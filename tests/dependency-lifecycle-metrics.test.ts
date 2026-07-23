import { beforeEach, describe, expect, it } from '@jest/globals';

import {
  getMetricsText,
  recordDependencyCall,
  recordDependencyLifecycleEvent,
  recordDependencyOperationGateRejection,
  recordDependencyOperationInFlight,
  resetAppMetricsForTests,
} from '../src/platform/observability/appMetrics.js';

describe('dependency lifecycle metrics', () => {
  beforeEach(() => {
    resetAppMetricsForTests();
  });

  it('exports alert-ready bounded Redis lifecycle and operation metrics', async () => {
    recordDependencyLifecycleEvent({
      dependency: 'redis',
      event: 'retry_scheduled',
      lifecycleState: 'DEGRADED',
      circuitState: 'OPEN'
    });
    recordDependencyLifecycleEvent({
      dependency: 'redis',
      event: 'ready',
      lifecycleState: 'READY',
      circuitState: 'CLOSED',
      recovered: true
    });
    recordDependencyOperationGateRejection({
      dependency: 'redis',
      operation: 'diagnostics.metrics.read',
      reason: 'open'
    });
    recordDependencyOperationInFlight('redis', 1);
    recordDependencyCall({
      dependency: 'redis',
      operation: 'diagnostics.metrics.read',
      outcome: 'timeout',
      durationMs: 2_000,
      error: Object.assign(new Error('timed out'), {
        code: 'REDIS_OPERATION_TIMEOUT'
      })
    });

    const metrics = await getMetricsText();
    expect(metrics).toMatch(
      /dependency_lifecycle_events_total\{[^}]*dependency="redis"[^}]*event="retry_scheduled"[^}]*\} 1/u
    );
    expect(metrics).toMatch(
      /dependency_lifecycle_events_total\{[^}]*dependency="redis"[^}]*event="ready"[^}]*\} 1/u
    );
    expect(metrics).toMatch(
      /dependency_circuit_breaker_state\{[^}]*dependency="redis"[^}]*state="CLOSED"[^}]*\} 1/u
    );
    expect(metrics).toMatch(
      /dependency_circuit_breaker_state\{[^}]*dependency="redis"[^}]*state="OPEN"[^}]*\} 0/u
    );
    expect(metrics).toMatch(
      /dependency_operation_gate_rejections_total\{[^}]*dependency="redis"[^}]*operation="diagnostics.metrics.read"[^}]*reason="open"[^}]*\} 1/u
    );
    expect(metrics).toMatch(
      /dependency_operation_in_flight\{[^}]*dependency="redis"[^}]*\} 1/u
    );
    expect(metrics).toMatch(
      /dependency_recoveries_total\{[^}]*dependency="redis"[^}]*\} 1/u
    );
    expect(metrics).toMatch(
      /dependency_timeouts_total\{[^}]*dependency="redis"[^}]*operation="diagnostics.metrics.read"[^}]*\} 1/u
    );
    expect(metrics).not.toContain('correlationId');
    expect(metrics).not.toContain('trace-');
  });
});
