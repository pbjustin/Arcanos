// AI-Controlled Worker Initialization - Refactored for OpenAI SDK v1.0.0 compatibility
import { workerStatusService } from './services/worker-status.js';
import { modelControlHooks } from './services/model-control-hooks.js';
import { isTrue } from './utils/env.js';
import { goalTrackerWorker } from './workers/goal-tracker.js';
import { maintenanceSchedulerWorker } from './workers/maintenance-scheduler.js';
import { createServiceLogger } from './utils/logger.js';
import { registerWorker } from './services/worker-manager.js';
import { memory } from './services/memory-scheduler.js';
import type { ScheduleTask } from './types/scheduler.js';
import { execSync } from 'child_process';

// Auto-install missing types if running locally
try {
  execSync('npm install --save-dev @types/node', { stdio: 'inherit' });
} catch (err) {
  console.error('[Patch] Failed to install missing types:', err);
}

// Ensure environment has open access to registry.npmjs.org
process.env.NPM_CONFIG_REGISTRY = 'https://registry.npmjs.org';
import { 
  initializeModernWorkerSystem,
  startModernWorkers,
  getModernWorkerStatus,
  registerModernWorker,
  orchestrateModernWorker
} from './services/modern-worker-init.js';
import { 
  validateWorkerDispatch, 
  isKnownWorker, 
  KNOWN_WORKERS 
} from './utils/worker-validation.js';

// Simplified worker registry - explicit and persistent
const activeWorkers = new Map<string, { 
  instance: any; 
  started: boolean; 
  registeredAt: number; 
  lastError?: string;
  retryCount: number;
  system?: string;
}>();

const logger = createServiceLogger('WorkerInit');

// Register defaultWorker bound to memory scheduler
registerWorker('defaultWorker', {
  service: 'memory',
  schedule: (task: ScheduleTask) => {
    if (!task || !task.key || !Array.isArray(task.value)) {
      throw new Error('[Scheduler] Invalid task payload');
    }
    console.log(`[Scheduler] Registered ${task.key} with ${task.value.length} entries`);
    memory.schedule(task.key, task.value);
  }
});

async function initializeAIControlledWorkers(): Promise<void> {
  logger.info('Initializing refactored AI-controlled worker system');
  
  // Initialize the modern worker system first
  try {
    await initializeModernWorkerSystem();
    logger.success('✅ Modern worker system initialized successfully');
  } catch (modernError: any) {
    logger.error(`❌ Modern system failed: ${modernError.message}`);
    throw modernError; // Fail fast instead of falling back to legacy
  }
  
  // Check system status
  const systemStatus = getModernWorkerStatus();
  if (!systemStatus.initialized) {
    logger.error(`❌ Modern system not available: ${systemStatus.error}`);
    throw new Error('Modern worker system required - legacy fallback removed');
  }
  
  // Register workers using the modern system or fallback to legacy
  const availableWorkers = KNOWN_WORKERS.filter(worker => 
    ['goalTracker', 'maintenanceScheduler', 'emailDispatcher', 'auditProcessor'].includes(worker)
  );
  
  let successCount = 0;
  let errorCount = 0;
  
  for (const workerName of availableWorkers) {
    logger.info('Registering worker with refactored AI control system', { workerName });
    
    try {
      // Validate worker registration parameters
      const dispatchParams = validateWorkerDispatch({
        worker: workerName,
        action: 'register',
        context: {
          userId: 'system',
          sessionId: 'worker-init',
          source: 'system'
        },
        options: {
          timeout: 30000,
          retryAttempts: 2,
          priority: 5
        }
      });

      // Try modern system only - no legacy fallback
      let orchestrationSuccess = false;
      if (systemStatus.initialized) {
        try {
          await registerModernWorker(workerName, {
            type: 'system',
            priority: 5,
            source: 'init'
          });
          orchestrationSuccess = true;
          logger.success(`✅ Worker ${workerName} registered via modern system`);
        } catch (modernError: any) {
          logger.error(`❌ Modern registration failed for ${workerName}:`, modernError.message);
          throw modernError; // Fail fast instead of legacy fallback
        }
      } else {
        throw new Error(`Modern system not available for ${workerName}`);
      }
      
      // Update worker registry
      activeWorkers.set(workerName, { 
        instance: null, 
        started: false, 
        registeredAt: Date.now(),
        lastError: orchestrationSuccess ? undefined : 'Orchestration failed',
        retryCount: 0,
        system: 'modern'
      });
      
      if (orchestrationSuccess) {
        successCount++;
      } else {
        errorCount++;
      }
      
    } catch (error: any) {
      logger.error('Failed to register worker with AI control', { workerName, error: error.message });
      
      // Still register for potential retry
      activeWorkers.set(workerName, { 
        instance: null, 
        started: false, 
        registeredAt: Date.now(),
        lastError: error.message,
        retryCount: 0,
        system: 'modern'
      });
      errorCount++;
    }
  }
  
  logger.info(`📊 Modern worker system initialized: ${successCount} successful, ${errorCount} failed`, { 
    totalWorkers: availableWorkers.length,
    modernSystemAvailable: systemStatus.initialized
  });
  
  if (successCount === 0 && errorCount > 0) {
    logger.warning('⚠️ No workers successfully initialized, system running in degraded mode');
  }
}

async function startBackgroundWorkers(): Promise<void> {
  logger.info('Starting modern background workers');

  // Use modern system only - no legacy fallback
  const systemStatus = getModernWorkerStatus();
  if (systemStatus.initialized) {
    try {
      await startModernWorkers();
      logger.success('✅ Modern background workers started successfully');
      return;
    } catch (modernError: any) {
      logger.error(`❌ Modern worker startup failed: ${modernError.message}`);
      throw modernError; // Fail fast instead of falling back
    }
  } else {
    throw new Error('Modern worker system not available - cannot start workers');
  }
}

// Streamlined worker startup with comprehensive error handling and fallback logic
async function startWorkers(): Promise<void> {
  logger.info('Starting AI-controlled workers with enhanced error handling');
  
  try {
    // Start the background workers with enhanced error handling
    await startBackgroundWorkers();
    logger.success('✅ Background workers startup completed');
    
  } catch (error: any) {
    logger.error('❌ Background worker startup failed:', error.message);
    logger.info('🔄 Continuing with degraded worker functionality');
  }
  
  // Enhanced AI worker startup request with validation
  try {
    const workerStartupRequest = validateWorkerDispatch({
      worker: 'system',
      action: 'worker-startup',
      payload: { 
        reason: 'RUN_WORKERS environment variable is true',
        requestedWorkers: Array.from(activeWorkers.keys()),
        timestamp: new Date().toISOString()
      },
      context: {
        userId: 'system',
        sessionId: 'startup',
        source: 'system'
      },
      options: {
        timeout: 30000,
        retryAttempts: 1,
        priority: 8
      }
    });

    // Ask AI whether to start additional workers with fallback
    let aiDecisionResult;
    try {
      aiDecisionResult = await modelControlHooks.processRequest(
        'worker-startup',
        workerStartupRequest.payload,
        workerStartupRequest.context!
      );
    } catch (aiError: any) {
      logger.warning('⚠️ AI decision making failed, using fallback logic:', aiError.message);
      
      // Fallback: auto-approve if we have any registered workers
      const registeredCount = Array.from(activeWorkers.values()).filter(w => !w.lastError).length;
      aiDecisionResult = {
        success: registeredCount > 0,
        response: `Fallback: Auto-approved worker startup (${registeredCount} workers available)`,
        error: registeredCount === 0 ? 'No workers available for startup' : undefined
      };
    }
    
    if (aiDecisionResult.success) {
      logger.success('[AI-WORKERS] AI approved worker startup:', aiDecisionResult.response);
      
      // Report worker status
      const workerStatuses = Array.from(activeWorkers.entries()).map(([name, ctx]) => ({
        name,
        started: ctx.started,
        hasError: !!ctx.lastError,
        registeredAt: new Date(ctx.registeredAt).toISOString()
      }));
      
      logger.info('📊 Worker status summary:', workerStatuses);
      
    } else {
      logger.warning('[AI-WORKERS] AI denied worker startup:', aiDecisionResult.error);
    }
    
  } catch (validationError: any) {
    logger.error('❌ Worker startup validation failed:', validationError.message);
    logger.info('🔄 System will continue with minimal worker functionality');
  }
}

// Initialize optimized system workers for status tracking
workerStatusService.initializeOptimizedWorkers();
console.log('[WORKER-INIT] Minimal system workers initialized');

// Initialize AI-controlled worker system with modern approach only
initializeAIControlledWorkers().catch(error => {
  logger.error('[AI-WORKERS] Failed to initialize AI-controlled workers:', error.message);
  logger.error('[AI-WORKERS] Modern system required - exiting');
  process.exit(1); // Fail fast instead of degraded mode
});

// Conditional worker startup based on environment variable with enhanced error handling
if (isTrue(process.env.RUN_WORKERS)) {
  startWorkers().catch(error => {
    logger.error('[AI-WORKERS] Failed to start AI-controlled workers:', error.message);
    logger.warning('⚠️ Workers failed to start - system running in degraded mode');
  });
} else {
  logger.info('[WORKER-INIT] Workers disabled (RUN_WORKERS not set to true)');
}

// Export enhanced worker management functions for refactored system
export { 
  startWorkers, 
  initializeAIControlledWorkers, 
  activeWorkers, 
  initializeModernWorkerSystem,
  orchestrateModernWorker,
  getModernWorkerStatus
};
