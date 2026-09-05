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
 * ## A credit pays for something; an entitlement permits it
 *
 * `alsoCounts` says this line ALSO PAYS FOR n of that — an E911 bundle includes a number, so a number
 * short is a deliverable missing, and the row shortfalls. `entitles` says each unit of this line
 * PERMITS n of that at no charge — a premium seat's Teams connection is a ceiling, so using it is
 * covered and not using it is nothing at all. The two arrive on the same `billed`/`entitled` split:
 * `billed` is what is paid for and must exist, `entitled` is headroom above it that may or may not be
 * taken up.
 *
 * A credit of either kind naming a path or group no rule tracks **creates a comparison-only row** for
 * that key. The alternative is dropping it, which this module used to do, and a premium seat's SMS and
 * transcription then appeared nowhere at all — the exact case an operator opens the report to see.
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
   * Credits: `path or group name → per-unit contribution`. "Each unit of this line also PAYS FOR n of
   * that", so it adds to the target's `billed` and fewer live than billed is a shortfall. Lands in
   * every group whose dimensions include the path, or whose name equals the key; a key naming neither
   * gets its own comparison-only row.
   *
   * Scales by the line's QUANTITY, not by `perUnit`: `perUnit` says how many of its OWN dimension a
   * line is worth (ten numbers to a pack), which says nothing about how many of someone else's it
   * pays for. A pack of ten that also carried ten E911 numbers states that as `alsoCounts: { …: 10 }`.
   */
  alsoCounts?: Record<string, number>;
  /**
   * Entitlements: `path or group name → per-unit ceiling`, same key vocabulary as `alsoCounts`. "Each
   * unit of this line ENTITLES the customer to n of that, at no charge", so it adds to the target's
   * `entitled` — headroom, never a shortfall. Not using an entitlement is not a finding.
   *
   * Scales by the line's QUANTITY and not by `perUnit`, exactly as `alsoCounts` does, and for the same
   * reason. A negative ceiling is a rulebook mistake: it is reported on the row and ignored by the
   * verdict.
   */
  entitles?: Record<string, number>;
}

/** One thing an operator looked at and declared correct. */
export interface ItemAcceptance {
  key: string;
  label: string;
  /**
   * Which offer this item is billed as — a name from the row's `offers[].name`, matched the way offer
   * names are matched everywhere else: case-insensitively after trim. Absent means untagged, which
   * every acceptance recorded before 0.6.0 is.
   *
   * It is a note on the decision, never an input to it: the verdict compares counts, and an operator
   * who tags nine seats to a tier that bills eight has recorded something for a reader to act on, not
   * a discrepancy this library can adjudicate.
   */
  offer?: string;
  note?: string;
  decidedAt: string;
  decidedBy: string;
}
/** A whole-group decision — what a shortfall or an item-less dimension is judged against. */
export interface GroupAcceptance {
  billed: number;
  observed: number;
  accepted: number;
  /**
   * The row's `entitled` when the decision was made. Optional because a decision recorded before
   * 0.6.0 has none — those keep the pre-entitlement behaviour rather than drifting every old row.
   * Where it IS recorded, an entitlement that has since gone away invalidates the decision: accepting
   * three seats against "two billed, two entitled" is not the same judgement as three against two
   * billed alone.
   */
  entitled?: number;
  note?: string;
  decidedAt: string;
  decidedBy: string;
}
/** What an operator previously accepted for one group on one account. */
export interface GroupBaseline { group: string; items: ItemAcceptance[]; groupRow?: GroupAcceptance }
/**
 * One thing behind a dimension, and where it stands. `stale` means accepted once, no longer present —
 * which is a change after the decision, so it drifts the whole row.
 */
export interface ComparisonItem { key: string; label: string; status: 'accepted' | 'unreviewed' | 'stale'; acceptance?: ItemAcceptance }

export type RecurringVerdict =
  /**
   * Everything billed exists, nothing beyond `billed + entitled` does, and no acceptance has gone
   * stale. Nothing to explain — an entitlement left unused lands here.
   */
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

/**
 * Where one crediting line's contribution to a row came from. `from` is the offer name as matched — the
 * same name the row's `offers` carry — and `quantity` the total it credited, summed over that line's
 * keys landing on this group. Its kind says whether it paid (`alsoCounts`) or permitted (`entitles`).
 */
export interface ComparisonCredit {
  from: string;
  kind: 'alsoCounts' | 'entitles';
  quantity: number;
}

export interface ComparisonRow {
  group: string;
  /** The first dimension — kept for callers that show one. */
  dimension: string;
  /** Every dotted path this group counts, in rulebook order. */
  dimensions: string[];
  /** Sum of quantity x perUnit over matched active REC offers, plus any `alsoCounts` contributions. */
  billed: number;
  /**
   * Sum of the `entitles` contributions landing on this group — 0 when nothing entitles it. Headroom
   * above `billed`: `observed` anywhere from `billed` to `billed + entitled` is a `match`, and staying
   * below it is never a shortfall.
   */
  entitled: number;
  /** The item count where the group has a list, otherwise the summed inventory counts. */
  observed: number;
  /**
   * True when one of this group's `counts` paths named nothing numeric in the inventory — a rulebook
   * typo, or a dimension the caller does not count. A zero that means "not counted" and a zero that
   * means "none" are different facts, and the typo produces the first while looking exactly like the
   * second.
   *
   * An absent bucket in a `by…` map (`extensions.byScope.Call Center Agent` on a domain with no
   * call-centre users) is the second, not the first: a partition carries only the buckets that have
   * members, so it reads 0 and does NOT set this flag. A missing `byScope` itself still does.
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
  /** Present accepted items whose acceptance names no offer. Always 0 when `items` is undefined. */
  untagged: number;
  /** Acceptances whose item is no longer present. Any of these makes the verdict `drift`. */
  stale: number;
  /** Echoed whole so a row can show what the numbers were when the decision was made. */
  groupRow?: GroupAcceptance;
  /**
   * Which offers made up `billed`, in the order the subscriptions were read. `tagged` counts the
   * PRESENT accepted items billed as this offer — a stale acceptance is a decision about something
   * that is gone, so it counts toward nothing. An acceptance naming an offer this row no longer
   * carries appears in no entry, which is visible here as the offer's absence.
   *
   * Two lines of the same plan are two entries, and each reports the count for that NAME, so their
   * `tagged` figures repeat rather than dividing between them: an acceptance names a plan, not a
   * subscription line.
   */
  offers: Array<{ name: string; quantity: number; perUnit: number; tagged: number; status?: unknown }>;
  /**
   * Both kinds of credit that landed here, so a row billed entirely by other lines can say what pays
   * for it. One entry per crediting offer name and kind, in the order the subscriptions were read.
   */
  credits: ComparisonCredit[];
  /**
   * `billed === 0 && entitled > 0` — the row exists only because something entitles it. Nothing is
   * being paid for directly, so nothing here can be short.
   */
  optional: boolean;
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

/** A partition map by the caller's camelCase convention: `byScope`, `byModel` — but not `bytes`. */
const BY_MAP = /^by[A-Z]/;

/**
 * Walk a dotted path to a number. `undefined` means the path named nothing numeric — a rulebook typo,
 * or a dimension this caller does not count.
 *
 * **One exception: an absent bucket in a `by…` map is 0, not "not counted".** A map whose key reads
 * `byX` — `byScope`, `byServiceCode`, `byDeviceCount`, `byModel` — is a partition of something
 * already counted, and a partition only carries the buckets that have members. No user holds the
 * call-centre scope, so `extensions.byScope.Call Center Agent` is simply not there; reading that as
 * "not counted" put a warning on every domain without call-centre users, which is most of them, and a
 * warning that fires on the normal case teaches people to ignore the warning.
 *
 * The exception is exactly that narrow. A missing PARENT (`extensions.byScope` itself absent) and a
 * missing leaf under any other object stay `undefined`: neither says anything about a partition, and
 * both are the case the flag exists for. The prefix test is the camelCase convention — `by` followed
 * by a capital — so a `bytes` map is not mistaken for a partition of anything.
 */
function numberAt(root: unknown, path: string): number | undefined {
  const segs = path.split('.');
  let cur: unknown = root;
  for (let i = 0; i < segs.length; i++) {
    if (cur === null || typeof cur !== 'object') return undefined;
    const next = (cur as Record<string, unknown>)[segs[i]!];
    // `segs[i - 1]` is the key that named the object being indexed — the map, not the bucket.
    if (next === undefined && i === segs.length - 1 && BY_MAP.test(segs[i - 1] ?? '')) return 0;
    cur = next;
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
  interface G { dimensions: string[]; billed: number; entitled: number; offers: Array<Omit<ComparisonRow['offers'][number], 'tagged'>>; credits: Map<string, ComparisonCredit> }
  const groups = new Map<string, G>();
  const emptyGroup = (dimensions: string[]): G => ({ dimensions, billed: 0, entitled: 0, offers: [], credits: new Map() });
  for (const r of input.rules) {
    if (r.ignore) continue;
    const g = groupNameOf(r);
    if (!g) continue;
    // First rule wins the dimensions. Two rules in one group naming different paths is a rulebook
    // mistake; picking one deterministically and showing it on the row is more useful to whoever has
    // to fix it than an error that hides every other group.
    if (!groups.has(g)) groups.set(g, emptyGroup(pathsOf(r)));
  }
  /** Where a credit lands: every group tracking that path, or the group of that name. */
  const creditTargets = (key: string): string[] => {
    const out: string[] = [];
    for (const [name, g] of groups) if (name === key || g.dimensions.includes(key)) out.push(name);
    return out;
  };
  // A credit naming a path or group no rule tracks gets a comparison-only row of its own, named after
  // the key and counting it. Dropping it — what this did until 0.6.0 — meant a seat's included SMS and
  // transcription reached no row, no unmapped list and no error at all.
  // Rulebook order, and after every rule group exists, so a key naming a group declared later still
  // finds it rather than shadowing it.
  for (const r of input.rules) {
    if (r.ignore) continue;
    for (const key of [...Object.keys(r.alsoCounts ?? {}), ...Object.keys(r.entitles ?? {})]) {
      if (key && creditTargets(key).length === 0) groups.set(key, emptyGroup([key]));
    }
  }
  /**
   * Credit one group, keeping the provenance a reader needs to see why a row is billed at all. Lines
   * are aggregated by name the way they are MATCHED — case-insensitively after trim — so two spellings
   * of one plan do not read as two products crediting the row. The first spelling seen is displayed,
   * since that is the one the reader will find on the bill.
   */
  const credit = (target: string, from: string, kind: ComparisonCredit['kind'], amount: number): void => {
    const g = groups.get(target)!;
    if (kind === 'entitles') g.entitled += amount; else g.billed += amount;
    const at = `${kind}\u0000${norm(from)}`;
    const seen = g.credits.get(at);
    if (seen) seen.quantity += amount;
    else g.credits.set(at, { from, kind, quantity: amount });
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
      for (const kind of ['alsoCounts', 'entitles'] as const) {
        for (const [key, per] of Object.entries(rule[kind] ?? {})) {
          const amount = quantity * (Number.isFinite(per) ? per : 0);
          for (const target of creditTargets(key)) credit(target, name, kind, amount);
        }
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

    // Billed as: which offer each accepted item consumes, counted per offer NAME. Information for a
    // reader — the verdict below never looks at it.
    let untagged = 0;
    const taggedTo = new Map<string, number>();
    for (const it of items ?? []) {
      if (it.status !== 'accepted') continue;
      const tag = norm(it.acceptance?.offer);
      if (!tag) untagged++;
      else taggedTo.set(tag, (taggedTo.get(tag) ?? 0) + 1);
    }

    const groupRow = b?.groupRow;
    // What the bill permits: the paid quantity plus whatever entitles it. With no entitlement the two
    // are the same number and every branch below reduces to the v2 test it replaces. A NEGATIVE
    // entitlement is a rulebook mistake, and it is clamped rather than obeyed — headroom below zero
    // would turn a row that matches its billed quantity into a finding. The row still reports the sum
    // it was given, so the mistake stays visible instead of being quietly rewritten.
    const covered = g.billed + Math.max(0, g.entitled);
    let verdict: RecurringVerdict;
    if (stale > 0) {
      // An accepted item that is no longer there is a change after the decision, whatever the counts
      // now say. Testing `observed === billed` first would let a swap — one accepted seat deleted,
      // one new seat created, billed caught up — read as a clean match, which is exactly the case
      // per-item acceptance exists to catch.
      verdict = 'drift';
    } else if (observed >= g.billed && observed <= covered) {
      // Everything paid for exists and nothing beyond what is permitted does. An entitlement left
      // unused is the customer's business, not a finding.
      verdict = 'match';
    } else if (items && observed > covered) {
      // Over-observed with a list is the case items exist for: the extras are nameable.
      // `entitled` moving matters as much as `billed` moving: the operator accepted an overage against
      // a stated ceiling, and a premium seat going away takes the ceiling with it. An old decision
      // that recorded no entitlement is judged as it always was.
      if (unreviewed === 0 && groupRow && groupRow.billed === g.billed
        && (groupRow.entitled === undefined || groupRow.entitled === g.entitled)) verdict = 'accepted';
      else if (groupRow) verdict = 'drift';
      else verdict = 'unbaselined';
    } else {
      // Shortfall, or any difference on a dimension with no items: there is no item to point at for a
      // seat that does not exist, so the group row carries the judgement exactly as the count model did.
      if (!groupRow) verdict = 'unbaselined';
      else if (groupRow.accepted === observed && groupRow.billed === g.billed) verdict = 'accepted';
      else verdict = 'drift';
    }

    return {
      group,
      dimension: g.dimensions[0] ?? '',
      dimensions: g.dimensions,
      billed: g.billed,
      entitled: g.entitled,
      observed,
      ...(missing ? { observedMissing: true } : {}),
      verdict,
      ...(items ? { items } : {}),
      unreviewed,
      untagged,
      stale,
      ...(groupRow ? { groupRow } : {}),
      offers: g.offers.map((o) => ({ ...o, tagged: taggedTo.get(norm(o.name)) ?? 0 })),
      credits: [...g.credits.values()],
      optional: g.billed === 0 && g.entitled > 0,
    };
  });

  return { rows, unmapped, ignored, examined, catalogMisses: [...misses] };
}
