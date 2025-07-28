import cron from 'node-cron';
import { createServiceLogger } from '../utils/logger';
import { executionEngine } from '../services/execution-engine';
import { DispatchInstruction } from '../services/ai-dispatcher';

const logger = createServiceLogger('DefaultScheduler');

/**
 * Initialize a fallback scheduler for instructions missing worker identities.
 */
export function initializeFallbackScheduler(instruction: DispatchInstruction): void {
  const schedule = instruction.schedule;
  if (!schedule) {
    logger.warning('No schedule provided for fallback scheduler');
    return;
  }

  const taskId = `fallback_${Date.now()}`;

  try {
    cron.schedule(
      schedule,
      async () => {
        logger.warning('Executing fallback scheduled instruction', { taskId });
        await executionEngine.executeInstruction({
          ...instruction,
          action: 'execute',
          worker: undefined
        });
      },
      { timezone: 'UTC' }
    );

    logger.warning('Fallback scheduler initialized', { taskId, schedule });
  } catch (error: any) {
    logger.error('Failed to initialize fallback scheduler', error);
  }
}
