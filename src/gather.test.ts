import { describe, expect, it, vi } from 'vitest';
import { gatherUsageRows, type UsageReadSource } from './gather.js';
import { OneBillApiError } from './http.js';
import { buildLinkSet } from './attributes.js';
import type { Subscriber, Subscription } from './model.js';
import { reconcileUsageSubscriptions } from './usage.js';

const MAPPING = [{ group: 'PBX', ns: 'PBX', valueField: 'Domain', qualifierField: 'Site' }];

function usageSub(identifier: string): Subscription {
  return {
    subscriptionIdentifier: identifier,
    subscriptionOffer: [{ name: 'Domain Usage' }],
  };
}

/** A subscriber carrying a PBX group instance, as the single-record read returns it. */
function withGroup(accountNumber: string, domain: string): Subscriber {
  return {
    accountNumber,
    accountAttribute: [
      {
        key: 'PBX',
        aggregator: 1,
        childAttribute: [{ key: 'Domain', value: domain }],
      },
    ],
  };
}

/** A source built from plain records — no HTTP anywhere. */
function source(
  rows: { row: Subscriber; full?: Subscriber; subs?: Subscription[] }[],
  over: Partial<UsageReadSource> = {},
): UsageReadSource & { calls: string[] } {
  const calls: string[] = [];
  const impl: UsageReadSource & { calls: string[] } = {
    calls,
    async listAllSubscribers(opts) {
      calls.push(`list:${(opts?.statuses ?? []).join('+') || 'default'}`);
      return rows.map((r) => r.row);
    },
    async getSubscriber(a) {
      calls.push(`sub:${a}`);
      return rows.find((r) => r.row.accountNumber === a)?.full ?? { accountNumber: a };
    },
    async getSubscriptions(a) {
      calls.push(`subs:${a}`);
      return rows.find((r) => r.row.accountNumber === a)?.subs ?? [];
    },
    ...over,
  };
  return impl;
}

describe('gatherUsageRows', () => {
  it("refuses linkSource 'group' without a mapping, naming the alternative", async () => {
    await expect(gatherUsageRows(source([]), { ns: 'PBX' })).rejects.toThrow(/needs a mapping/);
  });

  it("reads links from the group by default, costing an extra GET per subscriber", async () => {
    const s = source([
      {
        row: { accountNumber: 'CLI00000' },
        full: withGroup('CLI00000', 'acme.12345.service'),
        subs: [usageSub('acme.12345.service')],
      },
    ]);

    const res = await gatherUsageRows(s, { ns: 'PBX', mapping: MAPPING });
    // Provenance is kept, not stripped: "which group instance do I fix" is the next question.
    expect(res.rows[0]!.links).toEqual([
      { ns: 'PBX', value: 'acme.12345.service', group: 'PBX', aggregator: 1 },
    ]);
    expect(s.calls).toContain('sub:CLI00000');
    expect(res.failures).toEqual([]);
  });

  it("reads links from externalId without the extra GET when asked", async () => {
    const s = source([
      {
        row: { accountNumber: 'CLI00000', externalId: 'PBX:acme.12345.service' },
        subs: [usageSub('acme.12345.service')],
      },
    ]);

    const res = await gatherUsageRows(s, { ns: 'PBX', linkSource: 'externalId' });
    expect(res.rows[0]!.links).toEqual([{ ns: 'PBX', value: 'acme.12345.service' }]);
    expect(s.calls).not.toContain('sub:CLI00000');
  });

  it('keeps only the namespace being reconciled', async () => {
    const s = source([
      { row: { accountNumber: 'CLI00000', externalId: 'PBX:acme.12345.service|CRM:4471' } },
    ]);
    const res = await gatherUsageRows(s, { ns: 'PBX', linkSource: 'externalId' });
    expect(res.rows[0]!.links.map((l) => l.ns)).toEqual(['PBX']);
  });

  it('passes statuses through, so reconciliation can cover closed accounts', async () => {
    const s = source([]);
    await gatherUsageRows(s, {
      ns: 'PBX',
      linkSource: 'externalId',
      statuses: ['Active', 'Closed', 'Inactive'],
    });
    expect(s.calls[0]).toBe('list:Active+Closed+Inactive');
  });

  it('collects a per-account failure instead of destroying the whole sweep', async () => {
    const s = source([
      { row: { accountNumber: 'CLI00000' }, subs: [usageSub('acme.12345.service')] },
      { row: { accountNumber: 'CLI00001' }, subs: [usageSub('other.67890.service')] },
    ]);
    const boom = vi.fn(async (a: string) => {
      if (a === 'CLI00000') throw new Error('upstream exploded');
      return [] as Subscription[];
    });
    s.getSubscriptions = boom;

    const res = await gatherUsageRows(s, { ns: 'PBX', linkSource: 'externalId' });
    expect(res.rows.map((r) => r.accountNumber)).toEqual(['CLI00001']);
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0]!.accountNumber).toBe('CLI00000');
    expect(String((res.failures[0]!.error as Error).message)).toMatch(/upstream exploded/);
  });

  // OneBill answers "this account has no subscriptions" with an in-band failure at HTTP 200 —
  // code 10WS0001 — not with an empty list. Measured live 2026-09-02 on three Active accounts.
  // A nonexistent account answers identically, so only the sweep — whose account came from the
  // subscriber list a moment ago — may treat it as an empty row.
  const noSubscriptions = (acct: string) =>
    new OneBillApiError(
      `GET /rest/SubscriberService/v1/subscribers/${acct}/subscriptions -> OneBill API: Bad Request: ...`,
      200,
      `/rest/SubscriberService/v1/subscribers/${acct}/subscriptions`,
      'GET',
      {
        resultSize: 0,
        status: 'Bad Request',
        validationResponse: {
          successful: false,
          validationErrorInfo: [
            { code: '10WS0001', message: 'No Matching Object Found or Invalid input parameter.', errorLevel: 0 },
          ],
        },
      },
    );

  it("treats OneBill's in-band 'No Matching Object Found' as an account with no subscriptions", async () => {
    const s = source([
      { row: { accountNumber: 'CLI00000', externalId: 'PBX:acme.12345.service' } },
      { row: { accountNumber: 'CLI00001' }, subs: [usageSub('other.67890.service')] },
    ]);
    const original = s.getSubscriptions.bind(s);
    s.getSubscriptions = async (a: string) => {
      if (a === 'CLI00000') throw noSubscriptions(a);
      return original(a);
    };

    const res = await gatherUsageRows(s, { ns: 'PBX', linkSource: 'externalId' });
    expect(res.failures).toEqual([]);
    expect(res.rows.map((r) => r.accountNumber)).toEqual(['CLI00000', 'CLI00001']);
    // The row is otherwise ordinary: its links still surface, so it reconciles as unlinked/none
    // rather than vanishing.
    expect(res.rows[0]).toEqual({
      accountNumber: 'CLI00000',
      links: [{ ns: 'PBX', value: 'acme.12345.service' }],
      subscriptions: [],
    });
  });

  it('still reports an in-band failure with any other code as a failure', async () => {
    const s = source([{ row: { accountNumber: 'CLI00000' } }]);
    s.getSubscriptions = async (a: string) => {
      throw new OneBillApiError('GET ... -> OneBill API: Bad Request', 200, `/x/${a}`, 'GET', {
        status: 'Bad Request',
        validationResponse: {
          validationErrorInfo: [{ code: '10PARWS0026', message: 'Invalid Account Number.' }],
        },
      });
    };
    const res = await gatherUsageRows(s, { ns: 'PBX', linkSource: 'externalId' });
    expect(res.rows).toEqual([]);
    expect(res.failures.map((f) => f.accountNumber)).toEqual(['CLI00000']);
  });

  describe('one retry on a transport failure', () => {
    const edge525 = (acct: string) =>
      new OneBillApiError(`GET /x/${acct} -> 525: error code: 525`, 525, `/x/${acct}`, 'GET', 'error code: 525');

    it('retries a 5xx once and keeps the row', async () => {
      const s = source([{ row: { accountNumber: 'CLI00000', externalId: 'PBX:acme.12345.service' } }]);
      let calls = 0;
      s.getSubscriptions = async (a: string) => {
        calls++;
        if (calls === 1) throw edge525(a);
        return [];
      };
      const res = await gatherUsageRows(s, { ns: 'PBX', linkSource: 'externalId', retryDelayMs: 0 });
      expect(res.failures).toEqual([]);
      expect(res.rows.map((r) => r.accountNumber)).toEqual(['CLI00000']);
      expect(res.retried).toBe(1);
      expect(res.requestCount).toBe(3); // list + 2 attempts: a retry is a request too.
    });

    it('retries a network error once, and reports the second failure', async () => {
      const s = source([{ row: { accountNumber: 'CLI00000' } }]);
      let calls = 0;
      s.getSubscriptions = async () => {
        calls++;
        throw new TypeError('fetch failed');
      };
      const res = await gatherUsageRows(s, { ns: 'PBX', linkSource: 'externalId', retryDelayMs: 0 });
      expect(calls).toBe(2);
      expect(res.failures.map((f) => f.accountNumber)).toEqual(['CLI00000']);
      expect(res.retried).toBe(1);
    });

    it('does not retry a 4xx or an in-band failure', async () => {
      for (const err of [
        new OneBillApiError('GET /x -> 403', 403, '/x', 'GET', null),
        new OneBillApiError('GET /x -> OneBill API: Bad Request', 200, '/x', 'GET', {
          status: 'Bad Request',
          validationResponse: { validationErrorInfo: [{ code: '10PARWS0026', message: 'Invalid Account Number.' }] },
        }),
      ]) {
        const s = source([{ row: { accountNumber: 'CLI00000' } }]);
        let calls = 0;
        s.getSubscriptions = async () => {
          calls++;
          throw err;
        };
        const res = await gatherUsageRows(s, { ns: 'PBX', linkSource: 'externalId', retryDelayMs: 0 });
        expect(calls).toBe(1);
        expect(res.retried).toBe(0);
        expect(res.failures).toHaveLength(1);
      }
    });

    it('covers the single-record read on the group path too', async () => {
      const s = source([
        { row: { accountNumber: 'CLI00000' }, full: withGroup('CLI00000', 'acme.12345.service'), subs: [] },
      ]);
      const original = s.getSubscriber.bind(s);
      let calls = 0;
      s.getSubscriber = async (a: string) => {
        calls++;
        if (calls === 1) throw edge525(a);
        return original(a);
      };
      const res = await gatherUsageRows(s, { ns: 'PBX', mapping: MAPPING, retryDelayMs: 0 });
      expect(res.failures).toEqual([]);
      expect(res.rows[0]!.links).toHaveLength(1);
      expect(res.retried).toBe(1);
    });
  });

  it('reports the request count so the cost of a pass is visible', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      row: { accountNumber: `CLI0000${i}` },
      full: withGroup(`CLI0000${i}`, `acme${i}.12345.service`),
      subs: [],
    }));
    const res = await gatherUsageRows(source(rows), { ns: 'PBX', mapping: MAPPING });
    // 1 list + 3 subscriptions + 3 single-record reads.
    expect(res.requestCount).toBe(7);
  });

  it('costs one call per account fewer on the externalId path', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ row: { accountNumber: `CLI0000${i}` } }));
    const res = await gatherUsageRows(source(rows), { ns: 'PBX', linkSource: 'externalId' });
    expect(res.requestCount).toBe(4);
  });

  it('reports progress once per account, including failures', async () => {
    const seen: number[] = [];
    const s = source([{ row: { accountNumber: 'A' } }, { row: { accountNumber: 'B' } }]);
    await gatherUsageRows(s, {
      ns: 'PBX',
      linkSource: 'externalId',
      onProgress: (d, t) => {
        seen.push(d);
        expect(t).toBe(2);
      },
    });
    expect(seen).toEqual([1, 2]);
  });

  it('preserves row order when running concurrently', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      row: { accountNumber: `CLI0000${i}` },
    }));
    // Make the earlier accounts slower, so completion order differs from input order.
    const s = source(rows);
    const original = s.getSubscriptions.bind(s);
    s.getSubscriptions = async (a: string) => {
      await new Promise((r) => setTimeout(r, a.endsWith('0') ? 20 : 1));
      return original(a);
    };

    const res = await gatherUsageRows(s, { ns: 'PBX', linkSource: 'externalId', concurrency: 4 });
    expect(res.rows.map((r) => r.accountNumber)).toEqual(rows.map((r) => r.row.accountNumber));
  });

  it('feeds reconcileUsageSubscriptions directly — the whole point', async () => {
    const s = source([
      {
        row: { accountNumber: 'CLI00000', accountName: 'Acme' },
        full: withGroup('CLI00000', 'acme.12345.service'),
        subs: [usageSub('acme.12345.service')],
      },
      {
        row: { accountNumber: 'CLI00001', accountName: 'Newco' },
        subs: [usageSub('newco.67890.service')],
      },
    ]);

    const { rows } = await gatherUsageRows(s, { ns: 'PBX', mapping: MAPPING });
    const recs = reconcileUsageSubscriptions(rows, { spec: { offerNames: ['Domain Usage'] } });

    expect(recs.map((r) => r.verdict)).toEqual(['ok', 'unlinked']);
  });

  it('provenance can be stripped back to plain links when a consumer wants them', async () => {
    const s = source([
      { row: { accountNumber: 'CLI00000' }, full: withGroup('CLI00000', 'acme.12345.service') },
    ]);
    const res = await gatherUsageRows(s, { ns: 'PBX', mapping: MAPPING });
    expect(buildLinkSet(res.rows[0]!.links as any)).toEqual([
      { ns: 'PBX', value: 'acme.12345.service' },
    ]);
  });
});

describe('concurrency is validated, not silently misapplied', () => {
  // Regression: Number(process.env.UNSET) is NaN. `NaN <= 1` is false, so the pool branch ran,
  // Array.from({length: NaN}) made ZERO runners, and the call resolved with an empty result and
  // no failure recorded — every account vanished silently.
  it.each([NaN, 0, -1, 1.5, Infinity])('rejects %p rather than returning nothing', async (bad) => {
    const s = source([{ row: { accountNumber: 'CLI00000' } }]);
    await expect(
      gatherUsageRows(s, { ns: 'PBX', linkSource: 'externalId', concurrency: bad as number }),
    ).rejects.toThrow(/concurrency must be a positive integer/);
  });

  it('still accepts a valid concurrency and returns every account', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ row: { accountNumber: `CLI0000${i}` } }));
    const res = await gatherUsageRows(source(rows), {
      ns: 'PBX',
      linkSource: 'externalId',
      concurrency: 3,
    });
    expect(res.rows).toHaveLength(6);
  });

  it('omitting it runs sequentially and returns every account', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({ row: { accountNumber: `CLI0000${i}` } }));
    const res = await gatherUsageRows(source(rows), { ns: 'PBX', linkSource: 'externalId' });
    expect(res.rows).toHaveLength(4);
  });
});

describe('a throwing onProgress cannot kill the sweep', () => {
  it('still returns every row', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ row: { accountNumber: `CLI0000${i}` } }));
    const res = await gatherUsageRows(source(rows), {
      ns: 'PBX',
      linkSource: 'externalId',
      onProgress: () => {
        throw new Error('the caller\'s progress bar exploded');
      },
    });
    expect(res.rows).toHaveLength(3);
    expect(res.failures).toEqual([]);
  });
});
