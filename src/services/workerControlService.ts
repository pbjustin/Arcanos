import { z } from 'zod';
import { getStatus as getDatabaseStatus } from '@core/db/index.js';
import type { JobData } from '@core/db/schema.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import {
  createJob,
  getJobById,
  getJobQueueSummary,
  getLatestJob,
  listFailedJobs,
  type JobQueueSummary
} from '@core/db/repositories/jobRepository.js';
import type { WorkerRuntimeSnapshotRecord } from '@core/db/repositories/workerRuntimeRepository.js';
import {
  dispatchArcanosTask,
  getWorkerRuntimeStatus,
  startWorkers,
  type WorkerDispatchOptions,
  type WorkerResult,
  type WorkerRuntimeStatus
} from '@platform/runtime/workerConfig.js';
import {
  buildQueuedAskJobInput,
  buildQueuedAskPendingResponse,
  type QueuedAskPendingResponse
} from '@shared/ask/asyncAskJob.js';
import type { PreviewAskChaosHook } from '@shared/ask/previewChaos.js';
import type { ClientContextDTO } from '@shared/types/dto.js';
import { detectCognitiveDomain } from '@dispatcher/detectCognitiveDomain.js';
import type { CognitiveDomain } from '@shared/types/cognitiveDomain.js';
import { recordSelfHealEvent } from '@services/selfImprove/selfHealTelemetry.js';
import {
  getWorkerAutonomyHealthReport,
  getWorkerAutonomySettings,
  planAutonomousWorkerJob,
  type WorkerAutonomyHealthReport
} from './workerAutonomyService.js';

const workerControlDomainSchema = z.enum(['diagnostic', 'code', 'creative', 'natural', 'execution']);

/**
 * Snapshot of a queued worker job without large output payloads.
 *
 * Purpose:
 * - Provide stable job metadata for status views and summaries.
 *
 * Inputs/outputs:
 * - Input: database `JobData` row.
 * - Output: compact job snapshot safe for repeated polling.
 *
 * Edge case behavior:
 * - `completed_at` and `error_message` are normalized to `null` when absent.
 */
export interface WorkerJobSnapshot {
  id: string;
  worker_id: string;
  job_type: string;
  status: string;
  created_at: string | Date;
  updated_at: string | Date;
  completed_at: string | Date | null;
  error_message: string | null;
}

/**
 * Full queued worker job view, including output payload.
 *
 * Purpose:
 * - Support CLI and AI inspection of completed or failed job details.
 *
 * Inputs/outputs:
 * - Input: database `JobData` row.
 * - Output: detailed job payload including `output`.
 *
 * Edge case behavior:
 * - `output` is normalized to `null` when absent.
 */
export interface WorkerJobDetailSnapshot extends WorkerJobSnapshot {
  output: unknown;
}

/**
 * Compact failed-job view for operator inspection.
 *
 * Purpose:
 * - Surface retained terminal queue failures without requiring direct DB access.
 *
 * Inputs/outputs:
 * - Input: database `job_data` row subset for failed jobs.
 * - Output: stable failed-job snapshot with retry metadata.
 *
 * Edge case behavior:
 * - `last_worker_id` and `completed_at` normalize to `null` when absent.
 */
export interface FailedWorkerJobSnapshot {
  id: string;
  worker_id: string;
  last_worker_id: string | null;
  job_type: string;
  status: 'failed';
  error_message: string | null;
  retry_count: number;
  max_retries: number;
  created_at: string | Date;
  updated_at: string | Date;
  completed_at: string | Date | null;
}

/**
 * Semantics attached to queue counters exposed by worker-control routes.
 *
 * Purpose:
 * - Prevent probes from misreading retained terminal rows as active runtime failures.
 *
 * Inputs/outputs:
 * - Input: none.
 * - Output: fixed semantics metadata describing the queue summary counters.
 *
 * Edge case behavior:
 * - Always returns the same stable contract so external tooling can rely on the wording.
 */
export interface WorkerQueueSemantics {
  failedCountMode: 'retained_terminal_jobs';
  failedCountDescription: string;
  activeFailureSignals: string[];
}

/**
 * Retry policy summary for queue-backed Trinity workers.
 *
 * Purpose:
 * - Expose the effective retry and stale-lease thresholds used by the dedicated worker service.
 *
 * Inputs/outputs:
 * - Input: normalized worker autonomy settings.
 * - Output: stable retry policy summary for operator probes.
 *
 * Edge case behavior:
 * - Values always resolve from defaults when env overrides are absent.
 */
export interface WorkerRetryPolicySummary {
  defaultMaxRetries: number;
  retryBackoffBaseMs: number;
  retryBackoffMaxMs: number;
  staleAfterMs: number;
  watchdogIdleMs: number;
}

export interface WorkerControlWorkerSnapshot {
  workerId: string;
  workerType: string;
  healthStatus: string;
  currentJobId: string | null;
  lastError: string | null;
  lastHeartbeatAt: string | null;
  lastActivityAt: string | null;
  lastProcessedJobAt: string | null;
  inactivityMs: number | null;
  processedJobs?: number;
  scheduledRetries?: number;
  terminalFailures?: number;
  recoveredJobs?: number;
  updatedAt: string;
  watchdog: {
    triggered: boolean;
    reason: string | null;
    restartRecommended: boolean;
    idleThresholdMs: number | null;
  };
}

/**
 * Combined worker-control status view for the main app and dedicated worker service.
 *
 * Purpose:
 * - Expose one coherent operational status payload across HTTP, CLI, and AI tooling.
 *
 * Inputs/outputs:
 * - Input: runtime state and queue summary from existing worker subsystems.
 * - Output: status JSON with queue-observed worker service details.
 *
 * Edge case behavior:
 * - Queue summary and latest job are `null` when the database is unavailable.
 */
export interface WorkerControlStatusResponse {
  timestamp: string;
  mainApp: {
    connected: true;
    workerId: string;
    runtime: WorkerRuntimeStatus;
  };
  workerService: {
    observationMode: 'queue-observed';
    database: ReturnType<typeof getDatabaseStatus>;
    queueSummary: JobQueueSummary | null;
    queueSemantics: WorkerQueueSemantics;
    retryPolicy: WorkerRetryPolicySummary;
    recentFailedJobs: FailedWorkerJobSnapshot[];
    latestJob: WorkerJobSnapshot | null;
    health: {
      overallStatus: WorkerAutonomyHealthReport['overallStatus'];
      alerts: string[];
      workers: WorkerControlWorkerSnapshot[];
    };
  };
}

/**
 * Dedicated health view for the autonomous queue worker.
 *
 * Purpose:
 * - Surface persisted queue-worker health, budgets, and alerts without requiring callers to infer them from raw queue counts.
 *
 * Inputs/outputs:
 * - Input: persisted worker snapshots and queue summary.
 * - Output: autonomy-focused health report for CLI, HTTP, and AI tooling.
 *
 * Edge case behavior:
 * - Returns `offline` overall status when no worker snapshots exist and the queue is idle.
 */
export interface WorkerControlHealthResponse extends Omit<WorkerAutonomyHealthReport, 'workers'> {
  workers: WorkerControlWorkerSnapshot[];
  queueSemantics: WorkerQueueSemantics;
  retryPolicy: WorkerRetryPolicySummary;
  recentFailedJobs: FailedWorkerJobSnapshot[];
}

/**
 * Request payload for queueing dedicated-worker async `/ask` jobs.
 *
 * Purpose:
 * - Capture the queueable subset of worker-control input.
 *
 * Inputs/outputs:
 * - Input: prompt plus optional routing/session metadata.
 * - Output: normalized queue request consumed by `queueWorkerAsk`.
 *
 * Edge case behavior:
 * - `endpointName` defaults to `worker-helper` when omitted.
 */
export interface QueueWorkerAskRequest {
  prompt: string;
  sessionId?: string;
  overrideAuditSafe?: string;
  cognitiveDomain?: CognitiveDomain;
  clientContext?: ClientContextDTO | null;
  endpointName?: string;
  workerId?: string;
  previewChaosHook?: PreviewAskChaosHook;
}

/**
 * Response returned after queueing dedicated-worker async work.
 *
 * Purpose:
 * - Preserve the poll contract while surfacing domain routing metadata.
 *
 * Inputs/outputs:
 * - Input: created job record plus resolved domain metadata.
 * - Output: pollable async queue response.
 *
 * Edge case behavior:
 * - Domain source reflects whether the caller provided or the service detected the routing hint.
 */
export interface QueueWorkerAskResponse extends QueuedAskPendingResponse {
  endpoint: string;
  cognitiveDomain: CognitiveDomain;
  cognitiveDomainSource: 'provided' | 'detected';
}

/**
 * Request payload for direct in-process worker dispatch.
 *
 * Purpose:
 * - Route immediate worker execution through the same service used by HTTP and AI tooling.
 *
 * Inputs/outputs:
 * - Input: worker input plus optional retry and routing metadata.
 * - Output: normalized dispatch request passed to `dispatchWorkerInput`.
 *
 * Edge case behavior:
 * - Omitted retry values fall back to worker runtime defaults.
 */
export interface DispatchWorkerInputRequest extends WorkerDispatchOptions {
  input: string;
}

/**
 * Response returned after direct in-process worker dispatch.
 *
 * Purpose:
 * - Surface direct worker results with the same structure across helper routes and AI tools.
 *
 * Inputs/outputs:
 * - Input: runtime dispatch results.
 * - Output: summarized dispatch payload with both primary and full results.
 *
 * Edge case behavior:
 * - `primaryResult` becomes `null` if no worker produced an output.
 */
export interface DispatchWorkerInputResponse {
  timestamp: string;
  mode: 'direct-dispatch';
  input: string;
  resultCount: number;
  primaryResult: WorkerResult | null;
  results: WorkerResult[];
}

/**
 * Response returned after healing or restarting the in-process worker runtime.
 *
 * Purpose:
 * - Give callers restart feedback plus the resulting runtime snapshot.
 *
 * Inputs/outputs:
 * - Input: optional force flag.
 * - Output: restart summary and latest runtime status.
 *
 * Edge case behavior:
 * - Defaults to forced restart when `force` is omitted.
 */
export interface HealWorkerRuntimeResponse {
  timestamp: string;
  requestedForce: boolean;
  restart: Awaited<ReturnType<typeof startWorkers>>;
  runtime: WorkerRuntimeStatus;
}

/**
 * Domain resolution result for worker queue and dispatch requests.
 *
 * Purpose:
 * - Make explicit whether routing came from the caller or heuristic detection.
 *
 * Inputs/outputs:
 * - Input: prompt and optional caller-provided domain.
 * - Output: resolved domain with provenance.
 *
 * Edge case behavior:
 * - Falls back to heuristic detection when the caller omits a domain.
 */
export interface ResolvedWorkerDomain {
  cognitiveDomain: CognitiveDomain;
  source: 'provided' | 'detected';
}

function buildWorkerJobSnapshot(job: JobData): WorkerJobSnapshot {
  return {
    id: job.id,
    worker_id: job.worker_id,
    job_type: job.job_type,
    status: job.status,
    created_at: job.created_at,
    updated_at: job.updated_at,
    completed_at: job.completed_at ?? null,
    error_message: job.error_message ?? null
  };
}

function buildWorkerJobDetailSnapshot(job: JobData): WorkerJobDetailSnapshot {
  return {
    ...buildWorkerJobSnapshot(job),
    output: job.output ?? null
  };
}

function buildFailedWorkerJobSnapshot(
  failedJob: Awaited<ReturnType<typeof listFailedJobs>>[number]
): FailedWorkerJobSnapshot {
  return {
    id: failedJob.id,
    worker_id: failedJob.worker_id,
    last_worker_id: failedJob.last_worker_id ?? null,
    job_type: failedJob.job_type,
    status: 'failed',
    error_message: failedJob.error_message ?? null,
    retry_count: Number(failedJob.retry_count ?? 0),
    max_retries: Number(failedJob.max_retries ?? 0),
    created_at: failedJob.created_at,
    updated_at: failedJob.updated_at,
    completed_at: failedJob.completed_at ?? null
  };
}

/**
 * Describe how queue failure counts should be interpreted by probes.
 *
 * Purpose:
 * - Make the persisted queue summary self-describing so operators can distinguish retained failures from active incidents.
 *
 * Inputs/outputs:
 * - Input: none.
 * - Output: immutable queue semantics description.
 *
 * Edge case behavior:
 * - Returns a stable payload even when the queue summary is unavailable.
 */
export function buildWorkerQueueSemantics(): WorkerQueueSemantics {
  return {
    failedCountMode: 'retained_terminal_jobs',
    failedCountDescription:
      'The failed counter represents job rows currently retained in terminal failed state. It is not a count of currently running failures.',
    activeFailureSignals: ['running', 'stalledRunning', 'health.alerts']
  };
}

/**
 * Build the effective retry policy summary for queue-backed workers.
 *
 * Purpose:
 * - Publish the retry and stale-lease settings that govern automatic recovery and backoff.
 *
 * Inputs/outputs:
 * - Input: optional autonomy settings override.
 * - Output: retry policy summary.
 *
 * Edge case behavior:
 * - Uses normalized defaults when no explicit settings are supplied.
 */
export function buildWorkerRetryPolicySummary(): WorkerRetryPolicySummary {
  const settings = getWorkerAutonomySettings();

  return {
    defaultMaxRetries: settings.defaultMaxRetries,
    retryBackoffBaseMs: settings.retryBackoffBaseMs,
    retryBackoffMaxMs: settings.retryBackoffMaxMs,
    staleAfterMs: settings.staleAfterMs,
    watchdogIdleMs: settings.watchdogIdleMs
  };
}

function readWorkerSnapshotObject(
  workerSnapshot: WorkerRuntimeSnapshotRecord
): Record<string, unknown> {
  return workerSnapshot.snapshot && typeof workerSnapshot.snapshot === 'object' && !Array.isArray(workerSnapshot.snapshot)
    ? workerSnapshot.snapshot
    : {};
}

function readSnapshotString(
  snapshot: Record<string, unknown>,
  key: string
): string | null {
  const value = snapshot[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readSnapshotNumber(
  snapshot: Record<string, unknown>,
  key: string
): number {
  const value = snapshot[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readIsoTimestampToMs(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readWatchdogView(
  workerSnapshot: WorkerRuntimeSnapshotRecord,
  idleThresholdMs: number
): WorkerControlWorkerSnapshot['watchdog'] {
  const snapshot = readWorkerSnapshotObject(workerSnapshot);
  const rawWatchdog = snapshot.watchdog;
  if (!rawWatchdog || typeof rawWatchdog !== 'object' || Array.isArray(rawWatchdog)) {
    const lastActivityAt = readSnapshotString(snapshot, 'lastActivityAt');
    const lastProcessedJobAt = readSnapshotString(snapshot, 'lastProcessedJobAt');
    const inactivitySourceAt =
      readIsoTimestampToMs(lastActivityAt) ??
      readIsoTimestampToMs(lastProcessedJobAt) ??
      readIsoTimestampToMs(workerSnapshot.lastHeartbeatAt) ??
      readIsoTimestampToMs(workerSnapshot.updatedAt);
    const inactivityMs =
      inactivitySourceAt === null ? null : Math.max(0, Date.now() - inactivitySourceAt);
    const restartRecommended =
      workerSnapshot.currentJobId === null &&
      inactivityMs !== null &&
      inactivityMs >= idleThresholdMs;

    return {
      triggered: false,
      reason:
        restartRecommended
          ? `No worker receipts or processed jobs observed for ${inactivityMs}ms.`
          : null,
      restartRecommended,
      idleThresholdMs
    };
  }

  const watchdog = rawWatchdog as Record<string, unknown>;
  return {
    triggered: Boolean(watchdog.triggered),
    reason: typeof watchdog.reason === 'string' ? watchdog.reason : null,
    restartRecommended: Boolean(watchdog.restartRecommended),
    idleThresholdMs:
      typeof watchdog.idleThresholdMs === 'number'
        ? watchdog.idleThresholdMs
        : idleThresholdMs
  };
}

function buildWorkerControlWorkerSnapshot(
  workerSnapshot: WorkerRuntimeSnapshotRecord,
  idleThresholdMs: number
): WorkerControlWorkerSnapshot {
  const snapshot = readWorkerSnapshotObject(workerSnapshot);
  const lastActivityAt = readSnapshotString(snapshot, 'lastActivityAt');
  const lastProcessedJobAt = readSnapshotString(snapshot, 'lastProcessedJobAt');
  const inactivityMs = lastActivityAt && Number.isFinite(Date.parse(lastActivityAt))
    ? Math.max(0, Date.now() - Date.parse(lastActivityAt))
    : null;

  return {
    workerId: workerSnapshot.workerId,
    workerType: workerSnapshot.workerType,
    healthStatus: workerSnapshot.healthStatus,
    currentJobId: workerSnapshot.currentJobId,
    lastError: workerSnapshot.lastError,
    lastHeartbeatAt: workerSnapshot.lastHeartbeatAt,
    lastActivityAt,
    lastProcessedJobAt,
    inactivityMs,
    processedJobs: readSnapshotNumber(snapshot, 'processedJobs'),
    scheduledRetries: readSnapshotNumber(snapshot, 'scheduledRetries'),
    terminalFailures: readSnapshotNumber(snapshot, 'terminalFailures'),
    recoveredJobs: readSnapshotNumber(snapshot, 'recoveredJobs'),
    updatedAt: workerSnapshot.updatedAt,
    watchdog: readWatchdogView(workerSnapshot, idleThresholdMs)
  };
}

function deriveWorkerControlAlerts(
  fallbackAlerts: string[],
  workers: WorkerControlWorkerSnapshot[]
): string[] {
  const alerts = new Set<string>(fallbackAlerts);

  for (const worker of workers) {
    if (worker.watchdog.restartRecommended) {
      alerts.add(
        worker.watchdog.reason ??
          `Worker ${worker.workerId} has been idle beyond the watchdog threshold.`
      );
    }
  }

  return [...alerts];
}

function deriveWorkerControlOverallStatus(
  fallbackStatus: WorkerAutonomyHealthReport['overallStatus'],
  workers: WorkerControlWorkerSnapshot[],
  alerts: string[]
): WorkerAutonomyHealthReport['overallStatus'] {
  if (fallbackStatus === 'offline' && workers.length === 0) {
    return 'offline';
  }

  if (fallbackStatus === 'unhealthy' || workers.some((worker) => worker.healthStatus === 'unhealthy')) {
    return 'unhealthy';
  }

  if (
    fallbackStatus === 'degraded' ||
    alerts.length > 0 ||
    workers.some((worker) => worker.healthStatus === 'degraded' || worker.watchdog.restartRecommended)
  ) {
    return 'degraded';
  }

  return workers.length === 0 ? fallbackStatus : 'healthy';
}

/**
 * Resolve the worker identifier used for helper-originated jobs and status reports.
 *
 * Purpose:
 * - Keep helper-origin worker attribution consistent across routes and tooling.
 *
 * Inputs/outputs:
 * - Input: optional explicit worker identifier override.
 * - Output: effective worker identifier string.
 *
 * Edge case behavior:
 * - Falls back to `process.env.WORKER_ID` or `worker-helper` when no override is provided.
 */
export function getWorkerControlOriginWorkerId(workerId?: string): string {
  return workerId || process.env.WORKER_ID || 'worker-helper';
}

/**
 * Resolve the cognitive domain for worker tasks.
 *
 * Purpose:
 * - Preserve explicit operator intent while still supporting heuristic routing defaults.
 *
 * Inputs/outputs:
 * - Input: prompt string and optional caller-provided domain.
 * - Output: normalized domain plus whether it was provided or detected.
 *
 * Edge case behavior:
 * - Heuristic detection is used when the caller omits a domain.
 */
export function resolveWorkerControlDomain(
  prompt: string,
  providedDomain?: CognitiveDomain
): ResolvedWorkerDomain {
  const parsedDomain = providedDomain ? workerControlDomainSchema.parse(providedDomain) : undefined;

  //audit Assumption: operator-supplied cognitive domains should override heuristic classification; failure risk: deliberate routing hints are discarded; expected invariant: explicit domain wins, otherwise heuristic detection supplies a deterministic fallback; handling strategy: branch on caller-provided domain first.
  if (parsedDomain) {
    return {
      cognitiveDomain: parsedDomain,
      source: 'provided'
    };
  }

  return {
    cognitiveDomain: detectCognitiveDomain(prompt).domain,
    source: 'detected'
  };
}

/**
 * Build the combined worker-control status payload.
 *
 * Purpose:
 * - Provide one status view for the main app runtime and the dedicated queue-backed worker.
 *
 * Inputs/outputs:
 * - Input: optional worker identifier override for attribution.
 * - Output: `WorkerControlStatusResponse`.
 *
 * Edge case behavior:
 * - Queue summary and latest job degrade to `null` when the database is unavailable.
 */
export async function getWorkerControlStatus(
  workerId?: string
): Promise<WorkerControlStatusResponse> {
  const [latestJob, autonomyHealth, recentFailedJobs] = await Promise.all([
    getLatestJob(),
    getWorkerAutonomyHealthReport(),
    listRecentFailedWorkerJobs()
  ]);

  const workerSnapshots = autonomyHealth.workers.map((workerSnapshot) =>
    buildWorkerControlWorkerSnapshot(
      workerSnapshot,
      autonomyHealth.settings.watchdogIdleMs
    )
  );
  const alerts = deriveWorkerControlAlerts(autonomyHealth.alerts, workerSnapshots);
  const overallStatus = deriveWorkerControlOverallStatus(
    autonomyHealth.overallStatus,
    workerSnapshots,
    alerts
  );

  return {
    timestamp: new Date().toISOString(),
    mainApp: {
      connected: true,
      workerId: getWorkerControlOriginWorkerId(workerId),
      runtime: getWorkerRuntimeStatus()
    },
    workerService: {
      observationMode: 'queue-observed',
      database: getDatabaseStatus(),
      queueSummary: await getJobQueueSummary(),
      queueSemantics: buildWorkerQueueSemantics(),
      retryPolicy: buildWorkerRetryPolicySummary(),
      recentFailedJobs,
      latestJob: latestJob ? buildWorkerJobSnapshot(latestJob) : null,
      health: {
        overallStatus,
        alerts,
        workers: workerSnapshots
      }
    }
  };
}

/**
 * Get the latest queued worker job with output.
 *
 * Purpose:
 * - Support operator inspection of the most recent async worker execution.
 *
 * Inputs/outputs:
 * - Input: none.
 * - Output: latest job detail snapshot or `null`.
 *
 * Edge case behavior:
 * - Returns `null` when the queue has no history or the database is unavailable.
 */
export async function getLatestWorkerJobDetail(): Promise<WorkerJobDetailSnapshot | null> {
  const latestJob = await getLatestJob();
  return latestJob ? buildWorkerJobDetailSnapshot(latestJob) : null;
}

/**
 * Get one queued worker job by identifier.
 *
 * Purpose:
 * - Support polling and AI inspection of a specific async worker job.
 *
 * Inputs/outputs:
 * - Input: job identifier string.
 * - Output: job detail snapshot or `null`.
 *
 * Edge case behavior:
 * - Returns `null` when the identifier does not exist.
 */
export async function getWorkerJobDetailById(jobId: string): Promise<WorkerJobDetailSnapshot | null> {
  const job = await getJobById(jobId);
  return job ? buildWorkerJobDetailSnapshot(job) : null;
}

/**
 * List recently retained failed jobs for operator inspection.
 *
 * Purpose:
 * - Provide a stable inspection view over terminal failed queue rows.
 *
 * Inputs/outputs:
 * - Input: optional result limit.
 * - Output: most recently updated failed-job snapshots.
 *
 * Edge case behavior:
 * - Falls back to five rows when the caller omits the limit.
 */
export async function listRecentFailedWorkerJobs(
  limit = 5
): Promise<FailedWorkerJobSnapshot[]> {
  const failedJobs = await listFailedJobs(limit);
  return failedJobs.map(buildFailedWorkerJobSnapshot);
}

/**
 * Queue async dedicated-worker `/ask` work.
 *
 * Purpose:
 * - Route AI work to the dedicated DB-backed worker with stable queue metadata.
 *
 * Inputs/outputs:
 * - Input: queue request with prompt and optional routing/session metadata.
 * - Output: pollable async queue response with resolved domain metadata.
 *
 * Edge case behavior:
 * - When no domain is supplied, heuristic detection determines the queued routing hint.
 */
export async function queueWorkerAsk(
  request: QueueWorkerAskRequest
): Promise<QueueWorkerAskResponse> {
  const resolvedDomain = resolveWorkerControlDomain(request.prompt, request.cognitiveDomain);
  const queuedAskJobInput = buildQueuedAskJobInput({
    prompt: request.prompt,
    sessionId: request.sessionId,
    overrideAuditSafe: request.overrideAuditSafe,
    cognitiveDomain: resolvedDomain.cognitiveDomain,
    clientContext: request.clientContext ?? null,
    endpointName: request.endpointName || 'worker-helper',
    previewChaosHook: request.previewChaosHook
  });
  const plannedJob = await planAutonomousWorkerJob('ask', queuedAskJobInput);

  const createdJob = await createJob(
    getWorkerControlOriginWorkerId(request.workerId),
    'ask',
    queuedAskJobInput,
    plannedJob
  );

  return {
    ...buildQueuedAskPendingResponse(createdJob.id),
    endpoint: queuedAskJobInput.endpointName,
    cognitiveDomain: resolvedDomain.cognitiveDomain,
    cognitiveDomainSource: resolvedDomain.source
  };
}

/**
 * Get the persisted health report for autonomous queue workers.
 *
 * Purpose:
 * - Provide helper routes and AI tools with one stable worker health payload.
 *
 * Inputs/outputs:
 * - Input: none.
 * - Output: autonomy-focused health report.
 *
 * Edge case behavior:
 * - Returns `offline` overall status when no worker snapshot has been persisted yet.
 */
export async function getWorkerControlHealth(): Promise<WorkerControlHealthResponse> {
  const [healthReport, recentFailedJobs] = await Promise.all([
    getWorkerAutonomyHealthReport(),
    listRecentFailedWorkerJobs()
  ]);
  const workers = healthReport.workers.map((workerSnapshot) =>
    buildWorkerControlWorkerSnapshot(
      workerSnapshot,
      healthReport.settings.watchdogIdleMs
    )
  );
  const alerts = deriveWorkerControlAlerts(healthReport.alerts, workers);
  const overallStatus = deriveWorkerControlOverallStatus(
    healthReport.overallStatus,
    workers,
    alerts
  );

  return {
    ...healthReport,
    overallStatus,
    alerts,
    workers,
    queueSemantics: buildWorkerQueueSemantics(),
    retryPolicy: buildWorkerRetryPolicySummary(),
    recentFailedJobs
  };
}

/**
 * Dispatch work directly through the in-process worker runtime.
 *
 * Purpose:
 * - Execute worker logic immediately inside the main app without queueing a DB-backed job.
 *
 * Inputs/outputs:
 * - Input: direct dispatch request including worker input and optional retry/routing metadata.
 * - Output: summarized dispatch response with all worker results.
 *
 * Edge case behavior:
 * - `primaryResult` becomes `null` if the runtime returns no worker outputs.
 */
export async function dispatchWorkerInput(
  request: DispatchWorkerInputRequest
): Promise<DispatchWorkerInputResponse> {
  const dispatchResults = await dispatchArcanosTask(request.input, request);
  const primaryResult: WorkerResult | null = dispatchResults[0] ?? null;

  return {
    timestamp: new Date().toISOString(),
    mode: 'direct-dispatch',
    input: request.input,
    resultCount: dispatchResults.length,
    primaryResult,
    results: dispatchResults
  };
}

/**
 * Heal or restart the in-process worker runtime.
 *
 * Purpose:
 * - Give operator tooling a shared entrypoint for worker bootstrap and forced restarts.
 *
 * Inputs/outputs:
 * - Input: optional force flag.
 * - Output: restart summary and current runtime snapshot.
 *
 * Edge case behavior:
 * - Defaults to `force: true` when omitted.
 */
export async function healWorkerRuntime(
  force?: boolean,
  source = 'worker_control_service'
): Promise<HealWorkerRuntimeResponse> {
  const forceRestart = force ?? true;

  //audit Assumption: helper-driven heal commands are deliberate operator actions; failure risk: no-op restart when callers omit the force flag; expected invariant: heal defaults to a real restart; handling strategy: coerce undefined to `true`.
  recordSelfHealEvent({
    kind: 'attempt',
    source,
    trigger: 'manual',
    reason: forceRestart ? 'worker runtime restart requested' : 'worker runtime bootstrap requested',
    actionTaken: 'healWorkerRuntime',
    healedComponent: 'worker_runtime',
    details: {
      requestedForce: forceRestart
    }
  });

  try {
    const restartSummary = await startWorkers(forceRestart);
    const response = {
      timestamp: new Date().toISOString(),
      requestedForce: forceRestart,
      restart: restartSummary,
      runtime: getWorkerRuntimeStatus()
    };

    if (!restartSummary.runWorkers && !restartSummary.started) {
      recordSelfHealEvent({
        kind: 'noop',
        source,
        trigger: 'manual',
        reason: restartSummary.message ?? 'worker runtime heal blocked because workers are disabled',
        actionTaken: 'healWorkerRuntime:blocked',
        healedComponent: 'worker_runtime',
        details: {
          requestedForce: forceRestart,
          restart: restartSummary
        }
      });
      return response;
    }

    recordSelfHealEvent({
      kind: 'success',
      source,
      trigger: 'manual',
      reason: restartSummary.message ?? 'worker runtime restart completed',
      actionTaken: `healWorkerRuntime:${restartSummary.started ? 'started' : 'pending'}`,
      healedComponent: 'worker_runtime',
      details: {
        requestedForce: forceRestart,
        restart: restartSummary
      }
    });

    return response;
  } catch (error) {
    recordSelfHealEvent({
      kind: 'failure',
      source,
      trigger: 'manual',
      reason: resolveErrorMessage(error),
      actionTaken: 'healWorkerRuntime',
      healedComponent: 'worker_runtime',
      details: {
        requestedForce: forceRestart
      }
    });
    throw error;
  }
}
