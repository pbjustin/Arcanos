/**
 * Environment Variable Abstraction Layer
 * Centralizes all environment variable access with validation and defaults
 */

import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

/**
 * Environment configuration with type safety and validation
 */
export class Environment {
  /**
   * Get environment variable with type safety
   */
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
      throw new Error(`Environment variable ${key} is not a valid number: ${value}`);
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
}

/**
 * Pre-configured environment variables for easy access
 */
export const env = {
  // Server Configuration
  NODE_ENV: Environment.get('NODE_ENV', 'development'),
  PORT: Environment.getNumber('PORT', 8080),
  
  // OpenAI Configuration
  OPENAI_API_KEY: Environment.get('OPENAI_API_KEY'),
  OPENAI_BASE_URL: Environment.get('OPENAI_BASE_URL'),
  AI_MODEL: Environment.get('AI_MODEL', 'ft:gpt-4.1-2025-04-14:personal:arcanos:C8Msdote'),
  GPT5_MODEL: Environment.get('GPT5_MODEL', 'gpt-5'),
  
  // Database Configuration
  DATABASE_URL: Environment.get('DATABASE_URL'),
  
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
  
  // Development helpers
  isDevelopment: Environment.isDevelopment(),
  isProduction: Environment.isProduction(),
  isTest: Environment.isTest()
};

export default env;