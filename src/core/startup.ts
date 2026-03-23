import { config } from "@platform/runtime/config.js";
import { validateEnvironment, printValidationResults, createStartupReport, validateRailwayEnvironment, checkEphemeralFS } from "@platform/runtime/environmentValidation.js";
import { logger } from "@platform/logging/structuredLogging.js";
import { initializeDatabaseWithSchema as initializeDatabase } from "@core/db/index.js";
import { validateAPIKeyAtStartup, getDefaultModel } from "@services/openai.js";
import { verifySchema } from './persistenceManagerHierarchy.js';
import { initializeEnvironmentSecurity, getEnvironmentSecuritySummary } from "@platform/runtime/environmentSecurity.js";
import memoryStore from "@core/memory/store.js";
import { isRailwayApiConfigured, probeRailwayApi } from "@services/railwayClient.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import { verifyIntegrityManifestConfiguration } from "@services/safety/configIntegrity.js";
import { activateUnsafeCondition } from "@services/safety/runtimeState.js";
import { emitSafetyAuditEvent } from "@services/safety/auditEvents.js";
import { hydrateJudgedResponseFeedbackContext } from "@services/judgedResponseFeedback.js";
import { getQueryFinetuneAttemptLatencyBudgetDiagnostics } from "@config/queryFinetune.js";
import { getGptRegistrySnapshot } from '@platform/runtime/gptRouterConfig.js';

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
    } else {
      try {
        const hydratedEntries = await hydrateJudgedResponseFeedbackContext();
        //audit Assumption: judged feedback hydration is best-effort and should not block startup; risk: missing historical context after restart; invariant: startup continues even when hydration fails; handling: informational logging with fallback catch below.
        logger.info('🧠 Reinforcement judged feedback hydrated', { hydratedEntries });
      } catch (hydrationError: unknown) {
        logger.warn('⚠️ Reinforcement judged feedback hydration failed - continuing without persisted judgment context', {
          error: resolveErrorMessage(hydrationError)
        });
      }
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
  const gptRegistrySnapshot = await getGptRegistrySnapshot();

  logger.info('gpt.registry.startup', {
    registeredGptCount: gptRegistrySnapshot.validation.registeredGptCount,
    registeredGptIds: gptRegistrySnapshot.validation.registeredGptIds,
    requiredGptIds: gptRegistrySnapshot.validation.requiredGptIds,
    missingGptIds: gptRegistrySnapshot.validation.missingGptIds
  });

  //audit Assumption: missing required GPT IDs means the primary request path is broken and should not accept traffic; failure risk: backend starts "healthy" but 404s canonical GPT routes; expected invariant: required GPT bindings exist before listen; handling strategy: fail startup immediately.
  if (gptRegistrySnapshot.validation.missingGptIds.length > 0) {
    throw new Error(
      `Required GPT registrations missing at startup: ${gptRegistrySnapshot.validation.missingGptIds.join(', ')}`
    );
  }

  const queryFinetuneAttemptLatencyBudgetDiagnostics =
    getQueryFinetuneAttemptLatencyBudgetDiagnostics();

  logger.info(`🧠 ARCANOS AI - Default Model: ${getDefaultModel()}`);
  logger.info(`🔄 ARCANOS AI - Fallback Model: ${config.ai.fallbackModel}`);
  logger.info('🕒 ARCANOS QUERY-FINETUNE - Attempt latency budget', {
    queryFinetuneAttemptLatencyBudgetMs: queryFinetuneAttemptLatencyBudgetDiagnostics.resolvedValueMs,
    envName: queryFinetuneAttemptLatencyBudgetDiagnostics.envName,
    source: queryFinetuneAttemptLatencyBudgetDiagnostics.source,
    configuredValue: queryFinetuneAttemptLatencyBudgetDiagnostics.configuredValue,
    defaultValueMs: queryFinetuneAttemptLatencyBudgetDiagnostics.defaultValueMs,
    usedFallbackDefault: queryFinetuneAttemptLatencyBudgetDiagnostics.usedFallbackDefault
  });
  logger.info('✅ ARCANOS CONFIG - Configuration validation complete');
}
