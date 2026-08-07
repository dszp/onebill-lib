import { describe, expect, it } from 'vitest';
import {
  buildLinkIndex,
  findByAccount,
  findByTarget,
  findByValue,
  targetKey,
} from './linkIndex.js';
import type { Subscriber } from './model.js';

const PBX = 'PBX';
const CRM = 'CRM';

function sub(accountNumber: string, externalId?: string, accountName?: string): Subscriber {
  return { accountNumber, externalId, accountName };
}

describe('targetKey', () => {
  it('distinguishes a bare value from a qualified one', () => {
    expect(targetKey('acme.12345.service')).not.toBe(targetKey('acme.12345.service', 'Downtown'));
  });
});

describe('buildLinkIndex', () => {
  it('indexes a simple one-to-one link', () => {
    const index = buildLinkIndex([sub('CLI00001', 'PBX:acme.12345.service')], { ns: PBX });

    expect(findByTarget(index, 'acme.12345.service')).toEqual([
      {
        accountNumber: 'CLI00001',
        accountName: undefined,
        link: { ns: PBX, value: 'acme.12345.service' },
      },
    ]);
    expect(findByAccount(index, 'CLI00001')).toHaveLength(1);
    expect(index.conflicts).toEqual([]);
  });

  it('ignores links in other namespaces', () => {
    const index = buildLinkIndex([sub('CLI00001', 'CRM:4471|PBX:acme.12345.service')], { ns: PBX });
    expect(findByAccount(index, 'CLI00001')).toEqual([{ ns: PBX, value: 'acme.12345.service' }]);

    const crmIndex = buildLinkIndex([sub('CLI00001', 'CRM:4471|PBX:acme.12345.service')], { ns: CRM });
    expect(findByAccount(crmIndex, 'CLI00001')).toEqual([{ ns: CRM, value: '4471' }]);
  });

  it('maps one subscriber to several targets', () => {
    const index = buildLinkIndex(
      [sub('CLI00001', 'PBX:acme.12345.service|PBX:other.12345.service')],
      { ns: PBX },
    );
    expect(findByAccount(index, 'CLI00001')).toHaveLength(2);
    expect(findByTarget(index, 'other.12345.service')).toHaveLength(1);
  });

  it('maps one value to several subscribers split by qualifier', () => {
    // The site-billed-separately case: two accounts, one domain, distinct sub-units.
    const index = buildLinkIndex(
      [
        sub('CLI00001', 'PBX:acme.12345.service/Downtown'),
        sub('CLI00002', 'PBX:acme.12345.service/Airport'),
      ],
      { ns: PBX },
    );

    expect(findByValue(index, 'acme.12345.service')).toHaveLength(2);
    expect(findByTarget(index, 'acme.12345.service', 'Downtown')).toHaveLength(1);
    expect(findByTarget(index, 'acme.12345.service', 'Airport')).toHaveLength(1);
    // Not a conflict: they are different targets.
    expect(index.conflicts).toEqual([]);
  });

  it('does not match a qualified link when asked for the bare value', () => {
    const index = buildLinkIndex([sub('CLI00001', 'PBX:acme.12345.service/Downtown')], { ns: PBX });
    expect(findByTarget(index, 'acme.12345.service')).toEqual([]);
    expect(findByValue(index, 'acme.12345.service')).toHaveLength(1);
  });

  it('reports a genuine conflict instead of picking a winner', () => {
    const index = buildLinkIndex(
      [sub('CLI00001', 'PBX:acme.12345.service'), sub('CLI00002', 'PBX:acme.12345.service')],
      { ns: PBX },
    );

    expect(index.conflicts).toHaveLength(1);
    expect(index.conflicts[0]!.accountNumbers).toEqual(['CLI00001', 'CLI00002']);
    expect(index.conflicts[0]!.value).toBe('acme.12345.service');
    // Both are still reachable — nothing was dropped.
    expect(findByTarget(index, 'acme.12345.service')).toHaveLength(2);
  });

  it('lists subscribers with no link in this namespace', () => {
    const index = buildLinkIndex(
      [sub('CLI00001', 'PBX:acme.12345.service'), sub('CLI00002', ''), sub('CLI00003'), sub('CLI00004', 'CRM:4471')],
      { ns: PBX },
    );
    expect(index.unlinked).toEqual(['CLI00002', 'CLI00003', 'CLI00004']);
  });

  it('records the continuation marker', () => {
    const index = buildLinkIndex([sub('CLI00001', 'PBX:acme.12345.service|+2')], { ns: PBX });
    expect(index.withContinuation).toEqual([{ accountNumber: 'CLI00001', count: 2 }]);
  });

  it('reports unparseable tokens as problems without losing the good links', () => {
    const index = buildLinkIndex([sub('CLI00001', 'PBX:acme.12345.service|hand typed note')], {
      ns: PBX,
    });
    expect(index.problems).toHaveLength(1);
    expect(index.problems[0]!.issues.join(' ')).toContain('not a recognizable link');
    expect(findByAccount(index, 'CLI00001')).toHaveLength(1);
  });

  it('validates against a supplied registry', () => {
    const registry = [{ ns: PBX, label: 'Example PBX' }];
    const index = buildLinkIndex([sub('CLI00001', 'PBX:acme.12345.service|XYZ:9')], {
      ns: PBX,
      registry,
    });
    expect(index.problems[0]!.issues.join(' ')).toContain('not in the registry');
  });

  it('reports no registry problems when none is supplied', () => {
    const index = buildLinkIndex([sub('CLI00001', 'PBX:acme.12345.service|XYZ:9')], { ns: PBX });
    expect(index.problems).toEqual([]);
  });

  it('carries the account name through for display', () => {
    const index = buildLinkIndex([sub('CLI00001', 'PBX:acme.12345.service', 'Acme Division 1')], {
      ns: PBX,
    });
    expect(findByTarget(index, 'acme.12345.service')[0]!.accountName).toBe('Acme Division 1');
  });

  it('returns empty results for an unknown lookup rather than undefined', () => {
    const index = buildLinkIndex([], { ns: PBX });
    expect(findByTarget(index, 'nope')).toEqual([]);
    expect(findByValue(index, 'nope')).toEqual([]);
    expect(findByAccount(index, 'nope')).toEqual([]);
  });

  it('handles an empty subscriber list', () => {
    const index = buildLinkIndex([], { ns: PBX });
    expect(index.unlinked).toEqual([]);
    expect(index.conflicts).toEqual([]);
    expect(index.byTarget.size).toBe(0);
  });
});
