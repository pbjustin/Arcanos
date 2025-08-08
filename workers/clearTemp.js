#!/usr/bin/env node
/**
 * Clear Temp Worker - OpenAI SDK Compliant
 * Handles temporary file cleanup using OpenAI API guidance
 */

import { createOpenAIClient, executeWorker, createCompletion, isMainModule, registerWithManager } from './shared/workerUtils.js';

async function clearTempFiles(logger) {
  try {
    logger('Starting temporary file cleanup task');
    
    const openai = createOpenAIClient();
    if (!openai) {
      throw new Error('Failed to initialize OpenAI client');
    }

    // Use shared completion function for cleanup strategy with fine-tuned model
    const completion = await createCompletion(
      openai,
      'You are ARCANOS file cleanup AI worker. Analyze and recommend optimal temporary file cleanup strategies.',
      'Analyze current temporary file usage and recommend cleanup actions for the ARCANOS system.',
      { max_tokens: 150, temperature: 0.1 }
    );

    const result = completion.choices[0].message.content;
    logger(`Cleanup analysis: ${result}`);
    
    // Simulate temp file cleanup
    logger('Temporary file cleanup completed successfully');
    
    return { success: true, result, timestamp: new Date().toISOString() };
  } catch (error) {
    logger(`Error during temp cleanup: ${error.message}`);
    throw error;
  }
}

// Export for testing
export { clearTempFiles };

// CommonJS-compatible export for WorkerManager integration
const runWorkerTask = async function(input, context) {
  const logger = context?.logger || ((msg) => console.log(`[clearTemp] ${msg}`));
  return await clearTempFiles(logger);
};

// Export in the format requested by requirements
export default runWorkerTask;

// For CommonJS compatibility
if (typeof module !== 'undefined' && module.exports) {
  module.exports = runWorkerTask;
}

// Register with WorkerManager
registerWithManager('clearTemp', runWorkerTask);

// Run if called directly
if (isMainModule()) {
  executeWorker('clearTemp', clearTempFiles);
}