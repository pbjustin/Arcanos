const lastRunMap = new Map<string, number>();

/**
 * Check whether a task should run based on a throttle interval.
 * @param taskId Unique identifier for the task
 * @param intervalMs Minimum interval between runs in milliseconds
 */
export function shouldRun(taskId: string, intervalMs: number): boolean {
  const lastRun = lastRunMap.get(taskId) || 0;
  const now = Date.now();
  if (now - lastRun >= intervalMs) {
    lastRunMap.set(taskId, now);
    return true;
  }
  return false;
}

import { enqueue } from '../services/jobQueue';

export interface QueuedTask {
  name: string;
  data: any;
  priority: 'high' | 'low';
  timestamp: number;
}

/**
 * Dispatch a task into the job queue with optional priority.
 */
export function dispatchTask(taskName: string, payload: any = {}, priority: 'high' | 'low' = 'low'): void {
  const task: QueuedTask = {
    name: taskName,
    data: payload,
    priority,
    timestamp: Date.now()
  };
  enqueue(task);
}

const REFLECTION_THRESHOLD = 50 * 1024 * 1024; // 50MB difference
let lastReflectionSnapshot = process.memoryUsage().heapUsed;

/**
 * Trigger a reflection task if memory usage has changed significantly
 * and the reflection cooldown has passed.
 */
export function maybeReflect(): void {
  const currentHeap = process.memoryUsage().heapUsed;
  const delta = Math.abs(currentHeap - lastReflectionSnapshot);
  if (delta > REFLECTION_THRESHOLD && shouldRun('reflection', 60 * 60 * 1000)) {
    dispatchTask('memory.reflect', { scope: 'meaningful' }, 'high');
    lastReflectionSnapshot = currentHeap;
  }
}
