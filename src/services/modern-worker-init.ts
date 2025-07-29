// Modern Worker Initialization - Refactored for OpenAI SDK v1.0.0 compatibility
// Replaces outdated orchestration logic with modular control hooks and unified fallback

import { refactorAIWorkerSystem, RefactoredAIWorkerSystem, OptimizedScheduleFormat } from './ai-worker-refactor';
import { createServiceLogger } from '../utils/logger';
import { isTrue } from '../utils/env';
import { workerStatusService } from './worker-status';

const logger = createServiceLogger('ModernWorkerInit');

// Global instance of the refactored system
let refactoredWorkerSystem: RefactoredAIWorkerSystem | null = null;

/**
 * Initialize the modern AI worker system with unified orchestration
 */
export async function initializeModernWorkerSystem(): Promise<void> {
  logger.info('Initializing modern AI worker system with refactored architecture');

  try {
    // Initialize the refactored system
    refactoredWorkerSystem = await refactorAIWorkerSystem({
      sdkVersion: '1.0.0',
      fallback: 'defaultWorker',
      controlHooks: true,
      modularize: true,
      logLevel: 'minimal'
    });

    logger.success('Modern AI worker system initialized successfully');

    // Report system status
    const status = refactoredWorkerSystem.getSystemStatus();
    logger.info('System status:', status);

  } catch (error: any) {
    logger.error('Failed to initialize modern worker system:', error.message);
    throw error;
  }
}

/**
 * Register a worker using the modern system
 */
export async function registerModernWorker(
  name: string, 
  config: any = {}
): Promise<any> {
  if (!refactoredWorkerSystem) {
    throw new Error('Modern worker system not initialized. Call initializeModernWorkerSystem() first.');
  }

  try {
    const result = await refactoredWorkerSystem.registerWorker(name, {
      ...config,
      registered: Date.now(),
      system: 'modern'
    });

    logger.info(`Modern worker registered: ${name}`, result);
    return result;

  } catch (error: any) {
    logger.error(`Failed to register modern worker ${name}:`, error.message);
    throw error;
  }
}

/**
 * Orchestrate a worker using the modern system with optimized scheduling
 */
export async function orchestrateModernWorker(
  name: string,
  parameters: any = {},
  schedule?: Partial<OptimizedScheduleFormat>
): Promise<any> {
  if (!refactoredWorkerSystem) {
    throw new Error('Modern worker system not initialized');
  }

  try {
    // If scheduling is provided, use the optimized scheduler
    if (schedule) {
      const optimizedSchedule: OptimizedScheduleFormat = {
        worker: name,
        type: schedule.type || 'immediate',
        priority: schedule.priority || 5,
        retryPolicy: schedule.retryPolicy || {
          maxAttempts: 3,
          backoffMs: 1000,
          exponential: true
        },
        timeout: schedule.timeout || 30000,
        schedule: schedule.schedule,
        delay: schedule.delay,
        condition: schedule.condition,
        metadata: {
          ...schedule.metadata,
          orchestrated: Date.now(),
          system: 'modern'
        }
      };

      return await refactoredWorkerSystem.scheduleWorker(optimizedSchedule);
    }

    // Standard orchestration
    const task = {
      name,
      parameters,
      type: 'ondemand',
      priority: 5,
      timeout: 30000
    };

    const result = await refactoredWorkerSystem.orchestrateWorker(task);
    logger.info(`Worker ${name} orchestrated successfully`);
    
    return result;

  } catch (error: any) {
    logger.error(`Failed to orchestrate worker ${name}:`, error.message);
    throw error;
  }
}

/**
 * Start critical workers with the modern system
 */
export async function startModernWorkers(): Promise<void> {
  if (!refactoredWorkerSystem) {
    await initializeModernWorkerSystem();
  }

  logger.info('Starting critical workers with modern orchestration');

  const criticalWorkers = [
    {
      name: 'goalTracker',
      config: { type: 'background', priority: 8, autoRestart: true },
      schedule: { type: 'recurring' as const, schedule: '*/30 * * * * *', priority: 8 }
    },
    {
      name: 'maintenanceScheduler', 
      config: { type: 'scheduled', priority: 6, autoRestart: true },
      schedule: { type: 'recurring' as const, schedule: '0 */6 * * *', priority: 6 }
    },
    {
      name: 'emailDispatcher',
      config: { type: 'ondemand', priority: 7, autoRestart: false },
      schedule: { type: 'conditional' as const, condition: 'email_queue_not_empty', priority: 7 }
    },
    {
      name: 'auditProcessor',
      config: { type: 'ondemand', priority: 5, autoRestart: false }
    }
  ];

  let successCount = 0;
  let errorCount = 0;

  for (const worker of criticalWorkers) {
    try {
      // Check if worker is already registered to avoid duplicates
      if (refactoredWorkerSystem && refactoredWorkerSystem.isWorkerRegistered(worker.name)) {
        logger.info(`✅ Worker ${worker.name} already registered, skipping duplicate registration`);
        successCount++;
        continue;
      }
      
      // Register the worker
      await registerModernWorker(worker.name, worker.config);
      
      // Orchestrate with scheduling if provided
      if (worker.schedule) {
        await orchestrateModernWorker(worker.name, {}, worker.schedule);
      } else {
        await orchestrateModernWorker(worker.name);
      }

      successCount++;
      logger.success(`✅ Worker ${worker.name} started successfully`);

    } catch (error: any) {
      errorCount++;
      logger.error(`❌ Failed to start worker ${worker.name}:`, error.message);
      
      // Continue with other workers - don't fail the entire system
      continue;
    }
  }

  logger.info(`Modern worker startup completed: ${successCount} successful, ${errorCount} failed`);

  if (successCount === 0) {
    logger.warning('⚠️ No workers started successfully - system may be in degraded mode');
  }
}

/**
 * Get status of the modern worker system
 */
export function getModernWorkerStatus(): any {
  if (!refactoredWorkerSystem) {
    return {
      initialized: false,
      error: 'Modern worker system not initialized'
    };
  }

  return {
    initialized: true,
    ...refactoredWorkerSystem.getSystemStatus(),
    timestamp: new Date().toISOString()
  };
}

/**
 * Add a custom control hook to the modern system
 */
export function addModernControlHook(name: string, hook: Function): void {
  if (!refactoredWorkerSystem) {
    throw new Error('Modern worker system not initialized');
  }

  refactoredWorkerSystem.addControlHook(name, hook);
  logger.info(`Custom control hook added: ${name}`);
}

/**
 * Add a custom fallback strategy to the modern system
 */
export function addModernFallbackStrategy(name: string, strategy: Function): void {
  if (!refactoredWorkerSystem) {
    throw new Error('Modern worker system not initialized');
  }

  refactoredWorkerSystem.addFallbackStrategy(name, strategy);
  logger.info(`Custom fallback strategy added: ${name}`);
}

// Initialize minimal system workers for compatibility
workerStatusService.initializeMinimalWorkers();
logger.info('Minimal system workers initialized for compatibility');

// Conditional startup based on environment
if (isTrue(process.env.RUN_WORKERS)) {
  startModernWorkers().catch(error => {
    logger.error('Failed to start modern workers:', error.message);
    logger.info('System will continue with degraded worker functionality');
  });
} else {
  logger.info('Workers disabled (RUN_WORKERS not set to true)');
}

// Export the refactored functions for backward compatibility
export { 
  initializeModernWorkerSystem as initializeOpenAIWorkers,
  orchestrateModernWorker as safeOrchestrateWorker,
  refactoredWorkerSystem 
};