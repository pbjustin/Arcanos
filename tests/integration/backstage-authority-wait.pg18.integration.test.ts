import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Client, Pool, type PoolClient } from 'pg';
import {
  assertDisposablePostgresTestDatabaseUrl,
  resolvePostgresTestDatabaseUrl,
} from './postgresTestDatabase.js';
import {
  BACKSTAGE_AUTHORITY_WAIT_MAX_MS,
  planBackstageAuthorityWait,
  readBackstageAuthorityWaitState,
} from '../../src/shared/backstage/backstageAuthorityWait.js';
import type { JobData } from '../../src/core/db/schema.js';

const TEST_DATABASE_ENV = 'BACKSTAGE_AUTHORITY_WAIT_TEST_DATABASE_URL';
const connectionString = resolvePostgresTestDatabaseUrl(TEST_DATABASE_ENV);
if (connectionString) assertDisposablePostgresTestDatabaseUrl(connectionString, TEST_DATABASE_ENV);
const describeDatabase = connectionString ? describe : describe.skip;
const schemaName = `backstage_authority_wait_${randomUUID().replaceAll('-', '')}`;
const quotedSchema = `"${schemaName}"`;
let pool: Pool;
let setup: Client;
let directQueryClient: PoolClient | null = null;

// Only connection ownership and event delivery are injected. Every repository
// statement, transaction, row lock, JSONB operation and budget reservation runs
// in PostgreSQL; no query responses or SQL predicates are mocked.
jest.unstable_mockModule('@core/db/client.js', () => ({
  getPool: () => pool,
  isDatabaseConnected: () => true,
}));
jest.unstable_mockModule('@core/db/query.js', () => ({
  query: (sql: string, params: unknown[] = []) => (directQueryClient ?? pool).query(sql, params),
}));
jest.unstable_mockModule('../../src/core/db/repositories/jobEventRepository.js', () => ({
  recordJobEvent: jest.fn(async () => ({ inserted: true })),
  recordJobEventWithClient: jest.fn(async () => ({ inserted: true })),
}));

const {
  beginBackstageAuthorityGeneration,
  claimNextPendingJobWithAdmission,
  deferJobForProviderRecovery,
  getJobById,
  recordJobHeartbeat,
  recoverStaleJobs,
  recoverStalledJobsForWorkers,
  requestJobCancellation,
  updateClaimedJobTerminal,
} = await import('../../src/core/db/repositories/jobRepository.js');

const protectedInput = {
  gptId: 'backstage-booker',
  protectedBackstage: {
    version: 1, source: 'backstage-booker-http',
    envelopeId: '11111111-1111-4111-8111-111111111111',
    action: 'generateBooking', universeId: 'synthetic-pg18-universe', sealedPayload: {},
  },
};

function waitState(now = Date.now(), pollCount = 1) {
  return { version: 1 as const, startedAt: now, deadlineAt: now + BACKSTAGE_AUTHORITY_WAIT_MAX_MS, pollCount };
}

function fence(job: JobData) {
  return { workerId: job.last_worker_id!, claimGeneration: job.claim_generation! };
}

async function insertJob(options: {
  id?: string; protected?: boolean; state?: Record<string, unknown>; nextRunAt?: number;
} = {}): Promise<string> {
  const id = options.id ?? randomUUID();
  await setup.query(
    `INSERT INTO job_data (id, worker_id, job_type, input, autonomy_state, next_run_at)
     VALUES ($1::uuid, 'producer', $2, $3::jsonb, $4::jsonb, COALESCE($5::timestamptz, NOW()))`,
    [id, options.protected === false ? 'ask' : 'gpt', JSON.stringify(options.protected === false ? {} : protectedInput),
      JSON.stringify(options.state ?? {}), options.nextRunAt === undefined ? null : new Date(options.nextRunAt)],
  );
  return id;
}

async function claim(workerId = 'slot-a', now?: number, maxJobsPerHour?: number) {
  return claimNextPendingJobWithAdmission({
    workerId, statsWorkerId: 'authority-pg18-group', leaseMs: 60_000,
    priorityQueueEnabled: false,
    ...(now === undefined ? {} : { budgetNowForTesting: new Date(now) }),
    ...(maxJobsPerHour === undefined ? {} : { maxJobsPerHour }),
  });
}

async function defer(job: JobData, state = waitState(), delayMs = 15_000) {
  return deferJobForProviderRecovery(job.id, {
    fence: fence(job), delayMs, errorMessage: 'BACKSTAGE_NOTION_INDEX_UNAVAILABLE',
    deferralKind: 'backstage_notion_authority', autonomyState: { backstageAuthorityWait: state },
  });
}

async function waitForBlockedTransaction(blockerPid: number) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await setup.query<{ blocked: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
       WHERE $1::int = ANY(pg_blocking_pids(pid))) AS blocked`, [blockerPid],
    );
    if (result.rows[0]?.blocked) return;
  }
  throw new Error('Expected the competing repository transaction to block on its fixture row.');
}

describeDatabase('protected authority queue transitions on disposable PostgreSQL 18', () => {
  beforeAll(async () => {
    setup = new Client({ connectionString, ssl: false });
    await setup.connect();
    const version = await setup.query<{ version: string }>("SELECT current_setting('server_version_num') AS version");
    expect(Number(version.rows[0]?.version)).toBeGreaterThanOrEqual(180_000);
    expect(Number(version.rows[0]?.version)).toBeLessThan(190_000);
    await setup.query(`CREATE SCHEMA ${quotedSchema}`);
    await setup.query(`SET search_path TO ${quotedSchema}, public`);
    await setup.query(`CREATE TABLE job_data (
      id UUID PRIMARY KEY, worker_id TEXT NOT NULL, job_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', input JSONB NOT NULL DEFAULT '{}'::jsonb,
      output JSONB, error_message TEXT, retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 0, claim_generation BIGINT NOT NULL DEFAULT 0,
      next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), started_at TIMESTAMPTZ,
      last_heartbeat_at TIMESTAMPTZ, lease_expires_at TIMESTAMPTZ, priority INTEGER NOT NULL DEFAULT 100,
      last_worker_id TEXT, stats_worker_id VARCHAR(255) COLLATE "C", correlation_id TEXT,
      autonomy_state JSONB NOT NULL DEFAULT '{}'::jsonb, cancel_requested_at TIMESTAMPTZ,
      cancel_reason TEXT, idempotency_until TIMESTAMPTZ, retention_until TIMESTAMPTZ, expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )`);
    await setup.query(`CREATE TABLE job_events (
      id UUID PRIMARY KEY, job_id UUID NOT NULL, event_type TEXT NOT NULL, worker_id TEXT,
      stats_worker_id VARCHAR(255) COLLATE "C", claim_generation BIGINT, operation TEXT,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    )`);
    pool = new Pool({ connectionString, ssl: false, max: 6,
      options: `-c search_path=${schemaName},public`, application_name: 'backstage-authority-wait-pg18' });
  }, 30_000);

  beforeEach(async () => {
    directQueryClient = null;
    await setup.query('TRUNCATE job_data, job_events');
  });

  afterAll(async () => {
    directQueryClient = null;
    await pool?.end();
    if (setup) {
      await setup.query('RESET search_path');
      await setup.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      await setup.end();
    }
  }, 30_000);

  test('persists one wait atomically, releases its lease, preserves retries and rejects old-owner writes', async () => {
    const id = await insertJob({ state: { retained: 'synthetic' } });
    const { job } = await claim();
    expect(job?.id).toBe(id);
    const state = waitState();
    const pending = await defer(job!, state);
    expect(pending).toMatchObject({ id, status: 'pending', retry_count: 0, started_at: null,
      lease_expires_at: null, last_heartbeat_at: null,
      autonomy_state: { retained: 'synthetic', backstageAuthorityWait: state } });
    expect(new Date(pending!.next_run_at!).getTime()).toBeGreaterThan(Date.now() + 10_000);
    expect(await recordJobHeartbeat(id, { fence: fence(job!), leaseMs: 60_000 })).toBeNull();
    expect(await updateClaimedJobTerminal(id, 'completed', { fence: fence(job!), output: { invalid: true } })).toBeNull();
    await setup.query('UPDATE job_data SET next_run_at = NOW() WHERE id = $1', [id]);
    const second = (await claim('slot-b')).job!;
    expect(second.claim_generation).toBe('2');
    expect(readBackstageAuthorityWaitState(second.autonomy_state)).toEqual(state);
    expect(await defer(job!, state)).toBeNull();
    expect((await getJobById(id))?.last_worker_id).toBe('slot-b');
  });

  test.each(['lease', 'watchdog'] as const)('recovers a restarted pre-model %s wait without resetting deadline or retries', async kind => {
    const state = waitState(Date.now() - 120_000, 3);
    const id = await insertJob({ state: { backstageAuthorityWait: state } });
    await claim();
    await setup.query(`UPDATE job_data SET lease_expires_at = NOW() - INTERVAL '2 minutes',
      last_heartbeat_at = NOW() - INTERVAL '2 minutes', updated_at = NOW() - INTERVAL '2 minutes' WHERE id = $1`, [id]);
    if (kind === 'lease') {
      expect((await recoverStaleJobs({ staleAfterMs: 1_000, maxRetries: 0 })).recoveredJobs).toEqual([id]);
    } else {
      expect((await recoverStalledJobsForWorkers({ workerIds: ['slot-a'], staleAfterMs: 1_000, maxRetries: 0 })).requeuedJobIds).toEqual([id]);
    }
    expect(await getJobById(id)).toMatchObject({ status: 'pending', started_at: null, retry_count: 0,
      autonomy_state: { backstageAuthorityWait: state } });
    const restarted = (await claim('slot-restarted')).job!;
    expect(restarted.claim_generation).toBe('2');
    await setup.query("UPDATE job_data SET started_at = NOW() - INTERVAL '8 minutes' WHERE id = $1", [id]);
    const begun = await beginBackstageAuthorityGeneration(id, { fence: fence(restarted) });
    expect(begun?.started_at).not.toBeNull();
    expect(new Date(begun!.started_at!).getTime()).toBeGreaterThan(Date.now() - 5_000);
    expect(readBackstageAuthorityWaitState(begun?.autonomy_state)).toEqual({ ...state, executionClaimGeneration: '2' });
    expect(await beginBackstageAuthorityGeneration(id, { fence: fence(restarted) })).toBeNull();
    await setup.query(`UPDATE job_data SET lease_expires_at = NOW() - INTERVAL '2 minutes',
      last_heartbeat_at = NOW() - INTERVAL '2 minutes', updated_at = NOW() - INTERVAL '2 minutes' WHERE id = $1`, [id]);
    await recoverStaleJobs({ staleAfterMs: 1_000, maxRetries: 0 });
    expect(await getJobById(id)).toMatchObject({ status: 'failed', retry_count: 0,
      autonomy_state: { backstageAuthorityWait: { ...state, executionClaimGeneration: '2' } } });
    expect((await claim('slot-c')).job).toBeNull();
    expect(await defer(restarted, state)).toBeNull();
  });

  test('admits only one of two competing workers and preserves terminal status', async () => {
    const id = await insertJob({ state: { backstageAuthorityWait: waitState() } });
    const results = await Promise.all([claim('slot-a'), claim('slot-b')]);
    const jobs = results.flatMap(result => result.job ? [result.job] : []);
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job.id).toBe(id);
    const executions = await Promise.all([
      beginBackstageAuthorityGeneration(id, { fence: fence(job) }),
      beginBackstageAuthorityGeneration(id, { fence: fence(job) }),
    ]);
    expect(executions.filter(Boolean)).toHaveLength(1);
    expect(await updateClaimedJobTerminal(id, 'failed', { fence: fence(job), output: null,
      errorMessage: 'Synthetic protected failure.' })).not.toBeNull();
    expect(await defer(job)).toBeNull();
    expect((await getJobById(id))?.status).toBe('failed');
  });

  test('retains the execution marker across recovery even when a generic retry remains', async () => {
    const state = waitState();
    const id = await insertJob({ state: { backstageAuthorityWait: state } });
    const job = (await claim()).job!;
    expect(await beginBackstageAuthorityGeneration(id, { fence: fence(job) })).not.toBeNull();
    await setup.query(`UPDATE job_data SET max_retries = 2, lease_expires_at = NOW() - INTERVAL '2 minutes',
      last_heartbeat_at = NOW() - INTERVAL '2 minutes', updated_at = NOW() - INTERVAL '2 minutes' WHERE id = $1`, [id]);
    expect((await recoverStaleJobs({ staleAfterMs: 1_000, maxRetries: 2 })).recoveredJobs).toEqual([id]);
    const restarted = (await claim('slot-restarted')).job!;
    expect(restarted.retry_count).toBe(1);
    expect(restarted.claim_generation).toBe('2');
    expect(readBackstageAuthorityWaitState(restarted.autonomy_state)).toEqual({ ...state, executionClaimGeneration: '1' });
    expect(await beginBackstageAuthorityGeneration(id, { fence: fence(restarted) })).toBeNull();
  });

  test('stale recovery persists cancellation instead of resurrecting a pre-model wait', async () => {
    const id = await insertJob({ state: { backstageAuthorityWait: waitState() } });
    await claim();
    await requestJobCancellation(id, 'Synthetic cancellation before worker restart.');
    await setup.query(`UPDATE job_data SET lease_expires_at = NOW() - INTERVAL '2 minutes',
      last_heartbeat_at = NOW() - INTERVAL '2 minutes', updated_at = NOW() - INTERVAL '2 minutes' WHERE id = $1`, [id]);
    expect((await recoverStaleJobs({ staleAfterMs: 1_000, maxRetries: 0 })).cancelledJobs).toEqual([id]);
    expect(await getJobById(id)).toMatchObject({ status: 'cancelled', retry_count: 0, lease_expires_at: null });
    expect((await claim('slot-restarted')).job).toBeNull();
  });

  test('rejects the expired deadline and cancellation before execution without resetting the operation clock', async () => {
    const state = waitState(Date.now() - BACKSTAGE_AUTHORITY_WAIT_MAX_MS - 1_000);
    const id = await insertJob({ state: { backstageAuthorityWait: state } });
    const job = (await claim()).job!;
    expect(await beginBackstageAuthorityGeneration(id, { fence: fence(job) })).toBeNull();
    expect((await getJobById(id))?.started_at).toEqual(job.started_at);
    await setup.query('UPDATE job_data SET autonomy_state = $2::jsonb WHERE id = $1',
      [id, JSON.stringify({ backstageAuthorityWait: waitState() })]);
    await requestJobCancellation(id, 'Synthetic cancellation.');
    expect(await beginBackstageAuthorityGeneration(id, { fence: fence(job) })).toBeNull();
    expect(await defer(job)).toBeNull();
  });

  test.each(['generation', 'deferral'] as const)('rejects %s when the immutable deadline passes while its UPDATE waits for a row lock', async kind => {
    const blocker = await pool.connect();
    const competing = await pool.connect();
    let execution: ReturnType<typeof beginBackstageAuthorityGeneration> | undefined;
    try {
      const clock = await setup.query<{ now: string }>("SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::text AS now");
      const deadline = Number(clock.rows[0]!.now) + 500;
      const state = waitState(deadline - BACKSTAGE_AUTHORITY_WAIT_MAX_MS);
      const id = await insertJob({ state: { backstageAuthorityWait: state } });
      const job = (await claim()).job!;
      const pid = Number((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM job_data WHERE id = $1 FOR UPDATE', [id]);
      directQueryClient = competing;
      execution = kind === 'generation'
        ? beginBackstageAuthorityGeneration(id, { fence: fence(job) })
        : defer(job, state, 120_000);
      await waitForBlockedTransaction(pid);
      // Wait on the database clock itself, after proving the production UPDATE
      // is blocked; this exercises lock delay rather than a pre-expired input.
      const limit = Date.now() + 2_000;
      while (Date.now() < limit) {
        const now = await setup.query<{ expired: boolean }>(
          'SELECT EXTRACT(EPOCH FROM clock_timestamp()) * 1000 >= $1::bigint AS expired', [deadline],
        );
        if (now.rows[0]?.expired) break;
      }
      expect((await setup.query<{ expired: boolean }>(
        'SELECT EXTRACT(EPOCH FROM clock_timestamp()) * 1000 >= $1::bigint AS expired', [deadline],
      )).rows[0]?.expired).toBe(true);
      await blocker.query('COMMIT');
      expect(await execution).toBeNull();
      const persisted = await getJobById(id);
      expect(readBackstageAuthorityWaitState(persisted?.autonomy_state)).toEqual(state);
      expect(persisted?.started_at).toEqual(job.started_at);
    } finally {
      await blocker.query('ROLLBACK');
      if (execution) await execution;
      directQueryClient = null;
      competing.release(); blocker.release();
    }
  });

  test('clamps the persisted next poll to the immutable deadline instead of adding a full delay', async () => {
    const clock = await setup.query<{ now: string }>("SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::text AS now");
    const deadline = Number(clock.rows[0]!.now) + 5_000;
    const state = waitState(deadline - BACKSTAGE_AUTHORITY_WAIT_MAX_MS);
    const id = await insertJob({ state: { backstageAuthorityWait: state } });
    const job = (await claim()).job!;
    expect(job.id).toBe(id);
    const deferred = await defer(job, state, 120_000);
    expect(deferred?.status).toBe('pending');
    expect(new Date(deferred!.next_run_at!).getTime()).toBe(deadline);
    expect(new Date(deferred!.updated_at!).getTime()).toBeLessThan(deadline);
    expect(readBackstageAuthorityWaitState(deferred?.autonomy_state)).toEqual(state);
    expect(deferred?.retry_count).toBe(0);
  });

  test('lets a committed cancellation beat a blocked deferral after PostgreSQL rechecks its predicate', async () => {
    const id = await insertJob();
    const job = (await claim()).job!;
    const blocker = await pool.connect();
    const competing = await pool.connect();
    let deferred: ReturnType<typeof defer> | undefined;
    try {
      const pid = Number((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      await blocker.query('BEGIN');
      await blocker.query('UPDATE job_data SET cancel_requested_at = NOW() WHERE id = $1', [id]);
      directQueryClient = competing;
      deferred = defer(job);
      await waitForBlockedTransaction(pid);
      await blocker.query('COMMIT');
      expect(await deferred).toBeNull();
      expect(await getJobById(id)).toMatchObject({ status: 'running', retry_count: 0 });
    } finally {
      await blocker.query('ROLLBACK');
      if (deferred) await deferred;
      directQueryClient = null;
      competing.release(); blocker.release();
    }
  });

  test('cancels the pending row when deferral commits before a competing cancellation', async () => {
    const id = await insertJob();
    const job = (await claim()).job!;
    const blocker = await pool.connect();
    let cancellation: ReturnType<typeof requestJobCancellation> | undefined;
    try {
      const pid = Number((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      await blocker.query('BEGIN');
      directQueryClient = blocker;
      expect(await defer(job)).not.toBeNull();
      directQueryClient = null;
      cancellation = requestJobCancellation(id, 'Synthetic cancellation.');
      await waitForBlockedTransaction(pid);
      await blocker.query('COMMIT');
      expect((await cancellation).outcome).toBe('cancelled');
      expect(await getJobById(id)).toMatchObject({ status: 'cancelled', lease_expires_at: null, retry_count: 0 });
      expect((await claim('slot-b')).job).toBeNull();
    } finally {
      await blocker.query('ROLLBACK');
      if (cancellation) await cancellation;
      directQueryClient = null;
      blocker.release();
    }
  });

  // Virtual time controls scheduler due dates and the repository's existing
  // test-only budget clock. It does not replace database responses. The status
  // change represents Notion readiness; no Notion/provider/client is invoked.
  async function runCapacityScenario(input: { bookings: number; readyAtMs?: number; used?: number; cancelOne?: boolean }) {
    const start = Date.now();
    const ids: string[] = [];
    for (let index = 0; index < input.bookings; index += 1) ids.push(await insertJob({ nextRunAt: start }));
    const unrelated = new Set<string>();
    for (let index = 0; index < 16; index += 1) {
      unrelated.add(await insertJob({ protected: false, nextRunAt: start + (index + 1) * 15_000 }));
    }
    for (let index = 0; index < (input.used ?? 0); index += 1) {
      await setup.query(`INSERT INTO job_events (id, job_id, event_type, stats_worker_id, worker_id, claim_generation, occurred_at)
        VALUES ($1, $2, 'worker.budget.job_claim', 'authority-pg18-group', 'previous-slot', 1, $3)`,
      [randomUUID(), randomUUID(), new Date(start - 1_000)]);
    }
    const completed = new Set<string>();
    const expired = new Set<string>();
    let unrelatedCompleted = 0;
    let blocked = false;
    let cancelled = false;
    let now = start;
    for (let iteration = 0; iteration < 400; iteration += 1) {
      const result = await claim(iteration % 2 ? 'slot-restarted' : 'slot-a', now, 120);
      if (result.budgetAdmission && !result.budgetAdmission.allowed) { blocked = true; break; }
      const job = result.job;
      if (!job) {
        const due = await setup.query<{ next: Date | null }>("SELECT MIN(next_run_at) AS next FROM job_data WHERE status = 'pending'");
        if (!due.rows[0]?.next) break;
        now = Math.max(now + 1, due.rows[0].next.getTime());
        continue;
      }
      if (unrelated.has(job.id)) {
        await updateClaimedJobTerminal(job.id, 'completed', { fence: fence(job), output: { synthetic: true } });
        unrelatedCompleted += 1;
        continue;
      }
      if (input.cancelOne && !cancelled) {
        await requestJobCancellation(job.id, 'Synthetic cancellation during authority waiting.');
        expect(await defer(job)).toBeNull();
        await updateClaimedJobTerminal(job.id, 'cancelled', { fence: fence(job), output: null });
        cancelled = true;
        continue;
      }
      const state = readBackstageAuthorityWaitState(job.autonomy_state);
      const plan = planBackstageAuthorityWait(job.autonomy_state, now, job.id);
      if (plan.status !== 'defer') {
        expect(plan.status).toBe('expired');
        await updateClaimedJobTerminal(job.id, 'failed', { fence: fence(job), output: null,
          errorMessage: 'BACKSTAGE_NOTION_INDEX_UNAVAILABLE' });
        expired.add(job.id);
      } else if (input.readyAtMs !== undefined && now >= start + input.readyAtMs) {
        expect(state).not.toBe('invalid');
        if (state) expect(await beginBackstageAuthorityGeneration(job.id, { fence: fence(job) })).not.toBeNull();
        await updateClaimedJobTerminal(job.id, 'completed', { fence: fence(job), output: { synthetic: true } });
        completed.add(job.id);
      } else {
        expect(await defer(job, plan.state, plan.delayMs)).not.toBeNull();
        await setup.query('UPDATE job_data SET next_run_at = $2 WHERE id = $1', [job.id, new Date(now + plan.delayMs)]);
      }
    }
    const count = await setup.query<{ claims: number; ai: number }>(`SELECT
      COUNT(*) FILTER (WHERE event_type = 'worker.budget.job_claim')::int AS claims,
      COUNT(*) FILTER (WHERE event_type = 'worker.budget.ai_provider_attempt')::int AS ai FROM job_events`);
    return { start, now, completed, expired, unrelatedCompleted, blocked, cancelled, ids, ...count.rows[0]! };
  }

  test.each([1, 8])('%i bookings survive an eight-minute refresh with unrelated work and preserved hard claim limits', async bookings => {
    const result = await runCapacityScenario({ bookings, readyAtMs: 8 * 60_000, used: 24 });
    expect(result.blocked).toBe(false);
    expect(result.completed.size).toBe(bookings);
    expect(result.unrelatedCompleted).toBe(16);
    expect(result.expired.size).toBe(0);
    // The real ledger contains eight claims per booking plus 24 prior and
    // sixteen unrelated claims: 48 for one booking, 104 for eight bookings.
    expect(result.claims).toBe(24 + bookings * 8 + 16);
    expect(result.now - result.start).toBeLessThanOrEqual(10 * 60_000);
    expect(result.ai).toBe(0);
  }, 30_000);

  test('eight waits expire at the immutable twelve-minute deadline across worker changes and cancellation', async () => {
    const result = await runCapacityScenario({ bookings: 8, cancelOne: true });
    expect(result.blocked).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.expired.size).toBe(7);
    expect(result.completed.size).toBe(0);
    expect(result.unrelatedCompleted).toBe(16);
    expect(result.now - result.start).toBe(BACKSTAGE_AUTHORITY_WAIT_MAX_MS);
    expect(result.claims).toBeLessThanOrEqual(8 * 10 + 16);
    expect(result.ai).toBe(0);
  }, 30_000);

  test.each([{ bookings: 24, used: 0 }, { bookings: 8, used: 100 }])(
    'overload preserves the hard 120-claim cap without admitting AI: %j', async scenario => {
      const result = await runCapacityScenario({ ...scenario, readyAtMs: 8 * 60_000 });
      expect(result.blocked).toBe(true);
      expect(result.claims).toBe(120);
      expect(result.completed.size).toBe(0);
      expect(result.ai).toBe(0);
      const before = await setup.query('SELECT COUNT(*)::int AS count FROM job_events');
      const denied = await claim('slot-after-restart', result.now, 120);
      expect(denied.job).toBeNull();
      expect(denied.budgetAdmission?.allowed).toBe(false);
      expect((await setup.query('SELECT COUNT(*)::int AS count FROM job_events')).rows).toEqual(before.rows);
    }, 30_000,
  );
});
