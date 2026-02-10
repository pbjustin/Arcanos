import config from './config/index.js';
import { validateEnvironment, printValidationResults, createStartupReport, validateRailwayEnvironment, checkEphemeralFS } from './utils/environmentValidation.js';
import { logger } from './utils/structuredLogging.js';
import { initializeDatabaseWithSchema as initializeDatabase } from './db/index.js';
import { validateAPIKeyAtStartup, getDefaultModel } from './services/openai.js';
import { verifySchema } from './persistenceManagerHierarchy.js';
import { initializeEnvironmentSecurity, getEnvironmentSecuritySummary } from './utils/environmentSecurity.js';
import memoryStore from './memory/store.js';
import { isRailwayApiConfigured, probeRailwayApi } from './services/railwayClient.js';
import { resolveErrorMessage } from './lib/errors/index.js';
import { verifyIntegrityManifestConfiguration } from './services/safety/configIntegrity.js';
import { activateUnsafeCondition } from './services/safety/runtimeState.js';
import { emitSafetyAuditEvent } from './services/safety/auditEvents.js';

/**
 * Runs startup checks including environment validation, database init,
 * OpenAI key validation, and schema verification.
 */
export async function performStartup(): Promise<void> {
  // Railway-specific environment validation
  const railwayValidation = validateRailwayEnvironment();
  printValidationResults(railwayValidation);
  checkEphemeralFS();

  //audit Assumption: Railway API config controls probe behavior
  if (isRailwayApiConfigured()) {
    const probeResult = await probeRailwayApi();
    if (!probeResult.ok) {
      logger.warn('⚠️ Railway management API probe failed - deployment automation features may be unavailable');
    }
  } else {
    logger.info('Railway management API token not detected - skipping management API connectivity probe');
  }

  const securityState = await initializeEnvironmentSecurity();
  logger.info('ARCANOS environment security', {
    trusted: securityState.isTrusted,
    safeMode: securityState.safeMode,
    issues: securityState.issues,
    policy: securityState.policyApplied
  });
  console.log(createStartupReport(getEnvironmentSecuritySummary()));

  const envValidation = validateEnvironment();
  printValidationResults(envValidation);

  //audit Assumption: invalid env should halt startup
  if (!envValidation.isValid) {
    logger.error('Environment validation failed - exiting');
    process.exit(1);
  }

  logger.info('🔥 ARCANOS STARTUP - Server boot sequence triggered');
  logger.info('🔧 ARCANOS CONFIG - Validating configuration...');

  try {
    verifyIntegrityManifestConfiguration();
  } catch (error) {
    //audit Assumption: integrity manifest misconfiguration should block mutating execution but keep observability online; risk: unsafe writes continue; invariant: unsafe state activated; handling: activate condition + continue startup in fail-safe mode.
    const message = resolveErrorMessage(error);
    activateUnsafeCondition({
      code: 'PATTERN_INTEGRITY_FAILURE',
      message: 'Integrity manifest preflight failed',
      metadata: { message }
    });
    emitSafetyAuditEvent({
      event: 'startup_integrity_preflight_failed',
      severity: 'error',
      details: { message }
    });
    logger.error('Integrity preflight failed; mutating APIs will be blocked', {
      module: 'startup',
      message
    });
  }

  try {
    const dbConnected = await initializeDatabase('server');
    if (!dbConnected) {
      logger.warn('⚠️ DB CHECK - Database not available - continuing with in-memory fallback');
    }
  } catch (err: unknown) {
    //audit Assumption: DB init errors should log and fallback
    const errorMessage = resolveErrorMessage(err);
    logger.error('❌ DB CHECK - Database initialization failed', { error: errorMessage });
    logger.warn('⚠️ DB CHECK - Continuing with in-memory fallback');
  }

  await memoryStore.initialize();

  validateAPIKeyAtStartup(); // Always continue, but log warnings
  await verifySchema();

  logger.info(`🧠 ARCANOS AI - Default Model: ${getDefaultModel()}`);
  logger.info(`🔄 ARCANOS AI - Fallback Model: ${config.ai.fallbackModel}`);
  logger.info('✅ ARCANOS CONFIG - Configuration validation complete');
}
