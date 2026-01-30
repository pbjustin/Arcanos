import { getOpenAIAdapter, resetOpenAIAdapter } from './adapters/openai.adapter.js';
import { getConfig } from './config/unifiedConfig.js';
import { Express } from 'express';
import { logger } from './utils/structuredLogging.js';

/**
 * Initializes OpenAI adapter and attaches it to Express app locals.
 * Uses unified config so OPENAI_API_KEY, RAILWAY_OPENAI_API_KEY, API_KEY, OPENAI_KEY are all respected.
 * Also sets the module singleton so getOpenAIAdapter() (no args) returns the same instance.
 *
 * @param app - Express application instance
 */
export function initOpenAI(app: Express): void {
  try {
    const unified = getConfig();
    const apiKey = unified.openaiApiKey?.trim() || '';

    if (apiKey) {
      const adapterConfig = {
        apiKey,
        baseURL: unified.openaiBaseUrl,
        timeout: 60000,
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
      resetOpenAIAdapter();
      app.locals.openaiAdapter = null;
      logger.warn('OpenAI adapter not initialized - API key missing', {
        module: 'init-openai'
      });
    }
  } catch (error) {
    logger.error('Failed to initialize OpenAI adapter', {
      module: 'init-openai',
      error: error instanceof Error ? error.message : String(error)
    });
    resetOpenAIAdapter();
    app.locals.openaiAdapter = null;
  }
}
