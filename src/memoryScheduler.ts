import { dispatchJob } from './services/execution-engine';

export async function scheduleMemoryWorker(tag: string, payload: any, delay: number = 0) {
  const timestamp = new Date(Date.now() + delay).toISOString();

  return dispatchJob({
    action: 'schedule',
    service: 'memory',
    parameters: {
      type: 'scheduled_task',
      tag,
      data: payload,
      timestamp,
      worker: 'memoryWorker',
      scheduled_event: true
    },
    priority: 5,
    worker: 'memoryWorker',
    schedule: timestamp
  });
}

// Example usage (sleep watcher)
scheduleMemoryWorker('hydrate_memory_after_sleep', {
  context: 'wake',
  restoreState: true,
});
