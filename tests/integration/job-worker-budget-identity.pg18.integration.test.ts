import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Client } from 'pg';

const TEST_DATABASE_ENV = 'JOB_WORKER_BUDGET_TEST_DATABASE_URL';
const REQUIRE_DATABASE_ENV = 'JOB_WORKER_BUDGET_REQUIRE_DATABASE';
const EXPECTED_DATABASE_NAME = 'arcanos_audit_pg18_20260727';
const configuredConnectionString = process.env[TEST_DATABASE_ENV]?.trim() ?? '';
const databaseRequired = process.env[REQUIRE_DATABASE_ENV] === '1';

if (databaseRequired && !configuredConnectionString) {
  throw new Error(`${REQUIRE_DATABASE_ENV}=1 requires ${TEST_DATABASE_ENV}.`);
}

interface DisposableDatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
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

  const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  const host = parsed.hostname.toLowerCase();
  if (!loopbackHosts.has(host)) {
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
const schemaName = `job_worker_budget_${randomUUID().replaceAll('-', '')}`;
const quotedSchema = `"${schemaName}"`;
const migrationDirectory = resolve(
  process.cwd(),
  'migrations/20260801_job_worker_stats_identity_v1'
);
const migrationPhases = [
  '01_add_stats_worker_id.sql',
  '02_precheck_stats_worker_index.sql',
  '03_create_stats_worker_index.sql',
  '04_verify_stats_worker_index.sql'
] as const;

const addColumnSql = readFileSync(resolve(migrationDirectory, '01_add_stats_worker_id.sql'), 'utf8');
const precheckIndexSql = readFileSync(
  resolve(migrationDirectory, '02_precheck_stats_worker_index.sql'),
  'utf8'
);
const createIndexSql = readFileSync(
  resolve(migrationDirectory, '03_create_stats_worker_index.sql'),
  'utf8'
);
const verifyIndexSql = readFileSync(
  resolve(migrationDirectory, '04_verify_stats_worker_index.sql'),
  'utf8'
);
const recoverInvalidIndexSql = readFileSync(
  resolve(migrationDirectory, 'recovery/01_drop_invalid_stats_worker_index.sql'),
  'utf8'
);
const rollbackIndexSql = readFileSync(
  resolve(migrationDirectory, 'rollback/01_drop_stats_worker_index.sql'),
  'utf8'
);
const rollbackColumnSql = readFileSync(
  resolve(migrationDirectory, 'rollback/02_drop_stats_worker_id.sql'),
  'utf8'
);

function collectExplainNodes(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.flatMap(collectExplainNodes);
  }
  if (!value || typeof value !== 'object') {
    return [];
  }

  const node = value as Record<string, unknown>;
  return [node, ...Object.values(node).flatMap(collectExplainNodes)];
}

async function expectPostgresError(
  operation: Promise<unknown>,
  message: string,
  code: string
): Promise<void> {
  const error = await operation.then(
    () => undefined,
    reason => reason as Error & { code?: string }
  );
  expect(error).toBeDefined();
  expect(error?.message).toContain(message);
  expect(error?.code).toBe(code);
}

async function waitForInvalidIndex(
  client: Client
): Promise<{ indisvalid: boolean; indisready: boolean }> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await client.query<{ indisvalid: boolean; indisready: boolean }>(
      `SELECT i.indisvalid, i.indisready
       FROM pg_index AS i
       INNER JOIN pg_class AS index_class ON index_class.oid = i.indexrelid
       WHERE i.indrelid = 'job_data'::regclass
         AND index_class.relname = 'idx_job_data_stats_worker_updated'`
    );
    const invalid = result.rows.find(row => !row.indisvalid || !row.indisready);
    if (invalid) {
      return invalid;
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 25));
  }

  throw new Error('Timed out waiting for the concurrent index to enter an invalid state.');
}

let databaseClient: Client;

const getPoolMock = jest.fn(() => ({
  connect: async () => ({
    query: (text: string, params: unknown[] = []) => databaseClient.query(text, params),
    release: jest.fn()
  })
}));
const repositoryQueryMock = jest.fn(
  (text: string, params: unknown[] = []) => databaseClient.query(text, params)
);
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

const {
  claimNextPendingJob,
  getJobExecutionStatsSince,
  resetPriorityQueueFairnessState
} = await import('../../src/core/db/repositories/jobRepository.js');

describe('job worker budget disposable database guard', () => {
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

describeWithDatabase('job worker budget identity on PostgreSQL 18', () => {
  beforeAll(async () => {
    databaseClient = new Client(databaseConfig!);
    await databaseClient.connect();
    const version = await databaseClient.query<{ server_version_num: string }>(
      "SELECT current_setting('server_version_num') AS server_version_num"
    );
    expect(Number(version.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(180_000);
    expect(Number(version.rows[0]?.server_version_num)).toBeLessThan(190_000);

    await databaseClient.query(`CREATE SCHEMA ${quotedSchema}`);
    await databaseClient.query(`SET search_path TO ${quotedSchema}, public`);
    await databaseClient.query(
      `CREATE TABLE job_data (
         id UUID PRIMARY KEY,
         worker_id TEXT NOT NULL,
         job_type TEXT NOT NULL,
         status TEXT NOT NULL DEFAULT 'pending',
         claim_generation BIGINT NOT NULL DEFAULT 0,
         input JSONB NOT NULL DEFAULT '{}'::jsonb,
         output JSONB,
         error_message TEXT,
         retry_count INTEGER NOT NULL DEFAULT 0,
         max_retries INTEGER NOT NULL DEFAULT 2,
         next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         started_at TIMESTAMPTZ,
         last_heartbeat_at TIMESTAMPTZ,
         lease_expires_at TIMESTAMPTZ,
         priority INTEGER NOT NULL DEFAULT 100,
         last_worker_id TEXT,
         correlation_id TEXT,
         autonomy_state JSONB NOT NULL DEFAULT '{}'::jsonb,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         completed_at TIMESTAMPTZ
       )`
    );

    for (let pass = 0; pass < 2; pass += 1) {
      for (const phase of migrationPhases) {
        await databaseClient.query(readFileSync(resolve(migrationDirectory, phase), 'utf8'));
      }
    }
  });

  beforeEach(async () => {
    resetPriorityQueueFairnessState();
    jest.clearAllMocks();
    await databaseClient.query('TRUNCATE job_data');
  });

  afterAll(async () => {
    if (databaseClient) {
      await databaseClient.query('RESET search_path');
      await databaseClient.query(`DROP SCHEMA ${quotedSchema} CASCADE`);
      await databaseClient.end();
    }
  });

  test('counts base and suffixed claims in one exact configured worker-group budget', async () => {
    const jobs = [
      {
        id: randomUUID(),
        workerId: 'async-queue',
        statsWorkerId: 'async-queue',
        producerId: 'api',
        status: 'completed'
      },
      {
        id: randomUUID(),
        workerId: 'async-queue-slot-1',
        statsWorkerId: 'async-queue',
        producerId: 'dag-orchestrator',
        status: 'failed'
      },
      {
        id: randomUUID(),
        workerId: 'async-queue-slot-2',
        statsWorkerId: 'async-queue',
        producerId: 'gpt-access',
        status: 'cancelled'
      },
      {
        id: randomUUID(),
        workerId: 'async-queue-slot-3',
        statsWorkerId: 'async-queue',
        producerId: 'worker-helper',
        status: 'running'
      },
      {
        id: randomUUID(),
        workerId: 'async-queue-slot-99',
        statsWorkerId: 'separate-budget',
        producerId: 'async-queue',
        status: 'completed'
      },
      {
        id: randomUUID(),
        workerId: 'async-queue-slot-4',
        statsWorkerId: 'async-queue',
        producerId: 'api',
        status: 'completed',
        old: true
      }
    ];

    for (const [index, job] of jobs.entries()) {
      await databaseClient.query(
        `INSERT INTO job_data (id, worker_id, job_type, status, input, created_at, updated_at)
         VALUES ($1, $2, 'ask', 'pending', '{}'::jsonb, NOW() + ($3::int * INTERVAL '1 millisecond'), NOW())`,
        [job.id, job.producerId, index]
      );

      const claimOptions = {
        workerId: job.workerId,
        statsWorkerId: job.statsWorkerId,
        leaseMs: 30_000,
        priorityQueueEnabled: false
      };
      const claimed = await claimNextPendingJob(claimOptions);
      expect(claimed?.id).toBe(job.id);
      await databaseClient.query(
        `UPDATE job_data
         SET status = $2,
             completed_at = CASE WHEN $2 = 'running' THEN NULL ELSE NOW() END,
             updated_at = CASE WHEN $3::boolean THEN NOW() - INTERVAL '2 hours' ELSE NOW() END
         WHERE id = $1`,
        [job.id, job.status, job.old ?? false]
      );
    }

    await databaseClient.query(
      `INSERT INTO job_data (
         id, worker_id, job_type, status, input, created_at, updated_at, completed_at
       ) VALUES (
         $1, 'async-queue', 'ask', 'completed', '{}'::jsonb, NOW(), NOW(), NOW()
       )`,
      [randomUUID()]
    );

    const persisted = await databaseClient.query<{
      last_worker_id: string;
      stats_worker_id: string | null;
    }>(
      `SELECT last_worker_id, stats_worker_id
       FROM job_data
       WHERE last_worker_id IS NOT NULL
       ORDER BY created_at ASC`
    );
    expect(persisted.rows).toEqual([
      { last_worker_id: 'async-queue', stats_worker_id: 'async-queue' },
      { last_worker_id: 'async-queue-slot-1', stats_worker_id: 'async-queue' },
      { last_worker_id: 'async-queue-slot-2', stats_worker_id: 'async-queue' },
      { last_worker_id: 'async-queue-slot-3', stats_worker_id: 'async-queue' },
      { last_worker_id: 'async-queue-slot-99', stats_worker_id: 'separate-budget' },
      { last_worker_id: 'async-queue-slot-4', stats_worker_id: 'async-queue' }
    ]);

    const since = new Date(Date.now() - 60 * 60 * 1_000);
    await expect(getJobExecutionStatsSince(since, 'async-queue')).resolves.toEqual({
      completed: 1,
      failed: 1,
      running: 1,
      totalTerminal: 3,
      aiCalls: 3
    });

    await expect(getJobExecutionStatsSince(since, 'separate-budget')).resolves.toEqual({
      completed: 1,
      failed: 0,
      running: 0,
      totalTerminal: 1,
      aiCalls: 1
    });

    const statsQueryCall = repositoryQueryMock.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('stats_worker_id = $2')
    );
    expect(statsQueryCall).toBeDefined();
      await databaseClient.query('BEGIN');
    try {
      await databaseClient.query('SET LOCAL enable_seqscan = off');
      await databaseClient.query('SET LOCAL plan_cache_mode = force_custom_plan');
      const plan = await databaseClient.query(
        `EXPLAIN (FORMAT JSON) ${String(statsQueryCall?.[0])}`,
        statsQueryCall?.[1] as unknown[]
      );
      const indexNode = collectExplainNodes(plan.rows).find(
        node => node['Index Name'] === 'idx_job_data_stats_worker_updated'
      );
      expect(indexNode).toBeDefined();
      expect(String(indexNode?.['Index Cond'])).toMatch(/stats_worker_id[^=]*=/u);
      expect(String(indexNode?.['Index Cond'])).toMatch(/updated_at\s*>=/u);
    } finally {
      await databaseClient.query('ROLLBACK');
    }
  });

  test('installs an exact valid partial time-window index idempotently', async () => {
    const column = await databaseClient.query<{
      data_type: string;
      character_maximum_length: number;
      collation_name: string;
      is_nullable: string;
    }>(
      `SELECT data_type, character_maximum_length, collation_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = $1
         AND table_name = 'job_data'
         AND column_name = 'stats_worker_id'`,
      [schemaName]
    );
    expect(column.rows).toEqual([{
      data_type: 'character varying',
      character_maximum_length: 255,
      collation_name: 'C',
      is_nullable: 'YES'
    }]);

    const index = await databaseClient.query<{
      indisvalid: boolean;
      indisready: boolean;
      indisunique: boolean;
      definition: string;
    }>(
      `SELECT i.indisvalid, i.indisready, i.indisunique, pg_get_indexdef(i.indexrelid) AS definition
       FROM pg_index AS i
       INNER JOIN pg_class AS index_class ON index_class.oid = i.indexrelid
       WHERE i.indrelid = 'job_data'::regclass
         AND index_class.relname = 'idx_job_data_stats_worker_updated'`
    );
    expect(index.rows).toHaveLength(1);
    expect(index.rows[0]).toEqual(expect.objectContaining({
      indisvalid: true,
      indisready: true,
      indisunique: false
    }));
    expect(index.rows[0]?.definition).toContain(
      'USING btree (stats_worker_id, updated_at) WHERE (stats_worker_id IS NOT NULL)'
    );
  });

  test('rejects a same-name index with a non-contract key collation', async () => {
    await databaseClient.query(
      'DROP INDEX CONCURRENTLY IF EXISTS idx_job_data_stats_worker_updated'
    );
    try {
      await databaseClient.query(
        `CREATE INDEX CONCURRENTLY idx_job_data_stats_worker_updated
         ON job_data (stats_worker_id COLLATE "default", updated_at)
         WHERE stats_worker_id IS NOT NULL`
      );

      await expectPostgresError(
        databaseClient.query(precheckIndexSql),
        'idx_job_data_stats_worker_updated has an unexpected definition',
        '42804'
      );
      await expectPostgresError(
        databaseClient.query(verifyIndexSql),
        'idx_job_data_stats_worker_updated is missing, unexpected, or invalid',
        '42804'
      );
      await expectPostgresError(
        databaseClient.query(recoverInvalidIndexSql),
        'idx_job_data_stats_worker_updated has an unexpected definition; recovery refused',
        '42804'
      );
      await expectPostgresError(
        databaseClient.query(rollbackIndexSql),
        'idx_job_data_stats_worker_updated has an unexpected definition; rollback refused',
        '42804'
      );
      const retained = await databaseClient.query<{ present: boolean }>(
        `SELECT to_regclass('idx_job_data_stats_worker_updated') IS NOT NULL AS present`
      );
      expect(retained.rows[0]?.present).toBe(true);
    } finally {
      await databaseClient.query(
        'DROP INDEX CONCURRENTLY IF EXISTS idx_job_data_stats_worker_updated'
      );
      await databaseClient.query(createIndexSql);
      await databaseClient.query(verifyIndexSql);
    }
  });

  test.each([
    {
      label: 'database-default collation',
      definition: 'stats_worker_id VARCHAR(255) COLLATE "default"'
    },
    {
      label: 'generated value',
      definition:
        'stats_worker_id VARCHAR(255) COLLATE "C" GENERATED ALWAYS AS (\'fixed\'::VARCHAR(255)) STORED'
    }
  ])('rejects a drifted $label column', async ({ definition }) => {
    const driftSchema = `job_worker_budget_drift_${randomUUID().replaceAll('-', '')}`;
    const quotedDriftSchema = `"${driftSchema}"`;

    await databaseClient.query(`CREATE SCHEMA ${quotedDriftSchema}`);
    try {
      await databaseClient.query(`SET search_path TO ${quotedDriftSchema}, public`);
      await databaseClient.query(
        `CREATE TABLE job_data (
           id UUID PRIMARY KEY,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           ${definition}
         )`
      );
      await expectPostgresError(
        databaseClient.query(addColumnSql),
        'job_data.stats_worker_id must be a plain writable nullable VARCHAR(255) COLLATE "C" without a default',
        '42804'
      );
      await expectPostgresError(
        databaseClient.query(rollbackColumnSql),
        'job_data.stats_worker_id has an unexpected definition',
        '42804'
      );
      const retained = await databaseClient.query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM pg_attribute
           WHERE attrelid = 'job_data'::regclass
             AND attname = 'stats_worker_id'
             AND NOT attisdropped
         ) AS present`
      );
      expect(retained.rows[0]?.present).toBe(true);
    } finally {
      await databaseClient.query(`SET search_path TO ${quotedSchema}, public`);
      await databaseClient.query(`DROP SCHEMA ${quotedDriftSchema} CASCADE`);
    }
  });

  test('recovers only an exact invalid index left by an interrupted concurrent build', async () => {
    const blocker = new Client(databaseConfig!);
    const jobId = randomUUID();
    let createResult: Promise<{ error?: unknown }> | undefined;

    await databaseClient.query(
      'DROP INDEX CONCURRENTLY IF EXISTS idx_job_data_stats_worker_updated'
    );
    await databaseClient.query(
      `INSERT INTO job_data (id, worker_id, job_type, input)
       VALUES ($1, 'api', 'ask', '{}'::jsonb)`,
      [jobId]
    );
    await blocker.connect();
    try {
      await blocker.query(`SET search_path TO ${quotedSchema}, public`);
      await blocker.query('BEGIN');
      await blocker.query('UPDATE job_data SET updated_at = NOW() WHERE id = $1', [jobId]);
      const backend = await databaseClient.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid'
      );

      createResult = databaseClient.query(createIndexSql).then(
        () => ({}),
        error => ({ error })
      );
      const building = await waitForInvalidIndex(blocker);
      expect(building).toEqual({ indisvalid: false, indisready: false });
      const cancellation = await blocker.query<{ cancelled: boolean }>(
        'SELECT pg_cancel_backend($1) AS cancelled',
        [backend.rows[0]?.pid]
      );
      expect(cancellation.rows[0]?.cancelled).toBe(true);
      await blocker.query('ROLLBACK');
      const interrupted = await createResult;
      expect(interrupted.error).toEqual(expect.objectContaining({ code: '57014' }));

      const invalid = await databaseClient.query<{ indisvalid: boolean; indisready: boolean }>(
        `SELECT i.indisvalid, i.indisready
         FROM pg_index AS i
         INNER JOIN pg_class AS index_class ON index_class.oid = i.indexrelid
         WHERE i.indrelid = 'job_data'::regclass
           AND index_class.relname = 'idx_job_data_stats_worker_updated'`
      );
      expect(invalid.rows).toHaveLength(1);
      expect(invalid.rows[0]?.indisvalid && invalid.rows[0]?.indisready).toBe(false);

      await expectPostgresError(
        databaseClient.query(precheckIndexSql),
        'idx_job_data_stats_worker_updated is exact but not ready and valid; run the guarded invalid-index recovery',
        '55000'
      );
      await databaseClient.query(recoverInvalidIndexSql);
      const dropped = await databaseClient.query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM pg_class
           WHERE oid = to_regclass('idx_job_data_stats_worker_updated')
         ) AS present`
      );
      expect(dropped.rows[0]?.present).toBe(false);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      await blocker.end().catch(() => undefined);
      if (createResult) {
        await createResult;
      }
      await databaseClient.query(
        'DROP INDEX CONCURRENTLY IF EXISTS idx_job_data_stats_worker_updated'
      );
      await databaseClient.query(createIndexSql);
      await databaseClient.query(verifyIndexSql);
    }
  }, 30_000);

  test('refuses invalid-index recovery for the healthy exact index', async () => {
    await expectPostgresError(
      databaseClient.query(recoverInvalidIndexSql),
      'idx_job_data_stats_worker_updated is ready and valid; invalid-index recovery refused',
      '55000'
    );
  });

  test('removes the exact empty stats identity column and keeps rollback idempotent', async () => {
    const readRollbackState = async (): Promise<{
      column_present: boolean;
      index_present: boolean;
    }> => {
      const state = await databaseClient.query<{
        column_present: boolean;
        index_present: boolean;
      }>(
        `SELECT
           EXISTS (
             SELECT 1
             FROM pg_attribute
             WHERE attrelid = 'job_data'::regclass
               AND attname = 'stats_worker_id'
               AND NOT attisdropped
           ) AS column_present,
           to_regclass('idx_job_data_stats_worker_updated') IS NOT NULL AS index_present`
      );
      return state.rows[0]!;
    };

    try {
      await databaseClient.query(rollbackIndexSql);
      await databaseClient.query(rollbackColumnSql);
      await expect(readRollbackState()).resolves.toEqual({
        column_present: false,
        index_present: false
      });

      await expect(databaseClient.query(rollbackIndexSql)).resolves.toBeDefined();
      await expect(databaseClient.query(rollbackColumnSql)).resolves.toBeDefined();
      await expect(readRollbackState()).resolves.toEqual({
        column_present: false,
        index_present: false
      });
    } finally {
      await databaseClient.query(addColumnSql);
      await databaseClient.query(precheckIndexSql);
      await databaseClient.query(createIndexSql);
      await databaseClient.query(verifyIndexSql);
    }
  });

  test('rolls back only the exact owned index and refuses populated accounting history', async () => {
    await databaseClient.query(
      `INSERT INTO job_data (id, worker_id, job_type, stats_worker_id, input)
       VALUES ($1, 'api', 'ask', 'async-queue', '{}'::jsonb)`,
      [randomUUID()]
    );

    await expectPostgresError(
      databaseClient.query(rollbackIndexSql),
      'job_data.stats_worker_id contains accounting history; rollback refused',
      '55000'
    );
    const retainedHistory = await databaseClient.query<{
      index_present: boolean;
      row_count: number;
    }>(
      `SELECT
         to_regclass('idx_job_data_stats_worker_updated') IS NOT NULL AS index_present,
         COUNT(*)::int AS row_count
       FROM job_data`
    );
    expect(retainedHistory.rows[0]).toEqual({ index_present: true, row_count: 1 });
    await expectPostgresError(
      databaseClient.query(rollbackColumnSql),
      'job_data.stats_worker_id contains accounting history; rollback refused',
      '55000'
    );
    await databaseClient.query('TRUNCATE job_data');

    try {
      await databaseClient.query(
        'CREATE INDEX job_data_stats_worker_extra_dependency ON job_data (stats_worker_id)'
      );
      await expectPostgresError(
        databaseClient.query(rollbackIndexSql),
        'job_data.stats_worker_id has unexpected dependent objects; rollback refused',
        '55000'
      );
      const retainedDependencies = await databaseClient.query<{
        owned_present: boolean;
        extra_present: boolean;
      }>(
        `SELECT
           to_regclass('idx_job_data_stats_worker_updated') IS NOT NULL AS owned_present,
           to_regclass('job_data_stats_worker_extra_dependency') IS NOT NULL AS extra_present`
      );
      expect(retainedDependencies.rows[0]).toEqual({
        owned_present: true,
        extra_present: true
      });
      await databaseClient.query('DROP INDEX job_data_stats_worker_extra_dependency');

      await databaseClient.query(rollbackIndexSql);
      const dropped = await databaseClient.query<{ present: boolean }>(
        `SELECT to_regclass('idx_job_data_stats_worker_updated') IS NOT NULL AS present`
      );
      expect(dropped.rows[0]?.present).toBe(false);
      await expect(databaseClient.query(rollbackIndexSql)).resolves.toBeDefined();
    } finally {
      await databaseClient.query(
        'DROP INDEX IF EXISTS job_data_stats_worker_extra_dependency'
      );
      await databaseClient.query(
        'DROP INDEX CONCURRENTLY IF EXISTS idx_job_data_stats_worker_updated'
      );
      await databaseClient.query(createIndexSql);
      await databaseClient.query(verifyIndexSql);
    }
  });
});
