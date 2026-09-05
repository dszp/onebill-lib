/**
 * Recurring-subscription reconciliation: does what the customer is billed for still match what they
 * actually have?
 *
 * **Pure.** It fetches nothing and writes nothing. Feed it the account's subscriptions
 * (`OneBillReadClient.getSubscriptions`, a cache, a fixture), a count of the real world, a rulebook
 * and — optionally — what an operator has previously accepted, and it returns one row per rule group.
 *
 * ## Acceptance is per item, not per count
 *
 * A count says twelve extensions exist against ten billed; it cannot say *which* two are the extra
 * ones, so it cannot tell "the same two we already looked at" from "one of those was deleted and a
 * different one appeared". Where the caller can supply the list behind a dimension — through
 * `itemsFor` — the row carries one `ComparisonItem` per thing, an operator accepts individual items,
 * and a swap that leaves the count unchanged reads as `drift` rather than staying quietly `accepted`.
 *
 * The item list arrives **injected**. This library never learns what an extension or a phone number
 * is; it only knows that a dimension may have keys behind it and that keys can be accepted.
 *
 * Where a dimension has no list (`itemsFor` returns `undefined`, or none is supplied at all), the
 * group row carries the judgement on its own — the count model, kept for exactly that case.
 *
 * ## What it is NOT
 *
 * It is not a rulebook. Which offer means "a seat" and what a seat includes are **per-customer sales
 * decisions**, so this library ships no offer names and has no opinion on which of them are seats.
 * `RecurringRule[]` is supplied by the caller, from that deployment's own configuration.
 *
 * It is also not an invoice check. OneBill returns quantities on subscriptions and **amounts only on
 * invoices**; nothing here compares money.
 *
 * ## The inventory is an opaque tree of numbers
 *
 * A `counts` path is a dotted path into whatever object the caller passes as `inventory` — the value
 * at the end must be a number. That is the whole contract, deliberately: this library must not know
 * what a PBX is, and a caller counting something else entirely (mailboxes, licences, doors) can use
 * the same comparison with the same rules.
 *
 * ## What "active" means here
 *
 * Computed from the activation-window intersection of the subscription and the offer, exactly as
 * `findUsageSubscriptions` does it, and for the same reason: the numeric `status` on an offer and
 * `state` on a subscription have undocumented vocabularies, and guessing at them produces confident
 * wrong answers. Where the two windows disagree the intersection wins — a false "inactive" is a
 * visible false alarm, while a false "active" hides a real billing failure. The raw `status` is
 * carried through on the row's offer list for a caller that wants to show it.
 */
import { catalogLookup, type CatalogIndex } from './catalog.js';
import type { Subscription, SubscriptionOffer } from './model.js';

/**
 * One line of the rulebook: which subscription line counts toward which dimension.
 *
 * At most one of `offer`, `planCode` and `productCode` — a rule with none of them is a
 * comparison-only row, a group whose billed comes entirely from other rules' `alsoCounts` credits.
 */
export interface RecurringRule {
  /** Match by plan name (what a subscription line carries). */
  offer?: string;
  /** Match by price plan code, resolved through the catalogue index. Never matches a plan whose code is empty. */
  planCode?: string;
  /** Match by product code, resolved through the catalogue index — "any plan under this product I have not named". */
  productCode?: string;
  /** One dotted path, or several summed; observed is the sum and the item list the union. Absent only with `ignore`. */
  counts?: string | string[];
  /** Known and deliberately not compared. Leaves `unmapped`, lands in `ignored`, creates no row. */
  ignore?: true;
  /** Rules sharing a group are summed. Defaults to whichever key the rule carries. */
  group?: string;
  /** Quantity multiplier — 10 for a pack of ten. Defaults to 1. */
  perUnit?: number;
  /**
   * Credits: `path or group name → per-unit contribution`. Lands in every group whose dimensions
   * include the path, or whose name equals the key — not a group invented for the key. A credit
   * naming nothing is dropped rather than conjuring a row nobody configured and nobody can read.
   */
  alsoCounts?: Record<string, number>;
}

/** One thing an operator looked at and declared correct. */
export interface ItemAcceptance { key: string; label: string; note?: string; decidedAt: string; decidedBy: string }
/** A whole-group decision — what a shortfall or an item-less dimension is judged against. */
export interface GroupAcceptance { billed: number; observed: number; accepted: number; note?: string; decidedAt: string; decidedBy: string }
/** What an operator previously accepted for one group on one account. */
export interface GroupBaseline { group: string; items: ItemAcceptance[]; groupRow?: GroupAcceptance }
/**
 * One thing behind a dimension, and where it stands. `stale` means accepted once, no longer present —
 * which is a change after the decision, so it drifts the whole row.
 */
export interface ComparisonItem { key: string; label: string; status: 'accepted' | 'unreviewed' | 'stale'; acceptance?: ItemAcceptance }

export type RecurringVerdict =
  /** Observed equals billed and no acceptance has gone stale. Nothing to explain. */
  | 'match'
  /**
   * Observed differs from billed, the difference is exactly the one that was accepted, and no
   * accepted item has since vanished.
   */
  | 'accepted'
  /** Something moved after a full acceptance — a new item, a vanished one, or a changed billed count. */
  | 'drift'
  /** Observed differs from billed and nobody has said whether that is normal. */
  | 'unbaselined';

export interface ComparisonRow {
  group: string;
  /** The first dimension — kept for callers that show one. */
  dimension: string;
  /** Every dotted path this group counts, in rulebook order. */
  dimensions: string[];
  /** Sum of quantity x perUnit over matched active REC offers, plus any `alsoCounts` contributions. */
  billed: number;
  /** The item count where the group has a list, otherwise the summed inventory counts. */
  observed: number;
  /**
   * True when one of this group's `counts` paths named nothing numeric in the inventory — a rulebook
   * typo, or a dimension the caller does not count. A zero that means "not counted" and a zero that
   * means "none" are different facts, and the typo produces the first while looking exactly like the
   * second.
   *
   * It is a fact about the count paths, not about `observed`: where the group has an item list,
   * `observed` is the size of that list regardless of this flag.
   */
  observedMissing?: boolean;
  verdict: RecurringVerdict;
  /** undefined when no dimension of this row has an item list. */
  items?: ComparisonItem[];
  /** Present items nobody has accepted. Always 0 when `items` is undefined. */
  unreviewed: number;
  /** Acceptances whose item is no longer present. Any of these makes the verdict `drift`. */
  stale: number;
  /** Echoed whole so a row can show what the numbers were when the decision was made. */
  groupRow?: GroupAcceptance;
  /** Which offers made up `billed`, in the order the subscriptions were read. */
  offers: Array<{ name: string; quantity: number; perUnit: number; status?: unknown }>;
}

/** An active recurring offer no rule accounts for. */
export interface UnmappedOffer {
  name: string;
  quantity: number;
  subscriptionId?: string;
  /** Raw and uninterpreted — see the note on "active" above. */
  status?: unknown;
}

/** An active recurring offer a rule deliberately excluded from comparison. */
export interface IgnoredOffer {
  name: string;
  quantity: number;
  /** The rule key that matched, e.g. `"productCode:FAX"` — so a reader can find the rule. */
  rule: string;
}

export interface RecurringComparison {
  rows: ComparisonRow[];
  unmapped: UnmappedOffer[];
  ignored: IgnoredOffer[];
  /**
   * How many subscriptions were looked at. The misconfiguration detector: rows all zero against a
   * healthy `examined` means the rulebook's offer names are stale, not that the account is empty.
   */
  examined: number;
  /** Plan names a code-keyed rulebook could not resolve — no catalogue, or the catalogue does not know them. */
  catalogMisses: string[];
}

export interface CompareRecurringInput {
  subscriptions: readonly Subscription[];
  /** Any object whose `counts` paths end in numbers. */
  inventory: unknown;
  rules: readonly RecurringRule[];
  baselines?: readonly GroupBaseline[];
  /** Items behind a dimension path, or undefined when that dimension has none. Injected so this library knows nothing NetSapiens-shaped. */
  itemsFor?: (path: string) => ReadonlyArray<{ key: string }> | undefined;
  /** Names an item to a person; defaults to its key. */
  itemLabel?: (item: { key: string }) => string;
  /** Needed only by `planCode` / `productCode` rules — a name-keyed rulebook never touches it. */
  catalog?: CatalogIndex;
  /** Injectable so behaviour at a window boundary is testable without touching the clock. */
  now?: Date;
}

/**
 * How a rule is named in a report. Follows the match precedence, so the key a reader sees is the key
 * that would have won.
 */
export function ruleKeyOf(rule: RecurringRule): string {
  if (rule.planCode) return `planCode:${rule.planCode.trim()}`;
  if (rule.offer) return `offer:${rule.offer.trim()}`;
  if (rule.productCode) return `productCode:${rule.productCode.trim()}`;
  return `group:${(rule.group ?? '').trim()}`;
}

const pathsOf = (rule: RecurringRule): string[] => (Array.isArray(rule.counts) ? rule.counts : rule.counts ? [rule.counts] : []);
const groupNameOf = (rule: RecurringRule): string => (rule.group ?? rule.offer ?? rule.planCode ?? rule.productCode ?? '').trim();

const norm = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/** Parse an API date, or `undefined` if absent or unparseable. */
function parseDate(value: unknown): number | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}
const laterOf = (a?: number, b?: number): number | undefined => (a === undefined ? b : b === undefined ? a : Math.max(a, b));
const earlierOf = (a?: number, b?: number): number | undefined => (a === undefined ? b : b === undefined ? a : Math.min(a, b));

/**
 * A decimal-string quantity as a number. Absent, blank or unparseable reads as 1 — a subscription with
 * no stated quantity is one of the thing, which is how the API renders the common case. A quantity that
 * parses to any finite number 0 or greater is used as-is, `"0"` included: an offer explicitly billed at
 * zero is a real fact about the bill, not a stand-in for "one of the default".
 */
function quantityOf(offer: SubscriptionOffer): number {
  const raw = offer.quantity;
  if (typeof raw !== 'string' || raw.trim() === '') return 1;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

/** Does this offer carry a recurring charge? An offer with no charges at all is not one. */
function isRecurring(offer: SubscriptionOffer): boolean {
  return (offer.subscriptionCharge ?? []).some((c) => norm(c?.type) === 'rec');
}

/** Active by the intersected activation window — see the note at the top of this file. */
function isActive(sub: Subscription, offer: SubscriptionOffer, now: number): boolean {
  const start = laterOf(parseDate(sub.activationStartDate), parseDate(offer.activationStartDate));
  const end = earlierOf(parseDate(sub.activationEndDate), parseDate(offer.activationEndDate));
  if (start !== undefined && start > now) return false;
  if (end !== undefined && end <= now) return false;
  return true;
}

/** Walk a dotted path to a number. `undefined` means the path named nothing numeric. */
function numberAt(root: unknown, path: string): number | undefined {
  let cur: unknown = root;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return typeof cur === 'number' && Number.isFinite(cur) ? cur : undefined;
}

export function compareRecurring(input: CompareRecurringInput): RecurringComparison {
  const now = (input.now ?? new Date()).getTime();
  const byOffer = new Map<string, RecurringRule>(), byPlan = new Map<string, RecurringRule>(), byProduct = new Map<string, RecurringRule>();
  for (const r of input.rules) {
    if (r.offer && !byOffer.has(norm(r.offer))) byOffer.set(norm(r.offer), r);
    if (r.planCode && !byPlan.has(norm(r.planCode))) byPlan.set(norm(r.planCode), r);
    if (r.productCode && !byProduct.has(norm(r.productCode))) byProduct.set(norm(r.productCode), r);
  }
  // Only a rulebook that keys by code can suffer a catalogue miss; a name-keyed one never looks.
  const usesCodes = byPlan.size > 0 || byProduct.size > 0;

  // Groups, in rulebook order — a row exists for every rule group whether or not anything matched,
  // because a line that vanished from the bill is exactly what this is for.
  interface G { dimensions: string[]; billed: number; offers: ComparisonRow['offers'] }
  const groups = new Map<string, G>();
  for (const r of input.rules) {
    if (r.ignore) continue;
    const g = groupNameOf(r);
    if (!g) continue;
    // First rule wins the dimensions. Two rules in one group naming different paths is a rulebook
    // mistake; picking one deterministically and showing it on the row is more useful to whoever has
    // to fix it than an error that hides every other group.
    if (!groups.has(g)) groups.set(g, { dimensions: pathsOf(r), billed: 0, offers: [] });
  }
  /** Where an `alsoCounts` credit lands: every group tracking that path, or the group of that name. */
  const creditTargets = (key: string): string[] => {
    const out: string[] = [];
    for (const [name, g] of groups) if (name === key || g.dimensions.includes(key)) out.push(name);
    return out;
  };

  const unmapped: UnmappedOffer[] = [], ignored: IgnoredOffer[] = [], misses = new Set<string>();
  let examined = 0;
  for (const sub of input.subscriptions) {
    examined++;
    for (const offer of sub.subscriptionOffer ?? []) {
      if (!isRecurring(offer) || !isActive(sub, offer, now)) continue;
      const name = typeof offer.name === 'string' ? offer.name.trim() : '';
      const quantity = quantityOf(offer);
      // Precedence: plan code, then name, then product code. Codes come from the catalogue, never the
      // line — a subscription record carries the plan name and nothing else.
      const entry = catalogLookup(input.catalog, name);
      const rule = (entry && entry.planCode ? byPlan.get(norm(entry.planCode)) : undefined)
        ?? byOffer.get(norm(name))
        ?? (entry ? byProduct.get(norm(entry.productCode)) : undefined);
      if (!rule) {
        if (usesCodes && !entry) misses.add(name);
        unmapped.push({ name, quantity, ...(sub.subscriptionId === undefined ? {} : { subscriptionId: sub.subscriptionId }), status: offer.status });
        continue;
      }
      if (rule.ignore) { ignored.push({ name, quantity, rule: ruleKeyOf(rule) }); continue; }
      const perUnit = typeof rule.perUnit === 'number' && Number.isFinite(rule.perUnit) && rule.perUnit > 0 ? rule.perUnit : 1;
      const own = groups.get(groupNameOf(rule))!;
      own.billed += quantity * perUnit;
      own.offers.push({ name, quantity, perUnit, status: offer.status });
      for (const [key, per] of Object.entries(rule.alsoCounts ?? {})) {
        for (const target of creditTargets(key)) groups.get(target)!.billed += quantity * (Number.isFinite(per) ? per : 0);
      }
    }
  }

  const baselineFor = new Map((input.baselines ?? []).map((b) => [b.group, b]));
  const label = input.itemLabel ?? ((i: { key: string }) => i.key);

  const rows: ComparisonRow[] = [...groups].map(([group, g]) => {
    let observed = 0, missing = false;
    for (const p of g.dimensions) { const n = numberAt(input.inventory, p); if (n === undefined) missing = true; else observed += n; }

    // Items: the union over dimensions, deduplicated by key, in first-seen order. undefined only when
    // NO dimension has a list.
    let present: { key: string }[] | undefined;
    if (input.itemsFor) {
      const seen = new Map<string, { key: string }>();
      let any = false;
      for (const p of g.dimensions) {
        const list = input.itemsFor(p);
        if (!list) continue;
        any = true;
        for (const it of list) if (!seen.has(it.key)) seen.set(it.key, it);
      }
      if (any) present = [...seen.values()];
    }

    const b = baselineFor.get(group);
    const accepted = new Map((b?.items ?? []).map((a) => [a.key, a]));
    let items: ComparisonItem[] | undefined, unreviewed = 0, stale = 0;
    if (present) {
      items = present.map((it) => {
        const a = accepted.get(it.key);
        if (!a) unreviewed++;
        return { key: it.key, label: label(it), status: a ? 'accepted' : 'unreviewed', ...(a ? { acceptance: a } : {}) } as ComparisonItem;
      });
      const presentKeys = new Set(present.map((p) => p.key));
      for (const a of accepted.values()) if (!presentKeys.has(a.key)) { stale++; items.push({ key: a.key, label: a.label, status: 'stale', acceptance: a }); }
      // With a list, observed IS the list: a count and its list disagreeing would be this module's own bug.
      observed = present.length;
    }

    const groupRow = b?.groupRow;
    let verdict: RecurringVerdict;
    if (stale > 0) {
      // An accepted item that is no longer there is a change after the decision, whatever the counts
      // now say. Testing `observed === billed` first would let a swap — one accepted seat deleted,
      // one new seat created, billed caught up — read as a clean match, which is exactly the case
      // per-item acceptance exists to catch.
      verdict = 'drift';
    } else if (observed === g.billed) {
      verdict = 'match';
    } else if (items && observed > g.billed) {
      // Over-observed with a list is the case items exist for: the extras are nameable.
      if (unreviewed === 0 && groupRow && groupRow.billed === g.billed) verdict = 'accepted';
      else if (groupRow) verdict = 'drift';
      else verdict = 'unbaselined';
    } else {
      // Shortfall, or a dimension with no items: there is no item to point at for a seat that does not
      // exist, so the group row carries the judgement exactly as the count model did.
      if (!groupRow) verdict = 'unbaselined';
      else if (groupRow.accepted === observed && groupRow.billed === g.billed) verdict = 'accepted';
      else verdict = 'drift';
    }

    return {
      group,
      dimension: g.dimensions[0] ?? '',
      dimensions: g.dimensions,
      billed: g.billed,
      observed,
      ...(missing ? { observedMissing: true } : {}),
      verdict,
      ...(items ? { items } : {}),
      unreviewed,
      stale,
      ...(groupRow ? { groupRow } : {}),
      offers: g.offers,
    };
  });

  return { rows, unmapped, ignored, examined, catalogMisses: [...misses] };
}
