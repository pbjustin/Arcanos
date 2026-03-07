/**
 * Job Repository for ARCANOS
 * 
 * Handles job data storage and retrieval operations.
 */

import { getPool, isDatabaseConnected } from "@core/db/client.js";
import type { JobData } from "@core/db/schema.js";
import { query } from "@core/db/query.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";

/**
 * Aggregated queue counts for the DB-backed worker pipeline.
 *
 * Purpose:
 * - Provide a compact operational summary for pending/running/completed/failed jobs.
 *
 * Inputs/outputs:
 * - Input: none.
 * - Output: normalized queue counters and the latest queue update timestamp.
 *
 * Edge case behavior:
 * - `lastUpdatedAt` is omitted when the queue has never received a job.
 */
export interface JobQueueSummary {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  total: number;
  lastUpdatedAt?: string;
}

/**
 * Create a new job
 */
export async function createJob(
  workerId: string,
  jobType: string,
  input: unknown,
  status: string = 'pending'
): Promise<JobData> {
  if (!isDatabaseConnected()) {
    throw new Error('Database not configured');
  }

  const result = await query(
    'INSERT INTO job_data (worker_id, job_type, status, input) VALUES ($1, $2, $3, $4) RETURNING *',
    [workerId, jobType, status, JSON.stringify(input)]
  );

  return result.rows[0];
}

/**
 * Update job status and output
 */
export async function updateJob(
  jobId: string,
  status: string,
  output: unknown = null,
  errorMessage: string | null = null
): Promise<JobData> {
  if (!isDatabaseConnected()) {
    throw new Error('Database not configured');
  }

  const completedAt = status === 'completed';
  const result = await query(
    `UPDATE job_data
     SET status = $1, output = $2, error_message = $3, updated_at = NOW(), completed_at = ${completedAt ? 'NOW()' : 'completed_at'}
     WHERE id = $4 RETURNING *`,
    [status, JSON.stringify(output), errorMessage, jobId]
  );
  
  return result.rows[0];
}

/**
 * Get a job by id
 */
export async function getJobById(jobId: string): Promise<JobData | null> {
  if (!isDatabaseConnected()) {
    return null;
  }

  const result = await query(
    'SELECT * FROM job_data WHERE id = $1 LIMIT 1',
    [jobId]
  );

  return result.rows[0] || null;
}

/**
 * Atomically claim the next pending job using SKIP LOCKED.
 * Returns null when no jobs are pending.
 */
export async function claimNextPendingJob(): Promise<JobData | null> {
  if (!isDatabaseConnected()) {
    throw new Error('Database not configured');
  }

  const pool = getPool();
  if (!pool) {
    throw new Error('Database pool unavailable');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `UPDATE job_data
       SET status = 'running', updated_at = NOW()
       WHERE id = (
         SELECT id FROM job_data
         WHERE status = 'pending'
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING *`,
      []
    );

    await client.query('COMMIT');

    return result.rows[0] || null;
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    console.error('Error claiming pending job:', resolveErrorMessage(error));
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get the latest job
 */
export async function getLatestJob(): Promise<JobData | null> {
  if (!isDatabaseConnected()) {
    return null;
  }

  try {
    const result = await query(
      'SELECT * FROM job_data ORDER BY created_at DESC LIMIT 1',
      []
    );
    
    return result.rows[0] || null;
  } catch (error: unknown) {
    //audit Assumption: failures return null
    console.error('Error fetching latest job:', resolveErrorMessage(error));
    return null;
  }
}

/**
 * Get aggregate counts for the async worker queue.
 *
 * Purpose:
 * - Give operator tooling one stable queue summary instead of forcing multiple ad hoc queries.
 *
 * Inputs/outputs:
 * - Input: none.
 * - Output: status counters plus the latest queue mutation timestamp when available.
 *
 * Edge case behavior:
 * - Returns `null` when the database is unavailable or the summary query fails.
 */
export async function getJobQueueSummary(): Promise<JobQueueSummary | null> {
  //audit Assumption: queue summaries are only trustworthy when the DB connection is active; failure risk: helper surfaces stale or fabricated worker state; expected invariant: disconnected DB returns no summary; handling strategy: fail closed with `null`.
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
      last_updated_at?: string | Date | null;
    } | undefined;

    if (!summaryRow) {
      return {
        pending: 0,
        running: 0,
        completed: 0,
        failed: 0,
        total: 0
      };
    }

    const summary: JobQueueSummary = {
      pending: summaryRow.pending_count,
      running: summaryRow.running_count,
      completed: summaryRow.completed_count,
      failed: summaryRow.failed_count,
      total: summaryRow.total_count
    };

    //audit Assumption: `MAX(updated_at)` may be null when no jobs exist; failure risk: invalid date serialization; expected invariant: timestamp only appears when the queue has history; handling strategy: guard before ISO normalization.
    if (summaryRow.last_updated_at) {
      summary.lastUpdatedAt = new Date(summaryRow.last_updated_at).toISOString();
    }

    return summary;
  } catch (error: unknown) {
    //audit Assumption: queue summary failures should degrade observability, not crash request handling; failure risk: operator status endpoint returns 500 for transient query issues; expected invariant: errors are logged and summary becomes unavailable; handling strategy: return `null`.
    console.error('Error fetching job queue summary:', resolveErrorMessage(error));
    return null;
  }
}
