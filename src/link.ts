/**
 * The link codec: a generic, multi-system identifier format for OneBill's Subscriber
 * `externalId` field.
 *
 * OneBill gives each Subscriber one short free-text `externalId`. That single field is the only
 * place to record "this customer is also record X in system A and record Y in system B", so the
 * format below packs several links into it:
 *
 *     CRM:4471|PBX:acme.12345.service|PBX:acme.12345.service/Downtown|+2
 *
 * Deliberately, **this module ships no namespace constants and knows nothing about any particular
 * downstream system.** `CRM` and `PBX` above are illustrative; you choose your own two-to-eight
 * character namespaces and, if you want them validated, pass a {@link NamespaceRegistry} you own.
 * A namespace baked in here would be a default that binds the library to one deployment.
 *
 * The overriding invariant is that **parsing never discards anything**. A token this module cannot
 * interpret is preserved verbatim in {@link ParsedLinks.unknown} and re-emitted on format. The
 * field is edited by hand in OneBill's UI, so a round trip that silently dropped an unrecognized
 * value would destroy someone's data on the next automated write.
 */

/**
 * The field's practical limit in OneBill's UI, in characters.
 *
 * This is a vendor product constraint rather than a deployment-specific one — it is true for every
 * OneBill tenant — which is why it may be a default. Override it via the `maxLength` option if your
 * tenant differs. OneBill counts **code points**, verified live, and so does {@link measureLength}.
 */
export const DEFAULT_MAX_LENGTH = 64;

/** Separates tokens within the field. */
const TOKEN_SEP = '|';
/** Separates a link's value from its optional qualifier. */
const QUALIFIER_SEP = '/';
/** Separates a link's namespace from its value. */
const NS_SEP = ':';

/** A namespace is 1-8 uppercase alphanumerics, starting with a letter. */
const NS_PATTERN = /^[A-Z][A-Z0-9]{0,7}$/;
/** The one reserved token shape: `+N`, the continuation marker. */
const CONTINUATION_PATTERN = /^\+([0-9]{1,4})$/;

/** Characters that may not appear inside a link's value or qualifier. */
const RESERVED_CHARS = [TOKEN_SEP, QUALIFIER_SEP, NS_SEP];

/**
 * One link to a record in some foreign system.
 *
 * Both `value` and `qualifier` are **opaque identifiers**. This module never parses, splits,
 * normalizes, or abbreviates them — notably, it will not treat a dotted value as though it had
 * meaningful parts.
 */
export interface Link {
  /** The foreign system's namespace, e.g. `CRM`. Must match `[A-Z][A-Z0-9]{0,7}`. */
  ns: string;
  /** The identifier in that system. Opaque. May not contain `|`, `/`, or `:`. */
  value: string;
  /**
   * An optional sub-unit of `value` — for a PBX namespace this might be a site within a domain.
   * Opaque, and subject to the same character restrictions as `value`.
   */
  qualifier?: string;
}

/** The result of parsing an `externalId`. Everything in the input is represented here. */
export interface ParsedLinks {
  /** Links this module understood, in the order they appeared. */
  links: Link[];
  /**
   * The `+N` continuation marker, if present: N further links exist outside this field, in
   * whatever overflow store the consumer maintains. This module only carries the number.
   */
  continuation?: number;
  /**
   * Tokens that did not parse as a link or a continuation marker, preserved **verbatim** and
   * re-emitted unchanged by {@link formatExternalId}. Never silently dropped.
   */
  unknown: string[];
  /** Non-fatal observations: duplicates removed, empty tokens skipped, extra markers ignored. */
  warnings: string[];
}

/**
 * An optional description of one namespace, supplied by the consumer.
 *
 * The library has no built-in registry. Yours belongs in your own application configuration, where
 * it can name the systems you actually integrate with.
 */
export interface NamespaceSpec {
  /** The namespace token, e.g. `CRM`. */
  ns: string;
  /** Human-readable name for display, e.g. `Example CRM`. */
  label: string;
  /** Optional longer explanation for a UI tooltip or admin screen. */
  description?: string;
  /** Whether links in this namespace may carry a qualifier. Defaults to permitting one. */
  allowQualifier?: boolean;
  /** Optional shape check for the value, e.g. `/^[0-9]+$/` for a numeric foreign key. */
  pattern?: RegExp;
}

/** A consumer-supplied set of namespace descriptions. An empty registry validates nothing. */
export type NamespaceRegistry = readonly NamespaceSpec[];

/** Thrown when a formatted link string would exceed the field's length limit. */
export class OneBillLinkTooLongError extends Error {
  constructor(
    message: string,
    /** Measured length of the string that would have been written. */
    public readonly length: number,
    /** The limit it exceeded. */
    public readonly maxLength: number,
    /** The trailing links that did not fit — candidates for the overflow store. */
    public readonly overflow: Link[],
  ) {
    super(message);
    this.name = 'OneBillLinkTooLongError';
  }
}

/** Thrown when a {@link Link} cannot be represented in the field's grammar. */
export class OneBillInvalidLinkError extends Error {
  constructor(
    message: string,
    /** The offending link, or the raw token for a hand-built `unknown` entry. */
    public readonly link: Link | string,
  ) {
    super(message);
    this.name = 'OneBillInvalidLinkError';
  }
}

/**
 * Measure a string the way OneBill's limit is enforced: **by code point, not by byte.**
 *
 * Verified live 2026-07-31 against the Subscriber update endpoint: a 40-character, 77-byte value
 * was accepted, and a 100-character value was rejected outright with
 * `10PA1166 "External ID can not be more than 64  character."`. The rejection is wholesale — the
 * write fails and the previous value is left intact, so there is no silent truncation to defend
 * against.
 *
 * Counting bytes as well would be safe but wrong: it would refuse values the API accepts, costing
 * capacity in exactly the case where the 64-character budget is already tight.
 *
 * Astral characters (those outside the Basic Multilingual Plane, which JavaScript stores as two
 * UTF-16 units) were not part of that test, so whether OneBill counts one or two for them is
 * unverified. Iterating the string counts them as one, which matches the documented wording.
 */
export function measureLength(s: string): number {
  let codePoints = 0;
  for (const _ of s) codePoints++;
  return codePoints;
}

/** An empty parse result — what a blank `externalId` yields. */
export function emptyLinks(): ParsedLinks {
  return { links: [], unknown: [], warnings: [] };
}

/** Identity key for a link, used for de-duplication and removal. */
function linkKey(l: Link): string {
  return `${l.ns}${NS_SEP}${l.value}${QUALIFIER_SEP}${l.qualifier ?? ''}`;
}

function hasReservedChar(s: string): boolean {
  return RESERVED_CHARS.some((c) => s.includes(c));
}

/**
 * Render one link as a token. Throws {@link OneBillInvalidLinkError} rather than emitting
 * something that would parse back differently.
 */
export function linkToToken(l: Link): string {
  if (!NS_PATTERN.test(l.ns)) {
    throw new OneBillInvalidLinkError(
      `Invalid namespace "${l.ns}": expected 1-8 uppercase alphanumerics starting with a letter`,
      l,
    );
  }
  if (l.value === '') {
    throw new OneBillInvalidLinkError(`Link in namespace "${l.ns}" has an empty value`, l);
  }
  if (hasReservedChar(l.value)) {
    throw new OneBillInvalidLinkError(
      `Value "${l.value}" contains a reserved character (${RESERVED_CHARS.join(' ')})`,
      l,
    );
  }
  if (l.qualifier !== undefined) {
    if (l.qualifier === '') {
      throw new OneBillInvalidLinkError(
        `Link ${l.ns}${NS_SEP}${l.value} has an empty qualifier; omit it instead`,
        l,
      );
    }
    if (hasReservedChar(l.qualifier)) {
      throw new OneBillInvalidLinkError(
        `Qualifier "${l.qualifier}" contains a reserved character (${RESERVED_CHARS.join(' ')})`,
        l,
      );
    }
  }
  const base = `${l.ns}${NS_SEP}${l.value}`;
  return l.qualifier === undefined ? base : `${base}${QUALIFIER_SEP}${l.qualifier}`;
}

/**
 * Parse an `externalId` into its links. Never throws and never discards input.
 *
 * ```ts
 * const p = parseExternalId('CRM:4471|PBX:acme.12345.service/Downtown');
 * p.links; // [{ns: 'CRM', value: '4471'}, {ns: 'PBX', value: 'acme.12345.service', qualifier: 'Downtown'}]
 * ```
 */
export function parseExternalId(raw: string | null | undefined): ParsedLinks {
  const out = emptyLinks();
  if (raw === null || raw === undefined) return out;

  const trimmed = raw.trim();
  if (trimmed === '') return out;

  const seen = new Set<string>();

  for (const rawToken of trimmed.split(TOKEN_SEP)) {
    const token = rawToken.trim();

    if (token === '') {
      out.warnings.push('Skipped an empty token');
      continue;
    }

    const cont = CONTINUATION_PATTERN.exec(token);
    if (cont) {
      const n = Number(cont[1]);
      if (out.continuation === undefined) {
        out.continuation = n;
      } else {
        // Preserve rather than drop: a second marker is someone's hand-typed data, and warnings are
        // advisory — callers do not necessarily surface them, so dropping here would lose it on the
        // next automated write.
        out.warnings.push(`Kept a second continuation marker "${token}" as an unrecognized token`);
        out.unknown.push(token);
      }
      continue;
    }

    const link = tokenToLink(token);
    if (link === undefined) {
      // Anything we cannot interpret is kept, not dropped. See the module doc comment.
      out.unknown.push(token);
      continue;
    }

    const key = linkKey(link);
    if (seen.has(key)) {
      out.warnings.push(`Removed a duplicate of "${token}"`);
      continue;
    }
    seen.add(key);
    out.links.push(link);
  }

  return out;
}

/** Interpret one token as a link, or `undefined` if it does not cleanly parse as one. */
function tokenToLink(token: string): Link | undefined {
  const sep = token.indexOf(NS_SEP);
  if (sep <= 0) return undefined;

  const ns = token.slice(0, sep);
  if (!NS_PATTERN.test(ns)) return undefined;

  const rest = token.slice(sep + 1);
  if (rest === '') return undefined;
  // A second `:` would make the token ambiguous on the next round trip.
  if (rest.includes(NS_SEP)) return undefined;

  const slash = rest.indexOf(QUALIFIER_SEP);
  if (slash === -1) return { ns, value: rest };

  const value = rest.slice(0, slash);
  const qualifier = rest.slice(slash + 1);
  // Empty either side, or a further `/`, is malformed rather than meaningful.
  if (value === '' || qualifier === '' || qualifier.includes(QUALIFIER_SEP)) return undefined;

  return { ns, value, qualifier };
}

/**
 * Render links back into an `externalId`.
 *
 * Emits links in the order given, then any preserved unknown tokens, then the continuation marker.
 * Throws {@link OneBillLinkTooLongError} if the result would exceed the limit — silently truncating
 * would drop a real link, so the caller decides what moves to the overflow store.
 */
export function formatExternalId(
  p: ParsedLinks,
  opts: { maxLength?: number } = {},
): string {
  const maxLength = opts.maxLength ?? DEFAULT_MAX_LENGTH;

  for (const u of p.unknown) {
    // A hand-built `unknown` entry containing a separator would re-parse as two tokens.
    if (u.includes(TOKEN_SEP)) {
      throw new OneBillInvalidLinkError(
        `Preserved token "${u}" contains the token separator "${TOKEN_SEP}"`,
        u,
      );
    }
  }

  const linkTokens = p.links.map(linkToToken);
  const tailTokens = [...p.unknown];
  if (p.continuation !== undefined) tailTokens.push(`+${p.continuation}`);

  const result = [...linkTokens, ...tailTokens].join(TOKEN_SEP);
  const length = measureLength(result);

  if (length > maxLength) {
    throw new OneBillLinkTooLongError(
      `Link string is ${length} long, over the ${maxLength} limit; ` +
        `${overflowOf(p, maxLength).length} link(s) do not fit`,
      length,
      maxLength,
      overflowOf(p, maxLength),
    );
  }

  return result;
}

/**
 * Which trailing links would have to move to an overflow store for the rest to fit.
 *
 * Unknown tokens and the continuation marker are treated as non-negotiable — they are either
 * someone's hand-typed data or the pointer to the overflow itself — so only links are shed, from
 * the end backwards.
 */
function overflowOf(p: ParsedLinks, maxLength: number): Link[] {
  const tail = [...p.unknown];
  if (p.continuation !== undefined) tail.push(`+${p.continuation}`);

  const kept: Link[] = [];
  for (const link of p.links) {
    const candidate = [...kept.map(linkToToken), linkToToken(link), ...tail].join(TOKEN_SEP);
    if (measureLength(candidate) > maxLength) {
      return p.links.slice(kept.length);
    }
    kept.push(link);
  }
  return [];
}

/** Whether {@link formatExternalId} would succeed. Never throws for length reasons. */
export function fits(p: ParsedLinks, maxLength: number = DEFAULT_MAX_LENGTH): boolean {
  try {
    formatExternalId(p, { maxLength });
    return true;
  } catch (e) {
    if (e instanceof OneBillLinkTooLongError) return false;
    throw e;
  }
}

/**
 * Sort links and unknown tokens into a stable order and drop any duplicates.
 *
 * Order is not significant in the field, so this exists to make two equivalent strings compare
 * equal — useful before deciding whether a write is actually needed.
 */
export function canonicalize(p: ParsedLinks): ParsedLinks {
  const seen = new Set<string>();
  const links: Link[] = [];
  for (const l of p.links) {
    const key = linkKey(l);
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(l);
  }
  links.sort((a, b) => linkKey(a).localeCompare(linkKey(b)));

  return {
    links,
    continuation: p.continuation,
    unknown: [...new Set(p.unknown)].sort((a, b) => a.localeCompare(b)),
    warnings: [...p.warnings],
  };
}

/**
 * Check links against a registry you supply.
 *
 * Returns a list of human-readable problems; an empty array means everything checked out. An empty
 * registry checks no namespaces — it will still report tokens that failed to parse at all.
 */
export function validate(p: ParsedLinks, registry: NamespaceRegistry = []): string[] {
  const problems: string[] = [];

  for (const token of p.unknown) {
    problems.push(`Token "${token}" is not a recognizable link`);
  }

  if (registry.length === 0) return problems;

  const byNs = new Map(registry.map((s) => [s.ns, s]));
  for (const l of p.links) {
    const spec = byNs.get(l.ns);
    if (!spec) {
      problems.push(`Namespace "${l.ns}" is not in the registry`);
      continue;
    }
    if (l.qualifier !== undefined && spec.allowQualifier === false) {
      problems.push(`Namespace "${l.ns}" (${spec.label}) does not take a qualifier`);
    }
    if (spec.pattern && !spec.pattern.test(l.value)) {
      problems.push(`Value "${l.value}" does not match the expected shape for ${spec.label}`);
    }
  }

  return problems;
}

/** Every link in one namespace, e.g. `linksFor(p, MY_PBX_NAMESPACE)`. */
export function linksFor(p: ParsedLinks, ns: string): Link[] {
  return p.links.filter((l) => l.ns === ns);
}

/**
 * Add a link if an identical one is not already present. Returns a new object; the input is not
 * modified. Identity is the full triple (namespace, value, qualifier), so two sites of one domain
 * are two distinct links.
 */
export function upsertLink(p: ParsedLinks, link: Link): ParsedLinks {
  // Reject an unrepresentable link now rather than at format time, where the caller has lost the
  // context of which link it added.
  linkToToken(link);

  const key = linkKey(link);
  if (p.links.some((l) => linkKey(l) === key)) return { ...p, links: [...p.links] };
  return { ...p, links: [...p.links, link] };
}

/** Remove a link, matching on the full triple. Returns a new object. */
export function removeLink(p: ParsedLinks, link: Link): ParsedLinks {
  const key = linkKey(link);
  return { ...p, links: p.links.filter((l) => linkKey(l) !== key) };
}
