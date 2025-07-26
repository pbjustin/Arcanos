// AI-Controlled Worker Initialization - Workers only run when AI model decides
import { workerStatusService } from './services/worker-status';
import { modelControlHooks } from './services/model-control-hooks';
import { isTrue } from './utils/env';
import { goalTrackerWorker } from './workers/goal-tracker';
import { maintenanceSchedulerWorker } from './workers/maintenance-scheduler';
import { createServiceLogger } from './utils/logger';
import cron from 'node-cron';

// Global registry for active workers
declare global {
  var activeWorkers: Map<string, any> | undefined;
}

function workerInit(name: string, instance: any) {
  const globalAny = globalThis as any;
  if (!globalAny.activeWorkers) {
    globalAny.activeWorkers = new Map<string, any>();
  }
  if (globalAny.activeWorkers.has(name)) {
    logger.info(`Worker ${name} already registered`);
    return globalAny.activeWorkers.get(name);
  }
  const context = { instance, started: false, registeredAt: Date.now() };
  globalAny.activeWorkers.set(name, context);
  return context;
}

function pruneStaleWorkers() {
  const globalAny = globalThis as any;
  if (!globalAny.activeWorkers) return;
  const now = Date.now();
  for (const [name, ctx] of globalAny.activeWorkers.entries()) {
    if (!ctx.started && now - ctx.registeredAt > 30 * 60 * 1000) {
      globalAny.activeWorkers.delete(name);
      logger.info(`Pruned stale worker ${name}`);
    }
  }
}

// Run cleanup every 15 minutes
cron.schedule('*/15 * * * *', pruneStaleWorkers);

const logger = createServiceLogger('WorkerInit');

async function initializeAIControlledWorkers() {
  logger.info('Initializing AI-controlled worker system with enhanced workers');
  
  // Register available workers with AI control system (including new workers)
  const availableWorkers = ['memorySync', 'goalWatcher', 'clearTemp', 'auditProcessor', 'maintenanceScheduler', 'emailDispatcher'];
  
  for (const workerName of availableWorkers) {
    logger.info('Registering worker with AI control system', { workerName });
    
    // Each worker registers itself with the AI control system
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
    } catch (error: any) {
      logger.warning('Failed to register worker with AI control', { workerName, error: error.message });
    }
  }
  
  logger.success('AI-controlled worker system initialized', { workerCount: availableWorkers.length });
}

async function startBackgroundWorkers() {
  logger.info('Starting enhanced background workers');

  try {
    // Start Goal Tracker Worker
    const goalCtx = workerInit('goalTracker', goalTrackerWorker);
    if (!goalCtx.started) {
      await goalTrackerWorker.start();
      goalCtx.started = true;
      logger.success('Goal Tracker Worker started');
    }

    // Start Maintenance Scheduler Worker
    const maintCtx = workerInit('maintenanceScheduler', maintenanceSchedulerWorker);
    if (!maintCtx.started) {
      await maintenanceSchedulerWorker.start();
      maintCtx.started = true;
      logger.success('Maintenance Scheduler Worker started');
    }
    
    logger.success('All background workers started successfully');
    
  } catch (error: any) {
    logger.error('Failed to start background workers', error);
    throw error;
  }
}

// Legacy function for compatibility - now AI controlled
async function startWorkers() {
  logger.info('Legacy startWorkers called - routing to AI control and enhanced workers');
  
  // Start the enhanced background workers
  try {
    await startBackgroundWorkers();
  } catch (error: any) {
    logger.error('Background worker startup failed', error);
  }
  
  // Ask AI whether to start additional workers
  const result = await modelControlHooks.processRequest(
    'worker-startup',
    { 
      reason: 'RUN_WORKERS environment variable is true',
      requestedWorkers: ['memorySync', 'goalWatcher', 'clearTemp', 'auditProcessor', 'maintenanceScheduler']
    },
    {
      userId: 'system',
      sessionId: 'startup',
      source: 'system'
    }
  );
  
  if (result.success) {
    console.log('[AI-WORKERS] AI approved worker startup:', result.response);
  } else {
    console.log('[AI-WORKERS] AI denied worker startup:', result.error);
  }
}

// Always initialize minimal system workers for status tracking
workerStatusService.initializeMinimalWorkers();
console.log('[WORKER-INIT] Minimal system workers initialized');

// Initialize AI-controlled worker system
initializeAIControlledWorkers().catch(error => {
  console.error('[AI-WORKERS] Failed to initialize AI-controlled workers:', error);
});

// Conditional worker startup based on environment variable - now AI controlled
if (isTrue(process.env.RUN_WORKERS)) {
  startWorkers().catch(error => {
    console.error('[AI-WORKERS] Failed to start AI-controlled workers:', error);
  });
} else {
  console.log('[WORKER-INIT] Workers disabled (RUN_WORKERS not set to true)');
}

export { startWorkers, initializeAIControlledWorkers };
