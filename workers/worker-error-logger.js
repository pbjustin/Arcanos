#!/usr/bin/env node
/**
 * Worker Error Logger - OpenAI SDK Compliant
 * Handles MemoryKeyFormatMismatch errors and logs to error-log.txt
 */

import { createOpenAIClient, createCompletion } from './shared/workerUtils.js';
import fs from 'fs';
import path from 'path';

// Worker metadata and main function in required format
export const id = 'worker-error-logger';
export const description = 'Catches and gracefully handles MemoryKeyFormatMismatch errors with pattern validation';

/**
 * Validates pattern_* keys in schema access
 */
function validatePatternKey(key) {
  if (typeof key !== 'string') return false;
  if (!key.startsWith('pattern_')) return false;
  // Additional validation for pattern key format
  const pattern = /^pattern_[a-zA-Z0-9_-]+$/;
  return pattern.test(key);
}

/**
 * Safe schema access wrapper with try/catch
 */
function safeSchemaAccess(schema, key) {
  try {
    if (!validatePatternKey(key)) {
      throw new Error(`MemoryKeyFormatMismatch: Invalid pattern key format: ${key}`);
    }
    return schema[key];
  } catch (error) {
    logError('Schema Access Error', error, { key, schema: Object.keys(schema) });
    return null;
  }
}

/**
 * Log error to logs/error-log.txt
 */
function logError(type, error, context = {}) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${type}: ${error.message}\n` +
                   `Context: ${JSON.stringify(context, null, 2)}\n` +
                   `Stack: ${error.stack}\n\n`;
  
  try {
    const logPath = path.resolve(process.cwd(), 'logs', 'error-log.txt');
    fs.appendFileSync(logPath, logEntry, 'utf8');
  } catch (logWriteError) {
    console.error('Failed to write to error log:', logWriteError);
  }
}

export async function run(input, tools) {
  try {
    const openai = createOpenAIClient();
    if (!openai) {
      throw new Error('Failed to initialize OpenAI client');
    }

    // Handle any schema validation if provided in input
    if (input.schema && input.pattern_key) {
      const result = safeSchemaAccess(input.schema, input.pattern_key);
      if (result === null) {
        return {
          success: false,
          error: 'MemoryKeyFormatMismatch',
          message: 'Pattern key validation failed',
          timestamp: new Date().toISOString(),
          worker: id
        };
      }
    }

    // Use shared completion function for error analysis
    const completion = await createCompletion(
      openai,
      'You are ARCANOS error logger AI worker. Analyze system errors and provide recovery recommendations.',
      input.query || 'Analyze current system state for potential errors and recovery strategies.',
      { max_tokens: 200, temperature: 0.1 }
    );

    const result = completion.choices[0].message.content;
    
    return { 
      success: true, 
      result, 
      timestamp: new Date().toISOString(),
      worker: id,
      errorHandling: 'active',
      patternValidation: 'enabled'
    };
  } catch (error) {
    // Catch and gracefully handle all errors
    logError('Worker Execution Error', error, { worker: id, input });
    
    // Return graceful error response instead of throwing
    return {
      success: false,
      error: 'Worker execution failed',
      message: error.message,
      timestamp: new Date().toISOString(),
      worker: id,
      recovery: 'attempted'
    };
  }
}