import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

describe('worker duplication suppression', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalRunWorkers = process.env.RUN_WORKERS;

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
  });

  it('suppresses worker startup when lock acquisition reports duplicate', async () => {
    jest.resetModules();
    jest.unstable_mockModule('../src/services/safety/executionLock.js', () => ({
      acquireExecutionLock: async () => null
    }));

    const workerConfig = await import('../src/config/workerConfig.js');
    const startResult = await workerConfig.startWorkers(true);

    expect(startResult.started).toBe(false);
    expect(startResult.message).toContain('suppressed');
  });
});
