/**
 * Legacy OpenAI Client Factory
 * 
 * This module is maintained for backward compatibility.
 * New code should use unifiedClient.ts instead.
 * 
 * @deprecated Use unifiedClient.ts instead
 */

import OpenAI from 'openai';
import {
  getOrCreateClient,
  validateClientHealth,
  resetClient,
  API_TIMEOUT_MS,
  ARCANOS_ROUTING_MESSAGE,
  getDefaultModel,
  getFallbackModel,
  getOpenAIKeySource,
  hasValidAPIKey,
  resolveOpenAIBaseURL
} from './unifiedClient.js';
import { getCircuitBreakerSnapshot, RESILIENCE_CONSTANTS } from './resilience.js';
import { responseCache } from '../../utils/cache.js';

/**
 * @deprecated Use getOrCreateClient from unifiedClient.ts
 */
export const initializeOpenAI = (): OpenAI | null => {
  return getOrCreateClient();
};

/**
 * @deprecated Use getOrCreateClient from unifiedClient.ts
 */
export const getOpenAIClient = (): OpenAI | null => {
  return getOrCreateClient();
};

/**
 * @deprecated Use validateClientHealth from unifiedClient.ts
 */
export const validateAPIKeyAtStartup = (): boolean => {
  const health = validateClientHealth();
  return health.apiKeyConfigured;
};

/**
 * @deprecated Use validateClientHealth from unifiedClient.ts
 */
export const getOpenAIServiceHealth = () => {
  const health = validateClientHealth();
  const circuitBreakerMetrics = getCircuitBreakerSnapshot();
  const cacheStats = responseCache.getStats();

  return {
    apiKey: {
      configured: health.apiKeyConfigured,
      status: health.apiKeyConfigured ? 'valid' : 'missing_or_invalid',
      source: health.apiKeySource
    },
    client: {
      initialized: health.healthy,
      model: health.defaultModel,
      timeout: API_TIMEOUT_MS,
      baseURL: resolveOpenAIBaseURL()
    },
    circuitBreaker: {
      ...circuitBreakerMetrics,
      healthy: health.circuitBreakerHealthy
    },
    cache: {
      ...cacheStats,
      enabled: health.cacheEnabled
    },
    lastHealthCheck: health.lastCheck,
    defaults: {
      maxTokens: RESILIENCE_CONSTANTS.DEFAULT_MAX_TOKENS
    }
  };
};

/**
 * @deprecated Use resetClient from unifiedClient.ts
 */
export const resetOpenAIClient = () => {
  resetClient();
};

// Re-export constants for backward compatibility
export { API_TIMEOUT_MS, ARCANOS_ROUTING_MESSAGE };
