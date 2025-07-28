// AI-Controlled Worker Initialization - Streamlined for OpenAI SDK patterns
import { workerStatusService } from './services/worker-status';
import { modelControlHooks } from './services/model-control-hooks';
import { isTrue } from './utils/env';
import { goalTrackerWorker } from './workers/goal-tracker';
import { maintenanceSchedulerWorker } from './workers/maintenance-scheduler';
import { createServiceLogger } from './utils/logger';
import { initializeOpenAIWorkers } from './services/openai-worker-orchestrator';

// Simplified worker registry - explicit and persistent
const activeWorkers = new Map<string, { instance: any; started: boolean; registeredAt: number }>();

const logger = createServiceLogger('WorkerInit');

async function initializeAIControlledWorkers() {
  logger.info('Initializing streamlined AI-controlled worker system');
  
  // Explicit worker registration - only modern TypeScript workers
  const availableWorkers = [
    'goalTracker',
    'maintenanceScheduler',
    'emailDispatcher',
    'auditProcessor'
  ];
  
  for (const workerName of availableWorkers) {
    logger.info('Registering worker with AI control system', { workerName });
    
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
      
      // Explicit registration
      activeWorkers.set(workerName, { 
        instance: null, 
        started: false, 
        registeredAt: Date.now() 
      });
      
    } catch (error: any) {
      logger.warning('Failed to register worker with AI control', { workerName, error: error.message });
    }
  }
  
  logger.success('AI-controlled worker system initialized', { workerCount: availableWorkers.length });
}

async function startBackgroundWorkers() {
  logger.info('Starting streamlined background workers');

  try {
    // Start Goal Tracker Worker
    const goalCtx = activeWorkers.get('goalTracker');
    if (goalCtx && !goalCtx.started) {
      goalCtx.instance = goalTrackerWorker;
      await goalTrackerWorker.start();
      goalCtx.started = true;
      logger.success('Goal Tracker Worker started');
    }

    // Start Maintenance Scheduler Worker
    const maintCtx = activeWorkers.get('maintenanceScheduler');
    if (maintCtx && !maintCtx.started) {
      maintCtx.instance = maintenanceSchedulerWorker;
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

// Streamlined worker startup - removed legacy fallback logic
async function startWorkers() {
  logger.info('Starting AI-controlled workers with streamlined logic');
  
  // Start the background workers
  try {
    await startBackgroundWorkers();
  } catch (error: any) {
    logger.error('Background worker startup failed', error);
  }
  
  // Ask AI whether to start additional workers (simplified request)
  const result = await modelControlHooks.processRequest(
    'worker-startup',
    { 
      reason: 'RUN_WORKERS environment variable is true',
      requestedWorkers: Array.from(activeWorkers.keys())
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

// Initialize minimal system workers for status tracking
workerStatusService.initializeMinimalWorkers();
console.log('[WORKER-INIT] Minimal system workers initialized');

// Initialize AI-controlled worker system
initializeAIControlledWorkers().catch(error => {
  console.error('[AI-WORKERS] Failed to initialize AI-controlled workers:', error);
  
  // 🔁 Fallback to OpenAI SDK-compatible worker orchestration
  console.log('[AI-WORKERS] Attempting fallback to OpenAI SDK orchestration...');
  initializeOpenAIWorkers().catch(fallbackError => {
    console.error('[AI-WORKERS] Fallback OpenAI orchestration also failed:', fallbackError);
  });
});

// Conditional worker startup based on environment variable - now streamlined
if (isTrue(process.env.RUN_WORKERS)) {
  startWorkers().catch(error => {
    console.error('[AI-WORKERS] Failed to start AI-controlled workers:', error);
  });
} else {
  console.log('[WORKER-INIT] Workers disabled (RUN_WORKERS not set to true)');
}

export { startWorkers, initializeAIControlledWorkers, activeWorkers, initializeOpenAIWorkers };
