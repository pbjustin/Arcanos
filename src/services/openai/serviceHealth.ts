import { responseCache } from '../../utils/cache.js';
import { isOpenAIAdapterInitialized } from '../../adapters/openai.adapter.js';
import { RESILIENCE_CONSTANTS, getCircuitBreakerSnapshot } from './resilience.js';
import {
  API_TIMEOUT_MS,
  resolveOpenAIBaseURL,
  validateClientHealth
} from './unifiedClient.js';

// Legacy export for backward compatibility
export function getOpenAIServiceHealth() {
  const health = validateClientHealth();
  const circuitBreakerMetrics = getCircuitBreakerSnapshot();
  const cacheStats = responseCache.getStats();

  // Health reads from unified client singleton; init-openai sets only the adapter. Treat adapter as source of truth for "initialized" so AI readiness matches actual request path.
  const adapterInitialized = isOpenAIAdapterInitialized();
  const effectiveInitialized = health.healthy || adapterInitialized;
  const effectiveApiKeyConfigured = health.apiKeyConfigured || adapterInitialized;

  const result = {
    apiKey: {
      configured: effectiveApiKeyConfigured,
      status: effectiveApiKeyConfigured ? 'valid' : 'missing_or_invalid',
      source: health.apiKeySource
    },
    client: {
      initialized: effectiveInitialized,
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
  return result;
}

// Legacy export for backward compatibility
export function validateAPIKeyAtStartup(): boolean {
  const health = validateClientHealth();
  return health.apiKeyConfigured;
}
