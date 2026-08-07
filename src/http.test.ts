import { describe, expect, it } from 'vitest';
import { OneBillApiError, OneBillHttp, assertBaseUrl, type TokenCache } from './http.js';

import { TEST_CONFIG, mockFetch } from './testkit.js';

const B = TEST_CONFIG.baseUrl;

function client(mock: ReturnType<typeof mockFetch>, extra: Record<string, unknown> = {}) {
  return new OneBillHttp({ ...TEST_CONFIG, fetchImpl: mock.fetchImpl, ...extra });
}

describe('assertBaseUrl', () => {
  it('strips trailing slashes', () => {
    expect(assertBaseUrl('https://billing.example.com/')).toBe('https://billing.example.com');
    expect(assertBaseUrl('https://billing.example.com///')).toBe('https://billing.example.com');
  });

  it('requires https', () => {
    expect(() => assertBaseUrl('http://billing.example.com')).toThrow(/https/);
  });

  it('rejects embedded credentials', () => {
    // Otherwise a base URL built from request input could redirect the bearer token elsewhere.
    expect(() => assertBaseUrl('https://user:pass@billing.example.com')).toThrow(/credentials/);
  });

  it('rejects a non-URL', () => {
    expect(() => assertBaseUrl('billing.example.com')).toThrow(/absolute/);
  });
});

describe('authentication', () => {
  it('hashes the password and never sends it in the clear', async () => {
    const mock = mockFetch();
    await client(mock).request('GET', '/x');

    const tokenUrl = mock.tokenCalls[0]!.url;
    expect(tokenUrl).not.toContain(TEST_CONFIG.password);
    // SHA-256 of the fixture password, lowercase hex.
    const sent = new URL(tokenUrl).searchParams.get('password')!;
    expect(sent).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sends the documented token parameters', async () => {
    const mock = mockFetch();
    await client(mock).request('GET', '/x');

    const q = new URL(mock.tokenCalls[0]!.url).searchParams;
    expect(q.get('grant_type')).toBe('password');
    expect(q.get('client_id')).toBe(TEST_CONFIG.tenantId);
    expect(q.get('client_secret')).toBe(TEST_CONFIG.clientSecret);
    expect(q.get('username')).toBe(TEST_CONFIG.username);
    expect(q.get('scope')).toBe('trust');
    expect(mock.tokenCalls[0]!.method).toBe('POST');
  });

  it('reuses a cached token across requests', async () => {
    const mock = mockFetch();
    const c = client(mock);
    await c.request('GET', '/a');
    await c.request('GET', '/b');
    expect(mock.tokenCalls).toHaveLength(1);
    expect(mock.apiCalls).toHaveLength(2);
  });

  it('refetches once the token has expired', async () => {
    const mock = mockFetch({ token: { access_token: 'test-token', expires_in: 3600 } });
    let now = 1_000_000;
    const c = client(mock, { nowMs: () => now });

    await c.request('GET', '/a');
    // Past the 3600s lifetime minus the 5-minute safety margin.
    now += 3_400 * 1000;
    await c.request('GET', '/b');

    expect(mock.tokenCalls).toHaveLength(2);
  });

  it('uses an injected token cache', async () => {
    const store = new Map<string, any>();
    const cache: TokenCache = {
      get: (k) => store.get(k),
      set: (k, v) => void store.set(k, v),
      delete: (k) => void store.delete(k),
    };
    const mock = mockFetch();
    await client(mock, { tokenCache: cache }).request('GET', '/a');
    expect(store.size).toBe(1);
  });

  it('fails closed when the token endpoint returns 200 with no token', async () => {
    // A 200 carrying no usable token is an auth failure, not a usable session.
    const mock = mockFetch({ token: { expires_in: 3600 } });
    await expect(client(mock).request('GET', '/a')).rejects.toThrow(/no access_token/);
  });

  it('surfaces a failed token request', async () => {
    const mock = mockFetch({ tokenStatus: 401, token: { error: 'invalid_client' } });
    await expect(client(mock).request('GET', '/a')).rejects.toBeInstanceOf(OneBillApiError);
  });
});

describe('request shaping', () => {
  it('sends the mandatory tenant header and bearer token', async () => {
    const mock = mockFetch();
    await client(mock).request('GET', '/x');

    const h = mock.apiCalls[0]!.headers;
    expect(h['X-OB-Tenant-Identifier']).toBe(TEST_CONFIG.tenantId);
    expect(h.Authorization).toBe('Bearer test-token');
    expect(h.Accept).toBe('application/json');
  });

  it('builds the URL from the base and path', async () => {
    const mock = mockFetch();
    await client(mock).request('GET', '/rest/Thing/v1/x');
    expect(mock.apiCalls[0]!.url).toBe(`${B}/rest/Thing/v1/x`);
  });

  it('appends defined query params and drops undefined ones', async () => {
    const mock = mockFetch();
    await client(mock).request('GET', '/x', { query: { a: 1, b: 'two', c: undefined, d: false } });

    const q = new URL(mock.apiCalls[0]!.url).searchParams;
    expect(q.get('a')).toBe('1');
    expect(q.get('b')).toBe('two');
    expect(q.has('c')).toBe(false);
    expect(q.get('d')).toBe('false');
  });

  it('sends a body on PUT but never on GET or DELETE', async () => {
    const mock = mockFetch();
    const c = client(mock);
    await c.request('PUT', '/x', { body: { a: 1 } });
    await c.request('GET', '/y', { body: { a: 1 } });
    await c.request('DELETE', '/z', { body: { a: 1 } });

    expect(mock.apiCalls[0]!.body).toEqual({ a: 1 });
    expect(mock.apiCalls[1]!.body).toBeUndefined();
    expect(mock.apiCalls[2]!.body).toBeUndefined();
  });
});

describe('error handling', () => {
  it('throws OneBillApiError on a non-2xx, carrying context', async () => {
    const mock = mockFetch({ responses: [{ status: 404, body: { message: 'nope' } }] });
    try {
      await client(mock).request('GET', '/rest/missing');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(OneBillApiError);
      const err = e as OneBillApiError;
      expect(err.status).toBe(404);
      expect(err.path).toBe('/rest/missing');
      expect(err.method).toBe('GET');
      expect(err.body).toEqual({ message: 'nope' });
    }
  });

  it('survives a non-JSON error body', async () => {
    const mock = mockFetch({ responses: [{ status: 502, rawBody: '<html>Bad Gateway</html>' }] });
    await expect(client(mock).request('GET', '/x')).rejects.toThrow(/502/);
  });

  it('truncates a huge error body', async () => {
    const mock = mockFetch({ responses: [{ status: 500, body: { m: 'x'.repeat(5000) } }] });
    try {
      await client(mock).request('GET', '/x');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as Error).message.length).toBeLessThan(700);
    }
  });

  it('throws on an in-band error returned with HTTP 200', async () => {
    // OneBill reports validation failures at HTTP 200 with an error envelope.
    const mock = mockFetch({
      responses: [
        {
          status: 200,
          body: {
            status: 'Bad Request',
            validationResponse: {
              validationErrorInfo: [{ message: 'accountNumber is required' }],
            },
          },
        },
      ],
    });
    try {
      await client(mock).request('GET', '/x');
      expect.unreachable('should have thrown');
    } catch (e) {
      const err = e as OneBillApiError;
      expect(err).toBeInstanceOf(OneBillApiError);
      expect(err.status).toBe(200);
      expect(err.message).toContain('accountNumber is required');
    }
  });

  it('leaves a non-OK status alone when there is no validationResponse', async () => {
    // `status` is an ordinary data field on some responses; only the documented error envelope
    // counts as a failure.
    const mock = mockFetch({ responses: [{ body: { status: 'Pending', data: 1 } }] });
    await expect(client(mock).request('GET', '/x')).resolves.toEqual({ status: 'Pending', data: 1 });
  });

  it('passes a normal OK response through', async () => {
    const mock = mockFetch({ responses: [{ body: { status: 'OK', accountNumber: 'CLI00000' } }] });
    await expect(client(mock).request('GET', '/x')).resolves.toMatchObject({
      accountNumber: 'CLI00000',
    });
  });
});

describe('401 retry', () => {
  it('clears the token, re-authenticates, and retries once', async () => {
    let apiCalls = 0;
    const mock = mockFetch({
      handler: () => {
        apiCalls++;
        return apiCalls === 1 ? { status: 401, body: {} } : { body: { ok: true } };
      },
    });

    await expect(client(mock).request('GET', '/x')).resolves.toEqual({ ok: true });
    expect(mock.tokenCalls).toHaveLength(2);
    expect(mock.apiCalls).toHaveLength(2);
  });

  it('gives up after one retry', async () => {
    const mock = mockFetch({ handler: () => ({ status: 401, body: {} }) });
    try {
      await client(mock).request('GET', '/x');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as OneBillApiError).status).toBe(401);
    }
    expect(mock.apiCalls).toHaveLength(2);
  });
});

describe('regressions from the pre-publish review', () => {
  it('rejects a base URL carrying a query string or fragment', () => {
    // These swallow the path of every request built from the base, silently rerouting to `/`.
    expect(() => assertBaseUrl('https://billing.example.com/?x=1')).toThrow(/query string or fragment/);
    expect(() => assertBaseUrl('https://billing.example.com#f')).toThrow(/query string or fragment/);
  });

  it('does not share a cached token between differing scopes', async () => {
    // A shared KV cache is the documented setup, so a key covering only tenant+username would let a
    // token minted under one scope satisfy a client configured for another.
    const store = new Map<string, any>();
    const cache: TokenCache = {
      get: (k) => store.get(k),
      set: (k, v) => void store.set(k, v),
      delete: (k) => void store.delete(k),
    };
    const a = mockFetch();
    const b = mockFetch();
    await new OneBillHttp({ ...TEST_CONFIG, scope: 'trust', tokenCache: cache, fetchImpl: a.fetchImpl }).request('GET', '/x');
    await new OneBillHttp({ ...TEST_CONFIG, scope: 'other', tokenCache: cache, fetchImpl: b.fetchImpl }).request('GET', '/x');

    expect(store.size).toBe(2);
    expect(b.tokenCalls).toHaveLength(1);
  });

  it('does not share a cached token after the secret is rotated', async () => {
    const store = new Map<string, any>();
    const cache: TokenCache = {
      get: (k) => store.get(k),
      set: (k, v) => void store.set(k, v),
      delete: (k) => void store.delete(k),
    };
    const a = mockFetch();
    const b = mockFetch();
    await new OneBillHttp({ ...TEST_CONFIG, tokenCache: cache, fetchImpl: a.fetchImpl }).request('GET', '/x');
    await new OneBillHttp({ ...TEST_CONFIG, clientSecret: 'rotated-0001', tokenCache: cache, fetchImpl: b.fetchImpl }).request('GET', '/x');

    expect(store.size).toBe(2);
    expect(b.tokenCalls).toHaveLength(1);
  });

  it('keeps the secret out of the cache key itself', async () => {
    const store = new Map<string, any>();
    const cache: TokenCache = {
      get: (k) => store.get(k),
      set: (k, v) => void store.set(k, v),
      delete: (k) => void store.delete(k),
    };
    await new OneBillHttp({ ...TEST_CONFIG, tokenCache: cache, fetchImpl: mockFetch().fetchImpl }).request('GET', '/x');
    for (const key of store.keys()) {
      expect(key).not.toContain(TEST_CONFIG.clientSecret);
      expect(key).not.toContain(TEST_CONFIG.password);
    }
  });
});

describe('USER_AUTHENTICATION_FAILED at HTTP 200 is NOT a token problem', () => {
  // OneBill returns this message, with a perfectly valid token, for `quoteDocument` on an order
  // that has no document — which is most orders. Treating it as an expired token doubled every
  // request and churned a token per miss. It must surface as a plain error, with no retry.
  const AUTH_FAIL = {
    status: 'Bad Request',
    validationResponse: {
      validationErrorInfo: [
        {
          code: '12DS0002',
          message:
            'Failed to process the USER_AUTHENTICATION_FAILED - One or both of Username and Password are invalid. Invalid access token response.',
        },
      ],
    },
    errorMessage: 'Get Quote document by order number failed.',
    errorCode: '11ORDWS0049',
  };

  it('does not re-mint the token and does not replay the request', async () => {
    const mock = mockFetch({ responses: [{ body: AUTH_FAIL }] });
    const http = new OneBillHttp({ ...TEST_CONFIG, fetchImpl: mock.fetchImpl });

    await expect(http.request('GET', '/rest/x')).rejects.toThrow(/USER_AUTHENTICATION_FAILED/);
    expect(mock.apiCalls).toHaveLength(1);
    expect(mock.tokenCalls).toHaveLength(1);
  });

  it('still retries a real 401 exactly once', async () => {
    const mock = mockFetch({ responses: [{ status: 401, body: {} }, { body: { ok: true } }] });
    const http = new OneBillHttp({ ...TEST_CONFIG, fetchImpl: mock.fetchImpl });

    await expect(http.request('GET', '/rest/x')).resolves.toEqual({ ok: true });
    expect(mock.tokenCalls).toHaveLength(2);
  });
});
