import {
  createJob,
  getJobById,
  updateJob
} from '../core/db/repositories/jobRepository.js';
import { planAutonomousWorkerJob } from '../services/workerAutonomyService.js';
import type { DAGNode, DAGResult } from '../dag/dagNode.js';
import {
  buildDagNodeJobInput,
  buildDagQueueJobRecord,
  type DagQueueJobRecord
} from './jobSchema.js';
import {
  createDagArtifactStore,
  persistDagDependencyArtifactsForQueue,
  type DagArtifactStore
} from '../dag/artifactStore.js';
import { sleep } from '@shared/sleep.js';
import {
  DEFAULT_DAG_NODE_TIMEOUT_MS,
  getWorkerExecutionLimits
} from '../workers/workerExecutionLimits.js';

export interface EnqueueDagNodeJobRequest {
  dagId: string;
  node: DAGNode;
  payload?: Record<string, unknown>;
  dependencyResults?: Record<string, DAGResult>;
  sharedState?: Record<string, unknown>;
  depth: number;
  attempt?: number;
  maxRetries?: number;
  waitingTimeoutMs?: number;
  workerId?: string;
}

export interface WaitForDagJobCompletionOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  onStatusChange?: (record: DagQueueJobRecord) => void;
}

export interface DagJobQueue {
  enqueueDagNodeJob(request: EnqueueDagNodeJobRequest): Promise<DagQueueJobRecord>;
  waitForDagJobCompletion(
    jobId: string,
    options?: WaitForDagJobCompletionOptions
  ): Promise<DagQueueJobRecord>;
}

function resolvePositiveTimeoutMs(value: number | undefined, fallbackValue: number): number {
  const normalizedValue = Number(value);

  //audit Assumption: queue timeouts must remain positive finite integers; failure risk: invalid overrides create immediate failures or endless waits; expected invariant: polling always uses a bounded positive timeout; handling strategy: sanitize each timeout and fall back when invalid.
  if (!Number.isFinite(normalizedValue) || normalizedValue <= 0) {
    return fallbackValue;
  }

  return Math.trunc(normalizedValue);
}

function getDagQueueElapsedMs(record: DagQueueJobRecord, nowMs: number): number {
  return Math.max(0, nowMs - Date.parse(record.timestamps.queuedAt));
}

function getDagExecutionElapsedMs(record: DagQueueJobRecord, nowMs: number): number {
  const startedAtIso = record.timestamps.startedAt ?? record.timestamps.updatedAt;
  return Math.max(0, nowMs - Date.parse(startedAtIso));
}

/**
 * DB-backed DAG queue adapter layered on the existing `job_data` infrastructure.
 *
 * Purpose:
 * - Reuse the live worker queue instead of introducing a parallel DAG-specific queue backend.
 *
 * Inputs/outputs:
 * - Input: DAG node jobs and polling options.
 * - Output: normalized DAG queue job records.
 *
 * Edge case behavior:
 * - Times out waiting jobs by marking them failed in the existing queue table.
 */
export class DatabaseBackedDagJobQueue implements DagJobQueue {
  private readonly defaultWorkerId: string;
  private readonly artifactStore: DagArtifactStore;

  constructor(
    defaultWorkerId: string = 'dag-orchestrator',
    artifactStore: DagArtifactStore = createDagArtifactStore()
  ) {
    this.defaultWorkerId = defaultWorkerId;
    this.artifactStore = artifactStore;
  }

  /**
   * Enqueue one DAG node on the shared DB-backed job queue.
   *
   * Purpose:
   * - Persist runnable nodes as `dag-node` jobs consumable by the existing worker service.
   *
   * Inputs/outputs:
   * - Input: queue request with node metadata, payload, and scheduling guards.
   * - Output: normalized queued job record.
   *
   * Edge case behavior:
   * - Uses the orchestrator worker identifier when the caller does not provide a specific worker id.
   */
  async enqueueDagNodeJob(request: EnqueueDagNodeJobRequest): Promise<DagQueueJobRecord> {
    const queueSafeDependencyResults = await persistDagDependencyArtifactsForQueue({
      artifactStore: this.artifactStore,
      runId: request.dagId,
      dependencyResults: request.dependencyResults ?? {}
    });
    const jobInput = buildDagNodeJobInput({
      dagId: request.dagId,
      node: request.node,
      payload: request.payload,
      dependencyResults: queueSafeDependencyResults,
      sharedState: request.sharedState,
      depth: request.depth,
      attempt: request.attempt,
      maxRetries: request.maxRetries,
      waitingTimeoutMs: request.waitingTimeoutMs
    });
    const plannedJob = await planAutonomousWorkerJob('dag-node', jobInput, {
      maxRetries: 0
    });
    const createdJob = await createJob(
      request.workerId || this.defaultWorkerId,
      'dag-node',
      jobInput,
      {
        ...plannedJob,
        maxRetries: 0
      }
    );

    return buildDagQueueJobRecord(createdJob);
  }

  /**
   * Poll the shared queue until one DAG node job completes or fails.
   *
   * Purpose:
   * - Give the orchestrator a simple blocking primitive over the existing async queue table.
   *
   * Inputs/outputs:
   * - Input: job identifier and optional polling/timeout overrides.
   * - Output: terminal DAG queue job record.
   *
   * Edge case behavior:
   * - Marks a still-running job as failed when the wait timeout is exceeded.
   */
  async waitForDagJobCompletion(
    jobId: string,
    options: WaitForDagJobCompletionOptions = {}
  ): Promise<DagQueueJobRecord> {
    const pollIntervalMs = options.pollIntervalMs ?? 250;
    const executionTimeoutMs = resolvePositiveTimeoutMs(
      options.timeoutMs,
      DEFAULT_DAG_NODE_TIMEOUT_MS
    );
    const queueClaimGraceMs = getWorkerExecutionLimits().dagQueueClaimGraceMs;
    let previousStatus: DagQueueJobRecord['status'] | undefined;

    //audit Assumption: polling is acceptable for the first DAG scaffold on top of `job_data`; failure risk: excessive DB churn; expected invariant: poll interval remains bounded and terminal states stop the loop; handling strategy: use short configurable polling with an explicit timeout.
    while (true) {
      const job = await getJobById(jobId);

      //audit Assumption: a job must still exist after enqueue succeeds; failure risk: orchestrator waits forever on a deleted row; expected invariant: queued DAG jobs remain addressable until terminal; handling strategy: fail closed if the row disappears.
      if (!job) {
        throw new Error(`DAG queue job "${jobId}" no longer exists.`);
      }

      const normalizedRecord = buildDagQueueJobRecord(job);

      //audit Assumption: queue polling should surface meaningful status transitions once per state change; failure risk: event consumers miss `running` or receive duplicate spam; expected invariant: callbacks fire only when the observed status changes; handling strategy: track the previous status locally before notifying.
      if (normalizedRecord.status !== previousStatus) {
        previousStatus = normalizedRecord.status;
        options.onStatusChange?.(normalizedRecord);
      }

      if (normalizedRecord.status === 'completed' || normalizedRecord.status === 'failed') {
        return normalizedRecord;
      }

      const nowMs = Date.now();
      const effectiveExecutionTimeoutMs = resolvePositiveTimeoutMs(
        normalizedRecord.waitingTimeoutMs,
        executionTimeoutMs
      );
      const queueElapsedMs = getDagQueueElapsedMs(normalizedRecord, nowMs);
      const executionElapsedMs = getDagExecutionElapsedMs(normalizedRecord, nowMs);

      //audit Assumption: queue backlog and active execution are distinct failure modes; failure risk: healthy nodes are marked failed before they even start when the queue is busy; expected invariant: pending/queued jobs get extra claim grace while running jobs are judged against active execution time; handling strategy: branch on queue state and emit a precise timeout error.
      if (
        normalizedRecord.status !== 'running' &&
        queueElapsedMs > effectiveExecutionTimeoutMs + queueClaimGraceMs
      ) {
        const timedOutJob = await updateJob(
          jobId,
          'failed',
          null,
          `Timed out waiting ${queueElapsedMs}ms for DAG node claim (execution limit ${effectiveExecutionTimeoutMs}ms, queue grace ${queueClaimGraceMs}ms).`
        );
        return buildDagQueueJobRecord(timedOutJob);
      }

      //audit Assumption: once a node is running, the execution limit should measure active runtime rather than queue age; failure risk: long-running AI stages outlive their guardrails indefinitely; expected invariant: running nodes become terminal once they exceed the configured execution timeout; handling strategy: fail closed with an execution-specific timeout message.
      if (
        normalizedRecord.status === 'running' &&
        executionElapsedMs > effectiveExecutionTimeoutMs
      ) {
        const timedOutJob = await updateJob(
          jobId,
          'failed',
          null,
          `Timed out after ${executionElapsedMs}ms of DAG node execution (limit ${effectiveExecutionTimeoutMs}ms).`
        );
        return buildDagQueueJobRecord(timedOutJob);
      }

      await sleep(pollIntervalMs);
    }
  }
}
