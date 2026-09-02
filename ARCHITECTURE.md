# Architecture

Why this library is shaped the way it is, and the non-obvious traps it exists to work around. The
rules themselves live in [CONTRIBUTING.md](CONTRIBUTING.md); this is the reasoning behind them.

## Layout

```
src/
  http.ts         OneBillHttp — OAuth, request signing, error normalization. NOT exported.
  readClient.ts   OneBillReadClient — GET-only surface over the private transport.
  writeClient.ts  OneBillWriteClient — the only place a mutation can originate.
  model.ts        Loose wire types, plus small pure accessors over them.
  link.ts         The link codec. Pure, no I/O, no client dependency.
  attributes.ts   Custom-field group <-> link mapping. Pure.
  linkIndex.ts    buildLinkIndex — a pure function over an array of subscribers.
  usage.ts        Usage-subscription reconciliation. Pure — fetches nothing, writes nothing.
  invoice.ts      Invoice detail: flatten, reconcile, compare calls, per-tax totals. Pure.
  gather.ts       The one orchestrator: reads what usage.ts needs. The only I/O outside the clients.
  index.ts        The barrel. Explicit named exports only.
  testkit.ts      Recording mock fetch. Build-excluded, never shipped.
```

Nothing depends on anything above it in that list except through `index.ts`. `link.ts` in particular
imports nothing — it is a string codec, and it stays testable without a network or a fixture.

## Logic is pure; exactly one module does the fetching

Every non-trivial decision this library makes lives in a pure function over plain records —
`link.ts`, `attributes.ts`, `linkIndex.ts`, `usage.ts`, `invoice.ts`. The clients do I/O and no thinking. That is
not tidiness for its own sake: it is what lets the hard parts be tested exhaustively against
fixtures with no network, no mock server and no credentials, which is why `pnpm test` is green on a
fresh clone.

`gather.ts` is the deliberate exception, and it is small on purpose. Reconciliation needs data from
two endpoints across every subscriber, and assembling that correctly involves two choices that are
easy to get wrong *silently*, so they are made explicit there rather than left to whoever writes the
glue:

- **Which store is authoritative.** Links can come from the custom-field group (a GET per
  subscriber) or from `externalId` (free, riding the search rows). The default is the group, because
  a reconciliation that reads the derived index cannot notice the index is wrong — and index drift
  is half of what the report exists to find.
- **What one bad account does to a long sweep.** Per-account failures are collected and returned,
  never thrown, so a hundred-and-fifty-request pass survives one broken record. They are returned
  *visibly*, because a report that quietly covers fewer accounts than it claims is worse than one
  that fails outright.

`gather.ts` takes a structural interface rather than the concrete client, so a cache, a fixture or a
rate-limited wrapper substitutes cleanly — and anything satisfying that interface is read-only by
construction, since it exposes no write method to reach.

## The read/write split is structural, not a convention

`OneBillHttp` is held in a `#private` field and never exported from the barrel. `OneBillReadClient`
exposes only GET methods, with no generic `call()` or `request()` escape hatch.

Together those mean that holding a read client is *proof* you cannot write — a guarantee by
construction rather than by discipline. Exporting the transport, merging the two client classes, or
adding one generic method to the read client would each silently convert that back into a
convention, for every consumer at once.

`readClient.test.ts` asserts the surface at the type level with `expectTypeOf`, checked by
`pnpm typecheck` rather than at runtime.

## Pagination: why `totalCount` is a trap

OneBill's list endpoints take `startCount` (a **row offset**, not a page index) and `resultCount`,
capped at 50.

The obvious termination rule — accumulate until you have `totalCount` rows, stop if it is absent —
is unsafe here, because **whether that field exists varies by endpoint and the published spec is
wrong about which**. Verified live on 2026-07-31:

| Endpoint | `resultSize` | `totalCount` |
|---|---|---|
| `SubscriberService/v1/subscribers` | ✓ | ✓ |
| `OrderService/v1/orders` | – | ✓ |
| `SubscriberService/v1/leads` | ✓ | – |
| `InvoiceService/v1/invoices` | ✓ | – |
| `ProductService/v1/products` | ✓ | – |

The spec gets this wrong in both directions: it omits `totalCount` from the subscriber response
schema where it is present, and states that orders are the only endpoint carrying it. Code written
as "stop when `totalCount` is missing" therefore works on subscribers and orders, and silently
returns a single page as the whole result set on leads, invoices, and products. It looks like it
worked, which is the dangerous part.

So `listAllSubscribers` stops on a **short page** — fewer rows than requested means there are no more
— which holds regardless of which counters an endpoint reports. `totalCount` is honoured only as an
additional stop when the server supplies it, to avoid one needless request for an empty page.

It also carries a page cap, and when the cap is reached it **throws**. Returning a quietly clipped
list is the precise failure this method exists to prevent, so it must never be this method's own
behaviour.

(Also observed: `ProductService/v1/products` returned 26 rows for `resultCount=5`, so `resultCount`
is not honoured everywhere either. The short-page rule tolerates that; a rule based on requested page
size alone would not.)

## The invoice document, and the three things called "line item"

`getInvoiceDetail` returns a five-level tree in which one field repeats its own name and three
different things are named some variant of "line item":

```
invoice
  accountInvoiceElements[]          one per billed account (a parent carries its children)
    accountInvoiceElements[]        the same name again, nested inside itself
      invoiceElements[]             one per subscription
        lineItems[]                 A CHARGE LINE — recurring, one-time, or a usage ROLLUP
          usageLineItem[]           one per event name: "Origination Calls", "Termination Calls"
            lstLineItems[]          ONE RATED CALL
          taxLineItem.lineItems[]   a tax component. NOT a charge. Same tag name.
```

Every level is "an array, unless there is one of it, in which case it is the object".

Two traps follow, and both produce a wrong number that looks entirely plausible:

- **A usage charge line's `amount` is the sum of its own calls.** Add charge lines and calls
  together and every metered charge is counted twice.
- **`taxLineItem.lineItems` reuses the charge-line name**, so anything matching on the name rather
  than the position collects tax rows as charges.

`flattenInvoice` walks it by position and returns flat charge lines, surcharges and calls.
`reconcileInvoice` then checks that result against the totals the invoice states about itself, and
that is the point of the module: **a walk that silently drops rows is the failure mode here**, and
an analysis built on a partial extraction reports reassuring nonsense. It returns two checks rather
than one boolean, because they fail for different reasons — `balanced` compares charge lines +
surcharges + discount against `totalCurrentCharge`, while `usageBalanced` compares the individual
calls against their own rollups. An invoice can balance at the invoice level while the per-call
walk has lost rows, and only the second check sees it.

### Read the JSON, not the XML

The single-invoice endpoint serves the same content three ways, selected by `contentType`, and the
parameter is booby-trapped three ways (established live 2026-09-02):

- It is **case-sensitive and lowercase-only**: `xml` works, `XML` is rejected in-band at HTTP 200.
- **Omitting it does not error.** The server defaults to `pdf`, so a caller who forgets the
  parameter gets a base64 document where they expected records.
- Each value populates a different field, and the two document forms are **arrays of chunks**.

So `#getInvoiceDocument` is private and each public reader passes an explicit value.

`json` and `xml` carry identical detail — verified call-for-call and cent-for-cent on invoices up
to a five-figure call count. The library reads `json` because the XML for that invoice is 37 MB of text, and
parsing it dependency-free would mean shipping a hand-rolled XML parser to save nothing. `getInvoiceXml`
exists anyway, because the XML is what OneBill's own invoice template renders from and is therefore
the reference when a rendered invoice and the API disagree.

Both document payloads are typed as arrays and have held exactly one element in every response
observed, up to 37 MB — which is exactly why reading `[0]` is a bug that would never surface in
testing. Both are joined.

## Comparing calls across invoices

`eventId` is assigned when OneBill **ingests** a CDR, not by the switch. A call re-imported after a
broken usage feed therefore arrives with a *new* `eventId` for the same call — so matching on it
alone answers "no duplicates" for the one situation anyone asks the question about. `invoiceCallKey`
is the identity that survives a re-import: timestamp, source, destination, rated quantity.

`findDuplicateCalls` applies both keys and reports them **separately, never merged**. A single
"is it a duplicate" flag could not express disagreement between the keys, and disagreement is the
interesting case: a natural-key hit whose `eventId` missed is a re-ingested event, which is the
double-billing shape, while an `eventId` hit is one stored event appearing twice. `naturalOnly`
counts exactly that difference.

`findRepeatedCalls` asks the separate question of whether one invoice repeats a call against
itself, which a replayed feed can cause with no earlier invoice involved. Genuine repeats exist —
a call rated as two legs — so it returns the rows and whether their `eventId`s differ, rather than
a verdict.

## Tax lives at two depths, and absent is not zero

Tax components hang off `taxLineItem.lineItems` — the third thing in the invoice document named
some variant of "line item". They appear in **two different places**:

- on a **charge line**, for recurring and one-time charges;
- on **each individual call**, for usage — because a usage rollup has no `taxLineItem` node of its
  own and carries the sum of its calls' tax as its `taxAmount`.

Collect from one depth and you miss the other. `flattenInvoice` collects from both into
`FlatInvoice.taxes`, aggregated per (description, groupCode, code) rather than itemised, because an
invoice with ten thousand calls would otherwise produce tens of thousands of near-identical rows to answer
a question that is always "how much of tax X did this invoice carry".

`reconcileInvoice`'s `taxBalanced` checks the collected components against each charge line's own
`taxAmount` and against the invoice's stated tax total. It deliberately does **not** use each line's
`taxLineItem.totalTax`, which is the obvious control and the wrong one: a usage rollup has no
`totalTax`, so a check built on it silently omits every metered charge's tax — and then agrees with
a component walk that made exactly the same omission. A cross-check whose two sides share a blind
spot certifies the wrong answer.

**`InvoiceCall.taxAmount` is `undefined` when a call carries no tax record, never `0`.** The two are
different facts. On a live catch-up invoice, well over a thousand billed calls had no tax element at all while
identically-priced calls in the same months were taxed normally — a tax-engine failure that reads as
"taxed at zero" the moment anyone writes `?? 0`. `InvoiceCall.taxed` reports the node's presence so
the distinction survives even for a caller who only reads the number.

## Exemption is an account fact; jurisdiction is not on it

`Subscriber.taxExemptionCode` is **absent** when an account has none — most accounts on a live tenant —
so presence is the test, not truthiness. Its shape invites a specific bug: a **singular** `code` key
holds the array, and every element also has a `code`, so the value is at
`taxExemptionCode.code[].code` and a read one level short returns an array where a string was
expected without erroring.

The codes are the tax vendor's vocabulary, extended per tenant, and **not always numeric** — `TF`
was observed beside two-digit codes. `taxExemptionCodesOf` returns them and interprets nothing: a
convenience like `isSalesTaxExempt()` would bake one jurisdiction's meanings into a general-purpose
library, which is rule 4 of CONTRIBUTING applied outside the link codec.

**A code entry carries no jurisdiction** — its only keys are `code` and `description` — while which
codes an account needs is entirely jurisdictional. Live: Indiana accounts carried a single sales-tax
code, Michigan accounts carried use-tax codes, a Florida account carried six including excise and
gross-receipts codes with no Midwest equivalent. So the jurisdiction has to come from the account's
addresses, which are a **list** with their own per-address `isSkipTax`. `taxJurisdictionsOf` returns
those states, and an invoice's `taxTotalsByJurisdiction` returns the jurisdictions it was actually
taxed in; the audit question — "is this account exempt where it should be" — is the join of the two.

`isSkipTax` is the field that looks like the answer and is not: `false` on every account and every
address across that tenant, including all 12 genuinely exempt ones.

## Documents: `type` stopped being returned

`GET /subscribers/{acct}/documents` returns hand-uploaded attachments — contracts, exemption
certificates, receipts. No generated artefact is stored there, not even invoices, so it is an
attachment repository rather than a document archive.

Two shapes matter. `documents` is **usually absent rather than an empty array** when an account
holds none — roughly half the accounts on a live tenant — so `res.documents.length` throws on a
common case. An empty array has also been observed, so both shapes are live in one tenant and
`getSubscriberDocuments` normalises both.

And `type` cannot be trusted. The upload form marks Document Type required, yet across a live tenant
every document uploaded from 2025-05-12 onward came back with **no `type` field**, while every one
uploaded through 2024-11-22 carried it — a clean split with zero overlap. It
tracks neither the type chosen nor the visibility flag; a document uploaded as an external
`Contract` came back untyped just as an internal `Supporting Document` did. So
`filter(d => d.type === 'Supporting Document')` drops every recent document, which is exactly where
current exemption certificates are. Match on `name`.

The list response also embeds each file's full base64 content with no metadata-only mode, so a
tenant-wide sweep downloads every attachment.

## The status filter, and the second silent omission

Getting pagination right still returned the wrong answer, because the subscriber search **filters to
active accounts when no `status` is given** and reports nothing about what it withheld. A search
that confidently reports a total omits every closed account, and a meaningful fraction of a customer
base can be invisible that way. `totalCount` is not lying; it is counting the filtered set.

There is no "all" value, so `listAllSubscribers` queries each of `SUBSCRIBER_STATUSES` in turn and
merges, de-duplicating by account number. "All" now means all.

Two things about that vocabulary are worth knowing. The API accepts only `Active`, `Closed`, and
`Inactive` — **coarser than the UI**, whose subscriber screen also offers Delinquent, Pending Closed,
Suspended, and Pending Suspended. Those four are query-rejected, so presentation states are not
query tokens. And an unrecognised status fails with `10PARWS0018 "Find Customer has been failed."`
as an *in-band error at HTTP 200*, which means a typo is loud — but only for a client that checks
for in-band errors. A hand-rolled probe that read `body.subscriber ?? []` saw an empty list and
concluded the status was valid but unpopulated. That mistake is the reason this library treats the
in-band envelope as a first-class failure mode rather than an oddity.

The general lesson, twice over on this endpoint: **a count returned by an API answers the question
the API thinks you asked.** Neither `totalCount` nor an empty result set is evidence of completeness.

## Two failure modes, one error class

OneBill fails in two different ways and both have to be caught:

1. An ordinary non-2xx HTTP response.
2. **HTTP 200 with an error body**: `{status: "Bad Request", validationResponse: {validationErrorInfo: [...]}}`.

Both raise `OneBillApiError`, which carries `status` (200 in the second case), `path`, `method`, and
the parsed `body`. Bodies are truncated to 500 characters in the message so a 5 MB HTML error page
does not end up in a log line.

Only that documented envelope counts as an in-band error. A response with a non-`OK` `status` and no
`validationResponse` is passed through untouched, because `status` is an ordinary data field on some
responses and guessing there would break working calls.

## Auth, and the parts of it that are the vendor's fault

The password grant hashes the password with SHA-256 and sends **every parameter in the query string**
— including the client secret and the hashed password. That is OneBill's documented shape. It is a
real weakness: query strings land in proxy and server access logs. Whether the endpoint also accepts
a form-encoded body is untested; if it does, moving them into the body would be strictly better.

Hashing uses `crypto.subtle.digest`, not `node:crypto`, which is what keeps the library portable —
and is why the hash step is async.

Tokens are cached with a five-minute safety margin behind an injectable `TokenCache`. The default is
an in-memory `Map`, which in a Worker is per-isolate and does not survive a restart; supply a KV- or
Durable-Object-backed implementation to share one. A 401 clears the cache, re-authenticates, and
retries exactly once.

A 200 from the token endpoint carrying no `access_token` is treated as a failure, not a session. Fail
closed.

There are **no retries and no timeouts** beyond that single 401 retry. Both are consumer concerns,
and the seam for both is the injectable `fetchImpl` — wrap it rather than growing this class.

## Writing: why the read-modify-write is mandatory

Everything below was measured against a live tenant on 2026-07-31, on a disposable test account.
None of it is inferable from the documentation.

**A partial PUT is destructive.** Sending `{externalId}` alone to
`PUT /rest/SubscriberService/v1/subscribers/{acct}` returns `200 / status: OK`, sets the field
correctly — and also wipes `quoteTemplateName`, populates `accountOwnerId`, and moves
`nextCycleDate`. Fields you omit are not reliably left alone.

**A full read-modify-write is clean.** Fetching the record, changing one field, and PUTting the
entire thing back changed *nothing* but the intended field. That is the only verified-safe write
shape, which is why `setSubscriberExternalId` always reads first. It is not defensive style; the
cheaper version demonstrably breaks data.

One wrinkle: the response envelope's `status` key is not a settable field and is stripped before the
PUT.

**Clearing takes a second channel.** An empty string, `null`, and a single space are all read as "not
provided" — 200, and the old value survives. Naming the field in a **`fieldsToRemove`** array does
clear it. That array is not in the published spec; it was found in the payload OneBill's own web UI
sends to its private `ui-rest` endpoint, and it turns out to work on the public one too.

Combined with the wipe above, the endpoint is neither clean-merge nor clean-replace: omitted fields
sometimes clear on their own, blank values never do, and explicit removal needs its own list. Hence
the client passes the whole record *and* an explicit removal hint, and then verifies.

An earlier version of this client concluded that clearing was impossible and threw. That conclusion
came from testing an already-empty field, which proved nothing — a reminder that a negative result
needs the same setup rigour as a positive one.

**Verification is not optional.** Two neighbouring integrations in this space acknowledge writes and
silently discard them, and this API silently ignores a blank write, so the client reads back and
compares. A write that cannot be proven did not happen.

**Custom fields survive the round trip.** OneBill supports user-defined fields, including repeating
groups of typed sub-fields, which arrive on the subscriber record as a nested `accountAttribute`
structure. Echoing that structure back verbatim on the PUT preserves it exactly — ids, values, and
group membership all intact — verified live against a record carrying two group instances. So the
full read-modify-write is safe in the presence of custom fields and needs no special-casing.

**Child updates merge; clearing one child needs an explicit marker.** Verified live: PUTting a group
instance with only one of its three children named left the other two untouched. That is what lets
this library name only the fields its mapping manages, so a `Description` someone typed by hand
survives every automated write.

The same behaviour means a field cannot be blanked by omitting it — the old value simply survives.
So when a link drops its qualifier, the qualifier field is sent with `operationType: 2` rather than
left out. Without that the group would keep the old sub-unit while the derived `externalId` said
there was none, and the two would disagree — the exact drift the single-PUT design exists to prevent.
An empty value does not clear it either; only the marker does.

**Blank custom-field groups are stripped before writing.** OneBill materialises a blank instance of
every declared group onto every record, so an untouched account still reads back carrying empty
groups. Echoing those back writes meaningless rows, and the semantics anyone actually wants is that
a group with no data should not exist. A *partially* filled instance is kept, since a blank optional
field beside a populated one is meaningful.

Note this does **not** rescue a group containing a Mandatory field. That validation is
payload-independent: the field must have a value on the account for *any* update to succeed, whether
or not the group appears in the request — verified with the group omitted, with an empty array, and
with the key absent entirely. A Mandatory custom field therefore blocks every write to every account
lacking that value, with no client-side workaround. Don't mark custom fields Mandatory on records
this library writes to.

**Comparison has to be order-insensitive**, and that is not fastidiousness. OneBill returns nested
collections in a non-deterministic order: the same group's sub-fields came back in two different
orders on consecutive reads, with identical ids and values. A `JSON.stringify` comparison calls that
a change, so the collateral check would have reported phantom damage on every write to any account
using custom fields, and `strict` mode would have thrown on all of them. `normalize()` sorts object
keys and treats arrays as unordered before comparing. That is the correct semantics for the question
actually being asked — *did any data change* — because a pure reordering is not damage.

**Over-length writes are rejected wholesale.** A 100-character value returns HTTP 200 carrying
`{status: "Bad Request", validationResponse: {... "10PA1166", "External ID can not be more than 64
character."}}` and leaves the previous value untouched. So there is no silent truncation to defend
against — but it does mean the length rule is enforced in two places, and `formatExternalId` exists
to fail before the round trip rather than after it.

## The link codec

### Why one packed string

OneBill gives a Subscriber exactly one short free-text field. It is the system of record for billing,
a human can see and edit it in the UI, and it survives every rebuild of everything around it. That
makes it a good place for the authoritative link and a bad place for a large or structured one, so
the format optimizes for *fitting* and for *surviving human editing*.

### Never losing a token

The single most important property in the codebase. Anything the parser cannot interpret goes into
`ParsedLinks.unknown` verbatim and is re-emitted on format.

This is not politeness. The field is hand-edited, so a read-modify-write cycle that dropped an
unfamiliar token would destroy someone's note the first time it ran, silently, and the original is
gone. Every codec change needs a test proving an unrecognized token round-trips unchanged.

### Why no namespace is built in

The codec treats every namespace identically and ships none of its own. Which namespace means which
system is configuration, supplied by the consumer as a `NamespaceRegistry`.

A built-in namespace — or a convenience helper named after one particular product — would bake one
integrator's stack into a general-purpose library, which is the same mistake as a default that
encodes one deployment's server. It also costs nothing to avoid: generalizing the qualifier from "a
site" to "a sub-unit of the value" removed code rather than adding it.

### Why values are never parsed

Values belong to other systems. Some of them look like hostnames, which makes it tempting to split
them, strip a suffix to save characters, or infer scope from their shape. Every one of those is
wrong, and confidently so — in at least one system this commonly links to, a dotted suffix records
where a record was *created*, not who holds it now.

An earlier draft of this design compressed a known suffix away to fit more links into 64 characters.
That is exactly the bug, so the continuation marker does that job instead.

### Measuring length

OneBill enforces 64 **code points**, not bytes — verified live: a 40-character, 77-byte value was
accepted, and a 100-character one was rejected. `measureLength` counts code points to match.

An earlier draft took the greater of code points and UTF-8 bytes, on the theory that being stricter
than the server is always safe. It is not: it refuses values the API accepts, and it spends the
scarce part of a 64-character budget to defend against a limit that does not exist.

Astral characters were not part of that test, so whether OneBill counts one or two for them is
unverified. Iterating the string counts one, matching the documented wording.

The 64 default is a vendor product constraint — true for every OneBill tenant — which is why it is
allowed to be a default at all, and why it is still overridable.

## The index is a pure function

`buildLinkIndex` takes an array and returns maps. It fetches nothing, so it needs no mocking, and a
consumer caches the subscriber list rather than the index.

Every lookup returns a **list**, because the relationship is many-to-many in both directions: one
customer can be billed as several accounts split by sub-unit, and one account can carry links to
several targets. Anywhere a single answer was assumed, a site-split customer would silently produce
the wrong one.

Ambiguity is reported, never resolved. Two accounts claiming the same target land in
`index.conflicts` with both account numbers, and both remain reachable through `findByTarget`. The
library does not know which is right, and guessing would hide a data problem the operator needs to
see.

## Typing against a spec that is wrong

OneBill's published OpenAPI document is a Postman export. Several Subscriber operations document no
request body at all, some "paths" are hardcoded sample values rather than templates, and fields
plainly present on the wire are missing from the response schemas — `externalId` on Subscriber among
them, which is the entire premise of this library.

So `model.ts` types only the fields the library reads, marks almost everything optional, and ends
every wire-facing interface with `[k: string]: any`. Drift in unrelated fields never breaks the
build, and callers can still reach anything the API returns.

When the spec and a live response disagree, believe the response, and leave a dated comment saying
so.
