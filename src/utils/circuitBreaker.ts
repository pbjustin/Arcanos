/**
 * Circuit Breaker Pattern Implementation
 * Provides resilient API call handling with automatic failure detection and recovery
 */

export interface CircuitBreakerOptions {
  failureThreshold: number;
  resetTimeoutMs: number;
  monitoringPeriodMs: number;
}

export enum CircuitBreakerState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN', 
  HALF_OPEN = 'HALF_OPEN'
}

export class CircuitBreaker {
  private state: CircuitBreakerState = CircuitBreakerState.CLOSED;
  private failureCount = 0;
  private lastFailureTime = 0;
  private successCount = 0;
  
  constructor(private options: CircuitBreakerOptions) {}

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === CircuitBreakerState.OPEN) {
      if (this.shouldAttemptReset()) {
        this.state = CircuitBreakerState.HALF_OPEN;
        console.log('🔄 Circuit breaker transitioning to HALF_OPEN state');
      } else {
        throw new Error(`Circuit breaker is OPEN. Last failure: ${new Date(this.lastFailureTime).toISOString()}`);
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
      // Require multiple successes to fully close
      if (this.successCount >= 2) {
        this.state = CircuitBreakerState.CLOSED;
        this.successCount = 0;
        console.log('✅ Circuit breaker CLOSED - service recovered');
      }
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    this.successCount = 0;

    if (this.failureCount >= this.options.failureThreshold) {
      this.state = CircuitBreakerState.OPEN;
      console.warn(`🚨 Circuit breaker OPEN - failure threshold (${this.options.failureThreshold}) exceeded`);
    }
  }

  private shouldAttemptReset(): boolean {
    return Date.now() - this.lastFailureTime >= this.options.resetTimeoutMs;
  }

  getState(): CircuitBreakerState {
    return this.state;
  }

  getMetrics() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
      successCount: this.successCount
    };
  }
}

/**
 * Exponential backoff with jitter for retry logic
 */
export class ExponentialBackoff {
  constructor(
    private baseDelayMs: number = 1000,
    private maxDelayMs: number = 30000,
    private backoffMultiplier: number = 2,
    private jitterMaxMs: number = 1000
  ) {}

  calculateDelay(attempt: number): number {
    const exponentialDelay = Math.min(
      this.baseDelayMs * Math.pow(this.backoffMultiplier, attempt - 1),
      this.maxDelayMs
    );
    
    // Add jitter to prevent thundering herd
    const jitter = Math.random() * this.jitterMaxMs;
    return Math.floor(exponentialDelay + jitter);
  }

  async delay(attempt: number): Promise<void> {
    const delayMs = this.calculateDelay(attempt);
    console.log(`⏳ Exponential backoff: waiting ${delayMs}ms before attempt ${attempt}`);
    
    return new Promise(resolve => setTimeout(resolve, delayMs));
  }
}