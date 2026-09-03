/**
 * Usage-subscription reconciliation: does the billing system still agree with the PBX?
 *
 * Some billing products carry a **routable value in the subscription identifier** rather than the
 * usual opaque composite label. The canonical case is a usage product whose identifier is the exact
 * PBX domain, which is how metered usage — minutes, toll-free, long distance — finds its way onto
 * the right invoice. Nothing enforces it. If the identifier is missing, misspelled, or the
 * subscription is not active, usage silently stops flowing and the first symptom is a wrong bill.
 *
 * These functions surface that. They are **pure** — they fetch nothing and write nothing. Get the
 * subscriptions however suits you (`OneBillReadClient.getSubscriptions`, a cache, a fixture) and
 * feed them in.
 *
 * ## What this is NOT
 *
 * A matched subscription is a **validation signal and a bootstrap source, never a lookup path**.
 * Resolving "which account owns this domain" from subscriptions would cost one request per
 * subscriber where the indexed route costs one in total, and it would quietly displace whichever
 * store your deployment has chosen as authoritative. So:
 *
 * - Subscription-derived values must never enter `buildLinkIndex`.
 * - `findByValue` / `findByTarget` / `findByAccount` must never fall back to them.
 * - {@link findUsageSubscriptions} returns only what **matched**, never a list of every identifier
 *   on the account — that is the shape which invites someone to build a lookup out of it.
 *
 * ## Nothing here is deployment-specific
 *
 * There is no built-in product name. Which offer means "this identifier is a link target" is
 * configuration you supply, because it is a property of one deployment's product catalogue.
 */

import type { Link } from './link.js';
import type { LinkConflict } from './linkIndex.js';
import { targetKey } from './linkIndex.js';
import type { Subscription } from './model.js';

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1 — extract
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How to recognise a subscription whose identifier carries a routable value.
 *
 * Supply `offerNames`, a `match` predicate, or both — they are OR'd. There is deliberately no
 * default: a built-in product name would bind this library to one deployment's catalogue.
 */
export interface UsageSubscriptionSpec {
  /** Offer names that mean "this subscription's identifier is a link target". Trimmed, case-insensitive. */
  offerNames?: readonly string[];
  /** Escape hatch for anything `offerNames` cannot express. OR'd with `offerNames`. */
  match?: (sub: Subscription) => boolean;
}

/** A subscription that matched the spec, with enough context to explain itself. */
export interface UsageSubscriptionMatch {
  subscriptionId?: string;
  /** The identifier — for a usage product, the PBX domain. Exactly as the API returned it. */
  identifier: string;
  /** The offer name that caused the match, when `offerNames` matched rather than the predicate. */
  offerName?: string;
  /**
   * Whether this subscription is live as of `now`, computed from the activation window alone.
   * See {@link findUsageSubscriptions} for why the state fields are not consulted.
   */
  active: boolean;
  /** Why `active` is false. Absent when it is true. */
  inactiveReason?: string;
  /** The effective window, after intersecting the subscription-level and offer-level dates. */
  activationStartDate?: string;
  activationEndDate?: string;
  /** Raw, uninterpreted. Carried so a caller can inspect them without this module guessing. */
  state?: unknown;
  offerStatus?: unknown;
}

/** What {@link findUsageSubscriptions} returns. */
export interface UsageSubscriptionScan {
  /** Only the subscriptions that matched. Never every identifier on the account. */
  matched: UsageSubscriptionMatch[];
  /**
   * How many subscriptions were looked at.
   *
   * This is the **misconfiguration detector**. If a product is renamed, every account reports its
   * usage subscription missing and the report reads as a catastrophe rather than a stale spec. A
   * caller seeing `matched: 0` against a healthy `examined` on *every* account can say "the spec is
   * wrong", which is the true statement. That judgement needs a cross-account view, which a single
   * scan does not have and should not acquire — so the count is surfaced instead.
   */
  examined: number;
}

/** Parse an API date, or `undefined` if absent or unparseable. */
function parseDate(value: unknown): number | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}

/** The later of two optional instants — used to intersect activation windows. */
function laterOf(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

/** The earlier of two optional instants. */
function earlierOf(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/**
 * Find the subscriptions whose identifier is meant to carry a routable value.
 *
 * **On what "active" means.** It is computed from the activation window only — the numeric `state`
 * on a subscription and `status` on an offer are carried through raw and used by nothing, because
 * their vocabularies are undocumented and guessing at them would produce confident wrong answers.
 * When the subscription-level and offer-level windows disagree, the **intersection** is used: a
 * false "inactive" is a visible false alarm, while a false "active" hides a real billing failure.
 *
 * `now` is injectable so behaviour at a window boundary is testable without touching the clock.
 */
export function findUsageSubscriptions(
  subscriptions: readonly Subscription[],
  spec: UsageSubscriptionSpec,
  opts: { now?: Date } = {},
): UsageSubscriptionScan {
  const now = (opts.now ?? new Date()).getTime();
  const wanted = new Set((spec.offerNames ?? []).map((n) => n.trim().toLowerCase()));

  const matched: UsageSubscriptionMatch[] = [];
  let examined = 0;

  for (const sub of subscriptions) {
    examined++;

    const offers = sub.subscriptionOffer ?? [];
    const hit = offers.find((o) => {
      const name = typeof o?.name === 'string' ? o.name.trim().toLowerCase() : '';
      return name !== '' && wanted.has(name);
    });

    const byPredicate = spec.match?.(sub) === true;
    if (hit === undefined && !byPredicate) continue;

    // An identifier is the whole point; a match without one carries no information.
    const identifier = typeof sub.subscriptionIdentifier === 'string' ? sub.subscriptionIdentifier : '';
    if (identifier.trim() === '') continue;

    const start = laterOf(parseDate(sub.activationStartDate), parseDate(hit?.activationStartDate));
    const end = earlierOf(parseDate(sub.activationEndDate), parseDate(hit?.activationEndDate));

    let active = true;
    let inactiveReason: string | undefined;
    if (start !== undefined && start > now) {
      active = false;
      inactiveReason = `not active until ${dayOf(start)}`;
    } else if (end !== undefined && end <= now) {
      active = false;
      inactiveReason = `ended ${dayOf(end)}`;
    }

    matched.push({
      subscriptionId: sub.subscriptionId,
      identifier,
      offerName: hit?.name,
      active,
      ...(inactiveReason === undefined ? {} : { inactiveReason }),
      ...(start === undefined ? {} : { activationStartDate: new Date(start).toISOString() }),
      ...(end === undefined ? {} : { activationEndDate: new Date(end).toISOString() }),
      state: sub.state,
      offerStatus: hit?.status,
    });
  }

  return { matched, examined };
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2 — reconcile
// ─────────────────────────────────────────────────────────────────────────────

/** One account's inputs: what it is linked to, and what it is subscribed to. */
export interface UsageReconcileRow {
  accountNumber: string;
  accountName?: string;
  /**
   * The links this caller treats as authoritative for the account, already narrowed to the
   * namespace being reconciled. Where they came from is the caller's business.
   */
  links: readonly Link[];
  /** What the subscriptions read returned for this account. */
  subscriptions: readonly Subscription[];
}

/**
 * The verdict for one account.
 *
 * `extra` exists so that an account legitimately spanning several targets is not reported as
 * broken. Without it every such account reads as a mismatch, and a report that cries wolf is a
 * report nobody opens.
 */
export type UsageVerdict =
  /** One active match, and it agrees with the links. */
  | 'ok'
  /** An active match whose identifier is not among the links. */
  | 'mismatch'
  /** Linked, but no matching subscription at all — usage is not flowing. */
  | 'missing'
  /** More than one active match. Reported, not resolved. */
  | 'ambiguous'
  /** Matched, but nothing active as of `now`. */
  | 'inactive'
  /** An active match exists and the account has no link — the seed case. */
  | 'unlinked'
  /** The links agree, but there are more of them than matched subscriptions. Informational. */
  | 'extra'
  /** No links and no matches. Nothing to say. */
  | 'none';

/** Presentation order, worst first. Exported so every consumer sorts the same way. */
export const USAGE_VERDICT_SEVERITY: readonly UsageVerdict[] = [
  'mismatch',
  'missing',
  'ambiguous',
  'inactive',
  'unlinked',
  'extra',
  'ok',
  'none',
];

export interface UsageReconciliation {
  accountNumber: string;
  accountName?: string;
  verdict: UsageVerdict;
  /** Every distinct observation. The verdict is the headline; this is the detail. */
  findings: string[];
  /** Normalized identifiers from the **active** matches. */
  subscriptionValues: string[];
  /** Normalized values from the links treated as truth. */
  linkValues: string[];
  /** Every match, active or not, for a caller that wants to show the raw picture. */
  matches: UsageSubscriptionMatch[];
  /** Subscriptions examined on this account — see {@link UsageSubscriptionScan.examined}. */
  examined: number;
}

export interface ReconcileUsageOptions {
  spec: UsageSubscriptionSpec;
  now?: Date;
  /**
   * Applied to both sides before comparison. Defaults to trim + lowercase, which is right when one
   * system preserves case and the other does not.
   */
  normalize?: (value: string) => string;
}

const defaultNormalize = (value: string): string => value.trim().toLowerCase();

/**
 * Compare each account's links against its usage subscriptions.
 *
 * **Reports, never resolves.** Where the two disagree this says so and stops; it does not pick a
 * winner, because picking one silently would make the wrong choice permanent.
 */
export function reconcileUsageSubscriptions(
  rows: readonly UsageReconcileRow[],
  opts: ReconcileUsageOptions,
): UsageReconciliation[] {
  const normalize = opts.normalize ?? defaultNormalize;

  return rows.map((row) => {
    const { matched, examined } = findUsageSubscriptions(row.subscriptions, opts.spec, {
      now: opts.now,
    });

    const activeMatches = matched.filter((m) => m.active);
    const subscriptionValues = [...new Set(activeMatches.map((m) => normalize(m.identifier)))];
    const linkValues = [...new Set(row.links.map((l) => normalize(l.value)))];

    const linkSet = new Set(linkValues);
    const covered = subscriptionValues.filter((v) => linkSet.has(v));
    const uncovered = subscriptionValues.filter((v) => !linkSet.has(v));

    const findings: string[] = [];
    let verdict: UsageVerdict;
    // Every finding names the offer, because "matched" on its own does not say what matched.
    const offer = offerLabel(opts.spec);
    const describe = (m: UsageSubscriptionMatch): string => {
      const which = m.offerName === undefined ? offer : `"${m.offerName}"`;
      const linked = linkSet.has(normalize(m.identifier)) ? ' (the linked target)' : '';
      return `A ${which} subscription carries the identifier "${m.identifier}"${linked}`;
    };

    if (matched.length === 0) {
      verdict = linkValues.length === 0 ? 'none' : 'missing';
      if (verdict === 'missing') {
        findings.push(
          `Linked to ${quoteAll(linkValues)}, but no ${offer} subscription on this account has ` +
            `that as its identifier, so usage is not flowing.`,
        );
      }
    } else if (activeMatches.length === 0) {
      verdict = 'inactive';
      for (const m of matched) {
        findings.push(`${describe(m)}, but it is not active (${m.inactiveReason}).`);
      }
    } else if (activeMatches.length > 1) {
      verdict = 'ambiguous';
      findings.push(
        `${activeMatches.length} active usage subscriptions: ${subscriptionValues.join(', ')}. Not resolved here.`,
      );
    } else if (uncovered.length === 0) {
      if (linkValues.length === subscriptionValues.length) {
        verdict = 'ok';
      } else {
        verdict = 'extra';
        const unbilled = linkValues.filter((v) => !subscriptionValues.includes(v));
        findings.push(
          `${linkValues.length} link(s) but ${subscriptionValues.length} usage subscription(s); ` +
            `no usage subscription covers: ${unbilled.join(', ')}.`,
        );
      }
    } else if (linkValues.length === 0) {
      verdict = 'unlinked';
      findings.push(`Usage subscription for "${uncovered.join(', ')}" but the account has no link.`);
    } else {
      verdict = 'mismatch';
      findings.push(
        `Usage subscription says ${uncovered.join(', ')}, links say ${linkValues.join(', ')}.`,
      );
    }

    // Always worth saying, whatever the verdict.
    for (const m of matched.filter((x) => !x.active)) {
      if (verdict !== 'inactive') {
        findings.push(`${describe(m)}, but it is not active (${m.inactiveReason}).`);
      }
    }

    return {
      accountNumber: row.accountNumber,
      ...(row.accountName === undefined ? {} : { accountName: row.accountName }),
      verdict,
      findings,
      subscriptionValues,
      linkValues,
      matches: matched,
      examined,
    };
  });
}

/** Sort reconciliations worst-first, per {@link USAGE_VERDICT_SEVERITY}. Stable within a verdict. */
export function bySeverity(a: UsageReconciliation, b: UsageReconciliation): number {
  return (
    USAGE_VERDICT_SEVERITY.indexOf(a.verdict) - USAGE_VERDICT_SEVERITY.indexOf(b.verdict)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 3 — propose
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How much to trust a proposed value.
 *
 * `unknown` is the one that matters: the subscription identifier does not correspond to anything in
 * the caller's authoritative list, so it is probably a typo. Surface it; do not write it.
 */
export type MappingConfidence = 'exact' | 'canonicalized' | 'unverified' | 'unknown';

export interface MappingCandidate {
  accountNumber: string;
  accountName?: string;
  ns: string;
  /** What to write. Spelled the way `knownTargets` spells it whenever one matched. */
  value: string;
  /** Exactly as the subscription carried it, before normalization. */
  rawValue: string;
  confidence: MappingConfidence;
  /** Set when this would replace existing links, which only happens with `includeMismatches`. */
  replaces?: string[];
  notes: string[];
}

export interface ProposeMappingsOptions {
  /** The namespace to propose links in. No default — the library ships no namespace constants. */
  ns: string;
  /**
   * The authoritative target values — e.g. the real domain list from the other system.
   *
   * **Strongly recommended.** A subscription identifier is free text somebody typed during billing
   * setup, so seeding straight from it launders a typo into whatever you treat as truth, where it
   * then agrees with itself forever and the reconciliation report goes quiet. Cross-checking breaks
   * that loop, and lets the proposed value adopt the authoritative spelling rather than the typed
   * one.
   */
  knownTargets?: readonly string[];
  normalize?: (value: string) => string;
  /** Also propose corrections for `mismatch` rows, which replace an existing link. Default false. */
  includeMismatches?: boolean;
}

export interface MappingProposal {
  candidates: MappingCandidate[];
  /** Accounts with nothing to propose, and why — the audit trail for "we looked at everything". */
  skipped: { accountNumber: string; reason: string }[];
  /** Two or more accounts proposing the same target. Reported, never resolved. */
  conflicts: LinkConflict[];
}

/**
 * Turn reconciliation results into a reviewable set of proposed links.
 *
 * Proposes for `unlinked` rows — the bootstrap case — and, with `includeMismatches`, for `mismatch`
 * rows too. Everything else is skipped with a reason.
 *
 * **This proposes; it never writes.** Applying a candidate is a separate, explicit act by the
 * caller, and `unknown`-confidence candidates and anything in `conflicts` should not be applied
 * without a human looking at them.
 *
 * Re-running later proposes only what is new, since already-correct accounts are skipped — so the
 * same review screen serves both the initial bootstrap and the accounts that appear afterwards.
 */
export function proposeMappings(
  reconciliations: readonly UsageReconciliation[],
  opts: ProposeMappingsOptions,
): MappingProposal {
  const normalize = opts.normalize ?? defaultNormalize;

  // Authoritative spelling, keyed by its normalized form.
  const canonical = new Map<string, string>();
  for (const t of opts.knownTargets ?? []) canonical.set(normalize(t), t);
  const haveTargets = opts.knownTargets !== undefined;

  const candidates: MappingCandidate[] = [];
  const skipped: { accountNumber: string; reason: string }[] = [];

  for (const rec of reconciliations) {
    const eligible =
      rec.verdict === 'unlinked' || (rec.verdict === 'mismatch' && opts.includeMismatches === true);

    if (!eligible) {
      skipped.push({ accountNumber: rec.accountNumber, reason: verdictSkipReason(rec.verdict) });
      continue;
    }

    const linkSet = new Set(rec.linkValues);
    const proposeFor = rec.subscriptionValues.filter((v) => !linkSet.has(v));
    if (proposeFor.length === 0) {
      skipped.push({ accountNumber: rec.accountNumber, reason: 'nothing new to propose' });
      continue;
    }

    for (const normalized of proposeFor) {
      // Recover the identifier as the API spelled it, for the audit trail.
      const raw =
        rec.matches.find((m) => normalize(m.identifier) === normalized)?.identifier ?? normalized;

      const notes: string[] = [];
      let value = raw;
      let confidence: MappingConfidence;

      if (!haveTargets) {
        confidence = 'unverified';
        notes.push('No authoritative target list was supplied, so this value was not checked.');
      } else {
        const known = canonical.get(normalized);
        if (known === undefined) {
          confidence = 'unknown';
          notes.push(
            'This identifier does not match any known target — likely a typo in the billing record. Do not apply without checking.',
          );
        } else if (known === raw) {
          confidence = 'exact';
        } else {
          confidence = 'canonicalized';
          value = known;
          notes.push(`Adopting the authoritative spelling "${known}" over the billing record's "${raw}".`);
        }
      }

      candidates.push({
        accountNumber: rec.accountNumber,
        ...(rec.accountName === undefined ? {} : { accountName: rec.accountName }),
        ns: opts.ns,
        value,
        rawValue: raw,
        confidence,
        ...(rec.verdict === 'mismatch' ? { replaces: [...rec.linkValues] } : {}),
        notes,
      });
    }
  }

  // Two accounts claiming one target is a data problem, not something to arbitrate here.
  const byTarget = new Map<string, MappingCandidate[]>();
  for (const c of candidates) {
    const key = targetKey(normalize(c.value));
    const list = byTarget.get(key);
    if (list) list.push(c);
    else byTarget.set(key, [c]);
  }

  const conflicts: LinkConflict[] = [];
  for (const [key, group] of byTarget) {
    const accounts = [...new Set(group.map((c) => c.accountNumber))];
    if (accounts.length > 1) {
      conflicts.push({ key, value: group[0]!.value, accountNumbers: accounts });
    }
  }

  return { candidates, skipped, conflicts };
}

function verdictSkipReason(verdict: UsageVerdict): string {
  switch (verdict) {
    case 'ok':
      return 'already linked and agreeing';
    case 'extra':
      return 'links agree; more links than usage subscriptions, which is expected for a split account';
    case 'missing':
      return 'no usage subscription to propose from — fix this in the billing system';
    case 'inactive':
      return 'the matching subscription is not active';
    case 'ambiguous':
      return 'more than one active usage subscription; resolve by hand';
    case 'mismatch':
      return 'disagrees with the existing link; pass includeMismatches to propose a correction';
    case 'none':
      return 'no links and no usage subscription';
    default:
      return 'not eligible';
  }
}

/** A timestamp as a calendar day, UTC. A finding reads "ended 2021-03-01", not an ISO instant. */
function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** How the spec's offers are named in a finding: `"Domain Usage"`, `"A" / "B"`, or plain `usage`. */
function offerLabel(spec: UsageSubscriptionSpec): string {
  const names = (spec.offerNames ?? []).map((n) => n.trim()).filter((n) => n !== '');
  return names.length === 0 ? 'usage' : names.map((n) => `"${n}"`).join(' / ');
}

function quoteAll(values: readonly string[]): string {
  return values.map((v) => `"${v}"`).join(', ');
}
