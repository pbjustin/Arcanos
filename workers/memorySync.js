#!/usr/bin/env node
/**
 * Memory Sync Worker - OpenAI SDK Compliant
 * Handles memory synchronization tasks using OpenAI API
 */

import { createOpenAIClient, createCompletion } from './shared/workerUtils.js';

// Worker metadata and main function in required format
export const id = 'memorySync';
export const description = 'Analyzes and optimizes memory patterns for session data synchronization';

export async function run(input, tools) {
  try {
    const openai = createOpenAIClient();
    if (!openai) {
      throw new Error('Failed to initialize OpenAI client');
    }

    // Use shared completion function for memory analysis
    const completion = await createCompletion(
      openai,
      'You are ARCANOS memory synchronization AI worker. Analyze and optimize memory patterns.',
      input.query || 'Perform memory synchronization analysis for current session data.',
      { max_tokens: 150, temperature: 0.3 }
    );

    const result = completion.choices[0].message.content;
    
    return { 
      success: true, 
      result, 
      timestamp: new Date().toISOString(),
      worker: id
    };
  } catch (error) {
    throw new Error(`Memory sync failed: ${error.message}`);
  }
}