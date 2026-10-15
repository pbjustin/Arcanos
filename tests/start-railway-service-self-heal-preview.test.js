import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { BACKSTAGE_HEAVY_OPENAI_FIXTURE_SDK_KEY } from '../scripts/railway-backstage-heavy-openai-fixture.mjs';
import {
  bindSelfHealPreviewArtifact, buildSelfHealPreviewApplicationEnvironment, buildSelfHealPreviewFixtureEnvironment,
  preflightSelfHealPreviewDatabase, resolveSelfHealPreviewProfile, resolveSelfHealPreviewWorkerIds,
  buildSelfHealPreviewDatabaseClientOptions, validateSelfHealPreviewDatabaseCertificate,
  verifySelfHealPreviewDatabaseCertificateFile, SELF_HEAL_PREVIEW_DATABASE_CERTIFICATE_PATH,
  runSelfHealPreviewSupervisor, SelfHealPreviewError,
} from '../scripts/railway-self-heal-preview-profile.mjs';
import { resolveSelfHealPreviewFailureCode } from '../scripts/railway-backstage-heavy-proof-supervisor.mjs';
import { assertPreviewIsolationOrThrow, assertRailwayProcessIsolationOrThrow } from '../scripts/start-railway-service.mjs';
import { verifySelfHealPreviewArtifact } from '../scripts/self-heal-preview-artifact.mjs';
import { buildJobRunnerSlotDefinitions, resolveJobRunnerRuntimeSettings } from '../src/workers/jobRunnerRuntime.js';

const NOW = Date.parse('2026-10-14T16:00:00.000Z');
const DATABASE_CERTIFICATE_PEM = readFileSync(new URL('./fixtures/self-heal-preview-database-ca.pem', import.meta.url), 'utf8');
const IDS = { project: '11111111-1111-4111-8111-111111111111', environment: '22222222-2222-4222-8222-222222222222',
  web: '33333333-3333-4333-8333-333333333333', worker: '44444444-4444-4444-8444-444444444444',
  deployment: '55555555-5555-4555-8555-555555555555', postgres: '66666666-6666-4666-8666-666666666666', redis: '77777777-7777-4777-8777-777777777777' };
function environment(role = 'worker') {
  return {
    ARCANOS_BACKSTAGE_HEAVY_PROOF_TARGET: 'dedicated-backstage-heavy-preview-v1',
    ARCANOS_BACKSTAGE_HEAVY_PROOF_RUN_ID: 'proof-run-1544', ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA: 'a'.repeat(40),
    ARCANOS_PROCESS_KIND: role, NODE_ENV: 'production', ARCANOS_PREVIEW_ISOLATION: 'true', FORCE_MOCK: 'true',
    ALLOW_MOCK_OPENAI: 'true', OPENAI_API_KEY_REQUIRED: 'false',
    OPENAI_BASE_URL: role === 'worker' ? 'http://127.0.0.1:8766/v1' : 'http://127.0.0.1:9/v1',
    ...(role === 'worker' ? { ARCANOS_PREVIEW_OPENAI_FIXTURE: 'backstage-heavy-compact-retry-v1' } : {
      ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED: 'true',
      ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN: 'proof-only-fictional-access-token-0001',
      ARCANOS_JOB_READ_CAPABILITY_SECRET: 'proof-only-fictional-job-read-secret-0001',
    }),
    ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY: `${'A'.repeat(43)}=`,
    DATABASE_URL: 'postgresql://proof-user:proof-password@postgres.railway.internal:5432/railway',
    REDIS_URL: 'redis://default:proof-password@redis.railway.internal:6379',
    RAILWAY_PROJECT_ID: IDS.project, RAILWAY_PROJECT_NAME: 'arc-pr1544-heavy-test',
    RAILWAY_ENVIRONMENT_ID: IDS.environment, RAILWAY_ENVIRONMENT_NAME: 'backstage-heavy-pr-1544-e2e',
    RAILWAY_SERVICE_ID: IDS[role], RAILWAY_SERVICE_NAME: `arcanos-${role}-pr1544-heavy`,
    RAILWAY_DEPLOYMENT_ID: IDS.deployment, RAILWAY_GIT_COMMIT_SHA: 'a'.repeat(40),
    ARCANOS_BACKSTAGE_HEAVY_POSTGRES_SERVICE_ID: IDS.postgres, ARCANOS_BACKSTAGE_HEAVY_POSTGRES_SERVICE_NAME: 'Postgres',
    ARCANOS_BACKSTAGE_HEAVY_POSTGRES_INTERNAL_HOST: 'postgres.railway.internal',
    ARCANOS_BACKSTAGE_HEAVY_REDIS_SERVICE_ID: IDS.redis, ARCANOS_BACKSTAGE_HEAVY_REDIS_SERVICE_NAME: 'Redis',
    ARCANOS_BACKSTAGE_HEAVY_REDIS_INTERNAL_HOST: 'redis.railway.internal',
    ARCANOS_SELF_HEAL_PREVIEW_PROFILE: 'worker-coordinator-v1', ARCANOS_SELF_HEAL_PREVIEW_RUN_ID: 'proof-run-1544',
    ARCANOS_SELF_HEAL_PREVIEW_ISSUED_AT: '2026-10-14T15:59:00.000Z', ARCANOS_SELF_HEAL_PREVIEW_EXPIRES_AT: '2026-10-14T17:00:00.000Z',
    ARCANOS_SELF_HEAL_PREVIEW_CONTROL_TOKEN: 'b'.repeat(64), ARCANOS_SELF_HEAL_PREVIEW_CONTROL_PORT: '8791',
    ARCANOS_SELF_HEAL_PREVIEW_STARTUP_MODE: 'normal', ARCANOS_SELF_HEAL_PREVIEW_WEB_SERVICE_ID: IDS.web,
    ARCANOS_SELF_HEAL_PREVIEW_WORKER_SERVICE_ID: IDS.worker,
    ARCANOS_SELF_HEAL_PREVIEW_DATABASE_CERTIFICATE_PEM: DATABASE_CERTIFICATE_PEM,
  };
}
const ARTIFACT = { sourceSha: 'a'.repeat(40), compiledSha256: 'c'.repeat(64), fileCount: 10 };
function profile(role = 'worker', patch = {}) { return bindSelfHealPreviewArtifact(resolveSelfHealPreviewProfile(role, { ...environment(role), ...patch }, { now: () => NOW }), ARTIFACT); }
function database(options = {}) {
  const queries = []; const configurations = [];
  const client = new EventEmitter();
  client.connect = jest.fn(async () => {}); client.end = jest.fn(async () => {});
  client.query = jest.fn(async (sql, values) => {
    queries.push({ sql, values });
    if (options.error) throw new Error(options.error);
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: options.acquired !== false }] };
    if (sql.includes('AS receipt_exists')) return { rows: [{ receipt_exists: options.resume === true, job_data_exists: options.schema !== false, job_events_exists: options.schema !== false }] };
    if (sql.includes('AS user_table_count')) return { rows: [{ user_table_count: options.tableCount ?? 0 }] };
    if (sql.startsWith('SELECT identity')) return { rows: [{ identity: options.identity ?? JSON.stringify(profile(options.role ?? 'worker').ownership) }] };
    if (sql.includes('AS foreign_jobs')) return { rows: [{ foreign_jobs: options.foreignJobs ?? 0, active_leases: options.activeLeases ?? 0 }] };
    if (sql.includes('AS orphan_events')) return { rows: [{ orphan_events: options.orphanEvents ?? 0 }] };
    return { rows: [] };
  });
  class Client { constructor(config) { configurations.push(config); return client; } }
  return { Client, client, queries, configurations,
    verifyDatabaseCertificateFile: async value => value.ownership.databaseCertificateSha256 };
}
function launcherOptions() {
  const file = { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false,
    nlink: 1, uid: 0, mode: 0o100444, size: Buffer.byteLength(DATABASE_CERTIFICATE_PEM) };
  return { now: () => NOW, verifyArtifact: jest.fn(() => ARTIFACT), fileSystem: {
    lstatSync: jest.fn(path => path === SELF_HEAL_PREVIEW_DATABASE_CERTIFICATE_PATH || path.endsWith('self-heal-preview-artifact.json')
      ? { ...file } : { ...file, isFile: () => false, isDirectory: () => true, mode: 0o40755 }),
    readFileSync: jest.fn(() => DATABASE_CERTIFICATE_PEM),
  } };
}
class Child extends EventEmitter {
  constructor() { super(); this.exitCode = null; this.signalCode = null; this.stdout = new PassThrough(); this.stderr = new PassThrough();
    this.kill = jest.fn(signal => { this.close(null, signal); return true; }); }
  close(code, signal = null) { if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code; this.signalCode = signal; this.emit('close', code, signal); }
}
afterEach(() => { jest.useRealTimers(); });

describe('opt-in self-heal profile of the existing heavy preview supervisor', () => {
  it.each([
    ['profile validation', ['--self-heal-preview-v1'], {}, 'SELF_HEAL_PREVIEW_PROFILE_INVALID'],
    ['target validation', ['--self-heal-preview-v1'], { ARCANOS_SELF_HEAL_PREVIEW_PROFILE: 'worker-coordinator-v1' }, 'BACKSTAGE_HEAVY_PROOF_TARGET_INVALID'],
    ['legacy target validation', [], {}, 'BACKSTAGE_HEAVY_PROOF_TARGET_INVALID'],
  ])('retains the fixed %s diagnostic through the literal CLI entry point', (_label, args, env, expected) => {
    // No inherited credentials or valid target: every child fails validation
    // before artifact/database work or application/provider child creation.
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/railway-backstage-heavy-proof-supervisor.mjs', import.meta.url)), ...args], {
      env: { ARCANOS_PROCESS_KIND: 'worker', ...env }, encoding: 'utf8',
      timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(child.stdout).toBe('');
    expect(child.stderr).toBe(`${expected}\n`);
  });
  it('retains the real artifact verifier diagnostic before database or child startup', async () => {
    const db = database(); const spawnImpl = jest.fn();
    const error = await runSelfHealPreviewSupervisor('worker', environment(), {
      ...db, now: () => NOW, spawnImpl,
      // A file cannot contain an artifact tree: fail independently of whether
      // this checkout happens to have a generated artifact receipt.
      verifyArtifact: () => verifySelfHealPreviewArtifact({
        sourceSha: ARTIFACT.sourceSha, rootPath: fileURLToPath(new URL('../package.json', import.meta.url)),
      }),
    }).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SelfHealPreviewError);
    await expect(resolveSelfHealPreviewFailureCode(error)).resolves.toBe('SELF_HEAL_PREVIEW_ARTIFACT_INVALID');
    expect(db.client.connect).not.toHaveBeenCalled(); expect(spawnImpl).not.toHaveBeenCalled();
  });
  it.each([
    new Error('postgresql://sensitive.invalid/password'),
    new Error('SELF_HEAL_PREVIEW_ARTIFACT_INVALID token=sensitive'),
    new SelfHealPreviewError('SELF_HEAL_PREVIEW_UNKNOWN_SENSITIVE_PAYLOAD'),
    new Error('SELF_HEAL_PREVIEW_PROFILE_INVALID'),
    new Error('BACKSTAGE_HEAVY_PROOF_TARGET_INVALID'),
    { name: 'SelfHealPreviewError', message: 'SELF_HEAL_PREVIEW_PROFILE_INVALID' },
    { name: 'Error', message: 'SELF_HEAL_PREVIEW_ARTIFACT_INVALID' },
  ])('redacts unknown, decorated or forged failure diagnostics %#', async error => {
    await expect(resolveSelfHealPreviewFailureCode(error)).resolves.toBe('SELF_HEAL_PREVIEW_FAILED');
  });
  it('keeps the exact opt-in start command outside all existing Railway configuration', () => {
    expect(JSON.parse(readFileSync(new URL('../railway.self-heal-preview.json', import.meta.url), 'utf8'))).toEqual({
      $schema: 'https://railway.app/railway.schema.json', build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' }, deploy: {
        startCommand: 'node scripts/railway-backstage-heavy-proof-supervisor.mjs --self-heal-preview-v1',
      },
    });
  });
  it('binds both roles to one exact owner receipt and distinct service identities', () => {
    expect(profile('worker').ownership).toEqual(profile('web').ownership);
    expect(profile().controlPort).toBe(8791);
  });
  it.each([
    ['ARCANOS_SELF_HEAL_PREVIEW_PROFILE', 'other'], ['ARCANOS_SELF_HEAL_PREVIEW_RUN_ID', 'another-run-1544'],
    ['ARCANOS_SELF_HEAL_PREVIEW_CONTROL_TOKEN', 'B'.repeat(64)], ['ARCANOS_SELF_HEAL_PREVIEW_CONTROL_PORT', '80'],
    ['ARCANOS_SELF_HEAL_PREVIEW_ISSUED_AT', '2026-10-14T16:01:00.000Z'],
    ['ARCANOS_SELF_HEAL_PREVIEW_EXPIRES_AT', '2026-10-14T16:00:00.000Z'],
    ['ARCANOS_SELF_HEAL_PREVIEW_EXPIRES_AT', '2026-10-14T18:00:00.000Z'],
    ['ARCANOS_SELF_HEAL_PREVIEW_EXPIRES_AT', '2026-10-14T17:00:00Z'],
    ['ARCANOS_SELF_HEAL_PREVIEW_STARTUP_MODE', 'arbitrary-code'], ['ARCANOS_SELF_HEAL_PREVIEW_WEB_SERVICE_ID', IDS.worker],
    ['RAILWAY_GIT_COMMIT_SHA', 'c'.repeat(40)], ['PORT', '8791'],
  ])('rejects invalid or drifting %s before any spawn or database access', (name, value) => {
    expect(() => profile('worker', { [name]: value })).toThrow();
  });
  it('allows only the fixed scheduler startup failure on a Worker', () => {
    expect(profile('worker', { ARCANOS_SELF_HEAL_PREVIEW_STARTUP_MODE: 'scheduler-failure' }).startupMode).toBe('scheduler-failure');
    expect(() => profile('web', { ARCANOS_SELF_HEAL_PREVIEW_STARTUP_MODE: 'scheduler-failure' })).toThrow('SELF_HEAL_PREVIEW_STARTUP_MODE_INVALID');
  });
  it.each(['RAILWAY_TOKEN', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'CUSTOM_API_KEY', 'SELF_IMPROVE_ENABLED', 'PREDICTIVE_HEALING_ENABLED', 'NODE_OPTIONS'])('rejects ambient authority %s', name => {
    expect(() => profile('worker', { [name]: 'forbidden' })).toThrow();
  });
  it.each(['web', 'worker'])('admits the documented Railway snapshot metadata without projecting it into %s children', role => {
    const env = { ...environment(role), RAILWAY_SNAPSHOT_ID: '88888888-8888-4888-8888-888888888888' };
    const p = profile(role, { RAILWAY_SNAPSHOT_ID: env.RAILWAY_SNAPSHOT_ID });
    expect(buildSelfHealPreviewApplicationEnvironment(p, env)).not.toHaveProperty('RAILWAY_SNAPSHOT_ID');
    expect(buildSelfHealPreviewFixtureEnvironment(p)).not.toHaveProperty('RAILWAY_SNAPSHOT_ID');
    expect(() => profile(role, { RAILWAY_SNAPSHOT_SECRET: 'test-sensitive-marker' })).toThrow('ENV_FORBIDDEN');
  });
  it('builds literal role-specific environments and strips arbitrary ambient metadata', () => {
    const env = { ...environment(), PATH: '/ambient/bin', HOME: '/ambient/home', UNRELATED_BENIGN: 'discard' };
    const child = buildSelfHealPreviewApplicationEnvironment(profile(), env);
    expect(child.PATH).toBe('/usr/local/bin:/usr/bin:/bin'); expect(child).not.toHaveProperty('HOME'); expect(child).not.toHaveProperty('UNRELATED_BENIGN');
    expect(child).toMatchObject({ NODE_ENV: 'production', SELF_IMPROVE_ENABLED: 'false', SELF_IMPROVE_AUTONOMY_LEVEL: '0',
      PREDICTIVE_HEALING_ENABLED: 'false', PREDICTIVE_HEALING_DRY_RUN: 'true', JOB_WORKER_CONCURRENCY: '2',
      FORCE_MOCK: 'false', ALLOW_MOCK_OPENAI: 'false', OPENAI_API_KEY_REQUIRED: 'true',
      SELF_IMPROVE_EVIDENCE_DIR: '/app/memory/self-heal-preview-evidence',
      SELF_IMPROVE_KILL_SWITCH_KEY: 'arcanos:preview:self-heal:proof-run-1544:kill-switch:v1' });
    expect(child).not.toHaveProperty('ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN');
    expect(child).not.toHaveProperty('ARCANOS_SELF_HEAL_PREVIEW_DATABASE_CERTIFICATE_PEM');
    expect(new URL(child.DATABASE_URL).searchParams.get('sslmode')).toBe('verify-full');
    expect(new URL(child.DATABASE_URL).searchParams.get('sslrootcert')).toBe(SELF_HEAL_PREVIEW_DATABASE_CERTIFICATE_PATH);
    const web = buildSelfHealPreviewApplicationEnvironment(profile('web'), environment('web'));
    expect(web.SELF_IMPROVE_EVIDENCE_DIR).toBe('/app/memory/self-heal-preview-evidence');
    expect(web.OPENAI_BASE_URL).toBe('http://127.0.0.1:8766/v1'); expect(web.RUN_WORKERS).toBe('false');
    expect(environment('web').OPENAI_BASE_URL).toBe('http://127.0.0.1:9/v1');
    const fixture = buildSelfHealPreviewFixtureEnvironment(profile());
    expect(fixture).not.toHaveProperty('DATABASE_URL'); expect(fixture).not.toHaveProperty('REDIS_URL');
    expect(fixture).not.toHaveProperty('OPENAI_API_KEY'); expect(fixture.ARCANOS_SELF_HEAL_PREVIEW_RUN_ID).toBe('proof-run-1544');
  });
  it('uses the maintained two-consumer configuration and ordinary timing defaults without broad worker identity authority', () => {
    const configured = JSON.parse(readFileSync(new URL('../railway.json', import.meta.url), 'utf8'));
    const child = buildSelfHealPreviewApplicationEnvironment(profile(), environment());
    expect(child.JOB_WORKER_CONCURRENCY).toBe(configured.environments.production.variables.JOB_WORKER_CONCURRENCY);
    const actual = buildJobRunnerSlotDefinitions(resolveJobRunnerRuntimeSettings(child)).map(slot => slot.workerId);
    expect(resolveSelfHealPreviewWorkerIds(profile())).toEqual(actual);
    expect(actual).toEqual(['self-heal-preview-proof-run-1544-slot-1', 'self-heal-preview-proof-run-1544-slot-2']);
    expect(actual).not.toContain(child.JOB_WORKER_ID); expect(actual).not.toContain(`${child.JOB_WORKER_ID}-slot-3`);
    expect(child).not.toHaveProperty('JOB_WORKER_HEARTBEAT_MS'); expect(child).not.toHaveProperty('JOB_WORKER_LEASE_MS');
    expect(child).not.toHaveProperty('SELF_HEAL_LOOP_INTERVAL_MS');
    expect(environment()).toMatchObject({ FORCE_MOCK: 'true', ALLOW_MOCK_OPENAI: 'true', OPENAI_API_KEY_REQUIRED: 'false' });
  });
  it('passes actual normal startup key validation with only the fixed fictional SDK key', async () => {
    const child = buildSelfHealPreviewApplicationEnvironment(profile('web'), environment('web'));
    const values = { ...child, CI: 'false' };
    const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
    try {
      Object.assign(process.env, values);
      const { validateEnvironment, isOpenAIApiKeyRequiredForStartup } = await import('../src/platform/runtime/environmentValidation.js');
      expect(isOpenAIApiKeyRequiredForStartup()).toBe(true);
      expect(validateEnvironment().errors).toEqual([]);
      process.env.OPENAI_API_KEY = BACKSTAGE_HEAVY_OPENAI_FIXTURE_SDK_KEY;
      expect(validateEnvironment().errors.some(error => error.includes('OPENAI_API_KEY'))).toBe(true);
    } finally {
      for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    }
  });
  it('keeps the derived normal web gateway credential distinct, minimal and absent from the Worker', () => {
    const p = profile('web'); const env = environment('web'); const child = buildSelfHealPreviewApplicationEnvironment(p, env);
    expect(child.ARCANOS_GPT_ACCESS_TOKEN).toMatch(/^[a-f0-9]{64}$/u);
    expect(child.ARCANOS_GPT_ACCESS_TOKEN).not.toBe(p.controlToken);
    expect(child.ARCANOS_GPT_ACCESS_TOKEN).not.toBe(env.ARCANOS_JOB_READ_CAPABILITY_SECRET);
    expect(child.ARCANOS_GPT_ACCESS_TOKEN).not.toBe(env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN);
    expect(child.ARCANOS_GPT_ACCESS_SCOPES).toBe('runtime.read'); expect(child.ARCANOS_GPT_ACCESS_BASE_URL).toBe('http://127.0.0.1:8080');
    expect(buildSelfHealPreviewApplicationEnvironment(profile(), environment())).not.toHaveProperty('ARCANOS_GPT_ACCESS_TOKEN');
    expect(() => profile('web', { ARCANOS_GPT_ACCESS_TOKEN: child.ARCANOS_GPT_ACCESS_TOKEN })).toThrow();
  });
  it.each(['worker', 'web'])('passes the actual exported launcher gate only for an exact derived %s child and verified image', async role => {
    const child = buildSelfHealPreviewApplicationEnvironment(profile(role), environment(role)); const options = launcherOptions();
    await expect(assertRailwayProcessIsolationOrThrow(child, options)).resolves.toEqual({ enabled: true, environmentCategory: 'non-production',
      providerCategory: 'loopback', selfHealProfile: 'worker-coordinator-v1' });
    expect(options.verifyArtifact).toHaveBeenCalledWith(expect.objectContaining({ sourceSha: ARTIFACT.sourceSha }));
  });
  it.each([
    { ARCANOS_SELF_HEAL_PREVIEW_EXPIRES_AT: '2026-10-14T16:00:00.000Z' },
    { ARCANOS_SELF_HEAL_PREVIEW_RUN_ID: 'foreign-run-1544' }, { RAILWAY_ENVIRONMENT_NAME: 'production' },
    { RAILWAY_PROJECT_ID: '7faf44e5-519c-4e73-8d7a-da9f389e6187' },
    { ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA: 'b'.repeat(40) },
    { ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA: 'b'.repeat(40), RAILWAY_GIT_COMMIT_SHA: 'b'.repeat(40) },
    { OPENAI_API_KEY: 'foreign-key' }, { OPENAI_KEY: 'foreign-key' }, { OPENAI_BASE_URL: 'https://api.openai.com/v1' },
    { DATABASE_URL: `${environment().DATABASE_URL}?sslmode=no-verify` },
    { DATABASE_URL: `${environment().DATABASE_URL}?sslmode=verify-full&sslrootcert=/foreign/ca.pem` },
    { NODE_TLS_REJECT_UNAUTHORIZED: '0' }, { SELF_IMPROVE_ENABLED: 'true' },
    { JOB_WORKER_CONCURRENCY: '3' }, { JOB_WORKER_ID: 'foreign-worker' },
    { ARCANOS_SELF_HEAL_PREVIEW_DATABASE_CERTIFICATE_PEM: DATABASE_CERTIFICATE_PEM },
  ])('retains fail-closed actual launcher admission for malformed or foreign profile inputs %#', async patch => {
    const child = { ...buildSelfHealPreviewApplicationEnvironment(profile(), environment()), ...patch };
    await expect(assertRailwayProcessIsolationOrThrow(child, launcherOptions())).rejects.toThrow(/^PREVIEW_ISOLATION_/u);
  });
  it('keeps the original launcher mock gate for absent or unrelated profile markers', async () => {
    const child = buildSelfHealPreviewApplicationEnvironment(profile(), environment());
    delete child.ARCANOS_SELF_HEAL_PREVIEW_PROFILE;
    expect(() => assertPreviewIsolationOrThrow(child, launcherOptions())).toThrow('PREVIEW_ISOLATION_FORCE_MOCK_REQUIRED');
    await expect(assertRailwayProcessIsolationOrThrow(child, launcherOptions())).rejects.toThrow('PREVIEW_ISOLATION_FORCE_MOCK_REQUIRED');
    child.ARCANOS_SELF_HEAL_PREVIEW_PROFILE = 'foreign-profile';
    expect(() => assertPreviewIsolationOrThrow(child, launcherOptions())).toThrow('PREVIEW_ISOLATION_FORCE_MOCK_REQUIRED');
    await expect(assertRailwayProcessIsolationOrThrow(child, launcherOptions())).rejects.toThrow('PREVIEW_ISOLATION_FORCE_MOCK_REQUIRED');
  });
  it('rejects mutable manifest ownership or artifact drift at the actual launcher gate', async () => {
    const child = buildSelfHealPreviewApplicationEnvironment(profile(), environment()); const options = launcherOptions();
    const stat = options.fileSystem.lstatSync;
    options.fileSystem.lstatSync = jest.fn(path => ({ ...stat(path), ...(path.endsWith('self-heal-preview-artifact.json') ? { mode: 0o100644 } : {}) }));
    await expect(assertRailwayProcessIsolationOrThrow(child, options)).rejects.toThrow('PREVIEW_ISOLATION_SELF_HEAL_PROFILE_INVALID');
    const drift = launcherOptions(); drift.verifyArtifact.mockImplementation(() => { throw new Error('SECRET_SHOULD_NOT_ESCAPE'); });
    await expect(assertRailwayProcessIsolationOrThrow(child, drift)).rejects.toThrow('PREVIEW_ISOLATION_SELF_HEAL_PROFILE_INVALID');
  });
  it('requires a bounded public certificate before artifact, database or process activity', async () => {
    const db = database(); const verifyArtifact = jest.fn(); const spawnImpl = jest.fn();
    const env = environment(); delete env.ARCANOS_SELF_HEAL_PREVIEW_DATABASE_CERTIFICATE_PEM;
    await expect(runSelfHealPreviewSupervisor('worker', env, { ...db, now: () => NOW, verifyArtifact, spawnImpl }))
      .rejects.toThrow('SELF_HEAL_PREVIEW_DATABASE_CERTIFICATE_INVALID');
    expect(verifyArtifact).not.toHaveBeenCalled(); expect(db.client.connect).not.toHaveBeenCalled(); expect(spawnImpl).not.toHaveBeenCalled();
    for (const invalid of ['PRIVATE KEY', 'x'.repeat(16_385), `${DATABASE_CERTIFICATE_PEM}${DATABASE_CERTIFICATE_PEM}`]) {
      expect(() => validateSelfHealPreviewDatabaseCertificate(invalid, { now: () => NOW })).toThrow('SELF_HEAL_PREVIEW_DATABASE_CERTIFICATE_INVALID');
    }
  });
  it('binds the public CA fingerprint to ownership and uses strict TLS in every direct preview client', async () => {
    const p = profile(); const options = buildSelfHealPreviewDatabaseClientOptions(p);
    expect(options).toEqual({ connectionString: environment().DATABASE_URL,
      ssl: { rejectUnauthorized: true, ca: p.databaseCertificatePem } });
    expect(p.ownership.databaseCertificateSha256).toMatch(/^[a-f0-9]{64}$/u);
    const db = database(); const guard = await preflightSelfHealPreviewDatabase(p, db);
    expect(db.configurations[0]).toMatchObject(options); await guard.close();
  });
  it('checks the image CA file at its fixed immutable path before opening SQL or spawning', async () => {
    const db = database(); const spawnImpl = jest.fn();
    await expect(runSelfHealPreviewSupervisor('worker', environment(), { ...db, now: () => NOW,
      verifyArtifact: async () => ARTIFACT, verifyDatabaseCertificateFile: async () => 'd'.repeat(64), spawnImpl }))
      .rejects.toThrow('SELF_HEAL_PREVIEW_DATABASE_CERTIFICATE_FILE_INVALID');
    expect(db.client.connect).not.toHaveBeenCalled(); expect(spawnImpl).not.toHaveBeenCalled();
    const fs = { lstatSync: jest.fn(() => ({ isFile: () => true, isSymbolicLink: () => false,
      nlink: 1, uid: 0, mode: 0o100444, size: Buffer.byteLength(DATABASE_CERTIFICATE_PEM) })), readFileSync: jest.fn(() => DATABASE_CERTIFICATE_PEM) };
    expect(verifySelfHealPreviewDatabaseCertificateFile(profile(), { fileSystem: fs, now: () => NOW })).toBe(profile().ownership.databaseCertificateSha256);
    expect(fs.lstatSync).toHaveBeenCalledWith(SELF_HEAL_PREVIEW_DATABASE_CERTIFICATE_PATH);
    expect(fs.readFileSync).toHaveBeenCalledWith(SELF_HEAL_PREVIEW_DATABASE_CERTIFICATE_PATH, 'utf8');
    for (const patch of [{ uid: 1001 }, { nlink: 2 }, { mode: 0o100644 }, { isSymbolicLink: () => true }]) {
      fs.lstatSync.mockReturnValue({ isFile: () => true, isSymbolicLink: () => false, nlink: 1, uid: 0, mode: 0o100444,
        size: Buffer.byteLength(DATABASE_CERTIFICATE_PEM), ...patch });
      expect(() => verifySelfHealPreviewDatabaseCertificateFile(profile(), { fileSystem: fs, now: () => NOW }))
        .toThrow('SELF_HEAL_PREVIEW_DATABASE_CERTIFICATE_FILE_INVALID');
    }
  });
  it('accepts the exact Docker image metadata and strips it from both role environments', () => {
    const metadata = { ARCANOS_WORKSPACE_ROOT: '/app', ARCANOS_PYTHON_RUNTIME_DIR: '/app/daemon-python',
      RAILWAY_CLI_BIN: '/usr/local/bin/railway-native', PYTHON: 'python3' };
    for (const role of ['worker', 'web']) {
      const env = { ...environment(role), ...metadata };
      const resolved = resolveSelfHealPreviewProfile(role, env, { now: () => NOW });
      expect(resolved.proofTarget.processKind).toBe(role);
      const child = buildSelfHealPreviewApplicationEnvironment(resolved, env);
      for (const name of Object.keys(metadata)) expect(child).not.toHaveProperty(name);
    }
  });
  it.each([
    ['ARCANOS_WORKSPACE_ROOT', '/foreign'], ['ARCANOS_PYTHON_RUNTIME_DIR', '/foreign/daemon-python'],
    ['RAILWAY_CLI_BIN', '/foreign/railway'],
  ])('rejects altered image metadata %s before artifact verification, database access, or spawning', async (name, value) => {
    const db = database(); const spawnImpl = jest.fn(); const verifyArtifact = jest.fn(async () => ARTIFACT);
    await expect(runSelfHealPreviewSupervisor('worker', { ...environment(), [name]: value }, {
      ...db, now: () => NOW, spawnImpl, verifyArtifact,
    })).rejects.toThrow('SELF_HEAL_PREVIEW_IMAGE_METADATA_INVALID');
    expect(db.client.connect).not.toHaveBeenCalled(); expect(verifyArtifact).not.toHaveBeenCalled();
    expect(spawnImpl).not.toHaveBeenCalled();
  });
  it('creates only a fixed fixture ownership receipt after an empty catalog and holds its lock', async () => {
    const db = database(); const guard = await preflightSelfHealPreviewDatabase(profile(), db);
    expect(guard.mode).toBe('fresh-owned-receipt'); expect(db.client.end).not.toHaveBeenCalled();
    expect(db.queries.map(query => query.sql).filter(sql => /^(CREATE|INSERT)/u.test(sql))).toHaveLength(2);
    const insert = db.queries.find(query => query.sql.startsWith('INSERT'));
    expect(JSON.parse(insert.values[0])).toEqual(profile().ownership);
    expect(JSON.stringify(db.queries)).not.toContain('proof-password');
    await guard.close(); await guard.close(); expect(db.client.end).toHaveBeenCalledTimes(1);
  });
  it('admits an exact completed synthetic run on restart without rewriting ownership', async () => {
    const db = database({ resume: true }); const guard = await preflightSelfHealPreviewDatabase(profile(), db);
    expect(guard.mode).toBe('receipt-bound-resume');
    expect(db.queries.some(query => /^(CREATE|INSERT|UPDATE|DELETE)/u.test(query.sql))).toBe(false);
    expect(db.queries.find(query => query.sql.includes('AS foreign_jobs')).values).toEqual([
      'self-heal-preview:proof-run-1544:', ['self-heal-preview-proof-run-1544-slot-1', 'self-heal-preview-proof-run-1544-slot-2'],
    ]);
    expect(db.queries.find(query => query.sql.includes('AS foreign_jobs')).sql).toContain('last_worker_id <> ALL($2::text[])');
    await guard.close();
  });
  it.each([
    { acquired: false }, { tableCount: 1 }, { resume: true, identity: '{}' },
    { resume: true, foreignJobs: 1 }, { resume: true, activeLeases: 1 },
    { resume: true, orphanEvents: 1 }, { resume: true, schema: false },
  ])('rejects foreign or active receipt/database state %# and rolls back safely', async options => {
    const db = database(options); await expect(preflightSelfHealPreviewDatabase(profile(), db)).rejects.toThrow(/^SELF_HEAL_PREVIEW_/u);
    expect(db.client.end).toHaveBeenCalledTimes(1);
    expect(db.queries.some(query => /^(CREATE|INSERT|UPDATE|DELETE)/u.test(query.sql))).toBe(false);
  });
  it('refuses a web bootstrap before the worker established ownership', async () => {
    const db = database(); await expect(preflightSelfHealPreviewDatabase(profile('web'), db)).rejects.toThrow('SELF_HEAL_PREVIEW_RECEIPT_MISSING');
  });
  it('redacts arbitrary database errors and rejects loss of the live ownership lock', async () => {
    const failed = database({ error: 'postgresql://sensitive.invalid/password' });
    await expect(preflightSelfHealPreviewDatabase(profile(), failed)).rejects.toThrow('SELF_HEAL_PREVIEW_DATABASE_PREFLIGHT_FAILED');
    const db = database(); const guard = await preflightSelfHealPreviewDatabase(profile(), db);
    db.client.emit('error', new Error('sensitive transport')); await expect(guard.lost).rejects.toThrow('SELF_HEAL_PREVIEW_OWNERSHIP_LOST');
    await guard.close();
  });
  it('fails artifact verification before opening the database or launching a child', async () => {
    const db = database(); const spawnImpl = jest.fn(); const verifyArtifact = jest.fn(async () => { throw new Error('ARTIFACT_MISMATCH'); });
    await expect(runSelfHealPreviewSupervisor('worker', environment(), { ...db, now: () => NOW, spawnImpl, verifyArtifact })).rejects.toThrow('ARTIFACT_MISMATCH');
    expect(db.client.connect).not.toHaveBeenCalled(); expect(spawnImpl).not.toHaveBeenCalled();
    expect(verifyArtifact).toHaveBeenCalledWith(expect.objectContaining({ sourceSha: 'a'.repeat(40) }));
  });
  it('requires a verified compiled digest before writing restart authority', async () => {
    const db = database();
    const unbound = resolveSelfHealPreviewProfile('worker', environment(), { now: () => NOW });
    await expect(preflightSelfHealPreviewDatabase(unbound, db)).rejects.toThrow('SELF_HEAL_PREVIEW_ARTIFACT_INVALID');
    expect(db.client.connect).not.toHaveBeenCalled();
    expect(() => bindSelfHealPreviewArtifact(unbound, { ...ARTIFACT, sourceSha: 'f'.repeat(40) })).toThrow('SELF_HEAL_PREVIEW_ARTIFACT_INVALID');
    const resumed = database({ resume: true, identity: JSON.stringify({ ...profile().ownership, compiledSha256: 'd'.repeat(64) }) });
    await expect(preflightSelfHealPreviewDatabase(profile(), resumed)).rejects.toThrow('SELF_HEAL_PREVIEW_RECEIPT_MISMATCH');
  });
  it.each(['worker', 'web'])('keeps the %s provider and owner lock alive until the actual application drains', async role => {
    jest.useFakeTimers();
    const db = database({ resume: role === 'web', role }); const fixture = new Child(); const application = new Child(); const order = [];
    application.kill = jest.fn(signal => { order.push(`application:${signal}`); return true; });
    fixture.kill = jest.fn(signal => { order.push(`fixture:${signal}`); fixture.close(null, signal); return true; });
    db.client.end.mockImplementation(async () => { order.push('owner:release'); });
    const processRef = new EventEmitter();
    const spawnImpl = jest.fn((_, args) => {
      if (args[0].includes('openai-fixture')) {
        void Promise.resolve().then(() => fixture.stdout.write('SELF_HEAL_PREVIEW_OPENAI_READY_V1\n'));
        return fixture;
      }
      return application;
    });
    const pending = runSelfHealPreviewSupervisor(role, environment(role), { ...db, now: () => NOW,
      verifyArtifact: async () => ARTIFACT, processRef, spawnImpl });
    await jest.advanceTimersByTimeAsync(0); expect(spawnImpl).toHaveBeenCalledTimes(2);
    expect(spawnImpl.mock.calls[0][1][1]).toBe('--serve-self-heal-v1');
    processRef.emit('SIGTERM'); await jest.advanceTimersByTimeAsync(2_000);
    expect(order).toEqual(['application:SIGTERM']); expect(db.client.end).not.toHaveBeenCalled();
    application.close(0); await expect(pending).resolves.toBe(0);
    expect(order).toEqual(['application:SIGTERM', 'fixture:SIGTERM', 'owner:release']);
  });
  it('bounds a stuck application drain at 60 seconds and records failure after forced cleanup', async () => {
    jest.useFakeTimers(); const db = database({ resume: true, role: 'web' }); const application = new Child();
    const fixture = new Child();
    application.kill = jest.fn(signal => { if (signal === 'SIGKILL') application.close(null, signal); return true; });
    const processRef = new EventEmitter();
    const spawnImpl = jest.fn((_, args) => {
      if (args[0].includes('openai-fixture')) { void Promise.resolve().then(() => fixture.stdout.write('SELF_HEAL_PREVIEW_OPENAI_READY_V1\n')); return fixture; }
      return application;
    });
    const pending = runSelfHealPreviewSupervisor('web', environment('web'), { ...db, now: () => NOW,
      verifyArtifact: async () => ARTIFACT, processRef, spawnImpl });
    const outcome = pending.catch(error => error);
    await jest.advanceTimersByTimeAsync(0); processRef.emit('SIGTERM'); await jest.advanceTimersByTimeAsync(59_999);
    expect(application.kill.mock.calls).toEqual([['SIGTERM']]); expect(db.client.end).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect((await outcome).message).toBe('SELF_HEAL_PREVIEW_TEARDOWN_FAILED');
    expect(application.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]); expect(db.client.end).toHaveBeenCalledTimes(1);
  });
  it('runs the ordinary integrity wrapper and expires the application before releasing ownership', async () => {
    jest.useFakeTimers(); const db = database({ resume: true, role: 'web' }); const child = new Child();
    const fixture = new Child(); const processRef = new EventEmitter(); const spawnImpl = jest.fn((_, args) => {
      if (args[0].includes('openai-fixture')) { void Promise.resolve().then(() => fixture.stdout.write('SELF_HEAL_PREVIEW_OPENAI_READY_V1\n')); return fixture; }
      return child;
    });
    const pending = runSelfHealPreviewSupervisor('web', environment('web'), { ...db, now: () => NOW,
      verifyArtifact: async () => ARTIFACT, processRef, spawnImpl });
    await jest.advanceTimersByTimeAsync(0); expect(spawnImpl).toHaveBeenCalledTimes(2);
    expect(spawnImpl.mock.calls[1][1]).toEqual(['scripts/start-railway-service-with-integrity.mjs']);
    expect(spawnImpl.mock.calls[1][2].env.OPENAI_BASE_URL).toBe('http://127.0.0.1:8766/v1');
    expect(db.client.end).not.toHaveBeenCalled(); await jest.advanceTimersByTimeAsync(3_600_000);
    await expect(pending).resolves.toBe(0); expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(db.client.end).toHaveBeenCalledTimes(1); expect(processRef.listenerCount('SIGTERM')).toBe(0);
  });
});
