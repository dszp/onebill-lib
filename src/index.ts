/**
 * `@dszp/onebill-lib` — a portable, Node-free toolkit for the OneBill billing API.
 *
 * Runs unchanged in a Cloudflare Worker, Node, or the browser: Web APIs only, no dependencies, and
 * `fetch` is injectable.
 *
 * Typical use:
 *
 * ```ts
 * import { OneBillReadClient, parseExternalId, buildLinkIndex, findByValue } from '@dszp/onebill-lib';
 *
 * const client = new OneBillReadClient({
 *   tenantId: 'tenant-0000',
 *   clientSecret: '...',
 *   username: 'api@example.com',
 *   password: '...',
 * });
 *
 * const subscribers = await client.listAllSubscribers();
 * const index = buildLinkIndex(subscribers, { ns: 'PBX' });
 * findByValue(index, 'acme.12345.service'); // who bills for this, across all sub-units
 * ```
 *
 * READ-ONLY BOUNDARY: the raw transport `OneBillHttp` is deliberately **not** exported. The
 * read-only guarantee of `OneBillReadClient` rests on it having no mutating method and no reachable
 * transport underneath; exporting the transport would let a consumer bypass that in one line, so
 * don't. Its config type and error class are exported, because those are needed to construct a
 * client and to catch failures.
 *
 * NAMESPACE POLICY: the link codec ships **no namespace constants**. `PBX` and `CRM` throughout
 * these docs are illustrative placeholders for namespaces you define; supply a `NamespaceRegistry`
 * from your own configuration if you want them validated. A built-in namespace would bind this
 * library to one deployment's integrations.
 */

// Transport-level types and errors (but NOT the transport class — see the boundary note above).
export {
  OneBillApiError,
  assertBaseUrl,
  type CachedToken,
  type OneBillHttpConfig,
  type TokenCache,
} from './http.js';

// Clients. Read and write are two classes over one private transport — see the boundary note above.
export {
  ALL_ORDER_STATE_FILTERS,
  DEFAULT_LIST_STATUSES,
  ORDER_STATE_FILTERS,
  OneBillInvoiceNotFoundError,
  OneBillNoQuoteDocumentError,
  OneBillReadClient,
  SUBSCRIBER_STATUSES,
  type OneBillReadClientConfig,
} from './readClient.js';
export {
  OneBillInactiveAccountError,
  OneBillWriteClient,
  OneBillWriteVerificationError,
  type OneBillWriteClientConfig,
  type SetExternalIdOptions,
  type SetExternalIdResult,
  type SetLinksResult,
} from './writeClient.js';

// Domain types, plus the pure accessors over them.
export {
  hasTaxExemptionCode,
  invoicePdfBytes,
  isQuoteOrder,
  orderStateOf,
  quotePdfBytes,
  subscriberDocumentBytes,
  taxExemptionCodesOf,
  taxJurisdictionsOf,
} from './model.js';
export type {
  Invoice,
  InvoiceDetail,
  InvoiceDocumentResponse,
  InvoicePdf,
  InvoiceSearchOptions,
  InvoiceSearchPage,
  Order,
  OrderSearchOptions,
  OrderSearchPage,
  PricePlanInfo,
  Product,
  ProductSummary,
  ProductsResponse,
  QuoteDocument,
  QuoteDocumentResponse,
  Rec,
  Subscriber,
  SubscriberAddress,
  SubscriberDocument,
  SubscriberDocumentsResponse,
  SubscriberSearchOptions,
  SubscriberSearchPage,
  Subscription,
  SubscriptionCharge,
  SubscriptionOffer,
  SubscriptionsResponse,
  TaxExemptionCode,
  TaxExemptionCodes,
} from './model.js';

// The catalogue index: joins a price plan's NAME (all a subscription line carries) to its plan and
// product codes. Pure — built from `listProducts`/`getProduct` results, fetches nothing itself.
export {
  buildCatalogIndex,
  catalogLookup,
  type CatalogEntry,
  type CatalogIndex,
} from './catalog.js';

// The link codec.
export {
  DEFAULT_MAX_LENGTH,
  OneBillInvalidLinkError,
  OneBillLinkTooLongError,
  canonicalize,
  emptyLinks,
  fits,
  formatExternalId,
  linkToToken,
  linksFor,
  measureLength,
  parseExternalId,
  removeLink,
  upsertLink,
  validate,
  type Link,
  type NamespaceRegistry,
  type NamespaceSpec,
  type ParsedLinks,
} from './link.js';

// Custom-field group <-> link mapping.
export {
  attributesToLinks,
  buildLinkSet,
  linksToAttributes,
  type AttributePlan,
  type GroupLinkSpec,
  type LinkMapping,
  type SourcedLink,
} from './attributes.js';

// The subscriber <-> target index.
export {
  buildLinkIndex,
  findByAccount,
  findByTarget,
  findByValue,
  targetKey,
  type BuildLinkIndexOptions,
  type LinkConflict,
  type LinkIndex,
  type LinkProblem,
  type SubscriberRef,
} from './linkIndex.js';

// Usage-subscription reconciliation. Pure functions over records — fetches nothing, writes nothing.
export {
  USAGE_VERDICT_SEVERITY,
  bySeverity,
  findUsageSubscriptions,
  proposeMappings,
  reconcileUsageSubscriptions,
  type MappingCandidate,
  type MappingConfidence,
  type MappingProposal,
  type ProposeMappingsOptions,
  type ReconcileUsageOptions,
  type UsageReconcileRow,
  type UsageReconciliation,
  type UsageSubscriptionMatch,
  type UsageSubscriptionScan,
  type UsageSubscriptionSpec,
  type UsageVerdict,
} from './usage.js';

// Recurring-subscription reconciliation. Pure functions over records — fetches nothing, writes nothing.
export {
  compareRecurring,
  ruleKeyOf,
  type ComparisonCredit,
  type ComparisonItem,
  type ComparisonRow,
  type CompareRecurringInput,
  type GroupAcceptance,
  type GroupBaseline,
  type IgnoredOffer,
  type ItemAcceptance,
  type RecurringComparison,
  type RecurringRule,
  type RecurringVerdict,
  type UnmappedOffer,
} from './recurring.js';

// Reading the input for reconciliation. The only I/O in this area — the layers above are pure.
export {
  gatherUsageRows,
  type GatherFailure,
  type GatherResult,
  type GatherUsageRowsOptions,
  type UsageReadSource,
} from './gather.js';

// Invoice detail. Pure functions over a record from `getInvoiceDetail` - fetches nothing.
export {
  findDuplicateCalls,
  findRepeatedCalls,
  flattenInvoice,
  invoiceCallKey,
  reconcileInvoice,
  taxTotalsByDescription,
  taxTotalsByJurisdiction,
  type DuplicateCallMatch,
  type DuplicateCallReport,
  type FlatInvoice,
  type InvoiceCall,
  type InvoiceChargeLine,
  type InvoiceReconciliation,
  type InvoiceSurcharge,
  type InvoiceTaxLine,
  type RepeatedCallGroup,
} from './invoice.js';
