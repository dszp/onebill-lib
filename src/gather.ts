/**
 * Assembling the input for usage reconciliation.
 *
 * `usage.ts` is pure by design — it fetches nothing. Something still has to do the reading, and
 * doing it correctly involves two decisions that are easy to get wrong silently. This module makes
 * both explicit.
 *
 * **Where the links come from.** A deployment that treats the custom-field group as authoritative
 * and `externalId` as a derived index has two different answers available, at very different
 * prices:
 *
 * | source | cost | what it can detect |
 * |---|---|---|
 * | `'group'` | one extra GET per subscriber (N+1) | drift between the group and the index |
 * | `'externalId'` | free — rides the search rows | nothing about the index itself |
 *
 * The default is `'group'`, because a reconciliation report that reads the derived index cannot
 * notice that the index is wrong — and index drift is half of what the report exists to find.
 * `'externalId'` is the right choice for a quick pass over a large tenant, and the wrong one for an
 * audit.
 *
 * **What happens when one account fails.** A single bad account must not destroy a sweep of a
 * hundred and fifty requests, so per-account failures are collected and returned rather than
 * thrown. They are returned *visibly*, in {@link GatherResult.failures}, because a report that
 * quietly covers fewer accounts than it claims is worse than one that fails.
 */

import { attributesToLinks, type LinkMapping } from './attributes.js';
import { parseExternalId, type Link } from './link.js';
import type { Subscriber, Subscription } from './model.js';
import type { UsageReconcileRow } from './usage.js';

/**
 * The reads this module needs.
 *
 * Structural rather than the concrete `OneBillReadClient`, so a cache, a fixture, or a rate-limited
 * wrapper can stand in — and so tests need no HTTP at all. Anything satisfying this is read-only by
 * construction: there is no write method to reach.
 */
export interface UsageReadSource {
  listAllSubscribers(opts?: { statuses?: readonly string[] }): Promise<Subscriber[]>;
  getSubscriber(accountNumber: string): Promise<Subscriber>;
  getSubscriptions(accountNumber: string): Promise<Subscription[]>;
}

export interface GatherUsageRowsOptions {
  /** The namespace being reconciled. No default — this library ships no namespace constants. */
  ns: string;
  /**
   * Where authoritative links come from. Defaults to `'group'`; see the module note for why.
   * `'group'` requires {@link mapping}.
   */
  linkSource?: 'group' | 'externalId';
  /** Group → namespace mapping. Required when `linkSource` is `'group'`. */
  mapping?: LinkMapping;
  /**
   * Which subscriber statuses to cover.
   *
   * **Reconciliation should almost always pass every status.** The search filters to active
   * accounts by default and says nothing about it, and a closed account still carries billing
   * history and may still hold links — so the default here is *not* the client's default. Pass
   * `SUBSCRIBER_STATUSES` explicitly, or override with something narrower on purpose.
   */
  statuses?: readonly string[];
  /**
   * How many per-account reads to run at once. **Defaults to 1 — sequential.**
   *
   * OneBill publishes no rate limit and we have not measured one, so parallelism here is the
   * caller's risk to take, not this module's to assume. Raise it deliberately.
   */
  concurrency?: number;
  /** Called after each account completes, for a progress bar on a job that can take a while. */
  onProgress?: (done: number, total: number) => void;
}

export interface GatherFailure {
  accountNumber: string;
  error: unknown;
}

export interface GatherResult {
  /**
   * Ready to hand to `reconcileUsageSubscriptions`.
   *
   * On the `'group'` path the links are {@link SourcedLink}s — they carry the group key and
   * `aggregator` they came from, on top of the plain `Link` fields. That provenance is deliberately
   * *not* stripped: when a reconciliation says an account disagrees, the next question is always
   * "which group instance do I fix", and only the link knows. Consumers that want plain links can
   * pass them through `buildLinkSet`.
   */
  rows: UsageReconcileRow[];
  /** Accounts whose reads failed. Never empty-and-hidden: check this before trusting the report. */
  failures: GatherFailure[];
  /** Requests issued, so the cost of a pass is visible rather than folklore. */
  requestCount: number;
}

/**
 * Run `worker` over `items` with at most `limit` in flight. Order of results is preserved.
 *
 * `limit` is normalized rather than trusted. A non-finite value used to be catastrophic *and*
 * silent: `NaN <= 1` is false so the pool branch ran, `Array.from({ length: NaN })` produced no
 * runners at all, and the call resolved instantly with an empty result and no error recorded —
 * precisely the "quietly covers fewer accounts than it claims" failure this module exists to
 * prevent. Callers validate before reaching here; this is the second line of defence.
 */
async function pooled<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const parsed = Math.floor(Number(limit));
  const safeLimit = Number.isFinite(parsed) && parsed > 1 ? parsed : 1;

  if (safeLimit <= 1) {
    const out: R[] = [];
    for (let i = 0; i < items.length; i++) out.push(await worker(items[i]!, i));
    return out;
  }

  const results = new Array<R>(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.min(safeLimit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!, i);
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * Read everything the usage reconciliation needs, for every subscriber.
 *
 * Cost, for `N` subscribers: a handful of search calls to list them, plus `N` for subscriptions,
 * plus a further `N` when `linkSource` is `'group'` — so roughly `N` or `2N` requests depending on
 * which store you treat as authoritative. This is a cold-path job: run it on demand or on a
 * schedule and cache the result; never on a request path.
 */
export async function gatherUsageRows(
  source: UsageReadSource,
  opts: GatherUsageRowsOptions,
): Promise<GatherResult> {
  const linkSource = opts.linkSource ?? 'group';
  if (linkSource === 'group' && opts.mapping === undefined) {
    throw new Error(
      "gatherUsageRows: linkSource 'group' needs a mapping. Pass one, or use linkSource 'externalId' " +
        'to read the derived index instead — but note that cannot detect drift in the index itself.',
    );
  }

  // Reject a bad concurrency loudly rather than quietly running slower. `Number(process.env.X)` on
  // an unset variable is NaN, and a concurrency that silently fails to apply is the same shape of
  // bug as a filter that silently does nothing.
  if (opts.concurrency !== undefined) {
    const c = opts.concurrency;
    if (!Number.isInteger(c) || c < 1) {
      throw new Error(
        `gatherUsageRows: concurrency must be a positive integer, got ${JSON.stringify(c)}. ` +
          'Omit it for sequential reads.',
      );
    }
  }

  const failures: GatherFailure[] = [];
  let requestCount = 0;

  const subscribers = await source.listAllSubscribers(
    opts.statuses === undefined ? {} : { statuses: opts.statuses },
  );
  requestCount++; // The walk is several calls; counted as one step because its paging is internal.

  let done = 0;
  const rows = await pooled<Subscriber, UsageReconcileRow | undefined>(
    subscribers,
    opts.concurrency ?? 1,
    async (sub) => {
      const accountNumber = sub.accountNumber;
      try {
        const subscriptions = await source.getSubscriptions(accountNumber);
        requestCount++;

        let links: Link[];
        if (linkSource === 'externalId') {
          links = parseExternalId(sub.externalId).links.filter((l) => l.ns === opts.ns);
        } else {
          // The group rides only the single-record read, never the search row.
          const full = await source.getSubscriber(accountNumber);
          requestCount++;
          links = attributesToLinks(full, opts.mapping!).filter((l) => l.ns === opts.ns);
        }

        return {
          accountNumber,
          ...(sub.accountName === undefined ? {} : { accountName: sub.accountName }),
          links,
          subscriptions,
        };
      } catch (error) {
        failures.push({ accountNumber, error });
        return undefined;
      } finally {
        // Progress reporting must never be able to kill the job it reports on. Without this, a
        // throwing callback rejects its runner, rejects Promise.all, abandons the in-flight
        // siblings, and discards every row and failure already collected.
        done++;
        try {
          opts.onProgress?.(done, subscribers.length);
        } catch {
          /* a caller's progress bar is not this sweep's problem */
        }
      }
    },
  );

  return {
    rows: rows.filter((r): r is UsageReconcileRow => r !== undefined),
    failures,
    requestCount,
  };
}
