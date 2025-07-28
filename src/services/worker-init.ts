/**
 * Unified Worker Initialization
 * Consolidates all worker registration and initialization logic
 */

import { createServiceLogger } from '../utils/logger';
import { workerRegistry, WorkerMetadata } from './unified-worker-registry';
import { scheduleDispatcher } from './dispatch-schedule';
import { WORKER_SCHEDULES } from '../config/scheduler';

// Import all TypeScript workers
import { dispatchEmail } from '../workers/email/email-dispatcher';
import { runStreamAudit } from '../workers/audit/stream-audit-worker';
import { maintenanceSchedulerWorker } from '../workers/maintenance-scheduler';
import { goalTrackerWorker } from '../workers/goal-tracker';

const logger = createServiceLogger('WorkerInit');

/**
 * Initialize all workers with proper typing and metadata
 */
export async function initializeAllWorkers(): Promise<void> {
  logger.info('Initializing unified worker system');

  try {
    // Register email dispatcher
    workerRegistry.registerWorker(
      'emailDispatcher',
      async (payload?: any) => {
        if (!payload || !payload.to || !payload.subject || !payload.message) {
          throw new Error('Invalid email payload - missing required fields');
        }
        await dispatchEmail(payload);
      },
      {
        type: 'onDemand',
        description: 'Dispatches emails with AI-generated content',
        enabled: true,
        retryCount: 0,
        maxRetries: 3
      }
    );

    // Register audit processor
    workerRegistry.registerWorker(
      'auditProcessor',
      async (payload?: any) => {
        if (!payload || !payload.message) {
          throw new Error('No audit message provided');
        }
        await runStreamAudit(payload);
      },
      {
        type: 'logic',
        mode: 'CLEAR',
        description: 'Processes audit logs and generates reports',
        enabled: true,
        retryCount: 0,
        maxRetries: 3
      }
    );

    // Register maintenance scheduler
    workerRegistry.registerWorker(
      'maintenanceScheduler',
      async (payload?: any) => {
        await maintenanceSchedulerWorker.start();
      },
      {
        type: 'recurring',
        interval: 'daily',
        description: 'Automated system maintenance and cleanup',
        enabled: true,
        retryCount: 0,
        maxRetries: 2
      }
    );

    // Register goal tracker
    workerRegistry.registerWorker(
      'goalTracker',
      async (payload?: any) => {
        await goalTrackerWorker.start();
      },
      {
        type: 'recurring',
        interval: 'hourly',
        description: 'Monitors and tracks goal progress',
        enabled: true,
        retryCount: 0,
        maxRetries: 3
      }
    );

    // Register memory sync worker (consolidated logic)
    workerRegistry.registerWorker(
      'memorySync',
      async (payload?: any) => {
        // Use model control hooks for memory sync
        const { modelControlHooks } = await import('../services/model-control-hooks');
        
        const result = await modelControlHooks.manageMemory(
          'list',
          {},
          {
            userId: 'system',
            sessionId: 'memory-sync',
            source: 'worker'
          }
        );

        if (result.success) {
          logger.info('Memory sync operation completed');
          
          // Store sync timestamp
          await modelControlHooks.manageMemory(
            'store',
            {
              key: 'sync_timestamp',
              value: new Date().toISOString(),
              tags: ['system', 'sync']
            },
            {
              userId: 'system',
              sessionId: 'memory-sync',
              source: 'worker'
            }
          );
        } else {
          throw new Error('Memory sync operation failed');
        }
      },
      {
        type: 'recurring',
        interval: 'hourly',
        description: 'Synchronizes memory storage',
        enabled: true,
        retryCount: 0,
        maxRetries: 3
      }
    );

    // Register cleanup worker (consolidated from clearTemp)
    workerRegistry.registerWorker(
      'cleanupWorker',
      async (payload?: any) => {
        const fs = await import('fs');
        const path = await import('path');
        
        // Clean temporary files
        const tempDirs = [
          path.join(process.cwd(), 'temp'),
          path.join(process.cwd(), 'storage', 'temp'),
          '/tmp'
        ];

        for (const dir of tempDirs) {
          if (fs.existsSync(dir)) {
            const files = fs.readdirSync(dir);
            const oldFiles = files.filter(file => {
              const filePath = path.join(dir, file);
              const stats = fs.statSync(filePath);
              const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
              return stats.mtime.getTime() < oneDayAgo;
            });

            oldFiles.forEach(file => {
              try {
                fs.unlinkSync(path.join(dir, file));
                logger.info('Cleaned temporary file', { file });
              } catch (error) {
                logger.warning('Failed to clean file', { file, error });
              }
            });
          }
        }
      },
      {
        type: 'recurring',
        interval: 'daily',
        description: 'Cleans temporary files and directories',
        enabled: true,
        retryCount: 0,
        maxRetries: 2
      }
    );

    logger.success('All workers registered successfully', {
      totalWorkers: workerRegistry.getWorkerNames().length
    });

    // Initialize scheduled tasks
    await initializeScheduledTasks();

  } catch (error: any) {
    logger.error('Failed to initialize workers', error);
    throw error;
  }
}

/**
 * Initialize all scheduled tasks from configuration
 */
export async function initializeScheduledTasks(): Promise<void> {
  logger.info('Initializing scheduled tasks');

  let successCount = 0;
  let failureCount = 0;

  for (const config of WORKER_SCHEDULES) {
    try {
      const success = scheduleDispatcher.startSchedule(config);
      if (success) {
        successCount++;
        logger.info('Schedule started', { 
          taskId: config.id, 
          workerType: config.workerType,
          cron: config.cronExpression 
        });
      } else {
        failureCount++;
        logger.warning('Failed to start schedule', { 
          taskId: config.id, 
          workerType: config.workerType 
        });
      }
    } catch (error: any) {
      failureCount++;
      logger.error('Error starting schedule', error, { 
        taskId: config.id, 
        workerType: config.workerType 
      });
    }
  }

  logger.info('Schedule initialization complete', { 
    successCount, 
    failureCount, 
    totalSchedules: WORKER_SCHEDULES.length 
  });
}

/**
 * Shutdown all workers and scheduled tasks
 */
export async function shutdownWorkers(): Promise<void> {
  logger.info('Shutting down worker system');

  // Stop all scheduled tasks
  const schedules = scheduleDispatcher.getAllSchedules();
  for (const schedule of schedules) {
    scheduleDispatcher.stopSchedule(schedule.id);
  }

  logger.info('Worker system shutdown complete');
}

/**
 * Get worker system status
 */
export function getWorkerSystemStatus(): {
  workers: ReturnType<typeof workerRegistry.getStats>;
  schedules: ReturnType<typeof scheduleDispatcher.getStats>;
} {
  return {
    workers: workerRegistry.getStats(),
    schedules: scheduleDispatcher.getStats()
  };
}