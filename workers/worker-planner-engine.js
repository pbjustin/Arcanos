#!/usr/bin/env node
/**
 * ARCANOS Job Scheduler Worker
 * 
 * Manages job creation, tracking, and execution with database persistence
 */

import cron from 'node-cron';
import dotenv from 'dotenv';
import { initializeDatabase, createJob, updateJob, query, logExecution, getStatus } from '../dist/db.js';

// Load environment variables
dotenv.config();

const JOB_TIMEOUT_MS = parseInt(process.env.WORKER_API_TIMEOUT_MS || '30000', 10);
const MAX_ITERATIONS = 100;

export const id = 'worker-planner-engine';

// Verify database connectivity before processing jobs
await initializeDatabase(id);
await logExecution(id, 'info', 'db_connection_verified');

let scheduledTasks = [];
let isScheduling = false;

/**
 * Create a new job
 */
export async function createNewJob(workerId, jobType, input) {
  try {
    const job = await createJob(workerId, jobType, input);
    await logExecution(id, 'info', `Job created: ${job.id}`, { jobType, workerId });
    return job;
  } catch (error) {
    await logExecution(id, 'error', 'Failed to create job', { error: error.message, jobType, workerId });
    throw error;
  }
}

/**
 * Update job status
 */
export async function updateJobStatus(jobId, status, output = null) {
  try {
    const job = await updateJob(jobId, status, output);
    await logExecution(id, 'info', `Job updated: ${jobId}`, { status, hasOutput: !!output });
    return job;
  } catch (error) {
    await logExecution(id, 'error', 'Failed to update job', { error: error.message, jobId, status });
    throw error;
  }
}

/**
 * Get pending jobs for a worker
 */
export async function getPendingJobs(workerId) {
  const dbStatus = getStatus();
  
  if (!dbStatus.connected) {
    return [];
  }
  
  try {
    const result = await query(
      'SELECT * FROM job_data WHERE worker_id = $1 AND status = $2 ORDER BY created_at ASC',
      [workerId, 'pending']
    );
    
    return result.rows;
  } catch (error) {
    await logExecution(id, 'error', 'Failed to get pending jobs', { error: error.message, workerId });
    return [];
  }
}

/**
 * Process jobs for all workers
 */
async function processJobs() {
  const dbStatus = getStatus();
  
  if (!dbStatus.connected) {
    return;
  }
  
  try {
    // Get all pending jobs
    const result = await query(
      'SELECT * FROM job_data WHERE status = $1 ORDER BY created_at ASC LIMIT 10',
      ['pending']
    );
    
    if (result.rows.length === 0) {
      return;
    }
    
    await logExecution(id, 'info', `Processing ${result.rows.length} pending jobs`);
    
    let iterations = 0;
    for (const job of result.rows) {
      if (iterations++ >= MAX_ITERATIONS) {
        await logExecution(id, 'warn', 'Max iteration limit reached in processJobs');
        break;
      }

      try {
        await Promise.race([
          (async () => {
            // Mark job as in progress
            await updateJobStatus(job.id, 'in_progress');

            // Simulate job processing (in real implementation, delegate to worker)
            const mockOutput = {
              processed: true,
              timestamp: new Date().toISOString(),
              result: `Processed job ${job.id} of type ${job.job_type}`
            };

            // Mark job as completed
            await updateJobStatus(job.id, 'completed', mockOutput);
          })(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Job timed out')), JOB_TIMEOUT_MS)
          )
        ]);
      } catch (error) {
        await updateJobStatus(job.id, 'failed', { error: error.message });
        await logExecution(id, 'error', `Job processing failed: ${job.id}`, { error: error.message });
      }
    }
    
  } catch (error) {
    await logExecution(id, 'error', 'Job processing cycle failed', { error: error.message });
  }
}

/**
 * Start job scheduling
 */
export function startScheduling() {
  if (isScheduling) {
    console.log('[📅 WORKER-PLANNER] Scheduling already started');
    return;
  }
  
  const dbStatus = getStatus();
  
  if (!dbStatus.connected) {
    console.log('[📅 WORKER-PLANNER] ⚠️  Database not connected - scheduling disabled');
    return;
  }
  
  // Schedule job processing every minute
  const task = cron.schedule('*/1 * * * *', async () => {
    await processJobs();
  }, {
    scheduled: false
  });
  
  task.start();
  scheduledTasks.push(task);
  isScheduling = true;
  
  console.log('[📅 WORKER-PLANNER] ✅ Job scheduling started (every 1 minute)');
}

/**
 * Stop job scheduling
 */
export function stopScheduling() {
  scheduledTasks.forEach(task => task.stop());
  scheduledTasks = [];
  isScheduling = false;
  console.log('[📅 WORKER-PLANNER] Scheduling stopped');
}

/**
 * Worker run function
 */
export async function run() {
  const dbStatus = getStatus();
  
  if (dbStatus.connected) {
    console.log('[📅 WORKER-PLANNER] ✅ Initialized with database job tracking');
  } else {
    console.log('[📅 WORKER-PLANNER] ⚠️  Initialized without database - scheduling disabled');
  }
  
  // Log initial startup
  try {
    await logExecution(id, 'info', 'Planner engine worker initialized', { 
      database: dbStatus.connected,
      schedulingEnabled: dbStatus.connected 
    });
  } catch (error) {
    console.log('[📅 WORKER-PLANNER] Startup logging failed, using fallback');
  }
}

console.log(`[📅 WORKER-PLANNER] Module loaded: ${id}`);