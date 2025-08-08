#!/usr/bin/env node
/**
 * Goal Watcher Worker - OpenAI SDK Compliant
 * Monitors and tracks goals using OpenAI API
 */

import { createOpenAIClient, executeWorker, createCompletion, isMainModule, registerWithManager } from './shared/workerUtils.js';

async function watchGoals(logger) {
  try {
    logger('Starting goal monitoring task');
    
    const openai = createOpenAIClient();
    if (!openai) {
      throw new Error('Failed to initialize OpenAI client');
    }

    // Use shared completion function for goal analysis with fine-tuned model
    const completion = await createCompletion(
      openai,
      'You are ARCANOS goal monitoring AI worker. Track and analyze goal progress and completion status.',
      'Analyze current goals and provide progress assessment for the ARCANOS system.',
      { max_tokens: 200, temperature: 0.2 }
    );

    const result = completion.choices[0].message.content;
    logger(`Goal analysis: ${result}`);
    
    logger('Goal monitoring completed successfully');
    
    return { success: true, result, timestamp: new Date().toISOString() };
  } catch (error) {
    logger(`Error during goal monitoring: ${error.message}`);
    throw error;
  }
}

// Export for testing
export { watchGoals };

// CommonJS-compatible export for WorkerManager integration
const runWorkerTask = async function(input, context) {
  const logger = context?.logger || ((msg) => console.log(`[goalWatcher] ${msg}`));
  return await watchGoals(logger);
};

// Export in the format requested by requirements
export default runWorkerTask;

// For CommonJS compatibility
if (typeof module !== 'undefined' && module.exports) {
  module.exports = runWorkerTask;
}

// Register with WorkerManager
registerWithManager('goalWatcher', runWorkerTask);

// Run if called directly
if (isMainModule()) {
  executeWorker('goalWatcher', watchGoals);
}