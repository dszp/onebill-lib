import { describe, expect, it } from 'vitest';
import type { Link } from './link.js';
import type { Subscription } from './model.js';
import {
  bySeverity,
  findUsageSubscriptions,
  proposeMappings,
  reconcileUsageSubscriptions,
  type UsageReconcileRow,
} from './usage.js';

/** The spec under test throughout. Fictional, as everything published here must be. */
const SPEC = { offerNames: ['Domain Usage'] };

/** Build a subscription with a usage offer. */
function usageSub(identifier: string, over: Partial<Subscription> = {}, offer: any = {}): Subscription {
  return {
    subscriptionId: `SUB-${identifier}`,
    subscriptionIdentifier: identifier,
    subscriptionOffer: [{ name: 'Domain Usage', status: 1002, ...offer }],
    ...over,
  };
}

/** Build a subscription that should never match. */
function otherSub(identifier: string): Subscription {
  return {
    subscriptionIdentifier: identifier,
    subscriptionOffer: [{ name: 'Seat License' }],
  };
}

const link = (value: string, qualifier?: string): Link =>
  qualifier === undefined ? { ns: 'PBX', value } : { ns: 'PBX', value, qualifier };

const NOW = new Date('2026-06-01T00:00:00Z');

describe('findUsageSubscriptions', () => {
  it('matches on offer name, case- and whitespace-insensitively', () => {
    const subs = [usageSub('acme.12345.service', {}, { name: '  domain usage  ' })];
    const { matched } = findUsageSubscriptions(subs, SPEC, { now: NOW });
    expect(matched).toHaveLength(1);
    expect(matched[0]!.identifier).toBe('acme.12345.service');
  });

  it('returns only matches, never every identifier — this is not a lookup path', () => {
    const subs = [otherSub('SUB00001-SEAT'), usageSub('acme.12345.service'), otherSub('SUB00002-DID')];
    const { matched, examined } = findUsageSubscriptions(subs, SPEC, { now: NOW });
    expect(matched.map((m) => m.identifier)).toEqual(['acme.12345.service']);
    expect(examined).toBe(3);
  });

  it('counts every subscription examined, so a renamed product is detectable', () => {
    // The rename failure mode: the spec no longer matches anything, but the data is fine. A caller
    // seeing matched 0 of 9 on EVERY account can conclude the spec is stale, not the tenant broken.
    const subs = Array.from({ length: 9 }, (_, i) => otherSub(`SUB0000${i}`));
    const { matched, examined } = findUsageSubscriptions(subs, SPEC, { now: NOW });
    expect(matched).toHaveLength(0);
    expect(examined).toBe(9);
  });

  it('supports a predicate, OR-ed with the names', () => {
    const subs = [otherSub('SPECIAL-1')];
    const { matched } = findUsageSubscriptions(
      subs,
      { offerNames: ['Domain Usage'], match: (s) => s.subscriptionIdentifier === 'SPECIAL-1' },
      { now: NOW },
    );
    expect(matched).toHaveLength(1);
  });

  it('skips a match with no identifier — it carries no information', () => {
    const subs = [usageSub(''), usageSub('   ')];
    const { matched, examined } = findUsageSubscriptions(subs, SPEC, { now: NOW });
    expect(matched).toHaveLength(0);
    expect(examined).toBe(2);
  });

  it('is active with no window at all', () => {
    const { matched } = findUsageSubscriptions([usageSub('acme.12345.service')], SPEC, { now: NOW });
    expect(matched[0]!.active).toBe(true);
    expect(matched[0]!.inactiveReason).toBeUndefined();
  });

  it('is inactive before the window opens, and active once it has', () => {
    const sub = usageSub('acme.12345.service', { activationStartDate: '2026-07-01T00:00:00Z' });
    expect(findUsageSubscriptions([sub], SPEC, { now: NOW }).matched[0]!.active).toBe(false);
    expect(
      findUsageSubscriptions([sub], SPEC, { now: new Date('2026-07-02T00:00:00Z') }).matched[0]!.active,
    ).toBe(true);
  });

  it('is inactive once the window closes', () => {
    const sub = usageSub('acme.12345.service', { activationEndDate: '2026-05-01T00:00:00Z' });
    const m = findUsageSubscriptions([sub], SPEC, { now: NOW }).matched[0]!;
    expect(m.active).toBe(false);
    expect(m.inactiveReason).toMatch(/ended/);
  });

  it('intersects disagreeing subscription-level and offer-level windows', () => {
    // Subscription says open, the offer says not yet. The conservative reading wins: a false
    // "active" would hide a real billing failure, a false "inactive" is merely a visible alarm.
    const sub = usageSub(
      'acme.12345.service',
      { activationStartDate: '2020-01-01T00:00:00Z' },
      { activationStartDate: '2026-07-01T00:00:00Z' },
    );
    expect(findUsageSubscriptions([sub], SPEC, { now: NOW }).matched[0]!.active).toBe(false);
  });

  it('intersects on the end date too', () => {
    const sub = usageSub(
      'acme.12345.service',
      { activationEndDate: '2030-01-01T00:00:00Z' },
      { activationEndDate: '2026-05-01T00:00:00Z' },
    );
    expect(findUsageSubscriptions([sub], SPEC, { now: NOW }).matched[0]!.active).toBe(false);
  });

  it('carries state and offer status through raw, interpreting neither', () => {
    const sub = usageSub('acme.12345.service', { state: 'ACTIVE' }, { status: 1002 });
    const m = findUsageSubscriptions([sub], SPEC, { now: NOW }).matched[0]!;
    expect(m.state).toBe('ACTIVE');
    expect(m.offerStatus).toBe(1002);
  });

  it('ignores an unparseable date rather than treating it as a boundary', () => {
    const sub = usageSub('acme.12345.service', { activationStartDate: 'not a date' });
    expect(findUsageSubscriptions([sub], SPEC, { now: NOW }).matched[0]!.active).toBe(true);
  });
});

describe('reconcileUsageSubscriptions — the verdict table', () => {
  const run = (rows: UsageReconcileRow[]) =>
    reconcileUsageSubscriptions(rows, { spec: SPEC, now: NOW });

  const row = (over: Partial<UsageReconcileRow>): UsageReconcileRow => ({
    accountNumber: 'CLI00000',
    links: [],
    subscriptions: [],
    ...over,
  });

  it('ok — one active match agreeing with one link', () => {
    const [r] = run([
      row({ links: [link('acme.12345.service')], subscriptions: [usageSub('acme.12345.service')] }),
    ]);
    expect(r!.verdict).toBe('ok');
    expect(r!.findings).toEqual([]);
  });

  it('ok — ignoring case differences between the two systems', () => {
    const [r] = run([
      row({ links: [link('Acme.12345.Service')], subscriptions: [usageSub('acme.12345.service')] }),
    ]);
    expect(r!.verdict).toBe('ok');
  });

  it('missing — linked, but nothing matched, so usage is not flowing', () => {
    const [r] = run([row({ links: [link('acme.12345.service')], subscriptions: [otherSub('X')] })]);
    expect(r!.verdict).toBe('missing');
    expect(r!.findings[0]).toBe(
      'Linked to "acme.12345.service", but no "Domain Usage" subscription on this account has ' +
        'that as its identifier, so usage is not flowing.',
    );
  });

  it('none — nothing linked and nothing matched', () => {
    const [r] = run([row({})]);
    expect(r!.verdict).toBe('none');
    expect(r!.findings).toEqual([]);
  });

  it('inactive — matched, but outside its window', () => {
    const [r] = run([
      row({
        links: [link('acme.12345.service')],
        subscriptions: [usageSub('acme.12345.service', { activationEndDate: '2020-01-01T00:00:00Z' })],
      }),
    ]);
    expect(r!.verdict).toBe('inactive');
    // Says WHAT matched — the offer, the identifier, and that it is the linked one — as a day.
    expect(r!.findings).toEqual([
      'A "Domain Usage" subscription carries the identifier "acme.12345.service" (the linked target), ' +
        'but it is not active (ended 2020-01-01).',
    ]);
  });

  it('ambiguous — two active matches, and it does not pick one', () => {
    const [r] = run([
      row({
        links: [link('acme.12345.service')],
        subscriptions: [usageSub('acme.12345.service'), usageSub('other.67890.service')],
      }),
    ]);
    expect(r!.verdict).toBe('ambiguous');
    expect(r!.findings[0]).toMatch(/Not resolved here/);
  });

  it('unlinked — a usage subscription exists but no link does (the seed case)', () => {
    const [r] = run([row({ subscriptions: [usageSub('acme.12345.service')] })]);
    expect(r!.verdict).toBe('unlinked');
  });

  it('mismatch — active match disagrees with an existing link', () => {
    const [r] = run([
      row({ links: [link('wrong.11111.service')], subscriptions: [usageSub('acme.12345.service')] }),
    ]);
    expect(r!.verdict).toBe('mismatch');
    expect(r!.findings[0]).toMatch(/links say wrong\.11111\.service/);
  });

  it('extra — a multi-target account is NOT reported as a mismatch', () => {
    // The noise test. An account billed for two domains with one usage subscription is expected;
    // calling it a mismatch trains a reseller to ignore the whole report.
    const [r] = run([
      row({
        links: [link('acme.12345.service'), link('second.67890.service')],
        subscriptions: [usageSub('acme.12345.service')],
      }),
    ]);
    expect(r!.verdict).toBe('extra');
    expect(r!.findings[0]).toMatch(/no usage subscription covers: second\.67890\.service/);
  });

  it('reports an inactive extra match alongside the main verdict', () => {
    const [r] = run([
      row({
        links: [link('acme.12345.service')],
        subscriptions: [
          usageSub('acme.12345.service'),
          usageSub('old.99999.service', { activationEndDate: '2020-01-01T00:00:00Z' }),
        ],
      }),
    ]);
    expect(r!.verdict).toBe('ok');
    expect(r!.findings).toEqual([
      'A "Domain Usage" subscription carries the identifier "old.99999.service", but it is not active (ended 2020-01-01).',
    ]);
  });

  it('surfaces examined so a renamed product is visible per account', () => {
    const [r] = run([row({ subscriptions: [otherSub('A'), otherSub('B')] })]);
    expect(r!.examined).toBe(2);
    expect(r!.matches).toEqual([]);
  });

  it('sorts worst-first', () => {
    const sorted = run([
      row({ accountNumber: 'A', links: [link('a.1.service')], subscriptions: [usageSub('a.1.service')] }),
      row({ accountNumber: 'B', links: [link('b.1.service')], subscriptions: [otherSub('X')] }),
      row({ accountNumber: 'C', links: [link('x.1.service')], subscriptions: [usageSub('c.1.service')] }),
    ]).sort(bySeverity);
    expect(sorted.map((r) => r.verdict)).toEqual(['mismatch', 'missing', 'ok']);
  });
});

describe('proposeMappings', () => {
  const reconcile = (rows: UsageReconcileRow[]) =>
    reconcileUsageSubscriptions(rows, { spec: SPEC, now: NOW });

  const unlinked = (accountNumber: string, identifier: string): UsageReconcileRow => ({
    accountNumber,
    links: [],
    subscriptions: [usageSub(identifier)],
  });

  it('proposes for unlinked accounts', () => {
    const p = proposeMappings(reconcile([unlinked('CLI00000', 'acme.12345.service')]), { ns: 'PBX' });
    expect(p.candidates).toHaveLength(1);
    expect(p.candidates[0]).toMatchObject({
      accountNumber: 'CLI00000',
      ns: 'PBX',
      value: 'acme.12345.service',
      confidence: 'unverified',
    });
  });

  it('marks a value exact when it matches the authoritative list verbatim', () => {
    const p = proposeMappings(reconcile([unlinked('CLI00000', 'acme.12345.service')]), {
      ns: 'PBX',
      knownTargets: ['acme.12345.service'],
    });
    expect(p.candidates[0]!.confidence).toBe('exact');
  });

  it('canonicalizes toward the authoritative spelling, not the billing record', () => {
    // The case-sensitivity trap: one system preserves case, the other does not. Writing the
    // billing record's spelling would reintroduce it.
    const p = proposeMappings(reconcile([unlinked('CLI00000', 'ACME.12345.Service')]), {
      ns: 'PBX',
      knownTargets: ['acme.12345.service'],
    });
    expect(p.candidates[0]).toMatchObject({
      confidence: 'canonicalized',
      value: 'acme.12345.service',
      rawValue: 'ACME.12345.Service',
    });
    expect(p.candidates[0]!.notes[0]).toMatch(/Adopting the authoritative spelling/);
  });

  it('flags an identifier that matches nothing as unknown — the typo guard', () => {
    const p = proposeMappings(reconcile([unlinked('CLI00000', 'acme.12345.servce')]), {
      ns: 'PBX',
      knownTargets: ['acme.12345.service'],
    });
    expect(p.candidates[0]!.confidence).toBe('unknown');
    expect(p.candidates[0]!.notes[0]).toMatch(/likely a typo/);
  });

  it('reports two accounts claiming one target, and resolves neither', () => {
    const p = proposeMappings(
      reconcile([unlinked('CLI00000', 'acme.12345.service'), unlinked('CLI00001', 'acme.12345.service')]),
      { ns: 'PBX' },
    );
    expect(p.conflicts).toHaveLength(1);
    expect(p.conflicts[0]!.accountNumbers).toEqual(['CLI00000', 'CLI00001']);
    expect(p.candidates).toHaveLength(2);
  });

  it('skips accounts that are already correct, with a reason', () => {
    const recs = reconcile([
      { accountNumber: 'CLI00000', links: [link('acme.12345.service')], subscriptions: [usageSub('acme.12345.service')] },
    ]);
    const p = proposeMappings(recs, { ns: 'PBX' });
    expect(p.candidates).toEqual([]);
    expect(p.skipped).toEqual([{ accountNumber: 'CLI00000', reason: 'already linked and agreeing' }]);
  });

  it('does not propose over a mismatch unless asked', () => {
    const recs = reconcile([
      { accountNumber: 'CLI00000', links: [link('wrong.1.service')], subscriptions: [usageSub('acme.12345.service')] },
    ]);
    expect(proposeMappings(recs, { ns: 'PBX' }).candidates).toEqual([]);
    expect(proposeMappings(recs, { ns: 'PBX' }).skipped[0]!.reason).toMatch(/includeMismatches/);
  });

  it('proposes a correction, naming what it would replace, when asked', () => {
    const recs = reconcile([
      { accountNumber: 'CLI00000', links: [link('wrong.1.service')], subscriptions: [usageSub('acme.12345.service')] },
    ]);
    const p = proposeMappings(recs, { ns: 'PBX', includeMismatches: true });
    expect(p.candidates[0]).toMatchObject({
      value: 'acme.12345.service',
      replaces: ['wrong.1.service'],
    });
  });

  it('is re-runnable: a second pass after applying proposes nothing new', () => {
    // What makes this more than a one-shot script — the same review screen serves new accounts later.
    const before = reconcile([unlinked('CLI00000', 'acme.12345.service')]);
    expect(proposeMappings(before, { ns: 'PBX' }).candidates).toHaveLength(1);

    const after = reconcile([
      { accountNumber: 'CLI00000', links: [link('acme.12345.service')], subscriptions: [usageSub('acme.12345.service')] },
      unlinked('CLI00001', 'newco.67890.service'),
    ]);
    const p = proposeMappings(after, { ns: 'PBX' });
    expect(p.candidates.map((c) => c.accountNumber)).toEqual(['CLI00001']);
  });

  it('skips a missing row rather than inventing a value for it', () => {
    const recs = reconcile([
      { accountNumber: 'CLI00000', links: [link('acme.12345.service')], subscriptions: [] },
    ]);
    const p = proposeMappings(recs, { ns: 'PBX' });
    expect(p.candidates).toEqual([]);
    expect(p.skipped[0]!.reason).toMatch(/fix this in the billing system/);
  });
});
