#!/usr/bin/env node
/**
 * Code Improvement Worker - OpenAI SDK Compliant
 * Analyzes and suggests code improvements using OpenAI API
 */

import { createOpenAIClient, executeWorker, createCompletion, isMainModule } from './shared/workerUtils.js';

async function analyzeCodeImprovements(logger) {
  try {
    logger('Starting code improvement analysis');
    
    const openai = createOpenAIClient();
    if (!openai) {
      throw new Error('Failed to initialize OpenAI client');
    }

    // Use shared completion function for code analysis
    const completion = await createCompletion(
      openai,
      'You are a code improvement AI worker. Analyze code quality, performance, and suggest optimizations.',
      'Analyze the ARCANOS codebase for potential improvements in performance, maintainability, and code quality.',
      { max_tokens: 300, temperature: 0.2 }
    );

    const result = completion.choices[0].message.content;
    logger(`Code analysis: ${result}`);
    
    logger('Code improvement analysis completed successfully');
    
    return { success: true, result, timestamp: new Date().toISOString() };
  } catch (error) {
    logger(`Error during code analysis: ${error.message}`);
    throw error;
  }
}

// Export for testing
export { analyzeCodeImprovements };

// Run if called directly
if (isMainModule()) {
  executeWorker('codeImprovement', analyzeCodeImprovements);
}