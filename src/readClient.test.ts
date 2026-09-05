import { describe, expect, expectTypeOf, it } from 'vitest';
import { OneBillApiError } from './http.js';
import { invoicePdfBytes } from './model.js';
import {
  OneBillInvoiceNotFoundError,
  OneBillReadClient,
  SUBSCRIBER_STATUSES,
} from './readClient.js';
import { FAKE_PDF_BASE64, TEST_CONFIG, fakeSubscribers, mockFetch } from './testkit.js';

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

describe('products', () => {
  it('listProducts pages by the short-page rule and reads the `product` envelope key', async () => {
    // First page full (2 rows at resultCount=2), second page short (1 row): 3 rows, 2 requests.
    const mock = mockFetch({
      handler: (call) => {
        const q = new URL(call.url).searchParams;
        const start = Number(q.get('startCount') ?? 0);
        const rows =
          start === 0
            ? [{ id: '1', code: 'A' }, { id: '2', code: 'B' }]
            : [{ id: '3', code: 'C' }];
        return { body: { product: rows, resultSize: rows.length, status: 'OK' } };
      },
    });

    const rows = await client(mock).listProducts({ pageSize: 2 });

    expect(rows).toHaveLength(3);
    expect(mock.apiCalls).toHaveLength(2);
    expect(new URL(mock.apiCalls[1]!.url).searchParams.get('startCount')).toBe('2');
  });

  it('getProduct GETs /rest/ProductService/v1/products/{code} and returns the record', async () => {
    const mock = mockFetch({
      responses: [
        { body: { id: '8802', code: 'SVX', name: 'X', pricePlanInfos: [{ code: 'P', name: 'Plan' }] } },
      ],
    });

    await expect(client(mock).getProduct('SVX')).resolves.toMatchObject({ code: 'SVX' });
    expect(mock.apiCalls[0]!.url).toBe(`${B}/rest/ProductService/v1/products/SVX`);
  });

  it('getProduct throws OneBillApiError on the in-band 10PR1036 body at HTTP 200', async () => {
    const mock = mockFetch({
      responses: [
        {
          body: {
            status: 'Bad Request',
            validationResponse: {
              successful: false,
              validationErrorInfo: [{ code: '10PR1036', message: 'Invalid product code.' }],
            },
          },
        },
      ],
    });

    await expect(client(mock).getProduct('NOPE')).rejects.toBeInstanceOf(OneBillApiError);
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

describe('searchInvoices', () => {
  it('passes the filters through and always asks for a count', async () => {
    const mock = mockFetch({ responses: [{ body: { invoice: [] } }] });
    await client(mock).searchInvoices({
      accountNumber: 'CLI00000',
      startCount: 50,
      resultCount: 25,
    });

    const q = new URL(mock.apiCalls[0]!.url).searchParams;
    expect(q.get('accountNumber')).toBe('CLI00000');
    expect(q.get('startCount')).toBe('50');
    expect(q.get('resultCount')).toBe('25');
    expect(q.get('countRequired')).toBe('true');
  });

  it('omits accountNumber entirely when not given, so the search covers the tenant', async () => {
    const mock = mockFetch({ responses: [{ body: { invoice: [] } }] });
    await client(mock).searchInvoices();
    expect(new URL(mock.apiCalls[0]!.url).searchParams.has('accountNumber')).toBe(false);
  });
});

describe('listAllInvoices', () => {
  /** Serve `total` rows in pages, reporting `resultSize` and NEVER `totalCount` — as this
   *  endpoint actually behaves. */
  function pagedInvoices(total: number) {
    return mockFetch({
      handler: (call) => {
        const q = new URL(call.url).searchParams;
        const start = Number(q.get('startCount') ?? 0);
        const size = Number(q.get('resultCount') ?? 50);
        const rows = Array.from({ length: Math.max(0, Math.min(size, total - start)) }, (_, i) => ({
          invoiceNumber: `INV${String(start + i).padStart(5, '0')}`,
          accountNumber: 'CLI00000',
        }));
        return { body: { invoice: rows, resultSize: rows.length, status: 'OK' } };
      },
    });
  }

  it('walks past page one even though the endpoint reports no totalCount', async () => {
    // The regression this guards: a `!totalCount -> stop` rule returns 50 of 62 and looks fine.
    const mock = pagedInvoices(62);
    const rows = await client(mock).listAllInvoices({ accountNumber: 'CLI00000' });

    expect(rows).toHaveLength(62);
    expect(rows[0]!.invoiceNumber).toBe('INV00000');
    expect(rows[61]!.invoiceNumber).toBe('INV00061');
    expect(mock.apiCalls).toHaveLength(2);
  });

  it('advances the offset by rows received', async () => {
    const mock = pagedInvoices(62);
    await client(mock).listAllInvoices({ accountNumber: 'CLI00000' });
    expect(new URL(mock.apiCalls[0]!.url).searchParams.get('startCount')).toBe('0');
    expect(new URL(mock.apiCalls[1]!.url).searchParams.get('startCount')).toBe('50');
  });

  it('stops on an exactly-full final page without returning duplicates', async () => {
    const mock = pagedInvoices(50);
    const rows = await client(mock).listAllInvoices({ accountNumber: 'CLI00000' });
    expect(rows).toHaveLength(50);
    expect(new Set(rows.map((r) => r.invoiceNumber)).size).toBe(50);
  });

  it('throws rather than truncating when maxPages is reached', async () => {
    const mock = pagedInvoices(500);
    await expect(
      client(mock).listAllInvoices({ accountNumber: 'CLI00000', maxPages: 2 }),
    ).rejects.toThrow(/listAllInvoices stopped after 2 pages/);
  });
});

describe('getInvoiceDetail', () => {
  it('asks for the json representation explicitly', async () => {
    const mock = mockFetch({ responses: [{ body: { invoice: { invoiceNumber: 'INV00000' } } }] });
    await client(mock).getInvoiceDetail('INV00000');

    const url = new URL(mock.apiCalls[0]!.url);
    expect(url.pathname).toBe('/rest/InvoiceService/v1/invoices/INV00000');
    // Omitting contentType would silently get a PDF back; lowercase is the only accepted spelling.
    expect(url.searchParams.get('contentType')).toBe('json');
  });

  it('returns the invoice record', async () => {
    const mock = mockFetch({
      responses: [{ body: { invoice: { invoiceNumber: 'INV00000', totalCurrentCharge: 100 } } }],
    });
    await expect(client(mock).getInvoiceDetail('INV00000')).resolves.toMatchObject({
      invoiceNumber: 'INV00000',
      totalCurrentCharge: 100,
    });
  });

  it('encodes an invoice number with awkward characters', async () => {
    const mock = mockFetch({ responses: [{ body: { invoice: {} } }] });
    await client(mock).getInvoiceDetail('a b/c');
    expect(new URL(mock.apiCalls[0]!.url).pathname).toBe(
      '/rest/InvoiceService/v1/invoices/a%20b%2Fc',
    );
  });

  it('rejects an invoice number that would resolve to another endpoint', async () => {
    const mock = mockFetch({ responses: [{ body: { invoice: {} } }] });
    await expect(client(mock).getInvoiceDetail('..')).rejects.toThrow(/different endpoint/);
    expect(mock.apiCalls).toHaveLength(0);
  });

  it('raises OneBillInvoiceNotFoundError for an unknown invoice reported in-band', async () => {
    const mock = mockFetch({
      responses: [
        {
          status: 200,
          body: {
            savedInCloud: false,
            status: 'Bad Request',
            validationResponse: {
              successful: false,
              validationErrorInfo: [
                { code: '10INWS0022', message: 'Failed to get invoice.', errorLevel: 0 },
              ],
            },
          },
        },
      ],
    });
    await expect(client(mock).getInvoiceDetail('INV99999')).rejects.toThrow(
      OneBillInvoiceNotFoundError,
    );
  });

  it('leaves a genuine transport failure as an OneBillApiError', async () => {
    // Same error code, but a real HTTP failure. Retrying that is reasonable; retrying a missing
    // invoice is not, so the two must not collapse into one class.
    const mock = mockFetch({
      responses: [
        {
          status: 503,
          body: {
            status: 'Bad Request',
            validationResponse: {
              validationErrorInfo: [{ code: '10INWS0022', message: 'Failed to get invoice.' }],
            },
          },
        },
      ],
    });
    const err = await client(mock).getInvoiceDetail('INV00000').catch((e) => e);
    expect(err).toBeInstanceOf(OneBillApiError);
    expect(err).not.toBeInstanceOf(OneBillInvoiceNotFoundError);
  });

  it('throws rather than returning an empty invoice when the payload is missing', async () => {
    const mock = mockFetch({ responses: [{ body: { status: 'OK', savedInCloud: false } }] });
    await expect(client(mock).getInvoiceDetail('INV00000')).rejects.toThrow(/No invoice payload/);
  });
});

describe('getInvoiceXml', () => {
  it('joins the chunks rather than taking the first', async () => {
    const mock = mockFetch({
      responses: [{ body: { invoiceXml: ['<invoice>', '<a/>', '</invoice>'], status: 'OK' } }],
    });
    await expect(client(mock).getInvoiceXml('INV00000')).resolves.toBe('<invoice><a/></invoice>');
    expect(new URL(mock.apiCalls[0]!.url).searchParams.get('contentType')).toBe('xml');
  });

  it('accepts the bare-string form as well as the array', async () => {
    const mock = mockFetch({ responses: [{ body: { invoiceXml: '<invoice/>', status: 'OK' } }] });
    await expect(client(mock).getInvoiceXml('INV00000')).resolves.toBe('<invoice/>');
  });

  it('throws on an empty payload instead of returning an empty document', async () => {
    const mock = mockFetch({ responses: [{ body: { invoiceXml: [], status: 'OK' } }] });
    await expect(client(mock).getInvoiceXml('INV00000')).rejects.toThrow(/No invoice XML payload/);
  });
});

describe('getInvoicePdf', () => {
  it('asks for pdf, joins the chunks, and exposes the filename', async () => {
    const half = Math.floor(FAKE_PDF_BASE64.length / 2);
    const mock = mockFetch({
      responses: [
        {
          body: {
            invoicePdf: [FAKE_PDF_BASE64.slice(0, half), FAKE_PDF_BASE64.slice(half)],
            invoiceFileName: 'INV00000',
            status: 'OK',
          },
        },
      ],
    });

    const pdf = await client(mock).getInvoicePdf('INV00000');
    expect(new URL(mock.apiCalls[0]!.url).searchParams.get('contentType')).toBe('pdf');
    expect(pdf.pdfBase64).toBe(FAKE_PDF_BASE64);
    expect(pdf.fileName).toBe('INV00000');
  });

  it('decodes to real PDF bytes', async () => {
    const mock = mockFetch({
      responses: [{ body: { invoicePdf: [FAKE_PDF_BASE64], status: 'OK' } }],
    });
    const bytes = invoicePdfBytes(await client(mock).getInvoicePdf('INV00000'));
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe('%PDF-');
  });

  it('refuses a payload that is not a PDF', async () => {
    const mock = mockFetch({
      responses: [{ body: { invoicePdf: [btoa('<html>error</html>')], status: 'OK' } }],
    });
    const pdf = await client(mock).getInvoicePdf('INV00000');
    expect(() => invoicePdfBytes(pdf)).toThrow(/not a PDF/);
  });

  it('throws on an empty payload rather than writing a zero-byte file', async () => {
    const mock = mockFetch({ responses: [{ body: { invoicePdf: [], status: 'OK' } }] });
    await expect(client(mock).getInvoicePdf('INV00000')).rejects.toThrow(/No invoice PDF payload/);
  });
});

describe('getSubscriberDocuments', () => {
  it('reads the attachments for one account', async () => {
    const mock = mockFetch({
      responses: [{ body: { documents: [{ id: 1, name: 'StateUseTaxExemption' }], status: 'OK' } }],
    });
    const docs = await client(mock).getSubscriberDocuments('CLI00000');
    expect(docs).toHaveLength(1);
    expect(docs[0]!.name).toBe('StateUseTaxExemption');
    expect(mock.apiCalls[0]!.url).toBe(
      `${B}/rest/SubscriberService/v1/subscribers/CLI00000/documents`,
    );
  });

  it('returns [] when the account has none — the key is ABSENT, not an empty array', async () => {
    // Roughly half the accounts on a live tenant omitted `documents` entirely, so
    // throws on the majority case.
    const mock = mockFetch({ responses: [{ body: { status: 'OK', isAgent: false } }] });
    await expect(client(mock).getSubscriberDocuments('CLI00000')).resolves.toEqual([]);
  });

  it('accepts a single document sent unwrapped', async () => {
    const mock = mockFetch({ responses: [{ body: { documents: { id: 1, name: 'Contract' } } }] });
    const docs = await client(mock).getSubscriberDocuments('CLI00000');
    expect(docs).toHaveLength(1);
    expect(docs[0]!.name).toBe('Contract');
  });

  it('encodes an awkward account number', async () => {
    const mock = mockFetch({ responses: [{ body: {} }] });
    await client(mock).getSubscriberDocuments('a b/c');
    expect(mock.apiCalls[0]!.url).toBe(
      `${B}/rest/SubscriberService/v1/subscribers/a%20b%2Fc/documents`,
    );
  });

  it('rejects an account number that would resolve to another endpoint', async () => {
    const mock = mockFetch({ responses: [{ body: {} }] });
    await expect(client(mock).getSubscriberDocuments('..')).rejects.toThrow(/different endpoint/);
    expect(mock.apiCalls).toHaveLength(0);
  });
});

describe('searchSubscribers status guard', () => {
  it('rejects an array and names listAllSubscribers({ statuses }) as the fix', async () => {
    // `status` and `statuses` differ only by the plural. An array reaching the query is stringified
    // to `Active,Closed,Inactive` and comes back as an in-band 10PARWS0018 at HTTP 200, which is a
    // slow thing to diagnose from the wire.
    const mock = mockFetch({ responses: [{ body: { subscriber: [] } }] });
    await expect(
      client(mock).searchSubscribers({ status: SUBSCRIBER_STATUSES as unknown as string }),
    ).rejects.toThrow(/listAllSubscribers\(\{ statuses/);
    expect(mock.apiCalls).toHaveLength(0);
  });

  it('still accepts a single status string', async () => {
    const mock = mockFetch({ responses: [{ body: { subscriber: [] } }] });
    await client(mock).searchSubscribers({ status: 'Closed' });
    expect(new URL(mock.apiCalls[0]!.url).searchParams.get('status')).toBe('Closed');
  });
});
