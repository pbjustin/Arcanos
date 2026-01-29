/**
 * Environment Variable Abstraction Layer
 * Centralizes all environment variable access with validation and defaults
 */

import dotenv from 'dotenv';
import { APPLICATION_CONSTANTS } from './constants.js';

// Load environment variables from .env file
dotenv.config();

/**
 * Environment configuration with type safety and validation
 */
export class Environment {
  /**
   * Get environment variable with type safety
   */
  static get(key: string): string | undefined;
  static get(key: string, defaultValue: string): string;
  static get(key: string, defaultValue?: string): string | undefined {
    return process.env[key] || defaultValue;
  }

  /**
   * Get required environment variable (throws if missing)
   */
  static getRequired(key: string): string {
    const value = process.env[key];
    if (!value) {
      throw new Error(`Required environment variable ${key} is not set`);
    }
    return value;
  }

  /**
   * Get environment variable as number
   */
  static getNumber(key: string, defaultValue?: number): number {
    const value = process.env[key];
    if (!value) {
      if (defaultValue !== undefined) return defaultValue;
      throw new Error(`Environment variable ${key} is not set`);
    }
    const parsed = parseInt(value, 10);
    if (isNaN(parsed)) {
      // If a default is provided, fall back to it for invalid values
      if (defaultValue !== undefined) return defaultValue;
      throw new Error(`Environment variable ${key} is not a valid number: ${value}`);
    }
    return parsed;
  }

  /**
   * Get environment variable as float
   */
  static getFloat(key: string, defaultValue?: number): number {
    const value = process.env[key];
    if (!value) {
      if (defaultValue !== undefined) return defaultValue;
      throw new Error(`Environment variable ${key} is not set`);
    }
    const parsed = parseFloat(value);
    if (isNaN(parsed)) {
      // If a default is provided, fall back to it for invalid values
      if (defaultValue !== undefined) return defaultValue;
      throw new Error(`Environment variable ${key} is not a valid float: ${value}`);
    }
    return parsed;
  }

  /**
   * Get environment variable as boolean
   */
  static getBoolean(key: string, defaultValue?: boolean): boolean {
    const value = process.env[key];
    if (!value) {
      if (defaultValue !== undefined) return defaultValue;
      throw new Error(`Environment variable ${key} is not set`);
    }
    return value.toLowerCase() === 'true' || value === '1';
  }

  /**
   * Parse integer from env var with fallback (compatible with parseEnvInt)
   */
  static parseInt(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? fallback : parsed;
  }

  /**
   * Parse float from env var with fallback (compatible with parseEnvFloat)
   */
  static parseFloat(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const parsed = Number.parseFloat(value);
    return Number.isNaN(parsed) ? fallback : parsed;
  }

  /**
   * Parse boolean from env var with fallback (compatible with parseEnvBoolean)
   */
  static parseBoolean(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    const normalized = value.trim().toLowerCase();
    if (['false', '0', 'off', 'no'].includes(normalized)) return false;
    if (['true', '1', 'on', 'yes'].includes(normalized)) return true;
    return fallback;
  }

  /**
   * Check if we're in development mode
   */
  static isDevelopment(): boolean {
    return this.get('NODE_ENV', 'development') === 'development';
  }

  /**
   * Check if we're in production mode
   */
  static isProduction(): boolean {
    return this.get('NODE_ENV') === 'production';
  }

  /**
   * Check if we're in test mode
   */
  static isTest(): boolean {
    return this.get('NODE_ENV') === 'test';
  }

  /**
   * Check if running on Railway
   */
  static isRailway(): boolean {
    return Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
  }
}

/**
 * Pre-configured environment variables for easy access
 */
export const env = {
  // Server Configuration
  NODE_ENV: Environment.get('NODE_ENV', 'development'),
  PORT: Environment.getNumber('PORT', APPLICATION_CONSTANTS.DEFAULT_PORT),
  BACKEND_STATUS_ENDPOINT: Environment.get('BACKEND_STATUS_ENDPOINT', '/status'),
  
  // OpenAI Configuration
  OPENAI_API_KEY: Environment.get('OPENAI_API_KEY'),
  OPENAI_BASE_URL: Environment.get('OPENAI_BASE_URL'),
  AI_MODEL: Environment.get('AI_MODEL', APPLICATION_CONSTANTS.MODEL_GPT_4_TURBO),
  GPT51_MODEL: Environment.get('GPT51_MODEL', APPLICATION_CONSTANTS.MODEL_GPT_5_1),
  GPT5_MODEL: Environment.get('GPT5_MODEL', APPLICATION_CONSTANTS.MODEL_GPT_5),
  OPENAI_CACHE_TTL_MS: Environment.getNumber('OPENAI_CACHE_TTL_MS', 60000),
  OPENAI_BATCH_WINDOW_MS: Environment.getNumber('OPENAI_BATCH_WINDOW_MS', 150),
  
  // Database Configuration
  DATABASE_URL: Environment.get('DATABASE_URL'),
  PGHOST: Environment.get('PGHOST', 'localhost'),
  BACKEND_REGISTRY_URL: Environment.get('BACKEND_REGISTRY_URL'),
  
  // Worker Configuration
  RUN_WORKERS: Environment.isTest() ? false : Environment.getBoolean('RUN_WORKERS', true),
  WORKER_API_TIMEOUT_MS: Environment.getNumber('WORKER_API_TIMEOUT_MS', 60000),
  
  // Logging Configuration
  ARC_LOG_PATH: Environment.get('ARC_LOG_PATH', '/tmp/arc/log'),
  LOG_LEVEL: Environment.get('LOG_LEVEL', 'info'),
  
  // Security Configuration
  ADMIN_KEY: Environment.get('ADMIN_KEY'),
  REGISTER_KEY: Environment.get('REGISTER_KEY'),
  
  // Feature Flags
  ENABLE_GITHUB_ACTIONS: Environment.getBoolean('ENABLE_GITHUB_ACTIONS', false),
  ENABLE_GPT_USER_HANDLER: Environment.getBoolean('ENABLE_GPT_USER_HANDLER', true),
  
  // Idle Manager Configuration
  IDLE_MEMORY_THRESHOLD_MB: Environment.getNumber('IDLE_MEMORY_THRESHOLD_MB', 150),
  MEMORY_GROWTH_WINDOW_MS: Environment.getNumber('MEMORY_GROWTH_WINDOW_MS', 60000),
  INITIAL_IDLE_TIMEOUT_MS: Environment.getNumber('INITIAL_IDLE_TIMEOUT_MS', 30000),
  MIN_IDLE_TIMEOUT_MS: Environment.getNumber('MIN_IDLE_TIMEOUT_MS', 10000),
  MAX_IDLE_TIMEOUT_MS: Environment.getNumber('MAX_IDLE_TIMEOUT_MS', 120000),
  EWMA_DECAY: Environment.getFloat('EWMA_DECAY', 0.85),
  
  // Bridge Configuration
  BRIDGE_ENABLED: Environment.get('BRIDGE_ENABLED'),
  
  // Railway Configuration
  RAILWAY_ENVIRONMENT: Environment.get('RAILWAY_ENVIRONMENT'),
  RAILWAY_PROJECT_ID: Environment.get('RAILWAY_PROJECT_ID'),
  
  // GPT Configuration
  GPT_ID: Environment.get('GPT_ID'),
  
  // Testing
  SELF_TEST_BASE_URL: Environment.get('SELF_TEST_BASE_URL'),
  
  // Tutor Configuration
  TUTOR_DEFAULT_TOKEN_LIMIT: Environment.getNumber('TUTOR_DEFAULT_TOKEN_LIMIT', 200),
  
  // Telemetry Configuration
  TELEMETRY_RECENT_LOGS_LIMIT: Environment.getNumber('TELEMETRY_RECENT_LOGS_LIMIT', 100),
  TELEMETRY_TRACE_EVENT_LIMIT: Environment.getNumber('TELEMETRY_TRACE_EVENT_LIMIT', 200),
  
  // Audit Configuration
  AUDIT_OVERRIDE: Environment.get('AUDIT_OVERRIDE'),

  // Daemon Configuration
  DAEMON_TOKENS_FILE: Environment.get('DAEMON_TOKENS_FILE'),
  DAEMON_RATE_LIMIT_MAX: Environment.getNumber('DAEMON_RATE_LIMIT_MAX', 400),
  DAEMON_RATE_LIMIT_WINDOW_MS: Environment.getNumber('DAEMON_RATE_LIMIT_WINDOW_MS', 10 * 60 * 1000),
  DAEMON_REGISTRY_RATE_LIMIT_MAX: Environment.getNumber('DAEMON_REGISTRY_RATE_LIMIT_MAX', 120),
  DAEMON_REGISTRY_RATE_LIMIT_WINDOW_MS: Environment.getNumber('DAEMON_REGISTRY_RATE_LIMIT_WINDOW_MS', 10 * 60 * 1000),
  DAEMON_PENDING_ACTION_TTL_MS: Environment.getNumber('DAEMON_PENDING_ACTION_TTL_MS', 5 * 60 * 1000),
  DAEMON_COMMAND_RETENTION_MS: Environment.getNumber('DAEMON_COMMAND_RETENTION_MS', 60 * 60 * 1000),
  
  // Development helpers
  isDevelopment: Environment.isDevelopment(),
  isProduction: Environment.isProduction(),
  isTest: Environment.isTest(),
  isRailway: Environment.isRailway()
};

export default env;
