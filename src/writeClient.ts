import {
  attributesToLinks,
  buildLinkSet,
  linksToAttributes,
  type LinkMapping,
  type SourcedLink,
} from './attributes.js';
import { OneBillHttp, type OneBillHttpConfig } from './http.js';
import { assertPathSegment } from './readClient.js';
import { canonicalize, formatExternalId, parseExternalId, type Link } from './link.js';
import type { Rec, Subscriber } from './model.js';

/**
 * The one write this library performs, and the empirical facts that shape it.
 *
 * All verified live against a OneBill tenant on 2026-07-31:
 *
 * 1. **A partial PUT is not safe.** Sending `{externalId}` alone to
 *    `PUT /rest/SubscriberService/v1/subscribers/{acct}` returned 200 and set the field — and also
 *    wiped `quoteTemplateName` and populated `accountOwnerId`. Fields you do not send are not
 *    reliably left alone.
 * 2. **A full read-modify-write IS safe.** Reading the record, changing one field, and PUTting the
 *    whole thing back changed nothing but the intended field. That is why this client always reads
 *    first, and why it is not merely being cautious.
 * 3. **Clearing needs `fieldsToRemove`.** Sending an empty string, `null`, or a space as the value
 *    is treated as "not provided": 200, and the old value survives. Naming the field in a
 *    `fieldsToRemove` array does clear it. That array is what OneBill's own web UI sends, and it
 *    works on this public endpoint too, not just the UI's private one.
 * 4. **The 64-character limit is enforced server-side**, by code point, and the write is rejected
 *    *wholesale* — `10PA1166`, delivered as an in-band error at HTTP 200. Nothing is truncated, so a
 *    failed write leaves the previous value intact.
 */

export type OneBillWriteClientConfig = OneBillHttpConfig;

/** Fields expected to move on any successful write, and therefore not counted as collateral. */
const EXPECTED_TO_CHANGE = new Set(['externalId', 'lastModifiedDate']);

/**
 * Serialise a value so that two responses carrying the same data compare equal, regardless of the
 * order the API happened to return things in.
 *
 * Object keys are sorted, and **arrays are sorted by their own normalised form**. That second part
 * matters: OneBill returns nested collections in a non-deterministic order — a custom-field group's
 * `childAttribute` came back as Description/Domain/Site on one read and Domain/Site/Description on
 * the next, with identical ids and values. A plain `JSON.stringify` comparison flags that as a
 * change, which would report phantom collateral damage on every write to any account using custom
 * fields, and would make `strict` mode throw on all of them.
 *
 * Treating arrays as unordered is the right semantics here specifically because the question being
 * asked is "did any data change", not "did anything move". A pure reordering is not damage.
 */
function normalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(normalize).sort().join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${JSON.stringify(k)}:${normalize(v)}`)
      .sort();
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Response-envelope keys that are not settable fields and must not be echoed back on a PUT. */
/**
 * Fields stripped from the read-modify-write PUT body.
 *
 * `status` is the response envelope's own key, not a settable field.
 *
 * `payInfo` is stripped because **the API will not accept back what it just gave you**. A stored
 * card is read out masked — `cardNumber: "**** **** **** 0000"` — and echoing that mask makes
 * OneBill validate it as a real number, failing the whole write in-band at HTTP 200 with
 * `10CM1014 Invalid credit card number`, `10CM1066 Invalid Card Type`, and
 * `10CM1046 Card CVV Number is mandatory`. Nothing about the write concerns payment, and the
 * account is left untouched — but every account with a card on file is unwritable until this is
 * removed, which on a normal tenant is most of them.
 *
 * **Omitting it is safe here, and that is not the general rule.** A partial PUT to this endpoint is
 * destructive — see ARCHITECTURE.md — so dropping a field is normally how you lose it. `payInfo` was
 * verified live on a disposable account 2026-09-02: with it omitted, the write succeeds and the
 * payment profile comes back byte-identical, profile id, reference key, masked number, expiry,
 * address and status all intact. It is managed through its own endpoints and does not round-trip
 * through this one.
 *
 * Anything added here needs the same treatment: prove the field survives its own omission, on an
 * account you can afford to break.
 */
const NOT_SETTABLE = new Set(['status', 'payInfo']);

/** Does this custom-field child hold any actual value? */
function childHasValue(child: unknown): boolean {
  if (typeof child !== 'object' || child === null) return false;
  const c = child as { value?: unknown; attributeValuesInfo?: { associateValues?: unknown } };
  if (c.value !== undefined && c.value !== null && String(c.value).trim() !== '') return true;
  const associated = c.attributeValuesInfo?.associateValues;
  return (
    Array.isArray(associated) &&
    associated.some(
      (v) =>
        typeof v === 'object' &&
        v !== null &&
        (v as { value?: unknown }).value !== undefined &&
        String((v as { value?: unknown }).value).trim() !== '',
    )
  );
}

/**
 * Drop custom-field group instances in which every field is blank.
 *
 * OneBill materialises a **blank instance of every declared group** onto every record, so a record
 * that has never been touched still comes back carrying an empty group. Echo one of those back on a
 * PUT and the write is rejected outright if any field in the group is Mandatory:
 *
 *     Bad Request: Account Attribute value is mandatory for <field>.
 *
 * That would block writes on every account not yet populated — precisely the bulk-population case
 * the write path exists for. Verified live: with a Mandatory field in an empty group, the PUT fails;
 * with the empty instance removed, it succeeds.
 *
 * Dropping them loses nothing, because an instance with no values carries no information — and it is
 * also the intended semantics: a group with no data should not exist on the record. A **partially**
 * filled instance is kept, since blank optional fields beside a populated one are meaningful.
 */
function stripEmptyAttributeGroups(attributes: unknown): unknown {
  if (!Array.isArray(attributes)) return attributes;
  return attributes.filter((row) => {
    const children = (row as { childAttribute?: unknown })?.childAttribute;
    // Not a group (no children) — leave it alone; this function only understands groups.
    if (!Array.isArray(children) || children.length === 0) return true;
    return children.some(childHasValue);
  });
}

/** What happened during a {@link OneBillWriteClient.setSubscriberExternalId} call. */
export interface SetExternalIdResult {
  accountNumber: string;
  /** The value before the write. */
  previous: string;
  /** The value asked for. */
  requested: string;
  /** The value present after the write, read back from the API. */
  stored: string;
  /** Whether the stored value differs from the previous one. */
  changed: boolean;
  /**
   * Field names other than `externalId` and `lastModifiedDate` that differed after the write.
   *
   * Expected to be empty. **Check it anyway**: a non-empty list means the endpoint's behaviour has
   * shifted from what was verified, and something was modified that nobody asked to modify.
   */
  collateral: string[];
  /** True when nothing was actually sent. */
  dryRun: boolean;
}

/** Thrown when a write did not produce the value that was asked for. */
export class OneBillWriteVerificationError extends Error {
  constructor(
    message: string,
    public readonly result: SetExternalIdResult,
  ) {
    super(message);
    this.name = 'OneBillWriteVerificationError';
  }
}

/** Thrown when a write targets an account whose status makes it off-limits by default. */
export class OneBillInactiveAccountError extends Error {
  constructor(
    message: string,
    public readonly accountNumber: string,
    /** The account's status, e.g. `Closed`. */
    public readonly accountStatus: string,
  ) {
    super(message);
    this.name = 'OneBillInactiveAccountError';
  }
}

/** Statuses a write is permitted to touch unless the caller opts in explicitly. */
const WRITABLE_STATUSES = new Set(['Active']);

/** What a {@link OneBillWriteClient.setSubscriberLinks} call did. */
export interface SetLinksResult {
  accountNumber: string;
  /** Group instances created. */
  created: Link[];
  /** Group instances edited in place. */
  updated: Link[];
  /** Links already present and correct. */
  unchanged: Link[];
  /**
   * Links present in OneBill that the caller did not ask for, and which were **left in place**
   * because `removeUnlisted` was not set.
   *
   * Non-empty here means the record carries links you did not request — check it rather than
   * assuming the record now matches your input.
   */
  notRemoved: SourcedLink[];
  /** Links deleted because `removeUnlisted` was set. */
  removed: SourcedLink[];
  /** Requested links whose namespace is not in the mapping; nothing was written for them. */
  unmapped: Link[];
  /**
   * Links already in `externalId` whose namespace this mapping does not cover, **preserved**.
   *
   * They live outside the groups this call manages — another integration's, typically — so they are
   * carried into the derived `externalId` untouched rather than erased.
   */
  carriedOver: Link[];
  /** The `externalId` derived from the resulting link set and written in the same request. */
  externalId: string;
  /** The previous `externalId`. */
  previousExternalId: string;
  /** Unrelated fields that moved. Expected empty. */
  collateral: string[];
  /** True when nothing was sent. */
  dryRun: boolean;
}

export interface SetExternalIdOptions {
  /** Read and compute the write, but send nothing. The result reports what would have happened. */
  dryRun?: boolean;
  /**
   * Also throw when unrelated fields changed, not just when verification failed. Off by default
   * because the write still succeeded; on when you would rather stop than proceed on a surprise.
   */
  strict?: boolean;
  /**
   * Delete link-bearing group instances that were not requested, so the record matches the input.
   *
   * Off by default: it destroys data a human may have entered by hand. Only meaningful for
   * `setSubscriberLinks`.
   */
  removeUnlisted?: boolean;
  /**
   * Permit writing to an account that is not `Active` — a closed or inactive one.
   *
   * Off by default. A bulk job iterating a subscriber list and writing should not modify a closed
   * account by accident, and the account's status is already in hand from the read this method
   * performs anyway, so the check is free. Set this when you genuinely mean to touch one.
   */
  allowNonActive?: boolean;
}

/**
 * Writes to OneBill.
 *
 * A separate class from {@link OneBillReadClient} over the same private transport, so that holding a
 * read client remains proof you cannot write. New write capability belongs here or on a sibling —
 * never on the read client.
 */
export class OneBillWriteClient {
  readonly #http: OneBillHttp;

  constructor(cfg: OneBillWriteClientConfig) {
    this.#http = new OneBillHttp(cfg);
  }

  #path(accountNumber: string): string {
    return `/rest/SubscriberService/v1/subscribers/${assertPathSegment(accountNumber, 'account number')}`;
  }

  /**
   * Set a subscriber's `externalId`, then read it back and prove it took.
   *
   * Performs a full read-modify-write: the entire record is fetched and PUT back with only this one
   * field altered. A partial PUT is measurably destructive on this endpoint — see the note at the
   * top of this file.
   *
   * Pass an empty string to clear the field. That is handled specially: a blank value on its own is
   * ignored by the API, so the request also names the field in `fieldsToRemove`, which is how
   * OneBill's own UI clears it.
   *
   * The read-back is not optional politeness. Several APIs in this space acknowledge a write and
   * silently discard it — and this one does exactly that for a blank value without the removal
   * hint — so a write that is not verified is a write you cannot claim happened.
   *
   * @throws {OneBillWriteVerificationError} if the value read back is not the value requested.
   * @throws {OneBillApiError} for a server-side rejection, including an over-length value
   *   (`10PA1166`). Format the string with `formatExternalId` first to fail before the round trip.
   */
  async setSubscriberExternalId(
    accountNumber: string,
    externalId: string,
    opts: SetExternalIdOptions = {},
  ): Promise<SetExternalIdResult> {
    const path = this.#path(accountNumber);
    const before = await this.#http.request<Subscriber>('GET', path);
    const previous = before.externalId ?? '';

    // Refuse a closed or inactive account unless the caller said so. The status is already in hand
    // from the read this method has to do anyway, so guarding here costs nothing — and here is where
    // the risk actually is, rather than in the read that merely listed the account.
    const status = before.accountStatus;
    if (!opts.allowNonActive && typeof status === 'string' && !WRITABLE_STATUSES.has(status)) {
      throw new OneBillInactiveAccountError(
        `Refusing to write to ${accountNumber}: its status is ${status}, not Active. ` +
          `Pass { allowNonActive: true } if that is intended.`,
        accountNumber,
        status,
      );
    }

    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(before)) {
      if (NOT_SETTABLE.has(k)) continue;
      body[k] = k === 'accountAttribute' ? stripEmptyAttributeGroups(v) : v;
    }

    if (externalId === '') {
      // A blank value alone is read as "field not supplied" and leaves the old value in place.
      // `fieldsToRemove` is the explicit removal channel, and is what the OneBill UI sends.
      body.externalId = null;
      body.fieldsToRemove = ['externalId'];
    } else {
      body.externalId = externalId;
    }

    if (opts.dryRun) {
      return {
        accountNumber,
        previous,
        requested: externalId,
        stored: previous,
        changed: false,
        collateral: [],
        dryRun: true,
      };
    }

    await this.#http.request('PUT', path, { body });

    const after = await this.#http.request<Subscriber>('GET', path);
    const stored = after.externalId ?? '';

    const collateral: string[] = [];
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (EXPECTED_TO_CHANGE.has(key) || NOT_SETTABLE.has(key)) continue;
      if (normalize(before[key]) !== normalize(after[key])) collateral.push(key);
    }
    collateral.sort();

    const result: SetExternalIdResult = {
      accountNumber,
      previous,
      requested: externalId,
      stored,
      changed: stored !== previous,
      collateral,
      dryRun: false,
    };

    if (stored !== externalId) {
      throw new OneBillWriteVerificationError(
        `externalId on ${accountNumber} did not take: asked for ${JSON.stringify(externalId)}, ` +
          `read back ${JSON.stringify(stored)}`,
        result,
      );
    }

    if (opts.strict && collateral.length > 0) {
      throw new OneBillWriteVerificationError(
        `Write to ${accountNumber} succeeded but also changed ${collateral.length} unrelated ` +
          `field(s): ${collateral.join(', ')}`,
        result,
      );
    }

    return result;
  }

  /**
   * Set a subscriber's links: write the custom-field groups, and write the `externalId` derived
   * from them, in a **single request**.
   *
   * This is the method that makes "the groups are the truth, `externalId` is a derived index" real
   * rather than aspirational. The two can't drift between calls because there is only one call —
   * atomicity falls out of the full read-modify-write that OneBill's destructive partial PUT forces
   * on us anyway.
   *
   * Behaviour worth knowing before relying on it:
   *
   * - **Nothing is deleted unless you ask.** Links already on the record that you did not request
   *   are left alone and reported in {@link SetLinksResult.notRemoved} — so by default this method
   *   adds and updates but never removes, and the record can hold more than you passed. Pass
   *   `{ removeUnlisted: true }` to make the record *match* your input; what went is reported in
   *   {@link SetLinksResult.removed}.
   * - **Existing instances are edited in place**, matched on namespace + value, keeping their
   *   `aggregator` and any fields this mapping doesn't manage. New instances get the next free
   *   `aggregator`, which the API requires the caller to assign.
   * - **`externalId` is derived from the resulting link set**, canonicalised so the same links always
   *   produce the same string. It is not taken from the caller.
   * - Unknown tokens already in `externalId` are **preserved**, since the codec never discards them.
   *
   * @throws {OneBillLinkTooLongError} if the derived string exceeds the field limit — nothing is
   *   written, so the record is left consistent and the caller can move a link to an overflow store.
   */
  async setSubscriberLinks(
    accountNumber: string,
    links: readonly Link[],
    mapping: LinkMapping,
    opts: SetExternalIdOptions = {},
  ): Promise<SetLinksResult> {
    const path = this.#path(accountNumber);
    const before = await this.#http.request<Subscriber>('GET', path);
    const previousExternalId = before.externalId ?? '';

    const status = before.accountStatus;
    if (!opts.allowNonActive && typeof status === 'string' && !WRITABLE_STATUSES.has(status)) {
      throw new OneBillInactiveAccountError(
        `Refusing to write to ${accountNumber}: its status is ${status}, not Active. ` +
          `Pass { allowNonActive: true } if that is intended.`,
        accountNumber,
        status,
      );
    }

    const plan = linksToAttributes(before, links, mapping, {
      removeUnlisted: opts.removeUnlisted,
    });

    // Derive externalId from what the record will actually hold, which is the requested links plus
    // anything that could not be removed — not from the caller's list alone.
    const resulting = buildLinkSet([
      ...attributesToLinks({ ...before, accountAttribute: plan.attributes }, mapping),
    ]);

    // Carry forward links whose namespace this mapping knows nothing about.
    //
    // Without this, rebuilding externalId from the mapped groups alone ERASES them: a `CRM:` token
    // vanishes the first time a PBX-only sync runs, silently and with no verification failure,
    // because it parses fine and so never lands in `unknown`. Two integrations each calling this
    // with only their own mapping would delete each other's links on every run. That is the
    // never-lose-a-token invariant broken for tokens that *do* parse, which is worse than for the
    // ones that don't.
    const parsed = parseExternalId(previousExternalId);
    const mappedNamespaces = new Set(mapping.map((m) => m.ns));
    const carriedOver = parsed.links.filter((l) => !mappedNamespaces.has(l.ns));

    const derived = canonicalize({ ...parsed, links: [...resulting, ...carriedOver] });
    // Throws before anything is sent if it will not fit.
    const externalId = formatExternalId(derived);

    if (opts.dryRun) {
      return {
        accountNumber,
        created: plan.created,
        updated: plan.updated,
        unchanged: plan.unchanged,
        notRemoved: plan.notRemoved,
        removed: plan.removed,
        unmapped: plan.unmapped,
        carriedOver,
        externalId,
        previousExternalId,
        collateral: [],
        dryRun: true,
      };
    }

    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(before)) {
      if (NOT_SETTABLE.has(k)) continue;
      body[k] = v;
    }
    body.accountAttribute = stripEmptyAttributeGroups(plan.attributes);
    if (externalId === '') {
      body.externalId = null;
      body.fieldsToRemove = ['externalId'];
    } else {
      body.externalId = externalId;
    }

    await this.#http.request('PUT', path, { body });

    const after = await this.#http.request<Subscriber>('GET', path);
    const storedExternalId = after.externalId ?? '';

    const collateral: string[] = [];
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (EXPECTED_TO_CHANGE.has(key) || NOT_SETTABLE.has(key) || key === 'accountAttribute') continue;
      if (normalize(before[key]) !== normalize(after[key])) collateral.push(key);
    }
    collateral.sort();

    if (storedExternalId !== externalId) {
      throw new OneBillWriteVerificationError(
        `externalId on ${accountNumber} did not take: derived ${JSON.stringify(externalId)}, ` +
          `read back ${JSON.stringify(storedExternalId)}`,
        {
          accountNumber,
          previous: previousExternalId,
          requested: externalId,
          stored: storedExternalId,
          changed: storedExternalId !== previousExternalId,
          collateral,
          dryRun: false,
        },
      );
    }

    // Prove every requested link is actually on the record now.
    const actual = new Set(
      buildLinkSet(attributesToLinks(after, mapping)).map(
        (l) => `${l.ns}:${l.value}/${l.qualifier ?? ''}`,
      ),
    );
    const missing = links.filter(
      (l) => !plan.unmapped.includes(l) && !actual.has(`${l.ns}:${l.value}/${l.qualifier ?? ''}`),
    );
    // Deletion rides an undocumented mechanism lifted from the UI's private endpoint. If the public
    // endpoint ever stops honouring it, externalId (already written without these links) would
    // disagree with the groups -- the documented source of truth -- and nothing would notice.
    const survived = plan.removed.filter((l) =>
      actual.has(`${l.ns}:${l.value}/${l.qualifier ?? ''}`),
    );
    if (survived.length > 0) {
      throw new OneBillWriteVerificationError(
        `${survived.length} link(s) were meant to be removed from ${accountNumber} but are still ` +
          `present: ${survived.map((l) => `${l.ns}:${l.value}`).join(', ')}`,
        {
          accountNumber,
          previous: previousExternalId,
          requested: externalId,
          stored: storedExternalId,
          changed: true,
          collateral,
          dryRun: false,
        },
      );
    }

    if (missing.length > 0) {
      throw new OneBillWriteVerificationError(
        `${missing.length} link(s) were not present after writing ${accountNumber}: ` +
          missing.map((l) => `${l.ns}:${l.value}`).join(', '),
        {
          accountNumber,
          previous: previousExternalId,
          requested: externalId,
          stored: storedExternalId,
          changed: true,
          collateral,
          dryRun: false,
        },
      );
    }

    return {
      accountNumber,
      created: plan.created,
      updated: plan.updated,
      unchanged: plan.unchanged,
      notRemoved: plan.notRemoved,
      removed: plan.removed,
      unmapped: plan.unmapped,
      carriedOver,
      externalId: storedExternalId,
      previousExternalId,
      collateral,
      dryRun: false,
    };
  }
}
