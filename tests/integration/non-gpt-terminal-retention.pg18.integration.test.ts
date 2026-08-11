import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  test
} from '@jest/globals';
import { Client } from 'pg';
import {
  assertDisposablePostgresTestDatabaseUrl,
  resolvePostgresTestDatabaseUrl
} from './postgresTestDatabase.js';

let firstClient: Client;

const getPoolMock = jest.fn(() => ({
  connect: async () => ({
    query: (text: string, params: unknown[] = []) => firstClient.query(text, params),
    release: jest.fn()
  })
}));
const isDatabaseConnectedMock = jest.fn(() => true);
const repositoryQueryMock = jest.fn(
  (text: string, params: unknown[] = []) => firstClient.query(text, params)
);
const recordJobEventMock = jest.fn(async () => ({ inserted: true as const }));

jest.unstable_mockModule('@core/db/client.js', () => ({
  getPool: getPoolMock,
  isDatabaseConnected: isDatabaseConnectedMock
}));

jest.unstable_mockModule('@core/db/query.js', () => ({
  query: repositoryQueryMock
}));

jest.unstable_mockModule(
  '../../src/core/db/repositories/jobEventRepository.js',
  () => ({ recordJobEvent: recordJobEventMock })
);

const {
  MIN_NON_GPT_TERMINAL_CLEANUP_OBSERVATION_WINDOW_MS,
  RETAINED_NON_GPT_TERMINAL_CLEANUP_SQL,
  createJob,
  inspectLegacyNullNonGptTerminalJobs,
  recoverStaleJobs,
  recoverStalledJobsForWorkers,
  requestJobCancellation,
  updateClaimedJobTerminal,
  updateJob
} = await import('../../src/core/db/repositories/jobRepository.js');

const TEST_DATABASE_ENV = 'NON_GPT_TERMINAL_RETENTION_TEST_DATABASE_URL';
const configuredConnectionString =
  resolvePostgresTestDatabaseUrl(TEST_DATABASE_ENV);
if (configuredConnectionString) {
  assertDisposablePostgresTestDatabaseUrl(
    configuredConnectionString,
    TEST_DATABASE_ENV
  );
}
const describeWithDatabase = configuredConnectionString
  ? describe
  : describe.skip;
const schemaName = `non_gpt_terminal_retention_${randomUUID().replaceAll('-', '')}`;
const quotedSchema = `"${schemaName}"`;

describeWithDatabase('non-GPT terminal retention on PostgreSQL 18', () => {
  let secondClient: Client;
  let previousAskRetention: string | undefined;
  let previousDagNodeRetention: string | undefined;

  async function insertJob(
    client: Client,
    values: {
      id: string;
      jobType: string;
      status: string;
      retentionOffset?: string | null;
      idempotencyOffset?: string | null;
      completedOffset?: string | null;
      createdOffset?: string;
    }
  ): Promise<string> {
    const jobId = randomUUID();
    await client.query(
      `INSERT INTO job_data (
         id,
         worker_id,
         job_type,
         status,
         input,
         correlation_id,
         retention_until,
         idempotency_until,
         completed_at,
         created_at,
         updated_at
       )
       VALUES (
         $1,
         'queue',
         $2,
         $3,
         '{}'::jsonb,
         $4,
         CASE WHEN $5::text IS NULL THEN NULL ELSE NOW() + $5::interval END,
         CASE WHEN $6::text IS NULL THEN NULL ELSE NOW() + $6::interval END,
         CASE WHEN $7::text IS NULL THEN NULL ELSE NOW() + $7::interval END,
         NOW() + $8::interval,
         NOW() + $8::interval
       )`,
      [
        jobId,
        values.jobType,
        values.status,
        values.id,
        values.retentionOffset ?? null,
        values.idempotencyOffset ?? null,
        values.completedOffset ?? '-1 hour',
        values.createdOffset ?? '-2 hours'
      ]
    );
    return jobId;
  }

  async function readLifecycle(jobId: string): Promise<{
    status: string;
    retention_until: Date | null;
    idempotency_until: Date | null;
  }> {
    const result = await firstClient.query<{
      status: string;
      retention_until: Date | null;
      idempotency_until: Date | null;
    }>(
      `SELECT status, retention_until, idempotency_until
       FROM job_data
       WHERE id = $1`,
      [jobId]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Missing disposable test job ${jobId}.`);
    }
    return row;
  }

  async function expectDatabaseRetentionWindow(
    jobId: string,
    durationMs: number
  ): Promise<void> {
    const result = await firstClient.query<{ retention_window_ms: string | null }>(
      `SELECT ROUND(
         EXTRACT(EPOCH FROM (
           retention_until - COALESCE(completed_at, updated_at)
         )) * 1000
       )::bigint AS retention_window_ms
       FROM job_data
       WHERE id = $1`,
      [jobId]
    );
    expect(Number(result.rows[0]?.retention_window_ms)).toBe(durationMs);
  }

  beforeAll(async () => {
    if (!configuredConnectionString) {
      throw new Error(`${TEST_DATABASE_ENV} is required for this test suite.`);
    }

    firstClient = new Client({
      connectionString: configuredConnectionString,
      ssl: false,
      application_name: 'arcanos-non-gpt-terminal-retention-pg18-test-1'
    });
    secondClient = new Client({
      connectionString: configuredConnectionString,
      ssl: false,
      application_name: 'arcanos-non-gpt-terminal-retention-pg18-test-2'
    });
    await Promise.all([firstClient.connect(), secondClient.connect()]);

    const versionResult = await firstClient.query<{ server_version_num: string }>(
      `SELECT current_setting('server_version_num') AS server_version_num`
    );
    expect(Number(versionResult.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(
      180_000
    );

    await firstClient.query(`CREATE SCHEMA ${quotedSchema}`);
    for (const client of [firstClient, secondClient]) {
      await client.query(`SET search_path TO ${quotedSchema}, public`);
    }
    await firstClient.query(
      `CREATE TABLE job_data (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         worker_id VARCHAR(255) NOT NULL,
         job_type VARCHAR(255) NOT NULL,
         status VARCHAR(50) NOT NULL DEFAULT 'pending',
         claim_generation BIGINT NOT NULL DEFAULT 0,
         input JSONB NOT NULL,
         output JSONB,
         error_message TEXT,
         retry_count INTEGER NOT NULL DEFAULT 0,
         max_retries INTEGER NOT NULL DEFAULT 2,
         next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         started_at TIMESTAMPTZ,
         last_heartbeat_at TIMESTAMPTZ,
         lease_expires_at TIMESTAMPTZ,
          priority INTEGER NOT NULL DEFAULT 100,
          last_worker_id VARCHAR(255),
          stats_worker_id VARCHAR(255) COLLATE "C",
          correlation_id TEXT,
         autonomy_state JSONB NOT NULL DEFAULT '{}'::jsonb,
         request_fingerprint_hash TEXT,
         idempotency_key_hash TEXT,
         idempotency_scope_hash TEXT,
         idempotency_origin VARCHAR(32),
         retention_until TIMESTAMPTZ,
         idempotency_until TIMESTAMPTZ,
         expires_at TIMESTAMPTZ,
         cancel_requested_at TIMESTAMPTZ,
         cancel_reason TEXT,
         completed_at TIMESTAMPTZ,
         created_at TIMESTAMPTZ DEFAULT NOW(),
         updated_at TIMESTAMPTZ DEFAULT NOW()
       )`
    );
    await firstClient.query(
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

    previousAskRetention = process.env.QUEUE_ASK_TERMINAL_RETENTION_MS;
    previousDagNodeRetention = process.env.QUEUE_DAG_NODE_TERMINAL_RETENTION_MS;
    process.env.QUEUE_ASK_TERMINAL_RETENTION_MS = String(60 * 60 * 1_000);
    process.env.QUEUE_DAG_NODE_TERMINAL_RETENTION_MS = String(2 * 60 * 60 * 1_000);
  }, 30_000);

  beforeEach(async () => {
    jest.clearAllMocks();
    await firstClient.query('DELETE FROM job_events');
    await firstClient.query('DELETE FROM job_data');
  });

  afterAll(async () => {
    try {
      await firstClient.query('RESET search_path');
      await secondClient.query('RESET search_path');
      await firstClient.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    } finally {
      if (previousAskRetention === undefined) {
        delete process.env.QUEUE_ASK_TERMINAL_RETENTION_MS;
      } else {
        process.env.QUEUE_ASK_TERMINAL_RETENTION_MS = previousAskRetention;
      }
      if (previousDagNodeRetention === undefined) {
        delete process.env.QUEUE_DAG_NODE_TERMINAL_RETENTION_MS;
      } else {
        process.env.QUEUE_DAG_NODE_TERMINAL_RETENTION_MS = previousDagNodeRetention;
      }
      await Promise.all([firstClient.end(), secondClient.end()]);
    }
  }, 30_000);

  test('actual create, generic update, and claimed writers apply only non-GPT allowlisted fallbacks', async () => {
    const explicitDeadline = '2099-01-01T00:00:00.000Z';

    const createdTerminalAsk = await createJob(
      'queue',
      'ask',
      { prompt: 'created terminal ask' },
      { status: 'completed' }
    );
    await expectDatabaseRetentionWindow(createdTerminalAsk.id, 60 * 60 * 1_000);

    const genericAsk = await createJob('queue', 'ask', { prompt: 'generic ask' });
    await updateJob(genericAsk.id, 'completed', { ok: true });
    await expectDatabaseRetentionWindow(genericAsk.id, 60 * 60 * 1_000);

    const persistedAsk = await createJob(
      'queue',
      'ask',
      { prompt: 'persisted ask' },
      {
        retentionUntil: explicitDeadline,
        idempotencyUntil: explicitDeadline
      }
    );
    await updateJob(persistedAsk.id, 'cancelled', null, 'cancelled');
    const persistedLifecycle = await readLifecycle(persistedAsk.id);
    expect(persistedLifecycle.retention_until?.toISOString()).toBe(explicitDeadline);
    expect(persistedLifecycle.idempotency_until?.toISOString()).toBe(explicitDeadline);

    const claimedDagNode = await createJob(
      'queue',
      'dag-node',
      { nodeId: 'claimed-node' },
      {
        status: 'running',
        lastWorkerId: 'claimed-worker',
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 60_000)
      }
    );
    await expect(
      updateClaimedJobTerminal(claimedDagNode.id, 'completed', {
        fence: {
          workerId: 'claimed-worker',
          claimGeneration: claimedDagNode.claim_generation
        },
        output: { ok: true }
      })
    ).resolves.not.toBeNull();
    await expectDatabaseRetentionWindow(claimedDagNode.id, 2 * 60 * 60 * 1_000);

    const claimedPersistedDagNode = await createJob(
      'queue',
      'dag-node',
      { nodeId: 'claimed-persisted-node' },
      {
        status: 'running',
        lastWorkerId: 'claimed-worker',
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
        retentionUntil: explicitDeadline,
        idempotencyUntil: explicitDeadline
      }
    );
    await updateClaimedJobTerminal(claimedPersistedDagNode.id, 'cancelled', {
      fence: {
        workerId: 'claimed-worker',
        claimGeneration: claimedPersistedDagNode.claim_generation
      },
      errorMessage: 'cancelled'
    });
    const claimedPersistedLifecycle = await readLifecycle(
      claimedPersistedDagNode.id
    );
    expect(claimedPersistedLifecycle.retention_until?.toISOString()).toBe(
      explicitDeadline
    );
    expect(claimedPersistedLifecycle.idempotency_until?.toISOString()).toBe(
      explicitDeadline
    );

    const gptJob = await createJob('queue', 'gpt', { prompt: 'gpt compatibility' });
    await firstClient.query(
      `UPDATE job_data
       SET retention_until = NULL, idempotency_until = NULL
       WHERE id = $1`,
      [gptJob.id]
    );
    await updateJob(gptJob.id, 'completed', { ok: true });
    expect(await readLifecycle(gptJob.id)).toEqual({
      status: 'completed',
      retention_until: null,
      idempotency_until: null
    });

    const unknownJob = await createJob('queue', 'unknown', { prompt: 'unknown' });
    await updateJob(unknownJob.id, 'completed', { ok: true });
    expect((await readLifecycle(unknownJob.id)).retention_until).toBeNull();
  });

  test('actual pending cancellation preserves persisted lifecycle before applying a fallback', async () => {
    const explicitDeadline = '2099-01-01T00:00:00.000Z';
    const pendingAsk = await createJob('queue', 'ask', { prompt: 'cancel ask' });
    await expect(requestJobCancellation(pendingAsk.id)).resolves.toEqual(
      expect.objectContaining({ outcome: 'cancelled' })
    );
    await expectDatabaseRetentionWindow(pendingAsk.id, 60 * 60 * 1_000);

    const persistedDagNode = await createJob(
      'queue',
      'dag-node',
      { nodeId: 'cancel-persisted' },
      {
        retentionUntil: explicitDeadline,
        idempotencyUntil: explicitDeadline
      }
    );
    await requestJobCancellation(persistedDagNode.id);
    const persistedLifecycle = await readLifecycle(persistedDagNode.id);
    expect(persistedLifecycle.retention_until?.toISOString()).toBe(explicitDeadline);
    expect(persistedLifecycle.idempotency_until?.toISOString()).toBe(explicitDeadline);

    const unknownJob = await createJob('queue', 'unknown', { prompt: 'cancel unknown' });
    await requestJobCancellation(unknownJob.id);
    expect((await readLifecycle(unknownJob.id)).retention_until).toBeNull();
  });

  test('actual stale and stalled recovery writers retain allowlisted cancellations and exclude other types', async () => {
    const explicitDeadline = '2099-01-01T00:00:00.000Z';
    const staleTimestamp = new Date(Date.now() - 10 * 60 * 1_000);
    const expiredLease = new Date(Date.now() - 60_000);

    const staleAsk = await createJob('queue', 'ask', { prompt: 'stale ask' }, {
      status: 'running',
      lastWorkerId: 'stale-worker',
      startedAt: staleTimestamp,
      lastHeartbeatAt: null,
      leaseExpiresAt: expiredLease,
      cancelRequestedAt: staleTimestamp,
      cancelReason: 'cancel stale ask'
    });
    const staleUnknown = await createJob(
      'queue',
      'unknown',
      { prompt: 'stale unknown' },
      {
        status: 'running',
        lastWorkerId: 'stale-worker',
        startedAt: staleTimestamp,
        lastHeartbeatAt: null,
        leaseExpiresAt: expiredLease,
        cancelRequestedAt: staleTimestamp,
        cancelReason: 'cancel stale unknown'
      }
    );
    const excludedLocalAgent = await createJob(
      'queue',
      'local-agent',
      { prompt: 'stale local agent' },
      {
        status: 'running',
        lastWorkerId: 'stale-worker',
        startedAt: staleTimestamp,
        lastHeartbeatAt: null,
        leaseExpiresAt: expiredLease,
        cancelRequestedAt: staleTimestamp,
        cancelReason: 'cancel stale local agent'
      }
    );

    const staleRecovery = await recoverStaleJobs({
      staleAfterMs: 1_000,
      maxRetries: 2
    });
    expect(staleRecovery.cancelledJobs).toEqual(
      expect.arrayContaining([staleAsk.id, staleUnknown.id])
    );
    await expectDatabaseRetentionWindow(staleAsk.id, 60 * 60 * 1_000);
    expect((await readLifecycle(staleUnknown.id)).retention_until).toBeNull();
    expect(await readLifecycle(excludedLocalAgent.id)).toEqual({
      status: 'running',
      retention_until: null,
      idempotency_until: null
    });

    const stalledDagNode = await createJob(
      'queue',
      'dag-node',
      { nodeId: 'stalled-fallback' },
      {
        status: 'running',
        lastWorkerId: 'stalled-worker',
        startedAt: staleTimestamp,
        lastHeartbeatAt: null,
        leaseExpiresAt: new Date(Date.now() + 60_000),
        cancelRequestedAt: staleTimestamp,
        cancelReason: 'cancel stalled DAG node'
      }
    );
    const stalledPersistedDagNode = await createJob(
      'queue',
      'dag-node',
      { nodeId: 'stalled-persisted' },
      {
        status: 'running',
        lastWorkerId: 'stalled-worker',
        startedAt: staleTimestamp,
        lastHeartbeatAt: null,
        leaseExpiresAt: new Date(Date.now() + 60_000),
        cancelRequestedAt: staleTimestamp,
        cancelReason: 'cancel persisted stalled DAG node',
        retentionUntil: explicitDeadline,
        idempotencyUntil: explicitDeadline
      }
    );

    const stalledRecovery = await recoverStalledJobsForWorkers({
      workerIds: ['stalled-worker'],
      staleAfterMs: 1_000,
      maxRetries: 2
    });
    expect(stalledRecovery.cancelledJobIds).toEqual(
      expect.arrayContaining([stalledDagNode.id, stalledPersistedDagNode.id])
    );
    await expectDatabaseRetentionWindow(
      stalledDagNode.id,
      2 * 60 * 60 * 1_000
    );
    const stalledPersistedLifecycle = await readLifecycle(
      stalledPersistedDagNode.id
    );
    expect(stalledPersistedLifecycle.retention_until?.toISOString()).toBe(
      explicitDeadline
    );
    expect(stalledPersistedLifecycle.idempotency_until?.toISOString()).toBe(
      explicitDeadline
    );
  });

  test('deletes only the oldest eligible allowlisted rows in bounded repeatable batches', async () => {
    const eligibleRows = [
      ['eligible-1', 'ask', 'completed', '-5 hours'],
      ['eligible-2', 'dag-node', 'cancelled', '-4 hours'],
      ['eligible-3', 'ask', 'cancelled', '-3 hours'],
      ['eligible-4', 'dag-node', 'completed', '-2 hours'],
      ['eligible-5', 'ask', 'completed', '-1 hour']
    ] as const;
    const eligibleJobIds: string[] = [];
    for (const [id, jobType, status, retentionOffset] of eligibleRows) {
      eligibleJobIds.push(
        await insertJob(firstClient, { id, jobType, status, retentionOffset })
      );
    }

    const protectedLiveIdempotencyId = await insertJob(firstClient, {
      id: 'protected-live-idempotency',
      jobType: 'ask',
      status: 'completed',
      retentionOffset: '-6 hours',
      idempotencyOffset: '1 hour'
    });
    const protectedObservationWindowId = await insertJob(firstClient, {
      id: 'protected-observation-window',
      jobType: 'dag-node',
      status: 'completed',
      retentionOffset: '-6 hours',
      createdOffset: '-30 minutes'
    });
    await insertJob(firstClient, {
      id: 'protected-recent',
      jobType: 'dag-node',
      status: 'completed',
      retentionOffset: '1 hour'
    });
    await insertJob(firstClient, {
      id: 'protected-legacy-null',
      jobType: 'ask',
      status: 'completed',
      retentionOffset: null
    });
    for (const [id, jobType, status] of [
      ['protected-gpt', 'gpt', 'completed'],
      ['protected-local-agent', 'local-agent', 'cancelled'],
      ['protected-failed', 'ask', 'failed'],
      ['protected-running', 'dag-node', 'running'],
      ['protected-unknown', 'other', 'completed']
    ] as const) {
      await insertJob(firstClient, {
        id,
        jobType,
        status,
        retentionOffset: '-1 day'
      });
    }

    await expect(
      inspectLegacyNullNonGptTerminalJobs({ sampleLimit: 2 })
    ).resolves.toEqual({
      sampleLimit: 2,
      observedTerminal: 1,
      observedAsk: 1,
      observedDagNode: 0,
      observedCompleted: 1,
      observedCancelled: 0,
      sampleLimitReached: false
    });

    const firstBatch = await firstClient.query<{ id: string }>(
      RETAINED_NON_GPT_TERMINAL_CLEANUP_SQL,
      [2, MIN_NON_GPT_TERMINAL_CLEANUP_OBSERVATION_WINDOW_MS]
    );
    expect(firstBatch.rows.map(row => row.id)).toEqual(eligibleJobIds.slice(0, 2));

    const secondBatch = await firstClient.query<{ id: string }>(
      RETAINED_NON_GPT_TERMINAL_CLEANUP_SQL,
      [2, MIN_NON_GPT_TERMINAL_CLEANUP_OBSERVATION_WINDOW_MS]
    );
    expect(secondBatch.rows.map(row => row.id)).toEqual(eligibleJobIds.slice(2, 4));

    const thirdBatch = await firstClient.query<{ id: string }>(
      RETAINED_NON_GPT_TERMINAL_CLEANUP_SQL,
      [2, MIN_NON_GPT_TERMINAL_CLEANUP_OBSERVATION_WINDOW_MS]
    );
    expect(thirdBatch.rows.map(row => row.id)).toEqual(eligibleJobIds.slice(4));

    const repeated = await firstClient.query<{ id: string }>(
      RETAINED_NON_GPT_TERMINAL_CLEANUP_SQL,
      [2, MIN_NON_GPT_TERMINAL_CLEANUP_OBSERVATION_WINDOW_MS]
    );
    expect(repeated.rows).toEqual([]);

    const protectedRows = await firstClient.query<{ correlation_id: string }>(
      `SELECT correlation_id FROM job_data ORDER BY correlation_id`
    );
    expect(protectedRows.rows.map(row => row.correlation_id)).toEqual([
      'protected-failed',
      'protected-gpt',
      'protected-legacy-null',
      'protected-live-idempotency',
      'protected-local-agent',
      'protected-observation-window',
      'protected-recent',
      'protected-running',
      'protected-unknown'
    ]);

    await firstClient.query(
      `UPDATE job_data
       SET idempotency_until = NOW() - INTERVAL '1 second'
       WHERE id = $1`,
      [protectedLiveIdempotencyId]
    );
    const afterIdempotency = await firstClient.query<{ id: string }>(
      RETAINED_NON_GPT_TERMINAL_CLEANUP_SQL,
      [2, MIN_NON_GPT_TERMINAL_CLEANUP_OBSERVATION_WINDOW_MS]
    );
    expect(afterIdempotency.rows.map(row => row.id)).toEqual([
      protectedLiveIdempotencyId
    ]);

    await firstClient.query(
      `UPDATE job_data
       SET updated_at = NOW() - INTERVAL '2 hours'
       WHERE id = $1`,
      [protectedObservationWindowId]
    );
    const afterObservationWindow = await firstClient.query<{ id: string }>(
      RETAINED_NON_GPT_TERMINAL_CLEANUP_SQL,
      [2, MIN_NON_GPT_TERMINAL_CLEANUP_OBSERVATION_WINDOW_MS]
    );
    expect(afterObservationWindow.rows.map(row => row.id)).toEqual([
      protectedObservationWindowId
    ]);
  });

  test('skips a row locked by another cleanup owner without exceeding the batch', async () => {
    const insertedJobIds: string[] = [];
    for (const [id, retentionOffset] of [
      ['locked-oldest', '-3 hours'],
      ['available-middle', '-2 hours'],
      ['available-newest', '-1 hour']
    ] as const) {
      insertedJobIds.push(
        await insertJob(firstClient, {
          id,
          jobType: 'ask',
          status: 'completed',
          retentionOffset
        })
      );
    }

    await firstClient.query('BEGIN');
    try {
      await firstClient.query(
        `SELECT id FROM job_data WHERE id = $1 FOR UPDATE`,
        [insertedJobIds[0]]
      );
      const concurrentBatch = await secondClient.query<{ id: string }>(
        RETAINED_NON_GPT_TERMINAL_CLEANUP_SQL,
        [2, MIN_NON_GPT_TERMINAL_CLEANUP_OBSERVATION_WINDOW_MS]
      );
      expect(concurrentBatch.rows.map(row => row.id)).toEqual([
        insertedJobIds[1],
        insertedJobIds[2]
      ]);
    } finally {
      await firstClient.query('ROLLBACK');
    }

    const finalBatch = await firstClient.query<{ id: string }>(
      RETAINED_NON_GPT_TERMINAL_CLEANUP_SQL,
      [2, MIN_NON_GPT_TERMINAL_CLEANUP_OBSERVATION_WINDOW_MS]
    );
    expect(finalBatch.rows.map(row => row.id)).toEqual([insertedJobIds[0]]);
  });
});
