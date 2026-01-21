import { CircuitBreaker, ExponentialBackoff } from '../../utils/circuitBreaker.js';
import { recordTraceEvent, markOperation } from '../../utils/telemetry.js';

export const RESILIENCE_CONSTANTS = {
  DEFAULT_MAX_TOKENS: 1024,
  RATE_LIMIT_JITTER_MAX_MS: 2000,
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: 5,
  CIRCUIT_BREAKER_RESET_TIMEOUT_MS: 30000,
  CIRCUIT_BREAKER_MONITORING_PERIOD_MS: 60000,
  BACKOFF_BASE_DELAY_MS: 1000,
  BACKOFF_MAX_DELAY_MS: 30000,
  BACKOFF_MULTIPLIER: 2,
  BACKOFF_JITTER_MAX_MS: 500
} as const;

const circuitBreaker = new CircuitBreaker({
  failureThreshold: RESILIENCE_CONSTANTS.CIRCUIT_BREAKER_FAILURE_THRESHOLD,
  resetTimeoutMs: RESILIENCE_CONSTANTS.CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
  monitoringPeriodMs: RESILIENCE_CONSTANTS.CIRCUIT_BREAKER_MONITORING_PERIOD_MS
});

const backoffStrategy = new ExponentialBackoff(
  RESILIENCE_CONSTANTS.BACKOFF_BASE_DELAY_MS,
  RESILIENCE_CONSTANTS.BACKOFF_MAX_DELAY_MS,
  RESILIENCE_CONSTANTS.BACKOFF_MULTIPLIER,
  RESILIENCE_CONSTANTS.BACKOFF_JITTER_MAX_MS
);

export async function executeWithResilience<T>(operation: () => Promise<T>): Promise<T> {
  recordTraceEvent('openai.resilience.execute', {
    state: circuitBreaker.getState()
  });

  return circuitBreaker.execute(async () => {
    try {
      const result = await operation();
      markOperation('openai.success');
      recordTraceEvent('openai.resilience.success', {
        state: circuitBreaker.getState()
      });
      return result;
    } catch (error) {
      markOperation('openai.failure');
      recordTraceEvent('openai.resilience.failure', {
        state: circuitBreaker.getState(),
        error: error instanceof Error ? error.message : 'unknown'
      });
      throw error;
    }
  });
}

export function calculateRetryDelay(attempt: number, error: any): number {
  const delay = backoffStrategy.calculateDelay(attempt);
  if (error?.status === 429) {
    const jitter = Math.random() * RESILIENCE_CONSTANTS.RATE_LIMIT_JITTER_MAX_MS;
    return delay + jitter;
  }
  return delay;
}

export function getCircuitBreakerSnapshot() {
  const metrics = circuitBreaker.getMetrics();
  return {
    ...metrics,
    state: circuitBreaker.getState(),
    constants: RESILIENCE_CONSTANTS
  };
}

export function getCircuitBreakerState() {
  return circuitBreaker.getState();
}

