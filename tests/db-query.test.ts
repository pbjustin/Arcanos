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
      await query(
        'SELECT * FROM worker_runtime_snapshots WHERE worker_id = $1',
        ['worker-1'],
        1,
        false,
        {
          queryName: 'worker_runtime_snapshot_get',
          workerId: 'worker-1',
          source: 'worker-status'
        }
      );
    } finally {
      dateNowSpy.mockRestore();
    }

    expect(dbLoggerWarnMock).toHaveBeenCalledWith(
      'db.query.slow',
      expect.objectContaining({
        operation: 'select',
        queryHash: expect.any(String),
        durationMs: 145,
        durationKind: 'app_wall_clock',
        measurementKind: 'client_wall_clock',
        slowThresholdMs: 50,
        slowReasons: ['connection_acquisition', 'client_query_round_trip', 'app_wall_clock'],
        connectionAcquireMs: 60,
        clientQueryRoundTripMs: 85,
        appWallClockMs: 145,
        postgresExecutionMs: null,
        postgresExecutionKnown: false,
        rowCount: 1,
        queryName: 'worker_runtime_snapshot_get',
        workerId: 'worker-1',
        source: 'worker-status'
      })
    );
    expect(dbLoggerWarnMock.mock.calls[0]?.[1]).not.toHaveProperty('text');
    expect(dbLoggerWarnMock.mock.calls[0]?.[1]).not.toHaveProperty('sql');
    expect(dbLoggerWarnMock.mock.calls[0]?.[1]).not.toHaveProperty('params');
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('ignores non-string trace context values without throwing', async () => {
    const releaseMock = jest.fn();
    const clientQueryMock = jest.fn().mockResolvedValue({
      rows: [{ ok: true }],
      rowCount: 1
    });
    getPoolMock.mockReturnValue({
      connect: jest.fn().mockResolvedValue({
        query: clientQueryMock,
        release: releaseMock
      })
    });
    const timestamps = [2_000, 2_000, 2_000, 2_060];
    const dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => timestamps.shift() ?? 2_060);
    const unsafeTraceContext = {
      queryName: 42,
      source: { nested: true },
      workerId: null
    } as unknown as Parameters<typeof query>[4];

    try {
      await expect(query(
        'SELECT 1',
        [],
        1,
        false,
        unsafeTraceContext
      )).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      dateNowSpy.mockRestore();
    }

    const slowLogContext = dbLoggerWarnMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(slowLogContext).not.toHaveProperty('queryName');
    expect(slowLogContext).not.toHaveProperty('source');
    expect(slowLogContext).not.toHaveProperty('workerId');
    expect(slowLogContext).toEqual(expect.objectContaining({
      operation: 'select',
      durationMs: 60,
      clientQueryRoundTripMs: 60,
      appWallClockMs: 60,
      slowReasons: ['client_query_round_trip', 'app_wall_clock'],
      rowCount: 1
    }));
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('labels slow connection acquisition separately from query round trip', async () => {
    const releaseMock = jest.fn();
    const clientQueryMock = jest.fn().mockResolvedValue({
      rows: [],
      rowCount: null
    });
    getPoolMock.mockReturnValue({
      connect: jest.fn().mockResolvedValue({
        query: clientQueryMock,
        release: releaseMock
      })
    });
    const timestamps = [3_000, 3_080, 3_080, 3_090];
    const dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => timestamps.shift() ?? 3_090);

    try {
      await query('SELECT 1');
    } finally {
      dateNowSpy.mockRestore();
    }

    expect(dbLoggerWarnMock).toHaveBeenCalledWith(
      'db.query.slow',
      expect.objectContaining({
        connectionAcquireMs: 80,
        clientQueryRoundTripMs: 10,
        appWallClockMs: 90,
        slowReasons: ['connection_acquisition', 'app_wall_clock'],
        postgresExecutionKnown: false,
        postgresExecutionMs: null,
        rowCount: null
      })
    );
    expect(dbLoggerWarnMock.mock.calls[0]?.[1]).not.toHaveProperty('sql');
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });
});
