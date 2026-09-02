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

/**
 * Build a `lstLineItems`-shaped record: one rated call, with the CDR attributes in the key/value
 * form `contentType=json` returns.
 *
 * Numbers are fictional-use (555-01xx), per CONTRIBUTING.
 */
export function fakeCallRecord(
  over: {
    eventId?: string;
    isoEventDate?: string;
    source?: string;
    destination?: string;
    ratedQuantity?: string;
    amount?: number;
    chargeCategory?: string;
  } = {},
): Record<string, unknown> {
  const {
    eventId = '1000000000000000001',
    isoEventDate = '2026-01-15 09:30:00',
    source = '13175550100',
    destination = '18005550123',
    ratedQuantity = '60.0000000000',
    amount = 0.05,
    chargeCategory = 'Toll Free Orig',
  } = over;

  return {
    eventId,
    isoEventDate,
    eventDate: '01/15/26 09:30:00 AM',
    amount,
    totalAmount: amount,
    unitPrice: 0.05,
    uomName: 'Second',
    eventType: 'USAGE',
    subscriptionIdentifier: 'acme.12345.service',
    productName: 'Domain Usage',
    priceplanName: 'Domain Usage',
    eventAttributes: [
      { key: 'SERVICE_TYPE', value: 'voice' },
      { key: 'EVENT_TYPE', value: 'Origination Calls' },
      { key: 'SOURCE', value: source },
      { key: 'DESTINATION', value: destination },
      { key: 'BILLED_TO_NUMBER', value: '' },
      { key: 'CHARGE_CATEGORY', value: chargeCategory },
      { key: 'RATED_QUANTITY', value: ratedQuantity },
      { key: 'TIME_CODE', value: 'Standard' },
      { key: 'CHARGE_CATEGORY_GROUP', value: 'Toll Free Calls' },
    ],
  };
}

/**
 * Build an `InvoiceDetail`-shaped record with the real nesting: `accountInvoiceElements` inside
 * `accountInvoiceElements`, arrays at every level, a `taxLineItem.lineItems` decoy beside the
 * charge lines, and a usage rollup whose amount is the sum of its own calls.
 *
 * The decoy is the point of this fixture. A walk that matches on the name `lineItems` rather than
 * on position picks it up as a charge, and the resulting total is wrong in a way that still looks
 * like a plausible invoice.
 */
export function fakeInvoiceDetail(
  opts: {
    /** Calls to place under the usage rollup. */
    calls?: Record<string, unknown>[];
    /** The rollup's stated amount. Defaults to the sum of `calls`, i.e. a consistent invoice. */
    usageAmount?: number;
    /** The flat recurring charge that sits beside the rollup. */
    recurringAmount?: number;
    /** Account-level cost-recovery surcharge. */
    surchargeAmount?: number;
    discount?: number;
    /** `totalCurrentCharge`. Defaults to recurring + usage + surcharge + discount. */
    totalCurrentCharge?: number;
  } = {},
): Record<string, unknown> {
  const {
    calls = [fakeCallRecord()],
    recurringAmount = 100,
    surchargeAmount = 10,
    discount = -7.5,
  } = opts;

  const callSum = calls.reduce((s, c) => s + Number(c.amount ?? 0), 0);
  const usageAmount = opts.usageAmount ?? callSum;
  const totalCurrentCharge =
    opts.totalCurrentCharge ?? recurringAmount + usageAmount + surchargeAmount + discount;

  return {
    invoiceNumber: 'INV00000',
    accountNumber: 'CLI00000',
    invoiceDate: '02/01/2026',
    cycleStart: '01/01/2026',
    cycleEnd: '02/01/2026',
    totalCurrentCharge,
    totalDiscount: discount,
    accountInvoiceElements: [
      {
        accountNumber: 'CLI00000',
        billTimeLineItems: {
          chargeLineItems: [{ description: 'COST RECOVERY SURCHARGE', amount: surchargeAmount }],
        },
        accountInvoiceElements: [
          {
            invoiceElements: [
              {
                invoiceElementName: 'SUB00000-CLI00000-Hosted Phone Seat',
                lineItems: [
                  {
                    description: 'Standard Hosted Phone Seat',
                    chargeType: 'Standard Hosted Phone Seat',
                    productName: 'Hosted Phone Seat',
                    subscriptionIdentifier: 'acme.12345.service',
                    amount: recurringAmount,
                    taxAmount: 5,
                    // The decoy: same tag name, different position, NOT a charge.
                    taxLineItem: {
                      totalTax: 5,
                      lineItems: [{ code: 'TAX1', description: 'A tax component', taxAmount: 5 }],
                    },
                  },
                  {
                    description: 'Usage Charges',
                    chargeType: 'Metered Charge',
                    amount: usageAmount,
                    usageLineItem: [
                      { eventName: 'Origination Calls', amount: usageAmount, lstLineItems: calls },
                      { eventName: 'Termination Calls', amount: 0, lstLineItems: [] },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}
