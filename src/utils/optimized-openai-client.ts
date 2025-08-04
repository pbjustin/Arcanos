/**
 * Optimized OpenAI Client Factory
 * Simplified version that uses the main openaiClient
 */

import { openaiClient } from './openaiClient.js';
import { createServiceLogger } from './logger.js';

const logger = createServiceLogger('OptimizedOpenAIClient');

// Client cache for different configurations
const clientCache = new Map<string, any>();

export interface OptimizedClientOptions {
  cacheKey?: string;
  enableLogging?: boolean;
}

/**
 * Get optimized OpenAI client instance with caching
 */
export function getOptimizedOpenAIClient(options: OptimizedClientOptions = {}) {
  const {
    cacheKey = 'default',
    enableLogging = true
  } = options;

  // Check cache first
  if (clientCache.has(cacheKey)) {
    if (enableLogging) {
      logger.debug('Returning cached OpenAI client', { cacheKey });
    }
    return clientCache.get(cacheKey);
  }

  // Use the main OpenAI client
  const client = openaiClient;

  // Cache the client
  clientCache.set(cacheKey, client);

  if (enableLogging) {
    logger.info('Created optimized OpenAI client', { cacheKey });
  }

  return client;
}

/**
 * Clear client cache
 */
export function clearClientCache(cacheKey?: string): void {
  if (cacheKey) {
    clientCache.delete(cacheKey);
    logger.info('Cleared specific client cache', { cacheKey });
  } else {
    clientCache.clear();
    logger.info('Cleared all client cache');
  }
}

/**
 * Get cache statistics
 */
export function getClientCacheStats(): {
  cachedClients: number;
  cacheKeys: string[];
} {
  return {
    cachedClients: clientCache.size,
    cacheKeys: Array.from(clientCache.keys())
  };
}

/**
 * Recommended client configurations for different use cases
 */
export const RECOMMENDED_CONFIGS = {
  // For high-throughput operations
  highThroughput: {
    cacheKey: 'high-throughput',
    enableLogging: false
  },

  // For development and testing
  development: {
    cacheKey: 'dev',
    enableLogging: true
  },

  // For production
  production: {
    cacheKey: 'production',
    enableLogging: false
  }
} as const;

/**
 * Helper function to get client with recommended configuration
 */
export function getRecommendedClient(
  scenario: keyof typeof RECOMMENDED_CONFIGS
) {
  return getOptimizedOpenAIClient(RECOMMENDED_CONFIGS[scenario]);
}