import { describe, expect, it, jest } from '@jest/globals';

describe('executionLock', () => {
  it('suppresses concurrent duplicate starts with process mutex lock', async () => {
    jest.resetModules();
    const runtimeState = await import('../src/services/safety/runtimeState.js');
    runtimeState.resetSafetyRuntimeStateForTests();

    const executionLock = await import('../src/services/safety/executionLock.js');
    const firstLock = await executionLock.acquireExecutionLock('lock:process-only');
    expect(firstLock).not.toBeNull();

    const duplicateLock = await executionLock.acquireExecutionLock('lock:process-only');
    expect(duplicateLock).toBeNull();

    const snapshot = runtimeState.getSafetyRuntimeSnapshot();
    expect(snapshot.counters.duplicateSuppressions).toBeGreaterThanOrEqual(1);

    await firstLock?.release();
  });

  it('suppresses lock acquisition when advisory lock indicates duplicate cross-process execution', async () => {
    jest.resetModules();
    const queryMock = jest.fn(async () => ({ rows: [{ locked: false }] }));
    const releaseMock = jest.fn(() => undefined);
    const connectMock = jest.fn(async () => ({
      query: queryMock,
      release: releaseMock
    }));

    jest.unstable_mockModule('../src/db/client.js', () => ({
      getPool: () => ({
        connect: connectMock
      }),
      isDatabaseConnected: () => true
    }));

    const runtimeState = await import('../src/services/safety/runtimeState.js');
    runtimeState.resetSafetyRuntimeStateForTests();

    const executionLock = await import('../src/services/safety/executionLock.js');
    const advisoryLockResult = await executionLock.acquireExecutionLock('lock:advisory-duplicate');
    expect(advisoryLockResult).toBeNull();

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('pg_try_advisory_lock'),
      expect.any(Array)
    );
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(runtimeState.getSafetyRuntimeSnapshot().counters.duplicateSuppressions).toBeGreaterThanOrEqual(1);
  });
});
