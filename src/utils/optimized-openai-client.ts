/**
 * Optimized OpenAI Client Factory
 * Provides a centralized way to create optimized OpenAI clients
 * Reduces duplication and ensures consistent optimization across the codebase
 */

import { getUnifiedOpenAI } from '../services/unified-openai.js';
import { ClarkeHandler } from '../services/clarke-handler.js';
import { createServiceLogger } from './logger.js';

const logger = createServiceLogger('OptimizedOpenAIClient');

// Client reuse cache to prevent duplicate instantiations
const clientCache = new Map<string, any>();

export interface OptimizedClientOptions {
  useUnifiedService?: boolean;
  useClarkeHandler?: boolean;
  enableResilience?: boolean;
  enableOptimizations?: boolean;
  cacheKey?: string;
}

/**
 * Get optimized OpenAI client instance with caching and best practices
 */
export function getOptimizedOpenAIClient(options: OptimizedClientOptions = {}) {
  const {
    useUnifiedService = true,
    useClarkeHandler = false,
    enableResilience = true,
    enableOptimizations = true,
    cacheKey = 'default'
  } = options;

  // Check cache first
  if (clientCache.has(cacheKey)) {
    logger.debug('Returning cached OpenAI client', { cacheKey });
    return clientCache.get(cacheKey);
  }

  let client: any;

  if (useClarkeHandler) {
    // Use ClarkeHandler for enhanced resilience
    client = new ClarkeHandler({
      apiKey: process.env.OPENAI_API_KEY,
      ...process.env
    });

    if (enableResilience) {
      client.initialzeResilience({
        retries: 3,
        backoffMultiplier: 2,
        maxBackoffMs: 30000,
        failsafeEnabled: true,
        rollbackEnabled: true,
        isolatedRollback: true
      });
    }

    logger.info('Created ClarkeHandler client with resilience', { 
      cacheKey, 
      resilience: enableResilience 
    });

  } else if (useUnifiedService) {
    // Use UnifiedOpenAI service for optimization
    client = getUnifiedOpenAI({
      enableConnectionPooling: enableOptimizations,
      enableRequestBatching: false, // Disabled by default to prevent latency
      enableCircuitBreaker: enableResilience,
      adaptiveTimeout: enableOptimizations,
      circuitBreakerThreshold: 5
    });

    logger.info('Created UnifiedOpenAI client with optimizations', { 
      cacheKey, 
      optimizations: enableOptimizations,
      resilience: enableResilience 
    });

  } else {
    // Fallback to basic OpenAI client (not recommended)
    logger.warning('Using basic OpenAI client - consider using optimized options');
    const OpenAI = require('openai');
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  }

  // Cache the client
  clientCache.set(cacheKey, client);

  return client;
}

/**
 * Clear client cache (useful for testing or configuration changes)
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
    useUnifiedService: true,
    enableOptimizations: true,
    enableResilience: true,
    cacheKey: 'high-throughput'
  },

  // For critical operations requiring maximum resilience
  criticalOperations: {
    useClarkeHandler: true,
    enableResilience: true,
    enableOptimizations: false, // Focus on reliability over speed
    cacheKey: 'critical'
  },

  // For development and testing
  development: {
    useUnifiedService: true,
    enableOptimizations: false,
    enableResilience: false,
    cacheKey: 'dev'
  },

  // For production with balanced performance and reliability
  production: {
    useUnifiedService: true,
    enableOptimizations: true,
    enableResilience: true,
    cacheKey: 'production'
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