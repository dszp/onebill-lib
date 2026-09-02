/**
 * Domain types for the OneBill API.
 *
 * Typing philosophy: OneBill returns rich JSON whose exact shape drifts, and whose published
 * OpenAPI document is a Postman export that is demonstrably incomplete — several Subscriber
 * operations have no request body documented at all, and fields observed on the wire are missing
 * from the response schemas. So we type ONLY the fields this library reads, mark almost everything
 * optional, and keep every wire-facing record index-signature-open (`[k: string]: any`). Drift in
 * unrelated fields never breaks the build, and callers can still reach anything the API returns.
 *
 * Treat the published spec as a lower bound on what exists, and a live response as the authority.
 */

/** A loose record — the escape hatch for anything this library does not model. */
export type Rec = Record<string, any>;

/**
 * A OneBill Subscriber (a billed customer account).
 *
 * Two endpoints return subscriber-shaped objects with different levels of detail: the search
 * endpoint returns a thin row, and the single-record endpoint returns the full account. This one
 * interface covers both, so every field but `accountNumber` is optional.
 */
export interface Subscriber {
  /** The account number, e.g. `CLI00000`. The only identifier OneBill's REST paths accept. */
  accountNumber: string;
  accountName?: string;
  companyName?: string;
  /**
   * The free-text external identifier this library's link codec packs.
   *
   * Absent from the published OpenAPI response schemas for Subscriber, but present on the wire
   * (observed on the search endpoint, 2026-07-31). Optional here because the spec and the API
   * disagree and the spec may be right for some tenants or versions.
   */
  externalId?: string;
  /**
   * Text status: `Active`, `Closed`, or `Inactive`. Undocumented in the published spec but returned.
   *
   * Note the search endpoint filters to ACTIVE by default, so a list built without an explicit
   * status will contain only `Active` here — which makes this field look uniform and trustworthy
   * when it is merely filtered. See `SubscriberSearchOptions.status`.
   */
  accountStatus?: string;
  /** Set on closed accounts: `{ closedDate }`. Absent otherwise. */
  closedAccountInfo?: Rec;
  /** Timestamp the account was closed. Present on the single-record read. */
  closedOn?: string;
  accountType?: number;
  emailId?: string;
  phoneNumber?: string;
  createdDate?: string;
  /** The reselling partner's display name, returned on search rows. */
  sellerName?: string;
  sellerPartyRoleId?: string;
  /** Internal numeric id. Not usable as a REST path parameter — use `accountNumber`. */
  id?: number;
  /** Present only on the single-record read, not on search rows. */
  subscriberId?: string;
  [k: string]: any;
}

/** One page of a subscriber search. */
export interface SubscriberSearchPage {
  /** The rows in this page. Absent rather than empty when nothing matched. */
  subscriber?: Subscriber[];
  /** The number of rows in THIS page — not the total matching the query. */
  resultSize?: number;
  /**
   * Total rows matching the query, on the endpoints that report it. **Never assume it exists.**
   *
   * Verified live 2026-07-31: subscriber search and `OrderService/v1/orders` return it; leads,
   * invoices, and products return `resultSize` only. The published spec is wrong in both
   * directions — it omits `totalCount` from the subscriber schema (where it is present) and claims
   * orders are the only endpoint that has it.
   *
   * Pagination that stops when this is missing therefore terminates after one page on some
   * endpoints and not others. See `listAllSubscribers` for the rule that works either way.
   */
  totalCount?: number;
  status?: string;
  [k: string]: any;
}

/** Options accepted by the subscriber search endpoint. */
export interface SubscriberSearchOptions {
  /**
   * Account status to return. **Undocumented, and the default is a trap:** omitting it returns
   * ACTIVE accounts only, silently excluding closed ones, with no indication that anything was left
   * out. Verified live 2026-07-31 — a search reporting a total omitted every closed subscriber, and
   * they were reachable only via `status: 'Closed'`.
   *
   * Accepted values are `Active`, `Closed`, and `Inactive` — a **coarser vocabulary than the UI's**,
   * which additionally offers Delinquent, Pending Closed, Suspended and Pending Suspended. Those
   * four are query-rejected. There is **no "all" value**; to cover everything you must query each
   * status and merge, which is what `listAllSubscribers` does.
   *
   * An unrecognised status fails with `10PARWS0018 "Find Customer has been failed."` as an in-band
   * error at HTTP 200 — so a typo is loud, provided the caller checks for in-band errors.
   */
  status?: string;
  /** The field name to search on. OneBill documents no vocabulary of legal values. */
  searchBy?: string;
  /** The value to search for. OneBill supports one field at a time. */
  searchString?: string;
  orderBy?: string;
  ascending?: boolean;
  /** Row offset, not page index. */
  startCount?: number;
  /** Rows per page. */
  resultCount?: number;
}

/** A charge attached to a subscription offer. */
export interface SubscriptionCharge {
  /** `REC`, `USAGE`, or `ONE_TIME`. */
  type?: string;
  name?: string;
  cycleMode?: string;
  cycleUnit?: string;
  cycleWhen?: string;
  [k: string]: any;
}

/** One offer within a subscription. */
export interface SubscriptionOffer {
  name?: string;
  subsOfferId?: string;
  /** Decimal string, e.g. `"2.0000000000"`. */
  quantity?: string;
  status?: number;
  activationStartDate?: string;
  activationEndDate?: string;
  subscriptionCharge?: SubscriptionCharge[];
  [k: string]: any;
}

/** A subscription held by a subscriber. */
export interface Subscription {
  subscriptionId?: string;
  /**
   * Usually an opaque composite label, e.g. `SUB00000-PRODUCT-Tier` — but **not always**.
   *
   * Some products deliberately override it to carry a routable value, which is how a usage product
   * points at the PBX domain whose minutes it bills. Treating this field as universally opaque
   * misses that; treating it as universally meaningful is worse. Which products override it is
   * deployment-specific configuration — see `findUsageSubscriptions`.
   */
  subscriptionIdentifier?: string;
  accountId?: string;
  /**
   * Subscription state. Typed loosely on purpose: the published spec says number, and a string
   * (`"ACTIVE"`) has been observed on the wire. The vocabulary is undocumented either way, so this
   * library reads activation dates rather than interpreting it.
   */
  state?: number | string;
  quantity?: string;
  activationStartDate?: string;
  activationEndDate?: string;
  subscriptionOffer?: SubscriptionOffer[];
  /** Per-subscription key/value bag. */
  subsServiceAttribute?: { parameter?: string; value?: string; [k: string]: any }[];
  serviceAddress?: Rec;
  [k: string]: any;
}

/** The envelope returned by the subscriber-subscriptions endpoint. */
export interface SubscriptionsResponse {
  subscriptions?: Subscription[];
  resultSize?: number;
  status?: string;
  [k: string]: any;
}

/**
 * An order, which in OneBill is also how a **quote** is represented — a quote is an order in a
 * quote state, not a separate object.
 *
 * As with `Subscriber`, two endpoints return order-shaped objects at different levels of detail,
 * and this one interface covers both.
 *
 * **The state field is named differently on each.** Search rows carry `state`; the single-record
 * read carries `orderState`. Reading only one of them silently sees `undefined` half the time, so
 * both are declared here and {@link orderStateOf} reads whichever is present.
 */
export interface Order {
  /** The order number, e.g. `OR00000`. The identifier the REST paths accept. */
  orderNumber?: string;
  /** Numeric state, on **search rows**. See `ORDER_STATE_FILTERS`. */
  state?: number;
  /** Numeric state, on the **single-record read**. Same vocabulary as `state`. */
  orderState?: number | string;
  /**
   * Text status — **do not match on this.** The two endpoints spell it differently for the same
   * order: search rows return `"Quote Created"` and `"Quote Expired"`, while the single-record read
   * returns `"QuoteCreated"` and `"QuoteExpired"` with no space (verified live 2026-08-05). Code
   * comparing against one spelling works while iterating a list and silently stops working after a
   * `getOrder()`.
   *
   * Match on the numeric state instead — {@link orderStateOf} and {@link isQuoteOrder}.
   */
  orderStatus?: string;
  accountNumber?: string;
  accountName?: string;
  orderName?: string;
  orderId?: string;
  orderAmount?: string;
  taxAmount?: string;
  subtotal?: string;
  surchargeAmount?: string;
  surchargeTaxAmount?: string;
  couponDiscountAmount?: string;
  currency?: string;
  currencySymbol?: string;
  orderType?: number;
  itemCount?: number;
  createdDate?: string;
  createdBy?: string;
  fulfilledDate?: string;
  orderSubmissionDate?: string;
  /** Present on quotes: when the quote stops being valid. */
  expiryDate?: string;
  /** Present on quotes. Matches the `-N` suffix on `QuoteDocument.docName`. */
  quoteVersion?: number | string;
  /** Present on quotes. */
  isQuoteExpired?: boolean;
  /** The order's line items, each carrying its own charge and tax detail. */
  orderElement?: Rec[];
  sellerName?: string;
  submitter?: string;
  [k: string]: any;
}

/** One page of an order search. */
export interface OrderSearchPage {
  /** The rows in this page. Note the key is singular, as on the subscriber search. */
  order?: Order[];
  /** Total rows matching the query. Present on this endpoint — but see `SubscriberSearchPage.totalCount`. */
  totalCount?: number;
  startCount?: number;
  endCount?: number;
  status?: string;
  [k: string]: any;
}

/** Options accepted by the order search endpoint. */
export interface OrderSearchOptions {
  /**
   * The field to filter on. **The only pair observed to have any effect is
   * `searchBy: 'state'` with a numeric `searchString`.**
   *
   * Verified live 2026-08-05: `orderType`, `orderStatus`, `status`, `state`, `orderState`,
   * `orderCategory`, `includeQuote`, `includeQuotes`, `isQuote`, `quote` and `showQuote` are all
   * accepted and then **silently ignored** — every one returned the unfiltered result set. A filter
   * that does nothing and says nothing is the failure mode to design around here.
   */
  searchBy?: string;
  /** The value to filter by. With `searchBy: 'state'`, one of the `ORDER_STATE_FILTERS` codes. */
  searchString?: string;
  orderBy?: string;
  ascending?: boolean;
  /** Row offset, not page index. */
  startCount?: number;
  /** Rows per page. */
  resultCount?: number;
}

/**
 * The rendered PDF of an order or quote, as returned by the `quoteDocument` endpoint.
 *
 * `pdfBase64` is standard base64 of the PDF bytes — pass it to {@link quotePdfBytes} to get
 * something you can write to disk or return from a Worker.
 */
export interface QuoteDocument {
  /** Base64-encoded PDF. Observed to begin `JVBERi0` (`%PDF-`). */
  pdfBase64: string;
  /** OneBill's own name for the document, e.g. `OR00000-1`, where the suffix is the quote version. */
  docName?: string;
  /** The raw envelope, for anything this interface does not model. */
  raw?: Rec;
}

/** The envelope the `quoteDocument` endpoint actually returns. */
export interface QuoteDocumentResponse {
  quotePdf?: string;
  quoteDocName?: string;
  status?: string;
  [k: string]: any;
}

/**
 * Decode {@link QuoteDocument.pdfBase64} into the PDF's bytes.
 *
 * Uses `atob`, which is a Web API present in Workers, browsers and Node — deliberately not
 * `Buffer`, which would bind this library to Node. Write the result with `fs.writeFileSync`, hand
 * it to `new Response(bytes, ...)` in a Worker, or feed it to an e-signature API.
 *
 * Throws if the string is not valid base64 or does not decode to a PDF. Failing here is better
 * than handing a caller a corrupt file: OneBill answers with HTTP 200 even when something has gone
 * wrong, so a truncated or error-shaped payload would otherwise be written to disk as a `.pdf`
 * that no reader can open.
 */
export function quotePdfBytes(doc: QuoteDocument): Uint8Array {
  return decodePdfBase64(doc.pdfBase64, 'Quote document');
}

/**
 * Decode {@link InvoicePdf.pdfBase64} into the PDF's bytes.
 *
 * Same contract and same guarantees as {@link quotePdfBytes} — see it for why this validates
 * rather than trusting the payload.
 */
export function invoicePdfBytes(doc: InvoicePdf): Uint8Array {
  return decodePdfBase64(doc.pdfBase64, 'Invoice document');
}

/**
 * The shared decode behind {@link quotePdfBytes} and {@link invoicePdfBytes}.
 *
 * One implementation on purpose: both endpoints answer HTTP 200 when something has gone wrong, so
 * the validation is the whole value of these functions, and two copies of it would eventually be
 * two different amounts of validation.
 */
function decodePdfBase64(b64: unknown, what: string): Uint8Array {
  if (typeof b64 !== 'string' || b64 === '') {
    throw new Error(`${what} has no PDF payload`);
  }

  let binary: string;
  try {
    binary = atob(b64);
  } catch {
    throw new Error(`${what} payload is not valid base64`);
  }

  // Check the magic number BEFORE allocating, so a garbage payload — an HTML error page, say —
  // costs nothing. `%PDF-` was present on every document these endpoints returned.
  if (binary.slice(0, 5) !== '%PDF-') {
    throw new Error(
      `${what} payload is not a PDF (starts with ${JSON.stringify(binary.slice(0, 8))})`,
    );
  }

  // `atob` output is Latin-1 by specification, so every code unit is 0-255 and this is exact.
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The order's state, from whichever field this particular response shape carries it in.
 *
 * Search rows use `state`, the single-record read uses `orderState`, and the single-record value
 * has been observed as both a number and a string. Normalized to a number here, or `undefined`
 * when neither field is present or the value is not numeric.
 */
export function orderStateOf(order: Order): number | undefined {
  const raw = order.state ?? order.orderState;
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Every numeric state observed on a quote, across **both** response shapes.
 *
 * The union is necessary because the two endpoints do not agree on the number. Verified live
 * 2026-08-05, same orders read both ways:
 *
 * | search row | single-record read |
 * |---|---|
 * | `1034` "Quote Created" | `"1034"` "QuoteCreated" |
 * | `1034` "Quote Expired" | `"1007"` "QuoteExpired" |
 * | `1002` "Quote Expired" | `"1007"` "QuoteExpired" |
 *
 * So an expired quote is state `1034`/`1002` when listed and `1007` when fetched. Non-quote orders
 * do **not** remap — 1005, 1006, 1016 and 1030 each came back unchanged from both endpoints — and
 * `1007` was never seen on a non-quote order, which is what makes including it safe rather than a
 * source of false positives.
 */
const QUOTE_STATES = new Set([1002, 1007, 1034]);

/**
 * Is this order a quote?
 *
 * Decided on the **numeric state**, deliberately, because every textual route is booby-trapped:
 * {@link Order.orderStatus} is spelled with a space on search rows and without one on the
 * single-record read (`"Quote Created"` vs `"QuoteCreated"`), so a string comparison is a bug
 * waiting for whichever endpoint the caller happened not to test against.
 *
 * Even the numbers disagree between the two shapes, so this matches the **union** of the states a
 * quote has been observed to hold — see {@link QUOTE_STATES}. That union is empirical rather than
 * documented; a deployment with quote states we have never seen would need them added, so treat it
 * as a lower bound rather than a closed vocabulary.
 *
 * Returns `false` when the state is absent rather than guessing, so a partially-populated record
 * never reads as a quote by accident.
 */
export function isQuoteOrder(order: Order): boolean {
  const state = orderStateOf(order);
  return state !== undefined && QUOTE_STATES.has(state);
}

// ---------------------------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------------------------

/**
 * A row from the invoice list endpoint.
 *
 * This is the thin summary shape. The rated detail — charge lines, and the individual usage events
 * behind a metered charge — lives only on the single-invoice read; see
 * `OneBillReadClient.getInvoiceDetail`.
 */
export interface Invoice {
  /** e.g. `INV00000`. The identifier the single-invoice endpoints take. */
  invoiceNumber: string;
  accountNumber?: string;
  /** ISO-8601 with offset, e.g. `2026-02-02T00:00:00-07:00`. */
  invoiceDate?: string;
  dueDate?: string;
  /** Invoice total including tax. */
  amount?: number;
  /** Outstanding balance. `0` once paid. */
  dueAmount?: number;
  /** `Due`, `Paid`, … */
  status?: string;
  currency?: string;
  billNumber?: string;
  invoiceGenerationPreference?: number;
  [k: string]: any;
}

/** One page of an invoice search. */
export interface InvoiceSearchPage {
  /** The rows in this page. Absent rather than empty when nothing matched. */
  invoice?: Invoice[];
  /** The number of rows in THIS page — not the total matching the query. */
  resultSize?: number;
  /**
   * **This endpoint does not report it.** Declared only so code shared with the subscriber and
   * order searches type-checks; verified absent live 2026-07-31 and again 2026-09-02.
   *
   * Pagination that stops when `totalCount` is missing therefore returns page one as the whole
   * result set here. See `listAllInvoices` for the rule that works either way.
   */
  totalCount?: number;
  /** Sum of `dueAmount` across the matched rows. */
  totalDueAmount?: number;
  status?: string;
  [k: string]: any;
}

/** Options accepted by the invoice search endpoint. */
export interface InvoiceSearchOptions {
  /**
   * Restrict to one account. **Optional** — omitting it lists invoices across the whole tenant,
   * which the published spec does not say (it documents `accountNumber` without marking it
   * optional). Verified live 2026-09-02: an unfiltered page returned rows for three distinct
   * accounts.
   */
  accountNumber?: string;
  /** Row offset, not page index. Honoured here — verified live. */
  startCount?: number;
  /** Rows per page, capped at 50 by the server. */
  resultCount?: number;
}

/**
 * The envelope the single-invoice endpoint returns. Which field is populated depends on the
 * `contentType` requested — see `OneBillReadClient.getInvoiceDetail` for the trap in that
 * parameter.
 */
export interface InvoiceDocumentResponse {
  /** `contentType=json`: the structured invoice. */
  invoice?: InvoiceDetail;
  /**
   * `contentType=xml`: the invoice as XML. **An array of chunks that must be joined** — every
   * sample so far has had exactly one element, so code that reads `invoiceXml[0]` looks correct
   * and would silently truncate the day it is not.
   */
  invoiceXml?: string[] | string;
  /** `contentType=pdf` (and the server's default when `contentType` is omitted): base64 PDF. */
  invoicePdf?: string;
  invoiceFileName?: string;
  savedInCloud?: boolean;
  /** `OK`, or `Bad Request` when the in-band validation failed. */
  status?: string;
  /** Present instead of a payload when the request was rejected in-band at HTTP 200. */
  validationResponse?: Rec;
  [k: string]: any;
}

/**
 * The structured invoice returned by `contentType=json`.
 *
 * **Deliberately thin.** The rated detail is buried four levels deep under a field that repeats its
 * own name (`accountInvoiceElements.accountInvoiceElements`), and every level is an array. Reach it
 * with `flattenInvoice` rather than walking this by hand — that walk is the part callers get wrong.
 */
export interface InvoiceDetail {
  invoiceNumber?: string;
  accountNumber?: string;
  /** `MM/dd/yyyy`. Note this is NOT the ISO shape the list endpoint returns. */
  invoiceDate?: string;
  invoiceDuedate?: string;
  /** Start of the billing period this invoice covers, `MM/dd/yyyy`. */
  cycleStart?: string;
  /** End of the billing period, `MM/dd/yyyy`. */
  cycleEnd?: string;
  /**
   * Charges before tax: charge lines + account-level surcharges + `totalDiscount`.
   * `reconcileInvoice` checks a flattened invoice against exactly this.
   */
  totalCurrentCharge?: number;
  /** Negative when a discount applies. Already reflected in `totalCurrentCharge`. */
  totalDiscount?: number;
  totalSurcharge?: number;
  currency?: string;
  currencyCode?: string;
  /** One entry per billed account — a parent invoice carries its children here too. */
  accountInvoiceElements?: Rec[];
  enhancedAccountSummary?: Rec;
  accountSummary?: Rec;
  [k: string]: any;
}

/** A rendered invoice PDF, as returned by `contentType=pdf`. */
export interface InvoicePdf {
  /** Base64-encoded PDF. */
  pdfBase64: string;
  /** OneBill's own filename for the document. */
  fileName?: string;
  /** The raw envelope, for anything this interface does not model. */
  raw?: Rec;
}
