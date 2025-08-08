#!/usr/bin/env node
/**
 * Audit Processor Worker - OpenAI SDK Compliant
 * Performs system audits using OpenAI API
 */

import { createOpenAIClient, createCompletion } from './shared/workerUtils.js';

// Worker metadata and main function in required format
export const id = 'auditProcessor';
export const description = 'Performs comprehensive system audits including security, performance, and operational status analysis';

export async function run(input, tools) {
  try {
    const openai = createOpenAIClient();
    if (!openai) {
      throw new Error('Failed to initialize OpenAI client');
    }

    // Use shared completion function for audit analysis
    const completion = await createCompletion(
      openai,
      'You are ARCANOS audit AI worker. Analyze system performance, security, and compliance using advanced diagnostic capabilities.',
      input.query || 'Perform a comprehensive audit of the ARCANOS system including security, performance, and operational status.',
      { max_tokens: 300, temperature: 0.1 }
    );

    const result = completion.choices[0].message.content;
    
    return { 
      success: true, 
      result, 
      timestamp: new Date().toISOString(),
      worker: id
    };
  } catch (error) {
    throw new Error(`Audit processing failed: ${error.message}`);
  }
}