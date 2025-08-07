#!/usr/bin/env node
/**
 * Audit Processor Worker - OpenAI SDK Compliant
 * Performs system audits using OpenAI API
 */

import { createOpenAIClient, executeWorker, createCompletion, isMainModule } from './shared/workerUtils.js';

async function processAudit(logger) {
  try {
    logger('Starting system audit task');
    
    const openai = createOpenAIClient();
    if (!openai) {
      throw new Error('Failed to initialize OpenAI client');
    }

    // Use shared completion function for audit analysis
    const completion = await createCompletion(
      openai,
      'You are a system audit AI worker. Analyze system performance, security, and compliance.',
      'Perform a comprehensive audit of the ARCANOS system including security, performance, and operational status.',
      { max_tokens: 300, temperature: 0.1 }
    );

    const result = completion.choices[0].message.content;
    logger(`Audit analysis: ${result}`);
    
    logger('System audit completed successfully');
    
    return { success: true, result, timestamp: new Date().toISOString() };
  } catch (error) {
    logger(`Error during audit processing: ${error.message}`);
    throw error;
  }
}

// Export for testing
export { processAudit };

// Run if called directly
if (isMainModule()) {
  executeWorker('auditProcessor', processAudit);
}