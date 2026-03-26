/**
 * Unified Configuration Module
 * 
 * Centralizes configuration resolution with Railway fallbacks and type-safe access.
 * Follows Railway-native patterns: stateless, deterministic, environment-variable-based.
 * 
 * Features:
 * - Railway-first credential resolution with fallbacks
 * - Type-safe config access
 * - Configuration validation at startup
 * - Support for different environments (dev, staging, production)
 * - Audit trail for configuration access
 * 
 * @module unifiedConfig
 */

import { APPLICATION_CONSTANTS } from "@shared/constants.js";
import { getEnv, getEnvNumber, getEnvBoolean } from "@platform/runtime/env.js";
import { aiLogger } from "@platform/logging/structuredLogging.js";
import { recordTraceEvent } from "@platform/logging/telemetry.js";
import path from "path";

/**
 * Application configuration interface
 */
export interface AppConfig {
  // Server Configuration
  nodeEnv: string;
  port: number;
  isDevelopment: boolean;
  isProduction: boolean;
  isTest: boolean;
  isRailway: boolean;

  // OpenAI Configuration
  openaiApiKey: string | undefined;
  openaiBaseUrl: string | undefined;
  defaultModel: string;
  fallbackModel: string;
  gpt5Model: string;
  gpt51Model: string;
  openaiMaxRetries: number;

  // Database Configuration
  databaseUrl: string | undefined;
  pgHost: string;

  // Worker Configuration
  runWorkers: boolean;
  workerApiTimeoutMs: number;

  // Logging Configuration
  logPath: string;
  memoryPath: string;
  logLevel: string;

  // Security Configuration
  adminKey: string | undefined;
  registerKey: string | undefined;

  // Feature Flags
  enableGithubActions: boolean;
  enableGptUserHandler: boolean;
  enableActionPlans: boolean;
  enableClear2: boolean;
  migrationDryRun: boolean;

  // Railway Configuration
  railwayEnvironment: string | undefined;
  railwayProjectId: string | undefined;

  // Self-Improve Loop Configuration
  selfImproveEnabled: boolean;
  selfImproveEnvironment: 'development' | 'staging' | 'production';
  selfImproveAutonomyLevel: number; // 0..3
  selfImproveFrozen: boolean;
  selfImproveEvidenceDir: string;
  selfImproveRetentionDays: number;
  selfImprovePiiScrubEnabled: boolean;
  selfImproveActuatorMode: 'pr_bot' | 'daemon';

  // Predictive Self-Healing Configuration
  predictiveHealingEnabled: boolean;
  predictiveHealingDryRun: boolean;
  autoExecuteHealing: boolean;
  predictiveHealingWindowMs: number;
  predictiveHealingMinObservations: number;
  predictiveHealingStaleAfterMs: number;
  predictiveHealingMinConfidence: number;
  predictiveHealingActionCooldownMs: number;
  predictiveHealingObservationHistoryLimit: number;
  predictiveHealingAuditHistoryLimit: number;
  predictiveErrorRateThreshold: number;
  predictiveLatencyConsecutiveIntervals: number;
  predictiveLatencyRiseDeltaMs: number;
  predictiveMemoryThresholdMb: number;
  predictiveMemoryGrowthThresholdMb: number;
  predictiveMemorySustainedIntervals: number;
  predictiveQueuePendingThreshold: number;
  predictiveQueueVelocityThreshold: number;
  predictiveScaleUpStep: number;
  predictiveScaleUpMaxExtraWorkers: number;

}

/**
 * Configuration validation result
 */
export interface ValidationResult {
  /** Whether configuration is valid */
  valid: boolean;
  /** Validation errors */
  errors: string[];
  /** Validation warnings */
  warnings: string[];
}

export interface WorkerRuntimeModeResolution {
  requestedRunWorkers: boolean;
  resolvedRunWorkers: boolean;
  processKind: 'web' | 'worker' | 'unknown';
  railwayServiceName: string | null;
  dedicatedWorkerServiceDetected: boolean;
  webServiceWorkersOverride: boolean;
  reason:
    | 'requested'
    | 'process_kind_web'
    | 'process_kind_worker'
    | 'railway_web_service'
    | 'railway_dedicated_worker_service';
}

function parseSelfImproveEnvironment(raw: string | undefined): AppConfig['selfImproveEnvironment'] {
  const normalized = (raw || '').trim().toLowerCase();
  if (normalized === 'production' || normalized === 'staging' || normalized === 'development') {
    return normalized;
  }
  return 'development';
}

function parseSelfImproveActuatorMode(raw: string | undefined): AppConfig['selfImproveActuatorMode'] {
  const normalized = (raw || '').trim().toLowerCase();
  if (normalized === 'daemon' || normalized === 'pr_bot') {
    return normalized;
  }
  return 'pr_bot';
}

/**
 * Resolves environment variable with Railway fallbacks
 * 
 * Checks multiple environment variable names in priority order:
 * 1. Primary variable name
 * 2. Railway-prefixed variable name
 * 3. Fallback variable names (if provided)
 * 
 * This ensures Railway-native configuration resolution.
 * 
 * @param key - Primary environment variable name
 * @param fallbacks - Fallback environment variable names (in priority order)
 * @returns Resolved value or undefined if not found
 */
export function getEnvVar(key: string, fallbacks?: string[]): string | undefined {
  // Use env module for consistency (adapter boundary pattern)
  // Check primary key
  const primaryValue = getEnv(key);
  if (primaryValue && primaryValue.trim().length > 0) {
    return primaryValue.trim();
  }

  // Check Railway-prefixed key
  const railwayKey = `RAILWAY_${key}`;
  const railwayValue = getEnv(railwayKey);
  if (railwayValue && railwayValue.trim().length > 0) {
    return railwayValue.trim();
  }

  // Check fallback keys
  if (fallbacks && fallbacks.length > 0) {
    for (const fallback of fallbacks) {
      const fallbackValue = getEnv(fallback);
      if (fallbackValue && fallbackValue.trim().length > 0) {
        return fallbackValue.trim();
      }
    }
  }

  return undefined;
}

/**
 * Checks if running in Railway environment
 * 
 * @returns True if running on Railway
 */
export function isRailwayEnvironment(): boolean {
  // Use env module for consistency (adapter boundary pattern)
  return Boolean(
    getEnv('RAILWAY_ENVIRONMENT') ||
    getEnv('RAILWAY_PROJECT_ID') ||
    getEnv('RAILWAY_SERVICE_NAME')
  );
}

function normalizeProcessKind(raw: string | undefined): WorkerRuntimeModeResolution['processKind'] {
  const normalized = (raw || '').trim().toLowerCase();
  if (normalized === 'web' || normalized === 'worker') {
    return normalized;
  }

  return 'unknown';
}

function hasDedicatedRailwayWorkerService(): boolean {
  return Object.entries(process.env).some(([key, value]) => {
    if (!/^RAILWAY_SERVICE_.*WORKER.*_URL$/u.test(key)) {
      return false;
    }

    return typeof value === 'string' && value.trim().length > 0;
  });
}

export function resolveWorkerRuntimeMode(): WorkerRuntimeModeResolution {
  const requestedRunWorkers = getEnvBoolean('RUN_WORKERS', getEnv('NODE_ENV') !== 'test');
  const processKind = normalizeProcessKind(getEnv('ARCANOS_PROCESS_KIND'));
  const railwayServiceName = getEnv('RAILWAY_SERVICE_NAME')?.trim() || null;
  const dedicatedWorkerServiceDetected = isRailwayEnvironment() && hasDedicatedRailwayWorkerService();
  const webServiceWorkersOverride = getEnvBoolean('ARCANOS_ALLOW_WEB_SERVICE_WORKERS', false);

  if (processKind === 'web') {
    return {
      requestedRunWorkers,
      resolvedRunWorkers: false,
      processKind,
      railwayServiceName,
      dedicatedWorkerServiceDetected,
      webServiceWorkersOverride,
      reason: 'process_kind_web'
    };
  }

  if (processKind === 'worker') {
    return {
      requestedRunWorkers,
      resolvedRunWorkers: true,
      processKind,
      railwayServiceName,
      dedicatedWorkerServiceDetected,
      webServiceWorkersOverride,
      reason: 'process_kind_worker'
    };
  }

  const normalizedServiceName = railwayServiceName?.toLowerCase() ?? '';
  if (
    isRailwayEnvironment() &&
    !webServiceWorkersOverride &&
    normalizedServiceName.length > 0 &&
    !normalizedServiceName.includes('worker')
  ) {
    return {
      requestedRunWorkers,
      resolvedRunWorkers: false,
      processKind,
      railwayServiceName,
      dedicatedWorkerServiceDetected,
      webServiceWorkersOverride,
      reason: 'railway_web_service'
    };
  }

  if (
    dedicatedWorkerServiceDetected &&
    normalizedServiceName.length > 0 &&
    !normalizedServiceName.includes('worker')
  ) {
    return {
      requestedRunWorkers,
      resolvedRunWorkers: false,
      processKind,
      railwayServiceName,
      dedicatedWorkerServiceDetected,
      webServiceWorkersOverride,
      reason: 'railway_dedicated_worker_service'
    };
  }

  return {
    requestedRunWorkers,
    resolvedRunWorkers: requestedRunWorkers,
    processKind,
    railwayServiceName,
    dedicatedWorkerServiceDetected,
    webServiceWorkersOverride,
    reason: 'requested'
  };
}

/**
 * Gets unified application configuration
 * 
 * Resolves all configuration values with Railway fallbacks
 * and provides type-safe access to configuration.
 * 
 * @returns Application configuration object
 */
export function getConfig(): AppConfig {
  const workerRuntimeMode = resolveWorkerRuntimeMode();
  const config: AppConfig = {
    // Server Configuration
    nodeEnv: getEnv('NODE_ENV', 'development'),
    port: getEnvNumber('PORT', APPLICATION_CONSTANTS.DEFAULT_PORT),
    isDevelopment: getEnv('NODE_ENV', 'development') === 'development',
    isProduction: getEnv('NODE_ENV') === 'production',
    isTest: getEnv('NODE_ENV') === 'test',
    isRailway: isRailwayEnvironment(),

    // OpenAI Configuration
    openaiApiKey: getEnvVar('OPENAI_API_KEY', [
      'RAILWAY_OPENAI_API_KEY',
      'API_KEY',
      'OPENAI_KEY'
    ]),
    openaiBaseUrl: getEnvVar('OPENAI_BASE_URL', [
      'OPENAI_API_BASE_URL',
      'OPENAI_API_BASE'
    ]),
    defaultModel: getEnvVar('FINETUNED_MODEL_ID', [
      'FINE_TUNED_MODEL_ID',
      'AI_MODEL',
      'OPENAI_MODEL',
      'RAILWAY_OPENAI_MODEL'
    ]) || APPLICATION_CONSTANTS.MODEL_GPT_4_1_MINI,
    fallbackModel: getEnvVar('FALLBACK_MODEL', [
      'AI_FALLBACK_MODEL',
      'RAILWAY_OPENAI_FALLBACK_MODEL',
      // Allow fine-tuned model identifiers to act as fallback when explicitly provided
      'FINETUNED_MODEL_ID',
      'FINE_TUNED_MODEL_ID'
    ]) || APPLICATION_CONSTANTS.MODEL_GPT_4_1,
    gpt5Model: getEnvVar('GPT5_MODEL') || APPLICATION_CONSTANTS.MODEL_GPT_5,
    gpt51Model: getEnvVar('GPT51_MODEL') || APPLICATION_CONSTANTS.MODEL_GPT_5_1,
    openaiMaxRetries: getEnvNumber('OPENAI_MAX_RETRIES', APPLICATION_CONSTANTS.DEFAULT_OPENAI_MAX_RETRIES),

    // Database Configuration
    databaseUrl: getEnvVar('DATABASE_URL'),
    pgHost: getEnv('PGHOST', 'localhost'),

    // Worker Configuration
    runWorkers: workerRuntimeMode.resolvedRunWorkers,
    workerApiTimeoutMs: getEnvNumber('WORKER_API_TIMEOUT_MS', APPLICATION_CONSTANTS.DEFAULT_API_TIMEOUT),

    // Logging Configuration
    logPath: getEnv('ARC_LOG_PATH', APPLICATION_CONSTANTS.DEFAULT_LOG_PATH),
    memoryPath: getEnv('ARC_MEMORY_PATH', APPLICATION_CONSTANTS.DEFAULT_MEMORY_PATH),
    logLevel: getEnv('LOG_LEVEL', 'info'),

    // Security Configuration
    adminKey: getEnv('ADMIN_KEY'),
    registerKey: getEnv('REGISTER_KEY'),

    // Feature Flags
    enableGithubActions: getEnvBoolean('ENABLE_GITHUB_ACTIONS', false),
    enableGptUserHandler: getEnvBoolean('ENABLE_GPT_USER_HANDLER', true),
    enableActionPlans: getEnvBoolean('ENABLE_ACTION_PLANS', false),
    enableClear2: getEnvBoolean('ENABLE_CLEAR_2', false),
    migrationDryRun: getEnvBoolean('MIGRATION_DRY_RUN', false),

    // Railway Configuration
    railwayEnvironment: getEnv('RAILWAY_ENVIRONMENT'),
    railwayProjectId: getEnv('RAILWAY_PROJECT_ID'),
    // Self-Improve Loop Configuration
    selfImproveEnabled: getEnvBoolean('SELF_IMPROVE_ENABLED', false),
    selfImproveEnvironment: parseSelfImproveEnvironment(getEnv('SELF_IMPROVE_ENV', 'development')),
    selfImproveAutonomyLevel: getEnvNumber('SELF_IMPROVE_AUTONOMY_LEVEL', 0),
    selfImproveFrozen: getEnvBoolean('SELF_IMPROVE_FREEZE', false),
    selfImproveEvidenceDir: getEnv('SELF_IMPROVE_EVIDENCE_DIR', path.join(process.cwd(), 'governance', 'evidence_packs')),
    selfImproveRetentionDays: getEnvNumber('SELF_IMPROVE_RETENTION_DAYS', 30),
    selfImprovePiiScrubEnabled: getEnvBoolean('SELF_IMPROVE_PII_SCRUB', true),
    selfImproveActuatorMode: parseSelfImproveActuatorMode(getEnv('SELF_IMPROVE_ACTUATOR_MODE', 'pr_bot')),

    // Predictive Self-Healing Configuration
    predictiveHealingEnabled: getEnvBoolean('PREDICTIVE_HEALING_ENABLED', false),
    predictiveHealingDryRun: getEnvBoolean('PREDICTIVE_HEALING_DRY_RUN', true),
    autoExecuteHealing: getEnvBoolean('AUTO_EXECUTE_HEALING', false),
    predictiveHealingWindowMs: getEnvNumber('PREDICTIVE_HEALING_WINDOW_MS', 5 * 60_000),
    predictiveHealingMinObservations: getEnvNumber('PREDICTIVE_HEALING_MIN_OBSERVATIONS', 3),
    predictiveHealingStaleAfterMs: getEnvNumber('PREDICTIVE_HEALING_STALE_AFTER_MS', 2 * 60_000),
    predictiveHealingMinConfidence: getEnvNumber('PREDICTIVE_HEALING_MIN_CONFIDENCE', 0.65),
    predictiveHealingActionCooldownMs: getEnvNumber('PREDICTIVE_HEALING_ACTION_COOLDOWN_MS', 5 * 60_000),
    predictiveHealingObservationHistoryLimit: getEnvNumber('PREDICTIVE_HEALING_OBSERVATION_HISTORY_LIMIT', 12),
    predictiveHealingAuditHistoryLimit: getEnvNumber('PREDICTIVE_HEALING_AUDIT_HISTORY_LIMIT', 25),
    predictiveErrorRateThreshold: getEnvNumber('PREDICTIVE_ERROR_RATE_THRESHOLD', 0.18),
    predictiveLatencyConsecutiveIntervals: getEnvNumber('PREDICTIVE_LATENCY_CONSECUTIVE_INTERVALS', 3),
    predictiveLatencyRiseDeltaMs: getEnvNumber('PREDICTIVE_LATENCY_RISE_DELTA_MS', 350),
    predictiveMemoryThresholdMb: getEnvNumber('PREDICTIVE_MEMORY_THRESHOLD_MB', 1024),
    predictiveMemoryGrowthThresholdMb: getEnvNumber('PREDICTIVE_MEMORY_GROWTH_THRESHOLD_MB', 192),
    predictiveMemorySustainedIntervals: getEnvNumber('PREDICTIVE_MEMORY_SUSTAINED_INTERVALS', 3),
    predictiveQueuePendingThreshold: getEnvNumber('PREDICTIVE_QUEUE_PENDING_THRESHOLD', 5),
    predictiveQueueVelocityThreshold: getEnvNumber('PREDICTIVE_QUEUE_VELOCITY_THRESHOLD', 2),
    predictiveScaleUpStep: getEnvNumber('PREDICTIVE_SCALE_UP_STEP', 1),
    predictiveScaleUpMaxExtraWorkers: getEnvNumber('PREDICTIVE_SCALE_UP_MAX_EXTRA_WORKERS', 2)
  };

  return config;
}

/**
 * Validates application configuration
 * 
 * Checks for required configuration values and provides
 * warnings for missing optional but recommended values.
 * 
 * @returns Validation result with errors and warnings
 */
export function validateConfig(): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const config = getConfig();

  // Required configuration checks
  if (!config.openaiApiKey) {
    warnings.push('OPENAI_API_KEY not set - AI endpoints will return mock responses');
  }

  if (config.isProduction && !config.databaseUrl) {
    warnings.push('DATABASE_URL not set - database features will be unavailable');
  }

  const rawSelfImproveEnv = getEnv('SELF_IMPROVE_ENV');
  if (rawSelfImproveEnv && parseSelfImproveEnvironment(rawSelfImproveEnv) !== rawSelfImproveEnv.trim().toLowerCase()) {
    warnings.push('SELF_IMPROVE_ENV invalid - defaulted to development');
  }

  const rawActuatorMode = getEnv('SELF_IMPROVE_ACTUATOR_MODE');
  if (rawActuatorMode && parseSelfImproveActuatorMode(rawActuatorMode) !== rawActuatorMode.trim().toLowerCase()) {
    warnings.push('SELF_IMPROVE_ACTUATOR_MODE invalid - defaulted to pr_bot');
  }

  if (config.autoExecuteHealing && !config.predictiveHealingEnabled) {
    warnings.push('AUTO_EXECUTE_HEALING enabled while PREDICTIVE_HEALING_ENABLED is false - auto execution will stay inactive');
  }

  if (config.autoExecuteHealing && config.predictiveHealingDryRun) {
    warnings.push('AUTO_EXECUTE_HEALING enabled while PREDICTIVE_HEALING_DRY_RUN is true - predictive actions will remain dry-run');
  }

  // Railway-specific checks
  if (config.isRailway) {
    if (!config.railwayEnvironment) {
      warnings.push('RAILWAY_ENVIRONMENT not set - Railway environment detection may be incomplete');
    }

    if (!config.railwayProjectId) {
      warnings.push('RAILWAY_PROJECT_ID not set - Railway project identification may be incomplete');
    }
  }

  // Log validation results
  if (errors.length > 0 || warnings.length > 0) {
    recordTraceEvent('config.validation', {
      errors: errors.length,
      warnings: warnings.length,
      isRailway: config.isRailway
    });

    if (errors.length > 0) {
      aiLogger.error('Configuration validation failed', {
        module: 'config.unified',
        errors
      });
    }

    if (warnings.length > 0) {
      aiLogger.warn('Configuration validation warnings', {
        module: 'config.unified',
        warnings
      });
    }
  } else {
    aiLogger.info('Configuration validation passed', {
      module: 'config.unified',
      isRailway: config.isRailway,
      environment: config.nodeEnv
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Gets configuration value by key with Railway fallbacks
 * 
 * Convenience function for accessing configuration values
 * with automatic Railway fallback resolution.
 * 
 * @param key - Configuration key
 * @returns Configuration value or undefined
 */
export function getConfigValue(key: keyof AppConfig): unknown {
  const config = getConfig();
  return config[key];
}

/**
 * Default export for convenience
 */
export default {
  getConfig,
  validateConfig,
  getEnvVar,
  isRailwayEnvironment,
  getConfigValue
};
