/**
 * Unified Retry/Resilience Module
 * 
 * Provides consistent retry logic that works with any async operation,
 * not just OpenAI API calls. Implements Railway-native patterns with
 * exponential backoff, jitter, and circuit breaker integration.
 * 
 * Features:
 * - Works with any async operation
 * - Exponential backoff with jitter
 * - Circuit breaker integration
 * - Telemetry hooks
 * - Configurable retry strategies
 * - Railway-native patterns (stateless, deterministic)
 * 
 * @module unifiedRetry
 */

import { CircuitBreaker } from "@platform/resilience/circuitBreaker.js";
import { recordTraceEvent, markOperation } from "@platform/logging/telemetry.js";
import { aiLogger } from "@platform/logging/structuredLogging.js";
import {
  classifyOpenAIError,
  getRetryDelay,
  shouldRetry,
  getTechnicalMessage
} from "@core/lib/errors/reusable.js";
import { ErrorType } from "@core/lib/errors/classification.js";

/**
 * Retry configuration options
 */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Base delay in milliseconds (default: 1000) */
  baseDelayMs?: number;
  /** Maximum delay in milliseconds (default: 30000) */
  maxDelayMs?: number;
  /** Exponential multiplier (default: 2) */
  multiplier?: number;
  /** Maximum jitter in milliseconds for rate limits (default: 2000) */
  jitterMaxMs?: number;
  /** Whether to use circuit breaker (default: true) */
  useCircuitBreaker?: boolean;
  /** Custom retry predicate function */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Operation name for logging and telemetry */
  operationName?: string;
}

/**
 * Retry strategy configuration
 */
export interface RetryConfig {
  /** Maximum number of retries */
  maxRetries: number;
  /** Base delay in milliseconds */
  baseDelayMs: number;
  /** Maximum delay in milliseconds */
  maxDelayMs: number;
  /** Exponential multiplier */
  multiplier: number;
  /** Maximum jitter in milliseconds */
  jitterMaxMs: number;
  /** Retry predicate function */
  shouldRetry: (error: unknown, attempt: number) => boolean;
}

/**
 * Retry strategy implementation
 */
export class RetryStrategy {
  constructor(private config: RetryConfig) {}

  /**
   * Determines if an operation should be retried
   */
  shouldRetry(error: unknown, attempt: number): boolean {
    if (attempt >= this.config.maxRetries) {
      return false;
    }
    return this.config.shouldRetry(error, attempt);
  }

  /**
   * Calculates retry delay
   */
  calculateDelay(error: unknown, attempt: number): number {
    const result = getRetryDelay(
      error,
      attempt,
      this.config.baseDelayMs,
      this.config.maxDelayMs,
      this.config.multiplier,
      this.config.jitterMaxMs
    );
    return result.delay;
  }

  /**
   * Gets maximum retries
   */
  getMaxRetries(): number {
    return this.config.maxRetries;
  }
}

/**
 * Default retry constants matching resilience.ts
 */
export const DEFAULT_RETRY_CONSTANTS = {
  MAX_RETRIES: 3,
  BASE_DELAY_MS: 1000,
  MAX_DELAY_MS: 30000,
  MULTIPLIER: 2,
  JITTER_MAX_MS: 2000,
  RATE_LIMIT_JITTER_MAX_MS: 2000
} as const;

/**
 * Default circuit breaker configuration
 */
const DEFAULT_CIRCUIT_BREAKER_CONFIG = {
  failureThreshold: 5,
  resetTimeoutMs: 30000,
  monitoringPeriodMs: 60000
};

/**
 * Global circuit breaker instance
 */
let globalCircuitBreaker: CircuitBreaker | null = null;

/**
 * Gets or creates the global circuit breaker
 */
function getCircuitBreaker(): CircuitBreaker {
  if (!globalCircuitBreaker) {
    globalCircuitBreaker = new CircuitBreaker(DEFAULT_CIRCUIT_BREAKER_CONFIG);
  }
  return globalCircuitBreaker;
}

/**
 * Creates a retry strategy from configuration
 * 
 * @param config - Retry configuration
 * @returns Retry strategy instance
 */
export function createRetryStrategy(config: Partial<RetryConfig> = {}): RetryStrategy {
  const defaultShouldRetry = (error: unknown, attempt: number) => {
    return shouldRetry(error, attempt, config.maxRetries || DEFAULT_RETRY_CONSTANTS.MAX_RETRIES);
  };

  const retryConfig: RetryConfig = {
    maxRetries: config.maxRetries ?? DEFAULT_RETRY_CONSTANTS.MAX_RETRIES,
    baseDelayMs: config.baseDelayMs ?? DEFAULT_RETRY_CONSTANTS.BASE_DELAY_MS,
    maxDelayMs: config.maxDelayMs ?? DEFAULT_RETRY_CONSTANTS.MAX_DELAY_MS,
    multiplier: config.multiplier ?? DEFAULT_RETRY_CONSTANTS.MULTIPLIER,
    jitterMaxMs: config.jitterMaxMs ?? DEFAULT_RETRY_CONSTANTS.JITTER_MAX_MS,
    shouldRetry: config.shouldRetry ?? defaultShouldRetry
  };

  return new RetryStrategy(retryConfig);
}

/**
 * Calculates backoff delay for a retry attempt
 * 
 * @param attempt - Current attempt number (1-indexed)
 * @param error - Error that triggered the retry (optional)
 * @param baseDelayMs - Base delay in milliseconds (default: 1000)
 * @param maxDelayMs - Maximum delay in milliseconds (default: 30000)
 * @param multiplier - Exponential multiplier (default: 2)
 * @returns Calculated delay in milliseconds
 */
export function calculateBackoff(
  attempt: number,
  error?: unknown,
  baseDelayMs: number = DEFAULT_RETRY_CONSTANTS.BASE_DELAY_MS,
  maxDelayMs: number = DEFAULT_RETRY_CONSTANTS.MAX_DELAY_MS,
  multiplier: number = DEFAULT_RETRY_CONSTANTS.MULTIPLIER
): number {
  const result = getRetryDelay(
    error || new Error('Unknown error'),
    attempt,
    baseDelayMs,
    maxDelayMs,
    multiplier,
    DEFAULT_RETRY_CONSTANTS.JITTER_MAX_MS
  );
  return result.delay;
}

/**
 * Executes an async operation with retry logic
 * 
 * This is the main function for retrying operations. It:
 * - Implements exponential backoff with jitter
 * - Integrates with circuit breaker
 * - Provides telemetry hooks
 * - Logs retry attempts
 * - Handles Railway-native patterns
 * 
 * @param operation - Async operation to execute
 * @param options - Retry configuration options
 * @returns Promise resolving to operation result
 * @throws Last error if all retries are exhausted
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const startTime = Date.now();
  const operationName = options.operationName || 'unknown_operation';
  const maxRetries = options.maxRetries ?? DEFAULT_RETRY_CONSTANTS.MAX_RETRIES;
  const useCircuitBreaker = options.useCircuitBreaker !== false;
  
  const strategy = createRetryStrategy({
    maxRetries,
    baseDelayMs: options.baseDelayMs,
    maxDelayMs: options.maxDelayMs,
    multiplier: options.multiplier,
    jitterMaxMs: options.jitterMaxMs,
    shouldRetry: options.shouldRetry
  });

  const traceId = recordTraceEvent('retry.start', {
    operation: operationName,
    maxRetries,
    useCircuitBreaker
  });

  let lastError: unknown = null;

  // Execute with circuit breaker if enabled
  const executeOperation = async (): Promise<T> => {
    if (useCircuitBreaker) {
      const circuitBreaker = getCircuitBreaker();
      return circuitBreaker.execute(async () => {
        try {
          const result = await operation();
          markOperation(`${operationName}.success`);
          return result;
        } catch (error: unknown) {
          markOperation(`${operationName}.failure`);
          throw error;
        }
      });
    }
    return operation();
  };

  // Retry loop
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const result = await executeOperation();
      
      const duration = Date.now() - startTime;
      if (attempt > 1) {
        aiLogger.info(`Operation succeeded after ${attempt} attempts`, {
          module: 'resilience.unified',
          operation: operationName,
          attempt,
          duration
        });
      }

      recordTraceEvent('retry.success', {
        traceId,
        operation: operationName,
        attempt,
        duration
      });

      return result;
    } catch (error: unknown) {
      lastError = error;
      const classification = classifyOpenAIError(error);
      
      // Check if we should retry
      const shouldRetryAttempt = strategy.shouldRetry(error, attempt);
      
      if (!shouldRetryAttempt) {
        const duration = Date.now() - startTime;
        aiLogger.error(`Operation failed after ${attempt} attempts`, {
          module: 'resilience.unified',
          operation: operationName,
          attempt,
          errorType: classification.type,
          duration
        }, undefined, error as Error);

        recordTraceEvent('retry.exhausted', {
          traceId,
          operation: operationName,
          attempt,
          errorType: classification.type,
          duration
        });

        throw error;
      }

      // Calculate delay and wait
      const delay = strategy.calculateDelay(error, attempt);
      const duration = Date.now() - startTime;
      
      aiLogger.warn(`Operation failed, retrying (attempt ${attempt}/${maxRetries})`, {
        module: 'resilience.unified',
        operation: operationName,
        attempt,
        maxRetries,
        delay,
        errorType: classification.type,
        duration
      }, undefined, error as Error);

      recordTraceEvent('retry.attempt', {
        traceId,
        operation: operationName,
        attempt,
        delay,
        errorType: classification.type
      });

      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // This should never be reached, but TypeScript needs it
  const duration = Date.now() - startTime;
  recordTraceEvent('retry.unexpected_end', {
    traceId,
    operation: operationName,
    duration
  });

  throw lastError || new Error('Operation failed: unexpected end of retry loop');
}

/**
 * Default export for convenience
 */
export default {
  withRetry,
  createRetryStrategy,
  calculateBackoff,
  DEFAULT_RETRY_CONSTANTS
};
