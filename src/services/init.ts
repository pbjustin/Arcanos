/**
 * Worker Initialization Service
 * Provides a unified interface for initializing different types of workers
 */

import { createServiceLogger } from '../utils/logger';

const logger = createServiceLogger('WorkerInit');

// Worker registry to track initialized workers
const initializedWorkers = new Map<string, boolean>();

/**
 * Initialize a worker by name
 * @param workerName - Name of the worker to initialize
 */
export async function initializeWorker(workerName: string): Promise<void> {
  if (initializedWorkers.get(workerName)) {
    logger.info(`Worker ${workerName} already initialized`);
    return;
  }

  logger.info(`Initializing worker: ${workerName}`);

  try {
    switch (workerName) {
      case 'goalTracker': {
        const { goalTrackerWorker } = await import('../workers/goal-tracker');
        await goalTrackerWorker.start();
        initializedWorkers.set(workerName, true);
        logger.success(`✅ ${workerName} initialized successfully`);
        break;
      }

      case 'maintenanceScheduler': {
        const { maintenanceSchedulerWorker } = await import('../workers/maintenance-scheduler');
        await maintenanceSchedulerWorker.start();
        initializedWorkers.set(workerName, true);
        logger.success(`✅ ${workerName} initialized successfully`);
        break;
      }

      case 'emailDispatcher':
        // Email dispatcher is a function-based worker, we initialize it by ensuring it's available
        const { dispatchEmail } = await import('../workers/email/email-dispatcher');
        logger.info('Email dispatcher service is now available');
        initializedWorkers.set(workerName, true);
        logger.success(`✅ ${workerName} initialized successfully`);
        break;

      case 'auditProcessor':
        // Audit processor is a function-based worker, we initialize it by making it available
        const { runStreamAudit } = await import('../workers/audit/stream-audit-worker');
        logger.info('Audit processor service is now available');
        initializedWorkers.set(workerName, true);
        logger.success(`✅ ${workerName} initialized successfully`);
        break;

      default:
        throw new Error(`Unknown worker: ${workerName}`);
    }
  } catch (error: any) {
    logger.error(`Failed to initialize worker ${workerName}`, error);
    throw error;
  }
}

/**
 * Check if a worker is initialized
 * @param workerName - Name of the worker to check
 */
export function isWorkerInitialized(workerName: string): boolean {
  return initializedWorkers.get(workerName) || false;
}

/**
 * Get list of all initialized workers
 */
export function getInitializedWorkers(): string[] {
  return Array.from(initializedWorkers.entries())
    .filter(([_, initialized]) => initialized)
    .map(([name, _]) => name);
}

/**
 * Reset worker initialization state (for testing)
 */
export function resetWorkerInitialization(): void {
  initializedWorkers.clear();
  logger.info('Worker initialization state reset');
}