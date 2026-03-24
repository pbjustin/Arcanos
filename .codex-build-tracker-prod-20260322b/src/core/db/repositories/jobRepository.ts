/**
 * Job Repository for ARCANOS
 *
 * Handles queue persistence, retry scheduling, and lease-based worker claims.
 */

import { getPool, isDatabaseConnected } from '@core/db/client.js';
import type { JobData } from '@core/db/schema.js';
import { query } from '@core/db/query.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { safeJSONStringify } from '@shared/jsonHelpers.js';

export interface JobQueueSummary {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  total: number;
  delayed: number;
  stalledRunning: number;
  oldestPendingJobAgeMs: number;
  lastUpdatedAt?: string;
}

export interface CreateJobOptions {
  status?: string;
  retryCount?: number;
  maxRetries?: number;
  nextRunAt?: Date | string;
  startedAt?: Date | string | null;
  lastHeartbeatAt?: Date | string | null;
  leaseExpiresAt?: Date | string | null;
  priority?: number;
  lastWorkerId?: string | null;
  autonomyState?: Record<string, unknown>;
}

export interface ClaimNextPendingJobOptions {
  workerId?: string;
  leaseMs?: number;
}

export interface ScheduleJobRetryOptions {
  workerId?: string;
  delayMs: number;
  errorMessage: string;
  autonomyState?: Record<string, unknown>;
}

export interface RecoverStaleJobsOptions {
  staleAfterMs: number;
  maxRetries?: number;
}

export interface RecoverStaleJobsResult {
  recoveredJobs: string[];
  failedJobs: string[];
}

export interface JobExecutionStats {
  completed: number;
  failed: number;
  running: number;
  totalTerminal: number;
  aiCalls: number;
}

export interface FailedJobSnapshot {
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

function assertDatabaseReady(): void {
  if (!isDatabaseConnected()) {
    throw new Error('Database not configured');
  }
}

function normalizeCreateJobOptions(statusOrOptions: string | CreateJobOptions = 'pending'): CreateJobOptions {
  return typeof statusOrOptions === 'string'
    ? { status: statusOrOptions }
    : statusOrOptions;
}

function normalizeJsonbInput(value: unknown, context: string): string {
  const serialized = safeJSONStringify(value, context);

  //audit Assumption: job repository writes must remain JSON-serializable for JSONB columns; failure risk: partial queue writes or invalid JSONB values; expected invariant: inputs serialize before insert/update; handling strategy: throw explicit serialization errors.
  if (!serialized) {
    throw new Error(`Failed to serialize JSON payload for ${context}`);
  }

  return serialized;
}

function normalizeAutonomyState(state?: Record<string, unknown>): Record<string, unknown> {
  return state ?? {};
}

/**
 * Create a new queue job.
 * Purpose: persist queue work with scheduling, retry, and autonomy metadata in one write.
 * Inputs/outputs: accepts worker/job identity, raw input, and optional scheduling metadata; returns the created job row.
 * Edge case behavior: string legacy `status` input remains supported for existing call sites.
 */
export async function createJob(
  workerId: string,
  jobType: string,
  input: unknown,
  statusOrOptions: string | CreateJobOptions = 'pending'
): Promise<JobData> {
  assertDatabaseReady();

  const options = normalizeCreateJobOptions(statusOrOptions);
  const result = await query(
    `INSERT INTO job_data (
       worker_id,
       job_type,
       status,
       input,
       retry_count,
       max_retries,
       next_run_at,
       started_at,
       last_heartbeat_at,
       lease_expires_at,
       priority,
       last_worker_id,
       autonomy_state
     )
     VALUES (
       $1,
       $2,
       $3,
       $4::jsonb,
       $5,
       $6,
       COALESCE($7::timestamptz, NOW()),
       $8::timestamptz,
       $9::timestamptz,
       $10::timestamptz,
       $11,
       $12,
       $13::jsonb
     )
     RETURNING *`,
    [
      workerId,
      jobType,
      options.status ?? 'pending',
      normalizeJsonbInput(input, 'jobRepository.createJob.input'),
      options.retryCount ?? 0,
      options.maxRetries ?? 2,
      normalizeNullableDate(options.nextRunAt),
      normalizeNullableDate(options.startedAt),
      normalizeNullableDate(options.lastHeartbeatAt),
      normalizeNullableDate(options.leaseExpiresAt),
      options.priority ?? 100,
      options.lastWorkerId ?? null,
      normalizeJsonbInput(
        normalizeAutonomyState(options.autonomyState),
        'jobRepository.createJob.autonomyState'
      )
    ]
  );

  return result.rows[0] as JobData;
}

/**
 * Update job status and terminal output.
 * Purpose: persist job completion or failure while clearing lease metadata for non-running states.
 * Inputs/outputs: accepts job id, status, output payload, and optional error string; returns the updated job row.
 * Edge case behavior: running jobs retain their lease fields while terminal states clear them and stamp completion time.
 */
export async function updateJob(
  jobId: string,
  status: string,
  output: unknown = null,
  errorMessage: string | null = null
): Promise<JobData> {
  assertDatabaseReady();

  const terminalStatus = status === 'completed' || status === 'failed' || status === 'cancelled';
  const runningStatus = status === 'running';
  const result = await query(
    `UPDATE job_data
     SET
       status = $1,
       output = $2::jsonb,
       error_message = $3,
       updated_at = NOW(),
       completed_at = CASE
         WHEN $4 THEN COALESCE(completed_at, NOW())
         ELSE completed_at
       END,
       started_at = CASE
         WHEN $5 THEN COALESCE(started_at, NOW())
         ELSE started_at
       END,
       last_heartbeat_at = CASE
         WHEN $5 THEN COALESCE(last_heartbeat_at, NOW())
         ELSE NULL
       END,
       lease_expires_at = CASE
         WHEN $5 THEN lease_expires_at
         ELSE NULL
       END
     WHERE id = $6
     RETURNING *`,
    [
      status,
      normalizeJsonbInput(output, 'jobRepository.updateJob.output'),
      errorMessage,
      terminalStatus,
      runningStatus,
      jobId
    ]
  );

  return result.rows[0] as JobData;
}

/**
 * Get one job by identifier.
 * Purpose: support queue polling and operator inspection of DB-backed jobs.
 * Inputs/outputs: accepts a job id and returns the matching job row or `null`.
 * Edge case behavior: returns `null` when the database is unavailable or the row does not exist.
 */
export async function getJobById(jobId: string): Promise<JobData | null> {
  if (!isDatabaseConnected()) {
    return null;
  }

  const result = await query('SELECT * FROM job_data WHERE id = $1 LIMIT 1', [jobId]);
  return (result.rows[0] as JobData | undefined) ?? null;
}

/**
 * Atomically claim the next runnable pending job using SKIP LOCKED.
 * Purpose: lease due queue work to one worker while respecting scheduling and priority.
 * Inputs/outputs: optional worker id and lease duration; returns the claimed job or `null`.
 * Edge case behavior: ignores pending jobs scheduled for the future and returns `null` when none are due.
 */
export async function claimNextPendingJob(
  options: ClaimNextPendingJobOptions = {}
): Promise<JobData | null> {
  assertDatabaseReady();

  const pool = getPool();
  if (!pool) {
    throw new Error('Database pool unavailable');
  }

  const leaseMs = Math.max(1_000, options.leaseMs ?? 30_000);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `UPDATE job_data
       SET
         status = 'running',
         updated_at = NOW(),
         started_at = COALESCE(started_at, NOW()),
         last_heartbeat_at = NOW(),
         lease_expires_at = NOW() + ($1::bigint * INTERVAL '1 millisecond'),
         last_worker_id = COALESCE($2, last_worker_id)
       WHERE id = (
         SELECT id
         FROM job_data
         WHERE status = 'pending'
           AND next_run_at <= NOW()
         ORDER BY priority ASC, next_run_at ASC, created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING *`,
      [leaseMs, options.workerId ?? null]
    );

    await client.query('COMMIT');
    return (result.rows[0] as JobData | undefined) ?? null;
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    console.error('Error claiming pending job:', resolveErrorMessage(error));
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Extend the lease and heartbeat for one running job.
 * Purpose: prevent active work from being mistaken for a stalled job by the inspector.
 * Inputs/outputs: accepts a job id plus optional worker id and lease duration; returns the updated job or `null`.
 * Edge case behavior: returns `null` when the job is no longer running.
 */
export async function recordJobHeartbeat(
  jobId: string,
  options: ClaimNextPendingJobOptions = {}
): Promise<JobData | null> {
  assertDatabaseReady();

  const leaseMs = Math.max(1_000, options.leaseMs ?? 30_000);
  const result = await query(
    `UPDATE job_data
     SET
       updated_at = NOW(),
       last_heartbeat_at = NOW(),
       lease_expires_at = NOW() + ($1::bigint * INTERVAL '1 millisecond'),
       last_worker_id = COALESCE($2, last_worker_id)
     WHERE id = $3
       AND status = 'running'
     RETURNING *`,
    [leaseMs, options.workerId ?? null, jobId]
  );

  return (result.rows[0] as JobData | undefined) ?? null;
}

/**
 * Reschedule a failed job for retry.
 * Purpose: implement exponential backoff without dropping queue state or losing prior attempts.
 * Inputs/outputs: accepts a job id, retry delay, and failure context; returns the rescheduled job.
 * Edge case behavior: preserves existing job input/output while clearing running lease metadata.
 */
export async function scheduleJobRetry(
  jobId: string,
  options: ScheduleJobRetryOptions
): Promise<JobData> {
  assertDatabaseReady();

  const result = await query(
    `UPDATE job_data
     SET
       status = 'pending',
       error_message = $1,
       retry_count = retry_count + 1,
       next_run_at = NOW() + ($2::bigint * INTERVAL '1 millisecond'),
       updated_at = NOW(),
       completed_at = NULL,
       last_heartbeat_at = NULL,
       lease_expires_at = NULL,
       last_worker_id = COALESCE($3, last_worker_id),
       autonomy_state = COALESCE($4::jsonb, autonomy_state)
     WHERE id = $5
     RETURNING *`,
    [
      options.errorMessage,
      Math.max(0, options.delayMs),
      options.workerId ?? null,
      normalizeJsonbInput(
        normalizeAutonomyState(options.autonomyState),
        'jobRepository.scheduleJobRetry.autonomyState'
      ),
      jobId
    ]
  );

  return result.rows[0] as JobData;
}

/**
 * Recover stale running jobs whose leases expired or heartbeats disappeared.
 * Purpose: self-heal queue state after worker crashes or hung executions.
 * Inputs/outputs: accepts stale timing and retry limits; returns recovered and terminally failed job ids.
 * Edge case behavior: jobs that already exceeded retry caps are marked failed instead of re-queued.
 */
export async function recoverStaleJobs(
  options: RecoverStaleJobsOptions
): Promise<RecoverStaleJobsResult> {
  assertDatabaseReady();

  const pool = getPool();
  if (!pool) {
    throw new Error('Database pool unavailable');
  }

  const staleAfterMs = Math.max(1_000, options.staleAfterMs);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const staleResult = await client.query(
      `SELECT id, retry_count, max_retries, autonomy_state
       FROM job_data
       WHERE status = 'running'
         AND (
           (lease_expires_at IS NOT NULL AND lease_expires_at < NOW())
           OR (last_heartbeat_at IS NULL AND started_at < NOW() - ($1::bigint * INTERVAL '1 millisecond'))
           OR (last_heartbeat_at IS NOT NULL AND last_heartbeat_at < NOW() - ($1::bigint * INTERVAL '1 millisecond'))
         )
       FOR UPDATE`,
      [staleAfterMs]
    );

    const recoveredJobs: string[] = [];
    const failedJobs: string[] = [];

    for (const row of staleResult.rows as Array<{
      id: string;
      retry_count: number;
      max_retries: number;
      autonomy_state: Record<string, unknown> | string | null;
    }>) {
      const retryCount = Number(row.retry_count ?? 0);
      const maxRetries = Number(options.maxRetries ?? row.max_retries ?? 2);
      const normalizedAutonomyState = buildRecoveredAutonomyState(row.autonomy_state, retryCount);

      //audit Assumption: stale running jobs should be retried only while within retry budget; failure risk: infinite stale-recovery loops; expected invariant: exhausted jobs become terminal failures; handling strategy: branch on retry budget before resetting state.
      if (retryCount >= maxRetries) {
        await client.query(
          `UPDATE job_data
           SET
             status = 'failed',
             error_message = 'Job lease expired and retry budget was exhausted during recovery.',
             updated_at = NOW(),
             completed_at = NOW(),
             last_heartbeat_at = NULL,
             lease_expires_at = NULL,
             autonomy_state = $1::jsonb
           WHERE id = $2`,
          [
            normalizeJsonbInput(
              normalizedAutonomyState,
              'jobRepository.recoverStaleJobs.failedAutonomyState'
            ),
            row.id
          ]
        );
        failedJobs.push(row.id);
        continue;
      }

      await client.query(
        `UPDATE job_data
         SET
           status = 'pending',
           error_message = 'Job recovered after stale worker lease.',
           retry_count = retry_count + 1,
           next_run_at = NOW(),
           updated_at = NOW(),
           last_heartbeat_at = NULL,
           lease_expires_at = NULL,
           autonomy_state = $1::jsonb
         WHERE id = $2`,
        [
          normalizeJsonbInput(
            normalizedAutonomyState,
            'jobRepository.recoverStaleJobs.recoveredAutonomyState'
          ),
          row.id
        ]
      );
      recoveredJobs.push(row.id);
    }

    await client.query('COMMIT');
    return { recoveredJobs, failedJobs };
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    console.error('Error recovering stale jobs:', resolveErrorMessage(error));
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get the latest queue job.
 * Purpose: support operator tooling that needs one recent queue sample.
 * Inputs/outputs: no inputs, returns the most recently created job or `null`.
 * Edge case behavior: returns `null` when the database is unavailable or no jobs exist.
 */
export async function getLatestJob(): Promise<JobData | null> {
  if (!isDatabaseConnected()) {
    return null;
  }

  try {
    const result = await query('SELECT * FROM job_data ORDER BY created_at DESC LIMIT 1', []);
    return (result.rows[0] as JobData | undefined) ?? null;
  } catch (error: unknown) {
    //audit Assumption: latest job lookup failure should degrade observability rather than crash helper routes; failure risk: status endpoints fail on transient query issues; expected invariant: lookup errors are logged and return `null`; handling strategy: fail closed.
    console.error('Error fetching latest job:', resolveErrorMessage(error));
    return null;
  }
}

/**
 * Get aggregate counts for the async worker queue.
 * Purpose: expose one stable queue summary for helper routes, health checks, and planning logic.
 * Inputs/outputs: no inputs, returns normalized queue counters plus freshness metadata.
 * Edge case behavior: returns `null` when the database is unavailable or the summary query fails.
 */
export async function getJobQueueSummary(): Promise<JobQueueSummary | null> {
  //audit Assumption: queue summaries are only trustworthy when the database connection is active; failure risk: helper surfaces fabricated worker state; expected invariant: disconnected DB returns no summary; handling strategy: fail closed with `null`.
  if (!isDatabaseConnected()) {
    return null;
  }

  try {
    const result = await query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
         COUNT(*) FILTER (WHERE status = 'running')::int AS running_count,
         COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_count,
         COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
         COUNT(*)::int AS total_count,
         COUNT(*) FILTER (WHERE status = 'pending' AND next_run_at > NOW())::int AS delayed_count,
         COUNT(*) FILTER (
           WHERE status = 'running'
             AND (
               (lease_expires_at IS NOT NULL AND lease_expires_at < NOW())
               OR (last_heartbeat_at IS NOT NULL AND last_heartbeat_at < NOW() - INTERVAL '60 seconds')
             )
         )::int AS stalled_running_count,
         COALESCE(
           MAX(
             CASE
               WHEN status = 'pending' AND next_run_at <= NOW()
               THEN EXTRACT(EPOCH FROM (NOW() - created_at)) * 1000
               ELSE 0
             END
           ),
           0
         )::bigint AS oldest_pending_age_ms,
         MAX(updated_at) AS last_updated_at
       FROM job_data`,
      []
    );

    const summaryRow = result.rows[0] as {
      pending_count: number;
      running_count: number;
      completed_count: number;
      failed_count: number;
      total_count: number;
      delayed_count: number;
      stalled_running_count: number;
      oldest_pending_age_ms: number;
      last_updated_at?: string | Date | null;
    } | undefined;

    if (!summaryRow) {
      return {
        pending: 0,
        running: 0,
        completed: 0,
        failed: 0,
        total: 0,
        delayed: 0,
        stalledRunning: 0,
        oldestPendingJobAgeMs: 0
      };
    }

    const summary: JobQueueSummary = {
      pending: summaryRow.pending_count,
      running: summaryRow.running_count,
      completed: summaryRow.completed_count,
      failed: summaryRow.failed_count,
      total: summaryRow.total_count,
      delayed: summaryRow.delayed_count,
      stalledRunning: summaryRow.stalled_running_count,
      oldestPendingJobAgeMs: Number(summaryRow.oldest_pending_age_ms ?? 0)
    };

    if (summaryRow.last_updated_at) {
      summary.lastUpdatedAt = new Date(summaryRow.last_updated_at).toISOString();
    }

    return summary;
  } catch (error: unknown) {
    //audit Assumption: queue summary failures should degrade observability, not crash request handling; failure risk: operator status endpoints return 500 on transient query issues; expected invariant: errors are logged and summary becomes unavailable; handling strategy: return `null`.
    console.error('Error fetching job queue summary:', resolveErrorMessage(error));
    return null;
  }
}

/**
 * Aggregate recent queue execution stats for autonomy budgets.
 * Purpose: let the worker decide whether to pause new claims when throughput or AI-call budgets are exhausted.
 * Inputs/outputs: accepts a lower-bound timestamp and optional worker id; returns normalized execution counters.
 * Edge case behavior: returns zeroed counters when the database is unavailable.
 */
export async function getJobExecutionStatsSince(
  since: Date | string,
  workerId?: string
): Promise<JobExecutionStats> {
  if (!isDatabaseConnected()) {
    return {
      completed: 0,
      failed: 0,
      running: 0,
      totalTerminal: 0,
      aiCalls: 0
    };
  }

  const result = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_count,
       COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
       COUNT(*) FILTER (WHERE status = 'running')::int AS running_count,
       COUNT(*) FILTER (WHERE status IN ('completed', 'failed'))::int AS total_terminal_count,
       COUNT(*) FILTER (
         WHERE status IN ('completed', 'failed')
           AND job_type IN ('ask', 'dag-node')
       )::int AS ai_call_count
     FROM job_data
     WHERE updated_at >= $1::timestamptz
       AND ($2::text IS NULL OR last_worker_id = $2 OR worker_id = $2)`,
    [normalizeNullableDate(since), workerId ?? null]
  );

  const row = result.rows[0] as {
    completed_count: number;
    failed_count: number;
    running_count: number;
    total_terminal_count: number;
    ai_call_count: number;
  } | undefined;

  return {
    completed: row?.completed_count ?? 0,
    failed: row?.failed_count ?? 0,
    running: row?.running_count ?? 0,
    totalTerminal: row?.total_terminal_count ?? 0,
    aiCalls: row?.ai_call_count ?? 0
  };
}

function normalizeNullableDate(value: Date | string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return value;
}

function buildRecoveredAutonomyState(
  autonomyState: Record<string, unknown> | string | null,
  retryCount: number
): Record<string, unknown> {
  let baseState: Record<string, unknown> = {};

  if (typeof autonomyState === 'object' && autonomyState !== null && !Array.isArray(autonomyState)) {
    baseState = autonomyState;
  }

  return {
    ...baseState,
    recoveredFromStaleLeaseAt: new Date().toISOString(),
    staleRecoveryCount: Number(baseState.staleRecoveryCount ?? 0) + 1,
    previousRetryCount: retryCount
  };
}

function normalizeInspectionLimit(limit: number | undefined, fallback: number): number {
  const normalizedLimit = Number(limit ?? fallback);

  //audit Assumption: failed-job inspection should remain cheap enough for status routes; failure risk: unbounded operator queries pressure the primary queue table; expected invariant: inspection limits stay within a small capped range; handling strategy: clamp to 1-100 before issuing SQL.
  if (!Number.isFinite(normalizedLimit)) {
    return fallback;
  }

  return Math.min(100, Math.max(1, Math.trunc(normalizedLimit)));
}

/**
 * List recently failed queue jobs for operator inspection.
 * Purpose: expose retained terminal failures without requiring raw database access.
 * Inputs/outputs: accepts an optional limit and returns the most recently updated failed rows.
 * Edge case behavior: returns an empty list when the database is unavailable or the query fails.
 */
export async function listFailedJobs(limit = 10): Promise<FailedJobSnapshot[]> {
  if (!isDatabaseConnected()) {
    return [];
  }

  try {
    const normalizedLimit = normalizeInspectionLimit(limit, 10);
    const result = await query(
      `SELECT
         id,
         worker_id,
         last_worker_id,
         job_type,
         status,
         error_message,
         retry_count,
         max_retries,
         created_at,
         updated_at,
         completed_at
       FROM job_data
       WHERE status = 'failed'
       ORDER BY updated_at DESC, created_at DESC
       LIMIT $1`,
      [normalizedLimit]
    );

    return result.rows as FailedJobSnapshot[];
  } catch (error: unknown) {
    //audit Assumption: failed-job inspection should degrade observability rather than break helper and health endpoints; failure risk: one query failure cascades into probe failures; expected invariant: inspection errors are logged and return an empty list; handling strategy: fail closed.
    console.error('Error listing failed jobs:', resolveErrorMessage(error));
    return [];
  }
}
