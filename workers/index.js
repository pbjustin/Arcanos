// AI-Controlled Worker System - Workers only execute when AI model instructs them to
const path = require('path');
const { modelControlHooks } = require('../src/services/model-control-hooks');

// Available worker functions - now AI-controlled execution shells
const workerExecutions = {
  memorySync: require(path.resolve(__dirname, './memorySync')),
  goalWatcher: require(path.resolve(__dirname, './goalWatcher')),
  clearTemp: require(path.resolve(__dirname, './clearTemp')),
};

console.log('[AI-WORKERS] AI-controlled worker system loaded');

// AI-controlled worker execution function
async function executeWorkerWithAIControl(workerName, parameters = {}) {
  console.log(`[AI-WORKERS] AI requesting execution of worker: ${workerName}`);
  
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
      console.log(`[AI-WORKERS] AI approved execution of ${workerName}: ${result.response}`);
      
      // Execute the actual worker if AI approves
      const workerFunction = workerExecutions[workerName];
      if (workerFunction) {
        await workerFunction();
        console.log(`[AI-WORKERS] Completed execution of ${workerName}`);
      } else {
        console.error(`[AI-WORKERS] Unknown worker: ${workerName}`);
      }
    } else {
      console.log(`[AI-WORKERS] AI denied execution of ${workerName}: ${result.error}`);
    }
    
    return result;
  } catch (err) {
    console.error(`[AI-WORKERS] Error executing ${workerName}:`, err.message);
    return { success: false, error: err.message };
  }
}

// Legacy function - now routes through AI control
async function runWorkers() {
  console.log('[AI-WORKERS] Legacy runWorkers called - routing to AI control');
  
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
