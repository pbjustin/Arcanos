import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Client } from 'pg';
import { resolvePostgresTestDatabaseUrl } from './postgresTestDatabase.js';

const TEST_DATABASE_ENV = 'JOB_WORKER_BUDGET_TEST_DATABASE_URL';
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
const workerBudgetMigrationDirectory = resolve(
  process.cwd(),
  'migrations/20260830_job_events_worker_budget_v1'
);
const workerBudgetMigrationPhases = [
  '01_add_budget_evidence_contract.sql',
  '02_validate_budget_evidence_contract.sql',
  '03_precheck_budget_indexes.sql',
  '04_create_group_window_index.sql',
  '05_create_claim_generation_index.sql',
  '06_verify_budget_indexes.sql'
] as const;
const workerBudgetPrecheckIndexSql = readFileSync(
  resolve(workerBudgetMigrationDirectory, '03_precheck_budget_indexes.sql'),
  'utf8'
);
const workerBudgetCreateGroupIndexSql = readFileSync(
  resolve(workerBudgetMigrationDirectory, '04_create_group_window_index.sql'),
  'utf8'
);
const workerBudgetCreateClaimIndexSql = readFileSync(
  resolve(workerBudgetMigrationDirectory, '05_create_claim_generation_index.sql'),
  'utf8'
);
const workerBudgetVerifyIndexSql = readFileSync(
  resolve(workerBudgetMigrationDirectory, '06_verify_budget_indexes.sql'),
  'utf8'
);
const workerBudgetRollbackIndexSql = readFileSync(
  resolve(workerBudgetMigrationDirectory, 'rollback/01_drop_budget_indexes.sql'),
  'utf8'
);
const workerBudgetRollbackContractSql = readFileSync(
  resolve(workerBudgetMigrationDirectory, 'rollback/02_drop_budget_evidence_contract.sql'),
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

async function connectBudgetReplicaClient(): Promise<Client> {
  const client = new Client(databaseConfig!);
  await client.connect();
  await client.query(`SET search_path TO ${quotedSchema}, public`);
  return client;
}

let databaseClient: Client;
let poolClientQueue: Client[] = [];

const getPoolMock = jest.fn(() => ({
  connect: async () => {
    const client = poolClientQueue.shift() ?? databaseClient;
    return {
    query: (text: string, params: unknown[] = []) => client.query(text, params),
    release: jest.fn()
  };
  },
  query: (text: string, params: unknown[] = []) => databaseClient.query(text, params)
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
  () => ({
    recordJobEvent: recordJobEventMock,
    recordJobEventWithClient: jest.fn()
  })
);

const {
  claimNextPendingJob,
  claimNextPendingJobWithAdmission,
  getJobExecutionStatsSince,
  resetPriorityQueueFairnessState
} = await import('../../src/core/db/repositories/jobRepository.js');
const {
  reserveWorkerAiProviderAttempt
} = await import('../../src/core/db/repositories/workerBudgetRepository.js');

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
    await databaseClient.query(
      `CREATE TABLE job_events (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         job_id UUID NOT NULL,
         trace_id TEXT,
         event_type TEXT NOT NULL,
         worker_id TEXT,
         occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         duration_ms INTEGER,
         metadata JSONB NOT NULL DEFAULT '{}'::jsonb
       )`
    );

    for (let pass = 0; pass < 2; pass += 1) {
      for (const phase of migrationPhases) {
        await databaseClient.query(readFileSync(resolve(migrationDirectory, phase), 'utf8'));
      }
      for (const phase of workerBudgetMigrationPhases) {
        await databaseClient.query(
          readFileSync(resolve(workerBudgetMigrationDirectory, phase), 'utf8')
        );
      }
    }
  });

  beforeEach(async () => {
    resetPriorityQueueFairnessState();
    jest.clearAllMocks();
    poolClientQueue = [];
    await databaseClient.query('TRUNCATE job_data, job_events');
  });

  afterAll(async () => {
    if (databaseClient) {
      await databaseClient.query('RESET search_path');
      await databaseClient.query(`DROP SCHEMA ${quotedSchema} CASCADE`);
      await databaseClient.end();
    }
  });

  test('preserves lease and stats identities while ignoring legacy terminal rows for hard budgets', async () => {
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
      jobClaims: 0,
      aiCalls: 0
    });

    await expect(getJobExecutionStatsSince(since, 'separate-budget')).resolves.toEqual({
      completed: 1,
      failed: 0,
      running: 0,
      totalTerminal: 1,
      jobClaims: 0,
      aiCalls: 0
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

  test('does not reserve budget when no queued job is due', async () => {
    const evaluatedAt = new Date('2026-08-30T13:00:00.000Z');
    const jobId = randomUUID();
    await databaseClient.query(
      `INSERT INTO job_data (
         id, worker_id, job_type, status, input, next_run_at, created_at, updated_at
       ) VALUES (
         $1, 'producer', 'ask', 'pending', '{}'::jsonb,
         $2::timestamptz + INTERVAL '1 minute', $2, $2
       )`,
      [jobId, evaluatedAt]
    );

    await expect(claimNextPendingJobWithAdmission({
      workerId: 'async-queue-slot-1',
      statsWorkerId: 'async-queue',
      priorityQueueEnabled: false,
      maxJobsPerHour: 1,
      maxAiCallsPerHour: 1,
      budgetNowForTesting: evaluatedAt
    })).resolves.toEqual({ job: null, budgetAdmission: null });

    const state = await databaseClient.query<{
      status: string;
      claim_generation: string;
      evidence_count: number;
    }>(
      `SELECT job.status,
              job.claim_generation::text,
              COUNT(event.id)::int AS evidence_count
       FROM job_data AS job
       LEFT JOIN job_events AS event
         ON event.job_id = job.id
        AND event.event_type = 'worker.budget.job_claim'
       WHERE job.id = $1
       GROUP BY job.status, job.claim_generation`,
      [jobId]
    );
    expect(state.rows[0]).toEqual({
      status: 'pending',
      claim_generation: '0',
      evidence_count: 0
    });
  });

  test('atomically caps two replicas in one stats group and recovers at the exact rolling boundary', async () => {
    const windowStart = new Date('2026-08-30T14:00:00.000Z');
    const firstJobId = randomUUID();
    const secondJobId = randomUUID();
    await databaseClient.query(
      `INSERT INTO job_data (
         id, worker_id, job_type, status, input, next_run_at, created_at, updated_at
       ) VALUES
         ($1, 'producer-a', 'ask', 'pending', '{}'::jsonb, $3, $3, $3),
         ($2, 'producer-b', 'ask', 'pending', '{}'::jsonb,
          $3::timestamptz + INTERVAL '1 millisecond',
          $3::timestamptz + INTERVAL '1 millisecond',
          $3::timestamptz + INTERVAL '1 millisecond')`,
      [firstJobId, secondJobId, new Date(windowStart.getTime() - 1_000)]
    );

    const replicaA = await connectBudgetReplicaClient();
    const replicaB = await connectBudgetReplicaClient();
    try {
      poolClientQueue = [replicaA, replicaB];
      const results = await Promise.all([
        claimNextPendingJobWithAdmission({
          workerId: 'replica-a-slot-1',
          statsWorkerId: 'shared-budget',
          priorityQueueEnabled: false,
          maxJobsPerHour: 1,
          maxAiCallsPerHour: 10,
          budgetNowForTesting: windowStart
        }),
        claimNextPendingJobWithAdmission({
          workerId: 'replica-b-slot-1',
          statsWorkerId: 'shared-budget',
          priorityQueueEnabled: false,
          maxJobsPerHour: 1,
          maxAiCallsPerHour: 10,
          budgetNowForTesting: windowStart
        })
      ]);

      const claimed = results.filter(result => result.job !== null);
      const paused = results.filter(result => result.budgetAdmission?.allowed === false);
      expect(claimed).toHaveLength(1);
      expect(paused).toHaveLength(1);
      expect(claimed[0]?.job?.id).toBe(firstJobId);
      expect(claimed[0]?.budgetAdmission).toEqual(expect.objectContaining({
        kind: 'job_claim',
        allowed: true,
        used: 1,
        remaining: 0,
        nextAvailableAt: '2026-08-30T15:00:00.000Z'
      }));
      expect(paused[0]?.budgetAdmission).toEqual(expect.objectContaining({
        kind: 'job_claim',
        used: 1,
        limit: 1,
        nextAvailableAt: '2026-08-30T15:00:00.000Z'
      }));

      const evidence = await databaseClient.query<{
        job_id: string;
        worker_id: string;
        stats_worker_id: string;
        claim_generation: string;
        occurred_at: Date;
      }>(
        `SELECT job_id::text, worker_id, stats_worker_id,
                claim_generation::text, occurred_at
         FROM job_events
         WHERE event_type = 'worker.budget.job_claim'`
      );
      expect(evidence.rows).toHaveLength(1);
      expect(evidence.rows[0]).toEqual(expect.objectContaining({
        job_id: firstJobId,
        worker_id: expect.stringMatching(/^replica-[ab]-slot-1$/u),
        stats_worker_id: 'shared-budget',
        claim_generation: '1',
        occurred_at: windowStart
      }));

      await databaseClient.query('DELETE FROM job_data WHERE id = $1', [firstJobId]);
      await expect(claimNextPendingJobWithAdmission({
        workerId: 'replica-c-slot-1',
        statsWorkerId: 'shared-budget',
        priorityQueueEnabled: false,
        maxJobsPerHour: 1,
        maxAiCallsPerHour: 10,
        budgetNowForTesting: new Date(windowStart.getTime() + 60 * 60 * 1_000 - 1)
      })).resolves.toMatchObject({
        job: null,
        budgetAdmission: { allowed: false, used: 1 }
      });

      await expect(claimNextPendingJobWithAdmission({
        workerId: 'replica-c-slot-1',
        statsWorkerId: 'shared-budget',
        priorityQueueEnabled: false,
        maxJobsPerHour: 1,
        maxAiCallsPerHour: 10,
        budgetNowForTesting: new Date(windowStart.getTime() + 60 * 60 * 1_000)
      })).resolves.toMatchObject({
        job: { id: secondJobId },
        budgetAdmission: {
          allowed: true,
          used: 1,
          remaining: 0,
          nextAvailableAt: '2026-08-30T16:00:00.000Z'
        }
      });

      const retainedEvidence = await databaseClient.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
         FROM job_events
         WHERE event_type = 'worker.budget.job_claim'
           AND stats_worker_id = 'shared-budget'`
      );
      expect(retainedEvidence.rows[0]?.count).toBe(2);
    } finally {
      await replicaA.end();
      await replicaB.end();
      poolClientQueue = [];
    }
  });

  test('atomically caps two slots from the same replica in one stats group', async () => {
    const evaluatedAt = new Date('2026-08-30T15:30:00.000Z');
    const firstJobId = randomUUID();
    const secondJobId = randomUUID();
    await databaseClient.query(
      `INSERT INTO job_data (
         id, worker_id, job_type, status, input, next_run_at, created_at, updated_at
       ) VALUES
         ($1, 'producer-a', 'ask', 'pending', '{}'::jsonb, $3, $3, $3),
         ($2, 'producer-b', 'ask', 'pending', '{}'::jsonb,
          $3::timestamptz + INTERVAL '1 millisecond',
          $3::timestamptz + INTERVAL '1 millisecond',
          $3::timestamptz + INTERVAL '1 millisecond')`,
      [firstJobId, secondJobId, new Date(evaluatedAt.getTime() - 1_000)]
    );

    const slotA = await connectBudgetReplicaClient();
    const slotB = await connectBudgetReplicaClient();
    try {
      poolClientQueue = [slotA, slotB];
      const results = await Promise.all([
        claimNextPendingJobWithAdmission({
          workerId: 'replica-a-slot-1',
          statsWorkerId: 'replica-a',
          priorityQueueEnabled: false,
          maxJobsPerHour: 1,
          maxAiCallsPerHour: 10,
          budgetNowForTesting: evaluatedAt
        }),
        claimNextPendingJobWithAdmission({
          workerId: 'replica-a-slot-2',
          statsWorkerId: 'replica-a',
          priorityQueueEnabled: false,
          maxJobsPerHour: 1,
          maxAiCallsPerHour: 10,
          budgetNowForTesting: evaluatedAt
        })
      ]);

      expect(results.filter(result => result.job !== null)).toHaveLength(1);
      expect(results.filter(result => result.budgetAdmission?.allowed === false)).toHaveLength(1);
      const evidence = await databaseClient.query<{
        worker_id: string;
        stats_worker_id: string;
        count: number;
      }>(
        `SELECT MIN(worker_id) AS worker_id,
                MIN(stats_worker_id) AS stats_worker_id,
                COUNT(*)::int AS count
         FROM job_events
         WHERE event_type = 'worker.budget.job_claim'`
      );
      expect(evidence.rows[0]).toEqual({
        worker_id: expect.stringMatching(/^replica-a-slot-[12]$/u),
        stats_worker_id: 'replica-a',
        count: 1
      });
    } finally {
      await slotA.end();
      await slotB.end();
      poolClientQueue = [];
    }
  });

  test('retains one claim reservation per failed attempt across requeue and reclaim', async () => {
    const jobId = randomUUID();
    const firstClock = await databaseClient.query<{ evaluated_at: Date }>(
      'SELECT clock_timestamp() AS evaluated_at'
    );
    const firstClaimAt = firstClock.rows[0]!.evaluated_at;
    await databaseClient.query(
      `INSERT INTO job_data (
         id, worker_id, job_type, status, input, next_run_at, created_at, updated_at
       ) VALUES (
         $1, 'producer', 'ask', 'pending', '{}'::jsonb,
         $2::timestamptz - INTERVAL '1 second', $2, $2
       )`,
      [jobId, firstClaimAt]
    );

    const firstClaim = await claimNextPendingJobWithAdmission({
      workerId: 'replica-a-slot-1',
      statsWorkerId: 'shared-retry-budget',
      priorityQueueEnabled: false,
      maxJobsPerHour: 5,
      maxAiCallsPerHour: 10,
      budgetNowForTesting: firstClaimAt
    });
    expect(firstClaim).toMatchObject({
      job: { id: jobId, claim_generation: '1' },
      budgetAdmission: { allowed: true, used: 1 }
    });
    if (!firstClaim.job) {
      throw new Error('Expected the first retry fixture claim to succeed.');
    }

    const requeued = await databaseClient.query<{
      status: string;
      claim_generation: string;
      retry_count: number;
    }>(
      `UPDATE job_data
       SET status = 'pending',
           error_message = 'retryable failure',
           retry_count = retry_count + 1,
           next_run_at = clock_timestamp(),
           updated_at = clock_timestamp(),
           started_at = NULL,
           last_heartbeat_at = NULL,
           lease_expires_at = NULL
       WHERE id = $1
         AND status = 'running'
         AND last_worker_id = $2
         AND claim_generation = $3::bigint
       RETURNING status, claim_generation::text, retry_count`,
      [jobId, 'replica-a-slot-1', firstClaim.job.claim_generation]
    );
    expect(requeued.rows).toEqual([{
      status: 'pending',
      claim_generation: '1',
      retry_count: 1
    }]);

    const secondClock = await databaseClient.query<{ evaluated_at: Date }>(
      'SELECT clock_timestamp() AS evaluated_at'
    );
    const secondClaimAt = new Date(secondClock.rows[0]!.evaluated_at.getTime() + 1_000);
    const secondClaim = await claimNextPendingJobWithAdmission({
      workerId: 'replica-b-slot-1',
      statsWorkerId: 'shared-retry-budget',
      priorityQueueEnabled: false,
      maxJobsPerHour: 5,
      maxAiCallsPerHour: 10,
      budgetNowForTesting: secondClaimAt
    });
    expect(secondClaim).toMatchObject({
      job: { id: jobId, claim_generation: '2', retry_count: 1 },
      budgetAdmission: { allowed: true, used: 2 }
    });
    if (!secondClaim.job) {
      throw new Error('Expected the requeued fixture claim to succeed.');
    }

    const failed = await databaseClient.query<{ status: string }>(
      `UPDATE job_data
       SET status = 'failed',
           error_message = 'terminal failure',
           completed_at = clock_timestamp(),
           updated_at = clock_timestamp(),
           last_heartbeat_at = NULL,
           lease_expires_at = NULL
       WHERE id = $1
         AND status = 'running'
         AND last_worker_id = $2
         AND claim_generation = $3::bigint
       RETURNING status`,
      [jobId, 'replica-b-slot-1', secondClaim.job.claim_generation]
    );
    expect(failed.rows).toEqual([{ status: 'failed' }]);
    await databaseClient.query('DELETE FROM job_data WHERE id = $1', [jobId]);

    const evidence = await databaseClient.query<{
      claim_generation: string;
      worker_id: string;
      stats_worker_id: string;
    }>(
      `SELECT claim_generation::text, worker_id, stats_worker_id
       FROM job_events
       WHERE event_type = 'worker.budget.job_claim'
         AND job_id = $1
       ORDER BY claim_generation ASC`,
      [jobId]
    );
    expect(evidence.rows).toEqual([
      {
        claim_generation: '1',
        worker_id: 'replica-a-slot-1',
        stats_worker_id: 'shared-retry-budget'
      },
      {
        claim_generation: '2',
        worker_id: 'replica-b-slot-1',
        stats_worker_id: 'shared-retry-budget'
      }
    ]);
  });

  test('reports the first true recovery time when active usage exceeds a lowered limit', async () => {
    const evaluatedAt = new Date('2026-08-30T18:00:00.000Z');
    const jobId = randomUUID();
    await databaseClient.query(
      `INSERT INTO job_events (
         id, job_id, event_type, worker_id, stats_worker_id,
         claim_generation, occurred_at, metadata
       ) VALUES
         (gen_random_uuid(), gen_random_uuid(), 'worker.budget.job_claim',
          'legacy-slot-1', 'lowered-budget', 1,
          $1::timestamptz - INTERVAL '50 minutes', '{}'::jsonb),
         (gen_random_uuid(), gen_random_uuid(), 'worker.budget.job_claim',
          'legacy-slot-2', 'lowered-budget', 1,
          $1::timestamptz - INTERVAL '40 minutes', '{}'::jsonb),
         (gen_random_uuid(), gen_random_uuid(), 'worker.budget.job_claim',
          'legacy-slot-3', 'lowered-budget', 1,
          $1::timestamptz - INTERVAL '30 minutes', '{}'::jsonb)`,
      [evaluatedAt]
    );
    await databaseClient.query(
      `INSERT INTO job_data (
         id, worker_id, job_type, status, input, next_run_at, created_at, updated_at
       ) VALUES (
         $1, 'producer', 'ask', 'pending', '{}'::jsonb,
         $2::timestamptz - INTERVAL '1 second', $2, $2
       )`,
      [jobId, evaluatedAt]
    );

    await expect(claimNextPendingJobWithAdmission({
      workerId: 'current-slot-1',
      statsWorkerId: 'lowered-budget',
      priorityQueueEnabled: false,
      maxJobsPerHour: 1,
      maxAiCallsPerHour: 10,
      budgetNowForTesting: evaluatedAt
    })).resolves.toEqual({
      job: null,
      budgetAdmission: expect.objectContaining({
        kind: 'job_claim',
        allowed: false,
        used: 3,
        limit: 1,
        nextAvailableAt: '2026-08-30T18:30:00.000Z'
      })
    });

    await expect(claimNextPendingJobWithAdmission({
      workerId: 'current-slot-1',
      statsWorkerId: 'lowered-budget',
      priorityQueueEnabled: false,
      maxJobsPerHour: 1,
      maxAiCallsPerHour: 10,
      budgetNowForTesting: new Date('2026-08-30T18:30:00.000Z')
    })).resolves.toMatchObject({
      job: { id: jobId, claim_generation: '1' },
      budgetAdmission: { allowed: true, used: 1, remaining: 0 }
    });
  });

  test('atomically caps provider attempts across replicas and replays one reservation idempotently', async () => {
    const evaluatedAt = new Date('2026-08-30T16:00:00.000Z');
    const firstReservationId = randomUUID();
    const secondReservationId = randomUUID();
    const firstInput = {
      statsWorkerId: 'shared-provider-budget',
      workerId: 'replica-a-slot-1',
      limit: 1,
      jobId: randomUUID(),
      operation: '/v1/responses',
      reservationId: firstReservationId,
      now: evaluatedAt
    };
    const secondInput = {
      ...firstInput,
      workerId: 'replica-b-slot-1',
      jobId: randomUUID(),
      reservationId: secondReservationId
    };
    const replicaA = await connectBudgetReplicaClient();
    const replicaB = await connectBudgetReplicaClient();
    try {
      poolClientQueue = [replicaA, replicaB];
      const results = await Promise.all([
        reserveWorkerAiProviderAttempt(firstInput),
        reserveWorkerAiProviderAttempt(secondInput)
      ]);
      expect(results.filter(result => result.allowed)).toHaveLength(1);
      expect(results.filter(result => !result.allowed)).toHaveLength(1);
      expect(results.find(result => result.allowed)).toEqual(expect.objectContaining({
        used: 1,
        remaining: 0,
        nextAvailableAt: '2026-08-30T17:00:00.000Z'
      }));

      const admittedInput = results[0]?.allowed ? firstInput : secondInput;
      await expect(reserveWorkerAiProviderAttempt(admittedInput)).resolves.toMatchObject({
        allowed: false,
        alreadyReserved: true,
        reservationId: admittedInput.reservationId
      });
      const evidence = await databaseClient.query<{
        worker_id: string;
        stats_worker_id: string;
        count: number;
      }>(
        `SELECT MIN(worker_id) AS worker_id,
                MIN(stats_worker_id) AS stats_worker_id,
                COUNT(*)::int AS count
         FROM job_events
         WHERE event_type = 'worker.budget.ai_provider_attempt'`
      );
      expect(evidence.rows[0]).toEqual({
        worker_id: admittedInput.workerId,
        stats_worker_id: 'shared-provider-budget',
        count: 1
      });

      await expect(reserveWorkerAiProviderAttempt({
        ...secondInput,
        workerId: 'replica-c-slot-1',
        reservationId: randomUUID(),
        now: new Date(evaluatedAt.getTime() + 60 * 60 * 1_000)
      })).resolves.toMatchObject({
        allowed: true,
        used: 1,
        remaining: 0,
        nextAvailableAt: '2026-08-30T18:00:00.000Z'
      });
    } finally {
      await replicaA.end();
      await replicaB.end();
      poolClientQueue = [];
    }
  });

  test('rolls back a provider reservation when strict evidence insertion fails', async () => {
    const reservationId = randomUUID();
    const input = {
      statsWorkerId: 'provider-rollback-budget',
      workerId: 'replica-a-slot-1',
      limit: 1,
      jobId: randomUUID(),
      operation: '/v1/responses',
      reservationId,
      now: new Date('2026-08-30T16:30:00.000Z')
    };

    await databaseClient.query(
      `ALTER TABLE job_events
       ADD CONSTRAINT worker_budget_test_reject_ai_provider_attempt
       CHECK (event_type <> 'worker.budget.ai_provider_attempt')`
    );
    try {
      await expect(reserveWorkerAiProviderAttempt(input)).rejects.toEqual(
        expect.objectContaining({ code: '23514' })
      );
      const rolledBack = await databaseClient.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
         FROM job_events
         WHERE id = $1::uuid
            OR (
              event_type = 'worker.budget.ai_provider_attempt'
              AND stats_worker_id = $2
            )`,
        [reservationId, input.statsWorkerId]
      );
      expect(rolledBack.rows[0]?.count).toBe(0);
    } finally {
      await databaseClient.query(
        `ALTER TABLE job_events
         DROP CONSTRAINT IF EXISTS worker_budget_test_reject_ai_provider_attempt`
      );
    }

    await expect(reserveWorkerAiProviderAttempt(input)).resolves.toMatchObject({
      allowed: true,
      used: 1,
      remaining: 0,
      reservationId,
      alreadyReserved: false
    });
    const persisted = await databaseClient.query<{
      event_type: string;
      stats_worker_id: string;
      worker_id: string;
      operation: string;
      count: number;
    }>(
      `SELECT MIN(event_type) AS event_type,
              MIN(stats_worker_id) AS stats_worker_id,
              MIN(worker_id) AS worker_id,
              MIN(operation) AS operation,
              COUNT(*)::int AS count
       FROM job_events
       WHERE id = $1::uuid`,
      [reservationId]
    );
    expect(persisted.rows[0]).toEqual({
      event_type: 'worker.budget.ai_provider_attempt',
      stats_worker_id: input.statsWorkerId,
      worker_id: input.workerId,
      operation: input.operation,
      count: 1
    });
  });

  test('rolls back a queue claim when strict budget evidence cannot be persisted', async () => {
    const jobId = randomUUID();
    await databaseClient.query(
      `INSERT INTO job_data (id, worker_id, job_type, status, input)
       VALUES ($1, 'producer', 'ask', 'pending', '{}'::jsonb)`,
      [jobId]
    );
    await databaseClient.query('ALTER TABLE job_events DROP COLUMN operation');
    try {
      await expect(claimNextPendingJobWithAdmission({
        workerId: 'async-queue-slot-1',
        statsWorkerId: 'async-queue',
        priorityQueueEnabled: false,
        maxJobsPerHour: 1,
        maxAiCallsPerHour: 1,
        budgetNowForTesting: new Date('2026-08-30T17:00:00.000Z')
      })).rejects.toEqual(expect.objectContaining({ code: '42703' }));
      const job = await databaseClient.query<{ status: string; claim_generation: string }>(
        `SELECT status, claim_generation::text FROM job_data WHERE id = $1`,
        [jobId]
      );
      expect(job.rows[0]).toEqual({ status: 'pending', claim_generation: '0' });
      const evidence = await databaseClient.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
         FROM job_events
         WHERE event_type = 'worker.budget.job_claim'`
      );
      expect(evidence.rows[0]?.count).toBe(0);
    } finally {
      await databaseClient.query(
        readFileSync(
          resolve(workerBudgetMigrationDirectory, '01_add_budget_evidence_contract.sql'),
          'utf8'
        )
      );
    }
  });

  test.each([
    {
      label: 'group-window',
      indexName: 'idx_job_events_worker_budget_group_window',
      ddl: `CREATE INDEX idx_job_events_worker_budget_group_window
            ON job_events (stats_worker_id, event_type, occurred_at, id)
            WHERE event_type = 'worker.budget.job_claim'`
    },
    {
      label: 'claim-generation',
      indexName: 'idx_job_events_worker_budget_claim_generation',
      ddl: `CREATE UNIQUE INDEX idx_job_events_worker_budget_claim_generation
            ON job_events (job_id, claim_generation)
            WHERE event_type = 'worker.budget.ai_provider_attempt'`
    }
  ])('refuses a same-name $label index with a foreign predicate', async fixture => {
    await databaseClient.query(
      `DROP INDEX CONCURRENTLY IF EXISTS ${fixture.indexName}`
    );
    try {
      await databaseClient.query(fixture.ddl);
      await expectPostgresError(
        databaseClient.query(workerBudgetPrecheckIndexSql),
        `${fixture.indexName} has an unexpected definition`,
        '42804'
      );
      await expectPostgresError(
        databaseClient.query(workerBudgetVerifyIndexSql),
        `${fixture.indexName} is missing, unexpected, or invalid`,
        '42804'
      );
      await expectPostgresError(
        databaseClient.query(workerBudgetRollbackIndexSql),
        `${fixture.indexName} has an unexpected definition; rollback refused`,
        '42804'
      );
      await databaseClient.query('ROLLBACK');

      const retained = await databaseClient.query<{ present: boolean }>(
        'SELECT to_regclass($1) IS NOT NULL AS present',
        [fixture.indexName]
      );
      expect(retained.rows[0]?.present).toBe(true);
    } finally {
      await databaseClient.query('ROLLBACK').catch(() => undefined);
      await databaseClient.query(
        'DROP INDEX CONCURRENTLY IF EXISTS idx_job_events_worker_budget_claim_generation'
      );
      await databaseClient.query(
        'DROP INDEX CONCURRENTLY IF EXISTS idx_job_events_worker_budget_group_window'
      );
      await databaseClient.query(workerBudgetCreateGroupIndexSql);
      await databaseClient.query(workerBudgetCreateClaimIndexSql);
      await databaseClient.query(workerBudgetVerifyIndexSql);
    }
  });

  test('refuses to drop budget indexes while strict evidence exists, then rolls back exactly', async () => {
    const evidenceId = randomUUID();
    await databaseClient.query(
      `INSERT INTO job_events (
         id, job_id, event_type, worker_id, stats_worker_id,
         claim_generation, occurred_at, metadata
       ) VALUES (
         $1, $2, 'worker.budget.job_claim', 'rollback-slot-1',
         'rollback-budget', 1, clock_timestamp(), '{}'::jsonb
       )`,
      [evidenceId, randomUUID()]
    );

    const readRollbackState = async (): Promise<{
      group_index_present: boolean;
      claim_index_present: boolean;
      evidence_column_count: number;
      constraint_present: boolean;
      evidence_present: boolean;
    }> => {
      const result = await databaseClient.query<{
        group_index_present: boolean;
        claim_index_present: boolean;
        evidence_column_count: number;
        constraint_present: boolean;
        evidence_present: boolean;
      }>(
        `SELECT
           to_regclass('idx_job_events_worker_budget_group_window') IS NOT NULL
             AS group_index_present,
           to_regclass('idx_job_events_worker_budget_claim_generation') IS NOT NULL
             AS claim_index_present,
           (
             SELECT COUNT(*)::int
             FROM pg_attribute
             WHERE attrelid = 'job_events'::regclass
               AND attname IN ('stats_worker_id', 'claim_generation', 'operation')
               AND NOT attisdropped
           ) AS evidence_column_count,
           EXISTS (
             SELECT 1
             FROM pg_constraint
             WHERE conrelid = 'job_events'::regclass
               AND conname = 'job_events_worker_budget_shape_check'
           ) AS constraint_present,
           EXISTS (
             SELECT 1
             FROM job_events
             WHERE id = $1::uuid
           ) AS evidence_present`,
        [evidenceId]
      );
      return result.rows[0]!;
    };

    try {
      await expectPostgresError(
        databaseClient.query(workerBudgetRollbackIndexSql),
        'worker budget rollback refused because strict budget evidence exists',
        '55000'
      );
      await databaseClient.query('ROLLBACK');
      await expect(readRollbackState()).resolves.toEqual({
        group_index_present: true,
        claim_index_present: true,
        evidence_column_count: 3,
        constraint_present: true,
        evidence_present: true
      });

      await databaseClient.query('DELETE FROM job_events WHERE id = $1::uuid', [evidenceId]);
      await databaseClient.query(workerBudgetRollbackIndexSql);
      await databaseClient.query(workerBudgetRollbackContractSql);
      await expect(readRollbackState()).resolves.toEqual({
        group_index_present: false,
        claim_index_present: false,
        evidence_column_count: 0,
        constraint_present: false,
        evidence_present: false
      });
    } finally {
      await databaseClient.query('ROLLBACK').catch(() => undefined);
      await databaseClient.query('DELETE FROM job_events WHERE id = $1::uuid', [evidenceId]);
      for (const phase of workerBudgetMigrationPhases) {
        await databaseClient.query(
          readFileSync(resolve(workerBudgetMigrationDirectory, phase), 'utf8')
        );
      }
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
