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

import { Environment } from '../utils/env.js';
import { aiLogger } from '../utils/structuredLogging.js';
import { recordTraceEvent } from '../utils/telemetry.js';

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

  // Database Configuration
  databaseUrl: string | undefined;
  pgHost: string;

  // Worker Configuration
  runWorkers: boolean;
  workerApiTimeoutMs: number;

  // Logging Configuration
  logPath: string;
  logLevel: string;

  // Security Configuration
  adminKey: string | undefined;
  registerKey: string | undefined;

  // Feature Flags
  enableGithubActions: boolean;
  enableGptUserHandler: boolean;

  // Railway Configuration
  railwayEnvironment: string | undefined;
  railwayProjectId: string | undefined;
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
  // Check primary key
  const primaryValue = process.env[key];
  if (primaryValue && primaryValue.trim().length > 0) {
    return primaryValue.trim();
  }

  // Check Railway-prefixed key
  const railwayKey = `RAILWAY_${key}`;
  const railwayValue = process.env[railwayKey];
  if (railwayValue && railwayValue.trim().length > 0) {
    return railwayValue.trim();
  }

  // Check fallback keys
  if (fallbacks && fallbacks.length > 0) {
    for (const fallback of fallbacks) {
      const fallbackValue = process.env[fallback];
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
  return Boolean(
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.RAILWAY_PROJECT_ID ||
    process.env.RAILWAY_SERVICE_NAME
  );
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
  const config: AppConfig = {
    // Server Configuration
    nodeEnv: Environment.get('NODE_ENV', 'development'),
    port: Environment.getNumber('PORT', 8080),
    isDevelopment: Environment.isDevelopment(),
    isProduction: Environment.isProduction(),
    isTest: Environment.isTest(),
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
    ]) || 'gpt-4o-mini',
    fallbackModel: getEnvVar('FALLBACK_MODEL', [
      'AI_FALLBACK_MODEL',
      'RAILWAY_OPENAI_FALLBACK_MODEL'
    ]) || 'gpt-4',
    gpt5Model: getEnvVar('GPT5_MODEL') || 'gpt-5',
    gpt51Model: getEnvVar('GPT51_MODEL') || 'gpt-5.1',

    // Database Configuration
    databaseUrl: getEnvVar('DATABASE_URL'),
    pgHost: Environment.get('PGHOST', 'localhost'),

    // Worker Configuration
    runWorkers: Environment.getBoolean('RUN_WORKERS', !Environment.isTest()),
    workerApiTimeoutMs: Environment.getNumber('WORKER_API_TIMEOUT_MS', 60000),

    // Logging Configuration
    logPath: Environment.get('ARC_LOG_PATH', '/tmp/arc/log'),
    logLevel: Environment.get('LOG_LEVEL', 'info'),

    // Security Configuration
    adminKey: Environment.get('ADMIN_KEY'),
    registerKey: Environment.get('REGISTER_KEY'),

    // Feature Flags
    enableGithubActions: Environment.getBoolean('ENABLE_GITHUB_ACTIONS', false),
    enableGptUserHandler: Environment.getBoolean('ENABLE_GPT_USER_HANDLER', true),

    // Railway Configuration
    railwayEnvironment: Environment.get('RAILWAY_ENVIRONMENT'),
    railwayProjectId: Environment.get('RAILWAY_PROJECT_ID')
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
