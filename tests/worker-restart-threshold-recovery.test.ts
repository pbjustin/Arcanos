import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

describe('worker restart failure threshold recovery', () => {
  const originalEnvironment = {
    NODE_ENV: process.env.NODE_ENV,
    RUN_WORKERS: process.env.RUN_WORKERS,
    WORKER_COUNT: process.env.WORKER_COUNT,
    ARCANOS_PROCESS_KIND: process.env.ARCANOS_PROCESS_KIND,
    SAFETY_WORKER_RESTART_THRESHOLD: process.env.SAFETY_WORKER_RESTART_THRESHOLD,
    SAFETY_WORKER_RESTART_WINDOW_MS: process.env.SAFETY_WORKER_RESTART_WINDOW_MS
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-25T20:00:00.000Z'));
    process.env.NODE_ENV = 'test';
    // Import with automatic startup disabled; each test enables the exported
    // runtime setting immediately before exercising explicit forced starts.
    process.env.RUN_WORKERS = 'false';
    process.env.WORKER_COUNT = '1';
    delete process.env.ARCANOS_PROCESS_KIND;
    process.env.SAFETY_WORKER_RESTART_THRESHOLD = '2';
    process.env.SAFETY_WORKER_RESTART_WINDOW_MS = '1000';
  });

  afterEach(() => {
    jest.useRealTimers();
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('counts only failed forced starts and permits recovery after the bounded threshold window', async () => {
    let remainingInjectedFailures = 2;
    const workerStartLog = jest.fn((message: string) => {
      if (message === '[WORKER] Starting worker' && remainingInjectedFailures > 0) {
        remainingInjectedFailures -= 1;
        throw new Error('injected worker startup failure');
      }
    });

    jest.unstable_mockModule('../src/services/safety/executionLock.js', () => ({
      acquireExecutionLock: async () => ({
        release: async () => undefined
      })
    }));

    jest.resetModules();
    const { logger } = await import('../src/platform/logging/structuredLogging.js');
    jest.spyOn(logger, 'info').mockImplementation(workerStartLog);
    const workerConfig = await import('../src/config/workerConfig.js');
    const runtimeState = await import('../src/services/safety/runtimeState.js');
    const monotonicClock = await import('../src/services/safety/monotonicClock.js');
    runtimeState.resetSafetyRuntimeStateForTests();
    workerConfig.workerSettings.runWorkers = true;

    await expect(workerConfig.startWorkers(true)).rejects.toThrow('injected worker startup failure');
    await expect(workerConfig.startWorkers(true)).rejects.toThrow('injected worker startup failure');

    const thresholdConditions = runtimeState.getActiveUnsafeConditions('WORKER_RESTART_THRESHOLD');
    expect(thresholdConditions).toHaveLength(1);
    expect(thresholdConditions[0]).toEqual(expect.objectContaining({
      expiresAtMs: expect.any(Number),
      metadata: expect.objectContaining({
        entityId: 'worker-runtime:start',
        count: 2,
        threshold: 2,
        windowMs: 1000
      })
    }));

    const blockedStart = await workerConfig.startWorkers(true);
    expect(blockedStart).toEqual(expect.objectContaining({
      started: false,
      message: 'Worker restart threshold exceeded; execution blocked.'
    }));
    expect(remainingInjectedFailures).toBe(0);

    const expiresAtMs = thresholdConditions[0]?.expiresAtMs;
    expect(expiresAtMs).toEqual(expect.any(Number));
    let currentMonotonicMs = monotonicClock.getMonotonicTimestampMs();
    while (expiresAtMs !== undefined && currentMonotonicMs < expiresAtMs) {
      currentMonotonicMs = monotonicClock.getMonotonicTimestampMs();
    }
    expect(runtimeState.getActiveUnsafeConditions('WORKER_RESTART_THRESHOLD')).toHaveLength(0);
    expect(runtimeState.hasUnsafeBlockingConditions()).toBe(false);

    const recoveredStart = await workerConfig.startWorkers(true);
    expect(recoveredStart).toEqual(expect.objectContaining({
      started: true,
      runWorkers: true,
      workerCount: 1
    }));
    expect(runtimeState.getActiveUnsafeConditions('WORKER_RESTART_THRESHOLD')).toHaveLength(0);
    expect(runtimeState.getSafetyRuntimeSnapshot().counters.workerFailures['worker-runtime:start'])
      .toBeUndefined();

    runtimeState.resetSafetyRuntimeStateForTests();
  });

  it('does not accumulate failure signals for successful forced restarts', async () => {
    jest.unstable_mockModule('../src/services/safety/executionLock.js', () => ({
      acquireExecutionLock: async () => ({
        release: async () => undefined
      })
    }));

    jest.resetModules();
    const { logger } = await import('../src/platform/logging/structuredLogging.js');
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    const workerConfig = await import('../src/config/workerConfig.js');
    const runtimeState = await import('../src/services/safety/runtimeState.js');
    runtimeState.resetSafetyRuntimeStateForTests();
    workerConfig.workerSettings.runWorkers = true;

    await expect(workerConfig.startWorkers(true)).resolves.toEqual(expect.objectContaining({
      started: true
    }));
    await expect(workerConfig.startWorkers(true)).resolves.toEqual(expect.objectContaining({
      started: true
    }));

    expect(runtimeState.getSafetyRuntimeSnapshot().counters.workerFailures['worker-runtime:start'])
      .toBeUndefined();
    expect(runtimeState.getActiveUnsafeConditions('WORKER_RESTART_THRESHOLD')).toHaveLength(0);

    runtimeState.resetSafetyRuntimeStateForTests();
  });
});
