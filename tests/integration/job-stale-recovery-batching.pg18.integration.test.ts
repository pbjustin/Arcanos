import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Client, Pool, type PoolClient } from 'pg';
import { resolvePostgresTestDatabaseUrl } from './postgresTestDatabase.js';

const TEST_DATABASE_ENV = 'JOB_STALE_RECOVERY_TEST_DATABASE_URL';
const EXPECTED_DATABASE_NAME = 'arcanos_audit_pg18_20260727';
const configuredConnectionString =
  resolvePostgresTestDatabaseUrl(TEST_DATABASE_ENV);

interface DisposableDatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

interface SelectorCoordination {
  selectorCount: number;
  firstLocked: Deferred<void>;
  releaseFirst: Deferred<void>;
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>(resolve => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function decodeConnectionComponent(value: string, component: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error(`${TEST_DATABASE_ENV} contains an invalid encoded ${component}.`);
  }

  if (!decoded || /[\u0000-\u001f\u007f]/u.test(decoded)) {
    throw new Error(
      `${TEST_DATABASE_ENV} must include a non-empty ${component} without control characters.`
    );
  }
  return decoded;
}

function validateDisposableConnectionString(value: string): DisposableDatabaseConfig {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${TEST_DATABASE_ENV} must be a valid PostgreSQL URL.`);
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(`${TEST_DATABASE_ENV} must use postgres:// or postgresql://.`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`${TEST_DATABASE_ENV} must not include query parameters or a fragment.`);
  }

  const host = parsed.hostname.toLowerCase();
  if (!new Set(['localhost', '127.0.0.1', '::1', '[::1]']).has(host)) {
    throw new Error(`${TEST_DATABASE_ENV} must target a loopback host.`);
  }
  if (!parsed.port || !/^\d+$/u.test(parsed.port)) {
    throw new Error(`${TEST_DATABASE_ENV} must include an explicit numeric port.`);
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${TEST_DATABASE_ENV} must include a valid TCP port.`);
  }

  let databasePath: string;
  try {
    databasePath = decodeURIComponent(parsed.pathname);
  } catch {
    throw new Error(`${TEST_DATABASE_ENV} contains an invalid encoded database.`);
  }
  if (databasePath !== `/${EXPECTED_DATABASE_NAME}`) {
    throw new Error(`${TEST_DATABASE_ENV} must target disposable database ${EXPECTED_DATABASE_NAME}.`);
  }

  return {
    host,
    port,
    database: databasePath.slice(1),
    user: decodeConnectionComponent(parsed.username, 'username'),
    password: decodeConnectionComponent(parsed.password, 'password')
  };
}

const databaseConfig = configuredConnectionString
  ? validateDisposableConnectionString(configuredConnectionString)
  : null;
const describeWithDatabase = databaseConfig ? describe : describe.skip;
const schemaName = `job_stale_recovery_${randomUUID().replaceAll('-', '')}`;
const quotedSchema = `"${schemaName}"`;

let databasePool: Pool;
let setupClient: Client;
let selectorCoordination: SelectorCoordination | null = null;

function isRecoverySelector(sql: unknown): sql is string {
  return typeof sql === 'string' && sql.includes('FROM job_data') && sql.includes('FOR UPDATE');
}

function wrapPoolClient(client: PoolClient): {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
  release: () => void;
} {
  return {
    query: async (sql: string, params: unknown[] = []) => {
      const result = await client.query(sql, params);
      if (sql === 'BEGIN' && selectorCoordination) {
        await client.query("SET LOCAL lock_timeout = '500ms'");
        await client.query("SET LOCAL statement_timeout = '5s'");
      }
      if (selectorCoordination && isRecoverySelector(sql)) {
        selectorCoordination.selectorCount += 1;
        if (selectorCoordination.selectorCount === 1) {
          selectorCoordination.firstLocked.resolve(undefined);
          await selectorCoordination.releaseFirst.promise;
        }
      }
      return result;
    },
    release: () => client.release()
  };
}

const getPoolMock = jest.fn(() => ({
  connect: async () => {
    const client = await databasePool.connect();
    await client.query(`SET search_path TO ${quotedSchema}, public`);
    return wrapPoolClient(client);
  }
}));
const repositoryQueryMock = jest.fn(async () => ({ rows: [] }));
const recordJobEventMock = jest.fn(async () => ({ inserted: true as const }));

jest.unstable_mockModule('@core/db/client.js', () => ({
  getPool: getPoolMock,
  isDatabaseConnected: () => true
}));
jest.unstable_mockModule('@core/db/query.js', () => ({ query: repositoryQueryMock }));
jest.unstable_mockModule(
  '../../src/core/db/repositories/jobEventRepository.js',
  () => ({ recordJobEvent: recordJobEventMock })
);

const { recoverStalledJobsForWorkers, recoverStaleJobs } = await import(
  '../../src/core/db/repositories/jobRepository.js'
);

interface StaleJobInput {
  id: string;
  updatedMinutesAgo: number | null;
  jobType?: string;
  lastWorkerId?: string;
  retryCount?: number;
  maxRetries?: number;
  cancelRequested?: boolean;
}

async function insertStaleJob(input: StaleJobInput): Promise<void> {
  await setupClient.query(
    `INSERT INTO job_data (
       id, worker_id, job_type, status, retry_count, max_retries,
       next_run_at, started_at, last_heartbeat_at, lease_expires_at,
       last_worker_id, claim_generation, correlation_id, autonomy_state,
       cancel_requested_at, cancel_reason, updated_at
     ) VALUES (
       $1, 'producer', $2, 'running', $3, $4,
       NOW(), NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours',
       NOW() - INTERVAL '1 hour', $5, 1, $1, '{}'::jsonb,
       CASE WHEN $6::boolean THEN NOW() - INTERVAL '1 minute' ELSE NULL END,
       CASE WHEN $6::boolean THEN 'operator cancellation' ELSE NULL END,
       CASE WHEN $7::int IS NULL THEN NULL ELSE NOW() - ($7::int * INTERVAL '1 minute') END
     )`,
    [
      input.id,
      input.jobType ?? 'ask',
      input.retryCount ?? 0,
      input.maxRetries ?? 3,
      input.lastWorkerId ?? 'worker-stale',
      input.cancelRequested ?? false,
      input.updatedMinutesAgo
    ]
  );
}

describe('stale recovery disposable database guard', () => {
  test('accepts only the exact loopback PostgreSQL 18 test database shape', () => {
    expect(validateDisposableConnectionString(
      'postgresql://audit%2Duser:p%40ss@127.0.0.1:55432/arcanos_audit_pg18_20260727'
    )).toEqual({
      host: '127.0.0.1',
      port: 55_432,
      database: EXPECTED_DATABASE_NAME,
      user: 'audit-user',
      password: 'p@ss'
    });
  });

  test.each([
    `postgresql://audit:secret@db.example.test:55432/${EXPECTED_DATABASE_NAME}`,
    `postgresql://audit:secret@127.0.0.1/${EXPECTED_DATABASE_NAME}`,
    'postgresql://audit:secret@127.0.0.1:55432/postgres',
    `postgresql://audit:secret@127.0.0.1:55432/${EXPECTED_DATABASE_NAME}?host=example.test`,
    `postgresql://127.0.0.1:55432/${EXPECTED_DATABASE_NAME}`
  ])('rejects an unsafe or incomplete target: %s', value => {
    expect(() => validateDisposableConnectionString(value)).toThrow();
  });
});

describeWithDatabase('bounded stale recovery on PostgreSQL 18', () => {
  beforeAll(async () => {
    setupClient = new Client({ ...databaseConfig!, ssl: false });
    await setupClient.connect();
    const version = await setupClient.query<{ server_version_num: string }>(
      "SELECT current_setting('server_version_num') AS server_version_num"
    );
    expect(Number(version.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(180_000);
    expect(Number(version.rows[0]?.server_version_num)).toBeLessThan(190_000);

    await setupClient.query(`CREATE SCHEMA ${quotedSchema}`);
    await setupClient.query(`SET search_path TO ${quotedSchema}, public`);
    await setupClient.query(
      `CREATE TABLE job_data (
         id TEXT PRIMARY KEY,
         worker_id TEXT NOT NULL,
         job_type TEXT NOT NULL,
         status TEXT NOT NULL,
         retry_count INTEGER NOT NULL DEFAULT 0,
         max_retries INTEGER,
         next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         started_at TIMESTAMPTZ,
         last_heartbeat_at TIMESTAMPTZ,
         lease_expires_at TIMESTAMPTZ,
         last_worker_id TEXT,
         claim_generation BIGINT NOT NULL DEFAULT 0,
         correlation_id TEXT,
         autonomy_state JSONB NOT NULL DEFAULT '{}'::jsonb,
         cancel_requested_at TIMESTAMPTZ,
         cancel_reason TEXT,
         error_message TEXT,
         completed_at TIMESTAMPTZ,
         idempotency_until TIMESTAMPTZ,
         retention_until TIMESTAMPTZ,
         expires_at TIMESTAMPTZ,
         updated_at TIMESTAMPTZ
       )`
    );
    databasePool = new Pool({ ...databaseConfig!, ssl: false, max: 4 });
  });

  beforeEach(async () => {
    selectorCoordination = null;
    jest.clearAllMocks();
    await setupClient.query('TRUNCATE job_data');
  });

  afterAll(async () => {
    selectorCoordination?.releaseFirst.resolve(undefined);
    await databasePool?.end();
    if (setupClient) {
      await setupClient.query('RESET search_path');
      await setupClient.query(`DROP SCHEMA ${quotedSchema} CASCADE`);
      await setupClient.end();
    }
  });

  test('recovers one oldest-first batch per call and drains overflow later', async () => {
    await insertStaleJob({
      id: 'local-agent-oldest',
      updatedMinutesAgo: null,
      jobType: 'local-agent'
    });
    await insertStaleJob({ id: 'job-null', updatedMinutesAgo: null });
    await insertStaleJob({ id: 'job-01', updatedMinutesAgo: 60 });
    await insertStaleJob({ id: 'job-02', updatedMinutesAgo: 60 });
    await insertStaleJob({ id: 'job-03', updatedMinutesAgo: 40 });
    await insertStaleJob({ id: 'job-04', updatedMinutesAgo: 30 });
    await setupClient.query(
      `UPDATE job_data
       SET updated_at = NOW() - INTERVAL '60 minutes'
       WHERE id IN ('job-01', 'job-02')`
    );

    const first = await recoverStaleJobs({ staleAfterMs: 60_000, batchSize: 2 });
    const second = await recoverStaleJobs({ staleAfterMs: 60_000, batchSize: 2 });
    const third = await recoverStaleJobs({ staleAfterMs: 60_000, batchSize: 2 });
    const empty = await recoverStaleJobs({ staleAfterMs: 60_000, batchSize: 2 });

    expect(first.recoveredJobs).toEqual(['job-null', 'job-01']);
    expect(second.recoveredJobs).toEqual(['job-02', 'job-03']);
    expect(third.recoveredJobs).toEqual(['job-04']);
    expect(empty.recoveredJobs).toEqual([]);
    const rows = await setupClient.query<{ id: string; status: string }>(
      'SELECT id, status FROM job_data ORDER BY id'
    );
    expect(rows.rows.find(row => row.id === 'local-agent-oldest')).toEqual({
      id: 'local-agent-oldest',
      status: 'running'
    });
    expect(rows.rows.filter(row => row.id.startsWith('job-')).every(row => row.status === 'pending'))
      .toBe(true);
  });

  test('preserves cancellation precedence, retry requeue, and exhausted dead-letter behavior', async () => {
    await insertStaleJob({
      id: 'branch-01-cancel',
      updatedMinutesAgo: 60,
      retryCount: 3,
      maxRetries: 3,
      cancelRequested: true
    });
    await insertStaleJob({
      id: 'branch-02-fail',
      updatedMinutesAgo: 50,
      retryCount: 1,
      maxRetries: 1
    });
    await insertStaleJob({
      id: 'branch-03-requeue',
      updatedMinutesAgo: 40,
      retryCount: 0,
      maxRetries: 2
    });

    const result = await recoverStaleJobs({ staleAfterMs: 60_000, batchSize: 3 });
    expect(result).toEqual({
      recoveredJobs: ['branch-03-requeue'],
      failedJobs: ['branch-02-fail'],
      cancelledJobs: ['branch-01-cancel']
    });

    const rows = await setupClient.query<{ id: string; status: string; retry_count: number }>(
      'SELECT id, status, retry_count FROM job_data ORDER BY id'
    );
    expect(rows.rows).toEqual([
      { id: 'branch-01-cancel', status: 'cancelled', retry_count: 3 },
      { id: 'branch-02-fail', status: 'failed', retry_count: 1 },
      { id: 'branch-03-requeue', status: 'pending', retry_count: 1 }
    ]);
  });

  test('lets overlapping global and worker-specific passes claim disjoint batches', async () => {
    for (let index = 1; index <= 6; index += 1) {
      await insertStaleJob({
        id: `overlap-0${index}`,
        updatedMinutesAgo: 70 - index,
        lastWorkerId: 'worker-overlap'
      });
    }

    const coordination: SelectorCoordination = {
      selectorCount: 0,
      firstLocked: createDeferred<void>(),
      releaseFirst: createDeferred<void>()
    };
    selectorCoordination = coordination;

    const globalPromise = recoverStaleJobs({ staleAfterMs: 60_000, batchSize: 3 });
    await coordination.firstLocked.promise;
    const targetedPromise = recoverStalledJobsForWorkers({
      workerIds: ['worker-overlap'],
      staleAfterMs: 60_000,
      batchSize: 3,
      stalledJobAction: 'requeue'
    });

    let targetedOutcome:
      | { result: Awaited<typeof targetedPromise>; error?: never }
      | { result?: never; error: unknown };
    try {
      targetedOutcome = await targetedPromise.then(
        result => ({ result }),
        error => ({ error })
      );
    } finally {
      coordination.releaseFirst.resolve(undefined);
    }
    const globalResult = await globalPromise;
    selectorCoordination = null;

    expect(targetedOutcome.error).toBeUndefined();
    const globalIds = globalResult.recoveredJobs;
    const targetedIds = targetedOutcome.result?.requeuedJobIds ?? [];
    expect(globalIds).toHaveLength(3);
    expect(targetedIds).toHaveLength(3);
    expect(globalIds.filter(id => targetedIds.includes(id))).toEqual([]);
    expect([...globalIds, ...targetedIds].sort()).toEqual([
      'overlap-01',
      'overlap-02',
      'overlap-03',
      'overlap-04',
      'overlap-05',
      'overlap-06'
    ]);
  }, 15_000);
});
