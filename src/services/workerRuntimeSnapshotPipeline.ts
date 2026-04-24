import crypto from 'crypto';

import {
  appendWorkerRuntimeHistory,
  recordWorkerLiveness,
  upsertWorkerRuntimeState,
  type WorkerRuntimeSnapshotRecord
} from '@core/db/repositories/workerRuntimeRepository.js';
import { logger } from '@platform/logging/structuredLogging.js';
import {
  recordWorkerLivenessWrite,
  recordWorkerRuntimeHistoryWrite,
  recordWorkerRuntimeSnapshotSkipped,
  recordWorkerRuntimeStateWrite
} from '@platform/observability/appMetrics.js';
import { resolveErrorMessage } from '@shared/errorUtils.js';

type TimerHandle = ReturnType<typeof setTimeout>;

export interface WorkerRuntimeSnapshotPipelineDependencies {
  recordLiveness: typeof recordWorkerLiveness;
  upsertState: typeof upsertWorkerRuntimeState;
  appendHistory: typeof appendWorkerRuntimeHistory;
  nowMs: () => number;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

export interface WorkerRuntimeSnapshotPipelineOptions {
  coalesceMs?: number;
  historyEnabled?: boolean;
  preserveLegacySnapshot?: boolean;
  skipLogMinIntervalMs?: number;
  dependencies?: Partial<WorkerRuntimeSnapshotPipelineDependencies>;
}

interface PendingSnapshotIntent {
  workerId: string;
  source: string;
  snapshot: WorkerRuntimeSnapshotRecord;
  stateHash: string;
  firstSeenAtMs: number;
  latestSeenAtMs: number;
  timer: TimerHandle | null;
}

const DEFAULT_SNAPSHOT_PIPELINE_COALESCE_MS = 2_000;
const DEFAULT_SKIP_LOG_MIN_INTERVAL_MS = 60_000;

const defaultDependencies: WorkerRuntimeSnapshotPipelineDependencies = {
  recordLiveness: recordWorkerLiveness,
  upsertState: upsertWorkerRuntimeState,
  appendHistory: appendWorkerRuntimeHistory,
  nowMs: () => Date.now(),
  setTimeout,
  clearTimeout
};

export function isWorkerSnapshotPipelineV2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readBooleanEnv(env.WORKER_SNAPSHOT_PIPELINE_V2, false);
}

export function isWorkerSnapshotLegacyPreservationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readBooleanEnv(env.WORKER_SNAPSHOT_PRESERVE_LEGACY_TABLE, true);
}

export function createWorkerRuntimeSnapshotPipelineFromEnv(
  env: NodeJS.ProcessEnv = process.env
): WorkerRuntimeSnapshotPipeline {
  return new WorkerRuntimeSnapshotPipeline({
    coalesceMs: readNumberEnv(env.WORKER_SNAPSHOT_PIPELINE_COALESCE_MS, DEFAULT_SNAPSHOT_PIPELINE_COALESCE_MS),
    historyEnabled: readBooleanEnv(env.WORKER_SNAPSHOT_HISTORY_ENABLED, true),
    preserveLegacySnapshot: isWorkerSnapshotLegacyPreservationEnabled(env)
  });
}

export class WorkerRuntimeSnapshotPipeline {
  private readonly coalesceMs: number;
  private readonly historyEnabled: boolean;
  private readonly preserveLegacySnapshot: boolean;
  private readonly skipLogMinIntervalMs: number;
  private readonly dependencies: WorkerRuntimeSnapshotPipelineDependencies;
  private readonly pendingByWorkerId = new Map<string, PendingSnapshotIntent>();
  private readonly lastPersistedStateHashByWorkerId = new Map<string, string>();
  private readonly inFlightStateHashByWorkerId = new Map<string, string>();
  private readonly skippedWritesByWorkerId = new Map<string, number>();
  private readonly lastSkipLogAtMsByWorkerId = new Map<string, number>();
  private readonly inFlightHistoryWrites = new Set<Promise<void>>();
  private shuttingDown = false;

  constructor(options: WorkerRuntimeSnapshotPipelineOptions = {}) {
    this.coalesceMs = Math.max(0, options.coalesceMs ?? DEFAULT_SNAPSHOT_PIPELINE_COALESCE_MS);
    this.historyEnabled = options.historyEnabled ?? true;
    this.preserveLegacySnapshot = options.preserveLegacySnapshot ?? true;
    this.skipLogMinIntervalMs = Math.max(
      0,
      options.skipLogMinIntervalMs ?? DEFAULT_SKIP_LOG_MIN_INTERVAL_MS
    );
    this.dependencies = {
      ...defaultDependencies,
      ...options.dependencies
    };
  }

  async recordLiveness(
    workerId: string,
    healthStatus: string,
    observedAt: string = new Date(this.dependencies.nowMs()).toISOString()
  ): Promise<void> {
    try {
      await this.dependencies.recordLiveness({
        workerId,
        healthStatus,
        lastSeenAt: observedAt
      });
      recordWorkerLivenessWrite({ outcome: 'ok', healthStatus });
    } catch (error: unknown) {
      recordWorkerLivenessWrite({ outcome: 'error', healthStatus });
      logger.warn('worker.snapshot_pipeline.liveness.failed', {
        module: 'worker-runtime',
        workerId,
        healthStatus,
        error: resolveErrorMessage(error)
      });
    }
  }

  recordSnapshotIntent(
    workerId: string,
    source: string,
    snapshot: WorkerRuntimeSnapshotRecord
  ): void {
    if (this.shuttingDown) {
      return;
    }

    const nowMs = this.dependencies.nowMs();
    const normalizedSource = source || 'unspecified';
    const stateHash = buildWorkerRuntimeSnapshotStateHash(snapshot);
    const lastPersistedStateHash = this.lastPersistedStateHashByWorkerId.get(workerId);
    const existingIntent = this.pendingByWorkerId.get(workerId);

    if (!existingIntent) {
      if (lastPersistedStateHash === stateHash) {
        this.recordSkippedSnapshot(snapshot, normalizedSource, 'no_meaningful_delta');
        return;
      }

      if (this.inFlightStateHashByWorkerId.get(workerId) === stateHash) {
        this.recordSkippedSnapshot(snapshot, normalizedSource, 'in_flight_duplicate');
        return;
      }
    }

    if (existingIntent) {
      existingIntent.source = normalizedSource;
      existingIntent.snapshot = snapshot;
      existingIntent.stateHash = stateHash;
      existingIntent.latestSeenAtMs = nowMs;
      return;
    }

    const pendingIntent: PendingSnapshotIntent = {
      workerId,
      source: normalizedSource,
      snapshot,
      stateHash,
      firstSeenAtMs: nowMs,
      latestSeenAtMs: nowMs,
      timer: null
    };
    this.pendingByWorkerId.set(workerId, pendingIntent);
    this.scheduleFlush(pendingIntent);
  }

  async flushWorker(workerId: string, reason = 'manual'): Promise<void> {
    const pendingIntent = this.pendingByWorkerId.get(workerId);
    if (!pendingIntent) {
      return;
    }

    if (pendingIntent.timer) {
      this.dependencies.clearTimeout(pendingIntent.timer);
      pendingIntent.timer = null;
    }
    this.pendingByWorkerId.delete(workerId);

    const lastPersistedStateHash = this.lastPersistedStateHashByWorkerId.get(workerId);
    if (lastPersistedStateHash === pendingIntent.stateHash) {
      this.recordSkippedSnapshot(pendingIntent.snapshot, pendingIntent.source, 'no_meaningful_delta');
      return;
    }

    this.inFlightStateHashByWorkerId.set(workerId, pendingIntent.stateHash);
    try {
      await this.dependencies.upsertState(pendingIntent.snapshot, {
        source: pendingIntent.source,
        stateHash: pendingIntent.stateHash,
        preserveLegacySnapshot: this.preserveLegacySnapshot
      });
      recordWorkerRuntimeStateWrite({ outcome: 'ok', source: pendingIntent.source });
      this.lastPersistedStateHashByWorkerId.set(workerId, pendingIntent.stateHash);
      this.skippedWritesByWorkerId.set(workerId, 0);
      this.lastSkipLogAtMsByWorkerId.delete(workerId);
      logger.debug('worker.snapshot_pipeline.state.persisted', {
        module: 'worker-runtime',
        workerId,
        source: pendingIntent.source,
        reason,
        coalescedForMs: Math.max(0, pendingIntent.latestSeenAtMs - pendingIntent.firstSeenAtMs),
        stateHash: pendingIntent.stateHash.slice(0, 12)
      });

      if (this.historyEnabled) {
        this.enqueueHistoryWrite(pendingIntent);
      }
    } catch (error: unknown) {
      recordWorkerRuntimeStateWrite({ outcome: 'error', source: pendingIntent.source });
      logger.warn('worker.snapshot_pipeline.state.failed', {
        module: 'worker-runtime',
        workerId,
        source: pendingIntent.source,
        reason,
        stateHash: pendingIntent.stateHash.slice(0, 12),
        error: resolveErrorMessage(error)
      });
    } finally {
      if (this.inFlightStateHashByWorkerId.get(workerId) === pendingIntent.stateHash) {
        this.inFlightStateHashByWorkerId.delete(workerId);
      }
    }
  }

  async flushAll(reason = 'manual'): Promise<void> {
    const workerIds = [...this.pendingByWorkerId.keys()];
    await Promise.all(workerIds.map(workerId => this.flushWorker(workerId, reason)));
    await Promise.allSettled([...this.inFlightHistoryWrites]);
  }

  async shutdown(reason = 'shutdown'): Promise<void> {
    if (this.shuttingDown) {
      await this.flushAll(reason);
      return;
    }

    this.shuttingDown = true;
    for (const pendingIntent of this.pendingByWorkerId.values()) {
      if (pendingIntent.timer) {
        this.dependencies.clearTimeout(pendingIntent.timer);
        pendingIntent.timer = null;
      }
    }
    await this.flushAll(reason);
  }

  private scheduleFlush(pendingIntent: PendingSnapshotIntent): void {
    if (this.coalesceMs === 0) {
      void this.flushWorker(pendingIntent.workerId, 'immediate');
      return;
    }

    pendingIntent.timer = this.dependencies.setTimeout(() => {
      pendingIntent.timer = null;
      void this.flushWorker(pendingIntent.workerId, 'coalesced_timer');
    }, this.coalesceMs);
    if (hasUnref(pendingIntent.timer)) {
      pendingIntent.timer.unref();
    }
  }

  private enqueueHistoryWrite(pendingIntent: PendingSnapshotIntent): void {
    const historyWrite = this.dependencies.appendHistory(pendingIntent.snapshot, {
      source: pendingIntent.source,
      stateHash: pendingIntent.stateHash
    }).then(() => {
      recordWorkerRuntimeHistoryWrite({ outcome: 'ok', source: pendingIntent.source });
    }).catch((error: unknown) => {
      recordWorkerRuntimeHistoryWrite({ outcome: 'error', source: pendingIntent.source });
      logger.warn('worker.snapshot_pipeline.history.failed', {
        module: 'worker-runtime',
        workerId: pendingIntent.workerId,
        source: pendingIntent.source,
        stateHash: pendingIntent.stateHash.slice(0, 12),
        error: resolveErrorMessage(error)
      });
    });

    this.inFlightHistoryWrites.add(historyWrite);
    void historyWrite.finally(() => {
      this.inFlightHistoryWrites.delete(historyWrite);
    });
  }

  private recordSkippedSnapshot(
    snapshot: WorkerRuntimeSnapshotRecord,
    source: string,
    reason: string
  ): void {
    const workerId = snapshot.workerId;
    const skippedCount = (this.skippedWritesByWorkerId.get(workerId) ?? 0) + 1;
    const nowMs = this.dependencies.nowMs();
    const lastSkipLogAtMs = this.lastSkipLogAtMsByWorkerId.get(workerId) ?? 0;
    this.skippedWritesByWorkerId.set(workerId, skippedCount);
    recordWorkerRuntimeSnapshotSkipped({
      source,
      healthStatus: snapshot.healthStatus
    });

    if (lastSkipLogAtMs === 0 || nowMs - lastSkipLogAtMs >= this.skipLogMinIntervalMs) {
      this.lastSkipLogAtMsByWorkerId.set(workerId, nowMs);
      logger.info('worker.snapshot_pipeline.state.skipped', {
        module: 'worker-runtime',
        workerId,
        source,
        healthStatus: snapshot.healthStatus,
        skippedCount,
        reason
      });
    }
  }
}

export function buildWorkerRuntimeSnapshotStateHash(
  record: WorkerRuntimeSnapshotRecord
): string {
  const stablePayload = stableStringify(normalizeWorkerRuntimeSnapshotForHash(record));
  return crypto.createHash('sha256').update(stablePayload).digest('hex');
}

export function normalizeWorkerRuntimeSnapshotForHash(
  record: WorkerRuntimeSnapshotRecord
): Record<string, unknown> {
  return {
    workerType: record.workerType,
    healthStatus: record.healthStatus,
    currentJobId: record.currentJobId,
    lastError: record.lastError,
    startedAt: record.startedAt,
    snapshot: normalizeWorkerRuntimeSnapshotPayloadForHash(record.snapshot)
  };
}

function normalizeWorkerRuntimeSnapshotPayloadForHash(
  snapshot: Record<string, unknown>
): Record<string, unknown> {
  return {
    activeJobs: snapshot.activeJobs,
    processedJobs: snapshot.processedJobs,
    scheduledRetries: snapshot.scheduledRetries,
    terminalFailures: snapshot.terminalFailures,
    recoveredJobs: snapshot.recoveredJobs,
    staleWorkersDetected: snapshot.staleWorkersDetected,
    stalledJobsDetected: snapshot.stalledJobsDetected,
    deadLetterJobs: snapshot.deadLetterJobs,
    recoveryActions: snapshot.recoveryActions,
    lastBudgetPauseReason: snapshot.lastBudgetPauseReason,
    statsWorkerId: snapshot.statsWorkerId,
    watchdog: normalizeWatchdogSnapshotForHash(snapshot.watchdog)
  };
}

function normalizeWatchdogSnapshotForHash(value: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(value)) {
    return null;
  }

  return {
    triggered: value.triggered,
    stale: value.stale,
    restartRecommended: value.restartRecommended,
    staleAfterMs: value.staleAfterMs,
    idleThresholdMs: value.idleThresholdMs
  };
}

function stableStringify(value: unknown): string {
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }

  if (value instanceof Map) {
    const entries = [...value.entries()]
      .map(([entryKey, entryValue]) => [stableStringify(entryKey), stableStringify(entryValue)] as const)
      .sort(([leftKey, leftValue], [rightKey, rightValue]) => (
        leftKey === rightKey
          ? leftValue.localeCompare(rightValue)
          : leftKey.localeCompare(rightKey)
      ));
    return `{"$map":[${entries.map(([entryKey, entryValue]) => `[${entryKey},${entryValue}]`).join(',')}]}`;
  }

  if (value instanceof Set) {
    const entries = [...value.values()]
      .map(entry => stableStringify(entry))
      .sort();
    return `{"$set":[${entries.join(',')}]}`;
  }

  if (Array.isArray(value)) {
    return `[${value.map(entry => stableStringify(entry)).join(',')}]`;
  }

  if (isPlainRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }

  return JSON.stringify(value) ?? 'null';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasUnref(value: unknown): value is { unref: () => void } {
  return typeof value === 'object' &&
    value !== null &&
    'unref' in value &&
    typeof (value as { unref?: unknown }).unref === 'function';
}

function readBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  const normalizedValue = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalizedValue)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalizedValue)) {
    return false;
  }
  return fallback;
}

function readNumberEnv(value: string | undefined, fallback: number): number {
  const parsed = value ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
