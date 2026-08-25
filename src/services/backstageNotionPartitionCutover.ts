import { createHash } from 'node:crypto';

import { logger } from '@platform/logging/structuredLogging.js';
import { getEnv } from '@platform/runtime/env.js';
import {
  BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE_ENV_NAME,
  BACKSTAGE_NOTION_PARTITIONS_ENV_NAME,
  parseBackstageNotionPartitionConfiguration,
  parseBackstageNotionPartitionedIndexMode,
  resolveBackstageNotionPartitionUniverse,
} from '@shared/backstage/backstageNotionPartitionCore.js';
import {
  BACKSTAGE_NOTION_PARTITION_ROUTING_MAX_SELECTORS,
  type BackstageNotionPartitionRoutingIntent,
  type BackstageNotionPartitionRoutingSelector,
} from '@shared/backstage/backstageNotionPartitionRoutingCore.js';
import {
  resolveBackstageNotionBookingScopePlan,
} from '@shared/backstage/backstageNotionBookingScope.js';
import {
  MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH,
  MIN_PURPOSE_BOUND_CREDENTIAL_LENGTH,
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
  resolveConfiguredPurposeBoundCredential,
  type PurposeBoundCredentialEnvName,
  type PurposeBoundCredentialEnvironmentReader,
} from '@shared/security/purposeBoundCredential.js';
import {
  isBackstageNotionEnrichmentAuthorized,
  isBackstageProtectedQueuedExecution,
} from './backstageNotionEnrichmentAuthorization.js';
import {
  BackstageNotionIndexUnavailableError,
  retrieveBackstageNotionBookingRagContext,
  retrieveBackstageNotionRagContext,
  type BackstageNotionRagQuery,
  type BackstageNotionRagRetrieval,
  type BackstageNotionRagRetrievalDependencies,
} from './backstageNotionRag.js';
import {
  retrieveBackstageNotionPartitionRagContext,
  type BackstageNotionPartitionRagRetrieval,
  type BackstageNotionPartitionRetrievalDependencies,
  type BackstageNotionPartitionRetrievalPlan,
} from './backstageNotionPartitionRetrieval.js';
import { createEmbedding } from './openai/embeddings.js';

export const BACKSTAGE_NOTION_PARTITION_CURSOR_SECRET_ENV_NAME =
  'ARCANOS_BACKSTAGE_NOTION_PARTITION_CURSOR_SECRET' as const;
export const BACKSTAGE_NOTION_PARTITION_CURSOR_PREVIOUS_SECRET_ENV_NAME =
  'ARCANOS_BACKSTAGE_NOTION_PARTITION_CURSOR_PREVIOUS_SECRET' as const;
export const BACKSTAGE_NOTION_PARTITION_SHADOW_MAX_IN_FLIGHT = 4;
export const BACKSTAGE_NOTION_PARTITION_MAX_QUERY_YEARS = 8;

const QUERY_YEAR_PATTERN = /\b(?:19|20|21)\d{2}\b/gu;
const EXPLICIT_ARCHIVE_PATTERN = /\b(?:archive|archives|archived)\b/iu;
const PLE_LANE_PATTERN = /\b(?:ple|premium\s+live\s+events?|pay[-\s]+per[-\s]+view|ppv|wrestlemania|royal\s+rumble|summerslam|survivor\s+series|money\s+in\s+the\s+bank|elimination\s+chamber|backlash|night\s+of\s+champions|crown\s+jewel|clash\s+at\s+the\s+castle)\b/iu;
const MAX_ROUTING_QUERY_CODE_UNITS = 64_000;
const QUERY_REQUEST_KEYS = new Set([
  'cursor',
  'mode',
  'query',
  'retrievalMode',
  'retrievalScope',
]);

type ReadEnvironment = (name: string) => string | undefined;
type MonolithRetriever = (
  universeId: string,
  query: BackstageNotionRagQuery,
  dependencies?: BackstageNotionRagRetrievalDependencies
) => Promise<BackstageNotionRagRetrieval>;
type BookingMonolithRetriever = (
  universeId: string,
  query: string,
  dependencies?: BackstageNotionRagRetrievalDependencies
) => Promise<BackstageNotionRagRetrieval>;
type PartitionRetriever = (
  universeId: string,
  plan: BackstageNotionPartitionRetrievalPlan,
  dependencies?: BackstageNotionPartitionRetrievalDependencies
) => Promise<BackstageNotionPartitionRagRetrieval>;
type SafeLogValue = string | number | boolean | null;
type SafeLogMetadata = Readonly<Record<string, SafeLogValue>>;
type LogInfo = (event: string, metadata: SafeLogMetadata) => void;

export type BackstageNotionAuthorityRagRetrieval =
  | BackstageNotionRagRetrieval
  | BackstageNotionPartitionRagRetrieval;

export interface BackstageNotionPartitionCutoverDependencies {
  readonly isAuthorized?: () => boolean;
  readonly isProtectedQueuedExecution?: () => boolean;
  readonly readEnvironment?: ReadEnvironment;
  readonly retrieveMonolith?: MonolithRetriever;
  readonly retrieveBookingMonolith?: BookingMonolithRetriever;
  readonly retrievePartition?: PartitionRetriever;
  readonly embedQuery?: (query: string) => Promise<number[]>;
  readonly logInfo?: LogInfo;
}

interface PartitionActivation {
  readonly cursorSecret?: string;
  readonly previousCursorSecret?: string;
}

interface PartitionRequestPlan {
  readonly plan: BackstageNotionPartitionRetrievalPlan;
  readonly hasCursor: boolean;
  readonly requiresCursorSecret: boolean;
}

interface ShadowSlot {
  readonly release: () => void;
}

interface ShadowComparisonBaseline {
  readonly promptDigest: string;
  readonly citationShapeDigest: string;
  readonly retrievalMode: BackstageNotionRagRetrieval['retrievalMode'];
  readonly chunkCount: number;
  readonly truncated: boolean;
  readonly coverageStatus: BackstageNotionRagRetrieval['coverage']['status'];
  readonly citationCount: number;
}

let activeShadowComparisons = 0;

function isSupportedCursorSecret(value: string | null): value is string {
  if (!value || /\s/u.test(value)) {
    return false;
  }
  const bytes = Buffer.byteLength(value, 'utf8');
  return bytes >= MIN_PURPOSE_BOUND_CREDENTIAL_LENGTH
    && bytes <= MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH;
}

function readDataFunction<T extends (...args: never[]) => unknown>(
  value: object,
  key: PropertyKey
): T | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value')
    && typeof descriptor.value === 'function'
    ? descriptor.value as T
    : undefined;
}

function requireAuthorization(
  dependencies: BackstageNotionPartitionCutoverDependencies
): void {
  const resolveAuthorization = readDataFunction<() => boolean>(
    dependencies,
    'isAuthorized'
  ) ?? isBackstageNotionEnrichmentAuthorized;
  let authorized = false;
  try {
    authorized = resolveAuthorization() === true;
  } catch {
    authorized = false;
  }
  if (!authorized) {
    throw new BackstageNotionIndexUnavailableError();
  }
}

function resolveProtectedQueuedExecution(
  dependencies: BackstageNotionPartitionCutoverDependencies
): boolean {
  const resolver = readDataFunction<() => boolean>(
    dependencies,
    'isProtectedQueuedExecution'
  ) ?? isBackstageProtectedQueuedExecution;
  try {
    return resolver() === true;
  } catch {
    return false;
  }
}

function readModeOnce(readEnvironment: ReadEnvironment) {
  let rawMode: string | undefined;
  try {
    rawMode = readEnvironment(
      BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE_ENV_NAME
    );
  } catch {
    rawMode = undefined;
  }
  return parseBackstageNotionPartitionedIndexMode(rawMode);
}

function acquireShadowSlot(): ShadowSlot | null {
  if (
    activeShadowComparisons
      >= BACKSTAGE_NOTION_PARTITION_SHADOW_MAX_IN_FLIGHT
  ) {
    return null;
  }
  activeShadowComparisons += 1;
  let released = false;
  return Object.freeze({
    release: () => {
      if (released) {
        return;
      }
      released = true;
      activeShadowComparisons = Math.max(0, activeShadowComparisons - 1);
    },
  });
}

function safeLog(
  dependencies: BackstageNotionPartitionCutoverDependencies,
  event: string,
  metadata: SafeLogMetadata
): void {
  try {
    const injected = readDataFunction<LogInfo>(dependencies, 'logInfo');
    if (injected) {
      injected(event, metadata);
      return;
    }
    logger.info(event, metadata);
  } catch {
    // Shadow diagnostics must never change the authoritative response.
  }
}

function createLazyQueryBoundEmbedding(
  embedQuery: (query: string) => Promise<number[]>
): (query: string) => Promise<number[]> {
  let boundQuery: string | undefined;
  let embedding: Promise<number[]> | undefined;
  return query => {
    if (boundQuery === undefined) {
      boundQuery = query;
      embedding = Promise.resolve().then(() => embedQuery(query));
    } else if (query !== boundQuery) {
      throw new BackstageNotionIndexUnavailableError();
    }
    return embedding!;
  };
}

function readCredentialSnapshot(
  readEnvironment: ReadEnvironment
): ReadonlyMap<PurposeBoundCredentialEnvName, string | undefined> | null {
  const snapshot = new Map<
    PurposeBoundCredentialEnvName,
    string | undefined
  >();
  try {
    for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
      snapshot.set(environmentName, readEnvironment(environmentName));
    }
  } catch {
    return null;
  }
  return snapshot;
}

function resolvePartitionActivation(
  universeId: string,
  readEnvironment: ReadEnvironment,
  requireCursorSecret: boolean
): PartitionActivation | null {
  let rawConfiguration: string | undefined;
  try {
    rawConfiguration = readEnvironment(BACKSTAGE_NOTION_PARTITIONS_ENV_NAME);
  } catch {
    return null;
  }
  const configuration = parseBackstageNotionPartitionConfiguration(
    rawConfiguration
  );
  if (!resolveBackstageNotionPartitionUniverse(configuration, universeId)) {
    return null;
  }
  if (!requireCursorSecret) {
    return Object.freeze({});
  }

  const credentialSnapshot = readCredentialSnapshot(readEnvironment);
  if (!credentialSnapshot) {
    return null;
  }
  const snapshotReader: PurposeBoundCredentialEnvironmentReader =
    environmentName => credentialSnapshot.get(environmentName);
  const cursorSecret = resolveConfiguredPurposeBoundCredential({
    ownEnvironmentName: BACKSTAGE_NOTION_PARTITION_CURSOR_SECRET_ENV_NAME,
    readEnvironmentValue: snapshotReader,
  });
  const rawPreviousSecret = credentialSnapshot.get(
    BACKSTAGE_NOTION_PARTITION_CURSOR_PREVIOUS_SECRET_ENV_NAME
  );
  const previousCursorSecret = resolveConfiguredPurposeBoundCredential({
    ownEnvironmentName:
      BACKSTAGE_NOTION_PARTITION_CURSOR_PREVIOUS_SECRET_ENV_NAME,
    readEnvironmentValue: snapshotReader,
  });
  if (
    !isSupportedCursorSecret(cursorSecret)
    || (
      rawPreviousSecret !== undefined
      && !isSupportedCursorSecret(previousCursorSecret)
    )
  ) {
    return null;
  }
  return Object.freeze({
    cursorSecret,
    ...(previousCursorSecret ? { previousCursorSecret } : {}),
  });
}

function snapshotQueryRequest(
  query: BackstageNotionRagQuery
): Readonly<Record<string, unknown>> | null {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    return null;
  }
  try {
    const prototype = Object.getPrototypeOf(query);
    if (prototype !== Object.prototype && prototype !== null) {
      return null;
    }
    const keys = Reflect.ownKeys(query);
    if (
      keys.some(key => typeof key !== 'string' || !QUERY_REQUEST_KEYS.has(key))
    ) {
      return null;
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(query, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        return null;
      }
      snapshot[key as string] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function resolveRequestFacts(query: BackstageNotionRagQuery): Readonly<{
  query: BackstageNotionRagQuery;
  queryText: string;
  relevantUnscoped: boolean;
  hasCursor: boolean;
}> | null {
  if (typeof query === 'string') {
    return Object.freeze({
      query,
      queryText: query.trim(),
      relevantUnscoped: true,
      hasCursor: false,
    });
  }
  const snapshot = snapshotQueryRequest(query);
  if (!snapshot || typeof snapshot.query !== 'string') {
    return null;
  }
  const retrievalMode = snapshot.retrievalMode
    ?? snapshot.mode
    ?? 'relevant';
  const hasCursor = typeof snapshot.cursor === 'string'
    && snapshot.cursor.length > 0;
  return Object.freeze({
    query: snapshot as unknown as BackstageNotionRagQuery,
    queryText: snapshot.query.trim(),
    relevantUnscoped: retrievalMode === 'relevant'
      && snapshot.retrievalScope === undefined,
    hasCursor,
  });
}

function resolveBoundedYearTags(query: string): readonly string[] | null {
  const years = new Set<string>();
  for (const match of query.slice(0, MAX_ROUTING_QUERY_CODE_UNITS)
    .matchAll(QUERY_YEAR_PATTERN)) {
    years.add(match[0]);
    if (years.size > BACKSTAGE_NOTION_PARTITION_MAX_QUERY_YEARS) {
      return null;
    }
  }
  return Object.freeze(
    [...years].sort().map(year => `year:${year}`)
  );
}

function buildRelevantRoutingIntent(
  query: string
): BackstageNotionPartitionRoutingIntent | null {
  const boundedQuery = query.slice(0, MAX_ROUTING_QUERY_CODE_UNITS);
  const bookingScope = resolveBackstageNotionBookingScopePlan(boundedQuery);
  const laneTags: string[] = bookingScope.allowedBrands.map(
    brand => `brand:${brand}`
  );
  if (PLE_LANE_PATTERN.test(boundedQuery)) {
    laneTags.push('lane:ples');
  }
  const yearTags = resolveBoundedYearTags(boundedQuery);
  if (yearTags === null) {
    return null;
  }
  const narrowedSelectorCount = laneTags.length > 0 && yearTags.length > 0
    ? laneTags.length * yearTags.length
    : Math.max(laneTags.length, yearTags.length);
  if (
    narrowedSelectorCount > 0
    && narrowedSelectorCount + 1
      > BACKSTAGE_NOTION_PARTITION_ROUTING_MAX_SELECTORS
  ) {
    return null;
  }
  const explicitArchive = EXPLICIT_ARCHIVE_PATTERN.test(boundedQuery);
  const selectors: BackstageNotionPartitionRoutingSelector[] = [];
  if (laneTags.length > 0 && yearTags.length > 0) {
    for (const laneTag of laneTags) {
      for (const yearTag of yearTags) {
        selectors.push(Object.freeze({
          allScopeTags: Object.freeze([laneTag, yearTag]),
          allCategoryTags: Object.freeze([]),
        }));
      }
    }
  } else {
    for (const scopeTag of laneTags.length > 0 ? laneTags : yearTags) {
      selectors.push(Object.freeze({
        allScopeTags: Object.freeze([scopeTag]),
        allCategoryTags: Object.freeze([]),
      }));
    }
  }
  if (selectors.length === 0) {
    selectors.push(Object.freeze({
      allScopeTags: Object.freeze([]),
      allCategoryTags: Object.freeze([]),
    }));
  } else {
    selectors.push(Object.freeze({
      allScopeTags: Object.freeze(['shared']),
      allCategoryTags: Object.freeze([]),
    }));
  }
  return Object.freeze({
    kind: 'relevant' as const,
    cardinality: 'all_matching' as const,
    allowedTiers: explicitArchive
      ? Object.freeze(['archive' as const])
      : Object.freeze(['hot' as const, 'cold' as const]),
    explicitArchive,
    selectors: Object.freeze(selectors),
  });
}

function buildPartitionPlan(
  query: BackstageNotionRagQuery
): PartitionRequestPlan | null {
  const facts = resolveRequestFacts(query);
  if (!facts) {
    return null;
  }
  const relevantRoutingIntent = facts.relevantUnscoped
    ? buildRelevantRoutingIntent(facts.queryText)
    : undefined;
  if (facts.relevantUnscoped && !relevantRoutingIntent) {
    return null;
  }
  return Object.freeze({
    plan: Object.freeze({
      query: facts.query,
      ...(relevantRoutingIntent
        ? { relevantRoutingIntent }
        : {}),
    }),
    hasCursor: facts.hasCursor,
    requiresCursorSecret: facts.hasCursor
      || (
        typeof facts.query === 'object'
        && (
          facts.query.retrievalMode === 'complete_scope'
          || facts.query.mode === 'complete_scope'
        )
      ),
  });
}

function hashComparisonValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function buildShadowComparisonBaseline(
  monolith: BackstageNotionRagRetrieval
): ShadowComparisonBaseline {
  return Object.freeze({
    promptDigest: hashComparisonValue(monolith.prompt),
    citationShapeDigest: hashComparisonValue(monolith.citations.map(citation => ({
      contentHash: citation.contentHash,
      category: citation.category,
    }))),
    retrievalMode: monolith.retrievalMode,
    chunkCount: monolith.chunkCount,
    truncated: monolith.truncated,
    coverageStatus: monolith.coverage.status,
    citationCount: monolith.citations.length,
  });
}

function buildComparisonMetadata(
  monolith: ShadowComparisonBaseline,
  partition: BackstageNotionPartitionRagRetrieval
): SafeLogMetadata {
  const partitionCitationShape = partition.citations.map(citation => ({
    contentHash: citation.contentHash,
    category: citation.category,
  }));
  return Object.freeze({
    outcome: 'compared',
    promptEquivalent: monolith.promptDigest
      === hashComparisonValue(partition.prompt),
    citationsEquivalent: monolith.citationShapeDigest
      === hashComparisonValue(partitionCitationShape),
    retrievalModeEquivalent:
      monolith.retrievalMode === partition.retrievalMode,
    chunkCountEquivalent: monolith.chunkCount === partition.chunkCount,
    truncationEquivalent: monolith.truncated === partition.truncated,
    coverageStatusEquivalent:
      monolith.coverageStatus === partition.coverage.status,
    monolithChunkCount: monolith.chunkCount,
    partitionChunkCount: partition.chunkCount,
    monolithCitationCount: monolith.citationCount,
    partitionCitationCount: partition.citations.length,
    partitionRoutingComplete: partition.routingComplete,
    partitionConfigurationCurrent: partition.configurationCurrent,
  });
}

function partitionDependencies(
  activation: PartitionActivation,
  embedQuery: (query: string) => Promise<number[]>
): BackstageNotionPartitionRetrievalDependencies {
  const base = {
    embedQuery,
    ...(activation.cursorSecret
      ? { resolveCursorEncryptionSecret: () => activation.cursorSecret }
      : {}),
    ...(activation.previousCursorSecret
      ? {
          resolvePreviousCursorEncryptionSecret:
            () => activation.previousCursorSecret,
        }
      : {}),
  };
  return base as BackstageNotionPartitionRetrievalDependencies;
}

async function retrievePartitioned(
  universeId: string,
  query: BackstageNotionRagQuery,
  readEnvironment: ReadEnvironment,
  embedQuery: (query: string) => Promise<number[]>,
  dependencies: BackstageNotionPartitionCutoverDependencies,
  protectedQueuedExecution: boolean
): Promise<BackstageNotionPartitionRagRetrieval> {
  const requestPlan = buildPartitionPlan(query);
  const activation = requestPlan
    ? resolvePartitionActivation(
        universeId,
        readEnvironment,
        requestPlan.requiresCursorSecret || !protectedQueuedExecution
      )
    : null;
  if (!activation || !requestPlan) {
    throw new BackstageNotionIndexUnavailableError();
  }
  const retrievePartition = readDataFunction<PartitionRetriever>(
    dependencies,
    'retrievePartition'
  ) ?? retrieveBackstageNotionPartitionRagContext;
  return retrievePartition(
    universeId,
    requestPlan.plan,
    partitionDependencies(activation, embedQuery)
  );
}

function startShadowComparison(input: {
  readonly universeId: string;
  readonly requestPlan: PartitionRequestPlan;
  readonly baseline: ShadowComparisonBaseline;
  readonly readEnvironment: ReadEnvironment;
  readonly sharedEmbedding: (query: string) => Promise<number[]>;
  readonly dependencies: BackstageNotionPartitionCutoverDependencies;
  readonly protectedQueuedExecution: boolean;
  readonly slot: ShadowSlot;
}): void {
  void Promise.resolve().then(async () => {
    const activation = resolvePartitionActivation(
      input.universeId,
      input.readEnvironment,
      input.requestPlan.requiresCursorSecret
        || !input.protectedQueuedExecution
    );
    if (!activation) {
      safeLog(input.dependencies, 'backstage.notion_partition.shadow_read', {
        outcome: 'activation_unavailable',
      });
      return;
    }
    const retrievePartition = readDataFunction<PartitionRetriever>(
      input.dependencies,
      'retrievePartition'
    ) ?? retrieveBackstageNotionPartitionRagContext;
    const partition = await retrievePartition(
      input.universeId,
      input.requestPlan.plan,
      partitionDependencies(activation, input.sharedEmbedding)
    );
    safeLog(
      input.dependencies,
      'backstage.notion_partition.shadow_read',
      buildComparisonMetadata(input.baseline, partition)
    );
  }).catch(() => {
    safeLog(input.dependencies, 'backstage.notion_partition.shadow_read', {
      outcome: 'partition_unavailable',
    });
  }).finally(() => {
    input.slot.release();
  });
}

async function retrieveAuthority(
  universeId: string,
  query: BackstageNotionRagQuery,
  booking: boolean,
  dependencies: BackstageNotionPartitionCutoverDependencies
): Promise<BackstageNotionAuthorityRagRetrieval> {
  requireAuthorization(dependencies);

  const readEnvironment = readDataFunction<ReadEnvironment>(
    dependencies,
    'readEnvironment'
  ) ?? (name => getEnv(name));
  const mode = readModeOnce(readEnvironment).mode;
  const retrieveMonolith = booking
    ? readDataFunction<BookingMonolithRetriever>(
        dependencies,
        'retrieveBookingMonolith'
      ) ?? retrieveBackstageNotionBookingRagContext
    : readDataFunction<MonolithRetriever>(dependencies, 'retrieveMonolith')
      ?? retrieveBackstageNotionRagContext;

  if (mode === 'monolith') {
    return booking
      ? (retrieveMonolith as BookingMonolithRetriever)(
          universeId,
          query as string
        )
      : (retrieveMonolith as MonolithRetriever)(universeId, query);
  }

  const embed = readDataFunction<(query: string) => Promise<number[]>>(
    dependencies,
    'embedQuery'
  ) ?? createEmbedding;
  const sharedEmbedding = createLazyQueryBoundEmbedding(embed);
  const protectedQueuedExecution = resolveProtectedQueuedExecution(
    dependencies
  );
  if (mode === 'partitioned') {
    return retrievePartitioned(
      universeId,
      query,
      readEnvironment,
      sharedEmbedding,
      dependencies,
      protectedQueuedExecution
    );
  }

  const monolith = booking
    ? await (retrieveMonolith as BookingMonolithRetriever)(
        universeId,
        query as string,
        { embedQuery: sharedEmbedding }
      )
    : await (retrieveMonolith as MonolithRetriever)(
        universeId,
        query,
        { embedQuery: sharedEmbedding }
      );
  const requestPlan = buildPartitionPlan(query);
  if (!requestPlan || requestPlan.hasCursor) {
    safeLog(dependencies, 'backstage.notion_partition.shadow_read', {
      outcome: requestPlan ? 'cursor_continuation_skipped' : 'request_uncomparable',
    });
    return monolith;
  }
  const slot = acquireShadowSlot();
  if (!slot) {
    safeLog(dependencies, 'backstage.notion_partition.shadow_read', {
      outcome: 'capacity_skipped',
    });
    return monolith;
  }
  let baseline: ShadowComparisonBaseline;
  try {
    baseline = buildShadowComparisonBaseline(monolith);
  } catch {
    slot.release();
    safeLog(dependencies, 'backstage.notion_partition.shadow_read', {
      outcome: 'request_uncomparable',
    });
    return monolith;
  }
  startShadowComparison({
    universeId,
    requestPlan,
    baseline,
    readEnvironment,
    sharedEmbedding,
    dependencies,
    protectedQueuedExecution,
    slot,
  });
  return monolith;
}

/**
 * Retrieve authority context through the exact rollout mode captured for this
 * request. Shadow diagnostics can never replace or delay into a backlog behind
 * the monolithic authority result, and partitioned mode has no silent fallback.
 */
export async function retrieveBackstageNotionAuthorityRagContext(
  universeId: string,
  query: BackstageNotionRagQuery,
  dependencies: BackstageNotionPartitionCutoverDependencies = {}
): Promise<BackstageNotionAuthorityRagRetrieval> {
  return retrieveAuthority(universeId, query, false, dependencies);
}

/** Booking-only facade preserving the monolith booking scope contract. */
export async function retrieveBackstageNotionAuthorityBookingRagContext(
  universeId: string,
  query: string,
  dependencies: BackstageNotionPartitionCutoverDependencies = {}
): Promise<BackstageNotionAuthorityRagRetrieval> {
  return retrieveAuthority(universeId, query, true, dependencies);
}
