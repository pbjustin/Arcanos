import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

describe('worker duplication suppression', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalRunWorkers = process.env.RUN_WORKERS;
  const originalProcessKind = process.env.ARCANOS_PROCESS_KIND;
  const originalRailwayEnvironment = process.env.RAILWAY_ENVIRONMENT;
  const originalRailwayServiceName = process.env.RAILWAY_SERVICE_NAME;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.RUN_WORKERS = 'false';
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }

    if (originalRunWorkers === undefined) {
      delete process.env.RUN_WORKERS;
    } else {
      process.env.RUN_WORKERS = originalRunWorkers;
    }

    if (originalProcessKind === undefined) {
      delete process.env.ARCANOS_PROCESS_KIND;
    } else {
      process.env.ARCANOS_PROCESS_KIND = originalProcessKind;
    }

    if (originalRailwayEnvironment === undefined) {
      delete process.env.RAILWAY_ENVIRONMENT;
    } else {
      process.env.RAILWAY_ENVIRONMENT = originalRailwayEnvironment;
    }

    if (originalRailwayServiceName === undefined) {
      delete process.env.RAILWAY_SERVICE_NAME;
    } else {
      process.env.RAILWAY_SERVICE_NAME = originalRailwayServiceName;
    }
  });

  it('suppresses worker startup when lock acquisition reports duplicate', async () => {
    jest.resetModules();
    jest.unstable_mockModule('@services/safety/auditEvents.js', () => ({
      emitSafetyAuditEvent: jest.fn()
    }));
    jest.unstable_mockModule('../src/services/safety/executionLock.js', () => ({
      acquireExecutionLock: async () => null
    }));

    const workerConfig = await import('../src/config/workerConfig.js');
    const startResult = await workerConfig.startWorkers(true);

    expect(startResult.started).toBe(false);
    expect(startResult.message).toContain('suppressed');
  });

  it('does not allow force-starting workers on a Railway web runtime', async () => {
    process.env.NODE_ENV = 'production';
    process.env.RUN_WORKERS = 'true';
    process.env.ARCANOS_PROCESS_KIND = 'web';
    process.env.RAILWAY_ENVIRONMENT = 'production';
    process.env.RAILWAY_SERVICE_NAME = 'ARCANOS V2';

    jest.resetModules();
    jest.unstable_mockModule('@services/safety/auditEvents.js', () => ({
      emitSafetyAuditEvent: jest.fn()
    }));
    jest.unstable_mockModule('../src/services/safety/executionLock.js', () => ({
      acquireExecutionLock: async () => ({
        release: async () => undefined
      })
    }));

    const workerConfig = await import('../src/config/workerConfig.js');
    const startResult = await workerConfig.startWorkers(true);

    expect(startResult).toEqual(expect.objectContaining({
      started: false,
      runWorkers: false,
      workerCount: 0,
      workerIds: [],
      message: 'RUN_WORKERS disabled for this service role; workers not started.'
    }));
    expect(workerConfig.getWorkerRuntimeStatus()).toEqual(expect.objectContaining({
      enabled: false,
      started: false,
      activeListeners: 0,
      workerIds: []
    }));
  });
});
