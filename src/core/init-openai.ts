import { getOpenAIAdapter, resetOpenAIAdapter } from "@core/adapters/openai.adapter.js";
import { getConfig } from "@platform/runtime/unifiedConfig.js";
import { Express } from 'express';
import { logger } from "@platform/logging/structuredLogging.js";
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
