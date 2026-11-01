import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, test } from '@jest/globals';
import { Client } from 'pg';
import { assertDisposablePostgresTestDatabaseUrl, resolvePostgresTestDatabaseUrl } from './postgresTestDatabase.js';

const DATABASE_ENV = 'WORKER_RUNTIME_STARTUP_TEST_DATABASE_URL';
const connectionString = resolvePostgresTestDatabaseUrl(DATABASE_ENV);
if (connectionString) assertDisposablePostgresTestDatabaseUrl(connectionString, DATABASE_ENV);
const withDatabase = connectionString ? describe : describe.skip;
const root = process.cwd();
const owner = `worker_process_${randomUUID().replaceAll('-', '')}`;
const children: Array<{ child: ChildProcess; output: () => string; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> }> = [];
const directories: string[] = [];
let administrator: Client;
const baselineTables = new Map<string, { count: string; digest: string }>();
const baselineFunctions = new Set<string>();
let baselineLogIds: string[] = [];
let capturedBaseline = false;

function quotedIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

async function tableFingerprint(table: string) {
  const result = await administrator.query<{ count: string; digest: string }>(
    `SELECT count(*)::text AS count,
       md5(COALESCE(string_agg(md5(to_jsonb(row_value)::text), '' ORDER BY md5(to_jsonb(row_value)::text)), '')) AS digest
     FROM public.${quotedIdentifier(table)} AS row_value`
  );
  return result.rows[0]!;
}

async function until<T>(operation: () => Promise<T>, accepted: (value: T) => boolean, label: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await operation();
    if (accepted(value)) return value;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 25));
  }
  throw new Error(`Worker process fixture timed out: ${label}`);
}

function startWorker() {
  const directory = mkdtempSync(join(tmpdir(), 'arcanos-worker-process-'));
  directories.push(directory);
  const port = new URL(connectionString).port;
  const env: NodeJS.ProcessEnv = {
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
    TEMP: directory, TMP: directory, TMPDIR: directory,
    NODE_ENV: 'test', ARCANOS_PROCESS_KIND: 'worker', RUN_WORKERS: 'true',
    DATABASE_URL: connectionString, PGAPPNAME: owner, WORKER_FIXTURE_PG_PORT: port,
    AI_MODEL: 'ft:gpt-4.1-2025-04-14:arcanos-test:authority:offline',
    FORCE_MOCK: 'false', ALLOW_MOCK_OPENAI: 'false', DISABLE_EXTERNAL_CALLS: 'true',
    LOG_LEVEL: 'info', REDIS_SHARED_METRICS_ENABLED: 'false', DIAGNOSTICS_SHARED_METRICS: 'false',
    JOB_WORKER_ID: owner, JOB_WORKER_CONCURRENCY: '1', JOB_WORKER_POLL_MS: '10', JOB_WORKER_IDLE_BACKOFF_MS: '10',
    JOB_WORKER_HEARTBEAT_MS: '1000', JOB_WORKER_STALE_AFTER_MS: '5000',
    JOB_WORKER_INSPECTOR_MS: '60000', JOB_WORKER_WATCHDOG_MS: '60000',
    JOB_WORKER_DB_BOOTSTRAP_MAX_ATTEMPTS: '1', WORKER_SNAPSHOT_PIPELINE_COALESCE_MS: '50',
    PREDICTIVE_HEALING_ENABLED: 'false', PREDICTIVE_AUTO_EXECUTE: 'false', SELF_IMPROVE_ENABLED: 'false'
  };
  const child = spawn(process.execPath, [
    '--import', pathToFileURL(resolve(root, 'tests/fixtures/worker-runtime-process-egress.mjs')).href,
    '--import', pathToFileURL(resolve(root, 'scripts/register-esm-loader.mjs')).href,
    resolve(root, 'dist/workers/jobRunner.js')
  ], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const append = (chunk: Buffer) => {
    output += chunk.toString('utf8');
    if (output.length > 512 * 1024) child.kill('SIGKILL');
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  const running = { child, output: () => output, exited };
  children.push(running);
  return running;
}

async function stopWorker(running: ReturnType<typeof startWorker>) {
  if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill('SIGTERM');
  const result = await Promise.race([
    running.exited,
    new Promise<never>((_resolve, reject) => {
      const timeout = setTimeout(() => { running.child.kill('SIGKILL'); reject(new Error('Worker process did not stop')); }, 10_000);
      timeout.unref();
      void running.exited.finally(() => clearTimeout(timeout));
    })
  ]);
  expect(running.output()).not.toContain('WORKER_PROCESS_EGRESS_DENIED');
  return result;
}

async function observation() {
  const result = await administrator.query<{
    worker_id: string; started_at: Date; last_seen_at: Date; snapshot: Record<string, unknown>; updated_at: Date; history_count: number;
  }>(`SELECT snapshot.worker_id, snapshot.started_at, liveness.last_seen_at,
       snapshot.snapshot, snapshot.updated_at,
       (SELECT count(*)::int FROM worker_runtime_history WHERE worker_id = $1) AS history_count
     FROM worker_runtime_snapshots AS snapshot
     INNER JOIN worker_liveness AS liveness USING (worker_id)
     WHERE snapshot.worker_id = $1`, [owner]);
  return result.rows[0] ?? null;
}

test.each([
  "(await import('node:net')).connect(443, '203.0.113.1')",
  "(await import('node:net')).connect(55478, '127.0.0.1')",
  "(await import('node:tls')).connect(443, '127.0.0.1')",
  "(await import('node:dgram')).createSocket('udp4')",
  "(await import('node:dns/promises')).resolve('example.invalid')",
  "await fetch('https://example.invalid')"
])('native worker egress guard rejects transport before connection: %s', expression => {
  const denied = spawnSync(process.execPath, [
    '--import', pathToFileURL(resolve(root, 'tests/fixtures/worker-runtime-process-egress.mjs')).href,
    '--input-type=module', '--eval', expression
  ], { env: { WORKER_FIXTURE_PG_PORT: '55477' }, timeout: 3_000, encoding: 'utf8', windowsHide: true });
  expect(denied.status).not.toBe(0);
  expect(denied.stderr).toContain('WORKER_PROCESS_EGRESS_DENIED');
});

withDatabase('actual compiled worker process on dedicated disposable PostgreSQL 18', () => {
  beforeAll(async () => {
    administrator = new Client({ connectionString, connectionTimeoutMillis: 3_000, query_timeout: 5_000 });
    await administrator.connect();
    const version = await administrator.query("SELECT current_setting('server_version_num')::int AS version");
    expect(version.rows[0]?.version).toBeGreaterThanOrEqual(180_000);
    expect(version.rows[0]?.version).toBeLessThan(190_000);
    // Full canonical startup contains public-qualified contracts. CI may already
    // have canonical session tables: retain their objects and every existing row.
    const existing = await administrator.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
    for (const { tablename } of existing.rows) baselineTables.set(tablename, await tableFingerprint(tablename));
    const functions = await administrator.query<{ oid: string }>(
      "SELECT p.oid::text AS oid FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace WHERE n.nspname = 'public'"
    );
    for (const { oid } of functions.rows) baselineFunctions.add(oid);
    if (baselineTables.has('execution_logs')) {
      baselineLogIds = (await administrator.query<{ id: string }>('SELECT id::text FROM execution_logs')).rows.map(row => row.id);
    }
    // An active job must never be handed to this real queue consumer as setup.
    if (baselineTables.has('job_data')) {
      expect((await administrator.query('SELECT count(*)::int AS count FROM job_data')).rows[0]?.count).toBe(0);
    }
    capturedBaseline = true;
  });

  afterEach(async () => {
    await Promise.all(children.splice(0).map(stopWorker));
  });

  afterAll(async () => {
    try {
      await Promise.all(children.splice(0).map(stopWorker));
      if (capturedBaseline) {
        const tables = await administrator.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
        for (const table of ['worker_runtime_history', 'worker_runtime_state', 'worker_runtime_snapshots', 'worker_liveness', 'job_events']) {
          if (baselineTables.has(table)) await administrator.query(`DELETE FROM public.${quotedIdentifier(table)} WHERE worker_id = $1`, [owner]);
        }
        if (baselineTables.has('execution_logs')) {
          // Canonical bootstrap labels its online row 'job-runner', independently
          // of JOB_WORKER_ID; remove only new rows from these exclusive processes.
          await administrator.query("DELETE FROM execution_logs WHERE worker_id = 'job-runner' AND id <> ALL($1::uuid[])", [baselineLogIds]);
        }
        for (const { tablename } of tables.rows) {
          if (!baselineTables.has(tablename)) await administrator.query(`DROP TABLE IF EXISTS public.${quotedIdentifier(tablename)} CASCADE`);
        }
        const functions = await administrator.query<{ oid: string; signature: string }>(
          `SELECT p.oid::text AS oid, p.oid::regprocedure::text AS signature FROM pg_proc AS p
           JOIN pg_namespace AS n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname LIKE 'backstage_notion_%'`
        );
        for (const { oid, signature } of functions.rows) {
          if (!baselineFunctions.has(oid)) await administrator.query(`DROP FUNCTION IF EXISTS ${signature} CASCADE`);
        }
        const remaining = await administrator.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
        expect(remaining.rows.map(row => row.tablename).sort()).toEqual([...baselineTables.keys()].sort());
        for (const [table, fingerprint] of baselineTables) expect(await tableFingerprint(table)).toEqual(fingerprint);
      }
    } finally {
      await administrator?.end();
      for (const directory of directories.splice(0)) {
        const target = resolve(directory);
        if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('arcanos-worker-process-')) {
          throw new Error('Refusing cleanup outside the owned temporary worker directory');
        }
        rmSync(target, { recursive: true, force: true });
      }
    }
  });

  test('real bootstrap, continuous idle heartbeat and OS process restart retain worker identity without provider traffic', async () => {
    const first = startWorker();
    await until(async () => {
      if (first.child.exitCode !== null || first.child.signalCode !== null) throw new Error(`Worker exited before readiness: ${first.output().slice(-6000)}`);
      return first.output();
    }, value => value.includes('ARCANOS_WORKER_BOOTSTRAP_READY_V1'), 'real worker bootstrap');
    const before = await until(observation, value => Boolean(value?.snapshot.dispatcherStarted && value.snapshot.lastClaimResult === 'no_job_available' && value.history_count > 0), 'first durable idle state');
    const advanced = await until(observation, value => Boolean(value && value.last_seen_at > before!.last_seen_at), 'continuous heartbeat');
    expect(advanced?.worker_id).toBe(before?.worker_id);
    expect(advanced?.snapshot.lastClaimResult).toBe('no_job_available');
    expect(advanced?.updated_at).toEqual(before?.updated_at);
    expect(advanced?.history_count).toBe(before?.history_count);
    await stopWorker(first);
    const second = startWorker();
    await until(async () => {
      if (second.child.exitCode !== null || second.child.signalCode !== null) throw new Error(`Restart exited before readiness: ${second.output().slice(-6000)}`);
      return second.output();
    }, value => value.includes('ARCANOS_WORKER_BOOTSTRAP_READY_V1'), 'restarted worker bootstrap');
    const after = await until(observation, value => Boolean(value && value.started_at > before!.started_at && value.last_seen_at > advanced!.last_seen_at), 'restarted identity and heartbeat');
    expect(after?.worker_id).toBe(before?.worker_id);
    expect(second.child.pid).not.toBe(first.child.pid);
    const effects = await administrator.query(`SELECT
      (SELECT count(*)::int FROM job_data) AS jobs,
      (SELECT count(*)::int FROM job_events WHERE event_type = 'worker.budget.ai_provider_attempt') AS provider_attempts`);
    expect(effects.rows).toEqual([{ jobs: 0, provider_attempts: 0 }]);
    const stop = await stopWorker(second);
    console.log('WORKER_PROCESS_ACCEPTANCE', JSON.stringify({
      realCompiledEntrypoint: true, distinctProcesses: true, sameWorkerIdentity: true,
      heartbeatAdvanced: true, idleRichStateAndHistoryUnchanged: true,
      startedAtAdvanced: true, jobs: 0, providerAttempts: 0,
      stopMode: process.platform === 'win32' ? 'Windows OS termination; graceful signal drain not asserted' : 'SIGTERM', stop
    }));
  }, 60_000);
});
