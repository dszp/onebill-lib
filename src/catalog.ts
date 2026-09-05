/**
 * The OneBill catalogue, indexed by price plan NAME.
 *
 * A subscription line carries only its plan's name (`subscriptionOffer[].name`) — no plan code, no
 * product code (measured live 2026-09-04). The codes live in the catalogue: `listProducts()` names
 * every product, and `getProduct(code)` returns its `pricePlanInfos`. This index joins the two so a
 * consumer can key a rule by plan code or product code and still match a line by the only thing the
 * line says about itself.
 *
 * A plan can have an EMPTY code (retail plans supplied by a reseller's upstream do). It is kept under
 * its name with `planCode: ''` so a product-code key can still reach it; a plan-code key never will.
 */
import type { Product } from './model.js';

export interface CatalogEntry { planName: string; planCode: string; productCode: string; productName: string }
export interface CatalogIndex {
  /** Keyed by the normalised plan name: trimmed, lowercased. */
  byPlanName: Record<string, CatalogEntry>;
  products: number;
  plans: number;
}

const norm = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Pure. First product wins a duplicated plan name; the index is deterministic in input order. */
export function buildCatalogIndex(products: readonly Product[]): CatalogIndex {
  const byPlanName: Record<string, CatalogEntry> = {};
  let plans = 0;
  for (const p of products) {
    for (const plan of p.pricePlanInfos ?? []) {
      const planName = str(plan.name);
      if (!planName) continue;
      plans++;
      const key = norm(planName);
      if (byPlanName[key]) continue;
      byPlanName[key] = { planName, planCode: str(plan.code), productCode: str(p.code), productName: str(p.name) };
    }
  }
  return { byPlanName, products: products.length, plans };
}

export function catalogLookup(index: CatalogIndex | undefined, planName: string): CatalogEntry | undefined {
  return index?.byPlanName[norm(planName)];
}
