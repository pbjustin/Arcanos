import {
  getBackstageNotionPartitionRepository,
  type BackstageNotionPartitionDiagnosticsState,
  type PostgresBackstageNotionPartitionRepository,
} from '@core/db/repositories/backstageNotionPartitionRepository.js';
import { getEnv, getEnvNumber } from '@platform/runtime/env.js';
import {
  BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE_ENV_NAME,
  BACKSTAGE_NOTION_PARTITIONS_ENV_NAME,
  parseBackstageNotionPartitionConfiguration,
  parseBackstageNotionPartitionedIndexMode,
  resolveBackstageNotionPartitionUniverse,
  type BackstageNotionPartitionDefinition,
  type BackstageNotionPartitionedIndexMode,
} from '@shared/backstage/backstageNotionPartitionCore.js';
import {
  BACKSTAGE_NOTION_PARTITION_OPTIONAL_UNAVAILABLE_REASON_CODES,
} from '@shared/backstage/backstageNotionPartitionSyncCore.js';
import {
  BACKSTAGE_NOTION_PARTITION_ROUTING_DEFAULT_STALENESS_MS,
  BACKSTAGE_NOTION_PARTITION_ROUTING_MAX_FUTURE_SKEW_MS,
  BACKSTAGE_NOTION_PARTITION_ROUTING_MAX_STALENESS_MS,
  BACKSTAGE_NOTION_PARTITION_ROUTING_MIN_STALENESS_MS,
  BACKSTAGE_NOTION_PARTITION_ROUTING_STALENESS_ENV_NAME,
} from './backstageNotionPartitionRouting.js';

export const BACKSTAGE_NOTION_PARTITION_DIAGNOSTICS_VERSION = 1;

type ReadEnvironment = (name: string) => string | undefined;
type DiagnosticsRepository = Pick<
  PostgresBackstageNotionPartitionRepository,
  'loadUniverseDiagnosticsState'
>;

export interface BackstageNotionPartitionDiagnosticsDependencies {
  readonly readEnvironment: ReadEnvironment;
  readonly repository: DiagnosticsRepository;
  readonly now: () => Date;
  readonly readMaximumStalenessMs: () => number | undefined;
}

export interface GetBackstageNotionPartitionDiagnosticsInput {
  readonly universeId: string;
  readonly dependencies?: Partial<BackstageNotionPartitionDiagnosticsDependencies>;
}

export interface BackstageNotionPartitionDiagnosticsHttpResult {
  readonly statusCode: number;
  readonly payload: Record<string, unknown>;
}

type PublicFreshness = 'fresh' | 'stale' | 'future_clock' | 'unavailable';
type PublicActivation =
  | 'fresh'
  | 'retained_last_known_good'
  | 'optional_unavailable'
  | 'optional_disabled'
  | 'not_current'
  | 'unavailable';
const SAFE_OMISSION_REASONS = new Set<string>(
  BACKSTAGE_NOTION_PARTITION_OPTIONAL_UNAVAILABLE_REASON_CODES
);

interface PublicShardDiagnostics {
  readonly shardKey: string;
  readonly retrievalTier: 'hot' | 'cold' | 'archive';
  readonly required: boolean;
  readonly activation: PublicActivation;
  readonly safeReasonCode: string | null;
  readonly freshness: PublicFreshness;
  readonly verifiedAt: string | null;
  readonly retrievalReady: boolean;
  readonly lastKnownGood: Readonly<{
    snapshotId: string;
    pageCount: number;
    chunkCount: number;
    sealedAt: string;
    verifiedAt: string;
  }> | null;
  readonly lease: Readonly<{
    active: true;
    expiresAt: string;
  }> | null;
  readonly activeJobs: Readonly<{
    queued: number;
    running: number;
    staleConfiguration: number;
  }> | null;
}

function dependencies(
  overrides: Partial<BackstageNotionPartitionDiagnosticsDependencies> | undefined
): BackstageNotionPartitionDiagnosticsDependencies {
  return {
    readEnvironment: overrides?.readEnvironment ?? (name => getEnv(name)),
    repository: overrides?.repository ?? {
      loadUniverseDiagnosticsState: universeId =>
        getBackstageNotionPartitionRepository()
          .loadUniverseDiagnosticsState(universeId),
    },
    now: overrides?.now ?? (() => new Date()),
    readMaximumStalenessMs: overrides?.readMaximumStalenessMs ?? (() =>
      getEnvNumber(
        BACKSTAGE_NOTION_PARTITION_ROUTING_STALENESS_ENV_NAME,
        BACKSTAGE_NOTION_PARTITION_ROUTING_DEFAULT_STALENESS_MS
      )),
  };
}

function response(
  statusCode: number,
  payload: Record<string, unknown>
): BackstageNotionPartitionDiagnosticsHttpResult {
  return Object.freeze({ statusCode, payload: Object.freeze(payload) });
}

function errorResponse(
  statusCode: number,
  code: string,
  message: string
): BackstageNotionPartitionDiagnosticsHttpResult {
  return response(statusCode, {
    ok: false,
    error: Object.freeze({ code, message }),
  });
}

function unavailableResponse(): BackstageNotionPartitionDiagnosticsHttpResult {
  return errorResponse(
    503,
    'BACKSTAGE_NOTION_PARTITION_DIAGNOSTICS_UNAVAILABLE',
    'Partition diagnostics are unavailable.'
  );
}

function disabledResponse(): BackstageNotionPartitionDiagnosticsHttpResult {
  return errorResponse(
    409,
    'BACKSTAGE_NOTION_PARTITION_DIAGNOSTICS_DISABLED',
    'Partition diagnostics are disabled.'
  );
}

function notFoundResponse(): BackstageNotionPartitionDiagnosticsHttpResult {
  return errorResponse(
    404,
    'BACKSTAGE_NOTION_PARTITION_DIAGNOSTICS_NOT_FOUND',
    'The partition diagnostics target was not found.'
  );
}

function maximumStalenessMs(value: number | undefined): number {
  const candidate = value ?? BACKSTAGE_NOTION_PARTITION_ROUTING_DEFAULT_STALENESS_MS;
  if (!Number.isFinite(candidate) || candidate <= 0) {
    return BACKSTAGE_NOTION_PARTITION_ROUTING_DEFAULT_STALENESS_MS;
  }
  return Math.max(
    BACKSTAGE_NOTION_PARTITION_ROUTING_MIN_STALENESS_MS,
    Math.min(
      BACKSTAGE_NOTION_PARTITION_ROUTING_MAX_STALENESS_MS,
      Math.trunc(candidate)
    )
  );
}

function safeDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`${label} is invalid.`);
  }
  return new Date(value.getTime());
}

function safeInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function freshness(
  verifiedAt: Date | null,
  now: Date,
  stalenessMs: number
): PublicFreshness {
  if (verifiedAt === null) {
    return 'unavailable';
  }
  const verifiedAtMs = safeDate(verifiedAt, 'verifiedAt').getTime();
  const deltaMs = now.getTime() - verifiedAtMs;
  if (deltaMs < -BACKSTAGE_NOTION_PARTITION_ROUTING_MAX_FUTURE_SKEW_MS) {
    return 'future_clock';
  }
  return deltaMs > stalenessMs ? 'stale' : 'fresh';
}

function sameStrings(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function assertShardMatchesDefinition(
  shard: BackstageNotionPartitionDiagnosticsState['shards'][number],
  definition: BackstageNotionPartitionDefinition
): void {
  if (
    shard.shardKey !== definition.shardKey
    || shard.retrievalTier !== definition.retrievalTier
    || shard.required !== definition.required
    || !sameStrings(shard.scopeTags, definition.scopeTags)
    || !sameStrings(shard.categoryTags, definition.categoryTags)
  ) {
    throw new Error('Partition diagnostics crossed configuration definitions.');
  }
}

function projectShard(input: {
  readonly shard: BackstageNotionPartitionDiagnosticsState['shards'][number];
  readonly definition: BackstageNotionPartitionDefinition;
  readonly manifestCurrent: boolean;
  readonly observedAt: Date;
  readonly now: Date;
  readonly maximumStalenessMs: number;
}): PublicShardDiagnostics {
  const { shard, definition, manifestCurrent, now } = input;
  assertShardMatchesDefinition(shard, definition);

  let activation: PublicActivation = 'not_current';
  let safeReasonCode: string | null = null;
  let verifiedAt: Date | null = null;
  if (manifestCurrent) {
    if (shard.manifestRecord === null) {
      throw new Error('Current manifest diagnostics omitted a configured shard.');
    }
    if (shard.manifestRecord.kind === 'member') {
      activation = shard.manifestRecord.decision;
      verifiedAt = safeDate(
        shard.manifestRecord.verifiedAt,
        'manifestRecord.verifiedAt'
      );
    } else {
      if (!SAFE_OMISSION_REASONS.has(shard.manifestRecord.safeReasonCode)) {
        throw new Error('Manifest omission reason is outside its closed contract.');
      }
      activation = shard.manifestRecord.decision;
      safeReasonCode = shard.manifestRecord.safeReasonCode;
    }
  }

  const currentFreshness = freshness(verifiedAt, now, input.maximumStalenessMs);
  const retrievalReady = manifestCurrent
    && shard.manifestRecord?.kind === 'member'
    && currentFreshness === 'fresh';

  let lastKnownGood: PublicShardDiagnostics['lastKnownGood'] = null;
  if (shard.lastKnownGood !== null) {
    const exactForConfiguredPartition =
      shard.lastKnownGood.partitionVersionId === shard.partitionVersionId;
    if (
      shard.lastKnownGood.exactForConfiguredPartition
        !== exactForConfiguredPartition
    ) {
      throw new Error('Last-known-good partition identity is inconsistent.');
    }
    if (
      shard.currentHeadPartitionVersionId === shard.partitionVersionId
      && exactForConfiguredPartition
    ) {
      const createdAt = safeDate(
        shard.lastKnownGood.createdAt,
        'lastKnownGood.createdAt'
      );
      const sealedAt = safeDate(
        shard.lastKnownGood.sealedAt,
        'lastKnownGood.sealedAt'
      );
      const lastVerifiedAt = shard.lastVerifiedAt === null
        ? null
        : safeDate(shard.lastVerifiedAt, 'lastVerifiedAt');
      if (
        lastVerifiedAt === null
        || createdAt.getTime() > sealedAt.getTime()
      ) {
        throw new Error('Last-known-good diagnostics are internally inconsistent.');
      }
      lastKnownGood = Object.freeze({
        snapshotId: shard.lastKnownGood.snapshotId,
        pageCount: safeInteger(
          shard.lastKnownGood.pageCount,
          'lastKnownGood.pageCount',
          definition.capacity.maxPages
        ),
        chunkCount: safeInteger(
          shard.lastKnownGood.chunkCount,
          'lastKnownGood.chunkCount',
          definition.capacity.maxChunks
        ),
        sealedAt: sealedAt.toISOString(),
        verifiedAt: lastVerifiedAt.toISOString(),
      });
    }
  }

  let lease: PublicShardDiagnostics['lease'] = null;
  if (shard.lease !== null) {
    const acquiredAt = safeDate(shard.lease.acquiredAt, 'lease.acquiredAt');
    const expiresAt = safeDate(shard.lease.expiresAt, 'lease.expiresAt');
    if (
      expiresAt.getTime() <= acquiredAt.getTime()
      || expiresAt.getTime() <= input.observedAt.getTime()
    ) {
      throw new Error('Active lease diagnostics are internally inconsistent.');
    }
    lease = Object.freeze({ active: true as const, expiresAt: expiresAt.toISOString() });
  }

  const pending = safeInteger(shard.activeJobs.pending, 'activeJobs.pending', 16);
  const running = safeInteger(shard.activeJobs.running, 'activeJobs.running', 16);
  const total = safeInteger(shard.activeJobs.total, 'activeJobs.total', 16);
  const configurationStale = safeInteger(
    shard.activeJobs.configurationStale,
    'activeJobs.configurationStale',
    16
  );
  if (total > 1 || total !== pending + running || configurationStale > total) {
    throw new Error('Active job diagnostics are internally inconsistent.');
  }

  return Object.freeze({
    shardKey: definition.shardKey,
    retrievalTier: definition.retrievalTier,
    required: definition.required,
    activation,
    safeReasonCode,
    freshness: currentFreshness,
    verifiedAt: verifiedAt?.toISOString() ?? null,
    retrievalReady,
    lastKnownGood,
    lease,
    activeJobs: Object.freeze({
      queued: pending,
      running,
      staleConfiguration: configurationStale,
    }),
  });
}

function uninitializedShard(
  definition: BackstageNotionPartitionDefinition
): PublicShardDiagnostics {
  return Object.freeze({
    shardKey: definition.shardKey,
    retrievalTier: definition.retrievalTier,
    required: definition.required,
    activation: 'unavailable' as const,
    safeReasonCode: null,
    freshness: 'unavailable' as const,
    verifiedAt: null,
    retrievalReady: false,
    lastKnownGood: null,
    lease: null,
    activeJobs: null,
  });
}

function buildPayload(input: {
  readonly mode: Exclude<BackstageNotionPartitionedIndexMode, 'monolith'>;
  readonly universeId: string;
  readonly configurationGeneration: string;
  readonly configurationHash: string;
  readonly definitions: readonly BackstageNotionPartitionDefinition[];
  readonly state: BackstageNotionPartitionDiagnosticsState | null;
  readonly now: Date;
  readonly maximumStalenessMs: number;
}): Record<string, unknown> {
  if (input.state === null) {
    const shards = Object.freeze(input.definitions.map(uninitializedShard));
    return {
      ok: true,
      data: Object.freeze({
        version: BACKSTAGE_NOTION_PARTITION_DIAGNOSTICS_VERSION,
        universeId: input.universeId,
        mode: input.mode,
        observedAt: input.now.toISOString(),
        configurationStatus: 'uninitialized',
        configurationGeneration: input.configurationGeneration,
        activeManifest: null,
        shards,
        summary: Object.freeze({
          configuredShards: shards.length,
          requiredShardsReady: false,
          completeScopeReady: false,
          retrievalReadyShards: 0,
          staleShards: 0,
          unavailableShards: shards.length,
          operationalAggregatesAvailable: false,
          activeLeases: null,
          queuedJobs: null,
          runningJobs: null,
          unconfiguredActiveJobs: null,
        }),
      }),
    };
  }

  const state = input.state;
  if (
    state.universeId !== input.universeId
    || !state.authorityActive
    || state.desiredConfigurationGeneration !== input.configurationGeneration
    || state.desiredConfigurationHash !== input.configurationHash
    || state.shards.length !== input.definitions.length
  ) {
    throw new Error('Partition diagnostics crossed authority configuration.');
  }
  const observedAt = safeDate(state.observedAt, 'observedAt');
  if (
    Math.abs(observedAt.getTime() - input.now.getTime())
      > BACKSTAGE_NOTION_PARTITION_ROUTING_MAX_FUTURE_SKEW_MS
  ) {
    throw new Error('Partition diagnostics observation clock is invalid.');
  }

  const definitionByShard = new Map(
    input.definitions.map(definition => [definition.shardKey, definition])
  );
  const stateShardByKey = new Map<
    string,
    BackstageNotionPartitionDiagnosticsState['shards'][number]
  >();
  const activeManifest = state.activeManifest;
  const manifestCurrent = activeManifest !== null
    && activeManifest.configurationVersionId
      === state.desiredConfigurationVersionId
    && activeManifest.configurationGeneration
      === state.desiredConfigurationGeneration
    && activeManifest.configurationHash === state.desiredConfigurationHash;
  let publicActiveManifest: Record<string, unknown> | null = null;
  if (activeManifest !== null) {
    const manifestCreatedAt = safeDate(activeManifest.createdAt, 'manifest.createdAt');
    const manifestSealedAt = safeDate(activeManifest.sealedAt, 'manifest.sealedAt');
    const memberCount = safeInteger(activeManifest.memberCount, 'memberCount', 128);
    const omissionCount = safeInteger(activeManifest.omissionCount, 'omissionCount', 128);
    if (
      manifestCreatedAt.getTime() > manifestSealedAt.getTime()
      || memberCount + omissionCount > 128
      || (manifestCurrent
        && memberCount + omissionCount !== input.definitions.length)
    ) {
      throw new Error('Active manifest diagnostics are internally inconsistent.');
    }
    publicActiveManifest = Object.freeze({
      manifestId: activeManifest.manifestId,
      manifestGeneration: state.manifestGeneration,
      configurationCurrent: manifestCurrent,
      createdAt: manifestCreatedAt.toISOString(),
      sealedAt: manifestSealedAt.toISOString(),
      memberCount,
      omissionCount,
      pageCount: safeInteger(
        activeManifest.pageCount,
        'manifest.pageCount',
        Number.MAX_SAFE_INTEGER
      ),
      chunkCount: safeInteger(
        activeManifest.chunkCount,
        'manifest.chunkCount',
        Number.MAX_SAFE_INTEGER
      ),
    });
  }
  for (const shard of state.shards) {
    if (stateShardByKey.has(shard.shardKey)) {
      throw new Error('Partition diagnostics contain duplicate shards.');
    }
    if (!definitionByShard.has(shard.shardKey)) {
      throw new Error('Partition diagnostics contain an unknown shard.');
    }
    stateShardByKey.set(shard.shardKey, shard);
  }
  if (stateShardByKey.size !== definitionByShard.size) {
    throw new Error('Partition diagnostics omitted configured shards.');
  }
  const shards = Object.freeze(input.definitions.map(definition => {
    const shard = stateShardByKey.get(definition.shardKey);
    if (!shard) {
      throw new Error('Partition diagnostics omitted configured shards.');
    }
    return projectShard({
      shard,
      definition,
      manifestCurrent,
      observedAt,
      now: input.now,
      maximumStalenessMs: input.maximumStalenessMs,
    });
  }));

  const activeJobCount = safeInteger(state.activeJobCount, 'activeJobCount', 16);
  const unconfiguredActiveJobCount = safeInteger(
    state.unconfiguredActiveJobCount,
    'unconfiguredActiveJobCount',
    16
  );
  let queuedJobs = 0;
  let runningJobs = 0;
  for (const shard of shards) {
    if (shard.activeJobs === null) {
      throw new Error('Partition diagnostics active jobs are unavailable.');
    }
    queuedJobs += shard.activeJobs.queued;
    runningJobs += shard.activeJobs.running;
  }
  if (queuedJobs + runningJobs + unconfiguredActiveJobCount !== activeJobCount) {
    throw new Error('Partition diagnostics active job totals are inconsistent.');
  }

  const requiredShards = shards.filter(shard => shard.required);
  const retrievalReadyShards = shards.filter(shard => shard.retrievalReady).length;
  const staleShards = shards.filter(shard => shard.freshness === 'stale').length;
  const unavailableShards = shards.filter(shard => !shard.retrievalReady).length;
  return {
    ok: true,
    data: Object.freeze({
      version: BACKSTAGE_NOTION_PARTITION_DIAGNOSTICS_VERSION,
      universeId: input.universeId,
      mode: input.mode,
      observedAt: observedAt.toISOString(),
      configurationStatus: manifestCurrent ? 'active' : 'pending_manifest',
      configurationGeneration: input.configurationGeneration,
      activeManifest: publicActiveManifest,
      shards,
      summary: Object.freeze({
        configuredShards: shards.length,
        requiredShardsReady: requiredShards.length > 0
          && requiredShards.every(shard => shard.retrievalReady),
        completeScopeReady: shards.length > 0
          && shards.every(shard => shard.retrievalReady),
        retrievalReadyShards,
        staleShards,
        unavailableShards,
        operationalAggregatesAvailable: true,
        activeLeases: shards.filter(shard => shard.lease !== null).length,
        queuedJobs,
        runningJobs,
        unconfiguredActiveJobs: unconfiguredActiveJobCount,
      }),
    }),
  };
}

/**
 * Return one body-safe, bounded diagnostics generation. The repository method
 * pins heads, manifest records, leases, and active-job aggregates together and
 * never reads the authority corpus.
 */
export async function getBackstageNotionPartitionDiagnostics(
  input: GetBackstageNotionPartitionDiagnosticsInput
): Promise<BackstageNotionPartitionDiagnosticsHttpResult> {
  const resolved = dependencies(input.dependencies);
  let rawMode: string | undefined;
  try {
    rawMode = resolved.readEnvironment(
      BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE_ENV_NAME
    );
  } catch {
    return unavailableResponse();
  }
  const mode = parseBackstageNotionPartitionedIndexMode(rawMode);
  if (mode.status !== 'valid' || mode.mode === 'monolith') {
    return disabledResponse();
  }

  let rawConfiguration: string | undefined;
  try {
    rawConfiguration = resolved.readEnvironment(BACKSTAGE_NOTION_PARTITIONS_ENV_NAME);
  } catch {
    return unavailableResponse();
  }
  const configuration = parseBackstageNotionPartitionConfiguration(rawConfiguration);
  if (configuration.status !== 'valid') {
    return unavailableResponse();
  }
  const universe = resolveBackstageNotionPartitionUniverse(
    configuration,
    input.universeId
  );
  if (!universe) {
    return notFoundResponse();
  }

  let now: Date;
  let state: BackstageNotionPartitionDiagnosticsState | null;
  let configuredStaleness: number | undefined;
  try {
    now = safeDate(resolved.now(), 'now');
    configuredStaleness = resolved.readMaximumStalenessMs();
    state = await resolved.repository.loadUniverseDiagnosticsState(
      universe.universeId
    );
  } catch {
    return unavailableResponse();
  }

  try {
    return response(200, buildPayload({
      mode: mode.mode,
      universeId: universe.universeId,
      configurationGeneration: configuration.generation,
      configurationHash: configuration.semanticDigest,
      definitions: universe.shards,
      state,
      now,
      maximumStalenessMs: maximumStalenessMs(configuredStaleness),
    }));
  } catch {
    return unavailableResponse();
  }
}
