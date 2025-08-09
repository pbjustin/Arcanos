#!/usr/bin/env node
/**
 * Worker Error Logger - OpenAI SDK Compliant
 * Handles MemoryKeyFormatMismatch errors and logs to error-log.txt
 * Enhanced with memorySync initialization and exponential backoff retry logic
 */

import { createOpenAIClient, createCompletion } from './shared/workerUtils.js';
import { initMemorySync, isMemorySyncInitialized, getMemorySyncStatus } from './memorySync.js';
import fs from 'fs';
import path from 'path';

// Worker metadata and main function in required format
export const id = 'worker-error-logger';
export const description = 'Catches and gracefully handles MemoryKeyFormatMismatch errors with pattern validation';

// Exponential backoff configuration
const MAX_RETRY_ATTEMPTS = 5;
const BASE_RETRY_DELAY = 1000; // 1 second
let retryAttempts = 0;
let isBootstrapComplete = false;

/**
 * Enhanced bootstrap function with memorySync initialization and retry logic
 */
async function bootstrap() {
  let attempt = 0;
  
  while (attempt < MAX_RETRY_ATTEMPTS) {
    try {
      console.log(`[WORKER-ERROR-LOGGER] Bootstrap attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS}`);
      
      // Initialize memorySync at the very start of bootstrap
      console.log('[WORKER-ERROR-LOGGER] Initializing memorySync dependency...');
      const memorySyncResult = initMemorySync();
      
      if (!memorySyncResult.success) {
        throw new Error(`MemorySync initialization failed: ${memorySyncResult.error}`);
      }
      
      console.log('[WORKER-ERROR-LOGGER] ✅ MemorySync initialized successfully');
      
      // Validate production environment variables
      const envVars = {
        NODE_ENV: process.env.NODE_ENV || 'development',
        PORT: process.env.PORT || '8080',
        AI_MODEL: process.env.AI_MODEL || 'default-model'
      };
      
      console.log('[WORKER-ERROR-LOGGER] Environment validation:', {
        nodeEnv: envVars.NODE_ENV,
        port: envVars.PORT,
        hasAiModel: !!envVars.AI_MODEL
      });
      
      // Mark bootstrap as complete
      isBootstrapComplete = true;
      retryAttempts = 0; // Reset retry counter on success
      
      console.log('[WORKER-ERROR-LOGGER] ✅ Bootstrap completed successfully');
      return { success: true, attempt: attempt + 1 };
      
    } catch (error) {
      attempt++;
      retryAttempts = attempt;
      
      logError('Bootstrap Error', error, { 
        attempt, 
        maxAttempts: MAX_RETRY_ATTEMPTS,
        memorySyncStatus: getMemorySyncStatus()
      });
      
      if (attempt >= MAX_RETRY_ATTEMPTS) {
        console.error(`[WORKER-ERROR-LOGGER] ❌ Bootstrap failed after ${MAX_RETRY_ATTEMPTS} attempts`);
        isBootstrapComplete = false;
        return { 
          success: false, 
          error: error.message, 
          attempts: attempt,
          memorySyncStatus: getMemorySyncStatus()
        };
      }
      
      // Exponential backoff: delay = baseDelay * (2^attempt)
      const delay = BASE_RETRY_DELAY * Math.pow(2, attempt);
      console.log(`[WORKER-ERROR-LOGGER] Retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS})`);
      
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

/**
 * Get worker status including bootstrap and memorySync status
 */
export function getWorkerStatus() {
  return {
    id,
    bootstrapComplete: isBootstrapComplete,
    retryAttempts,
    memorySyncStatus: getMemorySyncStatus(),
    timestamp: new Date().toISOString()
  };
}

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
    // Ensure bootstrap is complete before proceeding
    if (!isBootstrapComplete) {
      console.log('[WORKER-ERROR-LOGGER] Bootstrap not complete, attempting bootstrap...');
      const bootstrapResult = await bootstrap();
      if (!bootstrapResult.success) {
        return {
          success: false,
          error: 'Bootstrap failed',
          message: bootstrapResult.error,
          attempts: bootstrapResult.attempts,
          timestamp: new Date().toISOString(),
          worker: id,
          recovery: 'bootstrap_failure'
        };
      }
    }

    // Verify memorySync is still initialized
    if (!isMemorySyncInitialized()) {
      console.log('[WORKER-ERROR-LOGGER] MemorySync not initialized, attempting re-initialization...');
      const memorySyncResult = initMemorySync();
      if (!memorySyncResult.success) {
        logError('MemorySync Re-initialization Failed', new Error(memorySyncResult.error), { input });
        return {
          success: false,
          error: 'MemorySync initialization failed',
          message: memorySyncResult.error,
          timestamp: new Date().toISOString(),
          worker: id,
          recovery: 'memorySync_failure'
        };
      }
    }

    const openai = createOpenAIClient();
    
    // Handle mock mode when no API key is available
    if (!openai) {
      console.log('[WORKER-ERROR-LOGGER] Running in mock mode (no OpenAI API key)');
      
      // Handle schema validation in mock mode
      if (input.schema && input.pattern_key) {
        const result = safeSchemaAccess(input.schema, input.pattern_key);
        if (result === null) {
          return {
            success: false,
            error: 'MemoryKeyFormatMismatch',
            message: 'Pattern key validation failed',
            timestamp: new Date().toISOString(),
            worker: id,
            memorySyncInitialized: isMemorySyncInitialized(),
            mode: 'mock'
          };
        }
      }
      
      return { 
        success: true, 
        result: 'MOCK: Error analysis completed. System is running in development mode without AI integration. Error handling and pattern validation are active.',
        timestamp: new Date().toISOString(),
        worker: id,
        errorHandling: 'active',
        patternValidation: 'enabled',
        memorySyncInitialized: isMemorySyncInitialized(),
        bootstrapComplete: isBootstrapComplete,
        mode: 'mock'
      };
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
          worker: id,
          memorySyncInitialized: isMemorySyncInitialized()
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
      patternValidation: 'enabled',
      memorySyncInitialized: isMemorySyncInitialized(),
      bootstrapComplete: isBootstrapComplete,
      mode: 'ai-enabled'
    };
  } catch (error) {
    // Catch and gracefully handle all errors
    logError('Worker Execution Error', error, { 
      worker: id, 
      input, 
      memorySyncStatus: getMemorySyncStatus(),
      bootstrapComplete: isBootstrapComplete
    });
    
    // Return graceful error response instead of throwing
    return {
      success: false,
      error: 'Worker execution failed',
      message: error.message,
      timestamp: new Date().toISOString(),
      worker: id,
      recovery: 'attempted',
      memorySyncInitialized: isMemorySyncInitialized(),
      bootstrapComplete: isBootstrapComplete
    };
  }
}

// Initialize bootstrap process when module is loaded
bootstrap().catch(error => {
  console.error('[WORKER-ERROR-LOGGER] Failed to complete initial bootstrap:', error.message);
});