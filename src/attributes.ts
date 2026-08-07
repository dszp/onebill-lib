/**
 * Mapping between OneBill custom-field groups and {@link Link}s.
 *
 * OneBill lets you declare repeating groups of typed fields on a subscriber — a group named for a
 * system, with a field for that system's identifier and optionally one for a sub-unit. That is the
 * same information a {@link Link} carries, in a place a human can see and edit, without the 64
 * character ceiling of `externalId`. So the groups hold the truth and `externalId` is derived.
 *
 * **Which group means which namespace is configuration**, supplied by the consumer as a
 * {@link LinkMapping}. The library ships none, for the same reason it ships no namespace constants:
 * a built-in mapping would bind it to one integrator's field names.
 *
 * Everything here is a pure function over a subscriber record. No I/O, so it needs no mocking.
 */
import type { Link } from './link.js';
import type { Rec, Subscriber } from './model.js';

/** How one custom-field group maps onto a link namespace. */
export interface GroupLinkSpec {
  /** The group's key as it appears in `accountAttribute`, e.g. `PBX`. */
  group: string;
  /** The namespace links from this group carry, e.g. `NS`. */
  ns: string;
  /** Field whose value becomes {@link Link.value}, e.g. `Domain`. */
  valueField: string;
  /**
   * Field whose value becomes {@link Link.qualifier}, e.g. `Site`.
   *
   * Omit it when the sub-unit does not distinguish one billable thing from another. A qualifier
   * belongs in the derived `externalId` only when it discriminates *billing identity* — two sites of
   * one domain billed as separate accounts do; several locations of one CRM company, all billed
   * together, do not.
   */
  qualifierField?: string;
}

/** A consumer-supplied set of group-to-namespace mappings. */
export type LinkMapping = readonly GroupLinkSpec[];

/** A link together with where it came from, so a caller can point at the offending row. */
export interface SourcedLink extends Link {
  /** The group key it was read from. */
  group: string;
  /** The group instance it belongs to — OneBill's `aggregator`. */
  aggregator?: number;
}

/**
 * OneBill's delete marker. A **number** — a string returns a 500. Used on a group row to remove an
 * instance, and on a single child to clear that one field.
 */
const DELETE_OPERATION = 2;

/** Blank means absent: OneBill omits `value` entirely on an unset field rather than sending "". */
function valueOf(child: unknown): string | undefined {
  if (typeof child !== 'object' || child === null) return undefined;
  const v = (child as { value?: unknown }).value;
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

/** Index a group instance's children by field name. Array order is not meaningful. */
function fieldsOf(instance: Rec): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const child of (instance.childAttribute as unknown[]) ?? []) {
    const key = (child as { key?: unknown })?.key;
    if (typeof key === 'string') out.set(key, child);
  }
  return out;
}

/**
 * Read links out of a subscriber's custom-field groups.
 *
 * An instance with no value in its `valueField` is skipped — that covers both the blank placeholder
 * instance OneBill materialises on every record and a half-filled row someone abandoned.
 *
 * Order follows the record. Duplicates are not removed here; {@link buildLinkSet} does that.
 */
export function attributesToLinks(subscriber: Subscriber, mapping: LinkMapping): SourcedLink[] {
  const byGroup = new Map(mapping.map((m) => [m.group, m]));
  const links: SourcedLink[] = [];

  for (const instance of (subscriber.accountAttribute as Rec[] | undefined) ?? []) {
    const spec = byGroup.get(instance?.key as string);
    if (!spec) continue;

    const fields = fieldsOf(instance);
    const value = valueOf(fields.get(spec.valueField));
    if (value === undefined) continue;

    const qualifier = spec.qualifierField ? valueOf(fields.get(spec.qualifierField)) : undefined;

    links.push({
      ns: spec.ns,
      value,
      ...(qualifier === undefined ? {} : { qualifier }),
      group: spec.group,
      aggregator: typeof instance.aggregator === 'number' ? instance.aggregator : undefined,
    });
  }

  return links;
}

/** Identity of a link, ignoring where it came from. */
function identity(l: Link): string {
  return `${l.ns}:${l.value}/${l.qualifier ?? ''}`;
}

/** Drop `group`/`aggregator` and de-duplicate, giving the plain links the codec works with. */
export function buildLinkSet(sourced: readonly SourcedLink[]): Link[] {
  const seen = new Set<string>();
  const out: Link[] = [];
  for (const l of sourced) {
    const plain: Link = l.qualifier === undefined
      ? { ns: l.ns, value: l.value }
      : { ns: l.ns, value: l.value, qualifier: l.qualifier };
    const key = identity(plain);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(plain);
  }
  return out;
}

/** What {@link linksToAttributes} decided to do. */
export interface AttributePlan {
  /** The `accountAttribute` array to send. */
  attributes: Rec[];
  /** Links that had no matching instance and will create one. */
  created: Link[];
  /** Links that matched an existing instance whose fields will change. */
  updated: Link[];
  /** Links already present and unchanged. */
  unchanged: Link[];
  /**
   * Links present in OneBill, absent from the requested set, and **left in place** because
   * `removeUnlisted` was not set. Reported rather than silently ignored.
   */
  notRemoved: SourcedLink[];
  /** Links marked for deletion because `removeUnlisted` was set. */
  removed: SourcedLink[];
  /** Links whose namespace is absent from the mapping and so cannot be written to any group. */
  unmapped: Link[];
}

/**
 * Work out the `accountAttribute` payload that makes a subscriber carry `links`.
 *
 * Existing instances are matched by namespace + value and **edited in place**, preserving their
 * `aggregator` and any fields this mapping does not manage — child updates merge rather than
 * replace, so a `Description` or `Link` field set by hand survives. New instances get the next free
 * `aggregator`, which the API requires the caller to assign: omit it and a second instance collides
 * with the first (`10CV00014 Duplicate key`).
 */
export function linksToAttributes(
  subscriber: Subscriber,
  links: readonly Link[],
  mapping: LinkMapping,
  opts: {
    /**
     * Delete group instances whose link is not in the requested set, making the record *match* the
     * input rather than accumulate.
     *
     * Off by default, because it destroys data a human may have entered. Deletion is expressed with
     * OneBill's own mechanism: `operationType: 2` (a **number** — a string crashes the server) on
     * the group row and on every child, with values in `attributeValuesInfo.associateValues`.
     */
    removeUnlisted?: boolean;
  } = {},
): AttributePlan {
  const byNs = new Map(mapping.map((m) => [m.ns, m]));
  const existing = ((subscriber.accountAttribute as Rec[] | undefined) ?? []).map((a) => ({ ...a }));
  const existingLinks = attributesToLinks(subscriber, mapping);

  const created: Link[] = [];
  const updated: Link[] = [];
  const unchanged: Link[] = [];
  const unmapped: Link[] = [];

  // Highest aggregator in use per group, so new instances do not collide.
  const nextAggregator = new Map<string, number>();
  for (const instance of existing) {
    const key = instance.key as string;
    const agg = typeof instance.aggregator === 'number' ? instance.aggregator : 0;
    nextAggregator.set(key, Math.max(nextAggregator.get(key) ?? 0, agg));
  }

  const wanted = new Set<string>();

  /**
   * Instances already assigned to a requested link in this pass.
   *
   * Without this, two requested links sharing a namespace and value but differing in qualifier
   * would both match the same instance and collapse into one — the second silently overwriting the
   * first. That is a supported input, and a real one: two sites of one domain billed as separate
   * accounts are two distinct links by the codec's own identity rule.
   */
  const claimed = new Set<Rec>();

  const specFor = (link: Link) => byNs.get(link.ns);
  const mappable = links.filter((l) => {
    const spec = specFor(l);
    if (!spec) {
      unmapped.push(l);
      return false;
    }
    wanted.add(identity(l));
    return true;
  });

  /**
   * The children to send for a link.
   *
   * Only the managed fields are named, because **child updates merge** — verified live: PUTting an
   * instance with one child named left the other two untouched. That is what keeps a hand-set
   * `Description` safe.
   *
   * The same merge behaviour means a qualifier cannot be removed by omitting it: the old value would
   * survive server-side while the derived `externalId` said there was none, and the two would drift.
   * So when a link drops its qualifier and the instance still has one, the field is explicitly
   * marked for deletion — an empty value is ignored, `operationType: 2` is not.
   */
  const childrenFor = (spec: GroupLinkSpec, link: Link, existing?: Rec): Rec[] => {
    const desired: Rec[] = [{ key: spec.valueField, value: link.value }];
    if (!spec.qualifierField) return desired;

    if (link.qualifier !== undefined) {
      desired.push({ key: spec.qualifierField, value: link.qualifier });
      return desired;
    }

    const currentQualifier = existing
      ? valueOf(fieldsOf(existing).get(spec.qualifierField))
      : undefined;
    if (currentQualifier !== undefined) {
      desired.push({
        key: spec.qualifierField,
        aggregator: existing?.aggregator,
        operationType: DELETE_OPERATION,
        attributeValuesInfo: { associateValues: [{ sequence: 1, value: currentQualifier }] },
      });
    }
    return desired;
  };

  const find = (spec: GroupLinkSpec, link: Link, exact: boolean) =>
    existing.find((instance) => {
      if (claimed.has(instance) || instance.key !== spec.group) return false;
      const fields = fieldsOf(instance);
      if (valueOf(fields.get(spec.valueField)) !== link.value) return false;
      if (!exact) return true;
      const q = spec.qualifierField ? valueOf(fields.get(spec.qualifierField)) : undefined;
      return q === link.qualifier;
    });

  // Pass 1: exact matches (value AND qualifier) claim their instance first, so a link that is
  // already correct never steals the instance belonging to a sibling that differs only in qualifier.
  const unresolved: Link[] = [];
  for (const link of mappable) {
    const spec = specFor(link)!;
    const match = find(spec, link, true);
    if (match) {
      claimed.add(match);
      unchanged.push(link);
    } else {
      unresolved.push(link);
    }
  }

  // Pass 2: a value-only match means the qualifier is what changed — edit in place.
  const toCreate: Link[] = [];
  for (const link of unresolved) {
    const spec = specFor(link)!;
    const match = find(spec, link, false);
    if (match) {
      claimed.add(match);
      match.childAttribute = childrenFor(spec, link, match);
      updated.push(link);
    } else {
      toCreate.push(link);
    }
  }

  // Pass 3: whatever is left needs a new instance.
  for (const link of toCreate) {
    const spec = specFor(link)!;
    const agg = (nextAggregator.get(spec.group) ?? 0) + 1;
    nextAggregator.set(spec.group, agg);
    const instance: Rec = {
      key: spec.group,
      aggregator: agg,
      childAttribute: childrenFor(spec, link),
    };
    claimed.add(instance);
    existing.push(instance);
    created.push(link);
  }

  const unlisted = existingLinks.filter((l) => !wanted.has(identity(l)));

  if (!opts.removeUnlisted) {
    return {
      attributes: existing,
      created,
      updated,
      unchanged,
      notRemoved: unlisted,
      removed: [],
      unmapped,
    };
  }

  // Mark each unlisted instance for deletion in OneBill's own shape.
  const doomed = new Set(unlisted.map((l) => `${l.group}#${l.aggregator}`));
  const attributes = existing.map((instance) => {
    const id = `${instance.key}#${instance.aggregator}`;
    if (!doomed.has(id)) return instance;
    return markForDeletion(instance);
  });

  return { attributes, created, updated, unchanged, notRemoved: [], removed: unlisted, unmapped };
}

function markForDeletion(instance: Rec): Rec {
  const aggregator = instance.aggregator;
  return {
    key: instance.key,
    aggregator,
    operationType: DELETE_OPERATION,
    childAttribute: ((instance.childAttribute as Rec[]) ?? []).map((child) => ({
      key: child.key,
      aggregator,
      operationType: DELETE_OPERATION,
      attributeValuesInfo: {
        associateValues: [{ sequence: 1, value: child.value ?? '' }],
      },
    })),
  };
}
