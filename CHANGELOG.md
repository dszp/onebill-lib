# Changelog

All notable changes to `@dszp/onebill-lib` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Invoice reads** — `searchInvoices`, `listAllInvoices`, `getInvoiceDetail`, `getInvoiceXml`,
  `getInvoicePdf`, `invoicePdfBytes`, and `OneBillInvoiceNotFoundError`.

  `accountNumber` is optional on the list, which the published spec does not say: omit it and the
  endpoint covers the whole tenant. The list reports `resultSize` and **never** `totalCount`, so
  the common `!totalCount → stop` rule returns page one as the whole history — an account with 62
  invoices answers with 50 and looks complete. `listAllInvoices` uses the short-page rule instead.

  The single-invoice endpoint serves the same content three ways via `contentType`, and that
  parameter is booby-trapped three ways: it is lowercase-only (`XML` is rejected in-band at HTTP
  200), **omitting it silently returns a PDF** rather than erroring, and each value populates a
  different field of the same envelope. The transport-level call is therefore private, and every
  public reader passes an explicit value. Both document payloads are typed as arrays of chunks and
  are joined — each has held exactly one element in every response observed, up to 37 MB, which is
  precisely why reading `[0]` is a bug that never shows up in testing.

- **Invoice detail as records** — `flattenInvoice`, `reconcileInvoice`, `invoiceCallKey`,
  `findDuplicateCalls`, `findRepeatedCalls`.

  An invoice is a five-level tree in which one field repeats its own name, every level may be an
  array or a bare object, and three different things are named some variant of "line item". Two
  traps follow, and both yield a plausible wrong number: a usage charge line's `amount` **is** the
  sum of its own calls, so adding charge lines to calls double-counts every metered charge; and
  `taxLineItem.lineItems` reuses the charge-line name, so a name-based match collects tax rows as
  charges. `flattenInvoice` walks by position; `reconcileInvoice` checks the result against the
  invoice's own totals and reports **two** checks rather than one, because an invoice can balance
  at the invoice level while the per-call walk has quietly lost rows.

  `findDuplicateCalls` matches on `eventId` and on `invoiceCallKey` and reports them separately,
  never merged. `eventId` is assigned at ingest rather than by the switch, so a CDR replayed after
  a broken usage feed arrives with a new id for the same call — matching on it alone answers "no
  duplicates" for the one case anyone asks about. The merged verdict could not express that
  disagreement, which is why `naturalOnly` is its own field.

  Verified against the XML representation call-for-call and cent-for-cent on live invoices up to
  a five-figure call count.

## [0.1.0] — 2026-08-07

First release: split read/write OneBill clients, a link codec for the Subscriber `externalId` field,
order and quote reads including the rendered quote PDF, and usage-subscription reconciliation.

### Added

- **Usage-subscription reconciliation** — `gatherUsageRows`, `findUsageSubscriptions`,
  `reconcileUsageSubscriptions`, `proposeMappings`, `bySeverity`, `USAGE_VERDICT_SEVERITY`.

  Some billing products override the subscription identifier to carry a routable value rather than
  an opaque composite label; a usage product whose identifier is the exact PBX domain is how metered
  usage reaches the right invoice. Nothing enforces it, so a misspelling or a lapsed subscription
  stops usage silently. Each account gets one of eight verdicts and the result **reports without
  resolving** — where two systems disagree, picking a winner silently makes the wrong choice
  permanent.

  Three decisions carry the value. `extra` is a verdict of its own so an account legitimately
  billing several targets is not reported as broken, because a report that cries wolf is one nobody
  opens. `examined` is returned alongside the matches so a renamed product reads as a stale config
  rather than a tenant-wide catastrophe. And `proposeMappings` cross-checks against a caller-supplied
  authoritative list and adopts **its** spelling — a subscription identifier is free text somebody
  typed, and seeding from it unchecked launders a typo into whatever you treat as truth, where it
  then agrees with itself forever.

  Only `gatherUsageRows` does I/O; the rest are pure functions over records. It defaults to reading
  links from the custom-field group rather than `externalId`, because a report that reads the derived
  index cannot notice the index is wrong. Per-account failures are collected and returned rather than
  thrown, so one bad account cannot destroy a long sweep — and returned *visibly*, because a report
  quietly covering fewer accounts than it claims is worse than one that fails.

- **Orders and quotes** — `searchOrders`, `listAllOrders`, `getOrder`, and `getQuoteDocument` on the
  read client, plus `ORDER_STATE_FILTERS`, `ALL_ORDER_STATE_FILTERS`, and the pure helpers
  `orderStateOf` and `quotePdfBytes`. A quote in OneBill is an order in a quote state, so one set of
  methods covers both.

  **The order search hides quotes and reports nothing about it** — the same silent-filter trap as the
  subscriber search excluding closed accounts. Verified live: an unfiltered walk returns orders in
  the four non-quote states only, and quotes are reachable solely by asking for them by state. The
  per-state counts of those four sum to exactly the unfiltered total, which is what proves the
  exclusion is total rather than partial. `listAllOrders()` keeps the server's default and offers
  `ALL_ORDER_STATE_FILTERS` to opt out.

  Filtering is narrower than it appears: only `searchBy: 'state'` with a numeric `searchString` has
  any effect. `orderType`, `orderStatus`, `status`, `orderState`, `orderCategory`, `includeQuote`,
  `includeQuotes`, `isQuote`, `quote` and `showQuote` are each accepted and then silently ignored,
  every one returning the unfiltered set.

  `getQuoteDocument(orderNumber, { version })` retrieves **superseded revisions**, not just the
  current one: a revised quote keeps its order number and gains a document version (`OR00000-3`), and
  omitting `version` returns the newest. Every prior revision of a multiply-revised quote was
  retrieved live as a distinct PDF, which is what makes an audit trail of what a customer was
  actually shown possible. `version` is the only parameter that works — `quoteVersion`, `docVersion`, `revision`
  and `quoteDocName` are accepted and silently ignored, so a caller guessing the name gets the
  current document back with no error.

  **Most orders have no quote document**, since an order can be raised without a quote — verified
  live by sampling every non-quote state, where most orders had none. OneBill reports
  the absence as `USER_AUTHENTICATION_FAILED … Invalid access token response` at HTTP 200 — with a
  valid token whose next request succeeds. The message is a lie and the `errorCode` (`11ORDWS0049`)
  is the truth; believing the message means re-minting a token on the majority of orders. This is
  decoded into `OneBillNoQuoteDocumentError`, with `tryGetQuoteDocument` returning `null` for
  sweeps.

  `getQuoteDocument` returns the **fully rendered PDF** — the same document OneBill's UI produces,
  estimated taxes included. It is **undocumented**: the endpoint appears nowhere in OneBill's
  published OpenAPI, which declares `application/json` for all 152 of its responses and never
  mentions PDFs at all. The PDF arrives base64-encoded inside the JSON body rather than as a binary
  response, so `quotePdfBytes` decodes it with `atob` and never touches `Buffer`, keeping the package
  Node-free. It checks the `%PDF-` magic number and throws rather than returning a corrupt file,
  because this API answers HTTP 200 on failure. A non-quote order can return a document too — not
  because the endpoint renders a quote template over anything, but because that order came from a
  quote and kept it. A 200 means a quote once existed, not that one exists now.

  `orderStateOf` and `isQuoteOrder` exist because the two endpoints describe the **same order**
  incompatibly, in four ways at once. The state field is named `state` on search rows and
  `orderState` on the single-record read; its type changes from number to string; the status string
  loses its space (`"Quote Expired"` → `"QuoteExpired"`, and likewise `"Pending Billing"` →
  `"PendingBilling"`, so this is not quote-specific); and for an **expired quote the numeric value
  itself changes**, from `1034` when listed to `1007` when fetched. Non-quote orders do not remap,
  and `1007` was never observed on one — which is what makes matching the union of quote states safe
  rather than a source of false positives.

  The practical consequence: `orderStatus === 'Quote Expired'` works while iterating a list and
  silently stops working after a `getOrder()`. `isQuoteOrder` is the supported way to ask.

- **`OneBillReadClient`** — `getSubscriber`, `searchSubscribers`, `listAllSubscribers`, and
  `getSubscriptions`. GET-only by charter: the class has no mutating method and no generic `call()`,
  and the transport it wraps (`OneBillHttp`) is private and unexported, so holding one is a
  structural guarantee that you cannot write. The boundary is asserted at the type level and checked
  by `pnpm typecheck`.

  `listAllSubscribers` defaults to **active accounts only**, matching the endpoint, as a safety
  default: a bulk job that iterates and writes must not reach a closed account by accident. Pass
  `{statuses: SUBSCRIBER_STATUSES}` for completeness, which read-only work generally wants. The
  endpoint filters silently and reports nothing about the omission — verified live, a search
  reporting a confident total omitted every closed subscriber, a meaningful fraction of the customer
  base, invisibly. There is no "all" value, so covering everything means querying each
  status and merging, de-duplicating by account number. The accepted vocabulary is `Active`, `Closed`, `Inactive` — coarser than the UI's, which
  also shows Delinquent, Pending Closed, Suspended, and Pending Suspended; those four are
  query-rejected with `10PARWS0018` as an in-band error at HTTP 200.

  `listAllSubscribers` terminates on a **short page** rather than on `totalCount`. This is the
  behaviour worth knowing about: whether OneBill returns `totalCount` varies by endpoint — verified
  live, subscribers and orders do, while leads, invoices, and products return only `resultSize` —
  and the published spec is wrong about which. The intuitive "stop when `totalCount` is absent or
  satisfied" rule therefore returns a single page as the entire result set on some endpoints and not
  others, with no visible difference. When the page cap is reached the method throws rather than
  returning a clipped list.

- **The link codec** (`parseExternalId`, `formatExternalId`, `canonicalize`, `fits`, `validate`,
  `linksFor`, `upsertLink`, `removeLink`, `measureLength`) — packs several foreign-system links into
  OneBill's single 64-character `externalId` field, in the form
  `CRM:4471|PBX:acme.12345.service/Downtown|+2`.

  Two properties are load-bearing. **Parsing never discards input:** anything the codec cannot
  interpret is preserved verbatim in `ParsedLinks.unknown` and written back out, because the field is
  hand-edited in OneBill's UI and a lossy round trip would destroy real data on the next automated
  write. And **no namespace is built in:** `CRM`/`PBX` in the docs are placeholders, and which
  namespace means which system is consumer-supplied configuration via `NamespaceRegistry`. A built-in
  namespace would bind a general-purpose library to one integrator's stack.

  `formatExternalId` throws `OneBillLinkTooLongError` rather than truncating, naming the links that
  did not fit so the caller can move them to an overflow store and record a `+N` continuation marker.
  Length is measured in **code points**, not bytes: verified live, OneBill accepted a 40-character
  77-byte value and rejected a 100-character one wholesale with `10PA1166`, leaving the previous
  value intact. Counting bytes as well would be safe but wrong — it refuses values the API accepts,
  spending the scarce part of a 64-character budget on a limit that does not exist.

- **`buildLinkIndex`** and the lookups `findByTarget`, `findByValue`, `findByAccount` — a two-way
  index between subscribers and the records they link to, keyed by a namespace you name. A pure
  function over an array: it fetches nothing, so consumers cache the subscriber list rather than the
  index.

  Every lookup returns a list, because the relationship is many-to-many in both directions — one
  customer may be billed as several accounts split by sub-unit, and one account may link to several
  targets. Contested targets are reported in `conflicts` with every claimant, never resolved by
  picking one.

- **`OneBillWriteClient`** — one method, `setSubscriberExternalId`, in a class separate from the
  read client so that holding a read client stays proof you cannot write.

  Its shape is dictated by measured behaviour rather than caution. A **partial** PUT of
  `{externalId}` alone returns 200, sets the field, and also wipes `quoteTemplateName` and populates
  `accountOwnerId`; a **full read-modify-write** changes nothing but the intended field. So the
  client always reads the whole record, alters one field, and PUTs it back.

  It then reads back and verifies, throwing `OneBillWriteVerificationError` if the stored value is
  not the requested one — neighbouring integrations in this space acknowledge writes and discard
  them, so an unverified write is not a write. `{strict: true}` also fails when unrelated fields
  moved; `{dryRun: true}` reports what would happen without sending anything.

  Wholly blank custom-field group instances are **stripped before the write**. OneBill materialises
  an empty instance of every declared group onto every record, and echoing those back writes
  meaningless rows; a partially filled instance is kept, since a blank optional field beside a
  populated one carries meaning.

  The collateral check compares **order-insensitively**. OneBill returns nested collections in a
  non-deterministic order — a custom-field group's sub-fields came back in two different orders on
  consecutive reads, with identical ids and values — so a naive comparison would report phantom
  damage on every write to any account using custom fields, and `strict` mode would throw on all of
  them. Custom fields themselves survive the full read-modify-write unchanged, verified against a
  record carrying two repeating group instances.

  Writes to a non-`Active` account are **refused** with `OneBillInactiveAccountError` unless
  `{allowNonActive: true}` is passed. The status is already in hand from the read the method performs
  anyway, so the guard is free — and it sits where the risk actually is, rather than being simulated
  by narrowing what the read returns.

  Passing an empty string clears the field. That needs its own channel: OneBill reads a blank value,
  `null`, or a space as "not provided" and keeps the old value, so the request names the field in a
  `fieldsToRemove` array — undocumented, but what OneBill's own web UI sends, and it works on the
  public endpoint too.

- **`setSubscriberLinks`** plus the pure `attributesToLinks` / `linksToAttributes` — links stored as
  OneBill **custom-field groups**, with `externalId` derived from them and written in the same PUT so
  the two cannot drift. The groups are structured, human-editable, and unbounded; `externalId` stays
  as the cheap bulk-readable index, since it rides the search rows and attributes do not.

  Which group maps to which namespace is consumer configuration (`LinkMapping`), for the same reason
  the codec ships no namespace constants.

  Behaviour follows what the API does, not what seemed reasonable: `aggregator` is caller-assigned on
  create (omit it and a second instance collides with `10CV00014`); child updates merge, so only the
  mapped fields are named and a hand-set field survives; and deletion needs `operationType: 2` — a
  **number**, on the group row and every child, with values in `attributeValuesInfo.associateValues`.
  A string there returns a 500.

  Removal is off by default because it destroys data a human may have entered; unrequested links are
  reported in `notRemoved` so "added and updated" is never mistaken for "matches my input".

- **`OneBillApiError`**, covering both of OneBill's failure modes: ordinary non-2xx responses, and
  application-level failures returned with HTTP 200 and a `validationResponse` envelope. Carries
  `status`, `path`, `method`, and the parsed body, with the body truncated in the message.

- **Injectable `TokenCache`** — the default is an in-memory `Map`, which in a Cloudflare Worker is
  per-isolate and does not survive a restart. Supply a KV- or Durable-Object-backed implementation to
  share one token across isolates.

### Security and correctness notes from the pre-publish review

- `setSubscriberLinks` **carries forward links whose namespace the mapping does not cover**. Deriving
  `externalId` from the mapped groups alone erased them — silently, and for tokens that *parse*,
  which is a worse breach of the never-lose-a-token invariant than for ones that don't. Two
  integrations each running with only their own mapping would have deleted each other's links on
  every run. Preserved links are reported in `carriedOver`.
- Two requested links sharing a namespace and value but **differing in qualifier no longer collapse**
  into one group instance. The codec treats the full triple as identity, and a domain split across
  separately-billed sites is exactly that shape. Matching is now exact-first, then value-only for the
  qualifier-changed case, with each instance claimable once.
- **Removals are verified**, not just additions. Deletion rides an undocumented mechanism; if the
  endpoint stopped honouring it, `externalId` would silently disagree with the groups.
- Account numbers of `""`, `"."`, and `".."` are **rejected**. `encodeURIComponent` leaves dot
  segments intact and `new URL()` resolves them, so those three escaped the intended path — `".."`
  to a different endpoint, the others to the collection, whose page envelope then typed as a record.
- The **token cache key covers the whole credential set**, with the secret and scope hashed. Keyed on
  tenant and username alone, two clients differing only in scope — or one with a rotated secret —
  served each other's tokens through the shared KV cache the docs recommend.
- `assertBaseUrl` **rejects a query string or fragment**, which would otherwise swallow the path of
  every request built from the base, including the credential-bearing token call.
- A second `+N` continuation marker is **preserved as an unknown token** rather than dropped.
- Dropping a link's qualifier now **explicitly clears** the field with `operationType: 2`. Child
  updates merge (verified live), so omitting the field left the old sub-unit in place while the
  derived `externalId` said there was none — group and index disagreeing, which is precisely what
  writing both in one request is meant to prevent.

### Notes

- Node-free by construction: Web APIs only, no runtime dependencies, and `tsconfig.json` sets
  `"types": []` with no `@types/node` so a stray `node:*` import fails the build. The password is
  hashed with `crypto.subtle.digest`, which is why that step is async.
- Types are deliberately loose. OneBill's published OpenAPI document is a Postman export that omits
  request bodies for several Subscriber operations and omits `externalId` from every Subscriber
  response schema despite it being present on the wire. Treat the spec as a lower bound.
