// Unified Worker Initialization - Uses new modular worker system
import { workerStatusService } from './services/worker-status';
import { isTrue } from './utils/env';
import { createServiceLogger } from './utils/logger';
import { initializeAllWorkers, shutdownWorkers, getWorkerSystemStatus } from './services/worker-init';
import cron from 'node-cron';

const logger = createServiceLogger('WorkerInit');

// Global registry for worker status tracking (simplified)
declare global {
  var workerSystemInitialized: boolean | undefined;
}

async function startWorkers() {
  logger.info('Starting unified worker system');
  
  const globalAny = globalThis as any;
  if (globalAny.workerSystemInitialized) {
    logger.info('Worker system already initialized');
    return;
  }

  try {
    await initializeAllWorkers();
    globalAny.workerSystemInitialized = true;
    
    logger.success('Unified worker system started successfully');
    
    // Log system status
    const status = getWorkerSystemStatus();
    logger.info('Worker system status', {
      totalWorkers: status.workers.totalWorkers,
      enabledWorkers: status.workers.enabledWorkers,
      totalSchedules: status.schedules.totalSchedules,
      runningSchedules: status.schedules.runningSchedules
    });
    
  } catch (error: any) {
    logger.error('Failed to start worker system', error);
    throw error;
  }
}

// Cleanup function for graceful shutdown
async function stopWorkers() {
  logger.info('Stopping worker system');
  
  try {
    await shutdownWorkers();
    const globalAny = globalThis as any;
    globalAny.workerSystemInitialized = false;
    
    logger.success('Worker system stopped successfully');
  } catch (error: any) {
    logger.error('Failed to stop worker system', error);
  }
}

// Handle process signals for graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down worker system');
  await stopWorkers();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down worker system');
  await stopWorkers();
  process.exit(0);
});

// Always initialize minimal system workers for status tracking
workerStatusService.initializeMinimalWorkers();
logger.info('Minimal system workers initialized');

// Conditional worker startup based on environment variable
if (isTrue(process.env.RUN_WORKERS)) {
  startWorkers().catch(error => {
    logger.error('Failed to start unified worker system', error);
  });
} else {
  logger.info('Workers disabled (RUN_WORKERS not set to true)');
}

export { startWorkers, stopWorkers, getWorkerSystemStatus };
