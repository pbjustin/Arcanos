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

    // Register memory sync worker (enhanced with sleep window functionality)
    workerRegistry.registerWorker(
      'memorySync',
      async (payload?: any) => {
        // Use model control hooks for memory sync
        const { modelControlHooks } = await import('../services/model-control-hooks');
        const { shouldReduceServerActivity } = await import('../services/sleep-config');
        
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

          // Enhanced: Create memory snapshot during sleep window
          if (shouldReduceServerActivity()) {
            const memUsage = process.memoryUsage();
            const timestamp = new Date().toISOString();
            
            const snapshotData = {
              timestamp,
              processMemory: {
                rss: Math.round(memUsage.rss / 1024 / 1024), // MB
                heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024), // MB
                heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024), // MB
                external: Math.round(memUsage.external / 1024 / 1024) // MB
              },
              memoryCount: result.results?.[0]?.result?.length || 0,
              sleepWindow: true,
              snapshotType: 'sleep_maintenance'
            };
            
            await modelControlHooks.manageMemory(
              'store',
              {
                key: `memory_snapshot_${timestamp.split('T')[0]}_${Date.now()}`,
                value: snapshotData,
                tags: ['snapshot', 'sleep', 'maintenance', 'memory-analysis']
              },
              {
                userId: 'system',
                sessionId: 'memory-snapshot',
                source: 'worker'
              }
            );
            
            logger.info('Memory snapshot created during sleep window', {
              rss: snapshotData.processMemory.rss,
              heapUsed: snapshotData.processMemory.heapUsed,
              records: snapshotData.memoryCount
            });
          }
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

    // Register cleanup worker (enhanced with comprehensive cleanup logic)
    workerRegistry.registerWorker(
      'cleanupWorker',
      async (payload?: any) => {
        const fs = await import('fs');
        const path = await import('path');
        const { modelControlHooks } = await import('../services/model-control-hooks');
        const { shouldReduceServerActivity } = await import('../services/sleep-config');
        
        // Request cleanup permission from AI model
        const result = await modelControlHooks.performMaintenance(
          'cleanup',
          { target: 'temp', maxAge: '24h' },
          {
            userId: 'system',
            sessionId: 'temp-cleaner',
            source: 'worker'
          }
        );

        if (!result.success) {
          throw new Error('AI denied cleanup operation');
        }

        // Perform AI-approved cleanup
        if (global.gc) {
          global.gc();
          logger.info('Memory garbage collection executed');
        }

        // Enhanced: Perform comprehensive log cleanup during sleep window
        if (shouldReduceServerActivity()) {
          const cleanupStats = {
            timestamp: new Date().toISOString(),
            sleepWindow: true,
            filesProcessed: 0,
            filesRemoved: 0,
            bytesFreed: 0,
            directories: []
          };
          
          // Define directories to clean
          const cleanupDirectories = [
            '/tmp',
            path.join(process.cwd(), 'logs'),
            path.join(process.cwd(), 'temp'),
            path.join(process.cwd(), 'storage', 'temp'),
            path.join(process.cwd(), 'storage', 'logs')
          ];
          
          for (const dir of cleanupDirectories) {
            try {
              if (fs.existsSync(dir)) {
                const files = fs.readdirSync(dir);
                const now = Date.now();
                const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
                
                for (const file of files) {
                  try {
                    const filePath = path.join(dir, file);
                    const fileStat = fs.statSync(filePath);
                    
                    cleanupStats.filesProcessed++;
                    
                    // Skip directories and recent files
                    if (fileStat.isDirectory()) continue;
                    if (now - fileStat.mtime.getTime() < maxAge) continue;
                    
                    // Remove old log files, temp files, and cache files
                    const shouldRemove = /\.(log|tmp|cache|temp)$/i.test(file) || 
                                       file.startsWith('temp_') || 
                                       file.startsWith('log_') ||
                                       file.includes('.log.') ||
                                       file.endsWith('.old');
                    
                    if (shouldRemove) {
                      fs.unlinkSync(filePath);
                      cleanupStats.filesRemoved++;
                      cleanupStats.bytesFreed += fileStat.size;
                      logger.debug('Removed old file', { file, bytes: fileStat.size });
                    }
                  } catch (fileError) {
                    logger.warning('Failed to process file', { file, error: fileError });
                  }
                }
              }
            } catch (dirError) {
              logger.warning('Directory not accessible', { dir, error: dirError });
            }
          }

          // Store cleanup results
          await modelControlHooks.manageMemory(
            'store',
            {
              key: `cleanup_report_${new Date().toISOString().split('T')[0]}_${Date.now()}`,
              value: cleanupStats,
              tags: ['cleanup', 'logs', 'sleep', 'maintenance', 'temp']
            },
            {
              userId: 'system',
              sessionId: 'log-cleanup',
              source: 'worker'
            }
          );
          
          logger.info('Comprehensive cleanup completed', {
            processed: cleanupStats.filesProcessed,
            removed: cleanupStats.filesRemoved,
            freedMB: Math.round(cleanupStats.bytesFreed / 1024 / 1024)
          });
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

    // Register code improvement worker
    workerRegistry.registerWorker(
      'codeImprovement',
      async (payload?: any) => {
        const { modelControlHooks } = await import('../services/model-control-hooks');
        
        // Request code analysis permission from AI model
        const analysisResult = await modelControlHooks.performAudit(
          { 
            auditType: 'code_improvement',
            scope: 'daily_suggestions',
            timestamp: new Date().toISOString(),
            sleepWindow: true 
          },
          'code_improvement_audit',
          {
            userId: 'system',
            sessionId: 'code-improvement',
            source: 'worker'
          }
        );

        if (!analysisResult.success) {
          throw new Error('AI denied code improvement analysis');
        }

        // Generate code improvement suggestions (condensed list)
        const suggestions = [
          {
            category: 'Performance',
            title: 'Memory Usage Optimization',
            description: 'Consider implementing memory pooling for frequently allocated objects',
            priority: 'medium',
            estimatedImpact: 'Reduce memory allocation overhead by 15-20%',
            timestamp: new Date().toISOString()
          },
          {
            category: 'Security',
            title: 'Input Validation Enhancement',
            description: 'Add comprehensive input sanitization for all user-facing endpoints',
            priority: 'high',
            estimatedImpact: 'Improve security posture and prevent injection attacks',
            timestamp: new Date().toISOString()
          }
        ];
        
        // Store suggestions in memory for later review
        await modelControlHooks.manageMemory(
          'store',
          {
            key: `code_improvements_${new Date().toISOString().split('T')[0]}`,
            value: {
              timestamp: new Date().toISOString(),
              suggestions: suggestions,
              generatedDuringSleep: true,
              status: 'pending_review'
            },
            tags: ['code-improvement', 'daily', 'sleep-maintenance', 'suggestions']
          },
          {
            userId: 'system',
            sessionId: 'code-improvement',
            source: 'worker'
          }
        );

        logger.info('Generated code improvement suggestions', { count: suggestions.length });
      },
      {
        type: 'recurring',
        interval: 'daily',
        description: 'Generates daily code improvement suggestions',
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