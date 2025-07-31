import { installNLPInterpreter } from './modules/nlp-interpreter';
import { installPagedOutputHandler } from './modules/paged-output-handler';
import { installMemoryAuditStreamSerializer } from './modules/memory-audit-stream-serializer';
import { createServiceLogger } from './utils/logger';

export interface BackendInitializationOptions {
  environment?: string;
  modules?: string[];
  integrations?: Record<string, any>;
  audit?: Record<string, any>;
  config?: Record<string, any>;
  memory?: Record<string, any>;
}

const logger = createServiceLogger('BackendInit');

export function initializeBackend(options: BackendInitializationOptions): void {
  // Set environment
  if (options.environment) {
    process.env.NODE_ENV = options.environment;
    logger.info(`Environment set to ${options.environment}`);
  }

  const modules = options.modules || [];
  if (modules.includes('nlp-interpreter')) {
    installNLPInterpreter({ enablePromptTranslation: true });
    logger.success('NLP interpreter initialized');
  }
  if (modules.includes('paged-output-handler')) {
    installPagedOutputHandler({ maxPayloadSize: options.config?.maxPayload || 2048 });
    logger.success('Paged output handler initialized');
  }
  if (modules.includes('memory-audit-stream-serializer')) {
    installMemoryAuditStreamSerializer({
      streamChunks: true,
      maxChunkSize: 2048,
      useContinuationTokens: true,
    });
    logger.success('Memory audit stream serializer initialized');
  }

  // Placeholder handlers for other modules
  ['dispatcher-core', 'audit-router', 'commit-logger'].forEach((name) => {
    if (modules.includes(name)) {
      logger.info(`Module ${name} requested but no implementation found`);
    }
  });

  logger.info('Backend initialization complete');
}
