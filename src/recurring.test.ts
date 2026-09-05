import { describe, expect, it } from 'vitest';
import { buildCatalogIndex } from './catalog.js';
import {
  compareRecurring,
  ruleKeyOf,
  type GroupAcceptance,
  type GroupBaseline,
  type ItemAcceptance,
  type RecurringRule,
} from './recurring.js';
import type { Subscription } from './model.js';

/** A fictional inventory tree — the same shape `countDomainInventory` produces, kept literal here so
 *  this library's tests never import the NetSapiens one. */
const inventory = {
  extensions: {
    total: 12,
    byScope: { 'Basic User': 10, 'Call Center Agent': 1, 'Call Center Supervisor': 1 },
    byServiceCode: { '': 4, premium: 8 },
    byDeviceCount: { '0': 1, '1': 9, '2': 1, '3+': 1 },
  },
  systemUsers: { total: 3, byServiceCode: { 'system-aa': 3 } },
  transcriptionEnabled: 5,
  dids: { total: 14, tollFree: 2, local: 12 },
  e911Addresses: 1,
  smsNumbers: 0,
  teamsConnected: 1,
  devices: { total: 13, byModel: { 'Model A': 13 } },
};

/** The item lists behind the dimensions that have one. `devices.total` deliberately has none — an
 *  item-less dimension is the case the count model is kept for. */
const items: Record<string, { key: string; label: string }[]> = {
  'extensions.total': Array.from({ length: 12 }, (_, i) => ({ key: `ext:${100 + i}`, label: `${100 + i}` })),
  transcriptionEnabled: Array.from({ length: 5 }, (_, i) => ({ key: `ext:${100 + i}`, label: `${100 + i}` })),
  'dids.total': Array.from({ length: 14 }, (_, i) => ({ key: `did:1317555${String(i).padStart(4, '0')}`, label: `1317555${String(i).padStart(4, '0')}` })),
  e911Addresses: [{ key: 'addr:a-1', label: 'HQ' }],
  'extensions.byScope.Call Center Agent': [{ key: 'ext:110', label: '110' }],
  'extensions.byScope.Call Center Supervisor': [{ key: 'ext:111', label: '111' }],
};
const itemsFor = (p: string) => items[p];
/** Falls back to the key so a test can present an item the fixture map does not name (the swap). */
const itemLabel = (i: { key: string }) => Object.values(items).flat().find((x) => x.key === i.key)?.label ?? i.key;

const ext = (n: number): string => `ext:${n}`;
const acc = (key: string): ItemAcceptance => ({ key, label: key, decidedAt: '2026-08-01T00:00:00.000Z', decidedBy: 'ops@example.com' });
const G = (billed: number, observed: number, accepted = observed): GroupAcceptance => ({ billed, observed, accepted, decidedAt: '2026-08-01T00:00:00.000Z', decidedBy: 'ops@example.com' });
/** The twelve extensions the fixture presents, as accepted keys. */
const allSeatKeys = Array.from({ length: 12 }, (_, i) => ext(100 + i));

const rec = (name: string, quantity: string, type = 'REC', extra: Record<string, unknown> = {}): Subscription => ({
  subscriptionId: `SUB${name.length}`,
  subscriptionOffer: [{ name, quantity, status: 1, subscriptionCharge: [{ type }], ...extra }],
});

const rules: RecurringRule[] = [
  { offer: 'Seat Tier One', counts: 'extensions.total', group: 'seats' },
  { offer: 'Seat Tier Two', counts: 'extensions.total', group: 'seats' },
  { offer: 'Seat Tier Three', counts: 'extensions.total', group: 'seats' },
  { offer: 'Call Center Seat', counts: 'extensions.total', group: 'seats', alsoCounts: { callcenter: 1 } },
  { offer: 'Transcription Add-on', counts: 'transcriptionEnabled' },
  { offer: 'Emergency Location', counts: 'e911Addresses', alsoCounts: { 'dids.total': 1 } },
  { offer: 'Single Number', counts: 'dids.total', group: 'numbers' },
  { offer: 'Number Pack', counts: 'dids.total', group: 'numbers', perUnit: 10 },
  { offer: 'Device Rental', counts: 'devices.total', group: 'devices' },
  { offer: 'Fax Line', ignore: true },
  // Comparison-only: no key of its own, so its billed comes entirely from other rules' credits.
  { group: 'callcenter', counts: ['extensions.byScope.Call Center Agent', 'extensions.byScope.Call Center Supervisor'] },
];

const base = { inventory, rules, itemsFor, itemLabel };

const rowFor = (out: ReturnType<typeof compareRecurring>, group: string) =>
  out.rows.find((r) => r.group === group)!;

describe('compareRecurring v2', () => {
  // ---- match, with items listed but not consulted ----------------------------------------------
  it('verdicts match when observed equals billed, and still lists the items as unreviewed', () => {
    const out = compareRecurring({ ...base, subscriptions: [rec('Seat Tier One', '12')] });
    const row = rowFor(out, 'seats');
    expect(row.verdict).toBe('match');
    expect(row.items?.length).toBe(12);
    expect(row.unreviewed).toBe(12);
  });

  it('drifts a row whose count matches when an accepted item has vanished', () => {
    const baselines: GroupBaseline[] = [{ group: 'seats', items: [...allSeatKeys, 'ext:999'].map(acc) }];
    const out = compareRecurring({ ...base, subscriptions: [rec('Seat Tier One', '12')], baselines });
    const row = rowFor(out, 'seats');
    expect(row.observed).toBe(12);
    expect(row.billed).toBe(12);
    expect(row.verdict).toBe('drift');
    expect(row.stale).toBe(1);
    expect(row.items?.find((i) => i.key === 'ext:999')?.status).toBe('stale');
  });

  it('drifts on a pure vanish: an accepted item gone and billed unchanged below the new count', () => {
    const shrunk = allSeatKeys.slice(0, 11).map((key) => ({ key }));
    const baselines: GroupBaseline[] = [{ group: 'seats', items: allSeatKeys.map(acc), groupRow: G(10, 12, 12) }];
    const out = compareRecurring({
      ...base,
      subscriptions: [rec('Seat Tier One', '10')],
      baselines,
      itemsFor: (p) => (p === 'extensions.total' ? shrunk : items[p]),
    });
    const row = rowFor(out, 'seats');
    expect(row.observed).toBe(11);
    expect(row.unreviewed).toBe(0);
    expect(row.stale).toBe(1);
    // Without the stale rule this reads `accepted`: every present item is accepted and the group row
    // still names billed 10. The seat that disappeared is the whole fact the operator needs.
    expect(row.verdict).toBe('drift');
  });

  // ---- over-observed, nothing accepted ----------------------------------------------------------
  it('verdicts unbaselined when more items are present than are billed and none is accepted', () => {
    const out = compareRecurring({ ...base, subscriptions: [rec('Seat Tier One', '10')] });
    const row = rowFor(out, 'seats');
    expect(row.verdict).toBe('unbaselined');
    expect(row.observed).toBe(12);
    expect(row.billed).toBe(10);
    expect(row.unreviewed).toBe(12);
  });

  // ---- partial acceptance -----------------------------------------------------------------------
  it('stays unbaselined while one item is still unreviewed and no group row exists', () => {
    const baselines: GroupBaseline[] = [{ group: 'seats', items: allSeatKeys.slice(0, 11).map(acc) }];
    const out = compareRecurring({ ...base, subscriptions: [rec('Seat Tier One', '10')], baselines });
    const row = rowFor(out, 'seats');
    expect(row.verdict).toBe('unbaselined');
    expect(row.unreviewed).toBe(1);
  });

  // ---- fully accepted ---------------------------------------------------------------------------
  it('verdicts accepted when every item is accepted and the group row still names the billed count', () => {
    const baselines: GroupBaseline[] = [{ group: 'seats', items: allSeatKeys.map(acc), groupRow: G(10, 12, 12) }];
    const out = compareRecurring({ ...base, subscriptions: [rec('Seat Tier One', '10')], baselines });
    const row = rowFor(out, 'seats');
    expect(row.verdict).toBe('accepted');
    expect(row.unreviewed).toBe(0);
  });

  // ---- billed moved after a full acceptance ------------------------------------------------------
  it('verdicts drift when every item is accepted but billed has moved since the group row', () => {
    const baselines: GroupBaseline[] = [{ group: 'seats', items: allSeatKeys.map(acc), groupRow: G(10, 12, 12) }];
    const out = compareRecurring({ ...base, subscriptions: [rec('Seat Tier One', '11')], baselines });
    expect(rowFor(out, 'seats').verdict).toBe('drift');
  });

  // ---- a new item after a full acceptance --------------------------------------------------------
  it('verdicts drift when a group row exists and one new unreviewed item has appeared', () => {
    const baselines: GroupBaseline[] = [{ group: 'seats', items: allSeatKeys.slice(0, 11).map(acc), groupRow: G(10, 11, 11) }];
    const out = compareRecurring({ ...base, subscriptions: [rec('Seat Tier One', '10')], baselines });
    const row = rowFor(out, 'seats');
    expect(row.verdict).toBe('drift');
    expect(row.unreviewed).toBe(1);
  });

  // ---- the swap: count unchanged, membership changed ---------------------------------------------
  it('verdicts drift on a swap: one accepted item gone, one new item in its place, count unchanged', () => {
    const swapped = [...allSeatKeys.slice(0, 11), 'ext:200'].map((key) => ({ key }));
    const baselines: GroupBaseline[] = [{ group: 'seats', items: allSeatKeys.map(acc), groupRow: G(10, 12, 12) }];
    const out = compareRecurring({
      ...base,
      subscriptions: [rec('Seat Tier One', '10')],
      baselines,
      itemsFor: (p) => (p === 'extensions.total' ? swapped : items[p]),
    });
    const row = rowFor(out, 'seats');
    expect(row.observed).toBe(12);
    expect(row.verdict).toBe('drift');
    expect(row.stale).toBe(1);
    expect(row.unreviewed).toBe(1);
    expect(row.items?.find((i) => i.key === ext(111))?.status).toBe('stale');
    expect(row.items?.find((i) => i.key === 'ext:200')?.status).toBe('unreviewed');
  });

  // ---- shortfall: fewer items than are billed ------------------------------------------------------
  it('shortfall with no group row is unbaselined, and the items are still listed', () => {
    const out = compareRecurring({ ...base, subscriptions: [rec('Seat Tier One', '14')] });
    const row = rowFor(out, 'seats');
    expect(row.verdict).toBe('unbaselined');
    expect(row.observed).toBe(12);
    expect(row.items?.length).toBe(12);
    expect(row.unreviewed).toBe(12);
  });

  it('shortfall is accepted when the group row names both the billed count and the observed count', () => {
    const baselines: GroupBaseline[] = [{ group: 'seats', items: [], groupRow: G(14, 12, 12) }];
    const out = compareRecurring({ ...base, subscriptions: [rec('Seat Tier One', '14')], baselines });
    expect(rowFor(out, 'seats').verdict).toBe('accepted');
  });

  it('shortfall is drift when the group row was decided against a different billed count', () => {
    const baselines: GroupBaseline[] = [{ group: 'seats', items: [], groupRow: G(13, 12, 12) }];
    const out = compareRecurring({ ...base, subscriptions: [rec('Seat Tier One', '14')], baselines });
    expect(rowFor(out, 'seats').verdict).toBe('drift');
  });

  // ---- a dimension with no item list -----------------------------------------------------------------
  it('an item-less dimension carries no items and is unbaselined on a difference', () => {
    const out = compareRecurring({ ...base, subscriptions: [rec('Device Rental', '12')] });
    const row = rowFor(out, 'devices');
    expect(row.items).toBeUndefined();
    expect(row.unreviewed).toBe(0);
    expect(row.observed).toBe(13);
    expect(row.verdict).toBe('unbaselined');
  });

  it('an item-less dimension is accepted from the group row alone', () => {
    const baselines: GroupBaseline[] = [{ group: 'devices', items: [], groupRow: G(12, 13, 13) }];
    const out = compareRecurring({ ...base, subscriptions: [rec('Device Rental', '12')], baselines });
    expect(rowFor(out, 'devices').verdict).toBe('accepted');
  });

  // ---- no itemsFor at all -----------------------------------------------------------------------------
  it('with no itemsFor at all, every row is item-less and the count model applies', () => {
    const subscriptions = [rec('Seat Tier One', '10')];
    const bare = compareRecurring({ inventory, rules, subscriptions });
    expect(rowFor(bare, 'seats').items).toBeUndefined();
    expect(rowFor(bare, 'seats').verdict).toBe('unbaselined');

    const baselines: GroupBaseline[] = [{ group: 'seats', items: [], groupRow: G(10, 12, 12) }];
    const withRow = compareRecurring({ inventory, rules, subscriptions, baselines });
    expect(rowFor(withRow, 'seats').verdict).toBe('accepted');
  });

  // ---- several counts paths ----------------------------------------------------------------------------
  it('sums observed and unions items across an array of counts paths', () => {
    const out = compareRecurring({ ...base, subscriptions: [] });
    const row = rowFor(out, 'callcenter');
    expect(row.observed).toBe(2);
    expect(row.items?.length).toBe(2);
    expect(row.dimensions.length).toBe(2);
    expect(row.dimension).toBe('extensions.byScope.Call Center Agent');
  });

  it('observed is the union size, not the sum, when two counts paths share keys', () => {
    // extensions.total is ext:100..111; transcriptionEnabled is ext:100..104, wholly inside it.
    // Summing the two counts gives 17 seats that do not exist — the union is the honest number.
    const overlapping: RecurringRule[] = [
      { offer: 'Seat Tier One', counts: ['extensions.total', 'transcriptionEnabled'], group: 'both' },
    ];
    const out = compareRecurring({ ...base, rules: overlapping, subscriptions: [rec('Seat Tier One', '12')] });
    const row = rowFor(out, 'both');
    expect(row.observed).toBe(12);
    expect(row.items?.length).toBe(12);
    expect(row.items?.length).toBe(row.observed);
    expect(new Set(row.items?.map((i) => i.key)).size).toBe(12);
    expect(row.verdict).toBe('match');
  });

  // ---- a group billed only by another rule's credits -----------------------------------------------------
  it('an offer-less group takes its billed from an alsoCounts credit naming the group', () => {
    const out = compareRecurring({ ...base, subscriptions: [rec('Seat Tier One', '10'), rec('Call Center Seat', '2')] });
    expect(rowFor(out, 'callcenter').billed).toBe(2);
    expect(rowFor(out, 'callcenter').offers).toEqual([]);
    expect(rowFor(out, 'seats').billed).toBe(12);
  });

  // ---- ignore -----------------------------------------------------------------------------------------------
  it('an ignore rule takes the offer out of unmapped, into ignored, and makes no row', () => {
    const out = compareRecurring({ ...base, subscriptions: [rec('Fax Line', '1')] });
    expect(out.unmapped).toEqual([]);
    expect(out.ignored).toEqual([{ name: 'Fax Line', quantity: 1, rule: 'offer:Fax Line' }]);
    expect(out.rows.some((r) => r.group === 'Fax Line')).toBe(false);
  });

  // ---- key precedence -----------------------------------------------------------------------------------------
  const catalog = buildCatalogIndex([
    { id: '1', code: 'SEATS', name: 'Seats', pricePlanInfos: [{ id: '11', code: 'T1', name: 'Seat Tier One' }] },
  ]);
  const byProductCode: RecurringRule = { productCode: 'SEATS', counts: 'extensions.total', group: 'p' };
  const byOfferName: RecurringRule = { offer: 'Seat Tier One', counts: 'extensions.total', group: 'o' };
  const byPlanCode: RecurringRule = { planCode: 'T1', counts: 'extensions.total', group: 'c' };

  it('a plan-code rule beats both the name rule and the product-code rule', () => {
    const out = compareRecurring({ ...base, rules: [byProductCode, byOfferName, byPlanCode], catalog, subscriptions: [rec('Seat Tier One', '4')] });
    expect(rowFor(out, 'c').billed).toBe(4);
    expect(rowFor(out, 'o').billed).toBe(0);
    expect(rowFor(out, 'p').billed).toBe(0);
  });

  it('a name rule beats the product-code rule when no plan-code rule matches', () => {
    const out = compareRecurring({ ...base, rules: [byProductCode, byOfferName], catalog, subscriptions: [rec('Seat Tier One', '4')] });
    expect(rowFor(out, 'o').billed).toBe(4);
    expect(rowFor(out, 'p').billed).toBe(0);
  });

  it('a product-code rule catches a plan no other rule names', () => {
    const out = compareRecurring({ ...base, rules: [byProductCode], catalog, subscriptions: [rec('Seat Tier One', '4')] });
    expect(rowFor(out, 'p').billed).toBe(4);
  });

  // ---- a code-keyed rulebook that cannot resolve a name -----------------------------------------------------
  it('reports a catalogue miss when a code-keyed rulebook has no catalogue at all', () => {
    const out = compareRecurring({ ...base, rules: [byProductCode], subscriptions: [rec('Seat Tier One', '4')] });
    expect(out.unmapped.map((u) => u.name)).toEqual(['Seat Tier One']);
    expect(out.catalogMisses).toEqual(['Seat Tier One']);
  });

  it('reports a catalogue miss when the catalogue does not know the plan name', () => {
    const out = compareRecurring({ ...base, rules: [byPlanCode, byProductCode], catalog, subscriptions: [rec('Seat Tier Nine', '4')] });
    expect(out.unmapped.map((u) => u.name)).toEqual(['Seat Tier Nine']);
    expect(out.catalogMisses).toEqual(['Seat Tier Nine']);
  });

  it('records no catalogue miss when the rulebook is keyed only by name', () => {
    const out = compareRecurring({ ...base, subscriptions: [rec('Something Unbudgeted', '2')] });
    expect(out.catalogMisses).toEqual([]);
  });

  // ---- ruleKeyOf ---------------------------------------------------------------------------------------------
  it('ruleKeyOf renders the four rule forms', () => {
    expect(ruleKeyOf({ planCode: 'T1', counts: 'extensions.total' })).toBe('planCode:T1');
    expect(ruleKeyOf({ offer: 'Seat Tier One', counts: 'extensions.total' })).toBe('offer:Seat Tier One');
    expect(ruleKeyOf({ productCode: 'SEATS', counts: 'extensions.total' })).toBe('productCode:SEATS');
    expect(ruleKeyOf({ group: 'callcenter', counts: ['a', 'b'] })).toBe('group:callcenter');
  });

  // ---- carried over from the count-only version ----------------------------------------------------------------
  it('sums three offers into one group', () => {
    const out = compareRecurring({ ...base, subscriptions: [rec('Seat Tier One', '4'), rec('Seat Tier Two', '6'), rec('Seat Tier Three', '2')] });
    expect(rowFor(out, 'seats').billed).toBe(12);
  });

  it('reads observed from the dotted path when the dimension has no item list', () => {
    const out = compareRecurring({ ...base, subscriptions: [rec('Device Rental', '13')] });
    expect(rowFor(out, 'devices').observed).toBe(13);
  });

  it('names the first dimension on the row', () => {
    const out = compareRecurring({ ...base, subscriptions: [rec('Seat Tier One', '12')] });
    expect(rowFor(out, 'seats').dimension).toBe('extensions.total');
    expect(rowFor(out, 'seats').dimensions).toEqual(['extensions.total']);
  });

  it('echoes the group row so a drift row can show what moved', () => {
    const baselines: GroupBaseline[] = [{ group: 'seats', items: [], groupRow: G(13, 12, 12) }];
    const out = compareRecurring({ ...base, subscriptions: [rec('Seat Tier One', '14')], baselines });
    expect(rowFor(out, 'seats').groupRow?.observed).toBe(12);
  });

  it('reports match, not accepted, when billed already equals observed', () => {
    const baselines: GroupBaseline[] = [{ group: 'seats', items: [], groupRow: G(10, 11, 11) }];
    const out = compareRecurring({ ...base, subscriptions: [rec('Seat Tier One', '12')], baselines });
    expect(rowFor(out, 'seats').verdict).toBe('match');
  });

  it('multiplies quantity by perUnit for a pack', () => {
    const out = compareRecurring({ ...base, subscriptions: [rec('Number Pack', '1')] });
    expect(rowFor(out, 'numbers').billed).toBe(10);
  });

  it('treats an explicit zero quantity as zero, not the absent-quantity default of one', () => {
    const out = compareRecurring({ ...base, subscriptions: [rec('Seat Tier One', '0.0000000000')] });
    expect(rowFor(out, 'seats').billed).toBe(0);
  });

  it('adds a singles line to the same group as the pack', () => {
    const out = compareRecurring({ ...base, subscriptions: [rec('Number Pack', '1'), rec('Single Number', '3')] });
    expect(rowFor(out, 'numbers').billed).toBe(13);
  });

  it('credits an alsoCounts contribution to the group holding that dimension', () => {
    const out = compareRecurring({ ...base, subscriptions: [rec('Number Pack', '1'), rec('Single Number', '3'), rec('Emergency Location', '1')] });
    expect(rowFor(out, 'numbers').billed).toBe(14);
  });

  it('still counts the alsoCounts offer in its own group', () => {
    const out = compareRecurring({ ...base, subscriptions: [rec('Emergency Location', '1')] });
    expect(rowFor(out, 'Emergency Location').billed).toBe(1);
  });

  it('credits an alsoCounts contribution to every group sharing that dimension', () => {
    const twoGroupRules: RecurringRule[] = [
      { offer: 'Single Number', counts: 'dids.total', group: 'numbers' },
      { offer: 'Toll-Free Number', counts: 'dids.total', group: 'tollfree' },
      { offer: 'Emergency Location', counts: 'e911Addresses', alsoCounts: { 'dids.total': 1 } },
    ];
    const out = compareRecurring({
      ...base,
      rules: twoGroupRules,
      subscriptions: [rec('Single Number', '3'), rec('Toll-Free Number', '1'), rec('Emergency Location', '1')],
    });
    expect(rowFor(out, 'numbers').billed).toBe(4);
    expect(rowFor(out, 'tollfree').billed).toBe(2);
  });

  it('creates a comparison-only row for an alsoCounts credit nothing else names', () => {
    const unmatchedAlsoCounts: RecurringRule[] = [
      { offer: 'Emergency Location', counts: 'e911Addresses', alsoCounts: { 'dids.total': 1 } },
    ];
    const out = compareRecurring({ ...base, rules: unmatchedAlsoCounts, subscriptions: [rec('Emergency Location', '1')] });
    expect(rowFor(out, 'Emergency Location').billed).toBe(1);
    // v2.1: the credit is no longer dropped. Something is paying for a number, so the number gets a row.
    const created = rowFor(out, 'dids.total');
    expect(created.billed).toBe(1);
    expect(created.dimensions).toEqual(['dids.total']);
    expect(created.credits).toEqual([{ from: 'Emergency Location', kind: 'alsoCounts', quantity: 1 }]);
    expect(out.rows.length).toBe(2);
  });

  it('matches offer names case-insensitively after trim', () => {
    const out = compareRecurring({ ...base, subscriptions: [rec('  seat TIER one  ', '12')] });
    expect(rowFor(out, 'seats').billed).toBe(12);
  });

  it('defaults the group to the offer name', () => {
    const out = compareRecurring({ ...base, subscriptions: [rec('Transcription Add-on', '5')] });
    expect(rowFor(out, 'Transcription Add-on').observed).toBe(5);
  });

  it('excludes a ONE_TIME offer', () => {
    const out = compareRecurring({ ...base, subscriptions: [rec('Seat Tier One', '4', 'ONE_TIME')] });
    expect(rowFor(out, 'seats').billed).toBe(0);
  });

  it('excludes a USAGE offer', () => {
    const out = compareRecurring({ ...base, subscriptions: [rec('Seat Tier One', '4', 'USAGE')] });
    expect(rowFor(out, 'seats').billed).toBe(0);
  });

  it('excludes an offer whose activation window has ended', () => {
    const ended = rec('Seat Tier One', '4', 'REC', { activationEndDate: '2020-01-01' });
    const out = compareRecurring({ ...base, subscriptions: [ended], now: new Date('2026-09-03T00:00:00Z') });
    expect(rowFor(out, 'seats').billed).toBe(0);
  });

  it('excludes an offer whose activation window has not begun', () => {
    const future = rec('Seat Tier One', '4', 'REC', { activationStartDate: '2099-01-01' });
    const out = compareRecurring({ ...base, subscriptions: [future], now: new Date('2026-09-03T00:00:00Z') });
    expect(rowFor(out, 'seats').billed).toBe(0);
  });

  it('intersects the subscription window with the offer window', () => {
    const sub: Subscription = { subscriptionId: 'SUB1', activationEndDate: '2020-01-01', subscriptionOffer: [{ name: 'Seat Tier One', quantity: '4', subscriptionCharge: [{ type: 'REC' }] }] };
    const out = compareRecurring({ ...base, subscriptions: [sub], now: new Date('2026-09-03T00:00:00Z') });
    expect(rowFor(out, 'seats').billed).toBe(0);
  });

  it('lists an active REC offer with no rule as unmapped', () => {
    const out = compareRecurring({ ...base, subscriptions: [rec('Something Unbudgeted', '2')] });
    expect(out.unmapped.map((u) => u.name)).toEqual(['Something Unbudgeted']);
  });

  it('carries the unmapped offer quantity', () => {
    const out = compareRecurring({ ...base, subscriptions: [rec('Something Unbudgeted', '2')] });
    expect(out.unmapped[0]!.quantity).toBe(2);
  });

  it('does not list an inactive unmapped offer', () => {
    const out = compareRecurring({ ...base, subscriptions: [rec('Something Unbudgeted', '2', 'REC', { activationEndDate: '2020-01-01' })], now: new Date('2026-09-03T00:00:00Z') });
    expect(out.unmapped).toEqual([]);
  });

  it('does not list a ONE_TIME offer as unmapped', () => {
    const out = compareRecurring({ ...base, subscriptions: [rec('Setup Fee', '1', 'ONE_TIME')] });
    expect(out.unmapped).toEqual([]);
  });

  it('emits a row for a rule with no matching subscription, so a dropped line is visible', () => {
    const out = compareRecurring({ ...base, subscriptions: [] });
    expect(rowFor(out, 'seats').billed).toBe(0);
  });

  it('names the offers that made up a row', () => {
    const out = compareRecurring({ ...base, subscriptions: [rec('Number Pack', '1')] });
    expect(rowFor(out, 'numbers').offers.map((o) => ({ name: o.name, quantity: o.quantity, perUnit: o.perUnit }))).toEqual([{ name: 'Number Pack', quantity: 1, perUnit: 10 }]);
  });

  it('counts every subscription it looked at', () => {
    const out = compareRecurring({ ...base, subscriptions: [rec('Seat Tier One', '1'), rec('Setup Fee', '1', 'ONE_TIME')] });
    expect(out.examined).toBe(2);
  });

  it('reports observed 0 for an item-less dimension the inventory does not carry', () => {
    const out = compareRecurring({ ...base, inventory: {}, subscriptions: [rec('Device Rental', '1')] });
    expect(rowFor(out, 'devices').observed).toBe(0);
  });

  it('flags a dimension the inventory does not carry, rather than reporting a silent zero', () => {
    const out = compareRecurring({ ...base, inventory: {}, subscriptions: [rec('Device Rental', '1')] });
    expect(rowFor(out, 'devices').observedMissing).toBe(true);
  });

  it('with no rules at all, every active REC offer is unmapped', () => {
    const out = compareRecurring({ ...base, rules: [], subscriptions: [rec('Seat Tier One', '4')] });
    expect(out.unmapped.map((u) => u.name)).toEqual(['Seat Tier One']);
  });

  it('with no rules at all, there are no rows', () => {
    const out = compareRecurring({ ...base, rules: [], subscriptions: [rec('Seat Tier One', '4')] });
    expect(out.rows).toEqual([]);
  });
});

describe('compareRecurring entitlements (v2.1)', () => {
  /** A seat whose price includes things the customer may or may not turn on. */
  const premium: RecurringRule = {
    offer: 'Premium Hosted Phone Seat',
    counts: 'extensions.total',
    group: 'seats',
    entitles: { teamsConnected: 1, smsNumbers: 1 },
  };
  const live = (over: Record<string, number>) => ({ ...inventory, ...over });

  it('creates an optional row for an entitlement no rule counts', () => {
    const out = compareRecurring({
      ...base,
      rules: [premium],
      subscriptions: [rec('Premium Hosted Phone Seat', '1')],
      inventory: live({ teamsConnected: 0, smsNumbers: 0 }),
    });
    for (const group of ['teamsConnected', 'smsNumbers']) {
      const row = rowFor(out, group);
      expect(row.billed, group).toBe(0);
      expect(row.entitled, group).toBe(1);
      expect(row.optional, group).toBe(true);
      expect(row.dimensions, group).toEqual([group]);
      expect(row.credits, group).toEqual([{ from: 'Premium Hosted Phone Seat', kind: 'entitles', quantity: 1 }]);
      // Nothing is billed and nothing is live: an unused entitlement is not a finding.
      expect(row.verdict, group).toBe('match');
    }
  });

  it('matches an entitlement the customer is using', () => {
    const out = compareRecurring({
      ...base,
      rules: [premium],
      subscriptions: [rec('Premium Hosted Phone Seat', '1')],
      inventory: live({ teamsConnected: 1 }),
    });
    const row = rowFor(out, 'teamsConnected');
    expect(row.observed).toBe(1);
    expect(row.billed).toBe(0);
    expect(row.entitled).toBe(1);
    expect(row.verdict).toBe('match');
  });

  it('reports more of a thing than the entitlement covers', () => {
    const out = compareRecurring({
      ...base,
      rules: [premium],
      subscriptions: [rec('Premium Hosted Phone Seat', '1')],
      inventory: live({ teamsConnected: 2 }),
    });
    const row = rowFor(out, 'teamsConnected');
    expect(row.observed).toBe(2);
    expect(row.entitled).toBe(1);
    expect(row.verdict).toBe('unbaselined');
  });

  // ---- entitlement alongside a paid line ---------------------------------------------------------
  const teamsRules: RecurringRule[] = [
    { offer: 'Premium Hosted Phone Seat', counts: 'extensions.total', group: 'seats', entitles: { teamsConnected: 1 } },
    { offer: 'MS Teams Integration', counts: 'teamsConnected', group: 'teams' },
  ];
  const teamsSubs = [rec('Premium Hosted Phone Seat', '2'), rec('MS Teams Integration', '1')];

  it('lands the entitlement on the group already counting that path, and creates no second row', () => {
    const out = compareRecurring({ ...base, rules: teamsRules, subscriptions: teamsSubs, inventory: live({ teamsConnected: 3 }) });
    const row = rowFor(out, 'teams');
    expect(row.billed).toBe(1);
    expect(row.entitled).toBe(2);
    expect(row.optional).toBe(false);
    expect(row.credits).toEqual([{ from: 'Premium Hosted Phone Seat', kind: 'entitles', quantity: 2 }]);
    expect(out.rows.some((r) => r.group === 'teamsConnected')).toBe(false);
  });

  it('matches at the top of the covered range', () => {
    const out = compareRecurring({ ...base, rules: teamsRules, subscriptions: teamsSubs, inventory: live({ teamsConnected: 3 }) });
    expect(rowFor(out, 'teams').verdict).toBe('match');
  });

  it('goes over one past the covered range', () => {
    const out = compareRecurring({ ...base, rules: teamsRules, subscriptions: teamsSubs, inventory: live({ teamsConnected: 4 }) });
    expect(rowFor(out, 'teams').verdict).toBe('unbaselined');
  });

  it('shortfalls below the billed quantity — an entitlement never covers a paid line', () => {
    const out = compareRecurring({ ...base, rules: teamsRules, subscriptions: teamsSubs, inventory: live({ teamsConnected: 0 }) });
    const row = rowFor(out, 'teams');
    expect(row.observed).toBe(0);
    expect(row.billed).toBe(1);
    expect(row.entitled).toBe(2);
    expect(row.verdict).toBe('unbaselined');
  });

  // ---- alsoCounts is still a deliverable ----------------------------------------------------------
  it('an alsoCounts credit pays for its group and is named in the row credits', () => {
    const out = compareRecurring({ ...base, subscriptions: [rec('Single Number', '14')] });
    const before = rowFor(out, 'numbers');
    expect(before.billed).toBe(14);
    expect(before.observed).toBe(14);
    expect(before.verdict).toBe('match');
    expect(before.credits).toEqual([]);

    const withE911 = compareRecurring({ ...base, subscriptions: [rec('Single Number', '14'), rec('Emergency Location', '1')] });
    const row = rowFor(withE911, 'numbers');
    expect(row.billed).toBe(15);
    expect(row.entitled).toBe(0);
    expect(row.optional).toBe(false);
    expect(row.credits).toEqual([{ from: 'Emergency Location', kind: 'alsoCounts', quantity: 1 }]);
    // The E911 number is a deliverable: one fewer live than billed is a shortfall, not an unused option.
    expect(row.observed).toBe(14);
    expect(row.verdict).toBe('unbaselined');
  });

  // ---- an entitlement over a dimension that HAS items ---------------------------------------------
  /** A premium seat counted on its own dimension, entitling one extension apiece. */
  const seatPlusPremium: RecurringRule[] = [
    { offer: 'Seat Tier One', counts: 'extensions.total', group: 'seats' },
    { offer: 'Premium Hosted Phone Seat', counts: 'devices.total', group: 'premium', entitles: { 'extensions.total': 1 } },
  ];

  it('matches inside the covered range on an item-bearing dimension, unreviewed items and all', () => {
    const out = compareRecurring({
      ...base,
      rules: seatPlusPremium,
      subscriptions: [rec('Seat Tier One', '10'), rec('Premium Hosted Phone Seat', '2')],
    });
    const row = rowFor(out, 'seats');
    expect(row.billed).toBe(10);
    expect(row.entitled).toBe(2);
    expect(row.observed).toBe(12);
    expect(row.items?.length).toBe(12);
    expect(row.unreviewed).toBe(12);
    expect(row.verdict).toBe('match');
  });

  it('takes the over branch on an item-bearing dimension one past the covered range', () => {
    const out = compareRecurring({
      ...base,
      rules: seatPlusPremium,
      subscriptions: [rec('Seat Tier One', '10'), rec('Premium Hosted Phone Seat', '1')],
    });
    const row = rowFor(out, 'seats');
    expect(row.entitled).toBe(1);
    expect(row.observed).toBe(12);
    expect(row.unreviewed).toBe(12);
    expect(row.verdict).toBe('unbaselined');
  });

  // ---- an acceptance is against the entitlement that was there at the time --------------------------
  const three = [ext(100), ext(101), ext(102)].map((key) => ({ key }));
  const threeItems = (p: string) => (p === 'extensions.total' ? three : items[p]);
  const acceptedThree = three.map((i) => acc(i.key));
  /** What an operator recorded while two premium seats were entitling two extensions. */
  const rowAcceptance: GroupAcceptance = { billed: 2, observed: 3, accepted: 3, entitled: 2, decidedAt: '2026-08-01T00:00:00.000Z', decidedBy: 'ops@example.com' };

  it('matches three extensions against two billed and two entitled', () => {
    const out = compareRecurring({
      ...base,
      rules: seatPlusPremium,
      itemsFor: threeItems,
      subscriptions: [rec('Seat Tier One', '2'), rec('Premium Hosted Phone Seat', '2')],
    });
    const row = rowFor(out, 'seats');
    expect(row.billed).toBe(2);
    expect(row.entitled).toBe(2);
    expect(row.observed).toBe(3);
    expect(row.verdict).toBe('match');
  });

  it('drifts when the entitlement behind an accepted overage has gone away', () => {
    const baselines: GroupBaseline[] = [{ group: 'seats', items: acceptedThree, groupRow: rowAcceptance }];
    const out = compareRecurring({
      ...base,
      rules: seatPlusPremium,
      itemsFor: threeItems,
      baselines,
      subscriptions: [rec('Seat Tier One', '2')],
    });
    const row = rowFor(out, 'seats');
    expect(row.billed).toBe(2);
    expect(row.entitled).toBe(0);
    expect(row.observed).toBe(3);
    expect(row.unreviewed).toBe(0);
    // Three seats against "two billed, two entitled" was a different judgement from three against two
    // billed alone — the premium seats paid for the ceiling, and they are gone.
    expect(row.verdict).toBe('drift');
  });

  it('leaves a group row recorded before 0.6.0 judged exactly as it was', () => {
    const { entitled: _dropped, ...legacy } = rowAcceptance;
    const baselines: GroupBaseline[] = [{ group: 'seats', items: acceptedThree, groupRow: legacy }];
    const out = compareRecurring({
      ...base,
      rules: seatPlusPremium,
      itemsFor: threeItems,
      baselines,
      subscriptions: [rec('Seat Tier One', '2')],
    });
    expect(rowFor(out, 'seats').verdict).toBe('accepted');
  });

  // ---- rulebook mistakes ---------------------------------------------------------------------------
  it('reports a negative entitlement but never lets it shrink the covered range', () => {
    const out = compareRecurring({
      ...base,
      rules: [{ offer: 'Premium Hosted Phone Seat', counts: 'devices.total', group: 'premium', entitles: { teamsConnected: -1 } }],
      subscriptions: [rec('Premium Hosted Phone Seat', '1')],
      inventory: live({ teamsConnected: 0 }),
    });
    const row = rowFor(out, 'teamsConnected');
    expect(row.entitled).toBe(-1);
    expect(row.optional).toBe(false);
    // Clamped: nothing is billed and nothing is live, which is a match however the rulebook is written.
    expect(row.verdict).toBe('match');
  });

  it('aggregates credit provenance the way offer names are matched — case-insensitively after trim', () => {
    const out = compareRecurring({
      ...base,
      rules: [premium],
      subscriptions: [rec('Premium Hosted Phone Seat', '1'), rec('  premium HOSTED phone seat  ', '2')],
      inventory: live({ smsNumbers: 3 }),
    });
    const row = rowFor(out, 'smsNumbers');
    expect(row.entitled).toBe(3);
    expect(row.credits).toEqual([{ from: 'Premium Hosted Phone Seat', kind: 'entitles', quantity: 3 }]);
  });

  it('leaves entitled, credits and optional at their empty values on an ordinary row', () => {
    const out = compareRecurring({ ...base, subscriptions: [rec('Seat Tier One', '12')] });
    const row = rowFor(out, 'seats');
    expect(row.entitled).toBe(0);
    expect(row.credits).toEqual([]);
    expect(row.optional).toBe(false);
  });

  it('sums the entitlement over the lines that grant it', () => {
    const out = compareRecurring({
      ...base,
      rules: [premium],
      subscriptions: [rec('Premium Hosted Phone Seat', '2'), { subscriptionId: 'SUB9', subscriptionOffer: [{ name: 'Premium Hosted Phone Seat', quantity: '3', subscriptionCharge: [{ type: 'REC' }] }] }],
      inventory: live({ smsNumbers: 5 }),
    });
    const row = rowFor(out, 'smsNumbers');
    expect(row.entitled).toBe(5);
    expect(row.credits).toEqual([{ from: 'Premium Hosted Phone Seat', kind: 'entitles', quantity: 5 }]);
    expect(row.verdict).toBe('match');
  });
});
