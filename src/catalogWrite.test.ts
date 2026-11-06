import { describe, expect, it } from 'vitest';
import { pricePlanFromTemplate } from './pricePlan.js';
import { TEST_CONFIG, fakePricePlan as templatePlan, mockFetch, type RecordedCall } from './testkit.js';
import {
  OneBillCatalogConflictError,
  OneBillCatalogVerificationError,
  OneBillWriteClient,
} from './writeClient.js';

const UNKNOWN = {
  status: 'Bad Request',
  validationResponse: { successful: false, validationErrorInfo: [{ code: '10PR1036', message: 'Invalid product code.' }] },
};

const productRecord = () => ({
  id: '30001',
  code: 'EX-PHONES',
  name: 'Example Desk Phones',
  categoryCode: 'CAT0001',
  description: '<p>Example Desk Phones</p>',
  pricePlanInfos: [templatePlan()],
});

const newPlan = () =>
  pricePlanFromTemplate(templatePlan(), {
    name: 'Example X200 Desk Phone',
    code: 'EX-X200',
    availableFrom: '2026-02-01T00:00:00-08:00',
    amount: 199.99,
  });

/**
 * A product endpoint that MERGES on PUT, as measured live: plans in the body are added, assigned
 * fresh ids; everything else is kept. `onPut` can distort it to simulate the API misbehaving.
 */
function productServer(initial: Record<string, any> | undefined, onPut?: (state: any, body: any) => any) {
  let state = initial ? structuredClone(initial) : undefined;
  let nextId = 80000;
  const writes: RecordedCall[] = [];
  const mock = mockFetch({
    handler: (call) => {
      if (call.method === 'GET') return { body: state ? { ...state, status: 'OK' } : UNKNOWN };
      writes.push(call);
      if (call.method === 'POST') {
        state = { ...call.body, id: String(nextId++), pricePlanInfos: (call.body.pricePlanInfos ?? []).map((p: any) => ({ ...p, id: String(nextId++) })) };
        return { body: { productCode: call.body.code, id: state!.id, status: 'OK' } };
      }
      const added = call.body.pricePlanInfos.map((p: any) => ({ ...p, id: String(nextId++) }));
      state = onPut ? onPut(state, call.body) : { ...state, pricePlanInfos: [...state!.pricePlanInfos, ...added] };
      return { body: { productCode: state!.code, id: state!.id, status: 'OK' } };
    },
  });
  return { mock, writes, current: () => state };
}

const client = (mock: ReturnType<typeof mockFetch>) => new OneBillWriteClient({ ...TEST_CONFIG, fetchImpl: mock.fetchImpl });

describe('addPricePlan', () => {
  it('sends only the product id and the new plan', async () => {
    const { mock, writes } = productServer(productRecord());
    await client(mock).addPricePlan('EX-PHONES', newPlan());

    expect(writes).toHaveLength(1);
    expect(writes[0]!.method).toBe('PUT');
    expect(writes[0]!.url).toBe('https://billing.example.com/rest/ProductService/v1/product');
    expect(Object.keys(writes[0]!.body).sort()).toEqual(['id', 'pricePlanInfos']);
    expect(writes[0]!.body.id).toBe('30001');
    expect(writes[0]!.body.pricePlanInfos.map((p: any) => p.code)).toEqual(['EX-X200']);
  });

  it('returns the stored plan and an empty collateral list when the server merges', async () => {
    const { mock } = productServer(productRecord());
    const res = await client(mock).addPricePlan('EX-PHONES', newPlan());
    expect(res.plan?.code).toBe('EX-X200');
    expect(res.plan?.id).toBeDefined();
    expect(res.collateral).toEqual([]);
  });

  it('ignores a reordering of nested arrays on read-back', async () => {
    const { mock } = productServer(productRecord(), (state, body) => {
      const s = structuredClone(state);
      s.pricePlanInfos[0].pricePlanEventInfos[0].chargeInfos[0].settlementPolicy.settlementPolicyRuleArray.reverse();
      s.pricePlanInfos.push({ ...body.pricePlanInfos[0], id: '81000' });
      return s;
    });
    const res = await client(mock).addPricePlan('EX-PHONES', newPlan(), { strict: true });
    expect(res.collateral).toEqual([]);
  });

  it('reports an existing plan that changed, and throws on it with strict', async () => {
    const revise = (state: any, body: any) => {
      const s = structuredClone(state);
      s.pricePlanInfos[0].pricePlanEventInfos[0].chargeInfos[0].amount = 1;
      s.description = '<p>changed</p>';
      s.pricePlanInfos.push({ ...body.pricePlanInfos[0], id: '81000' });
      return s;
    };
    const res = await client(productServer(productRecord(), revise).mock).addPricePlan('EX-PHONES', newPlan());
    expect(res.collateral).toEqual(['EX-X100', 'product.description']);

    await expect(
      client(productServer(productRecord(), revise).mock).addPricePlan('EX-PHONES', newPlan(), { strict: true }),
    ).rejects.toThrow(OneBillCatalogVerificationError);
  });

  it('reports an existing plan that disappeared (a replace, not a merge)', async () => {
    const replace = (state: any, body: any) => ({ ...state, pricePlanInfos: [{ ...body.pricePlanInfos[0], id: '81000' }] });
    const res = await client(productServer(productRecord(), replace).mock).addPricePlan('EX-PHONES', newPlan());
    expect(res.collateral).toEqual(['EX-X100']);
  });

  it('throws when the plan is missing after an accepted write', async () => {
    const { mock } = productServer(productRecord(), (state) => state);
    await expect(client(mock).addPricePlan('EX-PHONES', newPlan())).rejects.toThrow(/missing on read-back/);
  });

  it('refuses a plan code already on the product, sending nothing', async () => {
    const { mock, writes } = productServer(productRecord());
    const dupe = { ...newPlan(), code: 'EX-X100' };
    await expect(client(mock).addPricePlan('EX-PHONES', dupe)).rejects.toThrow(OneBillCatalogConflictError);
    expect(writes).toHaveLength(0);
  });

  it('refuses a plan name already on the product, ignoring case and dash variants', async () => {
    const { mock, writes } = productServer(productRecord());
    const dupe = { ...newPlan(), name: 'example x100 desk phone' };
    await expect(client(mock).addPricePlan('EX-PHONES', dupe)).rejects.toThrow(/already exists \(EX-X100\)/);
    expect(writes).toHaveLength(0);
  });

  it('refuses a plan carrying server ids, without reading or sending', async () => {
    const { mock } = productServer(productRecord());
    const raw = { ...templatePlan(), code: 'EX-X300', name: 'Example X300' } as any;
    await expect(client(mock).addPricePlan('EX-PHONES', raw)).rejects.toThrow(/carries server ids/);
    expect(mock.apiCalls).toHaveLength(0);
  });

  it('dryRun reads and checks but sends nothing', async () => {
    const { mock, writes } = productServer(productRecord());
    const res = await client(mock).addPricePlan('EX-PHONES', newPlan(), { dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.body.pricePlanInfos[0].code).toBe('EX-X200');
    expect(writes).toHaveLength(0);
  });
});

describe('createProduct', () => {
  const product = () => ({
    code: 'EX-HEADSETS',
    name: 'Example Headsets',
    categoryCode: 'CAT0001',
    availableFrom: '2026-02-01T00:00:00-08:00',
    pricePlanInfos: [newPlan()],
  });

  it('checks the code is free, POSTs, and reads back', async () => {
    const { mock, writes } = productServer(undefined);
    const res = await client(mock).createProduct(product());
    expect(mock.apiCalls.map((c) => c.method)).toEqual(['GET', 'POST', 'GET']);
    expect(writes[0]!.url).toBe('https://billing.example.com/rest/ProductService/v1/product');
    expect(res.id).not.toBe('');
    expect(res.product?.pricePlanInfos?.map((p) => p.code)).toEqual(['EX-X200']);
  });

  it('refuses a product code that already exists', async () => {
    const { mock, writes } = productServer(productRecord());
    await expect(client(mock).createProduct({ ...product(), code: 'EX-PHONES' })).rejects.toThrow(/already exists/);
    expect(writes).toHaveLength(0);
  });

  it('refuses duplicate plan codes or names within the request', async () => {
    const { mock } = productServer(undefined);
    const twice = { ...product(), pricePlanInfos: [newPlan(), newPlan()] };
    await expect(client(mock).createProduct(twice)).rejects.toThrow(OneBillCatalogConflictError);
    expect(mock.apiCalls).toHaveLength(0);
  });

  it('refuses a product body carrying an id', async () => {
    const { mock } = productServer(undefined);
    await expect(client(mock).createProduct({ ...product(), id: '30001' })).rejects.toThrow(/carries an id/);
  });

  it('propagates a read error that is not "unknown product"', async () => {
    const mock = mockFetch({ responses: [{ status: 500, body: { message: 'boom' } }] });
    await expect(client(mock).createProduct(product())).rejects.toThrow();
    expect(mock.apiCalls.map((c) => c.method)).toEqual(['GET']);
  });

  it('throws when a requested plan is missing after the write', async () => {
    let state: any;
    const mock = mockFetch({
      handler: (call) => {
        if (call.method === 'GET') return { body: state ? { ...state, status: 'OK' } : UNKNOWN };
        state = { ...call.body, id: '30002', pricePlanInfos: [] };
        return { body: { productCode: call.body.code, id: '30002', status: 'OK' } };
      },
    });
    await expect(client(mock).createProduct(product())).rejects.toThrow(OneBillCatalogVerificationError);
  });

  it('dryRun checks but sends nothing', async () => {
    const { mock, writes } = productServer(undefined);
    const res = await client(mock).createProduct(product(), { dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(writes).toHaveLength(0);
  });
});

/** Merge a by-id edit body into a product, as measured live: fields named are set, nothing else moves. */
function mergeEdit(state: any, body: any, sideEffects = true) {
  const s = structuredClone(state);
  for (const pe of body.pricePlanInfos) {
    const plan = s.pricePlanInfos.find((p: any) => p.id === pe.id);
    const { pricePlanEventInfos, id: _p, ...planFields } = pe;
    Object.assign(plan, planFields);
    if (sideEffects && pe.name !== undefined) plan.url = `https://billing.example.com/p?name=${encodeURIComponent(pe.name)}`;
    for (const ee of pricePlanEventInfos ?? []) {
      const event = plan.pricePlanEventInfos.find((e: any) => e.id === ee.id);
      for (const ce of ee.chargeInfos) {
        const charge = event.chargeInfos.find((c: any) => c.id === ce.id);
        const { id: _c, ...chargeFields } = ce;
        Object.assign(charge, chargeFields);
        if (sideEffects) {
          charge.chargeCategoryGroup = 'Default';
          delete charge.costCurrencyCode;
        }
      }
    }
  }
  return s;
}

describe('updatePricePlan', () => {
  const editServer = (distort?: (s: any, b: any) => any) =>
    productServer(productRecord(), (state, body) => (distort ? distort(state, body) : mergeEdit(state, body)));

  it('sends only ids and the changed fields', async () => {
    const { mock, writes } = editServer();
    await client(mock).updatePricePlan('EX-PHONES', 'EX-X100', { description: '<p>new</p>', amount: 160 });
    expect(writes[0]!.body).toEqual({
      id: '30001',
      pricePlanInfos: [
        {
          id: '50001',
          description: '<p>new</p>',
          pricePlanEventInfos: [{ id: '60001', chargeInfos: [{ id: '70001', amount: 160 }] }],
        },
      ],
    });
  });

  it('sends a cost edit as the cost alone', async () => {
    const { mock, writes } = editServer();
    await client(mock).updatePricePlan('EX-PHONES', 'EX-X100', { cost: 99 });
    expect(writes[0]!.body.pricePlanInfos[0].pricePlanEventInfos[0].chargeInfos[0]).toEqual({
      id: '70001',
      cost: 99,
    });
  });

  it('verifies the edit and ignores the server’s known side effects', async () => {
    const { mock } = editServer();
    const res = await client(mock).updatePricePlan(
      'EX-PHONES',
      'EX-X100',
      { name: 'Example X100 Desk Phone (2026)', amount: 155, glString: 'Hardware:X100', invoiceDescription: 'X100' },
      { strict: true },
    );
    expect(res.collateral).toEqual([]);
    expect(res.plan?.name).toBe('Example X100 Desk Phone (2026)');
    expect(res.previous.name).toBe('Example X100 Desk Phone');
  });

  it('retires a plan with availableTo', async () => {
    const { mock, writes } = editServer();
    const res = await client(mock).updatePricePlan('EX-PHONES', 'EX-X100', { availableTo: '2026-12-31T00:00:00-08:00' });
    expect(writes[0]!.body.pricePlanInfos[0]).toEqual({ id: '50001', availableTo: '2026-12-31T00:00:00-08:00' });
    expect(res.plan?.availableTo).toBe('2026-12-31T00:00:00-08:00');
  });

  it('throws when a requested field did not take', async () => {
    const { mock } = editServer((state) => state);
    await expect(client(mock).updatePricePlan('EX-PHONES', 'EX-X100', { amount: 1 })).rejects.toThrow(
      /did not take: charge\.amount/,
    );
  });

  it('reports a charge field that moved without being asked, and a revised charge id', async () => {
    const { mock } = editServer((state, body) => {
      const s = mergeEdit(state, body);
      const charge = s.pricePlanInfos[0].pricePlanEventInfos[0].chargeInfos[0];
      charge.glCode = 'Other';
      charge.id = '70999';
      return s;
    });
    const res = await client(mock).updatePricePlan('EX-PHONES', 'EX-X100', { amount: 151 });
    expect(res.collateral).toEqual(['charge.glCode', 'charge.id']);
  });

  it('reports another plan or the product changing, and throws on it with strict', async () => {
    const twoPlans = () => {
      const p = productRecord();
      p.pricePlanInfos.push({ ...structuredClone(p.pricePlanInfos[0]!), id: '50002', code: 'EX-X150', name: 'Example X150' });
      return p;
    };
    const distort = (state: any, body: any) => {
      const s = mergeEdit(state, body);
      s.pricePlanInfos[1].description = '<p>touched</p>';
      s.name = 'Renamed product';
      return s;
    };
    const res = await client(productServer(twoPlans(), distort).mock).updatePricePlan('EX-PHONES', 'EX-X100', { amount: 152 });
    expect(res.collateral).toEqual(['EX-X150', 'product.name']);
    await expect(
      client(productServer(twoPlans(), distort).mock).updatePricePlan('EX-PHONES', 'EX-X100', { amount: 152 }, { strict: true }),
    ).rejects.toThrow(OneBillCatalogVerificationError);
  });

  it('refuses an unknown plan, an empty change set, and a name used by another plan', async () => {
    const p = productRecord();
    p.pricePlanInfos.push({ ...structuredClone(p.pricePlanInfos[0]!), id: '50002', code: 'EX-X150', name: 'Example X150' });
    const { mock, writes } = productServer(p);
    const c = client(mock);
    await expect(c.updatePricePlan('EX-PHONES', 'EX-NOPE', { amount: 1 })).rejects.toThrow(/no such plan/);
    await expect(c.updatePricePlan('EX-PHONES', 'EX-X100', {})).rejects.toThrow(/no changes/);
    await expect(c.updatePricePlan('EX-PHONES', 'EX-X100', { name: 'example x150' })).rejects.toThrow(/already used by EX-X150/);
    expect(writes).toHaveLength(0);
  });

  it('allows keeping a plan’s own name in a different case', async () => {
    const { mock } = editServer();
    const res = await client(mock).updatePricePlan('EX-PHONES', 'EX-X100', { name: 'EXAMPLE X100 Desk Phone' });
    expect(res.plan?.name).toBe('EXAMPLE X100 Desk Phone');
  });

  it('refuses a charge change on a plan without exactly one charge', async () => {
    const p = productRecord();
    const event = p.pricePlanInfos[0]!.pricePlanEventInfos[0]!;
    event.chargeInfos.push({ ...structuredClone(event.chargeInfos[0]!), id: '70002' });
    const { mock, writes } = productServer(p, (s, b) => mergeEdit(s, b));
    await expect(client(mock).updatePricePlan('EX-PHONES', 'EX-X100', { amount: 1 })).rejects.toThrow(/exactly one charge/);
    // A plan-level edit on the same plan is still allowed.
    await expect(client(mock).updatePricePlan('EX-PHONES', 'EX-X100', { description: '<p>x</p>' })).resolves.toBeDefined();
    expect(writes).toHaveLength(1);
  });

  it('dryRun reads and builds the body but sends nothing', async () => {
    const { mock, writes } = editServer();
    const res = await client(mock).updatePricePlan('EX-PHONES', 'EX-X100', { amount: 1 }, { dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.body.pricePlanInfos[0].id).toBe('50001');
    expect(writes).toHaveLength(0);
  });
});
