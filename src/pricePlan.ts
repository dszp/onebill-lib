/**
 * Building a NEW price plan from an existing one. Pure: no I/O, no client dependency.
 *
 * The common catalogue task is "another model, priced like this one": clone a plan, change its name,
 * code, description and price. A plan read from `getProduct` cannot be sent back as-is, because it
 * carries the server's identity for every object in it — and on the product endpoint, an `id` names
 * an EXISTING plan, event or charge. What OneBill does when a create carries an existing charge's id
 * is untested (the UI's own clone sends one and the server mints a fresh id, but that is a different
 * endpoint), so this module removes them rather than relying on the server to ignore them.
 *
 * What is kept: every setting that describes the plan (term, proration, tax codes, GL code, unit,
 * features, settlement policy). The ids that survive are REFERENCES to shared definitions, not
 * identities of this plan's own objects — the settlement policy and its rules, and a feature's
 * `featureId`. See {@link findOwnIds}.
 */
import type { PricePlanInfo, Rec } from './model.js';

/** A price plan body ready to send: no server-assigned identity anywhere in it. */
export type NewPricePlan = PricePlanInfo & { code: string; name: string; availableFrom: string };

/** What changes when one plan is used as the template for another. */
export interface PricePlanOverrides {
  /** Display name, e.g. `Example X200 Desk Phone`. Also the default invoice description. */
  name: string;
  /** Plan code. Must not already exist on the target product. */
  code: string;
  /**
   * First day the plan is offered, ISO 8601 with offset, e.g. `2026-11-06T00:00:00-08:00`. OneBill
   * rejects a back-dated product `availableFrom` (`10PR1012`), and midnight today in a timezone
   * behind the tenant's counts as back-dated — measured; tomorrow is the safe choice for an API write.
   */
  availableFrom: string;
  /** HTML description. Kept from the template when omitted. */
  description?: string;
  /** Charge amount. Requires a template with exactly one charge. */
  amount?: number;
  /** Cost recorded on the charge. Requires a template with exactly one charge. */
  cost?: number;
  /** GL string on the charge. Requires a template with exactly one charge. */
  glString?: string;
  /** Invoice line description. Defaults to `name` when a template has exactly one charge. */
  invoiceDescription?: string;
  /**
   * Base64 images (no `data:` prefix), replacing the template's. Omit to keep the template's images;
   * pass `[]` for none.
   */
  images?: string[];
}

/** Thrown when overrides cannot be applied to the template as given. */
export class OneBillPricePlanTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OneBillPricePlanTemplateError';
  }
}

/** Keys holding a REFERENCE to a shared definition: an `id` directly beneath them is kept. */
const REFERENCE_PARENTS = new Set(['settlementPolicy', 'vendorSettlementPolicy', 'settlementPolicyRuleArray']);

/** Server-generated plan fields: links, status, and the charge's own revision timestamp. */
const SERVER_FIELDS = new Set(['url', 'selfcarePriceplanUrl', 'priceplanStatus', 'effectiveFrom']);

/**
 * Paths of every `id` in a plan body that identifies one of the plan's OWN objects — the plan, an
 * event, a charge, an image. Empty means the body names nothing that already exists.
 *
 * Settlement-policy and rule ids are references to shared definitions and are not reported.
 */
export function findOwnIds(plan: unknown): string[] {
  const found: string[] = [];
  const walk = (v: unknown, path: string, parentKey: string): void => {
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`, parentKey));
      return;
    }
    if (typeof v !== 'object' || v === null) return;
    for (const [k, x] of Object.entries(v as Rec)) {
      if (k === 'id' && x !== undefined && x !== null && !REFERENCE_PARENTS.has(parentKey)) {
        found.push(path ? `${path}.id` : 'id');
      }
      walk(x, path ? `${path}.${k}` : k, k);
    }
  };
  walk(plan, '', '');
  return found;
}

function strip(v: unknown, parentKey: string): unknown {
  if (Array.isArray(v)) return v.map((x) => strip(x, parentKey));
  if (typeof v !== 'object' || v === null) return v;
  const out: Rec = {};
  for (const [k, x] of Object.entries(v as Rec)) {
    if (SERVER_FIELDS.has(k)) continue;
    if (k === 'id' && !REFERENCE_PARENTS.has(parentKey)) continue;
    out[k] = strip(x, k);
  }
  return out;
}

/**
 * Reduce a settlement policy to the reference shape verified live: the policy id plus each rule's id
 * and value. The read shape also carries each rule's name, description and position — descriptive
 * copies of the shared definition, not settings of this charge.
 */
function settlementReference(policy: unknown): unknown {
  if (typeof policy !== 'object' || policy === null) return policy;
  const p = policy as Rec;
  return {
    id: p.id,
    settlementPolicyRuleArray: Array.isArray(p.settlementPolicyRuleArray)
      ? p.settlementPolicyRuleArray.map((r: Rec) => ({ id: r.id, ruleValue: r.ruleValue }))
      : [],
  };
}

/**
 * A new price plan body from an existing plan and the fields that differ.
 *
 * The template is not modified. Charge overrides (`amount`, `cost`, `glString`,
 * `invoiceDescription`) need a template with exactly one event holding exactly one charge — a
 * one-time hardware sale, say — and throw otherwise rather than guess which charge was meant.
 *
 * @throws {OneBillPricePlanTemplateError} for a charge override on a multi-charge template.
 */
export function pricePlanFromTemplate(template: PricePlanInfo, o: PricePlanOverrides): NewPricePlan {
  const plan = strip(template, '') as Rec;

  for (const event of (plan.pricePlanEventInfos ?? []) as Rec[]) {
    for (const charge of (event.chargeInfos ?? []) as Rec[]) {
      if (charge.settlementPolicy) charge.settlementPolicy = settlementReference(charge.settlementPolicy);
      // The API will not accept back what it gave: a charge created in the UI can read back
      // `matchingCurrency: false`, and a create echoing that is rejected in-band —
      // `10SP13112 Invalid Matching Currency value, allowed value is true.` (measured 2026-11-05).
      if ('matchingCurrency' in charge) charge.matchingCurrency = true;
    }
  }

  plan.name = o.name;
  plan.code = o.code;
  plan.availableFrom = o.availableFrom;
  if (o.description !== undefined) plan.description = o.description;

  if (o.images !== undefined) {
    plan.pricePlanImageInfos = o.images.map((image, i) => ({ sequence: i, image }));
  } else if (Array.isArray(plan.pricePlanImageInfos)) {
    plan.pricePlanImageInfos = (plan.pricePlanImageInfos as Rec[]).map((img, i) => ({
      sequence: img.sequence ?? i,
      image: img.image,
    }));
  }

  const charges = ((plan.pricePlanEventInfos ?? []) as Rec[]).flatMap((e) => (e.chargeInfos ?? []) as Rec[]);
  const wantsChargeOverride =
    o.amount !== undefined || o.cost !== undefined || o.glString !== undefined || o.invoiceDescription !== undefined;
  if (charges.length !== 1) {
    if (wantsChargeOverride) {
      throw new OneBillPricePlanTemplateError(
        `Template plan ${String(template.code ?? '')} has ${charges.length} charges; charge overrides ` +
          `need exactly one. Edit pricePlanEventInfos on the result instead.`,
      );
    }
    return plan as NewPricePlan;
  }

  const charge = charges[0]!;
  if (o.amount !== undefined) charge.amount = o.amount;
  if (o.cost !== undefined) {
    charge.cost = o.cost;
    charge.costCurrencyCode = charge.costCurrencyCode ?? charge.currencyCode;
  }
  if (o.glString !== undefined) charge.glString = o.glString;
  const invoice = o.invoiceDescription ?? o.name;
  const language = (charge.localizedInvoiceDescriptions as Rec[] | undefined)?.[0]?.language ?? 'US English';
  charge.localizedInvoiceDescriptions = [{ language, description: invoice }];
  return plan as NewPricePlan;
}
