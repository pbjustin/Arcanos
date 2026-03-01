import { configureUnifiedClient } from '@arcanos/openai/unifiedClient';

import {
  createOpenAIAdapter,
  getOpenAIAdapter,
  isOpenAIAdapterInitialized,
  resetOpenAIAdapter
} from "@core/adapters/openai.adapter.js";
import { getConfig } from "@platform/runtime/unifiedConfig.js";
import { Express } from 'express';
import { aiLogger, logger } from "@platform/logging/structuredLogging.js";
import { recordTraceEvent } from "@platform/logging/telemetry.js";
import { getRoutingActiveMessage } from "@platform/runtime/prompts.js";
import {
  resolveOpenAIKey,
  resolveOpenAIBaseURL,
  getOpenAIKeySource,
  hasValidAPIKey,
  setDefaultModel,
  getDefaultModel,
  getFallbackModel
} from "@services/openai/credentialProvider.js";
import { getCircuitBreakerSnapshot } from "@services/openai/resilience.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";

/**
 * Initializes OpenAI adapter and attaches it to Express app locals.
 * Uses unified config so OPENAI_API_KEY, RAILWAY_OPENAI_API_KEY, API_KEY, OPENAI_KEY are all respected.
 * Also sets the module singleton so getOpenAIAdapter() (no args) returns the same instance.
 *
 * @param app - Express application instance
 */
export function initOpenAI(app: Express): void {
  function clearAdapter(): void {
    resetOpenAIAdapter();
    app.locals.openaiAdapter = null;
  }

  try {
    // Wire the process-wide unified client early so all downstream consumers
    // importing from `@arcanos/openai/unifiedClient` share the same instance.
    configureUnifiedClient({
      resolveApiKey: resolveOpenAIKey,
      resolveBaseURL: resolveOpenAIBaseURL,
      getApiKeySource: getOpenAIKeySource,
      hasValidAPIKey,
      setDefaultModel,
      getDefaultModel,
      getFallbackModel,

      getTimeoutMs: () => getConfig().workerApiTimeoutMs,
      getMaxRetries: () => getConfig().openaiMaxRetries,
      getConfiguredDefaultModel: () => getConfig().defaultModel,

      // Adapter boundary integration (backend canonical path)
      createAdapter: (config) => createOpenAIAdapter(config as any) as any,
      getAdapter: (config) => getOpenAIAdapter(config as any) as any,
      isAdapterInitialized: isOpenAIAdapterInitialized,
      resetAdapter: resetOpenAIAdapter,

      getRoutingMessage: getRoutingActiveMessage,
      getCircuitBreakerSnapshot: getCircuitBreakerSnapshot as any,
      isCacheEnabled: () => true,

      trace: (event, data) => recordTraceEvent(event, data as any),
      logger: {
        info: (message, meta) => aiLogger.info(message, meta as any),
        warn: (message, meta) => aiLogger.warn(message, meta as any),
        error: (message, meta, error) => aiLogger.error(message, meta as any, undefined, error)
      },
      resolveErrorMessage
    });

    const unified = getConfig();
    const apiKey = unified.openaiApiKey?.trim() || '';

    //audit Assumption: valid API key enables adapter initialization; risk: missing key leads to mock responses; invariant: adapter only created when key is non-empty; handling: guard and log.
    if (apiKey) {
      const adapterConfig = {
        apiKey,
        baseURL: unified.openaiBaseUrl,
        timeout: unified.workerApiTimeoutMs,
        maxRetries: unified.openaiMaxRetries,
        defaultModel: unified.defaultModel
      };
      const adapter = getOpenAIAdapter(adapterConfig);
      app.locals.openaiAdapter = adapter;
      logger.info('OpenAI adapter initialized', {
        module: 'init-openai',
        hasApiKey: true,
        defaultModel: adapterConfig.defaultModel
      });
    } else {
      clearAdapter();
      logger.warn('OpenAI adapter not initialized - API key missing', {
        module: 'init-openai'
      });
    }
  } catch (error) {
    logger.error('Failed to initialize OpenAI adapter', {
      module: 'init-openai',
      error: resolveErrorMessage(error)
    });
    clearAdapter();
  }
}
