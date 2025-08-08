#!/usr/bin/env node
/**
 * Code Improvement Worker - OpenAI SDK Compliant
 * Analyzes and suggests code improvements using OpenAI API
 */

import { createOpenAIClient, createCompletion } from './shared/workerUtils.js';

// Worker metadata and main function in required format
export const id = 'codeImprovement';
export const description = 'Analyzes code quality, performance, and suggests optimizations for better maintainability';

export async function run(input, tools) {
  try {
    const openai = createOpenAIClient();
    if (!openai) {
      throw new Error('Failed to initialize OpenAI client');
    }

    // Use shared completion function for code analysis
    const completion = await createCompletion(
      openai,
      'You are ARCANOS code improvement AI worker. Analyze code quality, performance, and suggest optimizations.',
      input.query || 'Analyze the ARCANOS codebase for potential improvements in performance, maintainability, and code quality.',
      { max_tokens: 300, temperature: 0.2 }
    );

    const result = completion.choices[0].message.content;
    
    return { 
      success: true, 
      result, 
      timestamp: new Date().toISOString(),
      worker: id
    };
  } catch (error) {
    throw new Error(`Code improvement analysis failed: ${error.message}`);
  }
}