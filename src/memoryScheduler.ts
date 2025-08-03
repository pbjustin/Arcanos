import { dispatchJob } from './services/execution-engine.js';

// Memory-optimized scheduler with batching and deduplication
const scheduledTasks = new Map<string, any>();
const BATCH_INTERVAL = parseInt(process.env.MEMORY_BATCH_INTERVAL || '30000'); // 30 seconds

export async function scheduleMemoryWorker(tag: string, payload: any, delay: number = 0) {
  const timestamp = new Date(Date.now() + delay).toISOString();
  const taskId = `${tag}_${timestamp}`;
  
  // Deduplicate similar tasks
  if (scheduledTasks.has(taskId)) {
    console.log(`Memory task ${taskId} already scheduled, skipping duplicate`);
    return scheduledTasks.get(taskId);
  }

  const jobConfig = {
    action: 'schedule',
    service: 'memory',
    parameters: {
      type: 'scheduled_task',
      tag,
      data: payload,
      timestamp,
      worker: 'memoryWorker',
      scheduled_event: true,
      batchOptimized: true
    },
    priority: 5,
    worker: 'memoryWorker',
    schedule: timestamp
  };

  // Store in scheduled tasks for deduplication
  scheduledTasks.set(taskId, jobConfig);
  
  // Clean up old scheduled tasks periodically
  setTimeout(() => {
    scheduledTasks.delete(taskId);
  }, delay + BATCH_INTERVAL);

  return dispatchJob(jobConfig);
}

// Optimized memory hydration after sleep
export async function scheduleMemoryHydration(context: any = {}) {
  return scheduleMemoryWorker('hydrate_memory_after_sleep', {
    context: 'wake',
    restoreState: true,
    optimized: true,
    batchSize: parseInt(process.env.MEMORY_HYDRATION_BATCH_SIZE || '100'),
    ...context
  });
}

// Batch memory cleanup scheduler
export async function scheduleMemoryCleanup(userId?: string) {
  return scheduleMemoryWorker('memory_cleanup', {
    userId,
    cleanupType: 'expired_entries',
    batchProcessing: true,
    maxAge: parseInt(process.env.MEMORY_MAX_AGE || '86400000') // 24 hours default
  });
}
