/**
 * Environment Variable Validation and Access
 * 
 * Centralized environment variable access with fail-fast validation.
 * This is the ONLY module that should access process.env directly.
 * 
 * Rules:
 * - All env access must go through this module
 * - Required vars cause process.exit(1) if missing
 * - No default secrets (only non-secret defaults allowed)
 */

import { APPLICATION_CONSTANTS } from '../utils/constants.js';
import { resolveErrorMessage } from '../lib/errors/index.js';

export interface EnvConfig {
  // Required for Railway deployment
  PORT: number;
  
  // Required for OpenAI functionality
  OPENAI_API_KEY?: string;
  
  // Optional but validated
  NODE_ENV: string;
  DATABASE_URL?: string;
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Required environment variables for Railway deployment
 */
const REQUIRED_VARS = {
  PORT: {
    name: 'PORT',
    description: 'Server port (required for Railway)',
    validator: (value: string | undefined): number => {
      if (!value) {
        throw new Error('PORT is required');
      }
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`PORT must be a valid port number (1-65535), got: ${value}`);
      }
      return port;
    }
  }
} as const;

/**
 * Optional but recommended environment variables
 */
const OPTIONAL_VARS = {
  OPENAI_API_KEY: {
    name: 'OPENAI_API_KEY',
    description: 'OpenAI API key (required for AI functionality)',
    warnIfMissing: true
  },
  NODE_ENV: {
    name: 'NODE_ENV',
    description: 'Node environment',
    defaultValue: 'development'
  },
  DATABASE_URL: {
    name: 'DATABASE_URL',
    description: 'PostgreSQL connection string',
    warnIfMissing: false
  }
} as const;

/**
 * Validates all required environment variables
 * Exits process with code 1 if validation fails
 */
export function validateRequiredEnv(): EnvConfig {
  const errors: string[] = [];
  const warnings: string[] = [];
  const config: Partial<EnvConfig> = {};

  // Validate required vars
  for (const [key, spec] of Object.entries(REQUIRED_VARS)) {
    const value = process.env[spec.name];
    try {
      const validated = spec.validator(value);
      (config as any)[key] = validated;
    } catch (error) {
      errors.push(`${spec.name}: ${resolveErrorMessage(error)}`);
    }
  }

  // Validate optional vars
  for (const [key, spec] of Object.entries(OPTIONAL_VARS)) {
    const value = process.env[spec.name];
    if (value) {
      (config as any)[key] = value;
    } else if ('defaultValue' in spec && spec.defaultValue) {
      (config as any)[key] = spec.defaultValue;
    } else if ('warnIfMissing' in spec && spec.warnIfMissing) {
      warnings.push(`${spec.name} not set - ${spec.description}`);
    }
  }

  // Fail fast on errors
  if (errors.length > 0) {
    console.error('[❌ ENV VALIDATION FAILED]');
    console.error('Required environment variables are missing or invalid:');
    errors.forEach(error => console.error(`  - ${error}`));
    console.error('\nApplication cannot start. Please set the required variables.');
    process.exit(1);
  }

  // Log warnings but continue
  if (warnings.length > 0) {
    console.warn('[⚠️  ENV VALIDATION WARNINGS]');
    warnings.forEach(warning => console.warn(`  - ${warning}`));
  }

  return config as EnvConfig;
}

/**
 * Gets an environment variable value
 * Only use this for optional vars that have defaults
 * 
 * @param key - Environment variable name
 * @param defaultValue - Default value if not set
 * @returns Environment variable value or default
 */
export function getEnv(key: string, defaultValue: string): string;
export function getEnv(key: string): string | undefined;
export function getEnv(key: string, defaultValue?: string): string | undefined {
  return process.env[key] || defaultValue;
}

/**
 * Gets an environment variable as a number
 * 
 * @param key - Environment variable name
 * @param defaultValue - Default value if not set
 * @returns Parsed number or default
 */
export function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

/**
 * Gets an environment variable as a boolean
 * 
 * @param key - Environment variable name
 * @param defaultValue - Default value if not set
 * @returns Parsed boolean or default
 */
export function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  const normalized = value.toLowerCase().trim();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function resolveBackendBaseUrlValue(): string | undefined {
  const raw =
    getEnv('ARCANOS_BACKEND_URL') ||
    getEnv('SERVER_URL') ||
    getEnv('BACKEND_URL');
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function getBackendBaseUrlValue(): string | undefined {
  return resolveBackendBaseUrlValue();
}

export function getBackendBaseUrl(): URL {
  const explicitUrl = resolveBackendBaseUrlValue();
  if (explicitUrl) {
    try {
      return new URL(explicitUrl);
    } catch {
      // Fall back to local default when env is invalid
    }
  }

  const port = getEnvNumber('PORT', APPLICATION_CONSTANTS.DEFAULT_PORT);
  return new URL(`http://127.0.0.1:${port}`);
}

export function getAutomationAuth(): { headerName: string; secret: string } {
  const headerName = (getEnv('ARCANOS_AUTOMATION_HEADER') || 'x-arcanos-automation').toLowerCase();
  const secret = (getEnv('ARCANOS_AUTOMATION_SECRET') || '').trim();
  return { headerName, secret };
}

/**
 * Validates environment configuration
 * Returns validation result without exiting
 * Use validateRequiredEnv() for fail-fast validation at startup
 */
export function validateEnv(): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check required vars
  for (const [key, spec] of Object.entries(REQUIRED_VARS)) {
    const value = process.env[spec.name];
    try {
      spec.validator(value);
    } catch (error) {
      errors.push(`${spec.name}: ${resolveErrorMessage(error)}`);
    }
  }

  // Check optional vars
  for (const [key, spec] of Object.entries(OPTIONAL_VARS)) {
    const value = process.env[spec.name];
    if (!value && 'warnIfMissing' in spec && spec.warnIfMissing) {
      warnings.push(`${spec.name} not set - ${spec.description}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}
