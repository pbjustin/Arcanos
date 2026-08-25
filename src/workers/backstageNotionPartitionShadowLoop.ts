import {
  getBackstageNotionPartitionRepository,
  type BackstageNotionPartitionShadowCoverage,
} from '@core/db/repositories/backstageNotionPartitionRepository.js';
import { logger } from '@platform/logging/structuredLogging.js';
import { getEnv } from '@platform/runtime/env.js';
import {
  BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE_ENV_NAME,
  BACKSTAGE_NOTION_PARTITIONS_ENV_NAME,
  parseBackstageNotionPartitionConfiguration,
  parseBackstageNotionPartitionedIndexMode,
  type BackstageNotionPartitionConfiguration,
} from '@shared/backstage/backstageNotionPartitionCore.js';
import {
  projectBackstageNotionPartitionFailedShardTelemetry,
} from '@shared/backstage/backstageNotionPartitionTelemetryCore.js';
import {
  createBackstageNotionPartitionProviderCaptureDependencies,
  syncBackstageNotionPartitionConfiguration,
  type BackstageNotionPartitionSyncSelection,
  type BackstageNotionPartitionSynchronizationResult,
} from '@services/backstageNotionPartitionSync.js';
import {
  createEmbeddings,
  DEFAULT_OPENAI_EMBEDDING_DIMENSION,
  DEFAULT_OPENAI_EMBEDDING_MODEL,
} from '@services/openai/embeddings.js';
import {
  createBackstageNotionSynchronizationCoordinator,
  resolveBackstageNotionSyncIntervalMs,
  type BackstageNotionSynchronizationCoordinator,
} from './backstageNotionSyncLoop.js';

type ValidPartitionConfiguration = Extract<
  BackstageNotionPartitionConfiguration,
  { status: 'valid' }
>;

type SafeRequestedMode =
  | 'absent'
  | 'invalid'
  | 'monolith'
  | 'shadow'
  | 'partitioned';

export type BackstageNotionPartitionShadowReasonCode =
  | 'MODE_ABSENT'
  | 'MODE_INVALID'
  | 'MODE_MONOLITH'
  | 'SHADOW_CONFIGURATION_ABSENT'
  | 'SHADOW_CONFIGURATION_INVALID'
  | 'SHADOW_ENABLED'
  | 'PARTITIONED_CONFIGURATION_ABSENT'
  | 'PARTITIONED_CONFIGURATION_INVALID'
  | 'PARTITIONED_ENABLED'
  | 'ENVIRONMENT_READ_FAILED';

export interface BackstageNotionPartitionShadowPolicy {
  readonly enabled: boolean;
  readonly requestedMode: SafeRequestedMode;
  readonly modeStatus: 'absent' | 'valid' | 'invalid';
  readonly configurationStatus:
    | 'absent'
    | 'valid'
    | 'invalid'
    | 'unavailable'
    | 'uninspected';
  readonly semanticDigest: string | null;
  readonly configuredUniverses: number;
  readonly configuredShards: number;
  readonly reasonCode: BackstageNotionPartitionShadowReasonCode;
  readonly configuration: ValidPartitionConfiguration | null;
}

export type BackstageNotionWorkerReadinessGateResult<T> =
  | Readonly<{
    monolithReadinessRequired: true;
    evidence: T;
  }>
  | Readonly<{
    monolithReadinessRequired: false;
    evidence: null;
  }>;

export interface BackstageNotionPartitionShadowCycleResult {
  readonly synchronization: BackstageNotionPartitionSynchronizationResult;
  readonly coverage: readonly BackstageNotionPartitionShadowCoverage[];
  readonly coverageUnavailable: number;
}

export interface BackstageNotionPartitionSynchronizationCycleInput {
  readonly configuration: ValidPartitionConfiguration;
  readonly signal: AbortSignal;
  readonly readEnvironment?: (name: string) => string | undefined;
  readonly selection?: BackstageNotionPartitionSyncSelection;
}

export interface BackstageNotionPartitionShadowLoopHandle {
  readonly enabled: boolean;
  stopAndDrain(): Promise<void>;
}

export interface BackstageNotionPartitionShadowLoopDependencies {
  readonly signal?: AbortSignal;
  readonly intervalMs?: number;
  readonly initialDelayMs?: number;
  readonly readEnvironment?: (name: string) => string | undefined;
  readonly runCycle?: (input: {
    readonly configuration: ValidPartitionConfiguration;
    readonly signal: AbortSignal;
  }) => Promise<BackstageNotionPartitionShadowCycleResult>;
  readonly logger?: Pick<typeof logger, 'info' | 'warn'>;
  readonly coordinator?: BackstageNotionSynchronizationCoordinator;
}

function safeLog(
  loopLogger: Pick<typeof logger, 'info' | 'warn'>,
  level: 'info' | 'warn',
  event: string,
  metadata: Readonly<Record<string, unknown>>
): void {
  try {
    loopLogger[level](event, metadata);
  } catch {
    // Telemetry must never affect worker readiness or shadow synchronization.
  }
}

function disabledPolicy(input: {
  readonly requestedMode: SafeRequestedMode;
  readonly modeStatus: BackstageNotionPartitionShadowPolicy['modeStatus'];
  readonly configurationStatus: BackstageNotionPartitionShadowPolicy['configurationStatus'];
  readonly reasonCode: BackstageNotionPartitionShadowReasonCode;
}): BackstageNotionPartitionShadowPolicy {
  return Object.freeze({
    enabled: false,
    requestedMode: input.requestedMode,
    modeStatus: input.modeStatus,
    configurationStatus: input.configurationStatus,
    semanticDigest: null,
    configuredUniverses: 0,
    configuredShards: 0,
    reasonCode: input.reasonCode,
    configuration: null,
  });
}

/** Resolve the partition writer policy without exposing raw environment values. */
export function resolveBackstageNotionPartitionShadowPolicy(
  readEnvironment: (name: string) => string | undefined = name => getEnv(name)
): BackstageNotionPartitionShadowPolicy {
  let rawMode: string | undefined;
  try {
    rawMode = readEnvironment(BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE_ENV_NAME);
  } catch {
    return disabledPolicy({
      requestedMode: 'invalid',
      modeStatus: 'invalid',
      configurationStatus: 'unavailable',
      reasonCode: 'ENVIRONMENT_READ_FAILED',
    });
  }

  const mode = parseBackstageNotionPartitionedIndexMode(rawMode);
  const requestedMode: SafeRequestedMode = mode.status === 'valid'
    ? mode.mode
    : mode.status;
  if (mode.status === 'absent') {
    return disabledPolicy({
      requestedMode,
      modeStatus: mode.status,
      configurationStatus: 'uninspected',
      reasonCode: 'MODE_ABSENT',
    });
  }
  if (mode.status === 'invalid') {
    return disabledPolicy({
      requestedMode,
      modeStatus: mode.status,
      configurationStatus: 'uninspected',
      reasonCode: 'MODE_INVALID',
    });
  }
  if (mode.mode === 'monolith') {
    return disabledPolicy({
      requestedMode,
      modeStatus: mode.status,
      configurationStatus: 'uninspected',
      reasonCode: 'MODE_MONOLITH',
    });
  }
  let rawConfiguration: string | undefined;
  try {
    rawConfiguration = readEnvironment(BACKSTAGE_NOTION_PARTITIONS_ENV_NAME);
  } catch {
    return disabledPolicy({
      requestedMode,
      modeStatus: mode.status,
      configurationStatus: 'unavailable',
      reasonCode: 'ENVIRONMENT_READ_FAILED',
    });
  }
  const configuration = parseBackstageNotionPartitionConfiguration(rawConfiguration);
  if (configuration.status !== 'valid') {
    return disabledPolicy({
      requestedMode,
      modeStatus: mode.status,
      configurationStatus: configuration.status,
      reasonCode: mode.mode === 'partitioned'
        ? configuration.status === 'absent'
          ? 'PARTITIONED_CONFIGURATION_ABSENT'
          : 'PARTITIONED_CONFIGURATION_INVALID'
        : configuration.status === 'absent'
          ? 'SHADOW_CONFIGURATION_ABSENT'
          : 'SHADOW_CONFIGURATION_INVALID',
    });
  }
  return Object.freeze({
    enabled: true,
    requestedMode,
    modeStatus: mode.status,
    configurationStatus: configuration.status,
    semanticDigest: configuration.semanticDigest,
    configuredUniverses: configuration.universes.length,
    configuredShards: configuration.universes.reduce(
      (total, universe) => total + universe.shards.length,
      0
    ),
    reasonCode: mode.mode === 'partitioned'
      ? 'PARTITIONED_ENABLED'
      : 'SHADOW_ENABLED',
    configuration,
  });
}

/**
 * Keep the legacy monolith startup fence for every fallback policy. Only an
 * exact, internally consistent shadow or partitioned policy may admit queue
 * consumers without first awaiting a universe-wide monolith crawl.
 */
export function requiresBackstageNotionMonolithWorkerReadiness(
  policy: BackstageNotionPartitionShadowPolicy
): boolean {
  const exactEnabledPartitionPolicy = policy.enabled
    && policy.modeStatus === 'valid'
    && policy.configurationStatus === 'valid'
    && policy.configuration !== null
    && policy.semanticDigest !== null
    && (
      (policy.requestedMode === 'shadow' && policy.reasonCode === 'SHADOW_ENABLED')
      || (
        policy.requestedMode === 'partitioned'
        && policy.reasonCode === 'PARTITIONED_ENABLED'
      )
    );
  return !exactEnabledPartitionPolicy;
}

/** Run the unchanged legacy readiness proof only when the resolved policy requires it. */
export async function runBackstageNotionWorkerReadinessGate<T>(
  policy: BackstageNotionPartitionShadowPolicy,
  ensureReadiness: () => Promise<T>
): Promise<BackstageNotionWorkerReadinessGateResult<T>> {
  if (!requiresBackstageNotionMonolithWorkerReadiness(policy)) {
    return Object.freeze({
      monolithReadinessRequired: false,
      evidence: null,
    });
  }
  return Object.freeze({
    monolithReadinessRequired: true,
    evidence: await ensureReadiness(),
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError');
}

async function runDefaultShadowCycle(input: {
  readonly configuration: ValidPartitionConfiguration;
  readonly signal: AbortSignal;
  readonly readEnvironment: (name: string) => string | undefined;
}): Promise<BackstageNotionPartitionShadowCycleResult> {
  throwIfAborted(input.signal);
  const synchronization = await runBackstageNotionPartitionSynchronizationCycle(
    input
  );
  const repository = getBackstageNotionPartitionRepository();
  const coverage: BackstageNotionPartitionShadowCoverage[] = [];
  let coverageUnavailable = 0;
  for (const universe of input.configuration.universes) {
    throwIfAborted(input.signal);
    try {
      const comparison = await repository.loadShadowCoverage(universe.universeId);
      throwIfAborted(input.signal);
      coverage.push(comparison);
    } catch {
      throwIfAborted(input.signal);
      coverageUnavailable += 1;
    }
  }
  return Object.freeze({
    synchronization,
    coverage: Object.freeze(coverage),
    coverageUnavailable,
  });
}

/**
 * Run one partition reconciliation without coverage reads or coordinator
 * ownership. Scheduled and operator-triggered callers can therefore share the
 * exact capture, embedding, persistence, and cancellation behavior while the
 * worker owns cross-cycle serialization.
 */
export async function runBackstageNotionPartitionSynchronizationCycle(
  input: BackstageNotionPartitionSynchronizationCycleInput
): Promise<BackstageNotionPartitionSynchronizationResult> {
  throwIfAborted(input.signal);
  const readEnvironment = input.readEnvironment ?? (name => getEnv(name));
  const repository = getBackstageNotionPartitionRepository();
  const capture = createBackstageNotionPartitionProviderCaptureDependencies({
    readEnvironment,
    fetchImpl: fetch,
  });
  return syncBackstageNotionPartitionConfiguration(
    input.configuration,
    {
      repository,
      embeddingModel: DEFAULT_OPENAI_EMBEDDING_MODEL,
      embeddingDimension: DEFAULT_OPENAI_EMBEDDING_DIMENSION,
      embedBatch: async (inputs, signal) => {
        const embeddings = await createEmbeddings(inputs, undefined, { signal });
        if (
          embeddings.length !== inputs.length
          || embeddings.some(
            embedding => embedding.length !== DEFAULT_OPENAI_EMBEDDING_DIMENSION
          )
        ) {
          throw new Error('Embedding provider returned an unexpected dimension.');
        }
        return embeddings;
      },
      ...capture,
      signal: input.signal,
      selection: input.selection,
    }
  );
}

function summarizeCycle(
  result: BackstageNotionPartitionShadowCycleResult,
  requestedSemanticDigest: string
):
Readonly<Record<string, unknown>> {
  const shardResults = result.synchronization.universes.flatMap(
    universe => universe.shardResults
  );
  const coverage = result.coverage;
  const fullyScannedShards = shardResults.filter(
    shard => shard.fullSourceScan
  ).length;
  const failedShards =
    projectBackstageNotionPartitionFailedShardTelemetry(
      shardResults
    );
  return Object.freeze({
    fullSourceScan:
      shardResults.length > 0 && fullyScannedShards === shardResults.length,
    shardsFullyScanned: fullyScannedShards,
    universes: result.synchronization.universes.length,
    shards: shardResults.length,
    manifestsPublished: result.synchronization.universes.filter(
      universe => universe.manifestStatus === 'published'
    ).length,
    manifestsBlocked: result.synchronization.universes.filter(
      universe => universe.manifestStatus === 'blocked'
    ).length,
    manifestsDeferred: result.synchronization.universes.filter(
      universe => universe.manifestStatus === 'deferred'
    ).length,
    shardsFresh: shardResults.filter(shard => shard.status === 'fresh').length,
    shardsFailed: shardResults.filter(shard => shard.status === 'failed').length,
    failedShards,
    shardsAborted: shardResults.filter(shard => shard.status === 'aborted').length,
    shardsLeaseBusy: shardResults.filter(shard => shard.status === 'lease-busy').length,
    pages: shardResults.reduce((total, shard) => total + shard.pageCount, 0),
    chunks: shardResults.reduce((total, shard) => total + shard.chunkCount, 0),
    pageVersionsReused: shardResults.reduce(
      (total, shard) => total + shard.pageVersionReuseCount,
      0
    ),
    chunksEmbedded: shardResults.reduce(
      (total, shard) => total + shard.embeddedChunkCount,
      0
    ),
    coverageCompared: coverage.length,
    coverageUnavailable: result.coverageUnavailable,
    coverageWithMonolith: coverage.filter(
      item => item.monolithSnapshotId !== null
    ).length,
    coverageWithPartitionManifest: coverage.filter(
      item => item.partitionManifestId !== null
    ).length,
    coverageCurrentConfiguration: coverage.filter(
      item => item.partitionConfigurationHash === requestedSemanticDigest
    ).length,
    coverageOtherConfiguration: coverage.filter(item => (
      item.partitionManifestId !== null
      && item.partitionConfigurationHash !== requestedSemanticDigest
    )).length,
    coverageExactPageParity: coverage.filter(item => (
      item.monolithSnapshotId !== null
      && item.partitionManifestId !== null
      && item.partitionConfigurationHash === requestedSemanticDigest
      && item.monolithOnlyPageCount === 0
      && item.partitionOnlyPageCount === 0
    )).length,
    monolithOnlyPages: coverage.reduce(
      (total, item) => total + item.monolithOnlyPageCount,
      0
    ),
    partitionOnlyPages: coverage.reduce(
      (total, item) => total + item.partitionOnlyPageCount,
      0
    ),
    monolithChunks: coverage.reduce(
      (total, item) => total + item.monolithChunkCount,
      0
    ),
    partitionChunks: coverage.reduce(
      (total, item) => total + item.partitionChunkCount,
      0
    ),
  });
}

function resolveInitialDelayMs(
  value: number | undefined,
  intervalMs: number
): number {
  if (value === undefined) {
    return intervalMs;
  }
  if (!Number.isFinite(value) || value < 0) {
    return intervalMs;
  }
  return Math.min(intervalMs, Math.trunc(value));
}

/**
 * Start the additive worker-only writer. Read-mode selection remains separate
 * from readiness and the durable monolithic authority latch.
 */
export function startBackstageNotionPartitionShadowLoop(
  dependencies: BackstageNotionPartitionShadowLoopDependencies = {}
): BackstageNotionPartitionShadowLoopHandle {
  const loopLogger = dependencies.logger ?? logger;
  const readEnvironment = dependencies.readEnvironment ?? (name => getEnv(name));
  const policy = resolveBackstageNotionPartitionShadowPolicy(readEnvironment);
  const effectiveReadMode = policy.enabled && policy.requestedMode === 'partitioned'
    ? 'partitioned'
    : 'monolith';
  const policyMetadata = Object.freeze({
    module: 'backstage-notion-partition-shadow',
    modeStatus: policy.modeStatus,
    requestedMode: policy.requestedMode,
    effectiveReadMode,
    partitionSyncEnabled: policy.enabled,
    shadowSyncEnabled: policy.enabled && policy.requestedMode === 'shadow',
    partitionedReadEnabled: effectiveReadMode === 'partitioned',
    cutoverAvailable: true,
    configurationStatus: policy.configurationStatus,
    semanticDigest: policy.semanticDigest,
    configuredUniverses: policy.configuredUniverses,
    configuredShards: policy.configuredShards,
    reasonCode: policy.reasonCode,
  });
  safeLog(
    loopLogger,
    policy.enabled || policy.reasonCode === 'MODE_ABSENT'
      || policy.reasonCode === 'MODE_MONOLITH' ? 'info' : 'warn',
    policy.enabled
      ? 'backstage.notion_partition.shadow_enabled'
      : 'backstage.notion_partition.shadow_disabled',
    policyMetadata
  );
  if (!policy.enabled || !policy.configuration) {
    return Object.freeze({
      enabled: false,
      async stopAndDrain(): Promise<void> {
        return Promise.resolve();
      },
    });
  }

  const intervalMs = resolveBackstageNotionSyncIntervalMs(dependencies.intervalMs);
  const initialDelayMs = resolveInitialDelayMs(dependencies.initialDelayMs, intervalMs);
  const coordinator = dependencies.coordinator
    ?? createBackstageNotionSynchronizationCoordinator();
  const runCycle = dependencies.runCycle ?? (input => runDefaultShadowCycle({
    ...input,
    readEnvironment,
  }));
  const controller = new AbortController();
  let stopped = false;
  let timeoutHandle: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  let drainPromise: Promise<void> | null = null;

  const schedule = (delayMs: number): void => {
    if (stopped || controller.signal.aborted) {
      return;
    }
    timeoutHandle = setTimeout(() => {
      timeoutHandle = null;
      void runOnce();
    }, delayMs);
    timeoutHandle.unref?.();
  };

  const runOnce = (): void => {
    if (stopped || controller.signal.aborted || inFlight) {
      return;
    }
    const startedAt = Date.now();
    let cyclePromise!: Promise<void>;
    cyclePromise = (async () => {
      try {
        const result = await coordinator.runExclusive(() => {
          throwIfAborted(controller.signal);
          return runCycle({
            configuration: policy.configuration!,
            signal: controller.signal,
          });
        });
        throwIfAborted(controller.signal);
        const summary = summarizeCycle(result, policy.semanticDigest!);
        const hasFailures = Number(summary.shardsFailed) > 0
          || Number(summary.shardsAborted) > 0
          || Number(summary.manifestsBlocked) > 0
          || Number(summary.manifestsDeferred) > 0
          || Number(summary.coverageUnavailable) > 0
          || Number(summary.coverageOtherConfiguration) > 0;
        safeLog(
          loopLogger,
          hasFailures ? 'warn' : 'info',
          hasFailures
            ? 'backstage.notion_partition.shadow_cycle_completed_with_failures'
            : 'backstage.notion_partition.shadow_cycle_completed',
          Object.freeze({
            module: 'backstage-notion-partition-shadow',
            effectiveReadMode,
            semanticDigest: policy.semanticDigest,
            durationMs: Date.now() - startedAt,
            ...summary,
          })
        );
      } catch {
        if (!controller.signal.aborted) {
          safeLog(
            loopLogger,
            'warn',
            'backstage.notion_partition.shadow_cycle_failed',
            Object.freeze({
              module: 'backstage-notion-partition-shadow',
              effectiveReadMode,
              semanticDigest: policy.semanticDigest,
              durationMs: Date.now() - startedAt,
              reasonCode: 'SHADOW_CYCLE_FAILED',
            })
          );
        }
      } finally {
        if (inFlight === cyclePromise) {
          inFlight = null;
        }
        schedule(intervalMs);
      }
    })();
    inFlight = cyclePromise;
  };

  const stopInternal = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    controller.abort(dependencies.signal?.reason);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    dependencies.signal?.removeEventListener('abort', onParentAbort);
  };

  const stopAndDrain = (): Promise<void> => {
    if (drainPromise) {
      return drainPromise;
    }
    stopInternal();
    const activeCycle = inFlight;
    drainPromise = (async () => {
      await activeCycle;
      safeLog(
        loopLogger,
        'info',
        'backstage.notion_partition.shadow_drained',
        Object.freeze({
          module: 'backstage-notion-partition-shadow',
          effectiveReadMode,
          drained: true,
        })
      );
    })();
    return drainPromise;
  };

  function onParentAbort(): void {
    void stopAndDrain();
  }

  if (dependencies.signal?.aborted) {
    stopInternal();
  } else {
    dependencies.signal?.addEventListener('abort', onParentAbort, { once: true });
    schedule(initialDelayMs);
  }

  return Object.freeze({ enabled: true, stopAndDrain });
}
