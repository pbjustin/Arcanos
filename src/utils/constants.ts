/**
 * Application constants and defaults
 * Centralized configuration for commonly used values across the application
 */

export const APPLICATION_CONSTANTS = {
  // Default values
  DEFAULT_PORT: 8080,
  DEFAULT_NODE_ENV: 'development',
  DEFAULT_LOG_LEVEL: 'info',
  
  // Timeout values (in milliseconds)  
  DEFAULT_API_TIMEOUT: 30000,
  DEFAULT_DATABASE_TIMEOUT: 5000,
  DEFAULT_CIRCUIT_BREAKER_TIMEOUT: 60000,
  
  // File paths
  DEFAULT_LOG_PATH: '/tmp/arc/log',
  DEFAULT_MEMORY_PATH: '/tmp/arc/memory',
  
  // Validation limits
  MAX_PROMPT_LENGTH: 100000,
  MAX_MEMORY_ENTRIES: 1000,
  MIN_PASSWORD_LENGTH: 8,
  
  // Rate limiting
  DEFAULT_RATE_LIMIT: 100,
  API_RATE_LIMIT: 30,
  ADMIN_RATE_LIMIT: 10
} as const;

/**
 * Get environment variable with fallback to application constant
 * @param envKey - Environment variable key
 * @param constantKey - Key in APPLICATION_CONSTANTS
 * @returns Environment value or default from constants
 */
export function getConfigValue<T extends keyof typeof APPLICATION_CONSTANTS>(
  envKey: string, 
  constantKey: T
): typeof APPLICATION_CONSTANTS[T] | string {
  const envValue = process.env[envKey];
  if (envValue !== undefined) {
    // Try to parse as number if the constant is a number
    const constant = APPLICATION_CONSTANTS[constantKey];
    if (typeof constant === 'number' && !isNaN(Number(envValue))) {
      return Number(envValue) as typeof APPLICATION_CONSTANTS[T];
    }
    return envValue;
  }
  return APPLICATION_CONSTANTS[constantKey];
}

/**
 * Get a numeric configuration value with validation
 * @param envKey - Environment variable key  
 * @param constantKey - Key in APPLICATION_CONSTANTS for numeric values
 * @param min - Minimum allowed value
 * @param max - Maximum allowed value  
 * @returns Validated numeric value
 */
export function getNumericConfig<T extends keyof typeof APPLICATION_CONSTANTS>(
  envKey: string,
  constantKey: T,
  min?: number,
  max?: number
): number {
  const value = getConfigValue(envKey, constantKey);
  const numValue = typeof value === 'number' ? value : Number(value);
  
  if (isNaN(numValue)) {
    return APPLICATION_CONSTANTS[constantKey] as number;
  }
  
  if (min !== undefined && numValue < min) {
    return min;
  }
  
  if (max !== undefined && numValue > max) {
    return max;
  }
  
  return numValue;
}