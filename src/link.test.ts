import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_LENGTH,
  OneBillInvalidLinkError,
  OneBillLinkTooLongError,
  canonicalize,
  emptyLinks,
  fits,
  formatExternalId,
  linkToToken,
  linksFor,
  measureLength,
  parseExternalId,
  removeLink,
  upsertLink,
  validate,
  type Link,
  type NamespaceRegistry,
  type ParsedLinks,
} from './link.js';

// Namespaces here are fictional on purpose: the codec ships none of its own, so the tests must not
// imply otherwise. CRM/PBX/XYZ are stand-ins a reader should mentally replace with their own.
const CRM = 'CRM';
const PBX = 'PBX';

describe('parseExternalId', () => {
  it('treats blank input as no links', () => {
    for (const raw of ['', '   ', null, undefined]) {
      const p = parseExternalId(raw);
      expect(p.links).toEqual([]);
      expect(p.unknown).toEqual([]);
      expect(p.continuation).toBeUndefined();
    }
  });

  it('parses a single link', () => {
    const p = parseExternalId('CRM:4471');
    expect(p.links).toEqual([{ ns: CRM, value: '4471' }]);
  });

  it('parses a link with a qualifier', () => {
    const p = parseExternalId('PBX:acme.12345.service/Downtown');
    expect(p.links).toEqual([
      { ns: PBX, value: 'acme.12345.service', qualifier: 'Downtown' },
    ]);
  });

  it('does not split a dotted value into parts', () => {
    // Values are opaque. A domain-looking value must survive whole.
    const p = parseExternalId('PBX:acme.12345.service');
    expect(p.links[0]!.value).toBe('acme.12345.service');
  });

  it('accepts the two orderings as the same set of links', () => {
    const a = parseExternalId('CRM:4471|PBX:acme.12345.service');
    const b = parseExternalId('PBX:acme.12345.service|CRM:4471');
    expect(canonicalize(a).links).toEqual(canonicalize(b).links);
  });

  it('reads the continuation marker', () => {
    const p = parseExternalId('CRM:4471|+3');
    expect(p.continuation).toBe(3);
    expect(p.links).toHaveLength(1);
  });

  it('keeps the first continuation marker and warns about a second', () => {
    const p = parseExternalId('+2|+5');
    expect(p.continuation).toBe(2);
    expect(p.warnings.join(' ')).toContain('second continuation');
  });

  it('de-duplicates identical links and warns', () => {
    const p = parseExternalId('CRM:4471|CRM:4471');
    expect(p.links).toHaveLength(1);
    expect(p.warnings.join(' ')).toContain('duplicate');
  });

  it('treats a differing qualifier as a distinct link', () => {
    const p = parseExternalId('PBX:acme.12345.service|PBX:acme.12345.service/Downtown');
    expect(p.links).toHaveLength(2);
  });

  it('skips empty tokens and warns', () => {
    const p = parseExternalId('CRM:4471||');
    expect(p.links).toHaveLength(1);
    expect(p.warnings.join(' ')).toContain('empty token');
  });

  it('tolerates whitespace around tokens', () => {
    const p = parseExternalId(' CRM:4471 | PBX:acme.12345.service ');
    expect(p.links).toHaveLength(2);
  });
});

describe('never losing a token', () => {
  // The single most important property in this module: the field is hand-edited in OneBill's UI,
  // so an automated round trip that dropped an unrecognized value would destroy real data.

  it('preserves a namespace the codec was never taught', () => {
    const raw = 'CRM:4471|XYZ:something-else';
    const p = parseExternalId(raw);
    expect(p.links).toHaveLength(2);
    expect(formatExternalId(p)).toBe(raw);
  });

  it.each([
    'not-a-link',
    'lowercase:value',
    'TOOLONGNS:value',
    '9NUM:value',
    ':leading-colon',
    'CRM:',
    'CRM:a:b',
    'PBX:acme/',
    'PBX:/Downtown',
    'PBX:a/b/c',
    '+notanumber',
  ])('preserves the malformed token %j verbatim', (token) => {
    const p = parseExternalId(token);
    expect(p.links).toEqual([]);
    expect(p.unknown).toEqual([token]);
    expect(formatExternalId(p)).toBe(token);
  });

  it('keeps unknown tokens alongside real links', () => {
    const p = parseExternalId('CRM:4471|free text here|+2');
    expect(p.links).toHaveLength(1);
    expect(p.unknown).toEqual(['free text here']);
    expect(p.continuation).toBe(2);
    expect(formatExternalId(p)).toBe('CRM:4471|free text here|+2');
  });

  it('round-trips every combination through parse -> format -> parse', () => {
    const values = [
      '',
      'CRM:4471',
      'PBX:acme.12345.service',
      'PBX:acme.12345.service/Downtown',
      'CRM:4471|PBX:acme.12345.service',
      'PBX:acme.12345.service|CRM:4471',
      'CRM:4471|+2',
      'CRM:4471|mystery|+2',
      'XYZ:abc|PBX:acme.12345.service/Airport',
      'PBX:acme.12345.service/Downtown|PBX:acme.12345.service/Airport',
    ];
    for (const raw of values) {
      const once = parseExternalId(raw);
      const twice = parseExternalId(formatExternalId(once));
      expect(twice).toEqual(once);
    }
  });
});

describe('formatExternalId', () => {
  it('renders an empty parse as an empty string', () => {
    expect(formatExternalId(emptyLinks())).toBe('');
  });

  it('puts unknown tokens and the continuation marker after the links', () => {
    const p: ParsedLinks = {
      links: [{ ns: CRM, value: '4471' }],
      unknown: ['leftover'],
      continuation: 2,
      warnings: [],
    };
    expect(formatExternalId(p)).toBe('CRM:4471|leftover|+2');
  });

  it('refuses a hand-built unknown token containing the token separator', () => {
    const p: ParsedLinks = { links: [], unknown: ['a|b'], warnings: [] };
    expect(() => formatExternalId(p)).toThrow(OneBillInvalidLinkError);
  });
});

describe('length limits', () => {
  const link = (value: string, qualifier?: string): Link => ({ ns: 'AB', value, qualifier });
  const wrap = (l: Link): ParsedLinks => ({ links: [l], unknown: [], warnings: [] });

  it('accepts a string of exactly the limit', () => {
    // 'AB:' is 3 characters, so a 61-character value lands on 64 exactly.
    const p = wrap(link('x'.repeat(DEFAULT_MAX_LENGTH - 3)));
    const out = formatExternalId(p);
    expect(measureLength(out)).toBe(DEFAULT_MAX_LENGTH);
    expect(fits(p)).toBe(true);
  });

  it('rejects one character over the limit and reports the overflow', () => {
    const p = wrap(link('x'.repeat(DEFAULT_MAX_LENGTH - 2)));
    expect(fits(p)).toBe(false);
    try {
      formatExternalId(p);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(OneBillLinkTooLongError);
      const err = e as OneBillLinkTooLongError;
      expect(err.length).toBe(DEFAULT_MAX_LENGTH + 1);
      expect(err.maxLength).toBe(DEFAULT_MAX_LENGTH);
      expect(err.overflow).toHaveLength(1);
    }
  });

  it('names only the links that do not fit', () => {
    const p: ParsedLinks = {
      links: [
        { ns: 'AB', value: 'x'.repeat(40) },
        { ns: 'CD', value: 'y'.repeat(40) },
      ],
      unknown: [],
      warnings: [],
    };
    try {
      formatExternalId(p);
      expect.unreachable('should have thrown');
    } catch (e) {
      const err = e as OneBillLinkTooLongError;
      expect(err.overflow).toEqual([{ ns: 'CD', value: 'y'.repeat(40) }]);
    }
  });

  it('honours a caller-supplied limit', () => {
    const p = wrap(link('4471'));
    expect(fits(p, 100)).toBe(true);
    expect(fits(p, 5)).toBe(false);
  });

  it('counts code points, not bytes', () => {
    // Verified live: OneBill accepted a 40-character, 77-byte value, so bytes are not the measure.
    expect(measureLength('é')).toBe(1);
    expect(measureLength('e')).toBe(1);
    // An astral character is one code point, not the two UTF-16 units `.length` would report.
    expect(measureLength('\u{1F600}')).toBe(1);
    expect('\u{1F600}'.length).toBe(2);
  });

  it('accepts a multi-byte value that fits by character count', () => {
    // 'AB:acme/' is 8 characters plus 37 accented characters = 45 characters but 82 bytes.
    // A byte-based measure would wrongly refuse this; OneBill accepts it.
    const p = wrap(link('acme', 'é'.repeat(37)));
    expect(measureLength(formatExternalId(p))).toBe(45);
    expect(fits(p)).toBe(true);
  });

  it('still refuses a multi-byte value that is too many characters', () => {
    const p = wrap(link('acme', 'é'.repeat(70)));
    expect(fits(p)).toBe(false);
  });
});

describe('rejecting unrepresentable links', () => {
  it.each([
    { ns: 'crm', value: 'x' },
    { ns: 'TOOLONGNS', value: 'x' },
    { ns: '1AB', value: 'x' },
    { ns: 'AB', value: '' },
    { ns: 'AB', value: 'a|b' },
    { ns: 'AB', value: 'a/b' },
    { ns: 'AB', value: 'a:b' },
    { ns: 'AB', value: 'ok', qualifier: '' },
    { ns: 'AB', value: 'ok', qualifier: 'a/b' },
    { ns: 'AB', value: 'ok', qualifier: 'a|b' },
    { ns: 'AB', value: 'ok', qualifier: 'a:b' },
  ])('refuses %j', (l) => {
    expect(() => linkToToken(l as Link)).toThrow(OneBillInvalidLinkError);
  });

  it('allows a qualifier containing a space', () => {
    // Site labels in the wild contain spaces; only the three separators are reserved.
    expect(linkToToken({ ns: PBX, value: 'acme.12345.service', qualifier: 'North Office' })).toBe(
      'PBX:acme.12345.service/North Office',
    );
  });

  it('rejects at upsert time, not at format time', () => {
    expect(() => upsertLink(emptyLinks(), { ns: 'AB', value: 'a|b' })).toThrow(
      OneBillInvalidLinkError,
    );
  });
});

describe('validate', () => {
  const registry: NamespaceRegistry = [
    { ns: CRM, label: 'Example CRM', allowQualifier: false, pattern: /^[0-9]+$/ },
    { ns: PBX, label: 'Example PBX' },
  ];

  it('reports nothing for a clean set', () => {
    expect(validate(parseExternalId('CRM:4471|PBX:acme.12345.service'), registry)).toEqual([]);
  });

  it('accepts any namespace when the registry is empty', () => {
    expect(validate(parseExternalId('XYZ:abc'), [])).toEqual([]);
    expect(validate(parseExternalId('XYZ:abc'))).toEqual([]);
  });

  it('flags a namespace absent from a populated registry', () => {
    expect(validate(parseExternalId('XYZ:abc'), registry).join(' ')).toContain('not in the registry');
  });

  it('flags a qualifier on a namespace that forbids one', () => {
    expect(validate(parseExternalId('CRM:4471/extra'), registry).join(' ')).toContain(
      'does not take a qualifier',
    );
  });

  it('flags a value that fails the namespace pattern', () => {
    expect(validate(parseExternalId('CRM:not-numeric'), registry).join(' ')).toContain(
      'does not match the expected shape',
    );
  });

  it('reports unparseable tokens even with no registry', () => {
    expect(validate(parseExternalId('garbage')).join(' ')).toContain('not a recognizable link');
  });
});

describe('link set operations', () => {
  const base = parseExternalId('CRM:4471|PBX:acme.12345.service|PBX:acme.12345.service/Downtown');

  it('selects links by namespace', () => {
    expect(linksFor(base, CRM)).toHaveLength(1);
    expect(linksFor(base, PBX)).toHaveLength(2);
    expect(linksFor(base, 'NONE')).toHaveLength(0);
  });

  it('adds a new link without mutating the input', () => {
    const next = upsertLink(base, { ns: PBX, value: 'other.12345.service' });
    expect(next.links).toHaveLength(4);
    expect(base.links).toHaveLength(3);
  });

  it('is a no-op when the identical link is already present', () => {
    const next = upsertLink(base, { ns: CRM, value: '4471' });
    expect(next.links).toHaveLength(3);
  });

  it('distinguishes a qualified link from its unqualified twin', () => {
    const next = upsertLink(base, { ns: PBX, value: 'acme.12345.service', qualifier: 'Airport' });
    expect(next.links).toHaveLength(4);
  });

  it('removes on the full triple only', () => {
    const removed = removeLink(base, { ns: PBX, value: 'acme.12345.service' });
    expect(removed.links).toHaveLength(2);
    // The qualified sibling survives.
    expect(linksFor(removed, PBX)).toEqual([
      { ns: PBX, value: 'acme.12345.service', qualifier: 'Downtown' },
    ]);
  });

  it('canonicalizes two orderings to the same string', () => {
    const a = formatExternalId(canonicalize(parseExternalId('PBX:acme.12345.service|CRM:4471')));
    const b = formatExternalId(canonicalize(parseExternalId('CRM:4471|PBX:acme.12345.service')));
    expect(a).toBe(b);
  });

  it('preserves the continuation marker through canonicalize', () => {
    expect(canonicalize(parseExternalId('CRM:4471|+2')).continuation).toBe(2);
  });
});
