#!/usr/bin/env node
/**
 * Shared Worker Utilities - OpenAI SDK Compliant
 * Common patterns and utilities for ARCANOS workers
 */

import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';

const MEMORY_LOG_PATH = process.env.NODE_ENV === 'production' ? '/var/arc/log/session.log' : './memory/session.log';

/**
 * Initialize OpenAI client with error handling
 */
export function createOpenAIClient() {
  try {
    return new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  } catch (error) {
    console.error('Failed to initialize OpenAI client:', error.message);
    return null;
  }
}

/**
 * Shared logging function for all workers
 */
export function createLogger(workerName) {
  return (message) => {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${workerName}] ${message}\n`;
    
    try {
      const logDir = path.dirname(MEMORY_LOG_PATH);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      
      fs.appendFileSync(MEMORY_LOG_PATH, logEntry);
      console.log(logEntry.trim());
    } catch (error) {
      console.error(`Failed to write to log: ${error.message}`);
    }
  };
}

/**
 * Setup common process event handlers
 */
export function setupProcessHandlers(logger) {
  process.on('SIGINT', () => {
    logger('Worker interrupted');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    logger('Worker terminated');
    process.exit(0);
  });

  process.on('uncaughtException', (error) => {
    logger(`Uncaught exception: ${error.message}`);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger(`Unhandled rejection at: ${promise}, reason: ${reason}`);
    process.exit(1);
  });
}

/**
 * Execute worker with common error handling and lifecycle management
 */
export async function executeWorker(workerName, workerFunction) {
  const logger = createLogger(workerName);
  setupProcessHandlers(logger);
  
  logger(`Worker ${workerName} started with model: ${process.env.AI_MODEL || 'ft:gpt-3.5-turbo-0125:personal:arcanos-v2'}`);
  
  try {
    const result = await workerFunction(logger);
    logger('Worker completed successfully');
    process.exit(0);
  } catch (error) {
    logger(`Worker failed: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Create standardized OpenAI completion request with retry logic
 */
export async function createCompletion(openai, systemPrompt, userPrompt, options = {}) {
  const defaultOptions = {
    model: process.env.AI_MODEL || 'ft:gpt-3.5-turbo-0125:personal:arcanos-v2',
    max_tokens: 200,
    temperature: 0.2
  };

  const maxRetries = 3;
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await openai.chat.completions.create({
        ...defaultOptions,
        ...options,
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: userPrompt
          }
        ]
      });
    } catch (error) {
      lastError = error;
      console.error(`OpenAI completion attempt ${attempt} failed:`, error.message);
      
      if (attempt < maxRetries) {
        // Wait before retrying (exponential backoff)
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError;
}

/**
 * Check if this worker is being run directly
 */
export function isMainModule() {
  return import.meta.url === `file://${process.argv[1]}`;
}

/**
 * Register worker with WorkerManager (for auto-boot integration)
 */
export async function registerWithManager(workerName, workerFunction) {
  try {
    // Check if we're running in a managed environment
    if (process.env.WORKER_MANAGED === 'true') {
      // Worker is being managed by WorkerManager, export function for external use
      return workerFunction;
    }
    
    // Try to register with WorkerManager if available
    const managerPath = process.env.WORKER_MANAGER_PATH || '../src/services/workerManager.js';
    
    // For now, just log registration attempt
    console.log(`[${workerName}] Attempting registration with WorkerManager`);
    
    return workerFunction;
  } catch (error) {
    // Registration failed, but continue with standalone execution
    console.log(`[${workerName}] Registration with WorkerManager failed: ${error.message}`);
    return workerFunction;
  }
}