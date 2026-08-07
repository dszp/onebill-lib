# Contributing to `@dszp/onebill-lib`

Bug reports, ideas, and pull requests are welcome. This library is small and opinionated; the rules
below are the opinions, and each exists for a concrete reason rather than taste.

## Getting started

**Package manager: pnpm.** No runtime dependencies — please keep it that way.

```
pnpm install
pnpm build         # tsc → dist/ (dist/index.js + dist/index.d.ts)
pnpm test          # the offline suite — must pass with NO credentials and no setup
pnpm typecheck     # also checks the type-level API-surface assertions
```

`pnpm test` must be green on a fresh clone with nothing configured and no environment variables set.
Live smoke tests are named `*.live.test.ts` and self-skip when their credentials are absent.

## The rules

### 1. Fixtures and examples must be fictional

Every account number, company, person, domain, email address, and identifier in this repo — in code,
comments, tests, and the README — must be invented or reserved. No exceptions, including "just while
I debug."

Use [RFC 2606](https://www.rfc-editor.org/rfc/rfc2606) reserved names:

| Use | Prefer |
|---|---|
| domains / hosts | `example.com`, `example.net`, `*.example` |
| OneBill instance | `billing.example.com` |
| account numbers | `CLI00000`, `SR00000` — zero-padded, obviously synthetic |
| companies | `Acme`, `Acme Division 1`, `demo` |
| people / logins | `api@example.com`, `Alex Reseller`, `jordan@acme.example` |
| tenant / secrets | `tenant-0000`, `secret-0000`, `not-a-real-password` |
| linked-system values | `acme.12345.service`, `4471` |
| phone numbers | `555-01xx` / `13175550100`-style fictional-use numbers |

`src/testkit.ts` and `src/link.test.ts` are the reference for what good looks like.

**A linked value is an opaque string. Treat it as an identifier, never as parseable data.**

The link codec carries identifiers belonging to *other* systems, and it must not develop opinions
about their shape. Never split a value on `.` expecting a fixed number of parts, never strip or
re-attach a suffix to save characters, and never infer ownership or scope from how a value looks.
Values that resemble hostnames are especially tempting and especially wrong: in at least one system
the library commonly links to, a suffix records where a record was created rather than who holds it
now, so parsing one produces a confident wrong answer. Ask the other system; don't parse its keys.

### 2. No real customer data, ever

Not in code, comments, tests, the README, **or a commit message**. That includes real company names,
account numbers, contacts, email addresses, phone numbers, invoice totals, and the identifiers of any
system a link points at. A subscriber record pulled from a live tenant is customer data end to end —
never paste one into an issue, a PR, or a fixture.

If you need a real value to reproduce a bug, describe its *shape* (`an account whose externalId
carries two links and a continuation marker`), not the value.

### 3. No defaults that bind the library to one deployment

A default encoding *someone's specific* tenant, instance, integration, or brand is a bug, not a
convenience: it silently couples every other consumer to a stranger's setup.

That is why `tenantId`, `clientSecret`, `username`, and `password` are all required with no defaults.
`baseUrl` defaults to OneBill's own public endpoint and `scope` to `trust`, because those are vendor
constants — true for every OneBill tenant and overridable. Apply that test to any default you add:
*is this true for everyone, or just for us?*

### 4. The link codec ships no namespace constants

This is rule 3 applied to the part of the library most likely to break it. `parseExternalId` accepts
any namespace matching `[A-Z][A-Z0-9]{0,7}` and treats them all identically. The `PBX` and `CRM` you
see in doc comments and tests are placeholders, not API.

Which namespaces mean what is *configuration*, supplied by the consumer as a `NamespaceRegistry` and
passed to `validate()` or `buildLinkIndex()`. Adding a built-in namespace — or a convenience helper
like `netsapiensLinks(p)` — would bake one integrator's stack into a general-purpose library. Use
`linksFor(p, YOUR_NAMESPACE)` with your own constant instead.

### 5. Parsing must never discard input

`parseExternalId` puts anything it cannot interpret into `ParsedLinks.unknown`, verbatim, and
`formatExternalId` writes it back out. This is the most important invariant in the codebase, and it
is not a nicety: the `externalId` field is edited by hand in OneBill's UI, so a round trip that
dropped an unrecognized token would silently destroy someone's data on the next automated write.

Any change to the codec needs a test proving a token it does not understand survives
parse → format → parse unchanged.

### 6. Doc comments are published API

They ship in `dist/*.d.ts` and surface on IDE hover for every consumer. A comment here is as public
as a function signature. Write for a stranger, and never park context in one that you would not put
in the README — in particular, never illustrate a feature with a real customer's account.

### 7. Keep it Node-free

Never import `node:*` (`fs`, `path`, `crypto`, `Buffer`, …) anywhere in `src/`. Use Web APIs —
`fetch`, `crypto.subtle`, `TextEncoder`, `URL`. `http.ts` hashes the password with
`crypto.subtle.digest` rather than `node:crypto` for exactly this reason, which is why that function
is async.

It is enforced structurally: `tsconfig.json` sets `"types": []` with no `@types/node`, so a stray
`node:*` import fails `pnpm build`. Please don't add `@types/node` to make an error go away — the
error is the feature. It is what lets the same built output run in a Cloudflare Worker, in Node, and
in a browser.

### 8. Read and write stay two classes over one private transport

`OneBillHttp` is held in a `#private` field and is **never exported from `index.ts`**. `OneBillReadClient`
has only GET methods and no generic `call()` escape hatch, so holding one is proof you cannot write.

Never export the transport, never merge the two client classes, and never add a generic request
method to the read client. Any of those silently converts a structural guarantee back into a
convention. The boundary is asserted at the type level in `readClient.test.ts` and checked by
`pnpm typecheck`.

New write capability extends the write client (or a sibling), never the read client.

### 9. Treat the published OpenAPI document as a lower bound

OneBill's spec is a Postman export. Several Subscriber operations document no request body at all,
fields observed on the wire are missing from response schemas (`externalId` among them), and some
"paths" are hardcoded sample values rather than templates. It is useful as a starting point and
worthless as an authority.

So: model types loosely (`[k: string]: any` on every wire-facing interface, almost everything
optional), and when the spec and a live response disagree, believe the response — and record the
disagreement in a dated comment so the next reader does not have to rediscover it.

## Pull requests

- One logical change per PR; include a test.
- Run `pnpm build && pnpm test && pnpm typecheck` before opening.
- Add a `CHANGELOG.md` entry under "Unreleased" for anything user-visible.
- Public API changes need a note on why the surface should grow — this library aims to stay small.
