# Changelog

All notable changes to `@dszp/onebill-lib` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] — 2026-09-04

### Added

- **`listProducts()`** and **`getProduct(code)`** on `OneBillReadClient` — the product catalogue.
  `listProducts` pages by the short-page rule and reads the `product` envelope key; `getProduct` takes
  the product CODE (a numeric id answers the in-band `10PR1036` "Invalid product code" at HTTP 200,
  which surfaces as `OneBillApiError`) and returns the record's `pricePlanInfos`.
- **`buildCatalogIndex(products)`** and **`catalogLookup(index, planName)`** in `catalog.ts` — a pure
  index joining a price plan's name (all a subscription line carries) to its plan and product codes.
- **`ruleKeyOf(rule)`** — how a rule is named in a report (`offer:…`, `planCode:…`, `productCode:…`,
  `group:…`), following the same precedence the matcher uses.

### Changed

- **BREAKING — `compareRecurring` accepts per ITEM, not per count.** A count says twelve extensions
  exist against ten billed; it cannot say *which* two are the extra ones, so it cannot tell "the same
  two we already looked at" from "one of those was deleted and a different one appeared". Where the
  caller can supply the list behind a dimension — the new injected `itemsFor(path)`, with
  `itemLabel(item)` to name one — the row carries a `ComparisonItem` per thing, an operator accepts
  individual items, and a swap that leaves the count unchanged reads `drift` instead of staying
  quietly `accepted`.

  - A **stale acceptance verdicts `drift` in every branch**, the matching-count branch included: the
    items changed after the decision, and a swap whose billed count caught up would otherwise read
    `match`.
  - `baselines` takes **`GroupBaseline[]`** (`{ group, items: ItemAcceptance[], groupRow?: GroupAcceptance }`)
    instead of `BaselineEntry[]`. **`BaselineEntry` is removed**, and with it the row's `accepted` and
    `baseline` fields; the whole-group decision is now `ComparisonRow.groupRow`.
  - Rows gain **`items`** (undefined when no dimension of the row has a list), **`unreviewed`**,
    **`stale`**, **`groupRow`** and **`dimensions`**. `dimension` remains, as the first of `dimensions`.
  - Rules gain **`planCode`** and **`productCode`** keys, resolved through a `CatalogIndex` passed as
    `catalog` — a subscription line carries the plan NAME and nothing else, so the codes have to come
    from the catalogue. Precedence when more than one rule matches: `planCode`, then `offer`, then
    `productCode`, so a product rule means "any plan under this product I have not named".
  - Rules gain **`ignore: true`** for a line that is known and deliberately not compared. It leaves
    `unmapped`, lands in the new **`ignored`** list with the rule key that matched, and makes no row.
  - `counts` accepts an **array** of paths: observed is the sum and the item list the union.
  - A rule with **no key at all** is a comparison-only row — a group whose billed comes entirely from
    other rules' `alsoCounts` credits. `alsoCounts` keys may now name a GROUP as well as a path.
  - The result gains **`catalogMisses`**: plan names a code-keyed rulebook could not resolve, either
    because no catalogue was passed or because the catalogue does not know them. A rulebook keyed only
    by name never reports one.

  Verdicts, with `B` = billed, `n` = present items and `G` = the group row: `match` when `n == B`
  (stale acceptances are listed for housekeeping but do not change it). Over-observed, `accepted` when
  every present item is accepted and `G.billed == B`, `drift` when `G` exists and either an unreviewed
  item appeared or `B` moved, `unbaselined` otherwise. On a shortfall — and for a dimension with no
  item list, in either direction — the group row carries the judgement as the count model did:
  `accepted` when `G.accepted == n && G.billed == B`, `drift` when `G` exists and either differs,
  `unbaselined` without one.

### Fixed

- **`package.json` carried two `//files` doc keys**, the second silently overriding the first — and
  the first claimed the globs exclude maps, which they no longer do. The stale one is gone.

## [0.4.0] — 2026-09-03

### Added

- **`compareRecurring(input)`** — compares an account's active recurring offers against a count of what
  the customer actually has, one row per rule group, with an `unmapped` list for anything no rule
  accounts for. Pure.

  The rulebook is **injected**: `RecurringRule[]` names the offers, the dotted inventory path each one
  counts toward, an optional group to sum into, a `perUnit` multiplier for packs, and `alsoCounts` for
  a product that contributes to a second dimension. No offer name ships in this library.

  The inventory is an opaque object — a `counts` path just has to end in a number — so nothing here is
  bound to any particular thing being counted.

  With `baselines`, a known-and-accepted gap reads as `accepted` and stops shouting, and the row turns
  `drift` only once the observed count moves away from what was accepted.

## [0.3.6] — 2026-09-03

### Added

- **`gatherUsageRows` retries a per-account read once after a transport failure.** A sweep of
  ~150 reads lost a row to a single Cloudflare 525 (SSL handshake to the OneBill origin) mid-run.
  A 5xx, or a thrown network error, now gets one more attempt after a short pause
  (`retryDelayMs`, default 500 ms) before the account lands in `failures`. In-band failures and
  4xx are OneBill's answer, not the network's, and are never retried. The new `retried` count
  beside `requestCount` says how often it happened; retries are counted as requests.

### Changed

- **Usage findings say what matched.** `Matched "x" but it is not active: ended
  2021-03-01T08:00:00.000Z.` did not say what had that identifier. Every finding now names the
  offer from `spec.offerNames` (or the matched subscription's own offer name), says whether the
  identifier is the linked target, and prints dates as days:
  `A "Domain Usage" subscription carries the identifier "x" (the linked target), but it is not
  active (ended 2021-03-01).` The `missing` finding now names the linked values and the offer the
  same way. `UsageSubscriptionMatch.inactiveReason` is a day rather than an ISO instant.

## [0.3.5] — 2026-09-02

### Fixed

- **`gatherUsageRows` no longer reports an account with no subscriptions as a failure.** OneBill
  answers `GET …/subscribers/{acct}/subscriptions` for such an account not with an empty list but
  with an in-band failure at HTTP 200: `status: "Bad Request"`, validation code `10WS0001`,
  `No Matching Object Found or Invalid input parameter.` Measured live 2026-09-02 on three Active
  accounts in a 149-request sweep, one of them a freshly created account never sold anything.

  The sweep now maps that specific failure to an empty `subscriptions` array, so the account
  becomes an ordinary `none` / `unlinked` row. Any other failure is still reported.

  The mapping lives in the sweep and **not** in `OneBillReadClient.getSubscriptions`, because a
  nonexistent account number answers with the **identical** body — measured the same day against
  two invented account numbers. Only the sweep can tell the cases apart: its account came from the
  subscriber list moments earlier. A direct caller keeps seeing the error, and the method's doc
  now says so.

## [0.3.4] — 2026-09-02

### Fixed

- **`contact` is no longer echoed back on the subscriber write.** Same shape of problem as
  `payInfo` in 0.3.3, one level deeper and found by a real backfill rather than by reading.

  The API returns `contact[].userDetail.username` and then **validates it as an email address on
  the way back in**. A tenant that has changed its username-format default to require an email
  gets this enforced *retroactively on write*: legacy logins that are still perfectly valid — a
  bare name, or one suffixed when an account was closed — fail the entire write in-band at HTTP 200
  with `Username must be a valid email.`, once per offending contact. Nothing about a subscriber
  write concerns portal logins.

  **Stripping only `userDetail` does not help.** The server validates the stored usernames whenever
  `contact` appears in the payload at all, whatever it contains — the same accounts failed
  identically with the login block removed. The whole key has to go.

  Verified live on a disposable account before shipping: with `contact` omitted the write succeeds
  and every contact comes back intact — names, ids, primary/billing flags, all communication points,
  and the `userDetail` block with its username. Contacts are managed through their own endpoints.

  Note this failure is invisible on a tenant whose logins all happen to be emails, which is why
  0.3.3 shipped without it.

## [0.3.3] — 2026-09-02

### Fixed

- **`payInfo` is no longer echoed back on the subscriber write.** A stored card is read out
  **masked** — `cardNumber: "**** **** **** 0000"` — and the read-modify-write PUT sent that mask
  straight back, whereupon OneBill validated it as a real card number and rejected the entire write
  in-band at HTTP 200:

      10CM1014  Invalid credit card number.
      10CM1066  Invalid Card Type associated for entered credit card.
      10CM1046  Card CVV Number is mandatory.

  Nothing about the write concerns payment, and the account is left untouched — but **every account
  with a payment method on file was unwritable**, which on a normal tenant is most of them. Only
  accounts with no stored card ever succeeded, which is why this survived the first release of the
  write path.

  Omitting the field is safe *here* and that is not the general rule: a partial PUT to this endpoint
  is destructive, so dropping a field is normally how you lose it. Verified live on a disposable
  account before shipping — with `payInfo` omitted the write succeeds and the payment profile comes
  back byte-identical, profile id, reference key, masked number, expiry, address and status intact.
  Checked against both a stored card and an ACH profile. `payInfo` is managed through its own
  endpoints and does not round-trip through this one.

  Anything else added to that strip list needs the same treatment: prove the field survives its own
  omission, on an account you can afford to break.

## [0.3.2] — 2026-09-02

Packaging only; no API change from 0.3.1. 0.3.0 and 0.3.1 are not available on npm — install 0.3.2
or later.

### Fixed

- **Test files are no longer published.** `files` shipped `src` wholesale so the `.d.ts.map`
  references resolve and Go-to-Definition opens real source. Nothing in `dist` references the
  tests, and they roughly doubled the tarball — 70 files to 58, 171 kB to 148 kB. Excluded by
  negation, so they stay beside the code they test.

## [0.3.1] — 2026-09-02

Follow-up to 0.3.0 from consumer feedback. No behaviour change to anything that already worked.

### Added

- **`hasTaxExemptionCode(subscriber, code)`** — the membership test. `taxExemptionCodesOf` returns
  `{ code, description }` **objects**, so `codes.includes('34')` is quietly false and
  `codes.join(',')` is quietly `"[object Object]"`; neither errors, and both were reported from real
  use. The code to look for is the caller's to supply — this compares, it does not interpret.

### Changed

- **`reconcileInvoice` now throws a `TypeError` naming the fix** when handed something that is not a
  `FlatInvoice`. Passing the record from `getInvoiceDetail` straight in — which is what a caller has
  in hand at that point — previously failed as
  `Cannot read properties of undefined (reading 'reduce')` from inside the library.

### Fixed

- **The `SubscriberDocument.type` doc comment explained the wrong cause.** 0.3.0 attributed the
  missing field to internal visibility. That was a hypothesis falsified afterwards by a document
  uploaded as an externally-visible `Contract`, which came back untyped exactly as an internal one
  did. The real boundary is the upload date, and the corrected comment says so. The guidance —
  match on `name` — was right either way, but the reasoning behind it was not.

- **`documents` is *usually* absent rather than empty when an account has none, not always.** An
  empty array has since been observed on the same tenant, so both shapes are live.
  `getSubscriberDocuments` already normalised both; only the documentation overstated it.

## [0.3.0] — 2026-09-02

Tax: what an account is exempt from, what an invoice was actually taxed, and the documents that
justify it. All read-only, all verified live — the published OpenAPI contains **no** tax or
exemption paths at all, so none of this is inferable from the spec.

### Added

- **Tax exemption on the subscriber** — `Subscriber.taxExemptionCode`, `TaxExemptionCode`,
  `TaxExemptionCodes`, `SubscriberAddress`, `taxExemptionCodesOf`, `taxJurisdictionsOf`.

  The field is **absent, not empty**, when an account has no exemption (most accounts on a live tenant), so presence must be tested rather than truthiness. Its shape is a trap: a **singular**
  `code` key holds the array, and every element also has a `code` key — the value is at
  `taxExemptionCode.code[].code`, and reading one level short silently yields an array where a
  string was expected. Codes are strings and **not always numeric** (`TF` observed alongside
  two-digit codes), are extended per tenant, and are deliberately **not interpreted** here — the
  same rule that keeps namespace constants out of the link codec.

  **Which codes an account needs depends on its state**, and the codes carry no jurisdiction of
  their own: the only keys on a code entry are `code` and `description`. Live, Indiana accounts
  carried one sales-tax code, Michigan accounts carried use-tax codes, and a Florida account carried
  six including excise and gross-receipts codes with no Midwest equivalent. `taxJurisdictionsOf`
  returns the states from the account's addresses — which are a **list**, each with its own
  `isSkipTax` — so an exemption can be checked against the state it is meant to apply in.

  `isSkipTax` is **not** the exemption mechanism: it was `false` on every account and every address
  across that tenant while a minority of accounts carried genuine exemption codes.

- **Per-tax detail on invoices** — `InvoiceTaxLine`, `FlatInvoice.taxes`,
  `InvoiceChargeLine.taxLines`, `InvoiceCall.taxAmount`, `InvoiceCall.taxed`,
  `taxTotalsByDescription`, `taxTotalsByJurisdiction`, and `taxLineTotal` / `chargeTaxTotal` /
  `statedTaxTotal` / `taxBalanced` on `reconcileInvoice`.

  Tax components live at **two different depths**: on the charge line for recurring charges, and on
  the individual calls for usage — because a usage rollup has no `taxLineItem` node at all and
  carries the sum of its calls' tax as its own `taxAmount`. Collecting from one depth misses the
  other, which is why "how much STATE USE TAX did this invoice carry" previously required a
  hand-written recursive walk. `FlatInvoice.taxes` is aggregated per
  (description, groupCode, code) rather than itemised, so a large invoice does not produce
  tens of thousands of near-identical rows.

  `InvoiceCall.taxAmount` is `undefined` — never `0` — when a call carries no tax record, and
  `taxed` reports the presence of the node. **Do not collapse these with `?? 0`.** A call taxed at
  zero and a call the tax engine never answered for are different facts, and the second is a real
  defect: on one live catch-up invoice well over a thousand billed calls had no tax element at all while
  identically-priced calls in the same months were taxed normally. Telling "exempt" from "the tax
  engine returned nothing" needs the exemption codes above, which is why both shipped together.

  `taxBalanced` checks the collected components against each charge line's own `taxAmount` and
  against the invoice's stated tax. It deliberately does **not** use `taxLineItem.totalTax`: a usage
  rollup has none, so a control built on it omits every metered charge's tax and then agrees with a
  walk that made the same omission.

- **Subscriber documents** — `getSubscriberDocuments`, `SubscriberDocument`,
  `SubscriberDocumentsResponse`, `subscriberDocumentBytes`.

  Contracts, tax exemption certificates, receipts. An attachment repository, not where OneBill's
  rendered documents live — no generated artefact appears here, not even invoices.

  Two shapes worth knowing. `documents` is **absent, not an empty array**, when an account has none
  (roughly half the accounts on a live tenant). And **`type` cannot be relied on**: it is required by the upload form, yet
  every document uploaded to a live tenant from 2025-05-12 onward came back with no `type` at all,
  while every one uploaded through 2024-11-22 carried it — a clean split with zero overlap,
  independent of the type chosen and of visibility. Filtering on `type` therefore silently drops
  every recent document; match on `name`. Note also that the list response embeds each file's full
  base64 content with no metadata-only mode, so listing downloads everything.

### Changed

- `searchSubscribers` now **throws a `TypeError` when `status` is given an array**, naming
  `listAllSubscribers({ statuses })` as the fix. The two option names differ only by the plural, and
  an array was previously stringified into `Active,Closed,Inactive` — one unrecognised status,
  rejected in-band at HTTP 200 as `10PARWS0018 "Find Customer has been failed."`, which is slow to
  diagnose from the wire.

- `quotePdfBytes` and the new `invoicePdfBytes` / `subscriberDocumentBytes` now share one base64
  decoder. The validation is the entire value of these functions, and two copies of it eventually
  become two different amounts of validation.

## [0.2.0] — 2026-09-02

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
