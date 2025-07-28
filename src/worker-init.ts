// AI-Controlled Worker Initialization - Refactored for OpenAI SDK v1.0.0 compatibility
import { workerStatusService } from './services/worker-status';
import { modelControlHooks } from './services/model-control-hooks';
import { isTrue } from './utils/env';
import { goalTrackerWorker } from './workers/goal-tracker';
import { maintenanceSchedulerWorker } from './workers/maintenance-scheduler';
import { createServiceLogger } from './utils/logger';
import { 
  initializeModernWorkerSystem,
  startModernWorkers,
  getModernWorkerStatus,
  registerModernWorker,
  orchestrateModernWorker
} from './services/modern-worker-init';
import { 
  validateWorkerDispatch, 
  isKnownWorker, 
  KNOWN_WORKERS 
} from './utils/worker-validation';

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

async function initializeAIControlledWorkers(): Promise<void> {
  logger.info('Initializing refactored AI-controlled worker system');
  
  // Initialize the modern worker system first
  try {
    await initializeModernWorkerSystem();
    logger.success('✅ Modern worker system initialized successfully');
  } catch (modernError: any) {
    logger.warning(`⚠️ Modern system failed: ${modernError.message}, falling back to legacy`);
  }
  
  // Check system status
  const systemStatus = getModernWorkerStatus();
  if (!systemStatus.initialized) {
    logger.warning(`⚠️ Modern system not available: ${systemStatus.error}`);
    logger.info('🔄 Will attempt legacy orchestration methods');
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

      // Try modern system first
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
          logger.warning(`⚠️ Modern registration failed for ${workerName}:`, modernError.message);
        }
      }

      // Fallback to model control hooks if modern system failed
      if (!orchestrationSuccess) {
        try {
          await modelControlHooks.orchestrateWorker(
            workerName,
            'ondemand',
            { initialized: true },
            {
              userId: 'system',
              sessionId: 'worker-init',
              source: 'system'
            }
          );
          orchestrationSuccess = true;
          logger.success(`✅ Worker ${workerName} registered via legacy control hooks`);
        } catch (legacyError: any) {
          logger.error(`❌ All orchestration methods failed for ${workerName}:`, legacyError.message);
        }
      }
      
      // Update worker registry
      activeWorkers.set(workerName, { 
        instance: null, 
        started: false, 
        registeredAt: Date.now(),
        lastError: orchestrationSuccess ? undefined : 'Orchestration failed',
        retryCount: 0,
        system: orchestrationSuccess ? 'modern' : 'legacy'
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
        system: 'failed'
      });
      errorCount++;
    }
  }
  
  logger.info(`📊 Refactored worker system initialized: ${successCount} successful, ${errorCount} failed`, { 
    totalWorkers: availableWorkers.length,
    modernSystemAvailable: systemStatus.initialized
  });
  
  if (successCount === 0 && errorCount > 0) {
    logger.warning('⚠️ No workers successfully initialized, system running in degraded mode');
  }
}

async function startBackgroundWorkers(): Promise<void> {
  logger.info('Starting refactored background workers');

  // Try modern system first
  const systemStatus = getModernWorkerStatus();
  if (systemStatus.initialized) {
    try {
      await startModernWorkers();
      logger.success('✅ Modern background workers started successfully');
      return;
    } catch (modernError: any) {
      logger.warning(`⚠️ Modern worker startup failed: ${modernError.message}, falling back to legacy`);
    }
  }

  // Legacy fallback startup
  try {
    const workersToStart = ['goalTracker', 'maintenanceScheduler'];
    let startedCount = 0;
    
    for (const workerName of workersToStart) {
      let workerCtx = activeWorkers.get(workerName);
      if (!workerCtx) {
        logger.warning(`⚠️ Worker context not found for ${workerName} - creating placeholder`);
        workerCtx = {
          instance: null,
          started: false,
          registeredAt: Date.now(),
          lastError: 'context_missing',
          retryCount: 0,
          system: 'legacy'
        };
        activeWorkers.set(workerName, workerCtx);
      }

      if (workerCtx.started) {
        logger.info(`ℹ️ Worker ${workerName} already started`);
        continue;
      }

      try {
        // Attempt to start the worker with error handling
        if (workerName === 'goalTracker') {
          workerCtx.instance = goalTrackerWorker;
          await goalTrackerWorker.start();
          workerCtx.started = true;
          workerCtx.lastError = undefined;
          logger.success('Goal Tracker Worker started');
          startedCount++;
          
        } else if (workerName === 'maintenanceScheduler') {
          workerCtx.instance = maintenanceSchedulerWorker;
          await maintenanceSchedulerWorker.start();
          workerCtx.started = true;
          workerCtx.lastError = undefined;
          logger.success('Maintenance Scheduler Worker started');
          startedCount++;
        }
        
      } catch (workerError: any) {
        logger.error(`❌ Failed to start worker ${workerName}:`, workerError.message);
        workerCtx.lastError = `Start failed: ${workerError.message}`;
        workerCtx.retryCount++;
        
        // Attempt retry for critical workers
        if (workerCtx.retryCount < 3) {
          logger.info(`🔄 Scheduling retry for worker ${workerName} (attempt ${workerCtx.retryCount + 1})`);
          setTimeout(async () => {
            try {
              if (workerName === 'goalTracker') {
                await goalTrackerWorker.start();
              } else if (workerName === 'maintenanceScheduler') {
                await maintenanceSchedulerWorker.start();
              }
              workerCtx.started = true;
              workerCtx.lastError = undefined;
              logger.success(`✅ Worker ${workerName} started on retry`);
            } catch (retryError: any) {
              logger.error(`❌ Retry failed for worker ${workerName}:`, retryError.message);
              workerCtx.lastError = `Retry failed: ${retryError.message}`;
            }
          }, 5000 * workerCtx.retryCount); // Exponential backoff
        }
      }
    }
    
    logger.info(`📊 Legacy background workers startup completed: ${startedCount}/${workersToStart.length} started successfully`);
    
  } catch (error: any) {
    logger.error('❌ Critical error during background worker startup:', error.message);
    throw error;
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

// Initialize minimal system workers for status tracking
workerStatusService.initializeMinimalWorkers();
console.log('[WORKER-INIT] Minimal system workers initialized');

// Initialize AI-controlled worker system with comprehensive error handling
initializeAIControlledWorkers().catch(error => {
  logger.error('[AI-WORKERS] Failed to initialize AI-controlled workers:', error.message);
  
  // 🔁 Enhanced fallback to modern refactored worker system
  logger.info('[AI-WORKERS] Attempting enhanced fallback to refactored system...');
  
  initializeModernWorkerSystem().catch(fallbackError => {
    logger.error('[AI-WORKERS] Fallback modern system also failed:', fallbackError.message);
    logger.warning('⚠️ System will run with minimal worker functionality');
    
    // Final fallback - register workers locally without orchestration
    const minimalWorkers = ['goalTracker', 'maintenanceScheduler'];
    minimalWorkers.forEach(workerName => {
      if (!activeWorkers.has(workerName)) {
        activeWorkers.set(workerName, {
          instance: null,
          started: false,
          registeredAt: Date.now(),
          lastError: 'Registered in minimal mode - orchestration unavailable',
          retryCount: 0,
          system: 'minimal'
        });
        logger.info(`📝 Worker ${workerName} registered in minimal mode`);
      }
    });
  });
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
