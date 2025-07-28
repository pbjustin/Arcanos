// AI-Controlled Worker System - Workers only execute when AI model instructs them to
const { modelControlHooks } = require('../dist/services/model-control-hooks');
const { diagnosticsService } = require('../dist/services/diagnostics');
const { createServiceLogger } = require('../dist/utils/logger');
const { workerRegistry, getWorkers } = require('./workerRegistry');
const logger = createServiceLogger('Workers');

// Determine worker logic mode
const WORKER_LOGIC = process.env.WORKER_LOGIC || 'arcanos';
console.log(`[AI-WORKERS] Worker logic mode: ${WORKER_LOGIC}`);
if (WORKER_LOGIC !== 'arcanos') {
  console.warn(`[AI-WORKERS] Non-standard worker logic: ${WORKER_LOGIC} - defaulting to ARCANOS`);
}

// Dynamically loaded worker functions - hot swappable modules
const workerExecutions = {};
for (const name of getWorkers()) {
  workerExecutions[name] = workerRegistry.get(name);
}

logger.info('AI-controlled worker system loaded');

// AI-controlled worker execution function
async function reportFailure(workerName, error) {
  logger.error(`Worker ${workerName} failure`, error);
  try {
    await diagnosticsService.executeDiagnosticCommand(`worker failure ${workerName}: ${error.message}`);
  } catch (diagErr) {
    logger.error('Diagnostics reporting failed', diagErr);
  }
}

async function executeWorkerWithAIControl(workerName, parameters = {}) {
  logger.info(`AI requesting execution of worker: ${workerName}`);
  
  try {
    // Ask AI model for permission and instructions
    const result = await modelControlHooks.orchestrateWorker(
      workerName,
      'background',
      parameters,
      {
        userId: 'system',
        sessionId: 'worker-execution',
        source: 'worker'
      }
    );

    if (result.success) {
      logger.info(`AI approved execution of ${workerName}`, { response: result.response });
      
      // Execute the actual worker if AI approves
      const workerFunction = workerExecutions[workerName];
      if (workerFunction) {
        await workerFunction();
        logger.success(`Completed execution of ${workerName}`);
      } else {
        logger.error(`Unknown worker: ${workerName}`);
      }
    } else {
      logger.warning(`AI denied execution of ${workerName}`, result.error);
    }
    
    return result;
  } catch (err) {
    await reportFailure(workerName, err);
    return { success: false, error: err.message };
  }
}

// Legacy function - now routes through AI control
async function runWorkers() {
  logger.info('Legacy runWorkers called - routing to AI control');
  
  const results = [];
  for (const workerName of Object.keys(workerExecutions)) {
    const result = await executeWorkerWithAIControl(workerName);
    results.push(result);
  }
  
  return results;
}

// Export AI-controlled interfaces
module.exports = { 
  runWorkers, 
  executeWorkerWithAIControl,
  jobs: Object.values(workerExecutions),
  availableWorkers: Object.keys(workerExecutions)
};
