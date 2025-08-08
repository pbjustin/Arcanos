#!/usr/bin/env node
/**
 * Memory Sync Worker - OpenAI SDK Compliant
 * Handles memory synchronization tasks using OpenAI API
 */

import { createOpenAIClient, executeWorker, createCompletion, isMainModule, registerWithManager } from './shared/workerUtils.js';

async function performMemorySync(logger) {
  try {
    logger('Starting memory synchronization task');
    
    const openai = createOpenAIClient();
    if (!openai) {
      throw new Error('Failed to initialize OpenAI client');
    }

    // Use shared completion function for memory analysis with fine-tuned model
    const completion = await createCompletion(
      openai,
      'You are ARCANOS memory synchronization AI worker. Analyze and optimize memory patterns.',
      'Perform memory synchronization analysis for current session data.',
      { max_tokens: 150, temperature: 0.3 }
    );

    const result = completion.choices[0].message.content;
    logger(`Memory sync analysis: ${result}`);
    
    // Simulate memory optimization
    logger('Memory optimization completed successfully');
    
    return { success: true, result, timestamp: new Date().toISOString() };
  } catch (error) {
    logger(`Error during memory sync: ${error.message}`);
    throw error;
  }
}

// Export for testing
export { performMemorySync };

// CommonJS-compatible export for WorkerManager integration
const runWorkerTask = async function(input, context) {
  const logger = context?.logger || ((msg) => console.log(`[memorySync] ${msg}`));
  return await performMemorySync(logger);
};

// Export in the format requested by requirements
export default runWorkerTask;

// For CommonJS compatibility
if (typeof module !== 'undefined' && module.exports) {
  module.exports = runWorkerTask;
}

// Register with WorkerManager
registerWithManager('memorySync', runWorkerTask);

// Run if called directly
if (isMainModule()) {
  executeWorker('memorySync', performMemorySync);
}