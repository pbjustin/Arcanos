import { reflect } from './ai';
import { selfReflectionService } from './self-reflection';

/**
 * Run an AI reflection sweep before sleep.
 */
export async function runReflectionSweep(context: string): Promise<void> {
  await reflect({
    label: `${context}_prep_reflection`,
    persist: true,
    includeStack: true,
    targetPath: 'ai_outputs/pre_sleep/'
  });
}

/**
 * Flush any pending memory writes to persistent storage.
 */
export async function finalizeMemoryWrite(): Promise<void> {
  await selfReflectionService.flushPending();
}

/**
 * Queue additional maintenance tasks for the upcoming sleep window.
 * Placeholder implementation hooks into existing sleep manager queues.
 */
export async function queueSleepTasks(): Promise<void> {
  // Future maintenance tasks can be added here.
}
