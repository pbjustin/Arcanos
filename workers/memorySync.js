#!/usr/bin/env node
/**
 * Memory Sync Worker - OpenAI SDK Compliant
 * Handles memory synchronization tasks using OpenAI API
 */

import { createOpenAIClient, createCompletion } from './shared/workerUtils.js';

// Worker metadata and main function in required format
export const id = 'memorySync';
export const description = 'Analyzes and optimizes memory patterns for session data synchronization';

// Internal state tracking
let isInitialized = false;
let initializationError = null;
let openaiClient = null;

/**
 * Initialize memorySync dependencies and state
 * Must be called before any memorySync operations
 */
export function initMemorySync() {
  try {
    if (isInitialized) {
      return { success: true, message: 'Already initialized' };
    }

    console.log('[MEMORY-SYNC] Initializing memory synchronization module...');
    
    // Initialize OpenAI client - allow null for environments without API key
    openaiClient = createOpenAIClient();
    
    // In production environments, we may not have an API key but should still initialize
    const hasApiKey = !!process.env.OPENAI_API_KEY;
    if (!openaiClient && !hasApiKey) {
      console.log('[MEMORY-SYNC] ⚠️  No OpenAI API key provided, running in mock mode');
      // Set a placeholder that indicates mock mode
      openaiClient = null;
    } else if (!openaiClient) {
      throw new Error('Failed to initialize OpenAI client for memorySync');
    }

    // Validate environment variables
    const requiredEnvVars = ['NODE_ENV'];
    for (const envVar of requiredEnvVars) {
      if (!process.env[envVar]) {
        console.warn(`[MEMORY-SYNC] Warning: ${envVar} not set, using defaults`);
      }
    }

    // Mark as initialized
    isInitialized = true;
    initializationError = null;
    
    const mode = hasApiKey ? 'AI-enabled' : 'mock';
    console.log(`[MEMORY-SYNC] ✅ Memory synchronization module initialized successfully (${mode} mode)`);
    return { 
      success: true, 
      message: `Memory sync initialized successfully in ${mode} mode`,
      mode,
      hasApiKey,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    initializationError = error;
    isInitialized = false;
    console.error('[MEMORY-SYNC] ❌ Failed to initialize memory sync:', error.message);
    
    return { 
      success: false, 
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * Check if memorySync is properly initialized
 */
export function isMemorySyncInitialized() {
  return isInitialized;
}

/**
 * Get initialization status and error if any
 */
export function getMemorySyncStatus() {
  return {
    initialized: isInitialized,
    error: initializationError?.message || null,
    timestamp: new Date().toISOString()
  };
}

export async function run(input, tools) {
  try {
    // Ensure memorySync is initialized before proceeding
    if (!isInitialized) {
      console.log('[MEMORY-SYNC] Worker not initialized, attempting initialization...');
      const initResult = initMemorySync();
      if (!initResult.success) {
        throw new Error(`MemorySync initialization failed: ${initResult.error}`);
      }
    }

    // Use the pre-initialized client or create a new one as fallback
    const openai = openaiClient || createOpenAIClient();
    
    // Handle mock mode when no API key is available
    if (!openai) {
      console.log('[MEMORY-SYNC] Running in mock mode (no OpenAI API key)');
      return { 
        success: true, 
        result: 'MOCK: Memory synchronization analysis completed. System operating in development mode without AI integration.',
        timestamp: new Date().toISOString(),
        worker: id,
        initialized: isInitialized,
        mode: 'mock'
      };
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
      worker: id,
      initialized: isInitialized,
      mode: 'ai-enabled'
    };
  } catch (error) {
    throw new Error(`Memory sync failed: ${error.message}`);
  }
}