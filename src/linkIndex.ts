import { parseExternalId, validate, type Link, type NamespaceRegistry } from './link.js';
import type { Subscriber } from './model.js';

/**
 * Build a two-way lookup between OneBill subscribers and the foreign-system records their
 * `externalId` links to.
 *
 * This is a **pure function over an array** — it fetches nothing. Get the subscribers however suits
 * you (`OneBillReadClient.listAllSubscribers()`, a cached blob, a fixture) and cache the input
 * rather than the index.
 *
 * The relationship is genuinely **many-to-many in both directions**, so every lookup returns a
 * list, never a single match:
 *
 * - One target can have several subscribers. A customer whose sites are billed as separate accounts
 *   produces several subscribers pointing at one domain.
 * - One subscriber can have several targets, in the same namespace or different ones.
 *
 * Ambiguity is reported, never resolved by picking one. See {@link LinkIndex.conflicts}.
 */

/** A subscriber reached through one particular link. */
export interface SubscriberRef {
  accountNumber: string;
  accountName?: string;
  /** The link that produced this entry. */
  link: Link;
}

/** Two or more subscribers claiming the same target. */
export interface LinkConflict {
  /** The composite key, as produced by {@link targetKey}. */
  key: string;
  value: string;
  qualifier?: string;
  /** The account numbers in contention, in the order encountered. */
  accountNumbers: string[];
}

/** A subscriber whose `externalId` did not fully make sense. */
export interface LinkProblem {
  accountNumber: string;
  /** Human-readable descriptions: unparseable tokens, registry violations, duplicates. */
  issues: string[];
}

export interface LinkIndex {
  /** The namespace this index covers. */
  ns: string;
  /** Target key -> the subscribers claiming it. Keys come from {@link targetKey}. */
  byTarget: Map<string, SubscriberRef[]>;
  /** Target value, ignoring any qualifier -> every subscriber claiming that value. */
  byValue: Map<string, SubscriberRef[]>;
  /** Account number -> that subscriber's links in this namespace. */
  byAccount: Map<string, Link[]>;
  /** Account numbers with no link in this namespace — the work list for populating the field. */
  unlinked: string[];
  /** Targets claimed by more than one subscriber. */
  conflicts: LinkConflict[];
  /** Subscribers whose `externalId` had unparseable tokens or failed registry validation. */
  problems: LinkProblem[];
  /** Subscribers carrying a `+N` continuation marker, and how many links it promises. */
  withContinuation: { accountNumber: string; count: number }[];
}

export interface BuildLinkIndexOptions {
  /**
   * The namespace to index by, e.g. your PBX namespace. There is no default: the library ships no
   * namespace constants, so this is always your own.
   */
  ns: string;
  /** Optional registry, used to validate links into {@link LinkIndex.problems}. */
  registry?: NamespaceRegistry;
}

/**
 * The composite key for a target. A value and that same value with a qualifier are distinct
 * targets, because they are distinct billable things.
 *
 * Unambiguous because a link's value can never contain `/`.
 */
export function targetKey(value: string, qualifier?: string): string {
  return `${value}/${qualifier ?? ''}`;
}

/** Build the index. */
export function buildLinkIndex(
  subscribers: readonly Subscriber[],
  opts: BuildLinkIndexOptions,
): LinkIndex {
  const { ns, registry } = opts;

  const byTarget = new Map<string, SubscriberRef[]>();
  const byValue = new Map<string, SubscriberRef[]>();
  const byAccount = new Map<string, Link[]>();
  const unlinked: string[] = [];
  const problems: LinkProblem[] = [];
  const withContinuation: { accountNumber: string; count: number }[] = [];

  for (const sub of subscribers) {
    const accountNumber = sub.accountNumber;
    const parsed = parseExternalId(sub.externalId);

    const issues = [...validate(parsed, registry), ...parsed.warnings];
    if (issues.length > 0) problems.push({ accountNumber, issues });

    if (parsed.continuation !== undefined) {
      withContinuation.push({ accountNumber, count: parsed.continuation });
    }

    const mine = parsed.links.filter((l) => l.ns === ns);
    byAccount.set(accountNumber, mine);

    if (mine.length === 0) {
      unlinked.push(accountNumber);
      continue;
    }

    for (const link of mine) {
      const ref: SubscriberRef = { accountNumber, accountName: sub.accountName, link };
      push(byTarget, targetKey(link.value, link.qualifier), ref);
      push(byValue, link.value, ref);
    }
  }

  const conflicts: LinkConflict[] = [];
  for (const [key, refs] of byTarget) {
    const accounts = [...new Set(refs.map((r) => r.accountNumber))];
    if (accounts.length > 1) {
      const first = refs[0]!.link;
      conflicts.push({
        key,
        value: first.value,
        qualifier: first.qualifier,
        accountNumbers: accounts,
      });
    }
  }

  return { ns, byTarget, byValue, byAccount, unlinked, conflicts, problems, withContinuation };
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

/**
 * Subscribers linked to an exact target.
 *
 * Passing no qualifier matches only links that have none — use {@link findByValue} to match a value
 * regardless of qualifier.
 */
export function findByTarget(index: LinkIndex, value: string, qualifier?: string): SubscriberRef[] {
  return index.byTarget.get(targetKey(value, qualifier)) ?? [];
}

/**
 * Every subscriber linked to a value, qualified or not.
 *
 * This is the lookup you want for "who bills for this thing at all", where a customer may be split
 * across several accounts by sub-unit.
 */
export function findByValue(index: LinkIndex, value: string): SubscriberRef[] {
  return index.byValue.get(value) ?? [];
}

/** One subscriber's links in the indexed namespace. */
export function findByAccount(index: LinkIndex, accountNumber: string): Link[] {
  return index.byAccount.get(accountNumber) ?? [];
}
