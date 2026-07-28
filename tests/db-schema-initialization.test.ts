import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Pool } from 'pg';

type QueryResult = {
  rows: Record<string, unknown>[];
  rowCount: number;
};

type QueryMock = jest.Mock<
  (sql: string, values?: readonly unknown[]) => Promise<QueryResult>
>;

interface PoolHarness {
  pool: Pool;
  queryMock: QueryMock;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function queryResult(
  rows: Record<string, unknown>[] = []
): QueryResult {
  return { rows, rowCount: rows.length };
}

function createPoolHarness(): PoolHarness {
  const queryMock = jest.fn<
    (sql: string, values?: readonly unknown[]) => Promise<QueryResult>
  >(async () => queryResult());
  return {
    pool: { query: queryMock } as unknown as Pool,
    queryMock
  };
}

let currentPool: Pool | null = null;
let connected = false;

const initializeDatabaseMock =
  jest.fn<(workerId?: string) => Promise<boolean>>();
const closeDatabaseMock = jest.fn<() => Promise<void>>();
const closePoolIfCurrentMock =
  jest.fn<(pool: Pool) => Promise<boolean>>(async () => false);

jest.unstable_mockModule('../src/core/db/client.js', () => ({
  initializeDatabase: initializeDatabaseMock,
  getPool: () => currentPool,
  isDatabaseConnected: () => connected,
  getStatus: () => ({
    connected,
    hasPool: currentPool !== null,
    error: null
  }),
  close: closeDatabaseMock,
  closePoolIfCurrent: closePoolIfCurrentMock
}));

const {
  TABLE_DEFINITIONS,
  initializeTables,
  isDatabaseSchemaReady
} = await import('../src/core/db/schema.js');
const { initializeDatabaseWithSchema } = await import(
  '../src/core/db/index.js'
);

beforeEach(() => {
  currentPool = null;
  connected = false;
  initializeDatabaseMock.mockReset();
  initializeDatabaseMock.mockResolvedValue(false);
  closeDatabaseMock.mockReset();
  closePoolIfCurrentMock.mockClear();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('central database schema initialization', () => {
  it('returns false without a pool and does not record readiness', async () => {
    await expect(initializeTables()).resolves.toBe(false);
    expect(isDatabaseSchemaReady()).toBe(false);
  });

  it('shares one promise per pool and skips DDL after that pool is ready', async () => {
    const harness = createPoolHarness();
    const firstQuery = deferred<QueryResult>();
    harness.queryMock.mockImplementationOnce(() => firstQuery.promise);
    currentPool = harness.pool;
    connected = true;

    const first = initializeTables();
    const concurrent = initializeTables();

    expect(concurrent).toBe(first);
    expect(harness.queryMock).toHaveBeenCalledTimes(1);

    firstQuery.resolve(queryResult());
    await expect(Promise.all([first, concurrent])).resolves.toEqual([
      true,
      true
    ]);
    expect(harness.queryMock).toHaveBeenCalledTimes(TABLE_DEFINITIONS.length);
    expect(isDatabaseSchemaReady()).toBe(true);

    await expect(initializeTables()).resolves.toBe(true);
    expect(harness.queryMock).toHaveBeenCalledTimes(TABLE_DEFINITIONS.length);

    connected = false;
    await expect(initializeTables()).resolves.toBe(false);
    expect(isDatabaseSchemaReady()).toBe(false);
    expect(harness.queryMock).toHaveBeenCalledTimes(TABLE_DEFINITIONS.length);

    connected = true;
    await expect(initializeTables()).resolves.toBe(true);
    expect(isDatabaseSchemaReady()).toBe(true);
    expect(harness.queryMock).toHaveBeenCalledTimes(TABLE_DEFINITIONS.length);
  });

  it('rejects all waiters, clears the pending entry, and retries after failure', async () => {
    const harness = createPoolHarness();
    const schemaError = new Error('schema initialization failed');
    harness.queryMock.mockRejectedValueOnce(schemaError);
    currentPool = harness.pool;
    connected = true;

    const first = initializeTables();
    const concurrent = initializeTables();
    expect(concurrent).toBe(first);

    const outcomes = await Promise.allSettled([first, concurrent]);
    expect(outcomes).toEqual([
      expect.objectContaining({ status: 'rejected', reason: schemaError }),
      expect.objectContaining({ status: 'rejected', reason: schemaError })
    ]);
    expect(isDatabaseSchemaReady()).toBe(false);

    harness.queryMock.mockResolvedValue(queryResult());
    await expect(initializeTables()).resolves.toBe(true);
    expect(harness.queryMock).toHaveBeenCalledTimes(
      TABLE_DEFINITIONS.length + 1
    );
    expect(isDatabaseSchemaReady()).toBe(true);
  });

  it('initializes a replacement independently while an older pool is pending', async () => {
    const firstPool = createPoolHarness();
    const replacementPool = createPoolHarness();
    const firstQuery = deferred<QueryResult>();
    firstPool.queryMock.mockImplementationOnce(() => firstQuery.promise);
    currentPool = firstPool.pool;
    connected = true;

    const olderInitialization = initializeTables();
    currentPool = replacementPool.pool;
    const replacementInitialization = initializeTables();

    expect(replacementInitialization).not.toBe(olderInitialization);
    await expect(replacementInitialization).resolves.toBe(true);
    expect(isDatabaseSchemaReady()).toBe(true);

    firstQuery.resolve(queryResult());
    await expect(olderInitialization).resolves.toBe(false);
    expect(currentPool).toBe(replacementPool.pool);
    expect(isDatabaseSchemaReady()).toBe(true);
  });

  it('reuses each exact pending promise across an A to B to A flip', async () => {
    const firstPool = createPoolHarness();
    const replacementPool = createPoolHarness();
    const firstPoolQuery = deferred<QueryResult>();
    const replacementPoolQuery = deferred<QueryResult>();
    firstPool.queryMock.mockImplementationOnce(() => firstPoolQuery.promise);
    replacementPool.queryMock.mockImplementationOnce(
      () => replacementPoolQuery.promise
    );
    connected = true;

    currentPool = firstPool.pool;
    const firstPoolInitialization = initializeTables();
    currentPool = replacementPool.pool;
    const replacementInitialization = initializeTables();
    currentPool = firstPool.pool;

    expect(initializeTables()).toBe(firstPoolInitialization);
    expect(firstPool.queryMock).toHaveBeenCalledTimes(1);
    currentPool = replacementPool.pool;
    expect(initializeTables()).toBe(replacementInitialization);
    expect(replacementPool.queryMock).toHaveBeenCalledTimes(1);

    replacementPoolQuery.resolve(queryResult());
    await expect(replacementInitialization).resolves.toBe(true);
    expect(isDatabaseSchemaReady()).toBe(true);

    currentPool = firstPool.pool;
    expect(initializeTables()).toBe(firstPoolInitialization);
    firstPoolQuery.resolve(queryResult());
    await expect(firstPoolInitialization).resolves.toBe(true);
    expect(isDatabaseSchemaReady()).toBe(true);
    expect(firstPool.queryMock).toHaveBeenCalledTimes(TABLE_DEFINITIONS.length);

    currentPool = replacementPool.pool;
    await expect(initializeTables()).resolves.toBe(true);
    expect(replacementPool.queryMock).toHaveBeenCalledTimes(
      TABLE_DEFINITIONS.length
    );
  });

  it('does not let obsolete completion mark an A to B to A pool flip ready', async () => {
    const firstPool = createPoolHarness();
    const replacementPool = createPoolHarness();
    const firstQuery = deferred<QueryResult>();
    firstPool.queryMock.mockImplementationOnce(() => firstQuery.promise);
    currentPool = firstPool.pool;
    connected = true;

    const obsoleteInitialization = initializeTables();
    currentPool = replacementPool.pool;
    firstQuery.resolve(queryResult());
    await expect(obsoleteInitialization).resolves.toBe(false);
    expect(isDatabaseSchemaReady()).toBe(false);

    currentPool = firstPool.pool;
    expect(isDatabaseSchemaReady()).toBe(false);
    await expect(initializeTables()).resolves.toBe(true);
    expect(firstPool.queryMock).toHaveBeenCalledTimes(
      TABLE_DEFINITIONS.length * 2
    );

    currentPool = replacementPool.pool;
    await expect(initializeTables()).resolves.toBe(true);
    expect(replacementPool.queryMock).toHaveBeenCalledTimes(
      TABLE_DEFINITIONS.length
    );

    currentPool = firstPool.pool;
    expect(isDatabaseSchemaReady()).toBe(true);
    await expect(initializeTables()).resolves.toBe(true);
    expect(firstPool.queryMock).toHaveBeenCalledTimes(
      TABLE_DEFINITIONS.length * 2
    );
  });

  it('does not mark a pool ready when connectivity is lost during DDL', async () => {
    const harness = createPoolHarness();
    const firstQuery = deferred<QueryResult>();
    harness.queryMock.mockImplementationOnce(() => firstQuery.promise);
    currentPool = harness.pool;
    connected = true;

    const initialization = initializeTables();
    connected = false;
    firstQuery.resolve(queryResult());

    await expect(initialization).resolves.toBe(false);
    expect(isDatabaseSchemaReady()).toBe(false);

    connected = true;
    await expect(initializeTables()).resolves.toBe(true);
    expect(isDatabaseSchemaReady()).toBe(true);
  });
});

describe('database startup schema readiness', () => {
  it('reuses a connected pool and emits its heartbeat only after readiness', async () => {
    const harness = createPoolHarness();
    harness.queryMock.mockImplementation(async sql => {
      if (sql.includes('pg_database_collation_actual_version')) {
        return queryResult([{
          configured_version: '2.36',
          actual_version: '2.36'
        }]);
      }
      return queryResult();
    });
    currentPool = harness.pool;
    connected = true;

    await expect(
      initializeDatabaseWithSchema('schema-startup-worker')
    ).resolves.toBe(true);

    expect(initializeDatabaseMock).not.toHaveBeenCalled();
    expect(isDatabaseSchemaReady()).toBe(true);
    expect(harness.queryMock).toHaveBeenCalledTimes(
      TABLE_DEFINITIONS.length + 2
    );
    expect(harness.queryMock.mock.calls[0][0]).toContain(
      'pg_database_collation_actual_version'
    );
    expect(harness.queryMock.mock.calls.at(-1)?.[0]).toContain(
      'INSERT INTO execution_logs'
    );

    harness.queryMock.mockClear();
    await expect(
      initializeDatabaseWithSchema('schema-startup-worker')
    ).resolves.toBe(true);
    expect(harness.queryMock).toHaveBeenCalledTimes(2);
    expect(harness.queryMock.mock.calls[0][0]).toContain(
      'pg_database_collation_actual_version'
    );
    expect(harness.queryMock.mock.calls[1][0]).toContain(
      'INSERT INTO execution_logs'
    );
  });

  it('connects only when needed and returns false when no pool is established', async () => {
    const harness = createPoolHarness();
    harness.queryMock.mockImplementation(async sql => {
      if (sql.includes('pg_database_collation_actual_version')) {
        return queryResult([{
          configured_version: '2.36',
          actual_version: '2.36'
        }]);
      }
      return queryResult();
    });
    initializeDatabaseMock.mockImplementationOnce(async () => {
      currentPool = harness.pool;
      connected = true;
      return true;
    });

    await expect(initializeDatabaseWithSchema()).resolves.toBe(true);
    expect(initializeDatabaseMock).toHaveBeenCalledTimes(1);
    expect(harness.queryMock).toHaveBeenCalledTimes(
      TABLE_DEFINITIONS.length + 1
    );

    currentPool = null;
    connected = false;
    initializeDatabaseMock.mockResolvedValueOnce(false);
    await expect(initializeDatabaseWithSchema()).resolves.toBe(false);
  });

  it('returns false and skips DDL and heartbeat when the pool changes during inspection', async () => {
    const initialPool = createPoolHarness();
    const replacementPool = createPoolHarness();
    initialPool.queryMock.mockImplementationOnce(async () => {
      currentPool = replacementPool.pool;
      return queryResult([{
        configured_version: '2.36',
        actual_version: '2.36'
      }]);
    });
    currentPool = initialPool.pool;
    connected = true;

    await expect(
      initializeDatabaseWithSchema('schema-startup-worker')
    ).resolves.toBe(false);

    expect(initialPool.queryMock).toHaveBeenCalledTimes(1);
    expect(replacementPool.queryMock).not.toHaveBeenCalled();
    expect(isDatabaseSchemaReady()).toBe(false);
  });
});
