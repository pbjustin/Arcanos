/** Opt-in, expiring self-healing profile for the existing disposable supervisor. */
import { spawn } from 'node:child_process';
import { createHash, createHmac, X509Certificate } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { verifySelfHealPreviewArtifact } from './self-heal-preview-artifact.mjs';
import {
  buildBackstageHeavyApplicationChildEnvironment,
  resolveBackstageHeavyProofTargetOrThrow,
} from './railway-backstage-heavy-proof-supervisor.mjs';
import {
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_CHILD_ENV,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_CHILD_VALUE,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_BASE_URL,
  SELF_HEAL_PREVIEW_OPENAI_FIXTURE_SDK_KEY,
} from './railway-backstage-heavy-openai-fixture.mjs';

export const SELF_HEAL_PREVIEW_PROFILE = 'worker-coordinator-v1';
export const SELF_HEAL_PREVIEW_ARGUMENT = '--self-heal-preview-v1';
export const SELF_HEAL_PREVIEW_MAX_LEASE_MS = 7_200_000;
export const SELF_HEAL_PREVIEW_WORKER_CONCURRENCY = 2;
export const SELF_HEAL_PREVIEW_DATABASE_CERTIFICATE_PATH = '/app/config/self-heal-preview-database-ca.pem';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PREFIX = 'ARCANOS_SELF_HEAL_PREVIEW_';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTROL_PORT = '8791';
const RECEIPT_TABLE = 'public.arcanos_self_heal_preview_owner_v1';
const PLATFORM_NAMES = Object.freeze([
  'RAILWAY_PROJECT_ID', 'RAILWAY_PROJECT_NAME', 'RAILWAY_ENVIRONMENT_ID',
  'RAILWAY_ENVIRONMENT_NAME', 'RAILWAY_SERVICE_ID', 'RAILWAY_SERVICE_NAME',
  'RAILWAY_DEPLOYMENT_ID', 'RAILWAY_GIT_COMMIT_SHA',
]);
const PROOF_NAMES = Object.freeze([
  'ARCANOS_BACKSTAGE_HEAVY_PROOF_TARGET', 'ARCANOS_BACKSTAGE_HEAVY_PROOF_RUN_ID',
  'ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA',
  'ARCANOS_BACKSTAGE_HEAVY_POSTGRES_SERVICE_ID', 'ARCANOS_BACKSTAGE_HEAVY_POSTGRES_SERVICE_NAME',
  'ARCANOS_BACKSTAGE_HEAVY_POSTGRES_INTERNAL_HOST', 'ARCANOS_BACKSTAGE_HEAVY_REDIS_SERVICE_ID',
  'ARCANOS_BACKSTAGE_HEAVY_REDIS_SERVICE_NAME', 'ARCANOS_BACKSTAGE_HEAVY_REDIS_INTERNAL_HOST',
]);
const PROFILE_NAMES = Object.freeze([
  'PROFILE', 'RUN_ID', 'ISSUED_AT', 'EXPIRES_AT', 'CONTROL_TOKEN', 'CONTROL_PORT',
  'STARTUP_MODE', 'WEB_SERVICE_ID', 'WORKER_SERVICE_ID',
  'DATABASE_CERTIFICATE_PEM',
].map(name => `${PREFIX}${name}`));
const APP_INPUT_NAMES = Object.freeze([
  ...PLATFORM_NAMES, ...PROOF_NAMES, ...PROFILE_NAMES, 'PORT', 'DATABASE_URL', 'REDIS_URL',
  'ARCANOS_PROCESS_KIND', 'NODE_ENV', 'ARCANOS_PREVIEW_ISOLATION', 'FORCE_MOCK',
  'ALLOW_MOCK_OPENAI', 'OPENAI_API_KEY_REQUIRED', 'OPENAI_BASE_URL',
  'ARCANOS_PREVIEW_OPENAI_FIXTURE', 'ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY',
  'ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED', 'ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN',
  'ARCANOS_JOB_READ_CAPABILITY_SECRET',
]);
const ALLOWED_INPUT_NAMES = new Set(APP_INPUT_NAMES);
const IMAGE_METADATA = new Map([
  ['ARCANOS_WORKSPACE_ROOT', '/app'],
  ['ARCANOS_PYTHON_RUNTIME_DIR', '/app/daemon-python'],
  ['RAILWAY_CLI_BIN', '/usr/local/bin/railway-native'],
]);
const BENIGN_AMBIENT_NAMES = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'OLDPWD', 'SHLVL', '_',
  'HOSTNAME', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'TMPDIR', 'TMP', 'TEMP',
  'RAILWAY_PUBLIC_DOMAIN', 'RAILWAY_PRIVATE_DOMAIN', 'RAILWAY_REPLICA_ID', 'RAILWAY_REPLICA_REGION',
  'RAILWAY_GIT_AUTHOR', 'RAILWAY_GIT_BRANCH', 'RAILWAY_GIT_COMMIT_MESSAGE', 'RAILWAY_GIT_REPO_NAME',
  'RAILWAY_GIT_REPO_OWNER', 'RAILWAY_DEPLOYMENT_DRAINING_SECONDS', 'RAILWAY_GRACEFUL_SHUTDOWN_TIMEOUT',
  'RAILWAY_HEALTHCHECK_TIMEOUT_SEC', 'RAILWAY_RUN_UID',
]);
const SENSITIVE_NAME = /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE|PROXY|(?:^|_)KEY(?:$|_)|OPENAI|ANTHROPIC|AZURE|NOTION|DATABASE|POSTGRES|REDIS|SELF_HEAL|SELF_IMPROVE|PREDICTIVE|AUTONOMY|NODE_OPTIONS|NODE_EXTRA_CA|NODE_TLS)/iu;
const WINDOWS_AUTOMATIC_NAMES = new Set(['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SYSTEMDRIVE',
  'SYSTEMROOT', 'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR']);

export class SelfHealPreviewError extends Error {}
function proofError(code) { return new SelfHealPreviewError(`SELF_HEAL_PREVIEW_${code}`); }
function fail(code) { throw proofError(code); }
function exactIso(value) {
  const timestamp = Date.parse(value);
  return typeof value === 'string' && Number.isFinite(timestamp)
    && new Date(timestamp).toISOString() === value ? timestamp : NaN;
}
function literalPick(env, names) {
  return Object.fromEntries(names.filter(name => Object.hasOwn(env, name)).map(name => [name, env[name]]));
}

/** Only one preview-owned, self-signed public certificate for the exact private host. */
export function validateSelfHealPreviewDatabaseCertificate(value, options = {}) {
  const now = options.now?.() ?? Date.now();
  const expiresAtMs = options.expiresAtMs ?? now + SELF_HEAL_PREVIEW_MAX_LEASE_MS;
  if (typeof value !== 'string' || Buffer.byteLength(value) > 16_384) fail('DATABASE_CERTIFICATE_INVALID');
  const pem = value.trim();
  if (!/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----$/u.test(pem)) fail('DATABASE_CERTIFICATE_INVALID');
  try {
    const certificate = new X509Certificate(pem);
    if (Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= expiresAtMs
      || certificate.subject !== certificate.issuer || !certificate.verify(certificate.publicKey)
      || certificate.checkHost('postgres.railway.internal', { wildcards: false, subject: 'never' }) !== 'postgres.railway.internal') fail('DATABASE_CERTIFICATE_INVALID');
    return Object.freeze({ pem: certificate.toString(),
      sha256: createHash('sha256').update(certificate.raw).digest('hex') });
  } catch { fail('DATABASE_CERTIFICATE_INVALID'); }
}

/** Validate a single dedicated heavy-preview target and a finite process lease. */
export function resolveSelfHealPreviewProfile(processKind, env, options = {}) {
  if (env[`${PREFIX}PROFILE`] !== SELF_HEAL_PREVIEW_PROFILE) fail('PROFILE_INVALID');
  const proofTarget = resolveBackstageHeavyProofTargetOrThrow(processKind, env);
  const issuedAtMs = exactIso(env[`${PREFIX}ISSUED_AT`]);
  const expiresAtMs = exactIso(env[`${PREFIX}EXPIRES_AT`]);
  const now = options.now?.() ?? Date.now();
  if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs)
    || issuedAtMs > now || expiresAtMs <= now || expiresAtMs <= issuedAtMs
    || expiresAtMs - issuedAtMs > SELF_HEAL_PREVIEW_MAX_LEASE_MS) fail('LEASE_INVALID');
  const databaseCertificate = validateSelfHealPreviewDatabaseCertificate(env[`${PREFIX}DATABASE_CERTIFICATE_PEM`],
    { now: () => now, expiresAtMs });
  const webServiceId = env[`${PREFIX}WEB_SERVICE_ID`];
  const workerServiceId = env[`${PREFIX}WORKER_SERVICE_ID`];
  if (!UUID.test(webServiceId ?? '') || !UUID.test(workerServiceId ?? '')
    || new Set([webServiceId, workerServiceId, proofTarget.postgresServiceId, proofTarget.redisServiceId]).size !== 4
    || proofTarget.serviceId !== (processKind === 'worker' ? workerServiceId : webServiceId)
    || env[`${PREFIX}RUN_ID`] !== proofTarget.runId) fail('IDENTITY_INVALID');
  if (!/^[0-9a-f]{64}$/u.test(env[`${PREFIX}CONTROL_TOKEN`] ?? '')
    || env[`${PREFIX}CONTROL_PORT`] !== CONTROL_PORT) fail('CONTROL_INVALID');
  const startupMode = env[`${PREFIX}STARTUP_MODE`];
  if (!['normal', 'scheduler-failure'].includes(startupMode)
    || (processKind === 'web' && startupMode !== 'normal')) fail('STARTUP_MODE_INVALID');
  if (env.PORT !== undefined && (!/^\d{4,5}$/u.test(env.PORT) || Number(env.PORT) < 1024 || Number(env.PORT) > 65535
    || env.PORT === CONTROL_PORT || env.PORT === '8766')) fail('PORT_INVALID');
  for (const name of Object.keys(env)) {
    if (IMAGE_METADATA.has(name)) {
      if (env[name] !== IMAGE_METADATA.get(name)) fail('IMAGE_METADATA_INVALID');
      continue;
    }
    if (ALLOWED_INPUT_NAMES.has(name) || BENIGN_AMBIENT_NAMES.has(name)) continue;
    if (SENSITIVE_NAME.test(name) || name.startsWith('ARCANOS_') || name.startsWith('RAILWAY_')
      || name.startsWith('JOB_') || name.startsWith('RUN_') || name.startsWith('BOOKER_')) fail('ENV_FORBIDDEN');
  }
  const issuedAt = env[`${PREFIX}ISSUED_AT`];
  const expiresAt = env[`${PREFIX}EXPIRES_AT`];
  const ownership = Object.freeze({
    version: 1, owner: 'pbjustin', repository: 'pbjustin/Arcanos', profile: SELF_HEAL_PREVIEW_PROFILE,
    projectId: proofTarget.projectId, projectName: proofTarget.projectName,
    environmentId: proofTarget.environmentId, environmentName: proofTarget.environmentName,
    webServiceId, workerServiceId, postgresServiceId: proofTarget.postgresServiceId,
    redisServiceId: proofTarget.redisServiceId, runId: proofTarget.runId,
    sourceSha: proofTarget.sourceCommit, issuedAt, expiresAt,
    databaseCertificateSha256: databaseCertificate.sha256,
  });
  return Object.freeze({ proofTarget, ownership, issuedAt, expiresAt, expiresAtMs,
    databaseCertificatePem: databaseCertificate.pem,
    controlToken: env[`${PREFIX}CONTROL_TOKEN`], controlPort: Number(CONTROL_PORT), startupMode });
}

/** Bind resume authority to the independently verified executable inventory. */
export function bindSelfHealPreviewArtifact(profile, artifact) {
  if (artifact?.sourceSha !== profile.proofTarget.sourceCommit
    || !/^[0-9a-f]{64}$/u.test(artifact?.compiledSha256 ?? '')) fail('ARTIFACT_INVALID');
  return Object.freeze({ ...profile, ownership: Object.freeze({ ...profile.ownership,
    compiledSha256: artifact.compiledSha256 }) });
}

/** Derive only reviewed child inputs; no ambient administration or provider authority survives. */
export function buildSelfHealPreviewApplicationEnvironment(profile, env) {
  const input = literalPick(env, APP_INPUT_NAMES);
  const derived = buildBackstageHeavyApplicationChildEnvironment(profile.proofTarget, input);
  const workerId = `self-heal-preview-${profile.proofTarget.runId}`;
  // Let the ordinary Worker resolve heartbeat/lease defaults. The original
  // heavy profile keeps its explicit short proof configuration unchanged.
  delete derived.JOB_WORKER_HEARTBEAT_MS;
  delete derived.JOB_WORKER_LEASE_MS;
  delete derived[`${PREFIX}DATABASE_CERTIFICATE_PEM`];
  const databaseUrl = new URL(profile.proofTarget.databaseUrl);
  databaseUrl.searchParams.set('sslmode', 'verify-full');
  databaseUrl.searchParams.set('sslrootcert', SELF_HEAL_PREVIEW_DATABASE_CERTIFICATE_PATH);
  return {
    ...derived, PATH: '/usr/local/bin:/usr/bin:/bin', TZ: 'UTC', RUN_WORKERS: profile.proofTarget.processKind === 'worker' ? 'true' : 'false',
    // The parent remains sealed; only this reviewed application child uses the
    // normal SDK startup graph against its fixed synthetic loopback adapter.
    FORCE_MOCK: 'false', ALLOW_MOCK_OPENAI: 'false', OPENAI_API_KEY_REQUIRED: 'true',
    OPENAI_API_KEY: SELF_HEAL_PREVIEW_OPENAI_FIXTURE_SDK_KEY,
    OPENAI_BASE_URL: BACKSTAGE_HEAVY_OPENAI_FIXTURE_BASE_URL,
    DATABASE_URL: databaseUrl.toString(),
    SELF_IMPROVE_ENABLED: 'false', SELF_IMPROVE_AUTONOMY_LEVEL: '0', SELF_IMPROVE_FREEZE: 'false',
    SELF_IMPROVE_EVIDENCE_DIR: '/app/memory/self-heal-preview-evidence',
    PREDICTIVE_HEALING_ENABLED: 'false', PREDICTIVE_HEALING_DRY_RUN: 'true',
    SELF_IMPROVE_KILL_SWITCH_KEY: `arcanos:preview:self-heal:${profile.proofTarget.runId}:kill-switch:v1`,
    ...(profile.proofTarget.processKind === 'worker'
      ? { JOB_WORKER_ID: workerId, JOB_WORKER_STATS_ID: workerId,
          JOB_WORKER_CONCURRENCY: String(SELF_HEAL_PREVIEW_WORKER_CONCURRENCY) }
      : { ARCANOS_GPT_ACCESS_TOKEN: createHmac('sha256', profile.controlToken)
            .update(`arcanos:self-heal-preview:${profile.proofTarget.runId}:gpt-access:v1`).digest('hex'),
          ARCANOS_GPT_ACCESS_BASE_URL: `http://127.0.0.1:${env.PORT ?? '8080'}`,
          ARCANOS_GPT_ACCESS_SCOPES: 'runtime.read' }),
  };
}

/** Exact ordinary consumer identities; never grant authority by worker prefix. */
export function resolveSelfHealPreviewWorkerIds(profile) {
  return Object.freeze(Array.from({ length: SELF_HEAL_PREVIEW_WORKER_CONCURRENCY },
    (_, index) => `self-heal-preview-${profile.proofTarget.runId}-slot-${index + 1}`));
}

/** All direct preview clients enforce the same CA and hostname verification. */
export function buildSelfHealPreviewDatabaseClientOptions(profile) {
  return { connectionString: profile.proofTarget.databaseUrl,
    ssl: { rejectUnauthorized: true, ca: profile.databaseCertificatePem } };
}

/** The image trust file is literal, root-owned, readonly and artifact-inventoried. */
function readImmutableDatabaseCertificateFile(options = {}) {
  const fs = options.fileSystem ?? { lstatSync, readFileSync };
  try {
    const stat = fs.lstatSync(SELF_HEAL_PREVIEW_DATABASE_CERTIFICATE_PATH);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== 0
      || (stat.mode & 0o222) !== 0 || stat.size > 16_384) fail('DATABASE_CERTIFICATE_FILE_INVALID');
    return fs.readFileSync(SELF_HEAL_PREVIEW_DATABASE_CERTIFICATE_PATH, 'utf8');
  } catch { fail('DATABASE_CERTIFICATE_FILE_INVALID'); }
}
export function verifySelfHealPreviewDatabaseCertificateFile(profile, options = {}) {
  try {
    const observed = validateSelfHealPreviewDatabaseCertificate(readImmutableDatabaseCertificateFile(options),
      { now: options.now, expiresAtMs: profile.expiresAtMs });
    if (observed.sha256 !== profile.ownership.databaseCertificateSha256) fail('DATABASE_CERTIFICATE_FILE_INVALID');
    return observed.sha256;
  } catch { fail('DATABASE_CERTIFICATE_FILE_INVALID'); }
}

/** Admit only an exact supervisor-derived child through the ordinary launcher. */
export function assertSelfHealPreviewApplicationChildOrThrow(env, options = {}) {
  try {
    if (env.ARCANOS_SELF_HEAL_PREVIEW_PROFILE !== SELF_HEAL_PREVIEW_PROFILE) fail('PROFILE_INVALID');
    const databaseUrl = new URL(env.DATABASE_URL);
    if (databaseUrl.searchParams.size !== 2 || databaseUrl.searchParams.get('sslmode') !== 'verify-full'
      || databaseUrl.searchParams.get('sslrootcert') !== SELF_HEAL_PREVIEW_DATABASE_CERTIFICATE_PATH) fail('ENV_FORBIDDEN');
    databaseUrl.search = '';
    const parent = { ...literalPick(env, APP_INPUT_NAMES), DATABASE_URL: databaseUrl.toString(),
      FORCE_MOCK: 'true', ALLOW_MOCK_OPENAI: 'true', OPENAI_API_KEY_REQUIRED: 'false',
      OPENAI_BASE_URL: env.ARCANOS_PROCESS_KIND === 'web' ? 'http://127.0.0.1:9/v1' : BACKSTAGE_HEAVY_OPENAI_FIXTURE_BASE_URL,
      ARCANOS_SELF_HEAL_PREVIEW_DATABASE_CERTIFICATE_PEM: readImmutableDatabaseCertificateFile(options) };
    const profile = resolveSelfHealPreviewProfile(env.ARCANOS_PROCESS_KIND, parent, options);
    verifySelfHealPreviewDatabaseCertificateFile(profile, options);
    const expected = buildSelfHealPreviewApplicationEnvironment(profile, parent);
    if (Object.keys(expected).some(name => env[name] !== expected[name])
      || Object.keys(env).some(name => !Object.hasOwn(expected, name)
        && !(process.platform === 'win32' && WINDOWS_AUTOMATIC_NAMES.has(name.toUpperCase())))) fail('ENV_FORBIDDEN');
    const fs = options.fileSystem ?? { lstatSync };
    for (const path of [ROOT, fileURLToPath(new URL('./', import.meta.url))]) {
      const stat = fs.lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) fail('ARTIFACT_INVALID');
    }
    const manifest = fs.lstatSync(fileURLToPath(new URL('./self-heal-preview-artifact.json', import.meta.url)));
    if (!manifest.isFile() || manifest.isSymbolicLink() || manifest.nlink !== 1 || manifest.uid !== 0
      || (manifest.mode & 0o222) !== 0) fail('ARTIFACT_INVALID');
    const artifact = (options.verifyArtifact ?? verifySelfHealPreviewArtifact)({ sourceSha: profile.proofTarget.sourceCommit, rootPath: ROOT });
    bindSelfHealPreviewArtifact(profile, artifact);
    return { enabled: true, environmentCategory: 'non-production', providerCategory: 'loopback', selfHealProfile: SELF_HEAL_PREVIEW_PROFILE };
  } catch { throw new Error('PREVIEW_ISOLATION_SELF_HEAL_PROFILE_INVALID'); }
}

export function buildSelfHealPreviewFixtureEnvironment(profile) {
  return {
    [BACKSTAGE_HEAVY_OPENAI_FIXTURE_CHILD_ENV]: BACKSTAGE_HEAVY_OPENAI_FIXTURE_CHILD_VALUE,
    ARCANOS_BACKSTAGE_HEAVY_PROOF_RUN_ID: profile.proofTarget.runId,
    ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA: profile.proofTarget.sourceCommit,
    ARCANOS_SELF_HEAL_PREVIEW_PROFILE: SELF_HEAL_PREVIEW_PROFILE,
    ARCANOS_SELF_HEAL_PREVIEW_RUN_ID: profile.proofTarget.runId,
    ARCANOS_SELF_HEAL_PREVIEW_ISSUED_AT: profile.issuedAt,
    ARCANOS_SELF_HEAL_PREVIEW_EXPIRES_AT: profile.expiresAt,
    ARCANOS_SELF_HEAL_PREVIEW_CONTROL_TOKEN: profile.controlToken,
    NODE_ENV: 'production', TZ: 'UTC',
  };
}

/** Fixture-owned receipt and held advisory lock fence resume to this synthetic run. */
export async function preflightSelfHealPreviewDatabase(profile, options = {}) {
  if (!/^[0-9a-f]{64}$/u.test(profile.ownership.compiledSha256 ?? '')) fail('ARTIFACT_INVALID');
  let Client = options.Client;
  if (!Client) {
    const pg = await import('pg');
    Client = pg.Client ?? pg.default?.Client;
  }
  const client = new Client({ ...buildSelfHealPreviewDatabaseClientOptions(profile),
    application_name: 'arcanos_self_heal_preview_owner_v1', connectionTimeoutMillis: 5000,
    query_timeout: 5000, options: '-c statement_timeout=5000 -c lock_timeout=1000' });
  let transaction = false;
  let closed = false;
  const roleLock = profile.proofTarget.processKind === 'worker' ? 1 : 2;
  let rejectLost;
  const lost = new Promise((_, reject) => { rejectLost = reject; });
  void lost.catch(() => undefined);
  const onError = () => { if (!closed) rejectLost(proofError('OWNERSHIP_LOST')); };
  client.on?.('error', onError);
  client.on?.('end', onError);
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await client.end(); }
    finally {
      client.removeListener?.('error', onError);
      client.removeListener?.('end', onError);
    }
  };
  try {
    await client.connect();
    const lock = await client.query('SELECT pg_try_advisory_lock(1544, $1::integer) AS acquired', [roleLock]);
    if (lock.rows?.[0]?.acquired !== true) fail('OWNER_ALREADY_ACTIVE');
    await client.query('BEGIN'); transaction = true;
    await client.query('SELECT pg_advisory_xact_lock(1544, 3)');
    await client.query('SET LOCAL search_path = pg_catalog, public');
    const relations = await client.query(`SELECT to_regclass('${RECEIPT_TABLE}') IS NOT NULL AS receipt_exists,
      to_regclass('public.job_data') IS NOT NULL AS job_data_exists,
      to_regclass('public.job_events') IS NOT NULL AS job_events_exists`);
    const row = relations.rows?.[0];
    let mode;
    if (row?.receipt_exists !== true) {
      if (profile.proofTarget.processKind !== 'worker') fail('RECEIPT_MISSING');
      const tables = await client.query(`SELECT COUNT(*)::integer AS user_table_count FROM pg_catalog.pg_tables
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        AND schemaname NOT LIKE 'pg_toast_temp_%' AND schemaname NOT LIKE 'pg_temp_%'`);
      if (tables.rows?.[0]?.user_table_count !== 0) fail('DATABASE_NOT_FRESH');
      await client.query(`CREATE TABLE ${RECEIPT_TABLE} (singleton BOOLEAN PRIMARY KEY CHECK (singleton), identity TEXT NOT NULL)`);
      await client.query(`INSERT INTO ${RECEIPT_TABLE} (singleton, identity) VALUES (TRUE, $1)`, [JSON.stringify(profile.ownership)]);
      mode = 'fresh-owned-receipt';
    } else {
      const receipt = await client.query(`SELECT identity FROM ${RECEIPT_TABLE} WHERE singleton = TRUE`);
      if (receipt.rows?.length !== 1 || receipt.rows[0].identity !== JSON.stringify(profile.ownership)) fail('RECEIPT_MISMATCH');
      if (row.job_data_exists !== true || row.job_events_exists !== true) fail('DATABASE_SCHEMA_MISSING');
      const jobs = await client.query(`SELECT COUNT(*) FILTER (WHERE correlation_id IS NULL
          OR left(correlation_id, length($1)) <> $1
          OR (last_worker_id IS NOT NULL AND last_worker_id <> ALL($2::text[])))::integer AS foreign_jobs,
        COUNT(*) FILTER (WHERE status = 'running' AND lease_expires_at > NOW())::integer AS active_leases
        FROM public.job_data`, [`self-heal-preview:${profile.proofTarget.runId}:`, resolveSelfHealPreviewWorkerIds(profile)]);
      if (jobs.rows?.[0]?.foreign_jobs !== 0 || jobs.rows?.[0]?.active_leases !== 0) fail('FOREIGN_OR_ACTIVE_JOBS');
      const events = await client.query('SELECT COUNT(*)::integer AS orphan_events FROM public.job_events e WHERE NOT EXISTS (SELECT 1 FROM public.job_data j WHERE j.id = e.job_id)');
      if (events.rows?.[0]?.orphan_events !== 0) fail('FOREIGN_EVENTS');
      mode = 'receipt-bound-resume';
    }
    await client.query('COMMIT'); transaction = false;
    return { mode, close, lost };
  } catch (error) {
    if (transaction) await client.query('ROLLBACK').catch(() => undefined);
    await close().catch(() => undefined);
    if (error instanceof SelfHealPreviewError) throw error;
    fail('DATABASE_PREFLIGHT_FAILED');
  }
}

function exitPromise(child) {
  return new Promise((resolve, reject) => {
    child.once('error', () => reject(proofError('CHILD_START_FAILED')));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}
async function waitWithin(pending, ms) {
  let timer;
  try { return await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); timer.unref?.(); })]); }
  finally { clearTimeout(timer); }
}
async function stopChild(runtime, graceMs) {
  if (!runtime) return false;
  if (runtime.child.exitCode === null && runtime.child.signalCode === null) runtime.child.kill('SIGTERM');
  if (await waitWithin(runtime.exit, graceMs) !== null) return false;
  runtime.child.kill('SIGKILL');
  if (await waitWithin(runtime.exit, 2000) === null) fail('CHILD_TEARDOWN_TIMEOUT');
  return true;
}
async function fixtureReady(runtime, sentinel) {
  if (!runtime.child.stdout) fail('FIXTURE_STDOUT_REQUIRED');
  let buffer = '';
  let onData;
  const ready = new Promise((resolve, reject) => {
    onData = chunk => {
      buffer += String(chunk);
      if (buffer.length > sentinel.length + 2) reject(proofError('FIXTURE_HANDSHAKE_INVALID'));
      else if (buffer.includes('\n')) {
        if (buffer.replace(/\r?\n$/u, '') === sentinel) resolve(true);
        else reject(proofError('FIXTURE_HANDSHAKE_INVALID'));
      }
    };
    runtime.child.stdout.on('data', onData);
  });
  try {
    const outcome = await waitWithin(Promise.race([ready, runtime.exit.then(() => fail('FIXTURE_EXITED_BEFORE_READY'))]), 5000);
    if (outcome === null) fail('FIXTURE_HANDSHAKE_TIMEOUT');
  } finally { runtime.child.stdout.removeListener('data', onData); }
}

/** Retain the canonical integrity-wrapper/launcher/Worker chain under a finite lease. */
export async function runSelfHealPreviewSupervisor(processKind, env, options = {}) {
  const unboundProfile = resolveSelfHealPreviewProfile(processKind, env, options);
  const verifyArtifact = options.verifyArtifact ?? (await import('./self-heal-preview-artifact.mjs')).verifySelfHealPreviewArtifact;
  const artifact = await verifyArtifact({ sourceSha: unboundProfile.proofTarget.sourceCommit, rootPath: ROOT });
  const profile = bindSelfHealPreviewArtifact(unboundProfile, artifact);
  const verifyCertificate = options.verifyDatabaseCertificateFile ?? verifySelfHealPreviewDatabaseCertificateFile;
  const certificateSha256 = await verifyCertificate(profile, options);
  if (certificateSha256 !== profile.ownership.databaseCertificateSha256) fail('DATABASE_CERTIFICATE_FILE_INVALID');
  if (profile.expiresAtMs <= (options.now?.() ?? Date.now())) fail('LEASE_INVALID');
  const spawnImpl = options.spawnImpl ?? spawn;
  const processRef = options.processRef ?? process;
  let application;
  let fixture;
  let guard;
  let stopped = false;
  let stopReason = 'runtime_exit';
  let stopResolve;
  const stopRequested = new Promise(resolve => { stopResolve = resolve; });
  const requestStop = reason => { stopped = true; stopReason = reason; stopResolve(reason); };
  const onTerm = () => requestStop('SIGTERM');
  const onInt = () => requestStop('SIGINT');
  processRef.once('SIGTERM', onTerm); processRef.once('SIGINT', onInt);
  const expiry = setTimeout(() => requestStop('expired'), Math.max(1, profile.expiresAtMs - (options.now?.() ?? Date.now())));
  expiry.unref?.();
  try {
    guard = await preflightSelfHealPreviewDatabase(profile, options);
    if (stopped || profile.expiresAtMs <= (options.now?.() ?? Date.now())) return 0;
    {
      const fixtureModule = await import('./railway-backstage-heavy-openai-fixture.mjs');
      const child = spawnImpl(process.execPath, ['scripts/railway-backstage-heavy-openai-fixture.mjs', fixtureModule.SELF_HEAL_PREVIEW_OPENAI_FIXTURE_CHILD_ARGUMENT],
        { cwd: ROOT, env: buildSelfHealPreviewFixtureEnvironment(profile), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      fixture = { child, exit: exitPromise(child) }; void fixture.exit.catch(() => undefined);
      child.stderr?.resume();
      await fixtureReady(fixture, fixtureModule.SELF_HEAL_PREVIEW_OPENAI_FIXTURE_READY_SENTINEL);
      child.stdout?.resume();
    }
    if (stopped || profile.expiresAtMs <= (options.now?.() ?? Date.now())) return 0;
    const child = spawnImpl(process.execPath, ['scripts/start-railway-service-with-integrity.mjs'],
      { cwd: ROOT, env: buildSelfHealPreviewApplicationEnvironment(profile, env), stdio: 'inherit', windowsHide: true });
    application = { child, exit: exitPromise(child) }; void application.exit.catch(() => undefined);
    console.log('self_heal.preview.application.start', JSON.stringify({ profile: SELF_HEAL_PREVIEW_PROFILE,
      role: processKind, runId: profile.proofTarget.runId, sourceSha: profile.proofTarget.sourceCommit, expiresAt: profile.expiresAt, preflight: guard.mode }));
    const first = await Promise.race([stopRequested.then(() => ({ source: 'stop' })), guard.lost,
      application.exit.then(outcome => ({ source: 'application', outcome })),
      ...(fixture ? [fixture.exit.then(() => ({ source: 'fixture' }))] : [])]);
    return first.source === 'stop' ? 0 : 1;
  } finally {
    clearTimeout(expiry);
    processRef.removeListener('SIGTERM', onTerm); processRef.removeListener('SIGINT', onInt);
    const failures = [];
    // The provider remains available until the real Worker has drained its operations.
    try { if (await stopChild(application, 60_000)) failures.push(proofError('CHILD_DRAIN_TIMEOUT')); } catch (error) { failures.push(error); }
    try { if (await stopChild(fixture, 2000)) failures.push(proofError('CHILD_DRAIN_TIMEOUT')); } catch (error) { failures.push(error); }
    try { await guard?.close(); } catch (error) { failures.push(error); }
    console.log('self_heal.preview.shutdown', JSON.stringify({ role: processKind,
      runId: profile.proofTarget.runId, reason: stopReason, drained: failures.length === 0 }));
    if (failures.length) fail('TEARDOWN_FAILED');
  }
}
