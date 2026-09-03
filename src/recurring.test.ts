import { describe, expect, it } from 'vitest';
import { compareRecurring, type BaselineEntry, type RecurringRule } from './recurring.js';
import type { Subscription } from './model.js';

/** A fictional inventory tree — the same shape `countDomainInventory` produces, kept literal here so
 *  this library's tests never import the NetSapiens one. */
const inventory = {
  extensions: { total: 12, byScope: { 'Basic User': 10 }, byServiceCode: { '': 4, premium: 8 }, byDeviceCount: { '0': 1, '1': 9, '2': 1, '3+': 1 } },
  systemUsers: { total: 3, byServiceCode: { 'system-aa': 3 } },
  transcriptionEnabled: 5,
  dids: { total: 14, tollFree: 2, local: 12 },
  e911Addresses: 1,
  smsNumbers: 0,
  devices: { total: 13, byModel: { 'Model A': 13 } },
};

const rec = (name: string, quantity: string, type = 'REC', extra: Record<string, unknown> = {}): Subscription => ({
  subscriptionId: `SUB${name.length}`,
  subscriptionOffer: [{ name, quantity, status: 1, subscriptionCharge: [{ type }], ...extra }],
});

const rules: RecurringRule[] = [
  { offer: 'Seat Tier One', counts: 'extensions.total', group: 'seats' },
  { offer: 'Seat Tier Two', counts: 'extensions.total', group: 'seats' },
  { offer: 'Seat Tier Three', counts: 'extensions.total', group: 'seats' },
  { offer: 'Transcription Add-on', counts: 'transcriptionEnabled' },
  { offer: 'Emergency Location', counts: 'e911Addresses', alsoCounts: { 'dids.total': 1 } },
  { offer: 'Single Number', counts: 'dids.total', group: 'numbers' },
  { offer: 'Number Pack', counts: 'dids.total', group: 'numbers', perUnit: 10 },
];

const rowFor = (out: ReturnType<typeof compareRecurring>, group: string) =>
  out.rows.find((r) => r.group === group)!;

describe('compareRecurring', () => {
  it('sums three offers into one group', () => {
    const out = compareRecurring({ subscriptions: [rec('Seat Tier One', '4'), rec('Seat Tier Two', '6'), rec('Seat Tier Three', '2')], inventory, rules });
    expect(rowFor(out, 'seats').billed).toBe(12);
  });

  it('reads observed from the dotted path', () => {
    const out = compareRecurring({ subscriptions: [rec('Seat Tier One', '12')], inventory, rules });
    expect(rowFor(out, 'seats').observed).toBe(12);
  });

  it('names the dimension on the row', () => {
    const out = compareRecurring({ subscriptions: [rec('Seat Tier One', '12')], inventory, rules });
    expect(rowFor(out, 'seats').dimension).toBe('extensions.total');
  });

  it('verdicts match when billed equals observed', () => {
    const out = compareRecurring({ subscriptions: [rec('Seat Tier One', '12')], inventory, rules });
    expect(rowFor(out, 'seats').verdict).toBe('match');
  });

  it('verdicts unbaselined when they differ and no baseline exists', () => {
    const out = compareRecurring({ subscriptions: [rec('Seat Tier One', '10')], inventory, rules });
    expect(rowFor(out, 'seats').verdict).toBe('unbaselined');
  });

  it('verdicts accepted when observed equals the baseline accepted count', () => {
    const baselines: BaselineEntry[] = [{ group: 'seats', billed: 10, observed: 12, accepted: 12, decidedAt: '2026-01-01T00:00:00.000Z', decidedBy: 'ops@example.com' }];
    const out = compareRecurring({ subscriptions: [rec('Seat Tier One', '10')], inventory, rules, baselines });
    expect(rowFor(out, 'seats').verdict).toBe('accepted');
  });

  it('verdicts drift when observed moved away from the accepted count', () => {
    const baselines: BaselineEntry[] = [{ group: 'seats', billed: 10, observed: 11, accepted: 11, decidedAt: '2026-01-01T00:00:00.000Z', decidedBy: 'ops@example.com' }];
    const out = compareRecurring({ subscriptions: [rec('Seat Tier One', '10')], inventory, rules, baselines });
    expect(rowFor(out, 'seats').verdict).toBe('drift');
  });

  it('echoes the baseline so a drift row can show what moved', () => {
    const baselines: BaselineEntry[] = [{ group: 'seats', billed: 10, observed: 11, accepted: 11, decidedAt: '2026-01-01T00:00:00.000Z', decidedBy: 'ops@example.com' }];
    const out = compareRecurring({ subscriptions: [rec('Seat Tier One', '10')], inventory, rules, baselines });
    expect(rowFor(out, 'seats').baseline?.observed).toBe(11);
  });

  it('reports match, not accepted, when billed already equals observed', () => {
    const baselines: BaselineEntry[] = [{ group: 'seats', billed: 10, observed: 11, accepted: 11, decidedAt: '2026-01-01T00:00:00.000Z', decidedBy: 'ops@example.com' }];
    const out = compareRecurring({ subscriptions: [rec('Seat Tier One', '12')], inventory, rules, baselines });
    expect(rowFor(out, 'seats').verdict).toBe('match');
  });

  it('multiplies quantity by perUnit for a pack', () => {
    const out = compareRecurring({ subscriptions: [rec('Number Pack', '1')], inventory, rules });
    expect(rowFor(out, 'numbers').billed).toBe(10);
  });

  it('treats an explicit zero quantity as zero, not the absent-quantity default of one', () => {
    const out = compareRecurring({ subscriptions: [rec('Seat Tier One', '0.0000000000')], inventory, rules });
    expect(rowFor(out, 'seats').billed).toBe(0);
  });

  it('adds a singles line to the same group as the pack', () => {
    const out = compareRecurring({ subscriptions: [rec('Number Pack', '1'), rec('Single Number', '3')], inventory, rules });
    expect(rowFor(out, 'numbers').billed).toBe(13);
  });

  it('credits an alsoCounts contribution to the group holding that dimension', () => {
    const out = compareRecurring({ subscriptions: [rec('Number Pack', '1'), rec('Single Number', '3'), rec('Emergency Location', '1')], inventory, rules });
    expect(rowFor(out, 'numbers').billed).toBe(14);
  });

  it('still counts the alsoCounts offer in its own group', () => {
    const out = compareRecurring({ subscriptions: [rec('Emergency Location', '1')], inventory, rules });
    expect(rowFor(out, 'Emergency Location').billed).toBe(1);
  });

  it('credits an alsoCounts contribution to every group sharing that dimension', () => {
    const twoGroupRules: RecurringRule[] = [
      { offer: 'Single Number', counts: 'dids.total', group: 'numbers' },
      { offer: 'Toll-Free Number', counts: 'dids.total', group: 'tollfree' },
      { offer: 'Emergency Location', counts: 'e911Addresses', alsoCounts: { 'dids.total': 1 } },
    ];
    const out = compareRecurring({
      subscriptions: [rec('Single Number', '3'), rec('Toll-Free Number', '1'), rec('Emergency Location', '1')],
      inventory,
      rules: twoGroupRules,
    });
    expect(rowFor(out, 'numbers').billed).toBe(4);
    expect(rowFor(out, 'tollfree').billed).toBe(2);
  });

  it('drops an alsoCounts contribution when no rule counts toward that dimension', () => {
    const unmatchedAlsoCounts: RecurringRule[] = [
      { offer: 'Emergency Location', counts: 'e911Addresses', alsoCounts: { 'dids.total': 1 } },
    ];
    const out = compareRecurring({ subscriptions: [rec('Emergency Location', '1')], inventory, rules: unmatchedAlsoCounts });
    expect(rowFor(out, 'Emergency Location').billed).toBe(1);
    expect(out.rows.length).toBe(1);
  });

  it('matches offer names case-insensitively after trim', () => {
    const out = compareRecurring({ subscriptions: [rec('  seat TIER one  ', '12')], inventory, rules });
    expect(rowFor(out, 'seats').billed).toBe(12);
  });

  it('defaults the group to the offer name', () => {
    const out = compareRecurring({ subscriptions: [rec('Transcription Add-on', '5')], inventory, rules });
    expect(rowFor(out, 'Transcription Add-on').observed).toBe(5);
  });

  it('excludes a ONE_TIME offer', () => {
    const out = compareRecurring({ subscriptions: [rec('Seat Tier One', '4', 'ONE_TIME')], inventory, rules });
    expect(rowFor(out, 'seats').billed).toBe(0);
  });

  it('excludes a USAGE offer', () => {
    const out = compareRecurring({ subscriptions: [rec('Seat Tier One', '4', 'USAGE')], inventory, rules });
    expect(rowFor(out, 'seats').billed).toBe(0);
  });

  it('excludes an offer whose activation window has ended', () => {
    const ended = rec('Seat Tier One', '4', 'REC', { activationEndDate: '2020-01-01' });
    const out = compareRecurring({ subscriptions: [ended], inventory, rules, now: new Date('2026-09-03T00:00:00Z') });
    expect(rowFor(out, 'seats').billed).toBe(0);
  });

  it('excludes an offer whose activation window has not begun', () => {
    const future = rec('Seat Tier One', '4', 'REC', { activationStartDate: '2099-01-01' });
    const out = compareRecurring({ subscriptions: [future], inventory, rules, now: new Date('2026-09-03T00:00:00Z') });
    expect(rowFor(out, 'seats').billed).toBe(0);
  });

  it('intersects the subscription window with the offer window', () => {
    const sub: Subscription = { subscriptionId: 'SUB1', activationEndDate: '2020-01-01', subscriptionOffer: [{ name: 'Seat Tier One', quantity: '4', subscriptionCharge: [{ type: 'REC' }] }] };
    const out = compareRecurring({ subscriptions: [sub], inventory, rules, now: new Date('2026-09-03T00:00:00Z') });
    expect(rowFor(out, 'seats').billed).toBe(0);
  });

  it('lists an active REC offer with no rule as unmapped', () => {
    const out = compareRecurring({ subscriptions: [rec('Something Unbudgeted', '2')], inventory, rules });
    expect(out.unmapped.map((u) => u.name)).toEqual(['Something Unbudgeted']);
  });

  it('carries the unmapped offer quantity', () => {
    const out = compareRecurring({ subscriptions: [rec('Something Unbudgeted', '2')], inventory, rules });
    expect(out.unmapped[0]!.quantity).toBe(2);
  });

  it('does not list an inactive unmapped offer', () => {
    const out = compareRecurring({ subscriptions: [rec('Something Unbudgeted', '2', 'REC', { activationEndDate: '2020-01-01' })], inventory, rules, now: new Date('2026-09-03T00:00:00Z') });
    expect(out.unmapped).toEqual([]);
  });

  it('does not list a ONE_TIME offer as unmapped', () => {
    const out = compareRecurring({ subscriptions: [rec('Setup Fee', '1', 'ONE_TIME')], inventory, rules });
    expect(out.unmapped).toEqual([]);
  });

  it('emits a row for a rule with no matching subscription, so a dropped line is visible', () => {
    const out = compareRecurring({ subscriptions: [], inventory, rules });
    expect(rowFor(out, 'seats').billed).toBe(0);
  });

  it('names the offers that made up a row', () => {
    const out = compareRecurring({ subscriptions: [rec('Number Pack', '1')], inventory, rules });
    expect(rowFor(out, 'numbers').offers.map((o) => ({ name: o.name, quantity: o.quantity, perUnit: o.perUnit }))).toEqual([{ name: 'Number Pack', quantity: 1, perUnit: 10 }]);
  });

  it('counts every subscription it looked at', () => {
    const out = compareRecurring({ subscriptions: [rec('Seat Tier One', '1'), rec('Setup Fee', '1', 'ONE_TIME')], inventory, rules });
    expect(out.examined).toBe(2);
  });

  it('reports observed 0 for a dimension the inventory does not carry', () => {
    const out = compareRecurring({ subscriptions: [rec('Seat Tier One', '1')], inventory: {}, rules });
    expect(rowFor(out, 'seats').observed).toBe(0);
  });

  it('flags a dimension the inventory does not carry, rather than reporting a silent zero', () => {
    const out = compareRecurring({ subscriptions: [rec('Seat Tier One', '1')], inventory: {}, rules });
    expect(rowFor(out, 'seats').observedMissing).toBe(true);
  });

  it('with no rules at all, every active REC offer is unmapped', () => {
    const out = compareRecurring({ subscriptions: [rec('Seat Tier One', '4')], inventory, rules: [] });
    expect(out.unmapped.map((u) => u.name)).toEqual(['Seat Tier One']);
  });

  it('with no rules at all, there are no rows', () => {
    const out = compareRecurring({ subscriptions: [rec('Seat Tier One', '4')], inventory, rules: [] });
    expect(out.rows).toEqual([]);
  });
});
