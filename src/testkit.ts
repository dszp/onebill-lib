/**
 * Shared test helpers: a recording mock `fetch` that speaks OneBill's shapes.
 *
 * Build-excluded and never exported from the package barrel, but type-checked by
 * `tsconfig.test.json` — and, like the rest of the source, Node-free.
 */

/** One request the client made. */
export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Parsed request body, if there was one. */
  body?: any;
}

/** What the mock should answer with. */
export interface MockResponse {
  status?: number;
  /** JSON body. Ignored when `rawBody` is set. */
  body?: unknown;
  /** Non-JSON body, for exercising the parse fallback (an HTML error page, say). */
  rawBody?: string;
}

export interface MockFetchOptions {
  /** Body for the OAuth token endpoint. Defaults to a valid one-hour token. */
  token?: unknown;
  /** HTTP status for the OAuth token endpoint. Defaults to 200. */
  tokenStatus?: number;
  /** Answer for a non-token call. Consulted before `responses`. */
  handler?: (call: RecordedCall) => MockResponse | undefined;
  /** Queue of answers for non-token calls, consumed in order. */
  responses?: MockResponse[];
}

export interface MockFetch {
  fetchImpl: typeof fetch;
  /** Every call, in order, including token calls. */
  calls: RecordedCall[];
  /** Just the calls to the OAuth token endpoint. */
  tokenCalls: RecordedCall[];
  /** Every call except the token calls. */
  apiCalls: RecordedCall[];
}

function toResponse(spec: MockResponse): Response {
  const status = spec.status ?? 200;
  if (spec.rawBody !== undefined) {
    return new Response(spec.rawBody, { status, headers: { 'content-type': 'text/html' } });
  }
  return new Response(JSON.stringify(spec.body ?? {}), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A recording mock `fetch` that answers OneBill's OAuth endpoint automatically. */
export function mockFetch(opts: MockFetchOptions = {}): MockFetch {
  const calls: RecordedCall[] = [];
  const queue = [...(opts.responses ?? [])];

  const fetchImpl = (async (input: any, init: any = {}) => {
    const url = String(input);
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: RecordedCall = {
      method: init.method ?? 'GET',
      url,
      headers,
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);

    if (url.includes('/oauth/token')) {
      return toResponse({
        status: opts.tokenStatus ?? 200,
        body: opts.token ?? { access_token: 'test-token', expires_in: 3600 },
      });
    }

    const fromHandler = opts.handler?.(call);
    if (fromHandler) return toResponse(fromHandler);

    return toResponse(queue.shift() ?? {});
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    calls,
    get tokenCalls() {
      return calls.filter((c) => c.url.includes('/oauth/token'));
    },
    get apiCalls() {
      return calls.filter((c) => !c.url.includes('/oauth/token'));
    },
  };
}

/** Credentials for a mock client. Entirely fictional. */
export const TEST_CONFIG = {
  tenantId: 'tenant-0000',
  clientSecret: 'secret-0000',
  username: 'api@example.com',
  password: 'not-a-real-password',
  baseUrl: 'https://billing.example.com',
} as const;

/** Build `n` fictional subscriber rows, numbered from `from`. */
export function fakeSubscribers(n: number, from = 0): { accountNumber: string; accountName: string }[] {
  return Array.from({ length: n }, (_, i) => ({
    accountNumber: `CLI${String(from + i).padStart(5, '0')}`,
    accountName: `Acme Division ${from + i}`,
  }));
}

/** Build `n` fictional order rows, numbered from `from`. */
export function fakeOrders(
  n: number,
  from = 0,
  over: Record<string, unknown> = {},
): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({
    orderNumber: `OR${String(from + i).padStart(5, '0')}`,
    accountNumber: `CLI${String(from + i).padStart(5, '0')}`,
    state: 1006,
    orderStatus: 'Billing Active',
    ...over,
  }));
}

/**
 * Base64 of a minimal but genuine PDF — `%PDF-1.4` header through `%%EOF`.
 *
 * Real bytes matter here: `quotePdfBytes` checks the magic number, so a placeholder string would
 * make the happy-path tests pass for the wrong reason.
 */
export const FAKE_PDF_BASE64 = btoa('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
