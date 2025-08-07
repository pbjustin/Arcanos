#!/usr/bin/env node
/**
 * Goal Watcher Worker - OpenAI SDK Compliant
 * Monitors and tracks goals using OpenAI API
 */

import { createOpenAIClient, executeWorker, createCompletion, isMainModule } from './shared/workerUtils.js';

async function watchGoals(logger) {
  try {
    logger('Starting goal monitoring task');
    
    const openai = createOpenAIClient();
    if (!openai) {
      throw new Error('Failed to initialize OpenAI client');
    }

    // Use shared completion function for goal analysis
    const completion = await createCompletion(
      openai,
      'You are a goal monitoring AI worker. Track and analyze goal progress and completion status.',
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

// Run if called directly
if (isMainModule()) {
  executeWorker('goalWatcher', watchGoals);
}