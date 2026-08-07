import { describe, expect, expectTypeOf, it } from 'vitest';
import { OneBillReadClient, SUBSCRIBER_STATUSES } from './readClient.js';
import { TEST_CONFIG, fakeSubscribers, mockFetch } from './testkit.js';

const B = TEST_CONFIG.baseUrl;

function client(mock: ReturnType<typeof mockFetch>) {
  return new OneBillReadClient({ ...TEST_CONFIG, fetchImpl: mock.fetchImpl });
}

describe('getSubscriber', () => {
  it('reads one account', async () => {
    const mock = mockFetch({ responses: [{ body: { accountNumber: 'CLI00000' } }] });
    await expect(client(mock).getSubscriber('CLI00000')).resolves.toMatchObject({
      accountNumber: 'CLI00000',
    });
    expect(mock.apiCalls[0]!.url).toBe(`${B}/rest/SubscriberService/v1/subscribers/CLI00000`);
  });

  it('encodes an account number with awkward characters', async () => {
    const mock = mockFetch({ responses: [{ body: {} }] });
    await client(mock).getSubscriber('a b/c');
    expect(mock.apiCalls[0]!.url).toBe(`${B}/rest/SubscriberService/v1/subscribers/a%20b%2Fc`);
  });
});

describe('searchSubscribers', () => {
  it('passes the documented filters through', async () => {
    const mock = mockFetch({ responses: [{ body: { subscriber: [] } }] });
    await client(mock).searchSubscribers({
      searchBy: 'accountName',
      searchString: 'Acme',
      orderBy: 'accountName',
      ascending: true,
      startCount: 50,
      resultCount: 25,
    });

    const q = new URL(mock.apiCalls[0]!.url).searchParams;
    expect(q.get('searchBy')).toBe('accountName');
    expect(q.get('searchString')).toBe('Acme');
    expect(q.get('orderBy')).toBe('accountName');
    expect(q.get('ascending')).toBe('true');
    expect(q.get('startCount')).toBe('50');
    expect(q.get('resultCount')).toBe('25');
    expect(q.get('countRequired')).toBe('true');
  });
});

describe('listAllSubscribers', () => {
  /**
   * Serve `total` rows in pages, echoing only `resultSize` — OneBill's actual behaviour.
   * Rows are served for every status, so a default multi-status walk sees `total` per status.
   */
  function paged(total: number, opts: { withTotalCount?: boolean } = {}) {
    return mockFetch({
      handler: (call) => {
        const q = new URL(call.url).searchParams;
        const start = Number(q.get('startCount') ?? 0);
        const size = Number(q.get('resultCount') ?? 50);
        const rows = fakeSubscribers(Math.max(Math.min(size, total - start), 0), start);
        return {
          body: {
            subscriber: rows,
            resultSize: rows.length,
            ...(opts.withTotalCount ? { totalCount: total } : {}),
            status: 'OK',
          },
        };
      },
    });
  }

  /** Serve a distinct set of rows per status, the way a real tenant does. */
  function byStatus(counts: Record<string, number>) {
    let offset = 0;
    const perStatus = new Map<string, ReturnType<typeof fakeSubscribers>>();
    for (const [status, n] of Object.entries(counts)) {
      perStatus.set(
        status,
        fakeSubscribers(n, offset).map((s) => ({ ...s, accountStatus: status })),
      );
      offset += 1000;
    }
    return mockFetch({
      handler: (call) => {
        const q = new URL(call.url).searchParams;
        const status = q.get('status') ?? 'Active';
        const start = Number(q.get('startCount') ?? 0);
        const size = Number(q.get('resultCount') ?? 50);
        const rows = (perStatus.get(status) ?? []).slice(start, start + size);
        return { body: { subscriber: rows, resultSize: rows.length, status: 'OK' } };
      },
    });
  }

  it('walks past the first page when the server reports only resultSize', async () => {
    // The regression this method exists for: stopping on a missing `totalCount` reports the first
    // 50 rows as the entire tenant. Subscriber search never returns `totalCount`.
    const mock = paged(120);
    const all = await client(mock).listAllSubscribers({ statuses: ['Active'] });
    expect(all).toHaveLength(120);
    expect(mock.apiCalls).toHaveLength(3);
  });

  it('stops on a short page', async () => {
    const mock = paged(70);
    await expect(client(mock).listAllSubscribers({ statuses: ['Active'] })).resolves.toHaveLength(70);
    expect(mock.apiCalls).toHaveLength(2);
  });

  it('handles a total that is an exact multiple of the page size', async () => {
    // 100 rows means two full pages, then an empty third that ends the walk.
    const mock = paged(100);
    await expect(client(mock).listAllSubscribers({ statuses: ['Active'] })).resolves.toHaveLength(100);
    expect(mock.apiCalls).toHaveLength(3);
  });

  it('returns nothing for an empty tenant', async () => {
    const mock = paged(0);
    await expect(client(mock).listAllSubscribers({ statuses: ['Active'] })).resolves.toEqual([]);
    expect(mock.apiCalls).toHaveLength(1);
  });

  it('treats a missing subscriber array as the end', async () => {
    const mock = mockFetch({ responses: [{ body: { resultSize: 0, status: 'OK' } }] });
    await expect(client(mock).listAllSubscribers({ statuses: ['Active'] })).resolves.toEqual([]);
  });

  it('honours totalCount when the endpoint supplies it', async () => {
    const mock = paged(100, { withTotalCount: true });
    await expect(client(mock).listAllSubscribers({ statuses: ['Active'] })).resolves.toHaveLength(100);
    // Stops after two pages rather than probing for a third.
    expect(mock.apiCalls).toHaveLength(2);
  });

  it('respects a caller-supplied page size', async () => {
    const mock = paged(25);
    await expect(client(mock).listAllSubscribers({ pageSize: 10, statuses: ['Active'] })).resolves.toHaveLength(25);
    expect(mock.apiCalls).toHaveLength(3);
  });

  it('advances by rows received, not rows requested', async () => {
    // `resultCount` is not honoured everywhere: products returned 26 rows for resultCount=5.
    // Advancing by the requested size against such an endpoint re-requests rows already collected.
    const served: number[] = [];
    const mock = mockFetch({
      handler: (call) => {
        const q = new URL(call.url).searchParams;
        const start = Number(q.get('startCount') ?? 0);
        served.push(start);
        // Ignore resultCount and serve a fixed 30 per page, 60 rows total.
        const rows = start < 60 ? fakeSubscribers(Math.min(30, 60 - start), start) : [];
        return { body: { subscriber: rows, resultSize: rows.length, status: 'OK' } };
      },
    });

    const all = await client(mock).listAllSubscribers({ pageSize: 5, statuses: ['Active'] });
    // Offsets must step by 30 (what arrived), not 5 (what was asked).
    expect(served).toEqual([0, 30, 60]);
    expect(new Set(all.map((s) => s.accountNumber)).size).toBe(all.length);
    expect(all).toHaveLength(60);
  });

  it('clamps a page size above the API maximum', async () => {
    const mock = paged(10);
    await client(mock).listAllSubscribers({ pageSize: 5000, statuses: ['Active'] });
    expect(new URL(mock.apiCalls[0]!.url).searchParams.get('resultCount')).toBe('50');
  });

  it('throws rather than truncating when the page cap is reached', async () => {
    // Silent truncation is exactly the failure this guard exists to prevent.
    const mock = paged(10_000);
    await expect(client(mock).listAllSubscribers({ maxPages: 3, statuses: ['Active'] })).rejects.toThrow(
      /stopped after 3 pages/,
    );
  });

  it('defaults to active accounts only', async () => {
    // Deliberate safety default: a bulk job that iterates and writes must not reach a closed
    // account by accident. The cost is that the default result is not every subscriber.
    const mock = byStatus({ Active: 64, Closed: 12 });
    const all = await client(mock).listAllSubscribers();

    expect(all).toHaveLength(64);
    expect(new Set(all.map((s) => s.accountStatus))).toEqual(new Set(['Active']));
    // 64 rows is two pages, so assert the statuses asked for rather than the call count.
    const asked = new Set(mock.apiCalls.map((c) => new URL(c.url).searchParams.get('status')));
    expect(asked).toEqual(new Set(['Active']));
  });

  it('covers every status when asked, including closed accounts', async () => {
    // The trap this guards: the endpoint filters to Active silently, so closed accounts that
    // reconciliation needs to see are omitted with no indication anything was left out.
    const mock = byStatus({ Active: 30, Closed: 7 });
    const all = await client(mock).listAllSubscribers({ statuses: SUBSCRIBER_STATUSES });

    expect(all).toHaveLength(37);
    expect(new Set(all.map((s) => s.accountStatus))).toEqual(new Set(['Active', 'Closed']));

    const asked = mock.apiCalls.map((c) => new URL(c.url).searchParams.get('status'));
    expect(new Set(asked)).toEqual(new Set(SUBSCRIBER_STATUSES));
  });

  it('does not silently drop closed accounts when covering every status', async () => {
    const mock = byStatus({ Active: 3, Closed: 2 });
    const all = await client(mock).listAllSubscribers({ statuses: SUBSCRIBER_STATUSES });
    expect(all.filter((s) => s.accountStatus === 'Closed')).toHaveLength(2);
  });

  it('narrows to the statuses the caller asks for', async () => {
    const mock = byStatus({ Active: 3, Closed: 2 });
    const all = await client(mock).listAllSubscribers({ statuses: ['Closed'] });
    expect(all).toHaveLength(2);
    expect(mock.apiCalls).toHaveLength(1);
  });

  it('de-duplicates an account returned under two statuses', async () => {
    // Should not happen, but overlapping filters must not corrupt an index built from the result.
    const dup = { accountNumber: 'CLI00000', accountName: 'Acme Division 0' };
    const mock = mockFetch({
      handler: () => ({ body: { subscriber: [dup], resultSize: 1, status: 'OK' } }),
    });
    const all = await client(mock).listAllSubscribers({ statuses: SUBSCRIBER_STATUSES });
    expect(all).toHaveLength(1);
  });

  it('sends one status per query rather than combining them', async () => {
    const mock = byStatus({ Active: 1 });
    await client(mock).listAllSubscribers({ statuses: SUBSCRIBER_STATUSES });
    for (const call of mock.apiCalls) {
      const status = new URL(call.url).searchParams.get('status');
      expect(SUBSCRIBER_STATUSES).toContain(status as (typeof SUBSCRIBER_STATUSES)[number]);
    }
  });

  it('forwards search filters to every page', async () => {
    const mock = paged(60);
    await client(mock).listAllSubscribers({ search: { searchBy: 'accountName', searchString: 'Acme' }, statuses: ['Active'] });
    for (const call of mock.apiCalls) {
      expect(new URL(call.url).searchParams.get('searchString')).toBe('Acme');
    }
  });
});

describe('getSubscriptions', () => {
  it('unwraps the envelope', async () => {
    const mock = mockFetch({
      responses: [{ body: { subscriptions: [{ subscriptionId: '1' }], status: 'OK' } }],
    });
    await expect(client(mock).getSubscriptions('CLI00000')).resolves.toEqual([
      { subscriptionId: '1' },
    ]);
    expect(mock.apiCalls[0]!.url).toBe(
      `${B}/rest/SubscriberService/v1/subscribers/CLI00000/subscriptions`,
    );
  });

  it('returns an empty array when there are none', async () => {
    const mock = mockFetch({ responses: [{ body: { status: 'OK' } }] });
    await expect(client(mock).getSubscriptions('CLI00000')).resolves.toEqual([]);
  });
});

describe('the read-only boundary', () => {
  // Checked by `pnpm typecheck`, not at runtime. Holding a read client must be proof you cannot
  // write, so these must stay failing-to-exist.
  it('exposes no mutating methods', () => {
    expectTypeOf<OneBillReadClient>().not.toHaveProperty('post');
    expectTypeOf<OneBillReadClient>().not.toHaveProperty('put');
    expectTypeOf<OneBillReadClient>().not.toHaveProperty('delete');
    expectTypeOf<OneBillReadClient>().not.toHaveProperty('request');
    expectTypeOf<OneBillReadClient>().not.toHaveProperty('setSubscriberExternalId');
    expectTypeOf<OneBillReadClient>().toHaveProperty('getSubscriber');
  });
});

describe('path segment guard', () => {
  it.each(['', '.', '..'])('refuses account number %j', async (acct) => {
    const mock = mockFetch({ responses: [{ body: {} }] });
    await expect(client(mock).getSubscriber(acct)).rejects.toThrow(/different endpoint/);
    await expect(client(mock).getSubscriptions(acct)).rejects.toThrow(/different endpoint/);
    expect(mock.apiCalls).toHaveLength(0);
  });
});
