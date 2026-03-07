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
import { sleep } from '@shared/sleep.js';

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

  constructor(defaultWorkerId: string = 'dag-orchestrator') {
    this.defaultWorkerId = defaultWorkerId;
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
    const jobInput = buildDagNodeJobInput({
      dagId: request.dagId,
      node: request.node,
      payload: request.payload,
      dependencyResults: request.dependencyResults,
      sharedState: request.sharedState,
      depth: request.depth,
      attempt: request.attempt,
      maxRetries: request.maxRetries,
      waitingTimeoutMs: request.waitingTimeoutMs
    });
    const plannedJob = await planAutonomousWorkerJob('dag-node', jobInput, {
      maxRetries: request.maxRetries
    });
    const createdJob = await createJob(
      request.workerId || this.defaultWorkerId,
      'dag-node',
      jobInput,
      plannedJob
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
    const timeoutMs = options.timeoutMs ?? 60000;
    const startedAt = Date.now();
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

      //audit Assumption: long-running waits need an operator-visible timeout; failure risk: deadlocked DAG nodes hold orchestration slots forever; expected invariant: every queued node eventually becomes terminal; handling strategy: mark the job failed once the timeout is exceeded.
      if (Date.now() - startedAt > timeoutMs) {
        const timedOutJob = await updateJob(
          jobId,
          'failed',
          null,
          `Timed out waiting for DAG node job after ${timeoutMs}ms.`
        );
        return buildDagQueueJobRecord(timedOutJob);
      }

      await sleep(pollIntervalMs);
    }
  }
}
