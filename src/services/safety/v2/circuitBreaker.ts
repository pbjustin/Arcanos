/**
 * v2 Trust Verification — Circuit Breaker
 *
 * Prevents cascading failures when downstream services (Redis, JWKS) are
 * unavailable. Three states: CLOSED → OPEN → HALF_OPEN → CLOSED.
 * Uses performance.now() for monotonic timing (immune to clock adjustments).
 */

import { V2_CONFIG } from "./config.js";

type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export class CircuitBreaker {
  // Error thrown when circuit is open to allow callers to handle explicitly
  static CircuitBreakerOpenError = class CircuitBreakerOpenError extends Error {
    constructor(message?: string) {
      super(message);
      this.name = "CircuitBreakerOpenError";
    }
  };

  private state: CircuitState = "CLOSED";
  private failureCount = 0;
  private lastFailureTime = 0;
  private halfOpenCalls = 0;
  private inFlightCount = 0;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenMaxCalls: number;

  constructor(opts?: {
    failureThreshold?: number;
    resetTimeoutMs?: number;
    halfOpenMaxCalls?: number;
  }) {
    this.failureThreshold =
      opts?.failureThreshold ?? V2_CONFIG.CIRCUIT_BREAKER.FAILURE_THRESHOLD;
    this.resetTimeoutMs =
      opts?.resetTimeoutMs ?? V2_CONFIG.CIRCUIT_BREAKER.RESET_TIMEOUT_MS;
    this.halfOpenMaxCalls =
      opts?.halfOpenMaxCalls ?? V2_CONFIG.CIRCUIT_BREAKER.HALF_OPEN_MAX_CALLS;
  }

  getState(): CircuitState {
    // Return current state without causing side-effects. Use
    // `_transitionOpenIfNeeded` from callers that intend to mutate state.
    return this.state;
  }

  // Internal: transition from OPEN -> HALF_OPEN when reset timeout elapses.
  private _transitionOpenIfNeeded(): void {
    if (
      this.state === "OPEN" &&
      performance.now() - this.lastFailureTime >= this.resetTimeoutMs
    ) {
      this.state = "HALF_OPEN";
      this.halfOpenCalls = 0;
    }
  }

  async call<T>(fn: () => Promise<T>): Promise<T> {
    // Refresh time-based transitions before making decisions
    this._transitionOpenIfNeeded();
    const currentState = this.state;

    if (currentState === "OPEN") {
      throw new CircuitBreaker.CircuitBreakerOpenError(
        "Circuit breaker OPEN — failing fast"
      );
    }

    if (currentState === "HALF_OPEN") {
      if (this.halfOpenCalls >= this.halfOpenMaxCalls) {
        throw new CircuitBreaker.CircuitBreakerOpenError(
          "Circuit breaker HALF_OPEN — max probe calls reached"
        );
      }
      this.halfOpenCalls++;
    }

    this.inFlightCount++;

    try {
      const result = await fn();

      this.inFlightCount--;

      // Only reset to CLOSED when no other calls are in flight
      if (this.inFlightCount === 0) {
        this.state = "CLOSED";
        this.failureCount = 0;
        this.halfOpenCalls = 0;
      }

      return result;
    } catch (err) {
      this.inFlightCount--;
      this.failureCount++;
      this.lastFailureTime = performance.now();

      if (
        currentState === "HALF_OPEN" ||
        this.failureCount >= this.failureThreshold
      ) {
        this.state = "OPEN";
      }

      throw err;
    }
  }
}
