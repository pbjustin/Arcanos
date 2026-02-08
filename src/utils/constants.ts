/**
 * Application constants and defaults
 * Centralized configuration for commonly used values across the application
 */

export const APPLICATION_CONSTANTS = {
  // Default values
  DEFAULT_PORT: 3000,
  DEFAULT_NODE_ENV: 'development',
  DEFAULT_LOG_LEVEL: 'info',
  DEFAULT_OPENAI_MAX_RETRIES: 2,
  
  // AI Model names (latest stable defaults)
  MODEL_GPT_4: 'gpt-4',
  MODEL_GPT_4O: 'gpt-4o',
  MODEL_GPT_4O_MINI: 'gpt-4o-mini',
  MODEL_GPT_4_1: 'gpt-4.1',
  MODEL_GPT_4_1_MINI: 'gpt-4.1-mini',
  MODEL_GPT_4_1_NANO: 'gpt-4.1-nano',
  MODEL_GPT_5: 'gpt-5',
  MODEL_GPT_5_1: 'gpt-5.1',
  // Legacy models (for reference only, prefer gpt-4.1)
  MODEL_GPT_4_TURBO: 'gpt-4-turbo',
  
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
  MAX_INPUT_LENGTH: 1000,
  /** Max length for prompt snippet in fallback mode template (chars). Used by prompts and fallbackMessages. */
  FALLBACK_PROMPT_SNIPPET_LENGTH: 200,
  
  // Rate limiting
  DEFAULT_RATE_LIMIT: 100,
  API_RATE_LIMIT: 30,
  ADMIN_RATE_LIMIT: 10,
  
  // Cache configuration (in milliseconds)
  CACHE_TTL_SHORT: 5 * 60 * 1000,      // 5 minutes
  CACHE_TTL_MEDIUM: 10 * 60 * 1000,    // 10 minutes
  CACHE_TTL_LONG: 30 * 60 * 1000,      // 30 minutes
  CACHE_CLEANUP_INTERVAL_SHORT: 60 * 1000,     // 1 minute
  CACHE_CLEANUP_INTERVAL_MEDIUM: 2 * 60 * 1000, // 2 minutes
  CACHE_CLEANUP_INTERVAL_LONG: 5 * 60 * 1000,   // 5 minutes
  CACHE_MAX_ENTRIES_LARGE: 1000,
  CACHE_MAX_ENTRIES_MEDIUM: 500,
  CACHE_MAX_ENTRIES_SMALL: 100,
  
  // Circuit breaker configuration (in milliseconds)
  CIRCUIT_BREAKER_BASE_DELAY: 1000,
  CIRCUIT_BREAKER_MAX_DELAY: 30000,
  CIRCUIT_BREAKER_BACKOFF_MULTIPLIER: 2,
  CIRCUIT_BREAKER_JITTER_MAX: 1000,
  
  // Token parameters
  DEFAULT_TOKEN_LIMIT: 1000,
  EXTENDED_TOKEN_LIMIT: 2000,
  MAX_SAFE_TOKENS: 8000
} as const;
