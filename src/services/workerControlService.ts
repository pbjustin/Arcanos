import { z } from 'zod';
import { getStatus as getDatabaseStatus } from '@core/db/index.js';
import type { JobData } from '@core/db/schema.js';
import {
  createJob,
  getJobById,
  getJobQueueSummary,
  getLatestJob,
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
import type { ClientContextDTO } from '@shared/types/dto.js';
import { detectCognitiveDomain } from '@dispatcher/detectCognitiveDomain.js';
import type { CognitiveDomain } from '@shared/types/cognitiveDomain.js';
import {
  getWorkerAutonomyHealthReport,
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
    latestJob: WorkerJobSnapshot | null;
    health: {
      overallStatus: WorkerAutonomyHealthReport['overallStatus'];
      alerts: string[];
      workers: Array<Pick<
        WorkerRuntimeSnapshotRecord,
        'workerId' | 'workerType' | 'healthStatus' | 'currentJobId' | 'lastError' | 'lastHeartbeatAt' | 'updatedAt'
      >>;
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
export interface WorkerControlHealthResponse extends WorkerAutonomyHealthReport {}

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
  const [latestJob, autonomyHealth] = await Promise.all([
    getLatestJob(),
    getWorkerAutonomyHealthReport()
  ]);

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
      latestJob: latestJob ? buildWorkerJobSnapshot(latestJob) : null,
      health: {
        overallStatus: autonomyHealth.overallStatus,
        alerts: autonomyHealth.alerts,
        workers: autonomyHealth.workers.map(workerSnapshot => ({
          workerId: workerSnapshot.workerId,
          workerType: workerSnapshot.workerType,
          healthStatus: workerSnapshot.healthStatus,
          currentJobId: workerSnapshot.currentJobId,
          lastError: workerSnapshot.lastError,
          lastHeartbeatAt: workerSnapshot.lastHeartbeatAt,
          updatedAt: workerSnapshot.updatedAt
        }))
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
    endpointName: request.endpointName || 'worker-helper'
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
  return getWorkerAutonomyHealthReport();
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
export async function healWorkerRuntime(force?: boolean): Promise<HealWorkerRuntimeResponse> {
  const forceRestart = force ?? true;

  //audit Assumption: helper-driven heal commands are deliberate operator actions; failure risk: no-op restart when callers omit the force flag; expected invariant: heal defaults to a real restart; handling strategy: coerce undefined to `true`.
  const restartSummary = await startWorkers(forceRestart);

  return {
    timestamp: new Date().toISOString(),
    requestedForce: forceRestart,
    restart: restartSummary,
    runtime: getWorkerRuntimeStatus()
  };
}
