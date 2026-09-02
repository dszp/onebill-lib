import { describe, expect, it } from 'vitest';
import {
  findDuplicateCalls,
  findRepeatedCalls,
  flattenInvoice,
  invoiceCallKey,
  reconcileInvoice,
  taxTotalsByDescription,
  taxTotalsByJurisdiction,
  type InvoiceCall,
} from './invoice.js';
import { fakeCallRecord, fakeInvoiceDetail } from './testkit.js';
import type { InvoiceDetail } from './model.js';

const detail = (o: Parameters<typeof fakeInvoiceDetail>[0] = {}) =>
  fakeInvoiceDetail(o) as InvoiceDetail;

describe('flattenInvoice', () => {
  it('reaches calls through the doubly-nested accountInvoiceElements', () => {
    const flat = flattenInvoice(
      detail({ calls: [fakeCallRecord({ eventId: 'E1' }), fakeCallRecord({ eventId: 'E2' })] }),
    );
    expect(flat.calls.map((c) => c.eventId)).toEqual(['E1', 'E2']);
    expect(flat.invoiceNumber).toBe('INV00000');
    expect(flat.cycleStart).toBe('01/01/2026');
  });

  it('does NOT count taxLineItem.lineItems as a charge line', () => {
    const flat = flattenInvoice(detail({ recurringAmount: 100, usageAmount: 0.05 }));

    // Two charge lines: the recurring seat and the usage rollup. The tax component shares the
    // `lineItems` name and must not appear.
    expect(flat.chargeLines).toHaveLength(2);
    expect(flat.chargeLines[0]!.description).toBe('Standard Hosted Phone Seat');
    expect(flat.chargeLines[1]!.description).toBe('Usage Charges');
    expect(flat.chargeLines.map((l) => l.amount)).toEqual([100, 0.05]);
  });

  it('marks the usage rollup and does not double-count it', () => {
    const calls = [fakeCallRecord({ amount: 0.05 }), fakeCallRecord({ amount: 0.5 })];
    const flat = flattenInvoice(detail({ calls }));

    const recurring = flat.chargeLines[0]!;
    const rollup = flat.chargeLines[1]!;
    expect(recurring.isUsageRollup).toBe(false);
    expect(recurring.callCount).toBe(0);
    expect(recurring.usageAmount).toBe(0);
    expect(rollup.isUsageRollup).toBe(true);
    expect(rollup.callCount).toBe(2);
    // The rollup's own amount equals its calls, so adding both would double-count.
    expect(rollup.usageAmount).toBeCloseTo(0.55, 10);
    expect(rollup.amount).toBeCloseTo(0.55, 10);
  });

  it('collects the account-level surcharge, which sits outside the charge lines', () => {
    const flat = flattenInvoice(detail({ surchargeAmount: 12.34 }));
    expect(flat.surcharges).toHaveLength(1);
    expect(flat.surcharges[0]!.amount).toBe(12.34);
    expect(flat.surcharges[0]!.description).toBe('COST RECOVERY SURCHARGE');
  });

  it('lifts the CDR attributes out of the JSON key/value form', () => {
    const flat = flattenInvoice(
      detail({
        calls: [
          fakeCallRecord({
            source: '13175550100',
            destination: '18005550123',
            ratedQuantity: '126.0000000000',
          }),
        ],
      }),
    );
    const call = flat.calls[0]!;
    expect(call.source).toBe('13175550100');
    expect(call.destination).toBe('18005550123');
    expect(call.ratedQuantity).toBe(126);
    expect(call.chargeCategory).toBe('Toll Free Orig');
    expect(call.chargeCategoryGroup).toBe('Toll Free Calls');
    expect(call.timeCode).toBe('Standard');
    expect(call.uom).toBe('Second');
  });

  it('keeps the EVENT_TYPE attribute apart from the lstLineItems eventType', () => {
    // Two different facts with near-identical names: `USAGE` (what kind of line) versus
    // `Origination Calls` (which direction the call went). Conflating them loses the direction.
    const flat = flattenInvoice(detail());
    const call = flat.calls[0]!;
    expect(call.eventType).toBe('USAGE');
    expect(call.attributes.EVENT_TYPE).toBe('Origination Calls');
    expect(call.eventName).toBe('Origination Calls');
  });

  it('reads the XML-shaped eventAttributes too', () => {
    const xmlShaped = {
      ...fakeCallRecord(),
      eventAttributes: [
        {
          eventAttribute: [
            {
              SERVICE_TYPE: 'voice',
              SOURCE: '13175550100',
              DESTINATION: '18005550123',
              RATED_QUANTITY: '90.0000000000',
              CHARGE_CATEGORY: 'Toll Free Orig',
            },
          ],
        },
      ],
    };
    const flat = flattenInvoice(detail({ calls: [xmlShaped] }));
    const call = flat.calls[0]!;
    expect(call.source).toBe('13175550100');
    expect(call.destination).toBe('18005550123');
    expect(call.ratedQuantity).toBe(90);
    expect(call.chargeCategory).toBe('Toll Free Orig');
  });

  it('tolerates a single object where the API sometimes sends an array', () => {
    const single = detail() as any;
    // Collapse every level that the API is known to vary.
    single.accountInvoiceElements = single.accountInvoiceElements[0];
    single.accountInvoiceElements.accountInvoiceElements =
      single.accountInvoiceElements.accountInvoiceElements[0];
    single.accountInvoiceElements.accountInvoiceElements.invoiceElements =
      single.accountInvoiceElements.accountInvoiceElements.invoiceElements[0];

    const flat = flattenInvoice(single as InvoiceDetail);
    expect(flat.chargeLines).toHaveLength(2);
    expect(flat.calls).toHaveLength(1);
  });

  it('returns empty collections for an invoice with no elements at all', () => {
    const flat = flattenInvoice({ invoiceNumber: 'INV00001' } as InvoiceDetail);
    expect(flat.chargeLines).toEqual([]);
    expect(flat.calls).toEqual([]);
    expect(flat.surcharges).toEqual([]);
    expect(flat.totalDiscount).toBe(0);
  });
});

describe('reconcileInvoice', () => {
  it('balances a consistent invoice on both checks', () => {
    const r = reconcileInvoice(flattenInvoice(detail()));
    expect(r.balanced).toBe(true);
    expect(r.usageBalanced).toBe(true);
    expect(r.computedTotal).toBeCloseTo(r.statedTotal!, 10);
    expect(r.usageDelta).toBeCloseTo(0, 10);
  });

  it('adds surcharge and discount to the charge lines, not to the calls', () => {
    const r = reconcileInvoice(
      flattenInvoice(
        detail({
          recurringAmount: 100,
          calls: [fakeCallRecord({ amount: 0.5 })],
          surchargeAmount: 10,
          discount: -7.5,
        }),
      ),
    );
    expect(r.chargeLineTotal).toBeCloseTo(100.5, 10);
    expect(r.surchargeTotal).toBe(10);
    expect(r.discount).toBe(-7.5);
    expect(r.computedTotal).toBeCloseTo(103, 10);
    expect(r.balanced).toBe(true);
  });

  it('reports NOT balanced when the stated total disagrees', () => {
    const r = reconcileInvoice(flattenInvoice(detail({ totalCurrentCharge: 999 })));
    expect(r.balanced).toBe(false);
    expect(r.delta).toBeCloseTo(r.computedTotal - 999, 10);
  });

  it('catches a dropped call even when the invoice-level total still balances', () => {
    // This is the failure the usage check exists for: the rollup is intact, so `balanced` stays
    // true, but a per-call walk that lost a row would silently under-report every conclusion
    // drawn from the calls.
    const flat = flattenInvoice(
      detail({ calls: [fakeCallRecord({ amount: 0.5 }), fakeCallRecord({ amount: 0.25 })] }),
    );
    flat.calls.pop();

    const r = reconcileInvoice(flat);
    expect(r.balanced).toBe(true);
    expect(r.usageBalanced).toBe(false);
    expect(r.usageDelta).toBeCloseTo(-0.25, 10);
    expect(r.callCount).toBe(1);
  });

  it('leaves delta undefined when the invoice states no total', () => {
    const flat = flattenInvoice(detail());
    flat.totalCurrentCharge = undefined;
    const r = reconcileInvoice(flat);
    expect(r.delta).toBeUndefined();
    expect(r.balanced).toBe(false);
  });
});

/** A minimal typed call, so the key/duplicate tests state exactly what they depend on. */
function call(over: Partial<InvoiceCall> = {}): InvoiceCall {
  return {
    eventId: 'E1',
    isoEventDate: '2026-01-15 09:30:00',
    source: '13175550100',
    destination: '18005550123',
    ratedQuantity: 60,
    amount: 0.05,
    attributes: {},
    ...over,
    // Spreading a Partial would widen this to `boolean | undefined`; the field is not optional.
    taxed: over.taxed ?? false,
  };
}

describe('invoiceCallKey', () => {
  it('is equal for two rows describing the same call with different eventIds', () => {
    expect(invoiceCallKey(call({ eventId: 'E1' }))).toBe(invoiceCallKey(call({ eventId: 'E2' })));
  });

  it('differs when any one component differs', () => {
    const base = invoiceCallKey(call());
    expect(invoiceCallKey(call({ isoEventDate: '2026-01-15 09:30:01' }))).not.toBe(base);
    expect(invoiceCallKey(call({ source: '13175550101' }))).not.toBe(base);
    expect(invoiceCallKey(call({ destination: '18005550124' }))).not.toBe(base);
    expect(invoiceCallKey(call({ ratedQuantity: 66 }))).not.toBe(base);
  });
});

describe('findDuplicateCalls', () => {
  it('finds a re-imported call on the natural key when the eventId has changed', () => {
    const prior = [call({ eventId: 'OLD' })];
    const report = findDuplicateCalls([call({ eventId: 'NEW' })], prior);

    expect(report.byEventId).toHaveLength(0);
    expect(report.byNaturalKey).toHaveLength(1);
    expect(report.naturalOnly).toHaveLength(1);
    expect(report.naturalOnly[0]!.matches[0]!.eventId).toBe('OLD');
  });

  it('finds the same stored event on both keys, and does not call it natural-only', () => {
    const report = findDuplicateCalls([call({ eventId: 'SAME' })], [call({ eventId: 'SAME' })]);
    expect(report.byEventId).toHaveLength(1);
    expect(report.byNaturalKey).toHaveLength(1);
    expect(report.naturalOnly).toHaveLength(0);
  });

  it('reports nothing for genuinely distinct calls', () => {
    const report = findDuplicateCalls(
      [call({ eventId: 'A', isoEventDate: '2026-02-01 10:00:00' })],
      [call({ eventId: 'B', isoEventDate: '2026-01-15 09:30:00' })],
    );
    expect(report.byEventId).toHaveLength(0);
    expect(report.byNaturalKey).toHaveLength(0);
    expect(report.naturalOnly).toHaveLength(0);
  });

  it('does not match rows on an absent eventId', () => {
    // Two rows that both lack an id are not thereby the same event.
    const report = findDuplicateCalls(
      [call({ eventId: undefined, isoEventDate: '2026-03-01 08:00:00' })],
      [call({ eventId: undefined })],
    );
    expect(report.byEventId).toHaveLength(0);
  });

  it('returns every earlier row a call matched, not just the first', () => {
    const report = findDuplicateCalls([call({ eventId: 'X' })], [call({ eventId: 'A' }), call({ eventId: 'B' })]);
    expect(report.byNaturalKey[0]!.matches.map((m) => m.eventId)).toEqual(['A', 'B']);
  });
});

describe('findRepeatedCalls', () => {
  it('groups rows repeated within one invoice and prices the extra copies', () => {
    const groups = findRepeatedCalls([
      call({ eventId: 'A', amount: 0.05 }),
      call({ eventId: 'B', amount: 0.05 }),
      call({ eventId: 'C', isoEventDate: '2026-01-16 09:30:00' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.calls.map((c) => c.eventId)).toEqual(['A', 'B']);
    expect(groups[0]!.distinctEventIds).toBe(true);
    // Only the second copy is the overcharge; the first is the call itself.
    expect(groups[0]!.extraAmount).toBeCloseTo(0.05, 10);
  });

  it('flags a repeat carrying one eventId as NOT distinct', () => {
    const groups = findRepeatedCalls([call({ eventId: 'A' }), call({ eventId: 'A' })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.distinctEventIds).toBe(false);
  });

  it('returns nothing when every call is unique', () => {
    expect(
      findRepeatedCalls([
        call({ eventId: 'A' }),
        call({ eventId: 'B', isoEventDate: '2026-01-16 09:30:00' }),
      ]),
    ).toEqual([]);
  });
});

describe('tax on a flattened invoice', () => {
  const withTax = () =>
    detail({
      recurringAmount: 100,
      calls: [
        fakeCallRecord({
          amount: 0.5,
          tax: [
            { description: 'FEDERAL UNIVERSAL SERVICE FUND', amount: 0.05, groupCode: 'IN' },
            { description: 'STATE USE TAX', amount: 0.02, groupCode: 'IN' },
          ],
        }),
        fakeCallRecord({
          amount: 0.25,
          tax: [{ description: 'FEDERAL UNIVERSAL SERVICE FUND', amount: 0.03, groupCode: 'IN' }],
        }),
      ],
    });

  it('collects tax components from calls, which is where a usage rollup keeps them', () => {
    const flat = flattenInvoice(withTax());
    const byName = new Map(flat.taxes.map((t) => [`${t.description}|${t.groupCode}`, t.amount]));
    expect(byName.get('FEDERAL UNIVERSAL SERVICE FUND|IN')).toBeCloseTo(0.08, 10);
    expect(byName.get('STATE USE TAX|IN')).toBeCloseTo(0.02, 10);
  });

  it('leaves a usage rollup with no taxLines of its own', () => {
    // Not an omission: the API gives a rollup no taxLineItem node. Its components are on the calls.
    const rollup = flattenInvoice(withTax()).chargeLines.find((l) => l.isUsageRollup)!;
    expect(rollup.taxLines).toEqual([]);
  });

  it('marks a call with a tax record as taxed, and one without as not', () => {
    const flat = flattenInvoice(
      detail({
        calls: [
          fakeCallRecord({ amount: 0.5, tax: [{ description: 'STATE USE TAX', amount: 0.02 }] }),
          fakeCallRecord({ amount: 0.05 }), // no tax node at all
        ],
      }),
    );
    expect(flat.calls[0]!.taxed).toBe(true);
    expect(flat.calls[0]!.taxAmount).toBeCloseTo(0.02, 10);
    expect(flat.calls[1]!.taxed).toBe(false);
    // undefined, NOT 0 — the two mean different things and `?? 0` would erase the difference.
    expect(flat.calls[1]!.taxAmount).toBeUndefined();
  });

  it('distinguishes a call taxed at zero from a call with no tax record', () => {
    const flat = flattenInvoice(
      detail({
        calls: [
          fakeCallRecord({ amount: 0.05, tax: [{ description: 'STATE USE TAX', amount: 0 }] }),
          fakeCallRecord({ amount: 0.05 }),
        ],
      }),
    );
    expect(flat.calls[0]!.taxed).toBe(true);
    expect(flat.calls[0]!.taxAmount).toBe(0);
    expect(flat.calls[1]!.taxed).toBe(false);
    expect(flat.calls[1]!.taxAmount).toBeUndefined();
  });

  it('totals tax by name and by jurisdiction', () => {
    const flat = flattenInvoice(
      detail({
        calls: [
          fakeCallRecord({
            amount: 0.5,
            tax: [
              { description: 'STATE USE TAX', amount: 0.1, groupCode: 'MI' },
              { description: 'STATE USE TAX', amount: 0.2, groupCode: 'IN' },
            ],
          }),
        ],
      }),
    );
    expect(taxTotalsByDescription(flat).get('STATE USE TAX')).toBeCloseTo(0.3, 10);
    expect(taxTotalsByJurisdiction(flat).get('MI')).toBeCloseTo(0.1, 10);
    expect(taxTotalsByJurisdiction(flat).get('IN')).toBeCloseTo(0.2, 10);
  });

  it('keeps two jurisdictions apart even under the same tax name', () => {
    // Aggregating on description alone would merge MI and IN use tax into one untraceable figure.
    const flat = flattenInvoice(
      detail({
        calls: [
          fakeCallRecord({
            amount: 0.5,
            tax: [
              { description: 'STATE USE TAX', amount: 0.1, groupCode: 'MI' },
              { description: 'STATE USE TAX', amount: 0.2, groupCode: 'IN' },
            ],
          }),
        ],
      }),
    );
    const useTax = flat.taxes.filter((t) => t.description === 'STATE USE TAX');
    expect(useTax).toHaveLength(2);
    expect(useTax.map((t) => t.groupCode).sort()).toEqual(['IN', 'MI']);
  });
});

describe('reconcileInvoice tax checks', () => {
  it('balances when the components equal the charge lines own tax', () => {
    const flat = flattenInvoice(
      detail({
        calls: [
          fakeCallRecord({ amount: 0.5, tax: [{ description: 'STATE USE TAX', amount: 0.07 }] }),
        ],
      }),
    );
    // The fixture's recurring line carries taxAmount 5 with a matching component.
    const r = reconcileInvoice(flat);
    expect(r.taxLineTotal).toBeCloseTo(r.chargeTaxTotal, 10);
    expect(r.taxBalanced).toBe(true);
  });

  it('reports NOT tax-balanced when a component is lost', () => {
    const flat = flattenInvoice(
      detail({
        calls: [
          fakeCallRecord({ amount: 0.5, tax: [{ description: 'STATE USE TAX', amount: 0.07 }] }),
        ],
      }),
    );
    flat.taxes.pop();
    expect(reconcileInvoice(flat).taxBalanced).toBe(false);
  });

  it('reports NOT tax-balanced when the invoice states a different tax total', () => {
    const flat = flattenInvoice(detail());
    flat.statedTaxTotal = 999;
    expect(reconcileInvoice(flat).taxBalanced).toBe(false);
  });
});
