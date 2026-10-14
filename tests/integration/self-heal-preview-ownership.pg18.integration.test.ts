import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import { Client, type ClientConfig } from 'pg';
import ts from 'typescript';
import { runSelfHealPreviewFencedJob } from '../../scripts/self-heal-preview-job.mjs';
import {
  bindSelfHealPreviewArtifact, preflightSelfHealPreviewDatabase,
  resolveSelfHealPreviewProfile, runSelfHealPreviewSupervisor,
} from '../../scripts/railway-self-heal-preview-profile.mjs';
import {
  assertDisposablePostgresTestDatabaseUrl, POSTGRES_TEST_DATABASE_NAME,
  resolvePostgresTestDatabaseUrl,
} from './postgresTestDatabase.js';

const URL_ENV = 'SELF_HEAL_PREVIEW_OWNERSHIP_TEST_DATABASE_URL';
const CONFIRM_ENV = 'SELF_HEAL_PREVIEW_OWNERSHIP_CONFIRM_DISPOSABLE';
const configuredUrl = resolvePostgresTestDatabaseUrl(URL_ENV);
const CONFIRM = 'disposable-loopback-only';
const TEMP_DATABASE = /^self_heal_preview_pg18_[0-9a-f]{32}$/u;
const SOURCE = 'a'.repeat(40);
const COMPILED = 'c'.repeat(64);
const NOW = Date.parse('2026-10-14T16:00:00.000Z');
const ID = { project: '11111111-1111-4111-8111-111111111111', environment: '22222222-2222-4222-8222-222222222222',
  web: '33333333-3333-4333-8333-333333333333', worker: '44444444-4444-4444-8444-444444444444',
  deployment: '55555555-5555-4555-8555-555555555555', postgres: '66666666-6666-4666-8666-666666666666', redis: '77777777-7777-4777-8777-777777777777' };

function productionJobTableSql() {
  // Read two closed literal DDL entries without importing the configured DB
  // module, executing startup initialization, or rewriting production SQL.
  const source = ts.createSourceFile('schema.ts', readFileSync(new URL('../../src/core/db/schema.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const statements = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'TABLE_DEFINITIONS'
      && node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
      for (const entry of node.initializer.elements) {
        if (!ts.isNoSubstitutionTemplateLiteral(entry)) continue;
        for (const name of ['job_data', 'job_events']) {
          if (entry.text.startsWith(`CREATE TABLE IF NOT EXISTS ${name} (`)) {
            if (statements.has(name)) throw new Error('SELF_HEAL_PREVIEW_PG18_DUPLICATE_JOB_DDL');
            statements.set(name, entry.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (statements.size !== 2) throw new Error('SELF_HEAL_PREVIEW_PG18_JOB_DDL_MISSING');
  return [...statements.values()];
}
const JOB_TABLE_DDL = productionJobTableSql();

function guardedAdminConfig(url: string, confirmation: string | undefined): ClientConfig {
  assertDisposablePostgresTestDatabaseUrl(url, URL_ENV);
  if (confirmation !== CONFIRM) throw new Error('SELF_HEAL_PREVIEW_PG18_DISPOSABLE_CONFIRMATION_REQUIRED');
  const parsed = new URL(url);
  return { host: parsed.hostname.replace(/^\[|\]$/gu, ''), port: Number(parsed.port),
    user: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password),
    database: POSTGRES_TEST_DATABASE_NAME, ssl: false, connectionTimeoutMillis: 5000,
    query_timeout: 5000, options: '-c statement_timeout=5000 -c lock_timeout=1000' };
}
// URL and explicit mutation opt-in are checked before even constructing a Client.
const adminConfig = configuredUrl ? guardedAdminConfig(configuredUrl, process.env[CONFIRM_ENV]) : null;
const describeDatabase = adminConfig ? describe : describe.skip;

function environment(role = 'worker', patch: Record<string, string> = {}) {
  return {
    ARCANOS_BACKSTAGE_HEAVY_PROOF_TARGET: 'dedicated-backstage-heavy-preview-v1',
    ARCANOS_BACKSTAGE_HEAVY_PROOF_RUN_ID: 'ownership-pg18-1544', ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA: SOURCE,
    ARCANOS_PROCESS_KIND: role, NODE_ENV: 'production', ARCANOS_PREVIEW_ISOLATION: 'true', FORCE_MOCK: 'true',
    ALLOW_MOCK_OPENAI: 'true', OPENAI_API_KEY_REQUIRED: 'false',
    OPENAI_BASE_URL: role === 'worker' ? 'http://127.0.0.1:8766/v1' : 'http://127.0.0.1:9/v1',
    ...(role === 'worker' ? { ARCANOS_PREVIEW_OPENAI_FIXTURE: 'backstage-heavy-compact-retry-v1' } : {
      ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED: 'true',
      ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN: 'fictional-pg18-preview-access-token-0001',
      ARCANOS_JOB_READ_CAPABILITY_SECRET: 'fictional-pg18-preview-job-read-secret-0001',
    }),
    ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY: `${'A'.repeat(43)}=`,
    DATABASE_URL: 'postgresql://synthetic:synthetic@postgres.railway.internal:5432/railway',
    REDIS_URL: 'redis://default:synthetic@redis.railway.internal:6379',
    RAILWAY_PROJECT_ID: ID.project, RAILWAY_PROJECT_NAME: 'arc-pr1544-heavy-pg18',
    RAILWAY_ENVIRONMENT_ID: ID.environment, RAILWAY_ENVIRONMENT_NAME: 'backstage-heavy-pr-1544-e2e',
    RAILWAY_SERVICE_ID: role === 'worker' ? ID.worker : ID.web, RAILWAY_SERVICE_NAME: `arcanos-${role}-pr1544-heavy`,
    RAILWAY_DEPLOYMENT_ID: ID.deployment, RAILWAY_GIT_COMMIT_SHA: SOURCE,
    ARCANOS_BACKSTAGE_HEAVY_POSTGRES_SERVICE_ID: ID.postgres, ARCANOS_BACKSTAGE_HEAVY_POSTGRES_SERVICE_NAME: 'Postgres',
    ARCANOS_BACKSTAGE_HEAVY_POSTGRES_INTERNAL_HOST: 'postgres.railway.internal',
    ARCANOS_BACKSTAGE_HEAVY_REDIS_SERVICE_ID: ID.redis, ARCANOS_BACKSTAGE_HEAVY_REDIS_SERVICE_NAME: 'Redis',
    ARCANOS_BACKSTAGE_HEAVY_REDIS_INTERNAL_HOST: 'redis.railway.internal',
    ARCANOS_SELF_HEAL_PREVIEW_PROFILE: 'worker-coordinator-v1', ARCANOS_SELF_HEAL_PREVIEW_RUN_ID: 'ownership-pg18-1544',
    ARCANOS_SELF_HEAL_PREVIEW_ISSUED_AT: '2026-10-14T15:59:00.000Z', ARCANOS_SELF_HEAL_PREVIEW_EXPIRES_AT: '2026-10-14T17:00:00.000Z',
    ARCANOS_SELF_HEAL_PREVIEW_CONTROL_TOKEN: 'b'.repeat(64), ARCANOS_SELF_HEAL_PREVIEW_CONTROL_PORT: '8791',
    ARCANOS_SELF_HEAL_PREVIEW_STARTUP_MODE: 'normal', ARCANOS_SELF_HEAL_PREVIEW_WEB_SERVICE_ID: ID.web,
    ARCANOS_SELF_HEAL_PREVIEW_WORKER_SERVICE_ID: ID.worker, ...patch,
  };
}
function profile(role = 'worker', patch: Record<string, string> = {}, digest = COMPILED, now = NOW) {
  const env = environment(role, patch);
  return bindSelfHealPreviewArtifact(resolveSelfHealPreviewProfile(role, env, { now: () => now }), {
    sourceSha: env.ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA, compiledSha256: digest, fileCount: 1,
  });
}

describe('self-heal PostgreSQL disposable target and lease admission guards', () => {
  test('accepts only the explicit loopback disposable base and mutation confirmation', () => {
    expect(guardedAdminConfig(`postgresql://fixture:fixture@127.0.0.1:55432/${POSTGRES_TEST_DATABASE_NAME}`, CONFIRM))
      .toMatchObject({ host: '127.0.0.1', port: 55432, database: POSTGRES_TEST_DATABASE_NAME });
  });
  test.each([
    `postgresql://fixture:fixture@db.invalid:5432/${POSTGRES_TEST_DATABASE_NAME}`,
    'postgresql://fixture:fixture@127.0.0.1:5432/production',
    `postgresql://fixture:fixture@127.0.0.1:5432/${POSTGRES_TEST_DATABASE_NAME}?host=remote.invalid`,
    `postgresql://fixture:fixture@127.0.0.1/${POSTGRES_TEST_DATABASE_NAME}`,
  ])('rejects unsafe URL before construction or connection: %#', value => {
    expect(() => guardedAdminConfig(value, CONFIRM)).toThrow();
  });
  test('rejects missing dedicated mutation confirmation before construction or connection', () => {
    expect(() => guardedAdminConfig(`postgresql://fixture:fixture@127.0.0.1:55432/${POSTGRES_TEST_DATABASE_NAME}`, undefined))
      .toThrow('SELF_HEAL_PREVIEW_PG18_DISPOSABLE_CONFIRMATION_REQUIRED');
  });
  test.each([
    { ARCANOS_SELF_HEAL_PREVIEW_EXPIRES_AT: '2026-10-14T16:00:00.000Z' },
    { ARCANOS_SELF_HEAL_PREVIEW_ISSUED_AT: '2026-10-14T16:01:00.000Z' },
    { ARCANOS_SELF_HEAL_PREVIEW_EXPIRES_AT: '2026-10-14T18:00:00.000Z' },
  ])('rejects expired, future or oversized authority before PostgreSQL: %#', patch => {
    expect(() => profile('worker', patch)).toThrow('SELF_HEAL_PREVIEW_LEASE_INVALID');
  });
});

describeDatabase('literal self-heal ownership SQL and role locks on isolated PostgreSQL 18 databases', () => {
  let admin: Client;
  let observer: Client;
  let databaseName = '';
  const databases = new Map<string, string>();
  const clients = new Set<Client>();
  const guards: Array<{ close(): Promise<void> }> = [];

  function assertOwnedDatabase(name: string) {
    if (!adminConfig || !TEMP_DATABASE.test(name) || !databases.has(name)) throw new Error('SELF_HEAL_PREVIEW_PG18_DATABASE_NOT_OWNED');
    guardedAdminConfig(configuredUrl, process.env[CONFIRM_ENV]);
  }
  function localClient(name: string, options: ClientConfig = {}) {
    assertOwnedDatabase(name);
    const client = new Client({ ...options, ...adminConfig, connectionString: undefined, database: name });
    clients.add(client); return client;
  }
  class GuardedProfileClient {
    constructor(options: ClientConfig) {
      // Only the transport target changes. Every production SQL statement,
      // public table name and session/xact advisory lock runs without rewriting.
      return localClient(databaseName, options);
    }
  }
  async function admit(role = 'worker', patch: Record<string, string> = {}, digest = COMPILED, now = NOW) {
    assertOwnedDatabase(databaseName);
    const guard = await preflightSelfHealPreviewDatabase(profile(role, patch, digest, now), { Client: GuardedProfileClient });
    guards.push(guard); return guard;
  }
  async function installJobSchema() {
    assertOwnedDatabase(databaseName);
    // Exact production table definitions/defaults, without the unrelated startup
    // DDL or normal Worker execution. The helper's SQL is never rewritten.
    for (const statement of JOB_TABLE_DDL) await observer.query(statement);
  }
  async function initialized(patch: Record<string, string> = {}, now = NOW) {
    const guard = await admit('worker', patch, COMPILED, now); await guard.close(); await installJobSchema();
  }
  async function realClockAuthority(expired = false) {
    assertOwnedDatabase(databaseName);
    const current = await observer.query('SELECT clock_timestamp() AS now');
    const databaseNow = current.rows[0].now.getTime();
    const expires = databaseNow + (expired ? -60_000 : 60_000);
    const patch = {
      ARCANOS_SELF_HEAL_PREVIEW_ISSUED_AT: new Date(databaseNow - 120_000).toISOString(),
      ARCANOS_SELF_HEAL_PREVIEW_EXPIRES_AT: new Date(expires).toISOString(),
    };
    // The expired case deliberately holds injected admission time just before
    // expiry; unchanged PostgreSQL clock_timestamp() must still reject INSERT.
    const admissionNow = expired ? expires - 1 : databaseNow;
    await initialized(patch, admissionNow);
    return { env: environment('worker', patch), patch,
      options: { Client: GuardedProfileClient, now: () => admissionNow,
        verifyArtifact: async () => ({ sourceSha: SOURCE, compiledSha256: COMPILED, fileCount: 1 }) } };
  }
  async function insertJob(patch: { correlation?: string | null; worker?: string | null; status?: string; liveLease?: boolean } = {}) {
    assertOwnedDatabase(databaseName); const id = randomUUID();
    await observer.query(`INSERT INTO public.job_data (id, worker_id, job_type, input, correlation_id, status, last_worker_id, lease_expires_at)
      VALUES ($1::uuid, 'self-heal-preview-ownership-pg18-1544', 'ask', '{}'::jsonb, $2, $3, $4, NOW() + $5::interval)`, [id,
      patch.correlation === undefined ? 'self-heal-preview:ownership-pg18-1544:fixture' : patch.correlation,
      patch.status ?? 'completed', patch.worker === undefined ? 'self-heal-preview-ownership-pg18-1544' : patch.worker,
      patch.liveLease ? '1 minute' : '-1 minute']);
    return id;
  }

  beforeAll(async () => {
    if (!adminConfig) throw new Error('SELF_HEAL_PREVIEW_PG18_DATABASE_REQUIRED');
    guardedAdminConfig(configuredUrl, process.env[CONFIRM_ENV]);
    admin = new Client({ ...adminConfig, application_name: 'self_heal_preview_pg18_test_admin' });
    await admin.connect();
    const actual = await admin.query(`SELECT current_database() AS database, current_user AS username,
      current_setting('server_version_num')::integer AS version,
      (SELECT rolcreatedb OR rolsuper FROM pg_roles WHERE rolname = current_user) AS can_create`);
    expect(actual.rows[0]).toMatchObject({ database: POSTGRES_TEST_DATABASE_NAME, username: adminConfig.user, can_create: true });
    expect(actual.rows[0].version).toBeGreaterThanOrEqual(180_000);
    expect(actual.rows[0].version).toBeLessThan(190_000);
  }, 15_000);

  beforeEach(async () => {
    guardedAdminConfig(configuredUrl, process.env[CONFIRM_ENV]);
    databaseName = `self_heal_preview_pg18_${randomUUID().replaceAll('-', '')}`;
    if (!TEMP_DATABASE.test(databaseName)) throw new Error('SELF_HEAL_PREVIEW_PG18_DATABASE_NAME_INVALID');
    const existing = await admin.query('SELECT oid::text FROM pg_database WHERE datname = $1', [databaseName]);
    expect(existing.rows).toHaveLength(0);
    await admin.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
    const created = await admin.query('SELECT oid::text AS oid, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1', [databaseName]);
    expect(created.rows[0]?.owner).toBe(adminConfig?.user);
    databases.set(databaseName, created.rows[0].oid);
    observer = localClient(databaseName, { application_name: 'self_heal_preview_pg18_test_observer' });
    await observer.connect();
    expect((await observer.query('SELECT current_database() AS database')).rows[0].database).toBe(databaseName);
  }, 15_000);

  afterEach(async () => {
    await Promise.allSettled(guards.splice(0).map(guard => guard.close()));
    await Promise.allSettled([...clients].map(client => client.end())); clients.clear();
    if (databaseName && databases.has(databaseName)) {
      assertOwnedDatabase(databaseName);
      const actual = await admin.query('SELECT oid::text AS oid, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1', [databaseName]);
      expect(actual.rows[0]).toEqual({ oid: databases.get(databaseName), owner: adminConfig?.user });
      await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      expect((await admin.query('SELECT oid FROM pg_database WHERE datname = $1', [databaseName])).rows).toHaveLength(0);
      databases.delete(databaseName);
    }
    databaseName = '';
  }, 15_000);

  afterAll(async () => {
    try { expect(databases.size).toBe(0); }
    finally { await admin?.end(); }
  });

  test('requires an empty database and atomically persists the exact compiled ownership receipt', async () => {
    const guard = await admit(); expect(guard.mode).toBe('fresh-owned-receipt');
    const rows = await observer.query('SELECT singleton, identity FROM public.arcanos_self_heal_preview_owner_v1');
    expect(rows.rows).toEqual([{ singleton: true, identity: JSON.stringify(profile().ownership) }]);
    await expect(observer.query("INSERT INTO public.arcanos_self_heal_preview_owner_v1 VALUES (TRUE, '{}')")).rejects.toMatchObject({ code: '23505' });
    await expect(observer.query("INSERT INTO public.arcanos_self_heal_preview_owner_v1 VALUES (FALSE, '{}')")).rejects.toMatchObject({ code: '23514' });
  });
  test('refuses a pre-existing foreign table without creating a receipt', async () => {
    await observer.query('CREATE TABLE public.foreign_data (id integer)');
    await expect(admit()).rejects.toThrow('SELF_HEAL_PREVIEW_DATABASE_NOT_FRESH');
    expect((await observer.query("SELECT to_regclass('public.arcanos_self_heal_preview_owner_v1') AS receipt")).rows[0].receipt).toBeNull();
  });
  test('refuses web initialization before worker ownership exists', async () => {
    await expect(admit('web')).rejects.toThrow('SELF_HEAL_PREVIEW_RECEIPT_MISSING');
  });
  test('denies a simultaneous second worker while keeping exactly one receipt and live owner', async () => {
    const first = await admit();
    await expect(admit()).rejects.toThrow('SELF_HEAL_PREVIEW_OWNER_ALREADY_ACTIVE');
    expect((await observer.query('SELECT COUNT(*)::integer AS count FROM public.arcanos_self_heal_preview_owner_v1')).rows[0].count).toBe(1);
    await installJobSchema(); await first.close(); expect((await admit()).mode).toBe('receipt-bound-resume');
  });
  test('admits independent worker and web role locks on one exact initialized owner receipt', async () => {
    const worker = await admit(); await installJobSchema(); const web = await admit('web');
    expect(web.mode).toBe('receipt-bound-resume');
    await expect(admit('web')).rejects.toThrow('SELF_HEAL_PREVIEW_OWNER_ALREADY_ACTIVE');
    await web.close(); await expect(admit()).rejects.toThrow('SELF_HEAL_PREVIEW_OWNER_ALREADY_ACTIVE'); await worker.close();
  });
  test('resumes completed synthetic jobs while preserving their receipt, rows and events', async () => {
    await initialized(); const jobId = await insertJob(); await observer.query("INSERT INTO public.job_events(job_id, event_type) VALUES ($1::uuid, 'job.completed')", [jobId]);
    const before = (await observer.query('SELECT identity FROM public.arcanos_self_heal_preview_owner_v1')).rows;
    expect((await admit()).mode).toBe('receipt-bound-resume');
    expect((await observer.query('SELECT identity FROM public.arcanos_self_heal_preview_owner_v1')).rows).toEqual(before);
    expect((await observer.query('SELECT status FROM public.job_data WHERE id=$1::uuid', [jobId])).rows[0].status).toBe('completed');
    expect((await observer.query('SELECT COUNT(*)::integer AS count FROM public.job_events')).rows[0].count).toBe(1);
  });
  test.each([
    { ARCANOS_BACKSTAGE_HEAVY_PROOF_RUN_ID: 'other-owned-run-1544', ARCANOS_SELF_HEAL_PREVIEW_RUN_ID: 'other-owned-run-1544' },
    { ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA: 'd'.repeat(40), RAILWAY_GIT_COMMIT_SHA: 'd'.repeat(40) },
    { ARCANOS_SELF_HEAL_PREVIEW_EXPIRES_AT: '2026-10-14T16:59:00.000Z' },
    { ARCANOS_SELF_HEAL_PREVIEW_ISSUED_AT: '2026-10-14T15:58:00.000Z' },
  ])('rejects receipt binding drift without rewriting persisted authority: %#', async patch => {
    await initialized(); const expected = JSON.stringify(profile().ownership);
    await expect(admit('worker', patch)).rejects.toThrow('SELF_HEAL_PREVIEW_RECEIPT_MISMATCH');
    expect((await observer.query('SELECT identity FROM public.arcanos_self_heal_preview_owner_v1')).rows[0].identity).toBe(expected);
  });
  test('rejects compiled artifact drift at the same source SHA', async () => {
    await initialized(); await expect(admit('worker', {}, 'd'.repeat(64))).rejects.toThrow('SELF_HEAL_PREVIEW_RECEIPT_MISMATCH');
  });
  test.each([
    { correlation: null }, { correlation: 'another-run:fixture' }, { worker: 'foreign-worker' },
    { status: 'running', liveLease: true },
  ])('rejects foreign correlation, worker or live lease without changing the job: %#', async patch => {
    await initialized(); const jobId = await insertJob(patch); const before = (await observer.query('SELECT * FROM public.job_data WHERE id=$1::uuid', [jobId])).rows;
    await expect(admit()).rejects.toThrow('SELF_HEAL_PREVIEW_FOREIGN_OR_ACTIVE_JOBS');
    expect((await observer.query('SELECT * FROM public.job_data WHERE id=$1::uuid', [jobId])).rows).toEqual(before);
  });
  test('admits an expired owned lease for normal fenced recovery without completing the job', async () => {
    await initialized(); const jobId = await insertJob({ status: 'running' });
    expect((await admit()).mode).toBe('receipt-bound-resume');
    expect((await observer.query('SELECT status FROM public.job_data WHERE id=$1::uuid', [jobId])).rows[0].status).toBe('running');
  });
  test('rejects orphan events and preserves their evidence', async () => {
    await initialized(); await observer.query("INSERT INTO public.job_events(job_id, event_type) VALUES ($1::uuid, 'job.completed')", [randomUUID()]);
    await expect(admit()).rejects.toThrow('SELF_HEAL_PREVIEW_FOREIGN_EVENTS');
    expect((await observer.query('SELECT COUNT(*)::integer AS count FROM public.job_events')).rows[0].count).toBe(1);
  });
  test('serializes receipt initialization through the real transaction advisory lock', async () => {
    await observer.query('BEGIN'); await observer.query('SELECT pg_advisory_xact_lock(1544,3)');
    const pending = admit(); void pending.catch(() => undefined);
    let waiting = false;
    for (let attempt = 0; attempt < 30 && !waiting; attempt += 1) {
      const result = await admin.query(`SELECT COUNT(*)::integer AS count FROM pg_stat_activity
        WHERE datname=$1 AND application_name='arcanos_self_heal_preview_owner_v1' AND wait_event_type='Lock'`, [databaseName]);
      waiting = result.rows[0].count === 1;
      if (!waiting) await new Promise(resolveWait => setTimeout(resolveWait, 10));
    }
    expect(waiting).toBe(true);
    expect((await observer.query("SELECT to_regclass('public.arcanos_self_heal_preview_owner_v1') AS receipt")).rows[0].receipt).toBeNull();
    await observer.query('COMMIT'); expect((await pending).mode).toBe('fresh-owned-receipt');
  });
  test('creates and reads the fixed fenced job using exact production columns/defaults without duplication', async () => {
    const { env, options } = await realClockAuthority();
    const created = await runSelfHealPreviewFencedJob('create', env, options);
    expect(created).toMatchObject({ sourceSha: SOURCE, providerRecoveryProven: false,
      job: { status: 'pending', claimGeneration: '0', lastWorkerId: null, retryCount: 0, leaseActive: false, completionEvents: 0, literalObserved: false } });
    const inspected = await runSelfHealPreviewFencedJob('inspect', env, options);
    const reused = await runSelfHealPreviewFencedJob('create', env, options);
    expect(inspected).toEqual(created); expect(reused).toEqual(created);
    const rows = await observer.query(`SELECT id::text, job_type, claim_generation::text, retry_count,
      max_retries, priority, input, next_run_at IS NOT NULL AS scheduled,
      expires_at > NOW() AS expires, retention_until > NOW() AS retained FROM public.job_data`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ id: created.job.id, job_type: 'ask', claim_generation: '0', retry_count: 0,
      max_retries: 0, priority: 100, scheduled: true, expires: true, retained: true,
      input: { prompt: 'Reply with exactly SEALED_PREVIEW_FENCED_OK', answerMode: 'direct', endpointName: 'self-heal.preview.fenced' } });
  });
  test('serializes two real concurrent fenced-job creates to one synthetic row', async () => {
    const { env, options } = await realClockAuthority();
    const [first, second] = await Promise.all([
      runSelfHealPreviewFencedJob('create', env, options),
      runSelfHealPreviewFencedJob('create', env, options),
    ]);
    expect(first.job.id).toBe(second.job.id);
    expect((await observer.query('SELECT COUNT(*)::integer AS count FROM public.job_data')).rows[0].count).toBe(1);
  });
  test('rejects a foreign owner receipt before inserting or changing any fenced job', async () => {
    const { env, options } = await realClockAuthority();
    const owner = (await observer.query('SELECT identity FROM public.arcanos_self_heal_preview_owner_v1')).rows[0].identity;
    const foreign = JSON.stringify({ ...JSON.parse(owner), runId: 'foreign-owned-run' });
    await observer.query('UPDATE public.arcanos_self_heal_preview_owner_v1 SET identity=$1', [foreign]);
    await expect(runSelfHealPreviewFencedJob('create', env, options)).rejects.toThrow('SELF_HEAL_PREVIEW_FENCED_JOB_FAILED');
    expect((await observer.query('SELECT COUNT(*)::integer AS count FROM public.job_data')).rows[0].count).toBe(0);
    expect((await observer.query('SELECT identity FROM public.arcanos_self_heal_preview_owner_v1')).rows[0].identity).toBe(foreign);
  });
  test('reports expired leases false and future leases true using the real PostgreSQL clock', async () => {
    const { env, options } = await realClockAuthority();
    const created = await runSelfHealPreviewFencedJob('create', env, options);
    await observer.query("UPDATE public.job_data SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1::uuid", [created.job.id]);
    expect((await runSelfHealPreviewFencedJob('inspect', env, options)).job.leaseActive).toBe(false);
    await observer.query("UPDATE public.job_data SET lease_expires_at=clock_timestamp()+INTERVAL '1 minute' WHERE id=$1::uuid", [created.job.id]);
    const before = (await observer.query('SELECT lease_expires_at FROM public.job_data WHERE id=$1::uuid', [created.job.id])).rows;
    expect((await runSelfHealPreviewFencedJob('inspect', env, options)).job.leaseActive).toBe(true);
    expect((await observer.query('SELECT lease_expires_at FROM public.job_data WHERE id=$1::uuid', [created.job.id])).rows).toEqual(before);
  });
  test('database clock expiry rejects the guarded INSERT even when injected admission time remains valid', async () => {
    const { env, options } = await realClockAuthority(true);
    const owner = (await observer.query('SELECT identity FROM public.arcanos_self_heal_preview_owner_v1')).rows[0].identity;
    await expect(runSelfHealPreviewFencedJob('create', env, options)).rejects.toThrow('SELF_HEAL_PREVIEW_FENCED_JOB_FAILED');
    expect((await observer.query('SELECT COUNT(*)::integer AS count FROM public.job_data')).rows[0].count).toBe(0);
    expect((await observer.query('SELECT identity FROM public.arcanos_self_heal_preview_owner_v1')).rows[0].identity).toBe(owner);
  });
  test('fails the supervisor closed on real owner-connection loss before permitting a new owner', async () => {
    await initialized(); const order: string[] = [];
    class Child extends EventEmitter {
      exitCode: number | null = null; signalCode: string | null = null;
      stdout = new PassThrough(); stderr = new PassThrough();
      constructor(private label: string) { super(); }
      kill(signal: string) { if (this.signalCode === null) { order.push(`${this.label}:${signal}`); this.signalCode = signal; this.emit('close', null, signal); } return true; }
    }
    const fixture = new Child('fixture'); const application = new Child('application');
    let appStarted!: () => void; const started = new Promise<void>(resolveStarted => { appStarted = resolveStarted; });
    const runtime = runSelfHealPreviewSupervisor('worker', environment(), {
      Client: GuardedProfileClient, now: () => NOW, processRef: new EventEmitter(),
      verifyArtifact: async () => ({ sourceSha: SOURCE, compiledSha256: COMPILED, fileCount: 1 }),
      spawnImpl: (_file: string, args: string[]) => {
        if (args[0].includes('openai-fixture')) {
          void Promise.resolve().then(() => fixture.stdout.write('SELF_HEAL_PREVIEW_OPENAI_READY_V1\n')); return fixture;
        }
        appStarted(); return application;
      },
    });
    const outcome = runtime.catch((error: Error) => error);
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([started, new Promise((_, reject) => {
        startupTimer = setTimeout(() => reject(new Error('OWNER_START_TIMEOUT')), 5000);
      })]);
    } finally { clearTimeout(startupTimer); }
    const owners = await admin.query(`SELECT pid FROM pg_stat_activity
      WHERE datname=$1 AND application_name='arcanos_self_heal_preview_owner_v1'`, [databaseName]);
    expect(owners.rows).toHaveLength(1);
    expect((await admin.query('SELECT pg_terminate_backend($1::integer) AS terminated', [owners.rows[0].pid])).rows[0].terminated).toBe(true);
    await expect(outcome).resolves.toMatchObject({ message: 'SELF_HEAL_PREVIEW_OWNERSHIP_LOST' });
    expect(order).toEqual(['application:SIGTERM', 'fixture:SIGTERM']);
    expect((await admit()).mode).toBe('receipt-bound-resume');
  }, 10_000);
});
