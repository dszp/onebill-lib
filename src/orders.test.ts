import { describe, expect, it } from 'vitest';
import { isQuoteOrder, orderStateOf, quotePdfBytes } from './model.js';
import {
  ALL_ORDER_STATE_FILTERS,
  ORDER_STATE_FILTERS,
  OneBillNoQuoteDocumentError,
  OneBillReadClient,
} from './readClient.js';
import { FAKE_PDF_BASE64, TEST_CONFIG, fakeOrders, mockFetch } from './testkit.js';

const B = TEST_CONFIG.baseUrl;

function client(mock: ReturnType<typeof mockFetch>) {
  return new OneBillReadClient({ ...TEST_CONFIG, fetchImpl: mock.fetchImpl });
}

describe('searchOrders', () => {
  it('hits the orders endpoint and always asks for a count', async () => {
    const mock = mockFetch({ responses: [{ body: { order: [] } }] });
    await client(mock).searchOrders();

    const url = new URL(mock.apiCalls[0]!.url);
    expect(url.pathname).toBe('/rest/OrderService/v1/orders');
    expect(url.searchParams.get('countRequired')).toBe('true');
  });

  it('passes the state filter through', async () => {
    const mock = mockFetch({ responses: [{ body: { order: [] } }] });
    await client(mock).searchOrders({
      searchBy: 'state',
      searchString: ORDER_STATE_FILTERS.QUOTE,
      startCount: 50,
      resultCount: 25,
    });

    const q = new URL(mock.apiCalls[0]!.url).searchParams;
    expect(q.get('searchBy')).toBe('state');
    expect(q.get('searchString')).toBe('1034');
    expect(q.get('startCount')).toBe('50');
    expect(q.get('resultCount')).toBe('25');
  });
});

describe('listAllOrders', () => {
  it('sends no state filter by default — matching the endpoint, quotes excluded', async () => {
    const mock = mockFetch({ responses: [{ body: { order: fakeOrders(3) } }] });
    const rows = await client(mock).listAllOrders();

    expect(rows).toHaveLength(3);
    const q = new URL(mock.apiCalls[0]!.url).searchParams;
    expect(q.get('searchBy')).toBeNull();
    expect(q.get('searchString')).toBeNull();
    expect(mock.apiCalls).toHaveLength(1);
  });

  it('queries each state in turn when asked for the whole tenant', async () => {
    const mock = mockFetch({ responses: ALL_ORDER_STATE_FILTERS.map(() => ({ body: { order: [] } })) });
    await client(mock).listAllOrders({ states: ALL_ORDER_STATE_FILTERS });

    const asked = mock.apiCalls.map((c) => new URL(c.url).searchParams.get('searchString'));
    expect(asked).toEqual([...ALL_ORDER_STATE_FILTERS]);
  });

  it('de-duplicates by order number, because 1002 and 1034 return the same rows', async () => {
    const quotes = fakeOrders(2, 0, { state: 1034, orderStatus: 'Quote Created' });
    const mock = mockFetch({ responses: [{ body: { order: quotes } }, { body: { order: quotes } }] });

    const rows = await client(mock).listAllOrders({ states: ['1002', '1034'] });
    expect(rows).toHaveLength(2);
  });

  it('follows pagination and stops on a short page', async () => {
    const mock = mockFetch({
      responses: [
        { body: { order: fakeOrders(50, 0), totalCount: 60 } },
        { body: { order: fakeOrders(10, 50), totalCount: 60 } },
      ],
    });

    const rows = await client(mock).listAllOrders();
    expect(rows).toHaveLength(60);
    expect(new URL(mock.apiCalls[1]!.url).searchParams.get('startCount')).toBe('50');
  });

  it('advances by rows received, not rows requested', async () => {
    // A server that ignores resultCount and returns more than asked.
    const mock = mockFetch({
      responses: [{ body: { order: fakeOrders(50, 0) } }, { body: { order: fakeOrders(4, 50) } }],
    });

    await client(mock).listAllOrders({ pageSize: 50 });
    expect(new URL(mock.apiCalls[1]!.url).searchParams.get('startCount')).toBe('50');
  });

  it('throws rather than truncating when maxPages is hit', async () => {
    const mock = mockFetch({ handler: () => ({ body: { order: fakeOrders(50) } }) });
    await expect(client(mock).listAllOrders({ maxPages: 2 })).rejects.toThrow(/listAllOrders stopped/);
  });
});

describe('getOrder', () => {
  it('reads one order and encodes the number', async () => {
    const mock = mockFetch({ responses: [{ body: { orderNumber: 'OR00000' } }] });
    await expect(client(mock).getOrder('OR00000')).resolves.toMatchObject({ orderNumber: 'OR00000' });
    expect(mock.apiCalls[0]!.url).toBe(`${B}/rest/OrderService/v1/orders/OR00000`);
  });

  it('refuses a path segment that would resolve elsewhere', async () => {
    const mock = mockFetch({ responses: [{ body: {} }] });
    await expect(client(mock).getOrder('..')).rejects.toThrow(/different endpoint/);
  });
});

describe('getQuoteDocument', () => {
  it('returns the base64 PDF and its name', async () => {
    const mock = mockFetch({
      responses: [{ body: { quotePdf: FAKE_PDF_BASE64, quoteDocName: 'OR00000-1', status: 'OK' } }],
    });

    const doc = await client(mock).getQuoteDocument('OR00000');
    expect(doc.pdfBase64).toBe(FAKE_PDF_BASE64);
    expect(doc.docName).toBe('OR00000-1');
    expect(mock.apiCalls[0]!.url).toBe(`${B}/rest/OrderService/v1/orders/OR00000/quoteDocument`);
  });

  it('throws when the payload is missing, rather than yielding an empty document', async () => {
    // OneBill answers 200 on failures, so an absent payload must not read as success.
    const mock = mockFetch({ responses: [{ body: { status: 'FAILED' } }] });
    await expect(client(mock).getQuoteDocument('OR00000')).rejects.toThrow(/No quote document/);
  });

  it('throws on an empty-string payload too', async () => {
    const mock = mockFetch({ responses: [{ body: { quotePdf: '', status: 'OK' } }] });
    await expect(client(mock).getQuoteDocument('OR00000')).rejects.toThrow(/No quote document/);
  });
});

describe('quotePdfBytes', () => {
  it('decodes to the PDF bytes', () => {
    const bytes = quotePdfBytes({ pdfBase64: FAKE_PDF_BASE64 });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
  });

  it('round-trips byte-for-byte', () => {
    const bytes = quotePdfBytes({ pdfBase64: FAKE_PDF_BASE64 });
    expect(btoa(String.fromCharCode(...bytes))).toBe(FAKE_PDF_BASE64);
  });

  it('rejects a payload that is not a PDF', () => {
    expect(() => quotePdfBytes({ pdfBase64: btoa('<html>error</html>') })).toThrow(/not a PDF/);
  });

  it('rejects invalid base64', () => {
    expect(() => quotePdfBytes({ pdfBase64: '!!!not base64!!!' })).toThrow(/not valid base64/);
  });

  it('rejects an absent payload', () => {
    expect(() => quotePdfBytes({ pdfBase64: '' })).toThrow(/no PDF payload/);
  });
});

describe('orderStateOf', () => {
  it('reads `state` from a search row', () => {
    expect(orderStateOf({ state: 1034 })).toBe(1034);
  });

  it('reads `orderState` from a single-record read', () => {
    expect(orderStateOf({ orderState: 1034 })).toBe(1034);
  });

  it('coerces the string form the single-record read sometimes uses', () => {
    expect(orderStateOf({ orderState: '1006' })).toBe(1006);
  });

  it('prefers `state` when both are present', () => {
    expect(orderStateOf({ state: 1006, orderState: '1034' })).toBe(1006);
  });

  it('is undefined when neither field is present or the value is not numeric', () => {
    expect(orderStateOf({})).toBeUndefined();
    expect(orderStateOf({ orderState: '' })).toBeUndefined();
    expect(orderStateOf({ orderState: 'Quote Created' })).toBeUndefined();
  });
});

describe('isQuoteOrder', () => {
  it('recognises a quote from a search row', () => {
    expect(isQuoteOrder({ state: 1034, orderStatus: 'Quote Created' })).toBe(true);
  });

  it('recognises the same quote from a single-record read, whose status is spelled differently', () => {
    // The live API returns "Quote Created" on search rows and "QuoteCreated" here. Matching on the
    // string would pass one of these tests and fail the other — which is the whole point.
    expect(isQuoteOrder({ orderState: '1034', orderStatus: 'QuoteCreated' })).toBe(true);
  });

  it('accepts the 1002 alias state', () => {
    expect(isQuoteOrder({ state: 1002 })).toBe(true);
  });

  it('recognises an EXPIRED quote, which the two endpoints number differently', () => {
    // Live: the same order is state 1034 when listed and 1007 when fetched. Matching only the
    // search-row number would classify every expired quote as a normal order after a getOrder().
    expect(isQuoteOrder({ state: 1034, orderStatus: 'Quote Expired' })).toBe(true);
    expect(isQuoteOrder({ orderState: '1007', orderStatus: 'QuoteExpired' })).toBe(true);
  });

  it('rejects live billing states', () => {
    for (const state of [1005, 1006, 1016, 1030]) {
      expect(isQuoteOrder({ state })).toBe(false);
    }
  });

  it('is false — not a guess — when the state is missing', () => {
    expect(isQuoteOrder({})).toBe(false);
    expect(isQuoteOrder({ orderStatus: 'Quote Created' })).toBe(false);
  });
});

describe('getQuoteDocument versions', () => {
  it('sends no version parameter by default — the server returns the current one', async () => {
    const mock = mockFetch({ responses: [{ body: { quotePdf: FAKE_PDF_BASE64, quoteDocName: 'OR00000-9' } }] });
    await client(mock).getQuoteDocument('OR00000');
    expect(new URL(mock.apiCalls[0]!.url).searchParams.get('version')).toBeNull();
  });

  it('fetches a superseded version when asked', async () => {
    const mock = mockFetch({ responses: [{ body: { quotePdf: FAKE_PDF_BASE64, quoteDocName: 'OR00000-1' } }] });
    const doc = await client(mock).getQuoteDocument('OR00000', { version: 1 });
    expect(new URL(mock.apiCalls[0]!.url).searchParams.get('version')).toBe('1');
    expect(doc.docName).toBe('OR00000-1');
  });
});

describe('orders with no quote document', () => {
  // OneBill dresses this up as an auth failure. It is not one — the very next request succeeds.
  const NO_DOC = {
    status: 'Bad Request',
    validationResponse: {
      validationErrorInfo: [
        { code: '12DS0002', message: 'Failed to process the USER_AUTHENTICATION_FAILED - Invalid access token response.' },
      ],
    },
    errorMessage: 'Get Quote document by order number failed.',
    errorCode: '11ORDWS0049',
  };

  it('throws a typed error rather than an auth error', async () => {
    const mock = mockFetch({ responses: [{ body: NO_DOC }] });
    await expect(client(mock).getQuoteDocument('OR00000')).rejects.toBeInstanceOf(
      OneBillNoQuoteDocumentError,
    );
  });

  it('names the order and does not repeat OneBill\'s false claim as fact', async () => {
    const mock = mockFetch({ responses: [{ body: NO_DOC }] });
    await expect(client(mock).getQuoteDocument('OR00000', { version: 2 })).rejects.toThrow(
      /Order OR00000 has no quote document at version 2/,
    );
  });

  it('does not retry — one request, one token', async () => {
    const mock = mockFetch({ responses: [{ body: NO_DOC }] });
    await expect(client(mock).getQuoteDocument('OR00000')).rejects.toThrow();
    expect(mock.apiCalls).toHaveLength(1);
    expect(mock.tokenCalls).toHaveLength(1);
  });

  it('tryGetQuoteDocument returns null instead, for sweeps', async () => {
    const mock = mockFetch({ responses: [{ body: NO_DOC }] });
    await expect(client(mock).tryGetQuoteDocument('OR00000')).resolves.toBeNull();
  });

  it('tryGetQuoteDocument still returns a real document', async () => {
    const mock = mockFetch({ responses: [{ body: { quotePdf: FAKE_PDF_BASE64, quoteDocName: 'OR00000-1' } }] });
    await expect(client(mock).tryGetQuoteDocument('OR00000')).resolves.toMatchObject({
      docName: 'OR00000-1',
    });
  });

  it('tryGetQuoteDocument does NOT swallow an unrelated failure', async () => {
    const other = {
      status: 'Bad Request',
      validationResponse: { validationErrorInfo: [{ message: 'Find Customer has been failed.' }] },
      errorCode: '10PARWS0018',
    };
    const mock = mockFetch({ responses: [{ body: other }] });
    await expect(client(mock).tryGetQuoteDocument('OR00000')).rejects.toThrow(/Find Customer/);
  });
});

describe('a real transport failure is never decoded as "no document"', () => {
  // Otherwise tryGetQuoteDocument turns a 403 into null, and a sweep of hundreds of orders run by
  // an under-permissioned account reports "no quote documents exist anywhere" as a clean success.
  const LOOKS_SIMILAR = {
    errorMessage: 'Get Quote document by order number failed.',
    errorCode: '11ORDWS0049',
  };

  it.each([403, 500, 401])('surfaces HTTP %i as an error, not as absence', async (status) => {
    const mock = mockFetch({ responses: [{ status, body: LOOKS_SIMILAR }] });
    await expect(client(mock).getQuoteDocument('OR00000')).rejects.not.toBeInstanceOf(
      OneBillNoQuoteDocumentError,
    );
  });

  it('tryGetQuoteDocument rethrows it rather than returning null', async () => {
    const mock = mockFetch({ responses: [{ status: 403, body: LOOKS_SIMILAR }] });
    await expect(client(mock).tryGetQuoteDocument('OR00000')).rejects.toThrow();
  });

  it('still decodes the genuine in-band 200 miss', async () => {
    // The real wire shape: HTTP 200, a non-OK `status`, AND a validationResponse. Without the
    // validationResponse it is not an in-band error at all, which is what this fixture originally
    // got wrong.
    const mock = mockFetch({
      responses: [
        {
          status: 200,
          body: {
            status: 'Bad Request',
            validationResponse: {
              validationErrorInfo: [
                { code: '12DS0002', message: 'Failed to process the USER_AUTHENTICATION_FAILED' },
              ],
            },
            ...LOOKS_SIMILAR,
          },
        },
      ],
    });
    await expect(client(mock).tryGetQuoteDocument('OR00000')).resolves.toBeNull();
  });
});
