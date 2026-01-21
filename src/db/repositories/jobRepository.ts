/**
 * Job Repository for ARCANOS
 * 
 * Handles job data storage and retrieval operations.
 */

import { isDatabaseConnected } from '../client.js';
import type { JobData } from '../schema.js';
import { query } from '../query.js';

/**
 * Create a new job
 */
export async function createJob(workerId: string, jobType: string, input: any, status: string = 'pending'): Promise<JobData> {
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
export async function updateJob(jobId: string, status: string, output: any = null, errorMessage: string | null = null): Promise<JobData> {
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
  } catch (error) {
    console.error('Error fetching latest job:', error);
    return null;
  }
}
