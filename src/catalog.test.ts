import { describe, expect, it } from 'vitest';
import { buildCatalogIndex, catalogLookup } from './catalog.js';

const products = [
  { id: '1', code: 'SEATPROD', name: 'Hosted Seat', pricePlanInfos: [
    { id: '11', code: 'STD24', name: 'Standard Seat' },
    { id: '12', code: '', name: 'Bundled Seat - 24M' },          // a retail plan with no code
    { id: '13', code: 'PREM24', name: ' Premium Seat ' },
  ] },
  { id: '2', code: 'E911PROD', name: 'Emergency Location', pricePlanInfos: [{ id: '21', code: 'E911M', name: 'Emergency Location' }] },
  { id: '3', code: 'NOPLANS', name: 'Empty Product' },
];

describe('buildCatalogIndex', () => {
  it('maps every plan name to its plan and product codes', () => {
    const ix = buildCatalogIndex(products);
    expect(ix.byPlanName['standard seat']).toEqual({ planName: 'Standard Seat', planCode: 'STD24', productCode: 'SEATPROD', productName: 'Hosted Seat' });
  });
  it('keeps a plan with an empty code, under its name, with planCode ""', () => {
    expect(buildCatalogIndex(products).byPlanName['bundled seat - 24m']!.planCode).toBe('');
  });
  it('normalises the key (trim + lowercase) and keeps the display name trimmed', () => {
    const e = buildCatalogIndex(products).byPlanName['premium seat']!;
    expect(e.planName).toBe('Premium Seat');
  });
  it('counts products and plans', () => {
    const ix = buildCatalogIndex(products);
    expect(ix.products).toBe(3);
    expect(ix.plans).toBe(4);
  });
  it('first product wins when two products carry the same plan name', () => {
    const dup = [...products, { id: '9', code: 'OTHER', name: 'Other', pricePlanInfos: [{ code: 'X', name: 'Standard Seat' }] }];
    expect(buildCatalogIndex(dup).byPlanName['standard seat']!.productCode).toBe('SEATPROD');
  });
  it('catalogLookup tolerates an absent index', () => {
    expect(catalogLookup(undefined, 'Standard Seat')).toBeUndefined();
    expect(catalogLookup(buildCatalogIndex(products), '  standard SEAT ')!.planCode).toBe('STD24');
  });
});
