/**
 * Unified OpenAI Client Wrapper
 * 
 * Provides consistent client initialization, credential resolution, and health checks
 * following OpenAI SDK best practices and Railway-native patterns.
 * 
 * Features:
 * - Railway-first credential resolution with fallbacks
 * - Stateless, deterministic initialization
 * - Health check capabilities
 * - Type-safe model selection
 * - Audit trail for all operations
 * 
 * @module unifiedClient
 */

import OpenAI from 'openai';
import { aiLogger } from '../../utils/structuredLogging.js';
import { recordTraceEvent } from '../../utils/telemetry.js';
import {
  resolveOpenAIKey,
  resolveOpenAIBaseURL,
  getOpenAIKeySource,
  hasValidAPIKey,
  setDefaultModel,
  getDefaultModel,
  getFallbackModel,
  getGPT5Model,
  getComplexModel
} from './credentialProvider.js';
import {
  getCircuitBreakerSnapshot,
  RESILIENCE_CONSTANTS
} from './resilience.js';
import { responseCache } from '../../utils/cache.js';
import { getRoutingActiveMessage } from '../../config/prompts.js';
import { getConfig } from '../../config/unifiedConfig.js';
import { APPLICATION_CONSTANTS } from '../../utils/constants.js';
import { resolveErrorMessage } from '../../lib/errors/index.js';

/**
 * Client initialization options
 */
export interface ClientOptions {
  /** API key override (defaults to environment resolution) */
  apiKey?: string;
  /** Base URL override (defaults to environment resolution) */
  baseURL?: string;
  /** Timeout in milliseconds (defaults to WORKER_API_TIMEOUT_MS or 60000) */
  timeout?: number;
  /** Whether to use singleton pattern (default: true) */
  singleton?: boolean;
}

/**
 * Health status for OpenAI client
 */
export interface HealthStatus {
  /** Whether client is initialized and healthy */
  healthy: boolean;
  /** Whether API key is configured */
  apiKeyConfigured: boolean;
  /** Source of API key */
  apiKeySource: string | null;
  /** Default model configured */
  defaultModel: string;
  /** Fallback model configured */
  fallbackModel: string;
  /** Circuit breaker state */
  circuitBreakerHealthy: boolean;
  /** Cache statistics */
  cacheEnabled: boolean;
  /** Last health check timestamp */
  lastCheck: string;
  /** Error message if unhealthy */
  error?: string;
}

/**
 * Singleton client instance
 */
let singletonClient: OpenAI | null = null;
let initializationAttempted = false;

/**
 * API timeout from config or default
 */
export const API_TIMEOUT_MS = (() => {
  const config = getConfig();
  return config.workerApiTimeoutMs;
})();

/**
 * ARCANOS routing message for all completions
 */
export const ARCANOS_ROUTING_MESSAGE = getRoutingActiveMessage();

/**
 * Creates a new OpenAI client with Railway-native credential resolution
 * 
 * This function follows Railway best practices:
 * - Stateless initialization (no local state dependencies)
 * - Environment variable resolution with Railway fallbacks
 * - Deterministic behavior (same inputs = same outputs)
 * - Comprehensive error handling and logging
 * 
 * @param options - Client initialization options
 * @returns OpenAI client instance or null if initialization fails
 */
export function createOpenAIClient(options: ClientOptions = {}): OpenAI | null {
  const startTime = Date.now();
  const traceId = recordTraceEvent('openai.client.create.start', {
    hasApiKeyOverride: Boolean(options.apiKey),
    hasBaseURLOverride: Boolean(options.baseURL),
    timeout: options.timeout || API_TIMEOUT_MS
  });

  try {
    // Resolve API key with Railway fallbacks
    const apiKey = options.apiKey || resolveOpenAIKey();
    
    //audit Assumption: missing API key means OpenAI calls must be mocked; risk: real calls without key fail; invariant: return null without key; handling: log and short-circuit.
    if (!apiKey) {
      aiLogger.warn('OpenAI API key not configured - AI endpoints will return mock responses', {
        operation: 'createOpenAIClient',
        module: 'openai.unified'
      });
      recordTraceEvent('openai.client.create.no_key', { traceId });
      return null;
    }

    // Resolve base URL with Railway fallbacks
    const baseURL = options.baseURL || resolveOpenAIBaseURL();
    const timeout = options.timeout || API_TIMEOUT_MS;
    const config = getConfig();

    // Create client instance
    const client = new OpenAI({
      apiKey,
      timeout,
      maxRetries: config.openaiMaxRetries,
      ...(baseURL ? { baseURL } : {})
    });

    // Configure default model from config (adapter boundary pattern)
    const configuredDefaultModel = config.defaultModel || APPLICATION_CONSTANTS.MODEL_GPT_4O_MINI;
    setDefaultModel(configuredDefaultModel);

    const duration = Date.now() - startTime;
    aiLogger.info('✅ OpenAI client created', {
      module: 'openai.unified',
      operation: 'createOpenAIClient',
      duration,
      model: configuredDefaultModel,
      source: getOpenAIKeySource()
    });

    recordTraceEvent('openai.client.create.success', {
      traceId,
      duration,
      model: configuredDefaultModel
    });

    return client;
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = resolveErrorMessage(error);
    
    aiLogger.error('❌ Failed to create OpenAI client', {
      module: 'openai.unified',
      operation: 'createOpenAIClient',
      duration
    }, undefined, error as Error);

    recordTraceEvent('openai.client.create.error', {
      traceId,
      duration,
      error: errorMessage
    });

    return null;
  }
}

/**
 * Gets or creates the singleton OpenAI client
 * 
 * Uses singleton pattern for consistent client reuse across the application.
 * Initializes on first call with Railway-native credential resolution.
 * 
 * @returns OpenAI client instance or null if initialization fails
 */
export function getOrCreateClient(): OpenAI | null {
  if (singletonClient) {
    return singletonClient;
  }

  // If we previously failed (no key) but a key is now available, allow one retry (e.g. env loaded late or set in platform)
  if (initializationAttempted && hasValidAPIKey()) {
    aiLogger.info('OpenAI API key now available - retrying client creation', {
      module: 'openai.unified',
      operation: 'getOrCreateClient'
    });
    initializationAttempted = false;
    singletonClient = null;
  }

  if (initializationAttempted) {
    aiLogger.warn('OpenAI client initialization already attempted, returning null', {
      module: 'openai.unified',
      operation: 'getOrCreateClient'
    });
    return null;
  }

  initializationAttempted = true;
  singletonClient = createOpenAIClient({ singleton: true });

  return singletonClient;
}

/**
 * Validates OpenAI client health
 * 
 * Performs comprehensive health check including:
 * - API key configuration
 * - Client initialization status
 * - Circuit breaker state
 * - Cache status
 * 
 * @returns Health status object
 */
export function validateClientHealth(): HealthStatus {
  const circuitBreakerMetrics = getCircuitBreakerSnapshot();
  const configured = hasValidAPIKey();
  const initialized = singletonClient !== null;

  const health: HealthStatus = {
    healthy: configured && initialized && circuitBreakerMetrics.state !== 'OPEN',
    apiKeyConfigured: configured,
    apiKeySource: getOpenAIKeySource(),
    defaultModel: getDefaultModel(),
    fallbackModel: getFallbackModel(),
    circuitBreakerHealthy: circuitBreakerMetrics.state !== 'OPEN',
    cacheEnabled: true,
    lastCheck: new Date().toISOString()
  };

  if (!health.healthy) {
    if (!configured) {
      health.error = 'API key not configured';
    } else if (!initialized) {
      health.error = 'Client not initialized';
    } else if (!health.circuitBreakerHealthy) {
      health.error = 'Circuit breaker is OPEN';
    }
  }

  return health;
}

/**
 * Resets the singleton client
 * 
 * Useful for testing or when credentials change.
 * Clears singleton instance and allows re-initialization.
 */
export function resetClient(): void {
  singletonClient = null;
  initializationAttempted = false;
  recordTraceEvent('openai.client.reset', {
    module: 'openai.unified'
  });
  aiLogger.info('OpenAI client reset', {
    module: 'openai.unified',
    operation: 'resetClient'
  });
}

/**
 * Gets the current singleton client without creating a new one
 * 
 * @returns Current singleton client or null if not initialized
 */
export function getClient(): OpenAI | null {
  return singletonClient;
}

/**
 * Exports for backward compatibility with existing code
 */
export {
  getDefaultModel,
  getFallbackModel,
  getComplexModel,
  getGPT5Model,
  hasValidAPIKey,
  getOpenAIKeySource,
  resolveOpenAIKey,
  resolveOpenAIBaseURL
};

/**
 * Default export for convenience
 */
export default {
  createOpenAIClient,
  getOrCreateClient,
  getClient,
  validateClientHealth,
  resetClient,
  getDefaultModel,
  getFallbackModel,
  getComplexModel,
  getGPT5Model,
  hasValidAPIKey,
  API_TIMEOUT_MS,
  ARCANOS_ROUTING_MESSAGE
};
