#!/usr/bin/env node
/**
 * Maintenance Scheduler Worker - OpenAI SDK Compliant
 * Handles system maintenance scheduling using OpenAI API
 */

import { createOpenAIClient, executeWorker, createCompletion, isMainModule, registerWithManager } from './shared/workerUtils.js';

async function scheduleMaintenance(logger) {
  try {
    logger('Starting maintenance scheduling task');
    
    const openai = createOpenAIClient();
    if (!openai) {
      throw new Error('Failed to initialize OpenAI client');
    }

    // Use shared completion function for maintenance planning with fine-tuned model
    const completion = await createCompletion(
      openai,
      'You are ARCANOS maintenance scheduling AI worker. Plan and optimize system maintenance schedules.',
      'Analyze current system status and create an optimal maintenance schedule for the ARCANOS platform.',
      { max_tokens: 250, temperature: 0.2 }
    );

    const result = completion.choices[0].message.content;
    logger(`Maintenance schedule: ${result}`);
    
    logger('Maintenance scheduling completed successfully');
    
    return { success: true, result, timestamp: new Date().toISOString() };
  } catch (error) {
    logger(`Error during maintenance scheduling: ${error.message}`);
    throw error;
  }
}

// Export for testing
export { scheduleMaintenance };

// CommonJS-compatible export for WorkerManager integration
const runWorkerTask = async function(input, context) {
  const logger = context?.logger || ((msg) => console.log(`[maintenanceScheduler] ${msg}`));
  return await scheduleMaintenance(logger);
};

// Export in the format requested by requirements
export default runWorkerTask;

// For CommonJS compatibility
if (typeof module !== 'undefined' && module.exports) {
  module.exports = runWorkerTask;
}

// Register with WorkerManager
registerWithManager('maintenanceScheduler', runWorkerTask);

// Run if called directly
if (isMainModule()) {
  executeWorker('maintenanceScheduler', scheduleMaintenance);
}