import { OneBillApiError, OneBillHttp, type OneBillHttpConfig } from './http.js';
import type {
  Order,
  OrderSearchOptions,
  OrderSearchPage,
  QuoteDocument,
  QuoteDocumentResponse,
  Subscriber,
  SubscriberSearchOptions,
  SubscriberSearchPage,
  Subscription,
  SubscriptionsResponse,
} from './model.js';

/** OneBill's own maximum rows per page on the list endpoints. */
const MAX_PAGE_SIZE = 50;

/**
 * Runaway guard for {@link OneBillReadClient.listAllSubscribers}. At the maximum page size this is
 * 10,000 subscribers; hitting it means either a genuinely huge tenant or a server that is ignoring
 * the offset, and either way the caller should know rather than receive a quietly clipped list.
 */
const DEFAULT_MAX_PAGES = 200;

/**
 * The account statuses `listAllSubscribers` covers by default.
 *
 * The subscriber search filters to **active accounts only** when no `status` is given, and says
 * nothing about what it left out. Verified live: a search reporting a total omitted every closed
 * subscriber, reachable only by asking for them explicitly. There is no "all" value, so covering
 * everything means querying each status and merging.
 *
 * These three are the values the API accepts, established by rejection rather than by inference:
 * anything else fails with `10PARWS0018 "Find Customer has been failed."`, delivered as an in-band
 * error at HTTP 200. Note the API's vocabulary is **coarser than the UI's** — OneBill's own
 * subscriber screen offers Active / Delinquent / Closed / Pending Closed / Suspended / Pending
 * Suspended, and four of those six are rejected here. Presentation states are not query tokens.
 *
 * If a deployment accepts a status not listed here, pass `statuses` explicitly.
 */
export const SUBSCRIBER_STATUSES = ['Active', 'Closed', 'Inactive'] as const;

/**
 * What `listAllSubscribers` covers when the caller says nothing: **active accounts only**.
 *
 * This matches the endpoint's own behaviour, and it is a deliberate safety default — a bulk job that
 * iterates the list and writes should not reach closed or inactive accounts by accident.
 *
 * It does mean the default result is **not** every subscriber. Pass
 * `{ statuses: SUBSCRIBER_STATUSES }` when completeness is what you need, which is most read-only
 * work: reconciliation in particular has to see closed accounts, since they still carry billing
 * history and may still hold links.
 */
export const DEFAULT_LIST_STATUSES = ['Active'] as const;

/**
 * The `searchBy: 'state'` filter codes for the order search, established live 2026-08-05.
 *
 * **The order search hides quotes by default, and says nothing about it** — the same trap as the
 * subscriber search filtering to active accounts. An unfiltered walk returns only states
 * 1005 / 1006 / 1016 / 1030; quotes are reachable solely by asking for them by state. The per-state
 * counts of those four sum to exactly the unfiltered total, which is what confirms the exclusion is
 * total rather than partial.
 *
 * So a tenant's complete order history is the default set **plus** {@link ORDER_STATE_FILTERS.QUOTE},
 * which is what `listAllOrders({ states: ALL_ORDER_STATE_FILTERS })` covers.
 *
 * **These are filter selectors, not an enumeration of row states.** Either `1034` or `1002` returns
 * the same complete quote set, but the rows themselves carry one of *two* states, `1034` or
 * `1002`. The `1002` rows are the oldest quotes, and they are the only ones ever observed to have
 * no retrievable document. So do not read a row's `state` as "which filter found it", and do not
 * assume every quote has a PDF.
 */
export const ORDER_STATE_FILTERS = {
  /** Quotes: `Quote Created` and `Quote Expired`. Excluded from an unfiltered search. */
  QUOTE: '1034',
  PENDING_BILLING: '1005',
  BILLING_ACTIVE: '1006',
  PARTIALLY_FULFILLED: '1016',
  CANCELLED: '1030',
} as const;

/**
 * Every filter code in {@link ORDER_STATE_FILTERS}. Pass as `states` to `listAllOrders` when you
 * need the whole tenant, quotes included.
 *
 * This is a lower bound: it lists the codes observed to return rows. A deployment using order
 * states we have never seen would need its codes added, so pass `states` explicitly
 * rather than assuming this is exhaustive.
 */
export const ALL_ORDER_STATE_FILTERS = [
  ORDER_STATE_FILTERS.QUOTE,
  ORDER_STATE_FILTERS.PENDING_BILLING,
  ORDER_STATE_FILTERS.BILLING_ACTIVE,
  ORDER_STATE_FILTERS.PARTIALLY_FULFILLED,
  ORDER_STATE_FILTERS.CANCELLED,
] as const;

export type OneBillReadClientConfig = OneBillHttpConfig;

/**
 * Guard a value destined for a URL path segment.
 *
 * `encodeURIComponent` leaves `.` and `..` alone, and `new URL()` then resolves them — so an account
 * number of `".."` walks up to a different endpoint and `"."` or `""` lands on the *collection*,
 * whose page envelope then comes back typed as a single record. Slashes are safely encoded, so
 * exactly these three values escape.
 */
export function assertPathSegment(value: string, what: string): string {
  const s = String(value ?? '');
  if (s === '' || s === '.' || s === '..') {
    throw new Error(`Invalid ${what} ${JSON.stringify(s)}: it would resolve to a different endpoint`);
  }
  return encodeURIComponent(s);
}

/**
 * Read-only access to OneBill.
 *
 * Every method here is a GET. There is deliberately no `create`, `update`, `delete`, or generic
 * `call()` escape hatch, and the transport underneath is private and unexported — so holding one of
 * these is proof you cannot write. Keep it that way: adding a single mutating method destroys that
 * guarantee for every consumer at once. Writes live in `OneBillWriteClient`.
 */
export class OneBillReadClient {
  readonly #http: OneBillHttp;

  constructor(cfg: OneBillReadClientConfig) {
    this.#http = new OneBillHttp(cfg);
  }

  /** Read one subscriber in full, by account number. */
  async getSubscriber(accountNumber: string): Promise<Subscriber> {
    return this.#http.request<Subscriber>(
      'GET',
      `/rest/SubscriberService/v1/subscribers/${assertPathSegment(accountNumber, 'account number')}`,
    );
  }

  /**
   * One page of subscribers.
   *
   * OneBill supports searching on a single field at a time, and documents no vocabulary of legal
   * `searchBy` values for subscribers — treat an unrecognized one as returning everything rather
   * than erroring.
   */
  async searchSubscribers(opts: SubscriberSearchOptions = {}): Promise<SubscriberSearchPage> {
    return this.#http.request<SubscriberSearchPage>('GET', '/rest/SubscriberService/v1/subscribers', {
      query: {
        searchBy: opts.searchBy,
        searchString: opts.searchString,
        orderBy: opts.orderBy,
        ascending: opts.ascending,
        status: opts.status,
        startCount: opts.startCount,
        resultCount: opts.resultCount,
        countRequired: true,
      },
    });
  }

  /**
   * Every subscriber, following pagination to the end.
   *
   * **On the termination rule.** The obvious approach — stop once you have `totalCount` rows — is
   * unsafe across this API, because whether that field exists varies by endpoint and the published
   * spec is wrong about which. Verified live 2026-07-31: subscriber search and the orders endpoint
   * do return `totalCount`; leads, invoices, and products return only `resultSize`, the size of the
   * page you just received. Code shaped as "stop if `totalCount` is missing" silently returns one
   * page as the whole result set on the second group.
   *
   * So the primary rule is **a short page ends the walk**: fewer rows than requested means there
   * are no more, which holds regardless of which counters an endpoint reports. `totalCount` is
   * honoured as an additional stop when the server does supply it, purely to avoid one needless
   * request for a page that would come back empty.
   *
   * Throws rather than truncating if `maxPages` is reached — a quietly clipped list is the exact
   * failure this method exists to avoid.
   *
   * **On status — read this before trusting the result.** The endpoint filters to *active* accounts
   * when no status is supplied, and gives no hint that it did: verified live, a search reporting a
   * confident total omitted every closed account. This method keeps that narrower behaviour by default
   * ({@link DEFAULT_LIST_STATUSES}) so that a bulk job which iterates and writes cannot reach a
   * closed account by accident.
   *
   * The consequence is that **the default does not return every subscriber**, despite the name. For
   * read-only work that needs completeness — reconciliation above all, since closed accounts still
   * carry billing history and may still hold links — pass
   * `{ statuses: SUBSCRIBER_STATUSES }`. There is no "all" value in the API, so this queries each
   * status in turn and merges, de-duplicating by account number.
   */
  async listAllSubscribers(
    opts: {
      pageSize?: number;
      maxPages?: number;
      search?: SubscriberSearchOptions;
      /**
       * Statuses to cover. Defaults to {@link DEFAULT_LIST_STATUSES} (active only).
       * Pass {@link SUBSCRIBER_STATUSES} for every subscriber.
       */
      statuses?: readonly string[];
    } = {},
  ): Promise<Subscriber[]> {
    const statuses = opts.statuses ?? DEFAULT_LIST_STATUSES;

    const all: Subscriber[] = [];
    const seen = new Set<string>();

    for (const status of statuses) {
      for (const row of await this.#listOneStatus(status, opts)) {
        // De-duplicate defensively: one account should not appear under two statuses, but a caller
        // can pass overlapping filters, and a duplicated subscriber would corrupt any index.
        const key = row.accountNumber;
        if (key !== undefined && seen.has(key)) continue;
        if (key !== undefined) seen.add(key);
        all.push(row);
      }
    }

    return all;
  }

  /** Page through one status. `undefined` uses the endpoint's own default (active only). */
  async #listOneStatus(
    status: string | undefined,
    opts: { pageSize?: number; maxPages?: number; search?: SubscriberSearchOptions },
  ): Promise<Subscriber[]> {
    return this.#pageThrough(
      opts,
      (startCount, resultCount) =>
        this.searchSubscribers({
          ...opts.search,
          status: status ?? opts.search?.status,
          startCount,
          resultCount,
        }),
      (res) => res.subscriber ?? [],
      `listAllSubscribers`,
      status ? ` with status ${status}` : '',
    );
  }

  /**
   * The shared pagination walk, used by every `listAll*` method.
   *
   * **On the termination rule** — see `listAllSubscribers` for why this is shaped the way it is.
   * A short page ends the walk, `totalCount` is honoured only as an extra stop when present, and
   * the offset advances by rows *received* rather than rows *requested*.
   */
  async #pageThrough<TPage, TRow>(
    opts: { pageSize?: number; maxPages?: number },
    fetchPage: (startCount: number, resultCount: number) => Promise<TPage>,
    rowsOf: (page: TPage) => TRow[],
    what: string,
    qualifier: string,
  ): Promise<TRow[]> {
    const pageSize = Math.min(Math.max(opts.pageSize ?? MAX_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;

    const rows: TRow[] = [];
    let startCount = 0;

    for (let page = 0; page < maxPages; page++) {
      const res = await fetchPage(startCount, pageSize);

      const batch = rowsOf(res);
      rows.push(...batch);

      // A short page — including an empty one — is the end of the data.
      if (batch.length < pageSize) return rows;

      // Honour totalCount when the endpoint actually reports it.
      const totalCount = (res as { totalCount?: unknown }).totalCount;
      if (typeof totalCount === 'number' && rows.length >= totalCount) return rows;

      // Advance by what ARRIVED, not by what was asked for. `resultCount` is not honoured
      // everywhere — `ProductService/v1/products` returned 26 rows for `resultCount=5` — and against
      // such an endpoint, advancing by the requested size would re-request rows already collected.
      startCount += batch.length;
    }

    throw new Error(
      `${what} stopped after ${maxPages} pages (${rows.length} rows${qualifier}) without reaching ` +
        `the end. Raise maxPages if the tenant is genuinely this large, or check whether the server ` +
        `is honouring the startCount offset.`,
    );
  }

  /** The subscriptions held by one subscriber. */
  async getSubscriptions(accountNumber: string): Promise<Subscription[]> {
    const res = await this.#http.request<SubscriptionsResponse>(
      'GET',
      `/rest/SubscriberService/v1/subscribers/${assertPathSegment(accountNumber, 'account number')}/subscriptions`,
    );
    return res.subscriptions ?? [];
  }

  /**
   * One page of orders.
   *
   * **This endpoint hides quotes unless you ask for them.** With no `searchBy`/`searchString` it
   * returns every order *except* those in a quote state, and reports a `totalCount` that reflects
   * the narrowed set — so nothing about the response reveals that anything was withheld. Pass
   * `{ searchBy: 'state', searchString: ORDER_STATE_FILTERS.QUOTE }` for quotes, or use
   * `listAllOrders({ states: ALL_ORDER_STATE_FILTERS })`.
   *
   * Every other filter name we tried is accepted and silently ignored — see
   * {@link OrderSearchOptions.searchBy}.
   */
  async searchOrders(opts: OrderSearchOptions = {}): Promise<OrderSearchPage> {
    return this.#http.request<OrderSearchPage>('GET', '/rest/OrderService/v1/orders', {
      query: {
        searchBy: opts.searchBy,
        searchString: opts.searchString,
        orderBy: opts.orderBy,
        ascending: opts.ascending,
        startCount: opts.startCount,
        resultCount: opts.resultCount,
        countRequired: true,
      },
    });
  }

  /**
   * Every order, following pagination to the end.
   *
   * **The default does not return quotes**, because the endpoint's own default does not. That is
   * deliberate: it matches the server, and an order list that silently grew to include quotes would
   * break anyone counting revenue. Pass `{ states: ALL_ORDER_STATE_FILTERS }` for the whole tenant,
   * or `{ states: [ORDER_STATE_FILTERS.QUOTE] }` for quotes alone.
   *
   * Results are de-duplicated by order number, because the state filters are not disjoint — the
   * `1002` and `1034` codes return the same quote rows.
   */
  async listAllOrders(
    opts: {
      pageSize?: number;
      maxPages?: number;
      search?: OrderSearchOptions;
      /**
       * `searchBy: 'state'` codes to cover. Omit for the endpoint's own default, which **excludes
       * quotes**. See {@link ORDER_STATE_FILTERS}.
       */
      states?: readonly string[];
    } = {},
  ): Promise<Order[]> {
    const states = opts.states ?? [undefined];

    const all: Order[] = [];
    const seen = new Set<string>();

    for (const state of states) {
      const rows = await this.#pageThrough(
        opts,
        (startCount, resultCount) =>
          this.searchOrders({
            ...opts.search,
            ...(state === undefined
              ? {}
              : { searchBy: 'state', searchString: state }),
            startCount,
            resultCount,
          }),
        (res) => res.order ?? [],
        'listAllOrders',
        state === undefined ? '' : ` in state ${state}`,
      );

      for (const row of rows) {
        const key = row.orderNumber;
        if (key !== undefined && seen.has(key)) continue;
        if (key !== undefined) seen.add(key);
        all.push(row);
      }
    }

    return all;
  }

  /** One order in full, by order number. A quote is an order, so this reads quotes too. */
  async getOrder(orderNumber: string): Promise<Order> {
    return this.#http.request<Order>(
      'GET',
      `/rest/OrderService/v1/orders/${assertPathSegment(orderNumber, 'order number')}`,
    );
  }

  /**
   * The rendered quote PDF for an order.
   *
   * **Undocumented.** This endpoint appears nowhere in OneBill's published OpenAPI, which declares
   * `application/json` for all 152 of its responses and never mentions PDFs at all. Found by
   * probing; verified live 2026-08-05/06.
   *
   * The PDF arrives base64-encoded *inside* the JSON body rather than as a binary response, so
   * there is no `Content-Disposition` and no streaming. Decode with `quotePdfBytes`.
   *
   * **It really is the quote**, not a generic order printout — the rendered document is titled as a
   * quote and carries an acceptance/signature section. But it exists only where a quote existed:
   * an order raised directly, with no quote behind it, has no document. Most orders sampled across
   * every non-quote state had none, and every order that did have one was at version ≥ 2 —
   * consistent with having come through a quote that was revised, then converted.
   *
   * **Versions.** A quote superseded by a revision keeps one order number and gains a document
   * version — `docName` is `OR00000-3` for the third. Omitting `version` returns the **current**
   * one; pass `version` to retrieve a superseded one, which is what makes an audit trail of what a
   * customer was actually shown possible. Versions up to 9 have been observed.
   *
   * Throws {@link OneBillNoQuoteDocumentError} when the order has no document — see that class for
   * why detecting it is not straightforward — and a plain `Error` if a 200 arrives carrying no
   * payload at all, rather than returning an empty document that would be written to disk as a
   * zero-byte `.pdf` and counted as success.
   */
  async getQuoteDocument(
    orderNumber: string,
    opts: {
      /**
       * Which document version to fetch. Omit for the current one. Note `version` is the only
       * parameter that works — `quoteVersion`, `docVersion`, `revision` and `quoteDocName` are each
       * accepted and silently ignored, returning the current version.
       */
      version?: number;
    } = {},
  ): Promise<QuoteDocument> {
    const path = `/rest/OrderService/v1/orders/${assertPathSegment(orderNumber, 'order number')}/quoteDocument`;

    let res: QuoteDocumentResponse;
    try {
      res = await this.#http.request<QuoteDocumentResponse>('GET', path, {
        query: { version: opts.version },
      });
    } catch (err) {
      if (isMissingQuoteDocument(err)) {
        throw new OneBillNoQuoteDocumentError(orderNumber, opts.version, err);
      }
      throw err;
    }

    const pdfBase64 = res.quotePdf;
    if (typeof pdfBase64 !== 'string' || pdfBase64 === '') {
      throw new Error(
        `No quote document payload for order ${orderNumber}` +
          `${res.status ? ` (OneBill reported status ${JSON.stringify(res.status)})` : ''}`,
      );
    }

    return { pdfBase64, docName: res.quoteDocName, raw: res };
  }

  /**
   * As {@link getQuoteDocument}, but `null` instead of throwing when the order has no document.
   *
   * This is the one to use when sweeping many orders, where "no quote was ever raised" is an
   * ordinary answer rather than a failure — which is the common case.
   */
  async tryGetQuoteDocument(
    orderNumber: string,
    opts: { version?: number } = {},
  ): Promise<QuoteDocument | null> {
    try {
      return await this.getQuoteDocument(orderNumber, opts);
    } catch (err) {
      if (err instanceof OneBillNoQuoteDocumentError) return null;
      throw err;
    }
  }
}

/**
 * Raised when an order simply has no quote document.
 *
 * **OneBill reports this as an authentication failure, and it is not one.** The response is
 * HTTP 200 carrying `USER_AUTHENTICATION_FAILED - One or both of Username and Password are
 * invalid. Invalid access token response.` — with a perfectly good token, on a connection whose
 * very next request succeeds. The honest signal is `errorCode` (`11ORDWS0049`) and the
 * `errorMessage` (`Get Quote document by order number failed.`).
 *
 * This matters beyond tidiness: taking the message at face value leads straight to re-minting a
 * token on every order that lacks a document, which on a normal tenant is most of them.
 */
export class OneBillNoQuoteDocumentError extends Error {
  constructor(
    public readonly orderNumber: string,
    public readonly version: number | undefined,
    /** The underlying `OneBillApiError`, with OneBill's misleading message intact. */
    public readonly cause: unknown,
  ) {
    super(
      `Order ${orderNumber} has no quote document${version === undefined ? '' : ` at version ${version}`}. ` +
        `(OneBill reports this as USER_AUTHENTICATION_FAILED, which it is not.)`,
    );
    this.name = 'OneBillNoQuoteDocumentError';
  }
}

/**
 * Is this error OneBill's mislabelled "that order has no quote document"?
 *
 * **Gated on HTTP 200.** The miss is always reported in-band — a 200 whose body carries
 * `errorCode 11ORDWS0049`. A genuine transport failure that happens to carry similar text (a 403
 * from an under-permissioned account, say, or a 500) must NOT be decoded as "no document", because
 * `tryGetQuoteDocument` turns that into `null` and a sweep of several hundred orders would then
 * report "no quote documents exist anywhere" as a clean success. Failing loudly on a real error is
 * the whole point of distinguishing the two.
 */
function isMissingQuoteDocument(err: unknown): boolean {
  if (!(err instanceof OneBillApiError)) return false;
  if (err.status !== 200) return false;
  const body = err.body as { errorCode?: unknown; errorMessage?: unknown } | null;
  if (body && typeof body === 'object') {
    if (body.errorCode === '11ORDWS0049') return true;
    if (typeof body.errorMessage === 'string' && /quote document/i.test(body.errorMessage)) {
      return true;
    }
  }
  return false;
}
