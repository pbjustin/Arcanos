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

const {
  isTransactionCommitAmbiguousError,
  query,
  transaction,
  TRANSACTION_COMMIT_AMBIGUOUS_ERROR_CODE
} = await import('../src/core/db/query.js');
const { AUDITED_TRANSIENT_READ_QUERIES } =
  await import('../src/core/db/transientReadRegistry.js');
const AUDITED_TEST_READ =
  AUDITED_TRANSIENT_READ_QUERIES.BACKSTAGE_PROMPT_ROSTER_RECENT;

describe('db query helper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queryCacheGetMock.mockReset();
    queryCacheSetMock.mockReset();
    isDatabaseConnectedMock.mockReturnValue(true);
    getConfiguredLogLevelMock.mockReturnValue('info');
    getEnvNumberMock.mockReturnValue(50);
  });

  it('bypasses a populated query cache when the caller requires a fresh read', async () => {
    const staleResult = {
      rows: [{ name: 'Stale Wrestler', overall: 1 }],
      rowCount: 1
    };
    const freshResult = {
      rows: [{ name: 'Fresh Wrestler', overall: 99 }],
      rowCount: 1
    };
    const releaseMock = jest.fn();
    const clientQueryMock = jest.fn().mockResolvedValue(freshResult);
    const connectMock = jest.fn().mockResolvedValue({
      query: clientQueryMock,
      release: releaseMock
    });
    queryCacheGetMock.mockReturnValue(staleResult);
    getPoolMock.mockReturnValue({ connect: connectMock });

    await expect(query(
      'SELECT name, overall FROM backstage_wrestlers ORDER BY name ASC',
      [],
      { useCache: false }
    )).resolves.toBe(freshResult);

    expect(queryCacheGetMock).not.toHaveBeenCalled();
    expect(queryCacheSetMock).not.toHaveBeenCalled();
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(clientQueryMock).toHaveBeenCalledWith(
      'SELECT name, overall FROM backstage_wrestlers ORDER BY name ASC',
      []
    );
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('rolls back a transaction when a read fails after a successful write', async () => {
    const primaryError = new Error('injected transactional read failure');
    const releaseMock = jest.fn();
    const clientQueryMock = jest.fn().mockImplementation(async (sql: string) => {
      if (sql === 'SELECT name FROM backstage_wrestlers') {
        throw primaryError;
      }
      return { rows: [], rowCount: 0 };
    });
    const connectMock = jest.fn().mockResolvedValue({
      query: clientQueryMock,
      release: releaseMock
    });
    getPoolMock.mockReturnValue({ connect: connectMock });

    await expect(transaction(async client => {
      await client.query(
        'INSERT INTO backstage_wrestlers (name, overall) VALUES ($1, $2)',
        ['Atomic Wrestler', 90]
      );
      await client.query('SELECT name FROM backstage_wrestlers');
    })).rejects.toBe(primaryError);
    expect(isTransactionCommitAmbiguousError(primaryError)).toBe(false);

    expect(clientQueryMock.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'INSERT INTO backstage_wrestlers (name, overall) VALUES ($1, $2)',
      'SELECT name FROM backstage_wrestlers',
      'ROLLBACK'
    ]);
    expect(clientQueryMock).not.toHaveBeenCalledWith('COMMIT');
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('preserves the ambiguous commit cause when rollback also fails', async () => {
    const primaryError = Object.assign(new Error('commit acknowledgement lost'), {
      code: 'ECONNRESET'
    });
    const rollbackError = new Error('connection unavailable during rollback');
    const releaseMock = jest.fn();
    const clientQueryMock = jest.fn().mockImplementation(async (sql: string) => {
      if (sql === 'COMMIT') {
        throw primaryError;
      }
      if (sql === 'ROLLBACK') {
        throw rollbackError;
      }
      return { rows: [], rowCount: 0 };
    });
    const connectMock = jest.fn().mockResolvedValue({
      query: clientQueryMock,
      release: releaseMock
    });
    getPoolMock.mockReturnValue({ connect: connectMock });

    const observedError = await transaction(
      async () => 'result',
      { commitErrorMode: 'ambiguous' }
    ).then(
      () => null,
      (error: unknown) => error
    );

    expect(isTransactionCommitAmbiguousError(observedError)).toBe(true);
    expect(observedError).toMatchObject({
      code: TRANSACTION_COMMIT_AMBIGUOUS_ERROR_CODE,
      cause: primaryError
    });

    expect(clientQueryMock.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'COMMIT',
      'ROLLBACK'
    ]);
    expect(dbLoggerErrorMock).toHaveBeenCalledWith(
      'db.transaction.rollback_failed',
      { operation: 'transaction' },
      { message: rollbackError.message },
      rollbackError
    );
    expect(releaseMock).toHaveBeenCalledWith(rollbackError);
  });

  it('attempts rollback and preserves the error when commit acknowledgement fails', async () => {
    const commitError = new Error('injected commit acknowledgement failure');
    const releaseMock = jest.fn();
    const clientQueryMock = jest.fn().mockImplementation(async (sql: string) => {
      if (sql === 'COMMIT') {
        throw commitError;
      }
      return { rows: [], rowCount: 0 };
    });
    const connectMock = jest.fn().mockResolvedValue({
      query: clientQueryMock,
      release: releaseMock
    });
    getPoolMock.mockReturnValue({ connect: connectMock });

    await expect(transaction(async client => {
      await client.query(
        'INSERT INTO backstage_wrestlers (name, overall) VALUES ($1, $2)',
        ['Unconfirmed Wrestler', 90]
      );
    })).rejects.toBe(commitError);
    expect(isTransactionCommitAmbiguousError(commitError)).toBe(false);

    expect(clientQueryMock.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'INSERT INTO backstage_wrestlers (name, overall) VALUES ($1, $2)',
      'COMMIT',
      'ROLLBACK'
    ]);
    expect(releaseMock).toHaveBeenCalledTimes(1);
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
        {
          traceContext: {
            queryName: 'worker_runtime_snapshot_get',
            workerId: 'worker-1',
            source: 'worker-status'
          }
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
        durationMs: 85,
        durationKind: 'client_query_round_trip',
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
    } as unknown as NonNullable<Parameters<typeof query>[2]>['traceContext'];

    try {
      await expect(query(
        'SELECT 1',
        [],
        { traceContext: unsafeTraceContext }
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
        durationMs: 10,
        durationKind: 'client_query_round_trip',
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

  it('does not retry transient SELECT failures unless the caller explicitly opts in', async () => {
    const transientError = Object.assign(new Error('serialization failure'), { code: '40001' });
    const releaseMock = jest.fn();
    const clientQueryMock = jest.fn().mockRejectedValue(transientError);
    const connectMock = jest.fn().mockResolvedValue({
      query: clientQueryMock,
      release: releaseMock
    });
    getPoolMock.mockReturnValue({ connect: connectMock });

    await expect(query('SELECT id FROM jobs WHERE id = $1', ['job-1'])).rejects.toBe(transientError);

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(clientQueryMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(dbLoggerWarnMock).not.toHaveBeenCalledWith(
      'db.query.retry',
      expect.anything(),
      expect.anything()
    );
  });

  it('never retries a write under the default policy, including transient SQLSTATE failures', async () => {
    const transientError = Object.assign(new Error('connection failure'), { code: '08006' });
    const releaseMock = jest.fn();
    const clientQueryMock = jest.fn().mockRejectedValue(transientError);
    const connectMock = jest.fn().mockResolvedValue({
      query: clientQueryMock,
      release: releaseMock
    });
    getPoolMock.mockReturnValue({ connect: connectMock });

    await expect(query(
      'INSERT INTO jobs (id) VALUES ($1)',
      ['job-1']
    )).rejects.toBe(transientError);

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(clientQueryMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the audited retry registry fixed at seven immutable query identities', () => {
    const definitions = Object.values(AUDITED_TRANSIENT_READ_QUERIES);
    expect(definitions).toHaveLength(7);
    expect(new Set(definitions.map(definition => definition.id)).size).toBe(7);
    expect(Object.isFrozen(AUDITED_TRANSIENT_READ_QUERIES)).toBe(true);
    expect(definitions.every(definition => Object.isFrozen(definition))).toBe(true);
  });

  it.each(Object.values(AUDITED_TRANSIENT_READ_QUERIES))(
    'accepts audited normalized SQL identity $id',
    async (definition) => {
      const releaseMock = jest.fn();
      const clientQueryMock = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
      const connectMock = jest.fn().mockResolvedValue({
        query: clientQueryMock,
        release: releaseMock
      });
      getPoolMock.mockReturnValue({ connect: connectMock });
      const normalizedEquivalentSql = `  ${definition.sql.replace(/\s+/gu, '   ')}  `;

      await expect(query(
        normalizedEquivalentSql,
        [],
        {
          retry: 'transient-read',
          idempotent: true,
          auditedQueryId: definition.id
        }
      )).resolves.toMatchObject({ rowCount: 0 });

      expect(connectMock).toHaveBeenCalledTimes(1);
      expect(clientQueryMock).toHaveBeenCalledTimes(1);
      expect(releaseMock).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    '08000',
    '08001',
    '08003',
    '08006',
    '08007',
    '40001',
    '40P01',
    '55P03',
    '57P01',
    '57P02',
    '57P03'
  ])('retries an opted-in idempotent read for transient SQLSTATE %s', async (sqlState) => {
    const transientError = Object.assign(new Error('transient database failure'), { code: sqlState });
    const releaseMock = jest.fn();
    const clientQueryMock = jest.fn()
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce({ rows: [{ id: 'job-1' }], rowCount: 1 });
    const connectMock = jest.fn().mockResolvedValue({
      query: clientQueryMock,
      release: releaseMock
    });
    getPoolMock.mockReturnValue({ connect: connectMock });

    await expect(query(
      AUDITED_TEST_READ.sql,
      [],
      {
        retry: 'transient-read',
        idempotent: true,
        auditedQueryId: AUDITED_TEST_READ.id
      }
    )).resolves.toMatchObject({ rowCount: 1 });

    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(clientQueryMock).toHaveBeenCalledTimes(2);
    expect(releaseMock).toHaveBeenCalledTimes(2);
    expect(dbLoggerWarnMock).toHaveBeenCalledWith(
      'db.query.retry',
      expect.objectContaining({
        attempt: 1,
        sqlState,
        errorCategory: 'transient_sqlstate',
        maxAttempts: 3
      })
    );
  });

  it('stops an opted-in transient read after three total attempts', async () => {
    const transientError = Object.assign(new Error('database restarting'), { code: '57P03' });
    const releaseMock = jest.fn();
    const clientQueryMock = jest.fn().mockRejectedValue(transientError);
    const connectMock = jest.fn().mockResolvedValue({
      query: clientQueryMock,
      release: releaseMock
    });
    getPoolMock.mockReturnValue({ connect: connectMock });

    await expect(query(
      AUDITED_TEST_READ.sql,
      [],
      {
        retry: 'transient-read',
        idempotent: true,
        auditedQueryId: AUDITED_TEST_READ.id
      }
    )).rejects.toBe(transientError);

    expect(connectMock).toHaveBeenCalledTimes(3);
    expect(clientQueryMock).toHaveBeenCalledTimes(3);
    expect(releaseMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    Object.assign(new Error('missing relation'), { code: '42P01' }),
    Object.assign(new Error('query cancelled'), { code: '57014' }),
    Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
    Object.assign(new Error('server rejected connection'), { code: '08004' }),
    Object.assign(new Error('protocol violation'), { code: '08P01' })
  ])('does not retry an opted-in read for non-allowlisted errors', async (databaseError) => {
    const releaseMock = jest.fn();
    const clientQueryMock = jest.fn().mockRejectedValue(databaseError);
    const connectMock = jest.fn().mockResolvedValue({
      query: clientQueryMock,
      release: releaseMock
    });
    getPoolMock.mockReturnValue({ connect: connectMock });

    await expect(query(
      AUDITED_TEST_READ.sql,
      [],
      {
        retry: 'transient-read',
        idempotent: true,
        auditedQueryId: AUDITED_TEST_READ.id
      }
    )).rejects.toBe(databaseError);

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(clientQueryMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    'INSERT INTO jobs (id) VALUES ($1)',
    'WITH candidate AS (SELECT 1) SELECT * FROM candidate',
    'SELECT 1; SELECT 2',
    'SELECT id FROM jobs -- retry this',
    'SELECT id FROM jobs /* retry this */',
    'SELECT id INTO copied_jobs FROM jobs',
    'SELECT id FROM jobs FOR UPDATE',
    "SELECT nextval('jobs_id_seq')",
    'SELECT pg_advisory_lock(1)',
    'SELECT random()',
    "SELECT dblink_exec('foreign', 'DELETE FROM secrets')",
    'SELECT lo_unlink(42)',
    "SELECT pg_catalog.\"nextval\"('jobs_id_seq')",
    'SELECT unknown_extension_side_effect()'
  ])('rejects every non-audited retry SQL before acquiring a client: %s', async (sql) => {
    const connectMock = jest.fn();
    getPoolMock.mockReturnValue({ connect: connectMock });

    await expect(query(
      sql,
      ['job-1'],
      {
        retry: 'transient-read',
        idempotent: true,
        auditedQueryId: AUDITED_TEST_READ.id
      }
    )).rejects.toThrow('exact audited idempotent read query');

    expect(connectMock).not.toHaveBeenCalled();
  });

  it('rejects an untyped retry request that omits audited identity and idempotency', async () => {
    const connectMock = jest.fn();
    getPoolMock.mockReturnValue({ connect: connectMock });
    const unsafeOptions = {
      retry: 'transient-read'
    } as unknown as Parameters<typeof query>[2];

    await expect(query(
      AUDITED_TEST_READ.sql,
      [],
      unsafeOptions
    )).rejects.toThrow('exact audited idempotent read query');

    expect(connectMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown audited query id before acquiring a client', async () => {
    const connectMock = jest.fn();
    getPoolMock.mockReturnValue({ connect: connectMock });
    const unsafeOptions = {
      retry: 'transient-read',
      idempotent: true,
      auditedQueryId: 'unreviewed.query.v1'
    } as unknown as Parameters<typeof query>[2];

    await expect(query(
      AUDITED_TEST_READ.sql,
      [],
      unsafeOptions
    )).rejects.toThrow('exact audited idempotent read query');

    expect(connectMock).not.toHaveBeenCalled();
  });

  it('binds each audited query id to its exact normalized SQL identity', async () => {
    const connectMock = jest.fn();
    getPoolMock.mockReturnValue({ connect: connectMock });

    await expect(query(
      AUDITED_TEST_READ.sql,
      [],
      {
        retry: 'transient-read',
        idempotent: true,
        auditedQueryId:
          AUDITED_TRANSIENT_READ_QUERIES.BACKSTAGE_PROMPT_EVENTS_RECENT.id
      }
    )).rejects.toThrow('exact audited idempotent read query');

    expect(connectMock).not.toHaveBeenCalled();
  });

  it('does not expose error messages, errors, or parameters in retry telemetry', async () => {
    const errorMessageSentinel = 'private-error-message-value';
    const parameterSentinel = 'private-parameter-value';
    const transientError = Object.assign(new Error(errorMessageSentinel), { code: '40001' });
    const releaseMock = jest.fn();
    const clientQueryMock = jest.fn()
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    getPoolMock.mockReturnValue({
      connect: jest.fn().mockResolvedValue({
        query: clientQueryMock,
        release: releaseMock
      })
    });

    await query(
      AUDITED_TEST_READ.sql,
      [parameterSentinel],
      {
        retry: 'transient-read',
        idempotent: true,
        auditedQueryId: AUDITED_TEST_READ.id
      }
    );

    const retryTelemetry = JSON.stringify([
      ...dbLoggerErrorMock.mock.calls,
      ...dbLoggerWarnMock.mock.calls,
      ...recordDependencyCallMock.mock.calls
    ]);
    expect(retryTelemetry).not.toContain(errorMessageSentinel);
    expect(retryTelemetry).not.toContain(parameterSentinel);
    expect(releaseMock).toHaveBeenCalledTimes(2);
  });

  it('does not expose caller-controlled trace context in failure or retry telemetry', async () => {
    const traceQueryNameSentinel = 'private-trace-query-name';
    const traceSourceSentinel = 'private-trace-source';
    const traceWorkerSentinel = 'private-trace-worker';
    const transientError = Object.assign(new Error('serialization failure'), { code: '40001' });
    const releaseMock = jest.fn();
    const clientQueryMock = jest.fn()
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    getPoolMock.mockReturnValue({
      connect: jest.fn().mockResolvedValue({
        query: clientQueryMock,
        release: releaseMock
      })
    });

    await query(
      AUDITED_TEST_READ.sql,
      [],
      {
        retry: 'transient-read',
        idempotent: true,
        auditedQueryId: AUDITED_TEST_READ.id,
        traceContext: {
          queryName: traceQueryNameSentinel,
          source: traceSourceSentinel,
          workerId: traceWorkerSentinel
        }
      }
    );

    const retryTelemetry = JSON.stringify([
      ...dbLoggerErrorMock.mock.calls,
      ...dbLoggerWarnMock.mock.calls.filter(call => call[0] === 'db.query.retry'),
      ...recordDependencyCallMock.mock.calls.filter(call => call[0]?.outcome === 'error')
    ]);
    expect(retryTelemetry).not.toContain(traceQueryNameSentinel);
    expect(retryTelemetry).not.toContain(traceSourceSentinel);
    expect(retryTelemetry).not.toContain(traceWorkerSentinel);
    expect(releaseMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a pool acquisition failure for an opted-in audited read', async () => {
    const poolError = Object.assign(new Error('pool unavailable'), { code: '08006' });
    const connectMock = jest.fn().mockRejectedValue(poolError);
    const clientQueryMock = jest.fn();
    const releaseMock = jest.fn();
    getPoolMock.mockReturnValue({
      connect: connectMock,
      query: clientQueryMock,
      release: releaseMock
    });

    await expect(query(
      AUDITED_TEST_READ.sql,
      [],
      {
        retry: 'transient-read',
        idempotent: true,
        auditedQueryId: AUDITED_TEST_READ.id
      }
    )).rejects.toBe(poolError);

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(clientQueryMock).not.toHaveBeenCalled();
    expect(releaseMock).not.toHaveBeenCalled();
    expect(dbLoggerWarnMock.mock.calls.some(call => call[0] === 'db.query.retry')).toBe(false);
  });
});
