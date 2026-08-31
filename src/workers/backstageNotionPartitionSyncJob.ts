import {
  BackstageNotionPartitionRepositoryError,
  BackstageNotionPartitionRepositoryUnavailableError,
} from '@core/db/repositories/backstageNotionPartitionRepository.js';
import {
  BackstageNotionPartitionSyncError,
  type BackstageNotionPartitionSynchronizationResult,
} from '@services/backstageNotionPartitionSync.js';
import {
  BACKSTAGE_NOTION_PARTITION_SYNC_RESULT_PROTOCOL,
  BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_VERSION,
  parseBackstageNotionPartitionSyncJobInput,
  parseBackstageNotionPartitionSyncJobResult,
  type BackstageNotionPartitionSyncJobInput,
  type BackstageNotionPartitionSyncJobResult,
  type BackstageNotionPartitionSyncOperationReasonCode,
} from '@shared/jobs/backstageNotionPartitionSyncJob.js';
import {
  resolveBackstageNotionPartitionShadowPolicy,
  runBackstageNotionPartitionSynchronizationCycle,
  type BackstageNotionPartitionSynchronizationCycleInput,
} from './backstageNotionPartitionShadowLoop.js';
import type {
  BackstageNotionSynchronizationCoordinator,
} from './backstageNotionSyncLoop.js';
import {
  classifyWorkerAiBudgetError,
  normalizeWorkerAiBudgetError,
} from '@core/adapters/openai.adapter.js';

const EMPTY_PAGE_CHANGES = Object.freeze({
  added: 0,
  changed: 0,
  moved: 0,
  deleted: 0,
  unchanged: 0,
});

const TRANSIENT_INFRASTRUCTURE_CODES = new Set([
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01',
  '53300',
  '53400',
  '57P01',
  '57P02',
  '57P03',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETDOWN',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export interface BackstageNotionPartitionSyncJobExecutionOutcome {
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly output: BackstageNotionPartitionSyncJobResult | null;
  readonly errorMessage?: string;
  readonly retryable?: boolean;
}

export interface BackstageNotionPartitionSyncJobExecutionInput {
  readonly rawInput: unknown;
  readonly cancellationSignal: AbortSignal;
}

export type BackstageNotionPartitionSyncJobExecutor = (
  input: BackstageNotionPartitionSyncJobExecutionInput
) => Promise<BackstageNotionPartitionSyncJobExecutionOutcome>;

export interface BackstageNotionPartitionSyncJobExecutorDependencies {
  readonly coordinator: BackstageNotionSynchronizationCoordinator;
  readonly readEnvironment?: (name: string) => string | undefined;
  readonly runSynchronization?: (
    input: BackstageNotionPartitionSynchronizationCycleInput
  ) => Promise<BackstageNotionPartitionSynchronizationResult>;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError');
}

function buildZeroResult(
  input: BackstageNotionPartitionSyncJobInput,
  safeReasonCode: BackstageNotionPartitionSyncOperationReasonCode
): BackstageNotionPartitionSyncJobResult {
  return Object.freeze({
    protocol: BACKSTAGE_NOTION_PARTITION_SYNC_RESULT_PROTOCOL,
    version: BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_VERSION,
    outcome: 'completed_with_errors',
    safeReasonCode,
    universeId: input.universeId,
    shardKey: input.shardKey,
    fullSourceScan: false,
    manifestStatus: 'not_attempted',
    manifestId: null,
    freshSnapshotId: null,
    pageCount: 0,
    chunkCount: 0,
    pageVersionReuseCount: 0,
    embeddedChunkCount: 0,
    pageChanges: EMPTY_PAGE_CHANGES,
  });
}

function completedWithReason(
  input: BackstageNotionPartitionSyncJobInput,
  reasonCode: BackstageNotionPartitionSyncOperationReasonCode
): BackstageNotionPartitionSyncJobExecutionOutcome {
  return Object.freeze({
    status: 'completed',
    output: buildZeroResult(input, reasonCode),
    retryable: false,
  });
}

function projectSynchronizationResult(
  input: BackstageNotionPartitionSyncJobInput,
  synchronization: BackstageNotionPartitionSynchronizationResult
): BackstageNotionPartitionSyncJobResult {
  const universe = synchronization.universes.find(
    candidate => candidate.universeId === input.universeId
  );
  const shard = universe?.shardResults.find(
    candidate => candidate.shardKey === input.shardKey
  );
  if (!universe || !shard || shard.status === 'not-requested') {
    return buildZeroResult(input, 'SYNC_FAILED');
  }

  let safeReasonCode: BackstageNotionPartitionSyncOperationReasonCode | null =
    shard.status === 'fresh'
      ? null
      : shard.safeReasonCode ?? 'SYNC_FAILED';
  const targetOwnershipOmission = universe.manifestOmissions.find(omission => (
    omission.shardKey === input.shardKey
    && omission.safeReasonCode === 'SHARD_OWNERSHIP_CONFLICT'
  ));
  if (safeReasonCode === null && targetOwnershipOmission) {
    safeReasonCode = 'SHARD_OWNERSHIP_CONFLICT';
  } else if (safeReasonCode === null && universe.manifestStatus === 'blocked') {
    safeReasonCode = 'MANIFEST_BLOCKED';
  } else if (safeReasonCode === null && universe.manifestStatus === 'deferred') {
    safeReasonCode = 'MANIFEST_DEFERRED';
  }

  const candidate: BackstageNotionPartitionSyncJobResult = {
    protocol: BACKSTAGE_NOTION_PARTITION_SYNC_RESULT_PROTOCOL,
    version: BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_VERSION,
    outcome: safeReasonCode === null
      ? 'synchronized'
      : 'completed_with_errors',
    safeReasonCode,
    universeId: input.universeId,
    shardKey: input.shardKey,
    fullSourceScan: shard.fullSourceScan,
    manifestStatus: universe.manifestStatus,
    manifestId: universe.manifestId,
    freshSnapshotId: shard.freshSnapshotId,
    pageCount: shard.pageCount,
    chunkCount: shard.chunkCount,
    pageVersionReuseCount: shard.pageVersionReuseCount,
    embeddedChunkCount: shard.embeddedChunkCount,
    pageChanges: shard.pageChanges,
  };
  return parseBackstageNotionPartitionSyncJobResult(candidate)
    ?? buildZeroResult(input, 'SYNC_FAILED');
}

function mapSyncErrorReason(
  error: BackstageNotionPartitionSyncError
): BackstageNotionPartitionSyncOperationReasonCode {
  switch (error.code) {
    case 'BACKSTAGE_NOTION_PARTITION_SYNC_CONFIGURATION_INVALID':
      return 'CONFIGURATION_UNAVAILABLE';
    case 'BACKSTAGE_NOTION_PARTITION_SYNC_STALE_CONFIGURATION':
      return 'CONFIGURATION_STALE';
    case 'BACKSTAGE_NOTION_PARTITION_SYNC_CAPTURE_INCOMPLETE':
      return 'SHARD_CAPTURE_INCOMPLETE';
    case 'BACKSTAGE_NOTION_PARTITION_SYNC_CAPACITY_EXCEEDED':
      return 'SHARD_CAPACITY_EXCEEDED';
    case 'BACKSTAGE_NOTION_PARTITION_SYNC_SOURCE_DRIFT':
      return 'SHARD_SOURCE_DRIFT';
    case 'BACKSTAGE_NOTION_PARTITION_SYNC_LEASE_LOST':
      return 'SHARD_LEASE_LOST';
  }
}

function mapRepositoryErrorReason(
  error: BackstageNotionPartitionRepositoryError
): BackstageNotionPartitionSyncOperationReasonCode {
  switch (error.code) {
    case 'BACKSTAGE_NOTION_PARTITION_STALE_CONFIGURATION':
      return 'CONFIGURATION_STALE';
    case 'BACKSTAGE_NOTION_PARTITION_LEASE_LOST':
      return 'SHARD_LEASE_LOST';
    case 'BACKSTAGE_NOTION_PARTITION_OWNERSHIP_CONFLICT':
      return 'SHARD_OWNERSHIP_CONFLICT';
    default:
      return 'SYNC_FAILED';
  }
}

function isTransientInfrastructureError(error: unknown): boolean {
  if (error instanceof BackstageNotionPartitionRepositoryUnavailableError) {
    return true;
  }
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as { code?: unknown; name?: unknown };
  if (
    candidate.name === 'JobRepositoryUnavailableError'
    || candidate.name === 'ConnectionError'
  ) {
    return true;
  }
  return typeof candidate.code === 'string'
    && TRANSIENT_INFRASTRUCTURE_CODES.has(candidate.code.toUpperCase());
}

function configurationUnavailableReason(
  reasonCode: ReturnType<typeof resolveBackstageNotionPartitionShadowPolicy>['reasonCode']
): BackstageNotionPartitionSyncOperationReasonCode {
  return reasonCode === 'MODE_ABSENT'
    || reasonCode === 'MODE_INVALID'
    || reasonCode === 'MODE_MONOLITH'
    || reasonCode === 'PARTITIONED_CUTOVER_GATE_CLOSED'
    || reasonCode === 'PARTITIONED_ENABLED'
    ? 'MODE_DISABLED'
    : 'CONFIGURATION_UNAVAILABLE';
}

/** Build an executor around the worker's one shared Notion synchronization lock. */
export function createBackstageNotionPartitionSyncJobExecutor(
  dependencies: BackstageNotionPartitionSyncJobExecutorDependencies
): BackstageNotionPartitionSyncJobExecutor {
  const readEnvironment = dependencies.readEnvironment;
  const runSynchronization = dependencies.runSynchronization
    ?? runBackstageNotionPartitionSynchronizationCycle;

  return async ({ rawInput, cancellationSignal }) => {
    const parsedInput = parseBackstageNotionPartitionSyncJobInput(rawInput);
    if (!parsedInput) {
      return Object.freeze({
        status: 'failed',
        output: null,
        errorMessage: 'Invalid partition synchronization job input.',
        retryable: false,
      });
    }

    try {
      return await dependencies.coordinator.runExclusive(async () => {
        throwIfAborted(cancellationSignal);

        // Re-read the live mode, exact configuration, digest, and target after
        // waiting for any scheduled crawl and before constructing effectful
        // repository/provider dependencies.
        const policy = resolveBackstageNotionPartitionShadowPolicy(
          readEnvironment
        );
        if (
          !policy.enabled
          || !policy.partitionSyncEnabled
          || !policy.configuration
        ) {
          return completedWithReason(
            parsedInput,
            configurationUnavailableReason(policy.reasonCode)
          );
        }
        if (
          policy.semanticDigest !== parsedInput.configurationDigest
          || policy.configuration.generation
            !== parsedInput.configurationGeneration
        ) {
          return completedWithReason(parsedInput, 'CONFIGURATION_STALE');
        }
        const universe = policy.configuration.universes.find(
          candidate => candidate.universeId === parsedInput.universeId
        );
        const shard = universe?.shards.find(
          candidate => candidate.shardKey === parsedInput.shardKey
        );
        if (!universe || !shard) {
          return completedWithReason(parsedInput, 'TARGET_UNAVAILABLE');
        }

        throwIfAborted(cancellationSignal);
        const synchronization = await runSynchronization({
          configuration: policy.configuration,
          signal: cancellationSignal,
          readEnvironment,
          selection: {
            universeId: parsedInput.universeId,
            shardKey: parsedInput.shardKey,
          },
        });
        throwIfAborted(cancellationSignal);
        return Object.freeze({
          status: 'completed',
          output: projectSynchronizationResult(parsedInput, synchronization),
          retryable: false,
        });
      });
    } catch (error: unknown) {
      if (cancellationSignal.aborted) {
        return Object.freeze({
          status: 'cancelled',
          output: null,
          errorMessage: 'Partition synchronization cancellation requested.',
          retryable: false,
        });
      }
      const normalizedWorkerBudgetError = normalizeWorkerAiBudgetError(error);
      if (classifyWorkerAiBudgetError(normalizedWorkerBudgetError)) {
        throw normalizedWorkerBudgetError;
      }
      if (isTransientInfrastructureError(error)) {
        return Object.freeze({
          status: 'failed',
          output: null,
          errorMessage:
            'Partition synchronization infrastructure is temporarily unavailable.',
          retryable: true,
        });
      }
      if (error instanceof BackstageNotionPartitionSyncError) {
        return completedWithReason(parsedInput, mapSyncErrorReason(error));
      }
      if (error instanceof BackstageNotionPartitionRepositoryError) {
        return completedWithReason(parsedInput, mapRepositoryErrorReason(error));
      }
      return Object.freeze({
        status: 'failed',
        output: null,
        errorMessage: 'Partition synchronization execution failed.',
        retryable: false,
      });
    }
  };
}
