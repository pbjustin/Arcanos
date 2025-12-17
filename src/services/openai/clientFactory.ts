import OpenAI from 'openai';
import { getRoutingActiveMessage } from '../../config/prompts.js';
import { aiLogger } from '../../utils/structuredLogging.js';
import { responseCache } from '../../utils/cache.js';
import { recordTraceEvent } from '../../utils/telemetry.js';
import {
  getCircuitBreakerSnapshot,
  RESILIENCE_CONSTANTS
} from './resilience.js';
import {
  resolveOpenAIKey,
  resolveOpenAIBaseURL,
  getOpenAIKeySource,
  hasValidAPIKey,
  setDefaultModel,
  getDefaultModel,
  getFallbackModel
} from './credentialProvider.js';

export const API_TIMEOUT_MS = parseInt(process.env.WORKER_API_TIMEOUT_MS || '60000', 10);
export const ARCANOS_ROUTING_MESSAGE = getRoutingActiveMessage();
const ARCANOS_ROUTING_LOG = `${ARCANOS_ROUTING_MESSAGE} - all calls will use configured model by default`;

let openai: OpenAI | null = null;

export const initializeOpenAI = (): OpenAI | null => {
  if (openai) return openai;

  try {
    const apiKey = resolveOpenAIKey();
    if (!apiKey) {
      aiLogger.warn('OpenAI API key not configured - AI endpoints will return mock responses', {
        operation: 'initialization'
      });
      return null;
    }

    const baseURL = resolveOpenAIBaseURL();
    openai = new OpenAI({
      apiKey,
      timeout: API_TIMEOUT_MS,
      ...(baseURL ? { baseURL } : {})
    });

    const configuredDefaultModel =
      process.env.OPENAI_MODEL ||
      process.env.RAILWAY_OPENAI_MODEL ||
      process.env.FINETUNED_MODEL_ID ||
      process.env.FINE_TUNED_MODEL_ID ||
      process.env.AI_MODEL ||
      'gpt-4o';

    setDefaultModel(configuredDefaultModel);

    aiLogger.info('✅ OpenAI client initialized', { module: 'openai.client' });
    aiLogger.info('🧠 Default AI Model configured', { module: 'openai.client', model: configuredDefaultModel });
    aiLogger.info('🔄 Fallback Model configured', { module: 'openai.client', fallbackModel: getFallbackModel() });
    aiLogger.info(`🎯 ${ARCANOS_ROUTING_LOG}`, { module: 'openai.client' });

    return openai;
  } catch (error) {
    aiLogger.error('❌ Failed to initialize OpenAI client', { module: 'openai.client' }, undefined, error as Error);
    return null;
  }
};

export const getOpenAIClient = (): OpenAI | null => {
  return openai || initializeOpenAI();
};

export const validateAPIKeyAtStartup = (): boolean => {
  const apiKey = resolveOpenAIKey();
  if (!apiKey) {
    aiLogger.warn('⚠️ OPENAI_API_KEY not set - will return mock responses', { module: 'openai.client' });
    return true;
  }
  aiLogger.info('✅ OPENAI_API_KEY validation passed', {
    module: 'openai.client',
    source: getOpenAIKeySource()
  });
  return true;
};

export const getOpenAIServiceHealth = () => {
  const circuitBreakerMetrics = getCircuitBreakerSnapshot();
  const cacheStats = responseCache.getStats();
  const configured = hasValidAPIKey();

  return {
    apiKey: {
      configured,
      status: configured ? 'valid' : 'missing_or_invalid',
      source: getOpenAIKeySource()
    },
    client: {
      initialized: openai !== null,
      model: getDefaultModel(),
      timeout: API_TIMEOUT_MS,
      baseURL: resolveOpenAIBaseURL()
    },
    circuitBreaker: {
      ...circuitBreakerMetrics,
      healthy: circuitBreakerMetrics.state !== 'OPEN'
    },
    cache: {
      ...cacheStats,
      enabled: true
    },
    lastHealthCheck: new Date().toISOString(),
    defaults: {
      maxTokens: RESILIENCE_CONSTANTS.DEFAULT_MAX_TOKENS
    }
  };
};

export const resetOpenAIClient = () => {
  openai = null;
  recordTraceEvent('openai.client.reset');
};
