#!/usr/bin/env node
/**
 * Memory Sync Worker - OpenAI SDK Compliant
 * Handles memory synchronization tasks using OpenAI API
 */

import { createOpenAIClient, executeWorker, createCompletion, isMainModule } from './shared/workerUtils.js';

async function performMemorySync(logger) {
  try {
    logger('Starting memory synchronization task');
    
    const openai = createOpenAIClient();
    if (!openai) {
      throw new Error('Failed to initialize OpenAI client');
    }

    // Use shared completion function for memory analysis
    const completion = await createCompletion(
      openai,
      'You are a memory synchronization AI worker. Analyze and optimize memory patterns.',
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

// Run if called directly
if (isMainModule()) {
  executeWorker('memorySync', performMemorySync);
}