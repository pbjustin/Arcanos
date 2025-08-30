import config from './config/index.js';
import { validateEnvironment, printValidationResults, createStartupReport } from './utils/environmentValidation.js';
import { logger } from './utils/structuredLogging.js';
import { initializeDatabase } from './db.js';
import { validateAPIKeyAtStartup, getDefaultModel } from './services/openai.js';
import { verifySchema } from './persistenceManagerHierarchy.js';

/**
 * Runs startup checks including environment validation, database init,
 * OpenAI key validation, and schema verification.
 */
export async function performStartup(): Promise<void> {
  console.log(createStartupReport());

  const envValidation = validateEnvironment();
  printValidationResults(envValidation);

  if (!envValidation.isValid) {
    logger.error('Environment validation failed - exiting');
    process.exit(1);
  }

  logger.info('🔥 ARCANOS STARTUP - Server boot sequence triggered');
  logger.info('🔧 ARCANOS CONFIG - Validating configuration...');

  try {
    const dbConnected = await initializeDatabase('server');
    if (!dbConnected) {
      logger.warn('⚠️ DB CHECK - Database not available - continuing with in-memory fallback');
    }
  } catch (err: any) {
    logger.error('❌ DB CHECK - Database initialization failed', { error: err?.message || err });
    logger.warn('⚠️ DB CHECK - Continuing with in-memory fallback');
  }

  validateAPIKeyAtStartup(); // Always continue, but log warnings
  await verifySchema();

  logger.info(`🧠 ARCANOS AI - Default Model: ${getDefaultModel()}`);
  logger.info(`🔄 ARCANOS AI - Fallback Model: ${config.ai.fallbackModel}`);
  logger.info('✅ ARCANOS CONFIG - Configuration validation complete');
}
