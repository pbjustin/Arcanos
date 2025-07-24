// AI-Controlled Worker Initialization - Workers only run when AI model decides
import { workerStatusService } from './services/worker-status';
import { modelControlHooks } from './services/model-control-hooks';
import { isTrue } from './utils/env';

async function initializeAIControlledWorkers() {
  console.log('[AI-WORKERS] Initializing AI-controlled worker system');
  
  // Register available workers with AI control system
  const availableWorkers = ['memorySync', 'goalWatcher', 'clearTemp'];
  
  for (const workerName of availableWorkers) {
    console.log(`[AI-WORKERS] Registering worker: ${workerName}`);
    
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
    } catch (error) {
      console.warn(`[AI-WORKERS] Failed to register ${workerName}:`, error);
    }
  }
  
  console.log('[AI-WORKERS] AI-controlled worker system initialized');
}

// Legacy function for compatibility - now AI controlled
async function startWorkers() {
  console.log('[AI-WORKERS] Legacy startWorkers called - routing to AI control');
  
  // Ask AI whether to start workers
  const result = await modelControlHooks.processRequest(
    'worker-startup',
    { 
      reason: 'RUN_WORKERS environment variable is true',
      requestedWorkers: ['memorySync', 'goalWatcher', 'clearTemp']
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
