/**
 * Recurring-subscription reconciliation: does what the customer is billed for still match what they
 * actually have?
 *
 * **Pure.** It fetches nothing and writes nothing. Feed it the account's subscriptions
 * (`OneBillReadClient.getSubscriptions`, a cache, a fixture), a count of the real world, a rulebook
 * and — optionally — what an operator has previously accepted, and it returns one row per rule group.
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
import type { Subscription, SubscriptionOffer } from './model.js';

/** One line of the rulebook: which offer counts toward which dimension. */
export interface RecurringRule {
  /** The exact offer name, matched case-insensitively after trimming. */
  offer: string;
  /** Dotted path to a numeric leaf of the inventory, e.g. `"dids.total"`. */
  counts: string;
  /** Rows sharing a group are summed. Defaults to the offer name. */
  group?: string;
  /** Quantity multiplier — 10 for a pack of ten. Defaults to 1. */
  perUnit?: number;
  /**
   * Extra dimensions this offer also contributes to, e.g. an E911 product that includes a number:
   * `{ "dids.total": 1 }`. The contribution is `count x quantity`, and it lands in **every** group
   * whose own `counts` dimension equals that path — not a group named after the path, and not only
   * the first one found. When no group tracks that dimension, the contribution is dropped rather than
   * inventing a group for it: a row nobody configured would show a billed count with no way to explain
   * it. Tested by "credits an alsoCounts contribution to every group sharing that dimension" (two
   * groups both track `dids.total` and both pick up the credit) and "drops an alsoCounts contribution
   * when no rule counts toward that dimension" (the path names nothing in the rulebook, so nothing
   * changes).
   */
  alsoCounts?: Record<string, number>;
}

/** What an operator previously accepted for one group on one account. */
export interface BaselineEntry {
  group: string;
  /** What was billed when the decision was made. */
  billed: number;
  /** What was observed when the decision was made. */
  observed: number;
  /** The count the operator declared correct. */
  accepted: number;
  note?: string;
  /** ISO 8601. */
  decidedAt: string;
  /** Who decided — an identity string from the caller's own auth. */
  decidedBy: string;
}

export type RecurringVerdict =
  /** Observed equals billed. Nothing to explain. */
  | 'match'
  /** Observed differs from billed, and equals what was accepted. A known, recorded gap. */
  | 'accepted'
  /** A baseline exists and observed has moved away from its accepted count. */
  | 'drift'
  /** Observed differs from billed and nobody has said whether that is normal. */
  | 'unbaselined';

export interface ComparisonRow {
  group: string;
  /** The dotted path `observed` was read from. */
  dimension: string;
  /** Sum of quantity x perUnit over matched active REC offers, plus any `alsoCounts` contributions. */
  billed: number;
  /** The inventory count at `dimension`. Zero when the path is absent — see `observedMissing`. */
  observed: number;
  /**
   * True when `dimension` named nothing numeric in the inventory. A zero that means "not counted" and
   * a zero that means "none" are different facts, and a rulebook typo produces the first while looking
   * exactly like the second.
   */
  observedMissing?: boolean;
  /** From the baseline, when one exists for this group. */
  accepted?: number;
  verdict: RecurringVerdict;
  /** Echoed whole so a caller can show what the numbers were when the decision was made. */
  baseline?: BaselineEntry;
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

export interface RecurringComparison {
  rows: ComparisonRow[];
  unmapped: UnmappedOffer[];
  /**
   * How many subscriptions were looked at. The misconfiguration detector: rows all zero against a
   * healthy `examined` means the rulebook's offer names are stale, not that the account is empty.
   */
  examined: number;
}

export interface CompareRecurringInput {
  subscriptions: readonly Subscription[];
  /** Any object whose `counts` paths end in numbers. */
  inventory: unknown;
  rules: readonly RecurringRule[];
  baselines?: readonly BaselineEntry[];
  /** Injectable so behaviour at a window boundary is testable without touching the clock. */
  now?: Date;
}

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
  const byOffer = new Map<string, RecurringRule>();
  for (const r of input.rules) {
    const key = norm(r.offer);
    if (key !== '' && !byOffer.has(key)) byOffer.set(key, r);
  }

  // Groups, in rulebook order — a row exists for every rule group whether or not anything matched,
  // because a line that vanished from the bill is exactly what this is for.
  const groups = new Map<string, { dimension: string; billed: number; offers: ComparisonRow['offers'] }>();
  const groupNameOf = (rule: RecurringRule): string => (rule.group ?? rule.offer).trim();
  for (const r of input.rules) {
    const g = groupNameOf(r);
    // First rule wins the dimension. Two rules in one group naming different paths is a rulebook
    // mistake; picking one deterministically and letting the row's `dimension` show which is more
    // useful to whoever has to fix it than an error that hides every other group.
    if (!groups.has(g)) groups.set(g, { dimension: r.counts, billed: 0, offers: [] });
  }
  /** Every group whose dimension is `path` — where an `alsoCounts` contribution lands. */
  const groupsForDimension = (path: string): string[] => {
    const out: string[] = [];
    for (const [name, g] of groups) if (g.dimension === path) out.push(name);
    return out;
  };

  const unmapped: UnmappedOffer[] = [];
  let examined = 0;

  for (const sub of input.subscriptions) {
    examined++;
    for (const offer of sub.subscriptionOffer ?? []) {
      if (!isRecurring(offer) || !isActive(sub, offer, now)) continue;
      const name = typeof offer.name === 'string' ? offer.name.trim() : '';
      const rule = byOffer.get(norm(name));
      const quantity = quantityOf(offer);
      if (!rule) {
        unmapped.push({ name, quantity, ...(sub.subscriptionId === undefined ? {} : { subscriptionId: sub.subscriptionId }), status: offer.status });
        continue;
      }
      const perUnit = typeof rule.perUnit === 'number' && Number.isFinite(rule.perUnit) && rule.perUnit > 0 ? rule.perUnit : 1;
      const own = groups.get(groupNameOf(rule))!;
      own.billed += quantity * perUnit;
      own.offers.push({ name, quantity, perUnit, status: offer.status });

      for (const [path, per] of Object.entries(rule.alsoCounts ?? {})) {
        // Every group tracking this dimension gets the contribution — not just the first one found,
        // and not a group invented for the path. A contribution to a dimension no group tracks is
        // dropped: a row nobody configured would appear with a billed count and no way to read it.
        for (const target of groupsForDimension(path)) {
          groups.get(target)!.billed += quantity * (Number.isFinite(per) ? per : 0);
        }
      }
    }
  }

  const baselineFor = new Map((input.baselines ?? []).map((b) => [b.group, b]));

  const rows: ComparisonRow[] = [...groups].map(([group, g]) => {
    const found = numberAt(input.inventory, g.dimension);
    const observed = found ?? 0;
    const baseline = baselineFor.get(group);
    let verdict: RecurringVerdict;
    if (observed === g.billed) verdict = 'match';
    else if (baseline === undefined) verdict = 'unbaselined';
    else if (observed === baseline.accepted) verdict = 'accepted';
    else verdict = 'drift';

    return {
      group,
      dimension: g.dimension,
      billed: g.billed,
      observed,
      ...(found === undefined ? { observedMissing: true } : {}),
      ...(baseline === undefined ? {} : { accepted: baseline.accepted, baseline }),
      verdict,
      offers: g.offers,
    };
  });

  return { rows, unmapped, examined };
}
