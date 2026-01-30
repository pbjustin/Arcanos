import { getOpenAIAdapter, createOpenAIAdapter } from './adapters/openai.adapter.js';
import config from './config/index.js';
import { Express } from 'express';
import { logger } from './utils/structuredLogging.js';

/**
 * Initializes OpenAI adapter and attaches it to Express app locals.
 * Uses the adapter boundary pattern - all OpenAI SDK access goes through adapter.
 *
 * @param app - Express application instance
 */
export function initOpenAI(app: Express): void {
  try {
    // Initialize adapter with config (no env access in adapter)
    const adapterConfig = {
      apiKey: config.ai.apiKey || '',
      baseURL: undefined, // Can be added to config if needed
      timeout: 60000,
      defaultModel: config.ai.model
    };

    // Only create adapter if API key is available
    if (adapterConfig.apiKey) {
      const adapter = createOpenAIAdapter(adapterConfig);
      app.locals.openaiAdapter = adapter;
      logger.info('OpenAI adapter initialized', {
        module: 'init-openai',
        hasApiKey: true,
        defaultModel: adapterConfig.defaultModel
      });
    } else {
      logger.warn('OpenAI adapter not initialized - API key missing', {
        module: 'init-openai'
      });
      app.locals.openaiAdapter = null;
    }
  } catch (error) {
    logger.error('Failed to initialize OpenAI adapter', {
      module: 'init-openai',
      error: error instanceof Error ? error.message : String(error)
    });
    app.locals.openaiAdapter = null;
  }
}
