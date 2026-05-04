import { getEnv } from '@platform/runtime/env.js';
import { getConfig } from '@platform/runtime/unifiedConfig.js';
import { routeMemorySnapshotStore } from './routeMemorySnapshotStore.js';
import {
  getWorkerControlStatus,
  type WorkerControlStatusResponse
} from './workerControlService.js';
import { getConfiguredTrinitySessionTokenLimit } from '@core/logic/trinityGuards.js';
import { resolveJobWorkerStaleAfterMs } from '@core/db/repositories/jobRepository.js';
import { getWorkerExecutionLimits } from '../workers/workerExecutionLimits.js';

export type TrinityStatusHealth = 'healthy' | 'degraded' | 'offline';
export type TrinityMemorySyncState = 'active' | 'degraded' | 'offline';

export interface TrinityMemorySyncStatus {
  status: TrinityMemorySyncState;
  memoryVersion: string | null;
  lastUpdatedAt: string | null;
  loadedFrom: 'cache' | 'db' | 'created' | null;
  bindingsVersion: string | null;
  trustedSnapshotId: string | null;
  routeCount: number;
}

export interface TrinityRuntimeBindings {
  workerMode: string | null;
  memoryContainer: string | null;
  trinitySession: string | null;
  databaseConfigured: boolean;
}

export interface TrinityRuntimeLimits {
  workerApiTimeoutMs: number;
  workerTrinityRuntimeBudgetMs: number;
  workerTrinityStageTimeoutMs: number;
  dagMaxTokenBudget: number;
  dagNodeTimeoutMs: number;
  dagQueueClaimGraceMs: number;
  sessionTokenLimit: number;
}

export interface TrinityStatusResponse {
  pipeline: 'trinity';
  version: '1.0';
  status: TrinityStatusHealth;
  workersConnected: boolean;
  memorySync: TrinityMemorySyncStatus;
  lastDispatch: string | null;
  lastWorkerHeartbeat: string | null;
  timestamp: string;
  workerHealth: {
    overallStatus: WorkerControlStatusResponse['workerService']['health']['overallStatus'] | 'offline';
    observedWorkerIds: string[];
    queueDepth: number;
    pendingJobs: number;
    runningJobs: number;
  };
  queue: {
    idle: boolean;
    pendingJobs: number;
    runningJobs: number;
    completedJobs: number;
    retainedFailedJobs: number;
    delayedJobs: number;
    stalledRunningJobs: number;
    lastUpdatedAt: string | null;
    semantics: WorkerControlStatusResponse['workerService']['queueSemantics'];
    retryPolicy: WorkerControlStatusResponse['workerService']['retryPolicy'];
    recentFailedJobs: WorkerControlStatusResponse['workerService']['recentFailedJobs'];
  };
  bindings: TrinityRuntimeBindings;
  limits: TrinityRuntimeLimits;
  telemetry: {
    sourceEndpoint: 'trinity.status';
    traceIdPropagation: 'not_exposed';
    pipelineBindingsPublished: true;
    failedJobInspectionEndpoint: '/worker-helper/jobs/failed';
  };
}

function toIsoStringOrNull(value: string | Date | null | undefined): string | null {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function selectLatestIso(...values: Array<string | Date | null | undefined>): string | null {
  const normalizedValues = values
    .map(toIsoStringOrNull)
    .filter((value): value is string => typeof value === 'string');

  if (normalizedValues.length === 0) {
    return null;
  }

  return normalizedValues.sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

/**
 * Build safe runtime binding hints for Trinity observability.
 *
 * Purpose:
 * - Expose the operator-facing environment bindings relevant to Trinity without leaking secrets.
 *
 * Inputs/outputs:
 * - Input: process environment via the shared runtime env helper.
 * - Output: sanitized binding summary for `/trinity/status`.
 *
 * Edge case behavior:
 * - Missing env values are normalized to `null` instead of empty strings.
 */
function buildTrinityRuntimeBindings(): TrinityRuntimeBindings {
  return {
    workerMode: getEnv('WORKER_MODE')?.trim() || null,
    memoryContainer: getEnv('MEMORY_CONTAINER')?.trim() || null,
    trinitySession: getEnv('TRINITY_SESSION')?.trim() || null,
    databaseConfigured: Boolean(getEnv('DATABASE_URL'))
  };
}

/**
 * Build the effective runtime limit summary for Trinity worker and DAG execution.
 *
 * Purpose:
 * - Expose the live timeout and token ceilings that govern long-running Trinity and DAG work.
 *
 * Inputs/outputs:
 * - Input: environment-backed worker execution settings and Trinity session guardrails.
 * - Output: sanitized runtime limit summary for `/trinity/status`.
 *
 * Edge case behavior:
 * - Invalid environment overrides have already fallen back before this payload is assembled.
 */
function buildTrinityRuntimeLimits(): TrinityRuntimeLimits {
  const config = getConfig();
  const workerExecutionLimits = getWorkerExecutionLimits();

  return {
    workerApiTimeoutMs: config.workerApiTimeoutMs,
    workerTrinityRuntimeBudgetMs: workerExecutionLimits.workerTrinityRuntimeBudgetMs,
    workerTrinityStageTimeoutMs: workerExecutionLimits.workerTrinityStageTimeoutMs,
    dagMaxTokenBudget: workerExecutionLimits.dagMaxTokenBudget,
    dagNodeTimeoutMs: workerExecutionLimits.dagNodeTimeoutMs,
    dagQueueClaimGraceMs: workerExecutionLimits.dagQueueClaimGraceMs,
    sessionTokenLimit: getConfiguredTrinitySessionTokenLimit()
  };
}

/**
 * Resolve the Trinity memory synchronization snapshot state.
 *
 * Purpose:
 * - Surface whether the DB-backed route memory snapshot layer is available and current enough to inspect.
 *
 * Inputs/outputs:
 * - Input: none.
 * - Output: normalized memory synchronization status payload.
 *
 * Edge case behavior:
 * - Snapshot load failures degrade to `offline` without throwing so the status route still responds.
 */
async function getTrinityMemorySyncStatus(): Promise<TrinityMemorySyncStatus> {
  try {
    const snapshotRecord = await routeMemorySnapshotStore.getSnapshot({ forceRefresh: true });

    return {
      status: 'active',
      memoryVersion: snapshotRecord.memoryVersion,
      lastUpdatedAt: snapshotRecord.snapshot.updated_at,
      loadedFrom: snapshotRecord.loadedFrom,
      bindingsVersion: snapshotRecord.snapshot.bindings_version,
      trustedSnapshotId: snapshotRecord.snapshot.trusted_snapshot_id ?? null,
      routeCount: Object.keys(snapshotRecord.snapshot.route_state).length
    };
  } catch {
    return {
      status: 'offline',
      memoryVersion: null,
      lastUpdatedAt: null,
      loadedFrom: null,
      bindingsVersion: null,
      trustedSnapshotId: null,
      routeCount: 0
    };
  }
}

/**
 * Load the combined worker-control status with an offline fallback.
 *
 * Purpose:
 * - Keep `/trinity/status` available even when worker-control telemetry is temporarily unavailable.
 *
 * Inputs/outputs:
 * - Input: none.
 * - Output: live worker status payload or `null` when the worker-control layer cannot be read.
 *
 * Edge case behavior:
 * - Returns `null` instead of throwing so the caller can downgrade Trinity health deterministically.
 */
async function getWorkerControlStatusSafe(): Promise<WorkerControlStatusResponse | null> {
  try {
    return await getWorkerControlStatus();
  } catch {
    return null;
  }
}

/**
 * Build fallback queue semantics when worker-control telemetry is unavailable.
 *
 * Purpose:
 * - Keep `/trinity/status` self-describing even if the worker-control layer cannot be read.
 *
 * Inputs/outputs:
 * - Input: none.
 * - Output: stable queue semantics metadata.
 *
 * Edge case behavior:
 * - Returns the same contract regardless of runtime state so probes can rely on field presence.
 */
function buildFallbackQueueSemantics(): WorkerControlStatusResponse['workerService']['queueSemantics'] {
  return {
    failedCountMode: 'retained_terminal_jobs',
    failedCountDescription:
      'The failed counter represents job rows currently retained in terminal failed state. It is not a count of currently running failures.',
    activeFailureSignals: ['stalledRunning', 'oldestPendingJobAgeMs', 'recentFailed', 'workerHeartbeatAgeMs']
  };
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const rawValue = getEnv(name);
  const parsedValue = rawValue ? Number(rawValue) : Number.NaN;

  //audit Assumption: status probes should reflect the effective retry policy, not leak invalid env parsing artifacts; failure risk: malformed env values produce NaN fields in health payloads; expected invariant: numeric policy fields always fall back to safe defaults; handling strategy: validate positivity before returning.
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return fallback;
  }

  return Math.trunc(parsedValue);
}

/**
 * Build fallback retry policy values when worker-control telemetry is unavailable.
 *
 * Purpose:
 * - Preserve retry-policy observability for `/trinity/status` even during degraded worker-control reads.
 *
 * Inputs/outputs:
 * - Input: process env through the shared runtime helper.
 * - Output: normalized retry policy summary.
 *
 * Edge case behavior:
 * - Invalid or missing env values fall back to the documented defaults.
 */
function buildFallbackRetryPolicy(): WorkerControlStatusResponse['workerService']['retryPolicy'] {
  return {
    defaultMaxRetries: readPositiveIntegerEnv('JOB_WORKER_MAX_RETRIES', 2),
    retryBackoffBaseMs: readPositiveIntegerEnv('JOB_WORKER_RETRY_BASE_MS', 2_000),
    retryBackoffMaxMs: readPositiveIntegerEnv('JOB_WORKER_RETRY_MAX_MS', 60_000),
    staleAfterMs: resolveJobWorkerStaleAfterMs(),
    watchdogIdleMs: readPositiveIntegerEnv('JOB_WORKER_WATCHDOG_IDLE_MS', 120_000)
  };
}

/**
 * Determine whether Trinity has live worker connectivity.
 *
 * Purpose:
 * - Convert the mixed in-process and queue-observed worker telemetry into one boolean for external probes.
 *
 * Inputs/outputs:
 * - Input: combined worker-control status payload.
 * - Output: `true` when either the in-process runtime is started or queue workers are observed online.
 *
 * Edge case behavior:
 * - Offline queue observation still reports `true` when the in-process worker runtime is active.
 */
function resolveWorkersConnected(workerStatus: WorkerControlStatusResponse): boolean {
  const hasStartedMainRuntime =
    workerStatus.mainApp.runtime.enabled && workerStatus.mainApp.runtime.started;
  const hasObservedQueueWorker = workerStatus.workerService.health.workers.some(
    worker => worker.healthStatus !== 'offline'
  );

  return hasStartedMainRuntime || hasObservedQueueWorker;
}

/**
 * Build the aggregate Trinity health classification.
 *
 * Purpose:
 * - Give probes one coarse status signal derived from worker connectivity, DB availability, and memory sync state.
 *
 * Inputs/outputs:
 * - Input: worker connectivity, DB connectivity, and memory sync state.
 * - Output: aggregate Trinity health classification.
 *
 * Edge case behavior:
 * - Missing workers or offline memory sync returns `offline`; partial connectivity returns `degraded`.
 */
function resolveTrinityHealthStatus(
  workersConnected: boolean,
  databaseConnected: boolean,
  memorySyncStatus: TrinityMemorySyncState
): TrinityStatusHealth {
  //audit Assumption: Trinity cannot be considered online without both worker connectivity and snapshot-backed memory visibility; failure risk: probes report a healthy pipeline while core bindings are broken; expected invariant: missing workers or offline memory sync yields `offline`; handling strategy: fail closed before considering degraded or healthy states.
  if (!workersConnected || memorySyncStatus === 'offline') {
    return 'offline';
  }

  //audit Assumption: database disconnection or degraded memory sync should not look fully healthy; failure risk: operators miss partial outages; expected invariant: partial observability downgrades the route to `degraded`; handling strategy: branch before the healthy case.
  if (!databaseConnected || memorySyncStatus === 'degraded') {
    return 'degraded';
  }

  return 'healthy';
}

/**
 * Build the public Trinity status payload.
 *
 * Purpose:
 * - Expose one stable health and binding view for the Trinity pipeline across API, workers, and the route-memory snapshot layer.
 *
 * Inputs/outputs:
 * - Input: live worker-control status plus snapshot-backed memory sync state.
 * - Output: `TrinityStatusResponse`.
 *
 * Edge case behavior:
 * - Memory snapshot failures remain visible in the payload while still allowing the route to answer.
 */
export async function getTrinityStatus(): Promise<TrinityStatusResponse> {
  const [workerStatus, memorySync] = await Promise.all([
    getWorkerControlStatusSafe(),
    getTrinityMemorySyncStatus()
  ]);
  const workersConnected = workerStatus ? resolveWorkersConnected(workerStatus) : false;
  const databaseConnected = workerStatus?.workerService.database.connected === true;
  const status = resolveTrinityHealthStatus(workersConnected, databaseConnected, memorySync.status);
  const observedWorkerIds = workerStatus?.workerService.health.workers.map(worker => worker.workerId) ?? [];
  const queueSummary = workerStatus?.workerService.queueSummary ?? null;
  const latestJobUpdatedAt = workerStatus?.workerService.latestJob?.updated_at;
  const lastDispatch = selectLatestIso(workerStatus?.mainApp.runtime.lastDispatchAt, latestJobUpdatedAt);
  const lastWorkerHeartbeat = selectLatestIso(
    ...(workerStatus?.workerService.health.workers.map(worker => worker.lastHeartbeatAt) ?? [])
  );
  const queueSemantics =
    workerStatus?.workerService.queueSemantics ?? buildFallbackQueueSemantics();
  const retryPolicy =
    workerStatus?.workerService.retryPolicy ?? buildFallbackRetryPolicy();
  const recentFailedJobs = workerStatus?.workerService.recentFailedJobs ?? [];
  const pendingJobs = queueSummary?.pending ?? 0;
  const runningJobs = queueSummary?.running ?? 0;
  const completedJobs = queueSummary?.completed ?? 0;
  const retainedFailedJobs = queueSummary?.failed ?? 0;
  const delayedJobs = queueSummary?.delayed ?? 0;
  const stalledRunningJobs = queueSummary?.stalledRunning ?? 0;

  return {
    pipeline: 'trinity',
    version: '1.0',
    status,
    workersConnected,
    memorySync,
    lastDispatch,
    lastWorkerHeartbeat,
    timestamp: new Date().toISOString(),
    workerHealth: {
      overallStatus: workerStatus?.workerService.health.overallStatus ?? 'offline',
      observedWorkerIds,
      queueDepth: pendingJobs + runningJobs,
      pendingJobs,
      runningJobs
    },
    queue: {
      idle: pendingJobs === 0 && runningJobs === 0,
      pendingJobs,
      runningJobs,
      completedJobs,
      retainedFailedJobs,
      delayedJobs,
      stalledRunningJobs,
      lastUpdatedAt: queueSummary?.lastUpdatedAt ?? null,
      semantics: queueSemantics,
      retryPolicy,
      recentFailedJobs
    },
    bindings: buildTrinityRuntimeBindings(),
    limits: buildTrinityRuntimeLimits(),
    telemetry: {
      sourceEndpoint: 'trinity.status',
      traceIdPropagation: 'not_exposed',
      pipelineBindingsPublished: true,
      failedJobInspectionEndpoint: '/worker-helper/jobs/failed'
    }
  };
}
