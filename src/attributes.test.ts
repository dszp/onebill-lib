import { describe, expect, it } from 'vitest';
import {
  attributesToLinks,
  buildLinkSet,
  linksToAttributes,
  type LinkMapping,
} from './attributes.js';
import type { Rec, Subscriber } from './model.js';

// Fictional groups and namespaces: the library ships neither.
const MAPPING: LinkMapping = [
  { group: 'PBX', ns: 'NS', valueField: 'Domain', qualifierField: 'Site' },
  { group: 'PSA', ns: 'AT', valueField: 'ID' },
];

/** Build a group instance the way OneBill returns one, with fields in arbitrary order. */
function group(key: string, aggregator: number, fields: Record<string, string | undefined>): Rec {
  return {
    key,
    aggregator,
    configType: 'Group',
    childAttribute: Object.entries(fields)
      .reverse() // order is not meaningful on the wire; prove we don't depend on it
      .map(([k, v], i) => ({
        id: `${aggregator}${i}`,
        key: k,
        ...(v === undefined ? {} : { value: v }),
        configType: 'String',
      })),
  };
}

const sub = (...groups: Rec[]): Subscriber => ({
  accountNumber: 'CLI00000',
  accountAttribute: groups,
});

describe('attributesToLinks', () => {
  it('reads a value and its qualifier', () => {
    const links = attributesToLinks(
      sub(group('PBX', 1, { Domain: 'acme.12345.service', Site: 'Downtown' })),
      MAPPING,
    );
    expect(links).toEqual([
      { ns: 'NS', value: 'acme.12345.service', qualifier: 'Downtown', group: 'PBX', aggregator: 1 },
    ]);
  });

  it('omits the qualifier when the field is blank', () => {
    const links = attributesToLinks(sub(group('PBX', 1, { Domain: 'acme.12345.service' })), MAPPING);
    expect(links[0]).not.toHaveProperty('qualifier');
  });

  it('ignores a spec with no qualifier field even when the group has one', () => {
    const links = attributesToLinks(sub(group('PSA', 1, { ID: '4471', Site: 'ignored' })), MAPPING);
    expect(links).toEqual([{ ns: 'AT', value: '4471', group: 'PSA', aggregator: 1 }]);
  });

  it('skips the blank placeholder instance OneBill materialises on every record', () => {
    expect(attributesToLinks(sub(group('PBX', 1, { Domain: undefined, Site: undefined })), MAPPING)).toEqual(
      [],
    );
  });

  it('skips an instance whose value field is only whitespace', () => {
    expect(attributesToLinks(sub(group('PBX', 1, { Domain: '   ' })), MAPPING)).toEqual([]);
  });

  it('ignores groups absent from the mapping', () => {
    expect(attributesToLinks(sub(group('OTHER', 1, { Domain: 'x' })), MAPPING)).toEqual([]);
  });

  it('keeps two instances of one group distinct by aggregator', () => {
    const links = attributesToLinks(
      sub(
        group('PBX', 1, { Domain: 'acme.12345.service', Site: 'Downtown' }),
        group('PBX', 2, { Domain: 'acme.12345.service', Site: 'Airport' }),
      ),
      MAPPING,
    );
    expect(links).toHaveLength(2);
    expect(links.map((l) => l.aggregator)).toEqual([1, 2]);
  });

  it('returns nothing for a record with no groups', () => {
    expect(attributesToLinks({ accountNumber: 'CLI00000' }, MAPPING)).toEqual([]);
  });
});

describe('buildLinkSet', () => {
  it('strips provenance and de-duplicates', () => {
    const set = buildLinkSet([
      { ns: 'NS', value: 'a', group: 'PBX', aggregator: 1 },
      { ns: 'NS', value: 'a', group: 'PBX', aggregator: 2 },
      { ns: 'AT', value: '1', group: 'PSA', aggregator: 1 },
    ]);
    expect(set).toEqual([{ ns: 'NS', value: 'a' }, { ns: 'AT', value: '1' }]);
  });

  it('treats a differing qualifier as a distinct link', () => {
    const set = buildLinkSet([
      { ns: 'NS', value: 'a', qualifier: 'X', group: 'PBX' },
      { ns: 'NS', value: 'a', qualifier: 'Y', group: 'PBX' },
    ]);
    expect(set).toHaveLength(2);
  });
});

describe('linksToAttributes', () => {
  it('creates an instance with the next free aggregator', () => {
    // The API requires the caller to assign it: omit it and a second instance collides.
    const plan = linksToAttributes(
      sub(group('PBX', 1, { Domain: 'acme.12345.service' })),
      [
        { ns: 'NS', value: 'acme.12345.service' },
        { ns: 'NS', value: 'other.12345.service' },
      ],
      MAPPING,
    );
    expect(plan.created).toEqual([{ ns: 'NS', value: 'other.12345.service' }]);
    const added = plan.attributes.find((a) => a.aggregator === 2);
    expect(added).toBeDefined();
    expect(added!.key).toBe('PBX');
  });

  it('reports an already-correct link as unchanged and writes nothing new', () => {
    const plan = linksToAttributes(
      sub(group('PBX', 1, { Domain: 'acme.12345.service', Site: 'Downtown' })),
      [{ ns: 'NS', value: 'acme.12345.service', qualifier: 'Downtown' }],
      MAPPING,
    );
    expect(plan.unchanged).toHaveLength(1);
    expect(plan.created).toEqual([]);
    expect(plan.updated).toEqual([]);
  });

  it('edits an existing instance in place, keeping its aggregator', () => {
    const plan = linksToAttributes(
      sub(group('PBX', 3, { Domain: 'acme.12345.service', Site: 'Downtown' })),
      [{ ns: 'NS', value: 'acme.12345.service', qualifier: 'Airport' }],
      MAPPING,
    );
    expect(plan.updated).toHaveLength(1);
    expect(plan.attributes).toHaveLength(1);
    expect(plan.attributes[0]!.aggregator).toBe(3);
    const fields = Object.fromEntries(
      (plan.attributes[0]!.childAttribute as Rec[]).map((c) => [c.key, c.value]),
    );
    expect(fields.Site).toBe('Airport');
  });

  it('names only the managed fields, so hand-set ones survive the merge', () => {
    // Child updates merge on this API, so omitting Description leaves it alone.
    const plan = linksToAttributes(
      sub(group('PBX', 1, { Domain: 'acme.12345.service', Description: 'set by hand' })),
      [{ ns: 'NS', value: 'acme.12345.service', qualifier: 'Downtown' }],
      MAPPING,
    );
    const named = (plan.attributes[0]!.childAttribute as Rec[]).map((c) => c.key);
    expect(named).toEqual(['Domain', 'Site']);
    expect(named).not.toContain('Description');
  });

  it('leaves an unlisted link alone by default and reports it', () => {
    const plan = linksToAttributes(
      sub(group('PBX', 1, { Domain: 'stale.12345.service' })),
      [{ ns: 'NS', value: 'acme.12345.service' }],
      MAPPING,
    );
    expect(plan.notRemoved.map((l) => l.value)).toEqual(['stale.12345.service']);
    expect(plan.removed).toEqual([]);
    // Still in the payload, and unmarked — omission alone would not delete it anyway.
    const stale = plan.attributes.find((a) => a.aggregator === 1)!;
    expect(stale.operationType).toBeUndefined();
  });

  it('marks an unlisted link for deletion when asked', () => {
    // operationType 2, a NUMBER on the group and every child. A string crashes the server.
    const plan = linksToAttributes(
      sub(group('PBX', 1, { Domain: 'stale.12345.service', Site: 'Old' })),
      [{ ns: 'NS', value: 'acme.12345.service' }],
      MAPPING,
      { removeUnlisted: true },
    );
    expect(plan.removed.map((l) => l.value)).toEqual(['stale.12345.service']);
    expect(plan.notRemoved).toEqual([]);

    const doomed = plan.attributes.find((a) => a.aggregator === 1)!;
    expect(doomed.operationType).toBe(2);
    for (const child of doomed.childAttribute as Rec[]) {
      expect(child.operationType).toBe(2);
      expect(child.attributeValuesInfo.associateValues[0].sequence).toBe(1);
    }
  });

  it('does not mark a requested link for deletion', () => {
    const plan = linksToAttributes(
      sub(group('PBX', 1, { Domain: 'acme.12345.service' })),
      [{ ns: 'NS', value: 'acme.12345.service' }],
      MAPPING,
      { removeUnlisted: true },
    );
    expect(plan.removed).toEqual([]);
    expect(plan.attributes[0]!.operationType).toBeUndefined();
  });

  it('reports a namespace absent from the mapping instead of dropping it', () => {
    const plan = linksToAttributes(sub(), [{ ns: 'ZZ', value: 'x' }], MAPPING);
    expect(plan.unmapped).toEqual([{ ns: 'ZZ', value: 'x' }]);
    expect(plan.created).toEqual([]);
  });

  it('numbers aggregators per group, not globally', () => {
    const plan = linksToAttributes(
      sub(group('PBX', 1, { Domain: 'a' }), group('PBX', 2, { Domain: 'b' })),
      [{ ns: 'AT', value: '4471' }],
      MAPPING,
    );
    const psa = plan.attributes.find((a) => a.key === 'PSA');
    expect(psa!.aggregator).toBe(1);
  });

  it('starts at aggregator 1 on an empty record', () => {
    const plan = linksToAttributes(sub(), [{ ns: 'NS', value: 'acme.12345.service' }], MAPPING);
    expect(plan.attributes[0]!.aggregator).toBe(1);
  });
});

describe('regressions from the pre-publish review', () => {
  it('does not collapse two links sharing a value but differing in qualifier', () => {
    // H2. The codec treats the full triple as identity, and a site-split customer is exactly this
    // shape. Matching on value alone made the second link overwrite the first.
    const plan = linksToAttributes(
      sub(),
      [
        { ns: 'NS', value: 'acme.12345.service', qualifier: 'Downtown' },
        { ns: 'NS', value: 'acme.12345.service', qualifier: 'Airport' },
      ],
      MAPPING,
    );
    expect(plan.created).toHaveLength(2);
    expect(plan.attributes).toHaveLength(2);
    expect(plan.attributes.map((a) => a.aggregator).sort()).toEqual([1, 2]);

    const sites = plan.attributes
      .map((a) => (a.childAttribute as Rec[]).find((c) => c.key === 'Site')?.value)
      .sort();
    expect(sites).toEqual(['Airport', 'Downtown']);
  });

  it('adds a second qualifier beside an existing one rather than overwriting it', () => {
    const plan = linksToAttributes(
      sub(group('PBX', 1, { Domain: 'acme.12345.service', Site: 'Downtown' })),
      [
        { ns: 'NS', value: 'acme.12345.service', qualifier: 'Downtown' },
        { ns: 'NS', value: 'acme.12345.service', qualifier: 'Airport' },
      ],
      MAPPING,
    );
    expect(plan.unchanged).toHaveLength(1);
    expect(plan.created).toHaveLength(1);
    expect(plan.attributes).toHaveLength(2);
  });

  it('still edits in place when only the qualifier changed', () => {
    // The value-only fallback must survive the exact-match pass being added.
    const plan = linksToAttributes(
      sub(group('PBX', 1, { Domain: 'acme.12345.service', Site: 'Downtown' })),
      [{ ns: 'NS', value: 'acme.12345.service', qualifier: 'Airport' }],
      MAPPING,
    );
    expect(plan.updated).toHaveLength(1);
    expect(plan.created).toEqual([]);
    expect(plan.attributes).toHaveLength(1);
  });

  it('an exact match does not steal the instance of a sibling differing only in qualifier', () => {
    const plan = linksToAttributes(
      sub(
        group('PBX', 1, { Domain: 'acme.12345.service', Site: 'Downtown' }),
        group('PBX', 2, { Domain: 'acme.12345.service', Site: 'Airport' }),
      ),
      [
        { ns: 'NS', value: 'acme.12345.service', qualifier: 'Airport' },
        { ns: 'NS', value: 'acme.12345.service', qualifier: 'Downtown' },
      ],
      MAPPING,
    );
    expect(plan.unchanged).toHaveLength(2);
    expect(plan.created).toEqual([]);
    expect(plan.updated).toEqual([]);
  });
});

describe('dropping a qualifier', () => {
  // Children MERGE (verified live), so omitting the qualifier field would leave the old value
  // server-side while the derived externalId said there was none — the two would drift.
  it('explicitly clears the qualifier field rather than omitting it', () => {
    const plan = linksToAttributes(
      sub(group('PBX', 1, { Domain: 'acme.12345.service', Site: 'Downtown' })),
      [{ ns: 'NS', value: 'acme.12345.service' }],
      MAPPING,
    );
    expect(plan.updated).toHaveLength(1);

    const children = plan.attributes[0]!.childAttribute as Rec[];
    const site = children.find((c) => c.key === 'Site')!;
    expect(site).toBeDefined();
    expect(site.operationType).toBe(2);
    expect(site.attributeValuesInfo.associateValues[0].value).toBe('Downtown');
  });

  it('does not emit a clear when there was no qualifier to begin with', () => {
    const plan = linksToAttributes(
      sub(group('PBX', 1, { Domain: 'acme.12345.service' })),
      [{ ns: 'NS', value: 'acme.12345.service' }],
      MAPPING,
    );
    // Already correct, so the instance is left exactly as it was read — no rewrite, no marker.
    expect(plan.unchanged).toHaveLength(1);
    expect(plan.updated).toEqual([]);
    const children = plan.attributes[0]!.childAttribute as Rec[];
    expect(children.some((c) => c.operationType !== undefined)).toBe(false);
  });

  it('does not emit a clear on a brand-new instance', () => {
    const plan = linksToAttributes(sub(), [{ ns: 'NS', value: 'acme.12345.service' }], MAPPING);
    const children = plan.attributes[0]!.childAttribute as Rec[];
    expect(children.map((c) => c.key)).toEqual(['Domain']);
  });

  it('does not clear when the namespace has no qualifier field at all', () => {
    const plan = linksToAttributes(
      sub(group('PSA', 1, { ID: '4471' })),
      [{ ns: 'AT', value: '4471' }],
      MAPPING,
    );
    expect(plan.unchanged).toHaveLength(1);
  });
});
