# @dszp/onebill-lib

Portable, **Node-free** toolkit for the [OneBill](https://www.onebillsoftware.com/) billing and
subscription API: a read-only client, and a generic codec that lets one Subscriber's `externalId`
field carry links to several other systems at once.

Web APIs only, zero runtime dependencies, injectable `fetch` — the same built output runs unchanged
in a Cloudflare Worker, in Node, and in a browser.

## Install

```
npm install @dszp/onebill-lib      # or pnpm add / yarn add
```

Requires Node 20+ when run under Node. ESM only.

## Reading

```ts
import { OneBillReadClient } from '@dszp/onebill-lib';

const client = new OneBillReadClient({
  tenantId: 'tenant-0000',        // Config > Settings > Business Profile
  clientSecret: 'secret-0000',
  username: 'api@example.com',
  password: '...',               // hashed with SHA-256 before it leaves the process
  // baseUrl defaults to OneBill's public endpoint
});

const sub = await client.getSubscriber('CLI00000');
const page = await client.searchSubscribers({ searchBy: 'accountName', searchString: 'Acme' });
const all = await client.listAllSubscribers();
const subs = await client.getSubscriptions('CLI00000');
```

`listAllSubscribers()` returns **active accounts only** by default — a safety default, so a bulk job
that iterates and writes cannot reach a closed account by accident. Be aware that this means the
default is *not* every subscriber: the endpoint filters silently, and a search reporting a confident
total omits every closed account. For read-only work needing completeness, especially reconciliation, pass
`{ statuses: SUBSCRIBER_STATUSES }`; there is no "all" value in the API, so that walks each status
and merges, de-duplicating by account number.

It also **throws rather than truncating** if it hits
its page cap. It terminates on a **short page** rather than on `totalCount`, which matters more than
it sounds: whether OneBill returns `totalCount` varies by endpoint (subscribers and orders do; leads,
invoices, and products return only `resultSize`, the size of the page you just got), and the
published spec is wrong about which. The intuitive "stop when `totalCount` is missing or satisfied"
rule silently returns one page as the entire result set on half of them.

Holding an `OneBillReadClient` is proof you cannot write — it has only GET methods, and the transport
underneath it is private and unexported.

## Orders and quotes

A **quote in OneBill is an order in a quote state**, not a separate object — so one set of methods
reads both.

```ts
import {
  ALL_ORDER_STATE_FILTERS,
  ORDER_STATE_FILTERS,
  OneBillReadClient,
  quotePdfBytes,
} from '@dszp/onebill-lib';

const orders = await client.listAllOrders();                              // NO quotes — see below
const quotes = await client.listAllOrders({ states: [ORDER_STATE_FILTERS.QUOTE] });
const every  = await client.listAllOrders({ states: ALL_ORDER_STATE_FILTERS });

const quote = await client.getOrder('OR00000');   // line items, charges, tax, discounts
```

**The order search hides quotes, and tells you nothing about it.** With no state filter the endpoint
returns every order *except* quotes, and reports a `totalCount` for the narrowed set — so the
response looks complete when it is not. This is the same trap as `listAllSubscribers` defaulting to
active accounts. `listAllOrders()` keeps the server's behaviour by default and gives you
`ALL_ORDER_STATE_FILTERS` to opt out of it.

Filtering is also narrower than it looks: only `searchBy: 'state'` with a numeric `searchString` has
any effect. `orderType`, `orderStatus`, `status`, `orderState`, `isQuote` and friends are all
accepted and then silently ignored, returning the unfiltered set.

### Downloading the rendered PDF

```ts
const doc   = await client.getQuoteDocument('OR00000');  // { pdfBase64, docName }
const bytes = quotePdfBytes(doc);                        // Uint8Array

await writeFile(`${doc.docName}.pdf`, bytes);            // Node
return new Response(bytes, { headers: { 'content-type': 'application/pdf' } });  // Worker
```

This is the fully rendered quote — the same PDF OneBill's UI produces, taxes and all — which makes it
the practical input to an e-signature flow. It is genuinely the *quote* document, titled as one and
carrying an acceptance/signature section, not a generic order printout. The PDF arrives base64-encoded *inside* the JSON body
rather than as a binary response, so `quotePdfBytes` decodes via `atob` and never touches `Buffer`.
It verifies the `%PDF-` magic number and throws rather than handing back a corrupt file, because this
API answers HTTP 200 even when something has gone wrong.

A billing-active or pending order can return a PDF too — not because the endpoint renders a quote
template over any order, but because that order **came from** a quote and kept its document. So a 200
is not evidence that something is *currently* a quote; use `isQuoteOrder(order)` for that. It is
evidence that a quote once existed, which is its own useful signal.

### Never test an order's status as a string

The two endpoints describe the *same order* differently, in both the text and the number:

| | search row | single-record read |
|---|---|---|
| Quote Created | `state: 1034`, `"Quote Created"` | `orderState: "1034"`, `"QuoteCreated"` |
| Quote Expired | `state: 1034`, `"Quote Expired"` | `orderState: **"1007"**`, `"QuoteExpired"` |

The status string loses its space, the state field changes name, its type changes from number to
string, and for an expired quote the *value* changes too. Code matching `orderStatus === 'Quote
Expired'` works while iterating a list and silently stops working after a `getOrder()`.

Use the helpers — `isQuoteOrder(order)` matches the union of states a quote holds in either shape,
and `orderStateOf(order)` reads whichever field is present and normalizes it to a number. The
de-spacing is not quote-specific: `Pending Billing` becomes `PendingBilling` too.

### Superseded versions, and orders that never had a quote

A revised quote keeps its order number and gains a document version, so `docName` reads `OR00000-3`
for the third revision. Omitting `version` returns the **current** one; pass `version` to retrieve a
superseded revision — which is how you keep an audit trail of what a customer was actually shown.

```ts
const current = await client.getQuoteDocument('OR00000');           // newest
const asShown = await client.getQuoteDocument('OR00000', { version: 1 });
```

`version` is the only parameter that works. `quoteVersion`, `docVersion`, `revision` and
`quoteDocName` are each accepted and silently ignored, returning the current version — so a caller
guessing the parameter name gets the wrong document with no error.

**Most orders have no quote document at all**, because an order can be raised without a quote ever
existing — verified across every non-quote state, and a few of the oldest quotes have none either.
Use `tryGetQuoteDocument`, which returns `null` instead of throwing, when sweeping:

```ts
const doc = await client.tryGetQuoteDocument(order.orderNumber);
if (doc) { /* ... */ }
```

> **OneBill reports "no such document" as an authentication failure, and it is not one.** The
> response is HTTP 200 carrying `USER_AUTHENTICATION_FAILED … Invalid access token response`, with a
> perfectly good token whose very next request succeeds. Taking it at face value leads straight to
> re-minting a token on every order that lacks a document — most of them. This library decodes it
> from `errorCode` instead and raises `OneBillNoQuoteDocumentError`.

> This endpoint is **undocumented**. It appears nowhere in OneBill's published OpenAPI, which
> declares `application/json` for all 152 of its responses and never mentions PDFs. Treat that spec
> as a lower bound on what exists.

## Linking

OneBill gives each Subscriber one short free-text `externalId`. That single field is often the only
place to record that a customer is also record X in one system and record Y in another, so this
library packs several links into it:

```
CRM:4471|PBX:acme.12345.service|PBX:acme.12345.service/Downtown|+2
```

- `NS:value` — a link. The namespace is 1–8 uppercase alphanumerics; the value is opaque.
- `NS:value/qualifier` — a link to a *sub-unit* of that value, for when one customer is billed as
  several accounts split by site, region, or cost centre.
- `+N` — a continuation marker: N further links exist in whatever overflow store you keep.
- Order does not matter, and duplicates are collapsed.

**No namespace is built in.** `CRM` and `PBX` above are placeholders — pick your own, and describe
them in a `NamespaceRegistry` if you want them validated.

```ts
import { parseExternalId, upsertLink, formatExternalId } from '@dszp/onebill-lib';

const links = parseExternalId(sub.externalId);
const next = upsertLink(links, { ns: 'PBX', value: 'acme.12345.service', qualifier: 'Downtown' });
const value = formatExternalId(next);   // throws OneBillLinkTooLongError if it won't fit
```

### Parsing never discards anything

A token the codec cannot interpret is preserved verbatim in `ParsedLinks.unknown` and written back
out unchanged. The field is hand-edited in OneBill's UI, so a round trip that dropped an
unrecognized value would destroy real data on the next automated write.

### The length limit

OneBill's UI caps `externalId` at 64 characters. `formatExternalId` refuses to exceed it and throws
`OneBillLinkTooLongError`, which names exactly which links did not fit so you can move them to an
overflow store and record a `+N` marker. Length is measured in **code points**: verified live, a
40-character 77-byte value is accepted and a 100-character one is rejected outright with
`10PA1166`, leaving the previous value intact — so there is no truncation to defend against.

## Writing

```ts
import { OneBillWriteClient } from '@dszp/onebill-lib';

const writer = new OneBillWriteClient({ /* same config */ });
const result = await writer.setSubscriberExternalId('CLI00000', 'CRM:4471|PBX:acme.12345.service');

result.stored;      // read back from the API, not assumed
result.collateral;  // unrelated fields that moved — expected to be empty, worth checking
```

Writes are a separate class from reads, so holding an `OneBillReadClient` stays proof you cannot
write. Three behaviours here are not caution but necessity, all verified against a live tenant:

- **It always reads first and PUTs the whole record back.** A partial PUT of `{externalId}` alone
  returns 200, sets the field, *and* wipes unrelated fields. A full read-modify-write changes only
  what you asked for.
- **It reads back and verifies.** A write that cannot be proven did not happen. Pass `{strict: true}`
  to also fail when unrelated fields moved.
- **Clearing needs a special request.** OneBill reads an empty value, `null`, or a space as "not
  provided" and keeps the old value. Passing `''` therefore sends the field in a `fieldsToRemove`
  array — the same channel OneBill's own web UI uses — and then verifies the field really is empty.

`{dryRun: true}` reads and reports what would be written without sending anything.

### Links as first-class records

OneBill can hold links in **custom-field groups** — a repeating group per system, with a field for
its identifier and optionally one for a sub-unit. That is the same information `externalId` carries,
but structured, editable by a human, and free of the 64-character ceiling. So the groups hold the
truth and `externalId` becomes a derived index of them: cheap to read in bulk (it rides the search
rows, which attributes do not) and server-side prefix-searchable.

`setSubscriberLinks` writes both halves in **one request**, so they cannot drift:

```ts
const MAPPING = [
  { group: 'PBX', ns: 'NS', valueField: 'Domain', qualifierField: 'Site' },
  { group: 'PSA', ns: 'AT', valueField: 'PSA ID' },
];

const res = await writer.setSubscriberLinks('CLI00000', [
  { ns: 'NS', value: 'acme.12345.service', qualifier: 'Downtown' },
  { ns: 'AT', value: '4471' },
], MAPPING);

res.created; res.updated; res.unchanged;
res.notRemoved;  // links already there that you did NOT request — left alone
res.externalId;  // derived from the result and written in the same PUT
```

Which group means which namespace is **your configuration**, like the namespace registry — the
library ships no mapping.

By default this adds and updates but **never removes**, so the record can hold more than you passed;
`notRemoved` tells you. Pass `{ removeUnlisted: true }` to make the record *match* your input.
`{ dryRun: true }` reports the whole plan, including the `externalId` it would derive, without
sending anything.

## Indexing

```ts
import { buildLinkIndex, findByValue, findByTarget } from '@dszp/onebill-lib';

const index = buildLinkIndex(await client.listAllSubscribers(), { ns: 'PBX' });

findByValue(index, 'acme.12345.service');              // every account billing for it, any sub-unit
findByTarget(index, 'acme.12345.service', 'Downtown'); // just that sub-unit
index.unlinked;    // accounts with no link yet — the work list
index.conflicts;   // targets claimed by more than one account, reported not resolved
index.problems;    // accounts whose externalId did not fully parse
```

`buildLinkIndex` is a pure function over an array — it fetches nothing, so cache its input rather
than the index. Every lookup returns a list, because the relationship is genuinely many-to-many in
both directions.

## Reconciling usage subscriptions

Some billing products override the subscription identifier to carry a **routable value** instead of
the usual opaque composite label — a usage product whose identifier is the exact PBX domain is how
metered usage finds the right invoice. Nothing enforces it. Misspell it, or let the subscription
lapse, and usage silently stops flowing until a bill comes out wrong.

```ts
import {
  gatherUsageRows, reconcileUsageSubscriptions, proposeMappings, bySeverity,
  SUBSCRIBER_STATUSES,
} from '@dszp/onebill-lib';

const { rows, failures } = await gatherUsageRows(client, {
  ns: 'PBX',
  mapping: [{ group: 'PBX', ns: 'PBX', valueField: 'Domain', qualifierField: 'Site' }],
  statuses: SUBSCRIBER_STATUSES,          // closed accounts still hold links
});

const report = reconcileUsageSubscriptions(rows, {
  spec: { offerNames: ['Domain Usage'] }, // YOUR product name — nothing is built in
}).sort(bySeverity);

const proposal = proposeMappings(report, {
  ns: 'PBX',
  knownTargets: await realDomainList(),   // the typo guard — see below
});
```

Each account gets one of eight verdicts: `ok`, `mismatch`, `missing`, `ambiguous`, `inactive`,
`unlinked`, `extra`, `none`. It **reports and never resolves** — where the two systems disagree it
says so and stops, because picking a winner silently makes the wrong choice permanent.

Four things worth knowing before you build on it:

- **`extra` is a verdict, not an error.** An account legitimately billing several targets with one
  usage subscription is expected. Calling that a mismatch trains people to ignore the whole report.
- **`examined` detects a renamed product.** If the offer is renamed, every account reports its
  subscription missing and the report reads as a catastrophe rather than a stale config. Seeing
  `matched: 0` against a healthy `examined` on *every* account is the tell.
- **`knownTargets` is the typo guard, and you want it.** A subscription identifier is free text
  somebody typed during billing setup. Seeding from it unchecked launders a typo into whatever you
  treat as truth, where it then agrees with itself forever and the report goes quiet. Candidates
  that match nothing come back as `confidence: 'unknown'` — surface them, don't apply them. Ones
  that match only after normalizing come back `'canonicalized'`, spelled **your** way, not the
  billing record's.
- **`proposeMappings` proposes; it never writes.** Applying is a separate, explicit act — and
  `skipped` records why every other account was passed over, so a second run months later proposes
  only what is new.

`gatherUsageRows` is the only part that does I/O; the three layers above it are pure functions over
records. It defaults to reading links from the **custom-field group** rather than `externalId`,
because a report that reads the derived index cannot notice the index is wrong. That costs a GET per
subscriber; pass `linkSource: 'externalId'` for a cheaper pass that trades away drift detection.
Per-account failures are collected into `failures` rather than thrown, so one bad account cannot
destroy a long sweep — check it before trusting the report.

## Invoices

`listAllInvoices` walks the invoice list; `getInvoiceDetail` reads one invoice in full, down to the
individual rated calls behind a metered charge.

```ts
import {
  OneBillReadClient, flattenInvoice, reconcileInvoice, findDuplicateCalls,
} from '@dszp/onebill-lib';

const invoices = await client.listAllInvoices({ accountNumber: 'CLI00000' });

const flat = flattenInvoice(await client.getInvoiceDetail(invoices[0].invoiceNumber));
flat.chargeLines;  // recurring, one-time, and usage rollups
flat.calls;        // one entry per rated call, with source, destination and rated duration
```

`accountNumber` is optional — omit it and you get the whole tenant.

### Check the read before you trust it

```ts
const check = reconcileInvoice(flat);
if (!check.usageBalanced) throw new Error('lost calls while reading the invoice');
```

`reconcileInvoice` compares a flattened invoice against the totals the invoice states about itself.
Run it. The failure mode on this endpoint is a walk that silently drops rows, and an analysis built
on a partial read reports a reassuring wrong answer.

It returns **two** checks, not one, because they fail for different reasons. `balanced` compares
charge lines + surcharges + discount against `totalCurrentCharge`. `usageBalanced` compares the
individual calls against their own rollups — an invoice can balance at the invoice level while the
per-call walk has lost rows, and only the second check sees that.

### Do not add charge lines and calls together

A usage charge line's `amount` **is** the sum of its own calls. `InvoiceChargeLine.isUsageRollup`
marks those lines. Adding both double-counts every metered charge.

### Comparing calls across invoices

```ts
const report = findDuplicateCalls(thisInvoice.calls, everyEarlierInvoice.calls);
report.naturalOnly.length;  // calls re-ingested under a new eventId
```

`eventId` is assigned when OneBill **ingests** the CDR, not by the switch — so a call re-imported
after a broken usage feed carries a *new* id for the same call, and matching on `eventId` alone
reports "no duplicates" for exactly the case you are asking about. `invoiceCallKey` is the identity
that survives a re-import: timestamp, source, destination, rated quantity.

`findDuplicateCalls` applies both keys and reports them separately rather than merging them into a
verdict — `naturalOnly` is the count that matters, and a merged flag could not express it.
`findRepeatedCalls` answers the different question of whether one invoice repeats a call against
itself, which a replayed feed can cause with no earlier invoice involved.

### PDFs and XML

```ts
import { invoicePdfBytes } from '@dszp/onebill-lib';

const pdf = await client.getInvoicePdf('INV00000');
writeFileSync(`${pdf.fileName}.pdf`, invoicePdfBytes(pdf));  // fileName carries NO extension
```

`getInvoiceXml` returns the same content as `getInvoiceDetail` in OneBill's own template format.
Prefer `getInvoiceDetail` — the XML for a large invoice runs to tens of megabytes of text.

**Large invoices are large.** An invoice carrying a year of recovered usage took ~20 seconds to
return and held over ten thousand calls. Budget for it, particularly in a Worker.

## Develop

```
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

`pnpm test` is green on a fresh clone with no credentials configured.

## Docs

- [ARCHITECTURE.md](ARCHITECTURE.md) — why the library is shaped this way, and the traps it works around
- [CONTRIBUTING.md](CONTRIBUTING.md) — the rules, and the reason behind each one
- [CHANGELOG.md](CHANGELOG.md)

## License

[MIT](LICENSE)
