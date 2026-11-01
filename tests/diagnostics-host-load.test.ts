import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import os from 'node:os';

const circuitBreaker = { state: 'closed', failureCount: 0, lastFailureTime: null };
const telemetry = { metrics: { totalLogs: 0 }, traces: { recentEvents: [] } };
const config = { runWorkers: false };

jest.unstable_mockModule('@services/openai.js', () => ({
  getCircuitBreakerSnapshot: jest.fn(() => circuitBreaker)
}));
jest.unstable_mockModule('@platform/logging/telemetry.js', () => ({
  getTelemetrySnapshot: jest.fn(() => telemetry)
}));
jest.unstable_mockModule('@platform/runtime/environmentSecurity.js', () => ({
  getEnvironmentSecuritySummary: jest.fn(() => null)
}));
jest.unstable_mockModule('@platform/runtime/workerPaths.js', () => ({
  resolveWorkersDirectory: jest.fn(() => ({ path: '/unused', exists: false, checked: [] }))
}));
jest.unstable_mockModule('@platform/runtime/unifiedConfig.js', () => ({
  getConfig: jest.fn(() => config)
}));
jest.unstable_mockModule('@core/lib/errors/index.js', () => ({
  resolveErrorMessage: jest.fn((_error: unknown, fallback: string) => fallback)
}));

const { runHealthCheck } = await import('../src/platform/logging/diagnostics.js');

describe('health-check host load diagnostics', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    config.runWorkers = false;
  });

  afterEach(() => jest.restoreAllMocks());

  it('labels large host load without treating it as container CPU utilization or overload', () => {
    jest.spyOn(os, 'loadavg').mockReturnValue([800, 810, 820]);
    const report = runHealthCheck();

    expect(console.log).toHaveBeenCalledWith(
      '[📊 Host load] 1m=800.00 | 5m=810.00 | 15m=820.00 | Scope=host (not container CPU utilization)'
    );
    expect(report.metrics.loadAverage).toEqual({
      oneMinute: '800.00', fiveMinute: '810.00', fifteenMinute: '820.00'
    });
    expect(report.status).toBe('ok');
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('preserves the diagnostics response shape and reports worker failures independently of load', () => {
    config.runWorkers = true;
    jest.spyOn(os, 'loadavg').mockReturnValue([0, 0, 0]);
    const report = runHealthCheck();

    expect(report.status).toBe('degraded');
    expect(report.components.workers.healthy).toBe(false);
    expect(Object.keys(report.metrics).sort()).toEqual(['loadAverage', 'uptimeSeconds']);
    expect(report.metrics.loadAverage).toEqual({
      oneMinute: '0.00', fiveMinute: '0.00', fifteenMinute: '0.00'
    });
    expect(console.warn).toHaveBeenCalledWith(
      '[🧵 Workers] Worker subsystem reported an unhealthy status', expect.any(String)
    );
  });
});
