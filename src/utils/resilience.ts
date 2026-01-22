/**
 * Resilience Utilities
 * Provides fallback handlers, rollback isolation, and failsafe mechanisms
 * 
 * @confidence 1.0 - Core resilience patterns
 */

/**
 * Fallback handler configuration
 */
export interface FallbackConfig<T> {
  /** Primary operation to attempt */
  primary: () => Promise<T>;
  /** Fallback operation if primary fails */
  fallback: () => Promise<T>;
  /** Optional error handler */
  onError?: (error: Error) => void;
  /** Maximum retry attempts for primary */
  maxRetries?: number;
}

/**
 * Execute operation with automatic fallback
 * 
 * @param config - Fallback configuration
 * @returns Result from primary or fallback operation
 * @confidence 1.0 - Standard fallback pattern
 */
export async function withFallback<T>(config: FallbackConfig<T>): Promise<T> {
  const { primary, fallback, onError, maxRetries = 1 } = config;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await primary();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      
      if (onError) {
        onError(err);
      }
      
      // If this was the last retry, use fallback
      if (attempt === maxRetries) {
        try {
          return await fallback();
        } catch (fallbackError) {
          const fallbackErr = fallbackError instanceof Error 
            ? fallbackError 
            : new Error(String(fallbackError));
          throw new Error(
            `Both primary and fallback operations failed. Primary: ${err.message}, Fallback: ${fallbackErr.message}`
          );
        }
      }
    }
  }
  
  // This should never be reached, but TypeScript requires it
  throw new Error('Fallback execution failed');
}

/**
 * Rollback operation type
 */
export type RollbackOperation = () => Promise<void> | void;

/**
 * Transaction-like operation with rollback support
 * 
 * @param operation - Main operation to execute
 * @param rollback - Rollback operation if main fails
 * @returns Result of main operation
 * @confidence 1.0 - Standard transaction pattern
 */
export async function withRollback<T>(
  operation: () => Promise<T>,
  rollback: RollbackOperation
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    try {
      await rollback();
    } catch (rollbackError) {
      const rollbackErr = rollbackError instanceof Error 
        ? rollbackError 
        : new Error(String(rollbackError));
      throw new Error(
        `Operation failed and rollback also failed. Operation: ${error instanceof Error ? error.message : String(error)}, Rollback: ${rollbackErr.message}`
      );
    }
    throw error;
  }
}

/**
 * Failsafe checkpoint configuration
 */
export interface FailsafeCheckpoint {
  /** Checkpoint identifier */
  id: string;
  /** Validate checkpoint state */
  validate: () => Promise<boolean> | boolean;
  /** Restore from checkpoint */
  restore: () => Promise<void> | void;
}

/**
 * Execute operation with failsafe checkpoint
 * 
 * @param operation - Operation to execute
 * @param checkpoint - Checkpoint configuration
 * @returns Result of operation
 * @confidence 0.95 - Checkpoint validation may have edge cases
 */
export async function withFailsafe<T>(
  operation: () => Promise<T>,
  checkpoint: FailsafeCheckpoint
): Promise<T> {
  // Validate checkpoint before operation
  const isValid = await checkpoint.validate();
  if (!isValid) {
    throw new Error(`Failsafe checkpoint ${checkpoint.id} validation failed`);
  }
  
  try {
    return await operation();
  } catch (error) {
    // Attempt to restore from checkpoint
    try {
      await checkpoint.restore();
    } catch (restoreError) {
      const restoreErr = restoreError instanceof Error 
        ? restoreError 
        : new Error(String(restoreError));
      throw new Error(
        `Operation failed and checkpoint restore failed. Operation: ${error instanceof Error ? error.message : String(error)}, Restore: ${restoreErr.message}`
      );
    }
    throw error;
  }
}

/**
 * Retry configuration
 */
export interface RetryConfig {
  /** Maximum number of retry attempts */
  maxAttempts: number;
  /** Delay between retries in milliseconds */
  delayMs?: number;
  /** Exponential backoff multiplier */
  backoffMultiplier?: number;
  /** Function to determine if error is retryable */
  isRetryable?: (error: Error) => boolean;
}

/**
 * Execute operation with retry logic
 * 
 * @param operation - Operation to retry
 * @param config - Retry configuration
 * @returns Result of operation
 * @confidence 1.0 - Standard retry pattern
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  config: RetryConfig
): Promise<T> {
  const {
    maxAttempts,
    delayMs = 1000,
    backoffMultiplier = 2,
    isRetryable = () => true
  } = config;
  
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      lastError = err;
      
      // Check if error is retryable
      if (!isRetryable(err)) {
        throw err;
      }
      
      // If this was the last attempt, throw
      if (attempt === maxAttempts) {
        throw err;
      }
      
      // Calculate delay with exponential backoff
      const currentDelay = delayMs * Math.pow(backoffMultiplier, attempt - 1);
      await new Promise(resolve => setTimeout(resolve, currentDelay));
    }
  }
  
  // This should never be reached
  throw lastError || new Error('Retry execution failed');
}

/**
 * Circuit breaker state
 */
export enum CircuitBreakerState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half_open'
}

/**
 * Circuit breaker configuration
 */
export interface CircuitBreakerConfig {
  /** Failure threshold to open circuit */
  failureThreshold: number;
  /** Timeout in milliseconds before attempting to close circuit */
  timeoutMs: number;
  /** Success threshold to close circuit from half-open */
  successThreshold?: number;
}

/**
 * Circuit breaker implementation
 * 
 * @confidence 0.95 - Circuit breaker pattern with state management
 */
export class CircuitBreaker {
  private state: CircuitBreakerState = CircuitBreakerState.CLOSED;
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime: number | null = null;
  private readonly config: Required<CircuitBreakerConfig>;
  
  constructor(config: CircuitBreakerConfig) {
    this.config = {
      successThreshold: 2,
      ...config
    };
  }
  
  /**
   * Execute operation through circuit breaker
   */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    // Check if circuit should transition from open to half-open
    if (this.state === CircuitBreakerState.OPEN) {
      if (this.lastFailureTime && Date.now() - this.lastFailureTime >= this.config.timeoutMs) {
        this.state = CircuitBreakerState.HALF_OPEN;
        this.successCount = 0;
      } else {
        throw new Error('Circuit breaker is OPEN - operation blocked');
      }
    }
    
    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }
  
  private onSuccess(): void {
    this.failureCount = 0;
    
    if (this.state === CircuitBreakerState.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= this.config.successThreshold) {
        this.state = CircuitBreakerState.CLOSED;
        this.successCount = 0;
      }
    }
  }
  
  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    
    if (this.failureCount >= this.config.failureThreshold) {
      this.state = CircuitBreakerState.OPEN;
    }
  }
  
  /**
   * Get current circuit breaker state
   */
  getState(): CircuitBreakerState {
    return this.state;
  }
  
  /**
   * Reset circuit breaker to closed state
   */
  reset(): void {
    this.state = CircuitBreakerState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
  }
}
