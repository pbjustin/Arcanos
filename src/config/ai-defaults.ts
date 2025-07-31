/**
 * Standardized AI Configuration Defaults
 * Consolidates token limits, temperatures, and retry settings across all services
 * Optimizes for consistency and token efficiency
 */

export interface AITaskConfig {
  maxTokens: number;
  temperature: number;
  model?: string;
}

export interface AITaskPresets {
  // Quick, deterministic tasks
  analysis: AITaskConfig;
  extraction: AITaskConfig;
  validation: AITaskConfig;
  
  // Creative, longer tasks
  generation: AITaskConfig;
  writing: AITaskConfig;
  
  // System tasks
  maintenance: AITaskConfig;
  diagnostics: AITaskConfig;
  
  // Stream tasks (optimized for real-time)
  stream: AITaskConfig;
}

/**
 * Optimized AI task presets based on usage patterns and token efficiency
 */
export const AI_TASK_PRESETS: AITaskPresets = {
  // Quick, deterministic tasks - low tokens, low temperature
  analysis: {
    maxTokens: 500,
    temperature: 0.2
  },
  extraction: {
    maxTokens: 300,
    temperature: 0.1
  },
  validation: {
    maxTokens: 200,
    temperature: 0.1
  },
  
  // Creative, longer tasks - higher tokens, balanced temperature
  generation: {
    maxTokens: 1500,
    temperature: 0.7
  },
  writing: {
    maxTokens: 2000,
    temperature: 0.6
  },
  
  // System tasks - moderate tokens, low temperature for consistency
  maintenance: {
    maxTokens: 1000,
    temperature: 0.3
  },
  diagnostics: {
    maxTokens: 800,
    temperature: 0.2
  },
  
  // Stream tasks - optimized for real-time performance
  stream: {
    maxTokens: 1200,
    temperature: 0.4
  }
};

/**
 * Get optimized configuration for a specific AI task type
 */
export function getAIConfig(taskType: keyof AITaskPresets, overrides?: Partial<AITaskConfig>): AITaskConfig {
  const preset = AI_TASK_PRESETS[taskType];
  return {
    ...preset,
    ...overrides
  };
}

/**
 * Default fallback configuration for unspecified tasks
 */
export const DEFAULT_AI_CONFIG: AITaskConfig = {
  maxTokens: 1000,
  temperature: 0.5
};

/**
 * Retry configuration - consolidated from various services
 */
export const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelay: 1000, // 1 second
  maxDelay: 10000, // 10 seconds
  backoffFactor: 2
};

/**
 * Calculate retry delay with exponential backoff
 */
export function getRetryDelay(attempt: number): number {
  const delay = RETRY_CONFIG.baseDelay * Math.pow(RETRY_CONFIG.backoffFactor, attempt - 1);
  return Math.min(delay, RETRY_CONFIG.maxDelay);
}