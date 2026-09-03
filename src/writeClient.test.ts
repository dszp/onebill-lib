import { describe, expect, expectTypeOf, it } from 'vitest';
import { OneBillApiError } from './http.js';
import { OneBillReadClient } from './readClient.js';
import { TEST_CONFIG, mockFetch, type RecordedCall } from './testkit.js';
import {
  OneBillInactiveAccountError,
  OneBillWriteClient,
  OneBillWriteVerificationError,
} from './writeClient.js';

/** A fictional subscriber record with the handful of fields the tests care about. */
const record = (externalId: string, extra: Record<string, unknown> = {}) => ({
  accountNumber: 'CLI00000',
  accountName: 'Acme Division 1',
  quoteTemplateName: 'Example_Template',
  status: 'OK',
  externalId,
  ...extra,
});

/**
 * Serve a mutable subscriber: GET returns current state, PUT replaces it with the body.
 * `onPut` can distort the write to simulate the API misbehaving.
 */
function subscriberServer(
  initial: Record<string, unknown>,
  onPut?: (body: any, state: Record<string, unknown>) => Record<string, unknown>,
) {
  let state = { ...initial };
  const puts: RecordedCall[] = [];
  const mock = mockFetch({
    handler: (call) => {
      if (call.method === 'PUT') {
        puts.push(call);
        state = onPut ? onPut(call.body, state) : { ...call.body, status: 'OK' };
        return { body: { status: 'OK' } };
      }
      return { body: { ...state, status: 'OK' } };
    },
  });
  return { mock, puts, current: () => state };
}

const client = (mock: ReturnType<typeof mockFetch>) =>
  new OneBillWriteClient({ ...TEST_CONFIG, fetchImpl: mock.fetchImpl });

describe('setSubscriberExternalId', () => {
  it('sets the value and verifies it by reading back', async () => {
    const { mock } = subscriberServer(record(''));
    const res = await client(mock).setSubscriberExternalId('CLI00000', 'CRM:4471');

    expect(res.stored).toBe('CRM:4471');
    expect(res.previous).toBe('');
    expect(res.changed).toBe(true);
    expect(res.collateral).toEqual([]);
    expect(res.dryRun).toBe(false);
  });

  it('does a full read-modify-write, not a partial PUT', async () => {
    // The load-bearing behaviour: a partial PUT is measurably destructive on this endpoint.
    const { mock, puts } = subscriberServer(record('', { billingType: 'PREPAID' }));
    await client(mock).setSubscriberExternalId('CLI00000', 'CRM:4471');

    expect(puts).toHaveLength(1);
    const body = puts[0]!.body;
    expect(body.accountName).toBe('Acme Division 1');
    expect(body.quoteTemplateName).toBe('Example_Template');
    expect(body.billingType).toBe('PREPAID');
    expect(body.externalId).toBe('CRM:4471');
  });

  it('does not echo the response-only `status` field back on the write', async () => {
    const { mock, puts } = subscriberServer(record(''));
    await client(mock).setSubscriberExternalId('CLI00000', 'CRM:4471');
    expect('status' in puts[0]!.body).toBe(false);
  });

  it('reads, writes, and reads again — three requests in order', async () => {
    const { mock } = subscriberServer(record(''));
    await client(mock).setSubscriberExternalId('CLI00000', 'CRM:4471');
    expect(mock.apiCalls.map((c) => c.method)).toEqual(['GET', 'PUT', 'GET']);
  });

  it('overwrites an existing value', async () => {
    const { mock } = subscriberServer(record('CRM:1111'));
    const res = await client(mock).setSubscriberExternalId('CLI00000', 'CRM:2222');
    expect(res.previous).toBe('CRM:1111');
    expect(res.stored).toBe('CRM:2222');
  });

  it('reports an unchanged write without failing', async () => {
    const { mock } = subscriberServer(record('CRM:4471'));
    const res = await client(mock).setSubscriberExternalId('CLI00000', 'CRM:4471');
    expect(res.changed).toBe(false);
    expect(res.stored).toBe('CRM:4471');
  });

  it('encodes the account number into the path', async () => {
    const { mock } = subscriberServer(record(''));
    await client(mock).setSubscriberExternalId('a b/c', 'CRM:1');
    expect(mock.apiCalls[0]!.url).toContain('/subscribers/a%20b%2Fc');
  });
});

describe('the silent-no-op guard', () => {
  it('throws when a write is acknowledged but did not take', async () => {
    // Documo's `cf` field and Ringotel's updateUser both ack and discard. Never trust a 200.
    const { mock } = subscriberServer(record('CRM:1111'), (_body, state) => state);
    try {
      await client(mock).setSubscriberExternalId('CLI00000', 'CRM:2222');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(OneBillWriteVerificationError);
      const err = e as OneBillWriteVerificationError;
      expect(err.result.requested).toBe('CRM:2222');
      expect(err.result.stored).toBe('CRM:1111');
    }
  });

  it('throws when the server truncates the value', async () => {
    const { mock } = subscriberServer(record(''), (body) => ({
      ...body,
      externalId: String(body.externalId).slice(0, 10),
      status: 'OK',
    }));
    await expect(
      client(mock).setSubscriberExternalId('CLI00000', 'CRM:4471|PBX:acme.12345.service'),
    ).rejects.toBeInstanceOf(OneBillWriteVerificationError);
  });

});

describe('clearing the field', () => {
  /** Serve an API that only honours a clear when `fieldsToRemove` names the field — as OneBill does. */
  function pickyServer(initial: Record<string, unknown>) {
    return subscriberServer(initial, (body, state) => {
      const next = { ...body, status: 'OK' };
      delete next.fieldsToRemove;
      const removing = Array.isArray(body.fieldsToRemove) && body.fieldsToRemove.includes('externalId');
      if (removing) {
        next.externalId = '';
      } else if (body.externalId === null || body.externalId === '' || body.externalId === ' ') {
        // A blank value with no removal hint is read as "not supplied": keep the old value.
        next.externalId = state.externalId;
      }
      return next;
    });
  }

  it('clears a populated field using fieldsToRemove', async () => {
    const { mock, puts } = pickyServer(record('CRM:1111'));
    const res = await client(mock).setSubscriberExternalId('CLI00000', '');

    expect(res.stored).toBe('');
    expect(res.previous).toBe('CRM:1111');
    expect(res.changed).toBe(true);
    expect(puts[0]!.body.fieldsToRemove).toEqual(['externalId']);
    expect(puts[0]!.body.externalId).toBeNull();
  });

  it('does not send fieldsToRemove on an ordinary set', async () => {
    const { mock, puts } = pickyServer(record(''));
    await client(mock).setSubscriberExternalId('CLI00000', 'CRM:4471');
    expect('fieldsToRemove' in puts[0]!.body).toBe(false);
  });

  it('is a no-op when the field is already empty', async () => {
    const { mock } = pickyServer(record(''));
    await expect(client(mock).setSubscriberExternalId('CLI00000', '')).resolves.toMatchObject({
      changed: false,
      stored: '',
    });
  });

  it('catches a server that ignores the clear', async () => {
    // Regression guard: without fieldsToRemove this is precisely what the live API does.
    const { mock } = subscriberServer(record('CRM:1111'), (_body, state) => state);
    await expect(client(mock).setSubscriberExternalId('CLI00000', '')).rejects.toBeInstanceOf(
      OneBillWriteVerificationError,
    );
  });
});

describe('the non-active account guard', () => {
  it('refuses a closed account by default', async () => {
    const { mock, puts } = subscriberServer(record('', { accountStatus: 'Closed' }));
    try {
      await client(mock).setSubscriberExternalId('CLI00000', 'CRM:4471');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(OneBillInactiveAccountError);
      expect((e as OneBillInactiveAccountError).accountStatus).toBe('Closed');
    }
    // Refused before writing, not after.
    expect(puts).toHaveLength(0);
  });

  it('refuses an inactive account by default', async () => {
    const { mock } = subscriberServer(record('', { accountStatus: 'Inactive' }));
    await expect(client(mock).setSubscriberExternalId('CLI00000', 'CRM:4471')).rejects.toBeInstanceOf(
      OneBillInactiveAccountError,
    );
  });

  it('writes when the caller opts in', async () => {
    const { mock, puts } = subscriberServer(record('', { accountStatus: 'Closed' }));
    const res = await client(mock).setSubscriberExternalId('CLI00000', 'CRM:4471', {
      allowNonActive: true,
    });
    expect(res.stored).toBe('CRM:4471');
    expect(puts).toHaveLength(1);
  });

  it('allows an active account', async () => {
    const { mock } = subscriberServer(record('', { accountStatus: 'Active' }));
    await expect(
      client(mock).setSubscriberExternalId('CLI00000', 'CRM:4471'),
    ).resolves.toMatchObject({ stored: 'CRM:4471' });
  });

  it('allows a record with no status rather than guessing', async () => {
    // Absent status is not evidence of being closed; the search rows omit plenty.
    const { mock } = subscriberServer(record(''));
    await expect(
      client(mock).setSubscriberExternalId('CLI00000', 'CRM:4471'),
    ).resolves.toMatchObject({ stored: 'CRM:4471' });
  });

  it('blocks a dry run too, so the guard is discovered before the real attempt', async () => {
    const { mock } = subscriberServer(record('', { accountStatus: 'Closed' }));
    await expect(
      client(mock).setSubscriberExternalId('CLI00000', 'CRM:4471', { dryRun: true }),
    ).rejects.toBeInstanceOf(OneBillInactiveAccountError);
  });
});

describe('empty custom-field groups', () => {
  // OneBill materialises a blank instance of every declared group onto every record. Echoing one
  // back is rejected outright if any of its fields is Mandatory:
  //   "Bad Request: Account Attribute value is mandatory for <field>."
  // which would block writes on every account not yet populated.
  const group = (aggregator: number, fields: Record<string, string>) => ({
    key: 'PBX',
    aggregator,
    configType: 'Group',
    childAttribute: Object.entries(fields).map(([key, value], i) => ({
      id: `${aggregator}${i}`,
      key,
      value,
      attributeValuesInfo: { associateValues: value ? [{ value, sequence: 1 }] : [] },
    })),
  });

  it('drops a wholly blank instance before writing', async () => {
    const { mock, puts } = subscriberServer(
      record('', { accountAttribute: [group(1, { Domain: '', Site: '' })] }),
    );
    await client(mock).setSubscriberExternalId('CLI00000', 'CRM:4471');
    expect(puts[0]!.body.accountAttribute).toEqual([]);
  });

  it('keeps a populated instance', async () => {
    const { mock, puts } = subscriberServer(
      record('', { accountAttribute: [group(1, { Domain: 'acme.12345.service', Site: '' })] }),
    );
    await client(mock).setSubscriberExternalId('CLI00000', 'CRM:4471');
    expect(puts[0]!.body.accountAttribute).toHaveLength(1);
  });

  it('keeps a partially filled instance — a blank optional field beside a populated one is meaningful', async () => {
    const { mock, puts } = subscriberServer(
      record('', { accountAttribute: [group(1, { Domain: 'acme.12345.service', Site: '' })] }),
    );
    await client(mock).setSubscriberExternalId('CLI00000', 'CRM:4471');
    const kept = puts[0]!.body.accountAttribute[0];
    expect(kept.childAttribute.map((c: any) => c.key)).toEqual(['Domain', 'Site']);
  });

  it('drops only the blank instances when several are present', async () => {
    const { mock, puts } = subscriberServer(
      record('', {
        accountAttribute: [
          group(1, { Domain: 'acme.12345.service', Site: 'Downtown' }),
          group(2, { Domain: '', Site: '' }),
          group(3, { Domain: 'other.12345.service', Site: '' }),
        ],
      }),
    );
    await client(mock).setSubscriberExternalId('CLI00000', 'CRM:4471');
    expect(puts[0]!.body.accountAttribute.map((g: any) => g.aggregator)).toEqual([1, 3]);
  });

  it('treats whitespace as blank', async () => {
    const { mock, puts } = subscriberServer(
      record('', { accountAttribute: [group(1, { Domain: '   ', Site: '' })] }),
    );
    await client(mock).setSubscriberExternalId('CLI00000', 'CRM:4471');
    expect(puts[0]!.body.accountAttribute).toEqual([]);
  });

  it('leaves non-group attributes alone', async () => {
    const { mock, puts } = subscriberServer(
      record('', { accountAttribute: [{ key: 'Flat', value: '' }] }),
    );
    await client(mock).setSubscriberExternalId('CLI00000', 'CRM:4471');
    expect(puts[0]!.body.accountAttribute).toHaveLength(1);
  });

  it('keeps an instance whose value lives only in associateValues', async () => {
    // Multi-value fields carry their data in associateValues; `value` may be blank.
    const { mock, puts } = subscriberServer(
      record('', {
        accountAttribute: [
          {
            key: 'PSA',
            aggregator: 1,
            childAttribute: [
              {
                id: '1',
                key: 'PSA Location',
                value: '',
                attributeValuesInfo: { associateValues: [{ value: '12345', sequence: 1 }] },
              },
            ],
          },
        ],
      }),
    );
    await client(mock).setSubscriberExternalId('CLI00000', 'CRM:4471');
    expect(puts[0]!.body.accountAttribute).toHaveLength(1);
  });
});

describe('collateral damage detection', () => {
  it('reports unrelated fields that moved', async () => {
    const { mock } = subscriberServer(record(''), (body) => {
      const next = { ...body, status: 'OK' };
      delete next.quoteTemplateName; // exactly what a partial PUT did live
      return next;
    });
    const res = await client(mock).setSubscriberExternalId('CLI00000', 'CRM:4471');
    expect(res.collateral).toEqual(['quoteTemplateName']);
  });

  it('ignores lastModifiedDate, which is expected to move', async () => {
    const { mock } = subscriberServer(record('', { lastModifiedDate: 'then' }), (body) => ({
      ...body,
      lastModifiedDate: 'now',
      status: 'OK',
    }));
    const res = await client(mock).setSubscriberExternalId('CLI00000', 'CRM:4471');
    expect(res.collateral).toEqual([]);
  });

  it('does not report a reordered nested collection as damage', async () => {
    // Observed live: a custom-field group's childAttribute came back in a different order on two
    // consecutive reads, with identical ids and values. Comparing with JSON.stringify flagged that
    // as collateral damage on every single write.
    // ids derive from the key, not the position — a pure reorder must leave every row identical.
    const group = (order: string[]) => [
      {
        key: 'PBX',
        aggregator: 1,
        childAttribute: order.map((k) => ({ id: `id-${k}`, key: k, value: `v-${k}` })),
      },
    ];
    const { mock } = subscriberServer(record('', { accountAttribute: group(['A', 'B', 'C']) }), (body) => ({
      ...body,
      // Same data, different order — exactly what the API does.
      accountAttribute: group(['C', 'A', 'B']),
      status: 'OK',
    }));

    const res = await client(mock).setSubscriberExternalId('CLI00000', 'CRM:4471');
    expect(res.collateral).toEqual([]);
  });

  it('still reports a genuine change inside a nested collection', async () => {
    const group = (value: string) => [
      { key: 'PBX', aggregator: 1, childAttribute: [{ id: '1000', key: 'Domain', value }] },
    ];
    const { mock } = subscriberServer(record('', { accountAttribute: group('acme.12345.service') }), (body) => ({
      ...body,
      accountAttribute: group('other.12345.service'),
      status: 'OK',
    }));

    const res = await client(mock).setSubscriberExternalId('CLI00000', 'CRM:4471');
    expect(res.collateral).toEqual(['accountAttribute']);
  });

  it('reports a dropped element from a nested collection', async () => {
    const { mock } = subscriberServer(
      record('', {
        accountAttribute: [
          { key: 'PBX', aggregator: 1, childAttribute: [{ id: '1', key: 'Domain', value: 'a' }] },
          { key: 'PBX', aggregator: 2, childAttribute: [{ id: '2', key: 'Domain', value: 'b' }] },
        ],
      }),
      (body) => ({
        ...body,
        accountAttribute: [(body.accountAttribute as any[])[0]],
        status: 'OK',
      }),
    );

    const res = await client(mock).setSubscriberExternalId('CLI00000', 'CRM:4471');
    expect(res.collateral).toEqual(['accountAttribute']);
  });

  it('throws on collateral damage in strict mode', async () => {
    const { mock } = subscriberServer(record(''), (body) => {
      const next = { ...body, status: 'OK' };
      delete next.quoteTemplateName;
      return next;
    });
    await expect(
      client(mock).setSubscriberExternalId('CLI00000', 'CRM:4471', { strict: true }),
    ).rejects.toBeInstanceOf(OneBillWriteVerificationError);
  });
});

describe('dryRun', () => {
  it('reads but sends nothing', async () => {
    const { mock, puts } = subscriberServer(record('CRM:1111'));
    const res = await client(mock).setSubscriberExternalId('CLI00000', 'CRM:2222', {
      dryRun: true,
    });

    expect(puts).toHaveLength(0);
    expect(res.dryRun).toBe(true);
    expect(res.previous).toBe('CRM:1111');
    expect(res.requested).toBe('CRM:2222');
    expect(res.stored).toBe('CRM:1111');
  });

  it('reports a pending clear without sending it', async () => {
    const { mock, puts } = subscriberServer(record('CRM:1111'));
    const res = await client(mock).setSubscriberExternalId('CLI00000', '', { dryRun: true });

    expect(puts).toHaveLength(0);
    expect(res.previous).toBe('CRM:1111');
    expect(res.requested).toBe('');
  });
});

describe('server-side rejection', () => {
  it('surfaces the over-length validation error as an API error', async () => {
    // OneBill rejects the whole write in-band at HTTP 200 and leaves the old value intact.
    const { mock } = subscriberServer(record(''), (_body, state) => state);
    const failing = mockFetch({
      handler: (call) =>
        call.method === 'PUT'
          ? {
              body: {
                status: 'Bad Request',
                validationResponse: {
                  successful: false,
                  validationErrorInfo: [
                    { code: '10PA1166', message: 'External ID can not be more than 64  character.' },
                  ],
                },
              },
            }
          : { body: { ...record(''), status: 'OK' } },
    });
    void mock;
    await expect(
      client(failing).setSubscriberExternalId('CLI00000', `CRM:${'x'.repeat(100)}`),
    ).rejects.toBeInstanceOf(OneBillApiError);
  });
});

describe('the read/write boundary', () => {
  // Checked by `pnpm typecheck`. The split is structural, not a convention.
  it('keeps writes off the read client', () => {
    expectTypeOf<OneBillWriteClient>().toHaveProperty('setSubscriberExternalId');
    expectTypeOf<OneBillReadClient>().not.toHaveProperty('setSubscriberExternalId');
    expectTypeOf<OneBillWriteClient>().not.toHaveProperty('request');
    expectTypeOf<OneBillWriteClient>().not.toHaveProperty('put');
  });
});

describe('regressions from the pre-publish review', () => {
  const MAPPING = [{ group: 'PBX', ns: 'NS', valueField: 'Domain', qualifierField: 'Site' }];

  it('preserves links whose namespace this mapping does not cover', async () => {
    // H1. Rebuilding externalId from the mapped groups alone erased a CRM: token that parsed
    // perfectly well — silently, with no verification failure. Two integrations each running with
    // only their own mapping would have deleted each other's links on every run.
    const { mock, puts } = subscriberServer({
      accountNumber: 'CLI00000',
      accountStatus: 'Active',
      externalId: 'CRM:4471|NS:acme.12345.service',
      accountAttribute: [
        {
          key: 'PBX',
          aggregator: 1,
          childAttribute: [{ id: '1', key: 'Domain', value: 'acme.12345.service' }],
        },
      ],
      status: 'OK',
    });

    const res = await client(mock).setSubscriberLinks(
      'CLI00000',
      [{ ns: 'NS', value: 'acme.12345.service' }],
      MAPPING,
    );

    expect(res.externalId).toContain('CRM:4471');
    expect(res.carriedOver).toEqual([{ ns: 'CRM', value: '4471' }]);
    expect(puts[0]!.body.externalId).toContain('CRM:4471');
  });

  it('still drops nothing when the mapping covers every namespace present', async () => {
    const { mock } = subscriberServer({
      accountNumber: 'CLI00000',
      accountStatus: 'Active',
      externalId: 'NS:acme.12345.service',
      accountAttribute: [
        {
          key: 'PBX',
          aggregator: 1,
          childAttribute: [{ id: '1', key: 'Domain', value: 'acme.12345.service' }],
        },
      ],
      status: 'OK',
    });
    const res = await client(mock).setSubscriberLinks(
      'CLI00000',
      [{ ns: 'NS', value: 'acme.12345.service' }],
      MAPPING,
    );
    expect(res.carriedOver).toEqual([]);
    expect(res.externalId).toBe('NS:acme.12345.service');
  });
});

describe('path segment guard', () => {
  it.each(['', '.', '..'])('refuses account number %j, which resolves elsewhere', async (acct) => {
    // `encodeURIComponent` leaves dot segments intact and `new URL()` then resolves them: '..' walks
    // to a different endpoint, '.' and '' land on the collection whose envelope types as a record.
    const { mock } = subscriberServer(record(''));
    await expect(client(mock).setSubscriberExternalId(acct, 'CRM:1')).rejects.toThrow(
      /different endpoint/,
    );
  });

  it('still allows an account number needing encoding', async () => {
    const { mock } = subscriberServer(record(''));
    await client(mock).setSubscriberExternalId('a b/c', 'CRM:1');
    expect(mock.apiCalls[0]!.url).toContain('a%20b%2Fc');
  });
});

describe('payInfo is stripped from the write body', () => {
  /** A record carrying a stored card, as the API returns it: the number is MASKED. */
  function withStoredCard() {
    return {
      accountNumber: 'CLI00000',
      accountStatus: 'Active',
      externalId: '',
      payInfo: [
        {
          paymentProfileId: '00000',
          paymentMethod: 'CC',
          creditCardInfo: { cardNumber: '**** **** **** 0000', cardType: 'VISA' },
        },
      ],
      accountAttribute: [],
    };
  }

  const MAPPING = [{ group: 'PBX', ns: 'NS', valueField: 'Domain', qualifierField: 'Site' }];

  it('does not echo payInfo back on the PUT', async () => {
    // Echoing the mask makes the server validate it as a real card number and reject the whole
    // write, on an operation that has nothing to do with payment.
    const mock = mockFetch({
      handler: (call) =>
        call.method === 'GET' ? { body: withStoredCard() } : { body: { ...withStoredCard(), status: 'OK' } },
    });
    const client = new OneBillWriteClient({ ...TEST_CONFIG, fetchImpl: mock.fetchImpl });
    await client
      .setSubscriberLinks('CLI00000', [{ ns: 'NS', value: 'acme.12345.service' }], MAPPING)
      .catch(() => undefined);

    const put = mock.apiCalls.find((c) => c.method === 'PUT');
    expect(put).toBeDefined();
    expect(Object.keys(put!.body)).not.toContain('payInfo');
  });

  it('still sends the rest of the record, because a partial PUT is destructive here', async () => {
    const mock = mockFetch({
      handler: (call) =>
        call.method === 'GET' ? { body: withStoredCard() } : { body: { ...withStoredCard(), status: 'OK' } },
    });
    const client = new OneBillWriteClient({ ...TEST_CONFIG, fetchImpl: mock.fetchImpl });
    await client
      .setSubscriberLinks('CLI00000', [{ ns: 'NS', value: 'acme.12345.service' }], MAPPING)
      .catch(() => undefined);

    const put = mock.apiCalls.find((c) => c.method === 'PUT')!;
    expect(put.body.accountNumber).toBe('CLI00000');
    expect(put.body.externalId).toBe('NS:acme.12345.service');
    // `status` is the envelope's own key and is likewise not settable.
    expect(Object.keys(put.body)).not.toContain('status');
  });
});

describe('contact is stripped from the write body', () => {
  /** A record whose portal login is NOT an email — the shape the API refuses to take back. */
  function withLegacyLogin() {
    return {
      accountNumber: 'CLI00000',
      accountStatus: 'Active',
      externalId: '',
      accountAttribute: [],
      contact: [
        {
          id: '00001',
          firstName: 'Alex',
          lastName: 'Reseller',
          primaryContact: true,
          userDetail: { id: '00002', username: 'alexreseller', userStatus: 0 },
        },
      ],
    };
  }

  const MAPPING = [{ group: 'PBX', ns: 'NS', valueField: 'Domain', qualifierField: 'Site' }];

  function mockFor(record: Record<string, unknown>) {
    return mockFetch({
      handler: (call) =>
        call.method === 'GET' ? { body: record } : { body: { ...record, status: 'OK' } },
    });
  }

  it('does not send the contact key at all', async () => {
    // Dropping only `userDetail` is NOT enough: the server validates the stored usernames whenever
    // `contact` appears in the payload, whatever it contains. Measured against a live tenant.
    const mock = mockFor(withLegacyLogin());
    const client = new OneBillWriteClient({ ...TEST_CONFIG, fetchImpl: mock.fetchImpl });
    await client
      .setSubscriberLinks('CLI00000', [{ ns: 'NS', value: 'acme.12345.service' }], MAPPING)
      .catch(() => undefined);

    const put = mock.apiCalls.find((c) => c.method === 'PUT')!;
    expect(Object.keys(put.body)).not.toContain('contact');
  });

  it('strips it on the externalId path too, not just the links path', async () => {
    const mock = mockFor(withLegacyLogin());
    const client = new OneBillWriteClient({ ...TEST_CONFIG, fetchImpl: mock.fetchImpl });
    await client.setSubscriberExternalId('CLI00000', 'NS:acme.12345.service').catch(() => undefined);

    const put = mock.apiCalls.find((c) => c.method === 'PUT')!;
    expect(Object.keys(put.body)).not.toContain('contact');
  });

  it('still sends the rest of the record', async () => {
    const mock = mockFor(withLegacyLogin());
    const client = new OneBillWriteClient({ ...TEST_CONFIG, fetchImpl: mock.fetchImpl });
    await client
      .setSubscriberLinks('CLI00000', [{ ns: 'NS', value: 'acme.12345.service' }], MAPPING)
      .catch(() => undefined);

    const put = mock.apiCalls.find((c) => c.method === 'PUT')!;
    expect(put.body.accountNumber).toBe('CLI00000');
    expect(put.body.externalId).toBe('NS:acme.12345.service');
  });
});
