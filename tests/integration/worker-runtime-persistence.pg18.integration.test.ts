import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Client, Pool } from 'pg';
import {
  assertDisposablePostgresTestDatabaseUrl,
  resolvePostgresTestDatabaseUrl
} from './postgresTestDatabase.js';

const DATABASE_ENV = 'WORKER_RUNTIME_TEST_DATABASE_URL';
const connectionString = resolvePostgresTestDatabaseUrl(DATABASE_ENV);
if (connectionString) assertDisposablePostgresTestDatabaseUrl(connectionString, DATABASE_ENV);
const withDatabase = connectionString ? describe : describe.skip;
const schemaName = `worker_runtime_${randomUUID().replaceAll('-', '')}`;
const quotedSchema = `"${schemaName}"`;
const historyLock = String(BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 15)}`));
let databasePool: Pool;
let administrator: Client;
let schemaCreated = false;
let serverTimingAvailable = false;
const pipelines: Array<{ shutdown: (reason: string) => Promise<void> }> = [];
const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
const log = (event: string, context: Record<string, unknown> = {}) => logs.push({ event, context });
const fetchTrap = jest.fn<typeof fetch>(async () => { throw new Error('Network is forbidden in worker persistence acceptance'); });
const originalFetch = globalThis.fetch;
const loggingMethods = { debug: log, info: log, warn: log, error: log };
const fixtureLogger = { ...loggingMethods, child: () => loggingMethods };

// Only connection ownership and schema readiness are substituted. The production
// pipeline, repository, query helper, autonomy service and job repository execute.
jest.unstable_mockModule('@core/db/client.js', () => ({
  getPool: () => databasePool,
  isDatabaseConnected: () => Boolean(databasePool),
  initializeDatabase: async () => { throw new Error('Full database bootstrap is outside this fixture'); },
  getStatus: () => ({ connected: Boolean(databasePool), hasPool: Boolean(databasePool), error: null })
}));
jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
  LogLevel: { DEBUG: 'debug' }, getConfiguredLogLevel: () => 'debug',
  logger: fixtureLogger, default: fixtureLogger,
  dbLogger: fixtureLogger, aiLogger: fixtureLogger
}));
const actualSchema = await import('../../src/core/db/schema.js');
jest.unstable_mockModule('@core/db/schema.js', () => ({
  ...actualSchema, isDatabaseSchemaReady: () => true,
  initializeTables: async () => { throw new Error('Unrelated schema initialization is forbidden'); }
}));
const { WorkerRuntimeSnapshotPipeline } = await import('../../src/services/workerRuntimeSnapshotPipeline.js');
const repository = await import('../../src/core/db/repositories/workerRuntimeRepository.js');
const { query } = await import('../../src/core/db/query.js');
const { WorkerAutonomyService, getWorkerAutonomySettings, getWorkerAutonomyHealthReport } =
  await import('../../src/services/workerAutonomyService.js');
const jobs = await import('../../src/core/db/repositories/jobRepository.js');

function pipeline() {
  const instance = new WorkerRuntimeSnapshotPipeline({ coalesceMs: 60_000, preserveLegacySnapshot: true });
  pipelines.push(instance);
  return instance;
}

function service(workerId = 'acceptance-slot-1') {
  const snapshots = pipeline();
  const settings = getWorkerAutonomySettings({
    workerId, statsWorkerId: 'acceptance-group', heartbeatIntervalMs: 5_000,
    staleAfterMs: 5_000, watchdogIdleMs: 120_000, failureWebhookUrl: null,
    maxJobsPerHour: 100, maxAiCallsPerHour: 100, stalledJobAction: 'requeue'
  });
  return { autonomy: new WorkerAutonomyService(settings, snapshots), snapshots, settings };
}

function snapshot(overrides: Partial<import('../../src/core/db/repositories/workerRuntimeRepository.js').WorkerRuntimeSnapshotRecord> = {}) {
  const observedAt = new Date().toISOString();
  return {
    workerId: 'acceptance-slot-1', workerType: 'async_queue', healthStatus: 'healthy',
    currentJobId: null, lastError: null, startedAt: '2026-10-31T00:00:00.000Z',
    lastHeartbeatAt: observedAt, lastInspectorRunAt: null, updatedAt: observedAt,
    snapshot: { dispatcherStarted: true, activeListeners: 1, activeJobs: [], processedJobs: 0,
      lastClaimResult: 'no_job_available', lastPollAt: observedAt, lastClaimAttemptAt: observedAt },
    ...overrides
  };
}

async function persist(instance: ReturnType<typeof pipeline>, record: ReturnType<typeof snapshot>, source: string) {
  instance.recordSnapshotIntent(record.workerId, source, record);
  await instance.flushAll(source);
}

async function counts() {
  const result = await administrator.query<{ table_name: string; count: number }>(
    'SELECT table_name, count(*)::int AS count FROM write_audit GROUP BY table_name'
  );
  return { liveness: 0, state: 0, history: 0, legacy: 0,
    ...Object.fromEntries(result.rows.map(row => [row.table_name, row.count])) };
}

async function waitForHeldHistory() {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const result = await administrator.query<{ held: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
       WHERE application_name = $1 AND wait_event = 'advisory') AS held`, [schemaName]
    );
    if (result.rows[0]?.held) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('History insert did not reach the owned PostgreSQL lock');
}

async function drainDatabasePool() {
  const deadline = Date.now() + 3_000;
  do {
    await new Promise<void>(resolve => setImmediate(resolve));
    if (databasePool.waitingCount === 0 && databasePool.idleCount === databasePool.totalCount) return;
  } while (Date.now() < deadline);
  throw new Error('Owned worker database operations did not drain');
}

async function serverTimings() {
  if (!serverTimingAvailable) return [];
  const result = await administrator.query<{ queryid: string; query: string; calls: string; total_exec_time: number }>(
    `SELECT queryid::text, query, calls::text, total_exec_time FROM public.pg_stat_statements
     WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND query ~ '(INSERT INTO worker_liveness|INSERT INTO worker_runtime_state|INSERT INTO worker_runtime_history)'`
  );
  return result.rows;
}

test('worker persistence fixture refuses non-disposable targets', () => {
  expect(() => assertDisposablePostgresTestDatabaseUrl('postgres://test:test@remote.invalid:5432/postgres', DATABASE_ENV)).toThrow();
});

withDatabase('worker runtime pipeline and autonomy on disposable PostgreSQL 18', () => {
  beforeAll(async () => {
    globalThis.fetch = fetchTrap;
    administrator = new Client({ connectionString, connectionTimeoutMillis: 3_000 });
    await administrator.connect();
    const version = await administrator.query<{ version: number }>(
      "SELECT current_setting('server_version_num')::int AS version"
    );
    expect(version.rows[0]?.version).toBeGreaterThanOrEqual(180_000);
    expect(version.rows[0]?.version).toBeLessThan(190_000);
    const preload = await administrator.query<{ libraries: string }>(
      "SELECT current_setting('shared_preload_libraries') AS libraries"
    );
    serverTimingAvailable = preload.rows[0]?.libraries.split(',').map(value => value.trim()).includes('pg_stat_statements') ?? false;
    if (serverTimingAvailable) await administrator.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
    await administrator.query(`CREATE SCHEMA ${quotedSchema}`);
    schemaCreated = true;
    await administrator.query(`SET search_path TO ${quotedSchema}`);
    databasePool = new Pool({
      connectionString, max: 6, connectionTimeoutMillis: 3_000,
      options: `-c search_path=${schemaName} -c statement_timeout=5000 -c lock_timeout=4000`,
      application_name: schemaName
    });
    const tables = ['job_data', 'job_events', 'worker_runtime_snapshots', 'worker_liveness', 'worker_runtime_state', 'worker_runtime_history'];
    for (const table of tables) {
      const definition = actualSchema.TABLE_DEFINITIONS.find(sql => sql.startsWith(`CREATE TABLE IF NOT EXISTS ${table} (`));
      expect(definition).toBeDefined();
      await administrator.query(definition!);
    }
    for (const sql of actualSchema.TABLE_DEFINITIONS.filter(sql =>
      sql.startsWith('ALTER TABLE job_events') && /ADD COLUMN IF NOT EXISTS (stats_worker_id|claim_generation|operation)/u.test(sql))) {
      await administrator.query(sql);
    }
    await administrator.query('CREATE UNIQUE INDEX fixture_claim_event ON job_events(job_id, claim_generation) WHERE event_type = \'worker.budget.job_claim\'');
    await administrator.query('CREATE TABLE write_audit (table_name text NOT NULL, operation text NOT NULL)');
    await administrator.query('CREATE TABLE fixture_control (fail_history boolean NOT NULL)');
    await administrator.query('INSERT INTO fixture_control VALUES (false)');
    await administrator.query(`CREATE FUNCTION audit_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO write_audit VALUES (TG_ARGV[0], TG_OP); RETURN NEW; END $$`);
    for (const [table, label] of [
      ['worker_liveness', 'liveness'], ['worker_runtime_state', 'state'],
      ['worker_runtime_history', 'history'], ['worker_runtime_snapshots', 'legacy']
    ]) {
      await administrator.query(`CREATE TRIGGER fixture_write AFTER INSERT OR UPDATE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION audit_write('${label}')`);
    }
    await administrator.query(`CREATE FUNCTION fail_history() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.source = 'held-history' THEN
          PERFORM pg_advisory_xact_lock(${historyLock}::bigint);
          RAISE EXCEPTION 'owned delayed history failure';
        END IF;
        IF (SELECT fail_history FROM fixture_control) THEN RAISE EXCEPTION 'owned history failure'; END IF;
        RETURN NEW;
      END $$`);
    await administrator.query('CREATE TRIGGER fixture_history BEFORE INSERT ON worker_runtime_history FOR EACH ROW EXECUTE FUNCTION fail_history()');
  }, 20_000);

  beforeEach(async () => {
    logs.length = 0;
    fetchTrap.mockClear();
    await administrator.query('TRUNCATE worker_runtime_snapshots, worker_runtime_state, worker_runtime_history, worker_liveness, job_data, job_events, write_audit RESTART IDENTITY');
    await administrator.query('UPDATE fixture_control SET fail_history = false');
  });

  afterEach(async () => {
    await administrator.query('SELECT pg_advisory_unlock_all()');
    await Promise.all(pipelines.splice(0).map(instance => instance.shutdown('fixture-cleanup')));
    await drainDatabasePool();
    expect(fetchTrap).not.toHaveBeenCalled();
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    await databasePool?.end();
    if (administrator) {
      if (schemaCreated) {
        await administrator.query('RESET search_path');
        await administrator.query(`DROP SCHEMA ${quotedSchema} CASCADE`);
        const remaining = await administrator.query('SELECT count(*)::int AS count FROM pg_namespace WHERE nspname = $1', [schemaName]);
        expect(remaining.rows[0]?.count).toBe(0);
      }
      await administrator.end();
    }
  });

  test('01 bootstrap and 12 legacy compatibility persist real worker state', async () => {
    const { autonomy, snapshots } = service();
    const result = await autonomy.bootstrap();
    await snapshots.flushAll('bootstrap');
    expect(result.healthStatus).toBe('healthy');
    const [state] = await repository.listWorkerRuntimeStateSnapshots();
    const [legacy] = await repository.listWorkerRuntimeSnapshots();
    expect(state).toBeDefined();
    expect(legacy).toEqual(state);
    expect(await counts()).toMatchObject({ state: 1, history: 1, legacy: 1 });
  });

  test('02 sustained idle and 03 advancing heartbeats retain one state/history write', async () => {
    const instance = pipeline();
    const serverBefore = await serverTimings();
    const origin = Date.parse('2026-10-31T00:00:00.000Z');
    for (let tick = 0; tick <= 2_160; tick += 1) {
      const observedAt = new Date(origin + tick * 5_000).toISOString();
      const record = snapshot({ updatedAt: observedAt, lastHeartbeatAt: observedAt,
        snapshot: { ...snapshot().snapshot, lastPollAt: observedAt, lastClaimAttemptAt: observedAt } });
      await instance.recordLiveness(record.workerId, 'healthy', observedAt);
      await persist(instance, record, 'worker-idle');
    }
    expect(await counts()).toEqual({ liveness: 2_161, state: 1, history: 1, legacy: 1 });
    expect(await repository.listWorkerLiveness()).toEqual([{
      workerId: 'acceptance-slot-1', healthStatus: 'healthy', lastSeenAt: '2026-10-31T03:00:00.000Z'
    }]);
    const writeNames = new Set(['worker_liveness_upsert', 'worker_runtime_state_with_legacy_upsert', 'worker_runtime_history_insert']);
    const timing = logs.filter(entry => writeNames.has(String(entry.context.queryName)));
    expect(timing).toHaveLength(2_163);
    expect(timing.every(entry => entry.context.postgresExecutionKnown === false && entry.context.postgresExecutionMs === null)).toBe(true);
    const serverAfter = await serverTimings();
    const serverDelta = { calls: 0, totalExecutionMs: 0 };
    for (const statement of serverAfter) {
      const before = serverBefore.find(entry => entry.queryid === statement.queryid);
      serverDelta.calls += Number(statement.calls) - Number(before?.calls ?? 0);
      serverDelta.totalExecutionMs += statement.total_exec_time - (before?.total_exec_time ?? 0);
    }
    if (serverTimingAvailable) expect(serverDelta.calls).toBe(2_163);
    console.log('WORKER_RUNTIME_PG_IDLE', JSON.stringify({ writes: await counts(),
      querySamples: timing.length, maximumClientRoundTripMs: Math.max(...timing.map(entry => Number(entry.context.clientQueryRoundTripMs))),
      maximumConnectionAcquireMs: Math.max(...timing.map(entry => Number(entry.context.connectionAcquireMs))),
      postgresExecution: serverTimingAvailable ? { ...serverDelta, source: 'pg_stat_statements delta' } : null }));
  }, 30_000);

  test('04 meaningful changes and 06 degradation/recovery persist through actual autonomy', async () => {
    const { autonomy, snapshots } = service();
    await autonomy.markDispatcherStarted(1);
    await autonomy.setClaimAcceptanceState('dependency_failure', { reason: 'owned dependency fixture' });
    await autonomy.setClaimAcceptanceState('accepting');
    await snapshots.flushAll('recovered');
    expect(await counts()).toMatchObject({ state: 3, history: 3, legacy: 3 });
    const result = await administrator.query('SELECT health_status FROM worker_runtime_history ORDER BY id');
    expect(result.rows.map(row => row.health_status)).toEqual(['healthy', 'unhealthy', 'healthy']);
  });

  test('02 actual empty-queue claims and autonomy idle/heartbeat calls preserve the rich capture time', async () => {
    const { autonomy, snapshots, settings } = service();
    await autonomy.markDispatcherStarted(1);
    let capturedAt: string | undefined;
    let capturedPoll: unknown;
    for (let observation = 0; observation < 20; observation += 1) {
      autonomy.recordClaimAttempt();
      const claimed = await jobs.claimNextPendingJobWithAdmission(autonomy.getClaimOptions());
      expect(claimed.job).toBeNull();
      autonomy.recordClaimResult('no_job_available');
      await autonomy.recordWorkerHeartbeat();
      await autonomy.markIdle();
      await snapshots.flushAll('empty-queue');
      if (observation === 0) {
        const record = (await repository.listWorkerRuntimeStateSnapshots())[0]!;
        capturedAt = record.updatedAt;
        capturedPoll = record.snapshot.lastPollAt;
      }
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    expect(await counts()).toEqual({ liveness: 20, state: 2, history: 2, legacy: 2 });
    const report = await getWorkerAutonomyHealthReport(settings);
    expect(report.overallStatus).toBe('healthy');
    expect(report.workers[0]).toMatchObject({
      updatedAt: capturedAt, snapshot: { lastPollAt: capturedPoll, lastClaimAttemptAt: capturedPoll }
    });
    expect(Date.parse(report.workers[0]!.lastHeartbeatAt!)).toBeGreaterThan(Date.parse(capturedAt!));
    const ledger = await administrator.query("SELECT count(*)::int AS count FROM job_events WHERE event_type = 'worker.budget.job_claim'");
    expect(ledger.rows[0]?.count).toBe(0);
  });

  test('05 job admission, fenced heartbeat and completion use actual queue and snapshot repositories', async () => {
    const { autonomy, snapshots } = service();
    await autonomy.markDispatcherStarted(1);
    const job = await jobs.createJob('acceptance-producer', 'ask', { prompt: 'synthetic no-provider job' });
    autonomy.recordClaimAttempt();
    const admission = await jobs.claimNextPendingJobWithAdmission(autonomy.getClaimOptions());
    expect(admission.job?.id).toBe(job.id);
    const claimed = admission.job!;
    await autonomy.markJobStarted(claimed);
    await drainDatabasePool();
    await snapshots.flushAll('job-start');
    expect((await repository.listWorkerRuntimeStateSnapshots())[0]?.currentJobId).toBe(job.id);
    await expect(autonomy.recordHeartbeat(claimed)).resolves.toMatchObject({ id: job.id, status: 'running' });
    await drainDatabasePool();
    await expect(jobs.updateClaimedJobTerminal(job.id, 'completed', {
      fence: jobs.createClaimedJobFence(autonomy.getWorkerId(), String(BigInt(claimed.claim_generation) + 1n)), output: { fixture: 'stale-fence' }
    })).resolves.toBeNull();
    expect((await jobs.getJobById(job.id))?.status).toBe('running');
    const completed = await jobs.updateClaimedJobTerminal(job.id, 'completed', {
      fence: jobs.createClaimedJobFence(autonomy.getWorkerId(), claimed.claim_generation), output: { fixture: true }
    });
    expect(completed?.status).toBe('completed');
    await autonomy.markJobCompleted(job.id);
    await snapshots.flushAll('job-completed');
    expect((await repository.listWorkerRuntimeStateSnapshots())[0]).toMatchObject({
      currentJobId: null, snapshot: { processedJobs: 1 }
    });
    const ledger = await administrator.query("SELECT count(*)::int AS count FROM job_events WHERE event_type = 'worker.budget.job_claim'");
    expect(ledger.rows[0]?.count).toBe(1);
  });

  test('07 a new autonomy instance and pipeline persist restart under the same worker identity', async () => {
    const first = service();
    await first.autonomy.bootstrap();
    await first.snapshots.shutdown('restart');
    const before = (await repository.listWorkerRuntimeStateSnapshots())[0]!;
    await new Promise(resolve => setTimeout(resolve, 2));
    const restarted = service();
    await restarted.autonomy.bootstrap();
    await restarted.snapshots.flushAll('restarted');
    expect(await counts()).toMatchObject({ state: 2, history: 2, legacy: 2 });
    const after = (await repository.listWorkerRuntimeStateSnapshots())[0]!;
    expect(after.workerId).toBe(before.workerId);
    expect(Date.parse(after.startedAt!)).toBeGreaterThan(Date.parse(before.startedAt!));
  });

  test('08 a real PostgreSQL history error retries on the next unchanged observation', async () => {
    const instance = pipeline();
    const record = snapshot();
    await administrator.query('UPDATE fixture_control SET fail_history = true');
    await persist(instance, record, 'history-failure');
    expect(await counts()).toMatchObject({ state: 1, history: 0, legacy: 1 });
    expect(logs.some(entry => entry.event === 'worker.snapshot_pipeline.history.failed')).toBe(true);
    await administrator.query('UPDATE fixture_control SET fail_history = false');
    await persist(instance, record, 'history-recovery');
    await persist(instance, record, 'unchanged');
    expect(await counts()).toMatchObject({ state: 2, history: 1, legacy: 2 });
  });

  test.each([false, true])('09 obsolete history failure / 10 A-B-A fence (same hash returns: %s)', async aba => {
    const instance = pipeline();
    const first = snapshot();
    const newer = snapshot({ currentJobId: randomUUID() });
    await administrator.query('SELECT pg_advisory_lock($1::bigint)', [historyLock]);
    try {
      instance.recordSnapshotIntent(first.workerId, 'held-history', first);
      await instance.flushWorker(first.workerId, 'held-history');
      await waitForHeldHistory();
      instance.recordSnapshotIntent(newer.workerId, 'newer', newer);
      await instance.flushWorker(newer.workerId, 'newer');
      if (aba) {
        instance.recordSnapshotIntent(first.workerId, 'newer-A', first);
        await instance.flushWorker(first.workerId, 'newer-A');
      }
    } finally {
      await administrator.query('SELECT pg_advisory_unlock($1::bigint)', [historyLock]);
      await instance.flushAll('released');
    }
    await persist(instance, aba ? first : newer, 'unchanged');
    expect(await counts()).toMatchObject({ state: aba ? 3 : 2, history: aba ? 2 : 1, legacy: aba ? 3 : 2 });
    expect(logs.some(entry => entry.event === 'worker.snapshot_pipeline.history.failed')).toBe(true);
  });

  test('11 real watchdog uses heartbeat freshness and recovers a stale fenced job', async () => {
    const owner = service('acceptance-slot-owner');
    const observer = service('acceptance-slot-observer');
    await owner.autonomy.markDispatcherStarted(1);
    const job = await jobs.createJob('acceptance-producer', 'ask', { prompt: 'watchdog fixture' });
    const claimed = (await jobs.claimNextPendingJobWithAdmission(owner.autonomy.getClaimOptions())).job!;
    await owner.autonomy.markJobStarted(claimed);
    await drainDatabasePool();
    await owner.snapshots.flushAll('running');
    await owner.autonomy.recordWorkerHeartbeat();
    await administrator.query("UPDATE job_data SET lease_expires_at = NOW() - INTERVAL '1 minute', last_heartbeat_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [job.id]);
    await expect(observer.autonomy.runWatchdogCycle('fresh-control', { persistSnapshot: false })).resolves.toMatchObject({ staleWorkers: 0, requeuedJobs: 0 });
    await administrator.query("UPDATE worker_liveness SET last_seen_at = NOW() - INTERVAL '1 minute' WHERE worker_id = $1", [owner.autonomy.getWorkerId()]);
    await expect(observer.autonomy.runWatchdogCycle('stale-control', { persistSnapshot: false })).resolves.toMatchObject({ staleWorkers: 1, requeuedJobs: 1 });
    expect((await jobs.getJobById(job.id))?.status).toBe('pending');
    const report = await getWorkerAutonomyHealthReport(owner.settings);
    expect(report.workers.find(worker => worker.workerId === owner.autonomy.getWorkerId())?.lastHeartbeatAt).toBeDefined();
  });

  test('12 legacy failure rolls back the combined state/legacy statement', async () => {
    const instance = pipeline();
    await administrator.query("ALTER TABLE worker_runtime_snapshots ADD CONSTRAINT fixture_legacy_reject CHECK (health_status <> 'degraded')");
    try {
      await persist(instance, snapshot({ healthStatus: 'degraded' }), 'legacy-rejection');
      expect(await counts()).toEqual({ liveness: 0, state: 0, history: 0, legacy: 0 });
      expect(logs.some(entry => entry.event === 'worker.snapshot_pipeline.state.failed')).toBe(true);
    } finally {
      await administrator.query('ALTER TABLE worker_runtime_snapshots DROP CONSTRAINT fixture_legacy_reject');
    }
  });

  test('query timing keeps client round trip separate from PostgreSQL execution', async () => {
    await query('SELECT pg_sleep(0.06)', [], { traceContext: { queryName: 'worker_acceptance_timing' } });
    const timing = logs.find(entry => entry.context.queryName === 'worker_acceptance_timing');
    expect(timing?.context).toMatchObject({ durationKind: 'client_query_round_trip', postgresExecutionKnown: false, postgresExecutionMs: null });
    expect(Number(timing?.context.clientQueryRoundTripMs)).toBeGreaterThanOrEqual(50);
    expect(Number(timing?.context.connectionAcquireMs)).toBeGreaterThanOrEqual(0);
  });
});
