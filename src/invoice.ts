/**
 * Reading an invoice's rated detail: flatten the nesting, prove the read is complete, and compare
 * one invoice's calls against another's.
 *
 * Pure functions over records. Nothing here fetches; `OneBillReadClient.getInvoiceDetail` supplies
 * the input.
 *
 * **Why this module exists.** A OneBill invoice is not a list of charges. It is a five-level tree
 * in which one field repeats its own name, every level is an array, and *three different things
 * are called some variant of "line item"*:
 *
 * ```
 * invoice
 *   accountInvoiceElements[]          - one per billed account (a parent carries its children)
 *     accountInvoiceElements[]        - yes, the same name again, nested inside itself
 *       invoiceElements[]             - one per subscription
 *         lineItems[]                 - A CHARGE LINE (recurring, one-time, or a usage ROLLUP)
 *           usageLineItem[]           - one per event name: "Origination Calls", "Termination..."
 *             lstLineItems[]          - ONE RATED CALL. The thing you actually wanted.
 *           taxLineItem.lineItems[]   - a tax component. NOT a charge. Same tag name.
 * ```
 *
 * Two traps follow from that shape, and both produce a wrong number that looks right:
 *
 * 1. **A usage charge line's `amount` is the sum of its own calls.** Add the charge lines and the
 *    calls together and you double-count every metered charge.
 * 2. **`taxLineItem.lineItems` reuses the charge-line name.** Anything that matches on the name
 *    rather than the position picks up tax rows as if they were charges.
 *
 * {@link reconcileInvoice} exists so neither mistake can pass silently: it checks a flattened
 * invoice against the totals OneBill states on the invoice itself, and a caller who has lost rows
 * finds out here rather than in a report.
 */

import type { InvoiceDetail, Rec } from './model.js';

/** Coerce a wire value to a number. OneBill sends amounts as numbers, but not consistently. */
function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** As {@link num}, but `undefined` rather than `0` when the field is genuinely absent. */
function optNum(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v);
  return s === '' ? undefined : s;
}

/**
 * Every level of this document is "an array, unless there is one of it, in which case it is the
 * object" - so every walk has to tolerate both. Absent becomes empty.
 */
function arr(v: unknown): Rec[] {
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]) as Rec[];
}

/**
 * One rated call (or other metered event) - a `lstLineItems` entry.
 *
 * The CDR-level attributes arrive as a key/value list under `eventAttributes` in the JSON
 * representation and as named child elements in the XML one; this normalises both to
 * {@link InvoiceCall.attributes}, with the fields worth naming lifted out.
 */
export interface InvoiceCall {
  /**
   * OneBill's identifier for the rated event.
   *
   * **Assigned at ingest, not by the switch.** A CDR re-imported after a failed feed gets a *new*
   * `eventId` for the same call, so equal ids prove two rows are the same event and unequal ids
   * prove nothing. {@link invoiceCallKey} is the key that survives a re-import.
   */
  eventId?: string;
  /** `YYYY-MM-DD HH:mm:ss`, local to the tenant. The sortable one. */
  isoEventDate?: string;
  /** The same instant formatted for display, e.g. `10/14/25 03:49:52 AM`. */
  eventDate?: string;
  /** What this call was charged. `0` for a rated-but-free call, which is most of them. */
  amount: number;
  totalAmount?: number;
  unitPrice?: number;
  /** Rated duration, in the unit named by {@link InvoiceCall.uom} - seconds, in every sample so far. */
  ratedQuantity?: number;
  /** e.g. `Second`. Never assume; a plan can rate in minutes or messages. */
  uom?: string;
  /** Calling number, digits only. */
  source?: string;
  /** Called number, digits only. */
  destination?: string;
  billedToNumber?: string;
  /** e.g. `voice`. */
  serviceType?: string;
  /** The rating bucket, e.g. `Toll Free Orig`. This is what decides the price. */
  chargeCategory?: string;
  /** The coarser grouping the invoice prints under, e.g. `Toll Free Calls`. */
  chargeCategoryGroup?: string;
  /** e.g. `Standard`, `Peak`. */
  timeCode?: string;
  /**
   * The `lstLineItems` event type - `USAGE`. Not the `EVENT_TYPE` attribute, which is the
   * direction of the call; that one stays in {@link InvoiceCall.attributes} precisely so the two
   * cannot be confused.
   */
  eventType?: string;
  /** The usage group this call was rated under, e.g. `Origination Calls`. */
  eventName?: string;
  /** The service instance the call was rated against. */
  subscriptionIdentifier?: string;
  subscriptionId?: string;
  productName?: string;
  productCode?: string;
  priceplanName?: string;
  /**
   * What this call was taxed, or `undefined` when the call carries **no tax record at all**.
   *
   * The distinction is load-bearing and must not be collapsed with `?? 0`. A call taxed at zero and
   * a call the tax engine never returned a result for look identical once both read `0`, and the
   * second is a real defect: on a live catch-up invoice, well over a thousand billed calls had no tax element
   * whatsoever while identically-priced calls in the same months were taxed normally. See
   * {@link InvoiceCall.taxed}.
   */
  taxAmount?: number;
  /**
   * Whether this call carries a tax record at all — the presence of the `taxLineItem` node, not
   * whether the amount is non-zero.
   *
   * `taxed: false` with a customer who holds an exemption code is expected; `taxed: false` with no
   * exemption is a tax the invoice should have carried. Answering which needs
   * `taxExemptionCodesOf` on the subscriber, which is why the two live in the same release.
   */
  taxed: boolean;
  /**
   * Every CDR attribute, verbatim. Keys observed: `SERVICE_TYPE`, `EVENT_TYPE`, `EVENT_SUB_TYPE`,
   * `SOURCE`, `DESTINATION`, `BILLED_TO_NUMBER`, `CHARGE_CATEGORY`, `RATED_QUANTITY`,
   * `QUANTITY_2`, `TIME_CODE`, `EVENT_CATEGORY`, `CHARGE_CATEGORY_GROUP`. Treat that list as a
   * lower bound - rating configuration decides it, so another tenant may carry more.
   */
  attributes: Record<string, string>;
}

/** A charge line - a `lineItems` entry. Its `amount` is what the invoice charges for it. */
export interface InvoiceChargeLine {
  description?: string;
  chargeType?: string;
  productName?: string;
  productCode?: string;
  subscriptionIdentifier?: string;
  /** What this line charges, before tax. */
  amount: number;
  taxAmount?: number;
  discountAmount?: number;
  /**
   * True when this line is a metered rollup - it has `usageLineItem` children, and its
   * {@link InvoiceChargeLine.amount} is the sum of {@link InvoiceChargeLine.usageAmount}. **Do not
   * add such a line's amount to the call amounts**; that double-counts every metered charge.
   */
  isUsageRollup: boolean;
  /** Sum of the `usageLineItem` group amounts under this line. `0` when it is not a rollup. */
  usageAmount: number;
  /** How many calls sit under this line. */
  callCount: number;
  /**
   * This line's own named tax components.
   *
   * **Empty on a usage rollup**, and that is the API's shape rather than an omission here: a rollup
   * has no `taxLineItem` node of its own, and its components live on the individual calls beneath
   * it. Its {@link InvoiceChargeLine.taxAmount} is still the correct total for the line. Use
   * {@link FlatInvoice.taxes} to ask what a whole invoice paid in a given tax, since that is
   * collected from both places.
   */
  taxLines: InvoiceTaxLine[];
}

/**
 * One named tax component — a `taxLineItem.lineItems` entry.
 *
 * `taxLineItem.lineItems` is the **third** thing in this document named some variant of "line
 * item", after the charge lines and the rated calls. {@link flattenInvoice} walks past it by
 * position when collecting charges, and descends into it deliberately when collecting tax; those
 * are not contradictory, and a reader who sees only one of them will think the other is a bug.
 */
export interface InvoiceTaxLine {
  /** e.g. `STATE USE TAX`, `FEDERAL UNIVERSAL SERVICE FUND`. The name to group by. */
  description?: string;
  amount: number;
  /** The tax vendor's numeric code, e.g. `060`. A string; do not assume it is numeric. */
  code?: string;
  /**
   * The jurisdiction, e.g. `IN`, `MI`. Comparable with a subscriber address's `state`, which is
   * what lets an exemption be checked against the state it is supposed to apply in.
   */
  groupCode?: string;
  /** The rating engine that produced it, e.g. `SureTax`. */
  taxConfig?: string;
}

/** An account-level surcharge - `billTimeLineItems.chargeLineItems`, outside the charge lines. */
export interface InvoiceSurcharge {
  description?: string;
  amount: number;
}

/** An invoice with the nesting walked away. */
export interface FlatInvoice {
  invoiceNumber?: string;
  accountNumber?: string;
  invoiceDate?: string;
  /**
   * Start of the billing period, `MM/dd/yyyy`. A catch-up invoice still names its OWN cycle -
   * calls dated outside it are late-billed usage, not a data error.
   */
  cycleStart?: string;
  cycleEnd?: string;
  /** What OneBill says the pre-tax charges come to. {@link reconcileInvoice} checks against this. */
  totalCurrentCharge?: number;
  /** Negative when a discount applies. */
  totalDiscount: number;
  chargeLines: InvoiceChargeLine[];
  surcharges: InvoiceSurcharge[];
  /** Every rated call on the invoice, across every account, subscription and usage group. */
  calls: InvoiceCall[];
  /**
   * Every named tax on the invoice, **aggregated** — one entry per distinct
   * (description, groupCode, code), with `amount` summed across every charge line and every call.
   *
   * Aggregated rather than itemised on purpose. The components are collected from two different
   * depths (charge lines for recurring, individual calls for usage), and an invoice with 13,000
   * calls would otherwise produce tens of thousands of near-identical rows to answer a question
   * that is always "how much of tax X did this invoice carry".
   */
  taxes: InvoiceTaxLine[];
  /** The tax total the invoice states for itself, when it reports one. `reconcileInvoice` checks
   *  the collected components against it. */
  statedTaxTotal?: number;
}

/** Lift the CDR attributes out of whichever shape they arrived in. */
function readAttributes(raw: Rec): Record<string, string> {
  const out: Record<string, string> = {};

  for (const entry of arr(raw.eventAttributes)) {
    // `contentType=json`: a list of {key, value} pairs.
    if (typeof entry.key === 'string') {
      const v = str(entry.value);
      if (v !== undefined) out[entry.key] = v;
      continue;
    }
    for (const [k, v] of Object.entries(entry)) {
      // The XML shape wraps the pairs one level deeper, in `eventAttribute`, and names each
      // attribute with its own element rather than a key/value pair.
      if (k === 'eventAttribute') {
        for (const inner of arr(v)) {
          for (const [ik, iv] of Object.entries(inner)) {
            const s = str(iv);
            if (s !== undefined) out[ik] = s;
          }
        }
        continue;
      }
      const s = str(v);
      if (s !== undefined) out[k] = s;
    }
  }
  return out;
}

/**
 * The named tax components hanging off a charge line or a call.
 *
 * This is the one place that deliberately descends into `taxLineItem.lineItems` — the node
 * {@link flattenInvoice} skips when collecting charges. Both are correct: it is a tax component
 * there and never a charge, and it is the only source of per-tax detail here.
 */
function readTaxLines(raw: Rec): InvoiceTaxLine[] {
  const out: InvoiceTaxLine[] = [];
  for (const tli of arr(raw.taxLineItem)) {
    for (const line of arr(tli.lineItems)) {
      out.push({
        description: str(line.description),
        amount: num(line.taxAmount),
        code: str(line.code),
        groupCode: str(line.groupCode),
        taxConfig: str(line.taxConfig),
      });
    }
  }
  return out;
}

/** Fold tax components into the invoice-level aggregate, keyed by what distinguishes them. */
function accumulateTax(into: Map<string, InvoiceTaxLine>, lines: readonly InvoiceTaxLine[]): void {
  for (const line of lines) {
    const key = `${line.description ?? ''}\u0000${line.groupCode ?? ''}\u0000${line.code ?? ''}`;
    const existing = into.get(key);
    if (existing) existing.amount += line.amount;
    else into.set(key, { ...line });
  }
}

function readCall(raw: Rec, eventName: string | undefined): InvoiceCall {
  const attributes = readAttributes(raw);
  return {
    eventId: str(raw.eventId),
    isoEventDate: str(raw.isoEventDate),
    eventDate: str(raw.eventDate),
    amount: num(raw.amount),
    totalAmount: optNum(raw.totalAmount),
    unitPrice: optNum(raw.unitPrice),
    ratedQuantity: optNum(attributes.RATED_QUANTITY),
    uom: str(raw.uomName),
    source: attributes.SOURCE,
    destination: attributes.DESTINATION,
    billedToNumber: attributes.BILLED_TO_NUMBER,
    serviceType: attributes.SERVICE_TYPE,
    chargeCategory: attributes.CHARGE_CATEGORY,
    chargeCategoryGroup: attributes.CHARGE_CATEGORY_GROUP,
    timeCode: attributes.TIME_CODE,
    eventType: str(raw.eventType),
    eventName: str(raw.eventName) ?? eventName,
    subscriptionIdentifier: str(raw.subscriptionIdentifier),
    subscriptionId: str(raw.subscriptionId),
    productName: str(raw.productName),
    productCode: str(raw.productCode),
    priceplanName: str(raw.priceplanName),
    taxAmount: optNum(raw.taxAmount),
    // Presence of the node, not a non-zero amount: a call taxed at zero and a call the tax engine
    // never answered for are different facts, and only this distinguishes them.
    taxed: raw.taxLineItem !== undefined && raw.taxLineItem !== null,
    attributes,
  };
}

/**
 * Walk an invoice into flat charge lines, surcharges and calls.
 *
 * Handles a parent invoice with child accounts (the outer `accountInvoiceElements` array) by
 * flattening them together - the totals it produces then reconcile against the invoice's own
 * `totalCurrentCharge`, which is likewise for the whole invoice.
 */
export function flattenInvoice(detail: InvoiceDetail): FlatInvoice {
  const chargeLines: InvoiceChargeLine[] = [];
  const surcharges: InvoiceSurcharge[] = [];
  const calls: InvoiceCall[] = [];
  const taxIndex = new Map<string, InvoiceTaxLine>();

  for (const account of arr(detail.accountInvoiceElements)) {
    for (const sur of arr((account.billTimeLineItems as Rec | undefined)?.chargeLineItems)) {
      surcharges.push({ description: str(sur.description), amount: num(sur.amount) });
    }

    for (const group of arr(account.accountInvoiceElements)) {
      for (const element of arr(group.invoiceElements)) {
        // Only `invoiceElements.lineItems`, reached by POSITION. A name-based match would also
        // collect `taxLineItem.lineItems`, which are tax components rather than charges.
        for (const line of arr(element.lineItems)) {
          const usageGroups = arr(line.usageLineItem);
          let usageAmount = 0;
          let callCount = 0;

          for (const usage of usageGroups) {
            usageAmount += num(usage.amount);
            const eventName = str(usage.eventName);
            for (const call of arr(usage.lstLineItems)) {
              calls.push(readCall(call, eventName));
              // A usage rollup has no taxLineItem of its own; its components are down here.
              accumulateTax(taxIndex, readTaxLines(call));
              callCount++;
            }
          }

          const lineTaxLines = readTaxLines(line);
          accumulateTax(taxIndex, lineTaxLines);

          chargeLines.push({
            description: str(line.description) ?? str(line.chargeDescription),
            chargeType: str(line.chargeType),
            productName: str(line.productName),
            productCode: str(line.productCode),
            subscriptionIdentifier: str(line.subscriptionIdentifier),
            amount: num(line.amount),
            taxAmount: optNum(line.taxAmount),
            discountAmount: optNum(line.discountAmount),
            isUsageRollup: usageGroups.length > 0,
            usageAmount,
            callCount,
            taxLines: lineTaxLines,
          });
        }
      }
    }
  }

  return {
    invoiceNumber: str(detail.invoiceNumber),
    accountNumber: str(detail.accountNumber),
    invoiceDate: str(detail.invoiceDate),
    cycleStart: str(detail.cycleStart),
    cycleEnd: str(detail.cycleEnd),
    totalCurrentCharge: optNum(detail.totalCurrentCharge),
    totalDiscount: num(detail.totalDiscount),
    chargeLines,
    surcharges,
    calls,
    taxes: [...taxIndex.values()],
    statedTaxTotal: optNum(
      (detail.enhancedAccountSummary as Rec | undefined)?.currentInvoice?.taxes,
    ),
  };
}

/**
 * Total per named tax across the whole invoice, e.g. `STATE USE TAX` -> 10.4.
 *
 * Collected from both depths — charge lines for recurring, individual calls for usage — so it
 * answers "what did this invoice pay in tax X" without the caller re-solving the walk.
 */
export function taxTotalsByDescription(flat: FlatInvoice): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of flat.taxes) {
    const k = line.description ?? '';
    out.set(k, (out.get(k) ?? 0) + line.amount);
  }
  return out;
}

/**
 * Total tax per jurisdiction, from each component's `groupCode` (e.g. `IN`, `MI`).
 *
 * The counterpart to `taxJurisdictionsOf` on a subscriber: an exemption is granted per state, and
 * which codes an account needs depends on the state, so checking that an exemption did what it
 * should means comparing the states the account has addresses in against the jurisdictions its
 * invoice was actually taxed in. Components with no `groupCode` are grouped under `''`.
 */
export function taxTotalsByJurisdiction(flat: FlatInvoice): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of flat.taxes) {
    const k = line.groupCode ?? '';
    out.set(k, (out.get(k) ?? 0) + line.amount);
  }
  return out;
}

/** The result of checking a flattened invoice against the totals OneBill states on it. */
export interface InvoiceReconciliation {
  chargeLineCount: number;
  callCount: number;
  /** Sum of every charge line, usage rollups included and each counted once. */
  chargeLineTotal: number;
  /** Sum of the account-level surcharges. */
  surchargeTotal: number;
  /** The invoice's `totalDiscount`, negative when a discount applies. */
  discount: number;
  /** `chargeLineTotal + surchargeTotal + discount`. */
  computedTotal: number;
  /** The invoice's own `totalCurrentCharge`, or `undefined` if it did not report one. */
  statedTotal: number | undefined;
  /** `computedTotal - statedTotal`. `undefined` when there is nothing to compare against. */
  delta: number | undefined;
  /**
   * True when {@link InvoiceReconciliation.delta} is within a cent. **False means rows are
   * missing**, not that rounding drifted.
   */
  balanced: boolean;
  /** Sum of every individual call's amount. */
  callTotal: number;
  /** Sum of the usage-group rollups the calls hang under. */
  usageRollupTotal: number;
  /** `callTotal - usageRollupTotal`. */
  usageDelta: number;
  /**
   * True when the calls add up to their own rollups. **This is the check that matters if you are
   * about to reason about individual calls**: it fails the moment the per-call walk drops rows,
   * where the invoice-level check still passes because the rollup is intact.
   */
  usageBalanced: boolean;
  /** Sum of every named tax component collected into {@link FlatInvoice.taxes}. */
  taxLineTotal: number;
  /**
   * Sum of each charge line's own `taxAmount` — the authoritative per-line total, and the right
   * thing to check the components against.
   *
   * Note this is NOT the sum of each line's `taxLineItem.totalTax`: a usage rollup has no
   * `taxLineItem` node at all, so a control built on `totalTax` silently omits every metered
   * charge's tax and then agrees with a component walk that made the same omission.
   */
  chargeTaxTotal: number;
  /** The tax total the invoice states for itself, when it reports one. */
  statedTaxTotal: number | undefined;
  /**
   * True when the collected components equal the charge lines' own tax, and equal the invoice's
   * stated tax where it reports one. False means a tax component was missed or double-counted.
   */
  taxBalanced: boolean;
}

/** Within a cent - the tolerance for a total assembled from two-decimal amounts. */
const CENT = 0.005;

/**
 * Check a flattened invoice against the totals the invoice states about itself.
 *
 * Run this before trusting any conclusion drawn from the calls. Both checks are reported
 * separately and deliberately not combined into one boolean: they fail for different reasons and a
 * single flag could not say which. {@link InvoiceReconciliation.usageBalanced} is the strict one -
 * an invoice whose charge total balances can still have lost individual calls inside a rollup.
 */
export function reconcileInvoice(flat: FlatInvoice): InvoiceReconciliation {
  // `getInvoiceDetail` is what a caller has in hand at this point, and passing it straight here is
  // an easy mistake that used to surface as `Cannot read properties of undefined (reading 'reduce')`
  // from inside this function — an error about the library's internals rather than the caller's
  // mistake. Name the fix instead.
  if (!Array.isArray(flat?.chargeLines) || !Array.isArray(flat?.calls)) {
    throw new TypeError(
      'reconcileInvoice expects a FlatInvoice. Call flattenInvoice(detail) on the record from ' +
        'getInvoiceDetail first, and pass the result.',
    );
  }

  const chargeLineTotal = flat.chargeLines.reduce((s, l) => s + l.amount, 0);
  const surchargeTotal = flat.surcharges.reduce((s, l) => s + l.amount, 0);
  const computedTotal = chargeLineTotal + surchargeTotal + flat.totalDiscount;
  const statedTotal = flat.totalCurrentCharge;
  const delta = statedTotal === undefined ? undefined : computedTotal - statedTotal;

  const callTotal = flat.calls.reduce((s, c) => s + c.amount, 0);
  const usageRollupTotal = flat.chargeLines.reduce((s, l) => s + l.usageAmount, 0);

  const taxLineTotal = flat.taxes.reduce((s, t) => s + t.amount, 0);
  const chargeTaxTotal = flat.chargeLines.reduce((s, l) => s + (l.taxAmount ?? 0), 0);
  const statedTaxTotal = flat.statedTaxTotal;
  const taxBalanced =
    Math.abs(taxLineTotal - chargeTaxTotal) < CENT &&
    (statedTaxTotal === undefined || Math.abs(taxLineTotal - statedTaxTotal) < CENT);

  return {
    chargeLineCount: flat.chargeLines.length,
    callCount: flat.calls.length,
    chargeLineTotal,
    surchargeTotal,
    discount: flat.totalDiscount,
    computedTotal,
    statedTotal,
    delta,
    balanced: delta !== undefined && Math.abs(delta) < CENT,
    callTotal,
    usageRollupTotal,
    usageDelta: callTotal - usageRollupTotal,
    usageBalanced: Math.abs(callTotal - usageRollupTotal) < CENT,
    taxLineTotal,
    chargeTaxTotal,
    statedTaxTotal,
    taxBalanced,
  };
}

/**
 * The identity of a call that survives re-import: when it started, who called whom, and how long
 * it was rated for.
 *
 * **Not `eventId`.** That is assigned when OneBill ingests the CDR, so the same call fed twice -
 * which is exactly what happens when a broken usage feed is replayed - carries two different ids.
 * Comparing on `eventId` alone reports "no duplicates" for the one case anyone asks the question
 * about.
 *
 * Two genuinely distinct calls colliding on this key would need the same second, both numbers, and
 * the same rated duration. That is possible - a dialer, or one call rated as two legs - so treat a
 * collision as *evidence* of a duplicate rather than proof of one, and look at the rows.
 *
 * Fields are joined with a space, which cannot occur inside any of them, so no combination of
 * values can forge another key's string.
 */
export function invoiceCallKey(call: InvoiceCall): string {
  return [
    call.isoEventDate ?? '',
    call.source ?? '',
    call.destination ?? '',
    call.ratedQuantity ?? '',
  ].join(' ');
}

/** One call, and the earlier rows it matched. */
export interface DuplicateCallMatch {
  call: InvoiceCall;
  /** The rows from `against` that this call matched. Never empty. */
  matches: InvoiceCall[];
}

/**
 * Duplicate findings, reported per key rather than merged.
 *
 * The two keys are kept apart on purpose. Combining them into one "is it a duplicate" answer would
 * destroy the only signal that says the keys disagree - and disagreement is the interesting case.
 * A natural-key hit whose `eventId` did not hit is a call that was re-ingested, which is precisely
 * the double-billing shape; an `eventId` hit is the same stored event appearing twice.
 */
export interface DuplicateCallReport {
  /** Matched on {@link InvoiceCall.eventId}. Proves identity; misses re-imports. */
  byEventId: DuplicateCallMatch[];
  /** Matched on {@link invoiceCallKey}. Survives re-import. */
  byNaturalKey: DuplicateCallMatch[];
  /**
   * Calls that matched on the natural key but NOT on `eventId` - re-ingested events. Count these
   * before concluding a catch-up invoice is clean.
   */
  naturalOnly: DuplicateCallMatch[];
}

function indexBy(
  calls: readonly InvoiceCall[],
  key: (c: InvoiceCall) => string | undefined,
): Map<string, InvoiceCall[]> {
  const index = new Map<string, InvoiceCall[]>();
  for (const c of calls) {
    const k = key(c);
    if (k === undefined || k === '') continue;
    const bucket = index.get(k);
    if (bucket) bucket.push(c);
    else index.set(k, [c]);
  }
  return index;
}

/**
 * Find calls in `calls` that also appear in `against` - e.g. a catch-up invoice's rows against
 * every earlier invoice's rows.
 *
 * Both keys are applied independently; see {@link DuplicateCallReport} for why they are not
 * merged. An empty result means something only if {@link reconcileInvoice} says both sides were
 * read completely: a matcher run over a partial extraction finds nothing and looks reassuring.
 */
export function findDuplicateCalls(
  calls: readonly InvoiceCall[],
  against: readonly InvoiceCall[],
): DuplicateCallReport {
  const byId = indexBy(against, (c) => c.eventId);
  const byNat = indexBy(against, invoiceCallKey);

  const byEventId: DuplicateCallMatch[] = [];
  const byNaturalKey: DuplicateCallMatch[] = [];
  const naturalOnly: DuplicateCallMatch[] = [];

  for (const call of calls) {
    const idHits = call.eventId === undefined ? undefined : byId.get(call.eventId);
    if (idHits) byEventId.push({ call, matches: idHits });

    const natHits = byNat.get(invoiceCallKey(call));
    if (natHits) {
      byNaturalKey.push({ call, matches: natHits });
      if (!idHits) naturalOnly.push({ call, matches: natHits });
    }
  }

  return { byEventId, byNaturalKey, naturalOnly };
}

/** A natural key that occurs more than once, and every call carrying it. */
export interface RepeatedCallGroup {
  key: string;
  calls: InvoiceCall[];
  /**
   * True when the repeated rows carry different `eventId`s - two ingested events rather than one
   * row rendered twice, which is what a replayed usage feed produces.
   */
  distinctEventIds: boolean;
  /** What the second and later copies add to the invoice: the overcharge, if they are one call. */
  extraAmount: number;
}

/**
 * Find calls repeated *within one set* - the same second, both numbers and rated duration, more
 * than once.
 *
 * A catch-up invoice built from a replayed usage feed can double-load rows without any earlier
 * invoice being involved, so this is a separate question from {@link findDuplicateCalls} and has
 * to be asked separately. Genuine repeats do occur (a call rated as two legs), which is why
 * {@link RepeatedCallGroup.distinctEventIds} and the rows themselves are returned rather than a
 * verdict.
 */
export function findRepeatedCalls(calls: readonly InvoiceCall[]): RepeatedCallGroup[] {
  const byKey = indexBy(calls, invoiceCallKey);
  const out: RepeatedCallGroup[] = [];

  for (const [key, group] of byKey) {
    if (group.length < 2) continue;
    out.push({
      key,
      calls: group,
      distinctEventIds: new Set(group.map((c) => c.eventId)).size > 1,
      extraAmount: group.slice(1).reduce((s, c) => s + c.amount, 0),
    });
  }

  return out;
}
