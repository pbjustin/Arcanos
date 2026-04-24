import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getPoolMock = jest.fn();
const isDatabaseConnectedMock = jest.fn();
const dbLoggerDebugMock = jest.fn();
const dbLoggerErrorMock = jest.fn();
const dbLoggerWarnMock = jest.fn();
const getConfiguredLogLevelMock = jest.fn();
const queryCacheGetMock = jest.fn();
const queryCacheSetMock = jest.fn();
const getEnvNumberMock = jest.fn();
const recordDependencyCallMock = jest.fn();

jest.unstable_mockModule('@core/db/client.js', () => ({
  getPool: getPoolMock,
  isDatabaseConnected: isDatabaseConnectedMock
}));

jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
  LogLevel: {
    DEBUG: 'debug'
  },
  dbLogger: {
    debug: dbLoggerDebugMock,
    error: dbLoggerErrorMock,
    warn: dbLoggerWarnMock
  },
  getConfiguredLogLevel: getConfiguredLogLevelMock
}));

jest.unstable_mockModule('@platform/resilience/cache.js', () => ({
  queryCache: {
    get: queryCacheGetMock,
    set: queryCacheSetMock
  }
}));

jest.unstable_mockModule('@platform/runtime/env.js', () => ({
  getEnvNumber: getEnvNumberMock
}));

jest.unstable_mockModule('@platform/observability/appMetrics.js', () => ({
  recordDependencyCall: recordDependencyCallMock
}));

getEnvNumberMock.mockReturnValue(50);
getConfiguredLogLevelMock.mockReturnValue('info');

const { query } = await import('../src/core/db/query.js');

describe('db query helper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isDatabaseConnectedMock.mockReturnValue(true);
    getConfiguredLogLevelMock.mockReturnValue('info');
    getEnvNumberMock.mockReturnValue(50);
  });

  it('logs pool wait and execution timing without raw SQL', async () => {
    const releaseMock = jest.fn();
    const clientQueryMock = jest.fn().mockResolvedValue({
      rows: [{ id: 1 }],
      rowCount: 1
    });
    getPoolMock.mockReturnValue({
      connect: jest.fn().mockResolvedValue({
        query: clientQueryMock,
        release: releaseMock
      })
    });
    const timestamps = [1_000, 1_060, 1_060, 1_145];
    const dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => timestamps.shift() ?? 1_145);

    try {
      await query('SELECT * FROM worker_runtime_snapshots WHERE worker_id = $1', ['worker-1']);
    } finally {
      dateNowSpy.mockRestore();
    }

    expect(dbLoggerWarnMock).toHaveBeenCalledWith(
      'db.query.slow',
      expect.objectContaining({
        operation: 'select',
        queryHash: expect.any(String),
        durationMs: 85,
        executionMs: 85,
        poolWaitMs: 60,
        totalMs: 145,
        rowCount: 1
      })
    );
    expect(dbLoggerWarnMock.mock.calls[0]?.[1]).not.toHaveProperty('text');
    expect(dbLoggerWarnMock.mock.calls[0]?.[1]).not.toHaveProperty('sql');
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });
});
