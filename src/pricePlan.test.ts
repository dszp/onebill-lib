import { describe, expect, it } from 'vitest';
import { OneBillPricePlanTemplateError, findOwnIds, pricePlanFromTemplate } from './pricePlan.js';
import { fakePricePlan as templatePlan } from './testkit.js';

const overrides = {
  name: 'Example X200 Desk Phone',
  code: 'EX-X200',
  availableFrom: '2026-02-01T00:00:00-08:00',
};

describe('pricePlanFromTemplate', () => {
  it('removes every id that names one of the plan’s own objects', () => {
    const plan = pricePlanFromTemplate(templatePlan(), overrides);
    expect(findOwnIds(plan)).toEqual([]);
    expect('id' in plan).toBe(false);
    expect('id' in plan.pricePlanEventInfos[0]).toBe(false);
    expect('id' in plan.pricePlanEventInfos[0].chargeInfos[0]).toBe(false);
  });

  it('keeps settlement-policy references, reduced to ids and rule values', () => {
    const charge = pricePlanFromTemplate(templatePlan(), overrides).pricePlanEventInfos[0].chargeInfos[0];
    expect(charge.settlementPolicy).toEqual({
      id: '900',
      settlementPolicyRuleArray: [
        { id: '901', ruleValue: 0 },
        { id: '902', ruleValue: 0 },
      ],
    });
  });

  it('keeps feature references and plan settings', () => {
    const plan = pricePlanFromTemplate(templatePlan(), overrides);
    expect(plan.pricePlanFeatureInfos).toEqual([{ featureName: 'MAC', featureId: '203', value: '' }]);
    expect(plan.term).toBe(0);
    expect(plan.priceOverridable).toBe(true);
    expect(plan.pricePlanEventInfos[0].chargeInfos[0].glCode).toBe('Revenue - Hardware');
  });

  it('drops server-generated links, status and the charge revision timestamp', () => {
    const plan = pricePlanFromTemplate(templatePlan(), overrides);
    for (const k of ['url', 'selfcarePriceplanUrl', 'priceplanStatus']) expect(k in plan).toBe(false);
    expect('effectiveFrom' in plan.pricePlanEventInfos[0].chargeInfos[0]).toBe(false);
  });

  it('applies identity, description and charge overrides', () => {
    const plan = pricePlanFromTemplate(templatePlan(), {
      ...overrides,
      description: '<p>Example X200.</p>',
      amount: 199.99,
      cost: 120.5,
      glString: 'Hardware:Example X200 Desk Phone',
    });
    const charge = plan.pricePlanEventInfos[0].chargeInfos[0];
    expect(plan).toMatchObject({ ...overrides, description: '<p>Example X200.</p>' });
    expect(charge.amount).toBe(199.99);
    expect(charge.cost).toBe(120.5);
    expect(charge.costCurrencyCode).toBe(840);
    expect(charge.glString).toBe('Hardware:Example X200 Desk Phone');
  });

  it('defaults the invoice description to the new name, not the template’s', () => {
    const charge = pricePlanFromTemplate(templatePlan(), overrides).pricePlanEventInfos[0].chargeInfos[0];
    expect(charge.localizedInvoiceDescriptions).toEqual([
      { language: 'US English', description: 'Example X200 Desk Phone' },
    ]);
  });

  it('keeps template images without their ids, or replaces them', () => {
    expect(pricePlanFromTemplate(templatePlan(), overrides).pricePlanImageInfos).toEqual([
      { sequence: 0, image: 'AAAA' },
      { sequence: 0, image: 'BBBB' },
    ]);
    expect(pricePlanFromTemplate(templatePlan(), { ...overrides, images: ['CCCC'] }).pricePlanImageInfos).toEqual([
      { sequence: 0, image: 'CCCC' },
    ]);
  });

  it('sends matchingCurrency as true, the only value a create accepts', () => {
    const t = templatePlan() as any;
    t.pricePlanEventInfos[0].chargeInfos[0].matchingCurrency = false;
    expect(pricePlanFromTemplate(t, overrides).pricePlanEventInfos[0].chargeInfos[0].matchingCurrency).toBe(true);
  });

  it('does not modify the template', () => {
    const t = templatePlan();
    const snapshot = JSON.stringify(t);
    pricePlanFromTemplate(t, { ...overrides, amount: 1 });
    expect(JSON.stringify(t)).toBe(snapshot);
  });

  it('refuses a charge override on a template with more than one charge', () => {
    const t = templatePlan();
    t.pricePlanEventInfos[0]!.chargeInfos.push({ ...t.pricePlanEventInfos[0]!.chargeInfos[0]!, id: '70002' });
    expect(() => pricePlanFromTemplate(t, { ...overrides, amount: 5 })).toThrow(OneBillPricePlanTemplateError);
    // Without a charge override the clone is still allowed.
    expect(findOwnIds(pricePlanFromTemplate(t, overrides))).toEqual([]);
  });
});

describe('findOwnIds', () => {
  it('reports each own id by path, and ignores reference ids', () => {
    expect(findOwnIds(templatePlan())).toEqual([
      'id',
      'pricePlanImageInfos[0].id',
      'pricePlanImageInfos[1].id',
      'pricePlanEventInfos[0].id',
      'pricePlanEventInfos[0].chargeInfos[0].id',
    ]);
  });
});
