export type Job = any;

const queue: Job[] = [];
const CONCURRENCY_LIMIT = 3;
let activeJobs = 0;

// Job tracking for auditing
export const completedJobs: Job[] = [];
export const failedJobs: Array<{ job: Job; error: string; timestamp: string }> = [];
export const inProgressJobs: Job[] = [];

export function enqueue(job: Job) {
  // Add timestamp and ID to job for tracking
  const enhancedJob = {
    ...job,
    id: Date.now() + Math.random(),
    enqueuedAt: new Date().toISOString()
  };
  queue.push(enhancedJob);
}

async function runClearAudit(job: Job): Promise<any> {
  // Placeholder async logic; replace with real implementation
  await new Promise(resolve => setTimeout(resolve, 1000));
  return job;
}

async function runJob(job: Job) {
  console.log('🚀 Running job:', job);
  
  // Track job as in-progress
  inProgressJobs.push(job);
  
  try {
    const result = await runClearAudit(job);
    
    // Move to completed
    const completedJob = {
      ...job,
      result,
      completedAt: new Date().toISOString()
    };
    completedJobs.push(completedJob);
    
    // Keep only last 100 completed jobs
    if (completedJobs.length > 100) {
      completedJobs.shift();
    }
    
    console.log('✅ Finished:', result);
  } catch (err: any) {
    // Track failed job
    const failedJob = {
      job,
      error: err.message,
      timestamp: new Date().toISOString()
    };
    failedJobs.push(failedJob);
    
    // Keep only last 100 failed jobs
    if (failedJobs.length > 100) {
      failedJobs.shift();
    }
    
    console.error('❌ Error:', err.message);
  } finally {
    // Remove from in-progress
    const index = inProgressJobs.findIndex(j => j.id === job.id);
    if (index !== -1) {
      inProgressJobs.splice(index, 1);
    }
    
    activeJobs--;
    processQueue();
  }
}

export function processQueue() {
  while (activeJobs < CONCURRENCY_LIMIT && queue.length > 0) {
    const job = queue.shift()!;
    activeJobs++;
    runJob(job);
  }
}

setInterval(processQueue, 5000);

// Queue audit functions for diagnostics
export function getQueueAudit() {
  return {
    pending: queue.map(job => ({
      ...job,
      status: 'pending',
      category: 'pending'
    })),
    inProgress: inProgressJobs.map(job => ({
      ...job,
      status: 'in-progress',
      category: 'in-progress'
    })),
    completed: completedJobs.map(job => ({
      ...job,
      status: 'completed',
      category: 'completed'
    })),
    failed: failedJobs.map(item => ({
      ...item.job,
      error: item.error,
      failedAt: item.timestamp,
      status: 'failed',
      category: 'failed'
    }))
  };
}

export function getQueueStats() {
  return {
    totalPending: queue.length,
    totalInProgress: inProgressJobs.length,
    totalCompleted: completedJobs.length,
    totalFailed: failedJobs.length,
    activeJobs,
    concurrencyLimit: CONCURRENCY_LIMIT
  };
}
