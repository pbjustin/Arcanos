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
