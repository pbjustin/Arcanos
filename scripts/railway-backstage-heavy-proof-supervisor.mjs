#!/usr/bin/env node
/**
 * One-shot, non-production Railway supervisor for the Backstage durable proof.
 *
 * The supervisor fails closed before application startup, performs only the
 * role-ordered read-only database preflight, and then launches the unchanged
 * integrity wrapper. Both application children receive the fictional OpenAI
 * SDK key; only the worker receives the live loopback fixture and deterministic
 * job-runner controls, while the web child remains pinned to a dead loopback.
 */

import { spawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_BASE_URL,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_CHILD_ARGUMENT,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_CHILD_ENV,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_CHILD_VALUE,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_MARKER,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_READY_SENTINEL,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_RUN_ID_ENV,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_SDK_KEY,
} from './railway-backstage-heavy-openai-fixture.mjs';

export const BACKSTAGE_HEAVY_PROOF_TARGET_ENV =
  'ARCANOS_BACKSTAGE_HEAVY_PROOF_TARGET';
export const BACKSTAGE_HEAVY_PROOF_TARGET =
  'dedicated-backstage-heavy-preview-v1';
export const BACKSTAGE_HEAVY_PROOF_RUN_ID_ENV =
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_RUN_ID_ENV;
export const BACKSTAGE_HEAVY_PROOF_SOURCE_SHA_ENV =
  'ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA';
export const BACKSTAGE_HEAVY_PROOF_START_COMMAND =
  'node scripts/railway-backstage-heavy-proof-supervisor.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));
const INTEGRITY_WRAPPER_SCRIPT =
  'scripts/start-railway-service-with-integrity.mjs';
const FIXTURE_SCRIPT = 'scripts/railway-backstage-heavy-openai-fixture.mjs';
const FIXTURE_MARKER_ENV = 'ARCANOS_PREVIEW_OPENAI_FIXTURE';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,63}$/u;
const ENVIRONMENT_PATTERN =
  /^backstage-heavy-pr-([1-9]\d*)-e2e(?:-[a-z0-9]{1,16})?$/u;
const PROJECT_NAME_PATTERN =
  /^arc-pr([1-9]\d*)-heavy-[a-z0-9][a-z0-9-]{0,13}$/u;
const STOP_TIMEOUT_MS = 2_000;
const KILL_TIMEOUT_MS = 2_000;
const START_TIMEOUT_MS = 5_000;
const CANONICAL_IDS = new Set([
  '7faf44e5-519c-4e73-8d7a-da9f389e6187',
  'fb583147-6c39-4343-9267-500f357d25ab',
  '1765befb-b805-4051-9af9-28634e986886',
  'c4ade025-3f13-4fca-9309-5d0dd81396fe',
  '6647b5b1-d796-4783-b5f0-b8e356019ca6',
  '81e4a1cf-7ae4-48bf-8321-23641bb23c0e',
]);
const FORBIDDEN_ENV_NAMES = new Set([
  'ALL_PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_USE_ENV_PROXY',
  'DATABASE_PRIVATE_URL',
  'DATABASE_PUBLIC_URL',
  'PGDATA',
  'PGDATABASE',
  'PGHOST',
  'PGPASSWORD',
  'PGPORT',
  'PGSSLMODE',
  'PGUSER',
  'POSTGRES_PASSWORD',
  'POSTGRES_USER',
  'POSTGRES_URL',
  'POSTGRESQL_URL',
  'REDISHOST',
  'REDIS_HOST',
  'REDISPORT',
  'REDIS_PORT',
  'REDISUSER',
  'REDIS_USER',
  'REDISPASSWORD',
  'REDIS_PASSWORD',
  'ARCANOS_BACKSTAGE_NOTION_ACCESS_TOKEN',
  'ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_JSON',
  'ARCANOS_BACKSTAGE_NOTION_AUTHORITY_ROOTS_JSON',
]);
const PROVIDER_KEY_NAMES = new Set([
  'OPENAI_API_KEY',
  'RAILWAY_OPENAI_API_KEY',
  'API_KEY',
  'OPENAI_KEY',
]);
const PROVIDER_BASE_NAMES = new Set([
  'OPENAI_BASE_URL',
  'RAILWAY_OPENAI_BASE_URL',
  'OPENAI_API_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_BASEURL',
]);

const KNOWN_PROOF_ERRORS = new Set([
  'BACKSTAGE_HEAVY_PROOF_ARGUMENT_INVALID',
  'BACKSTAGE_HEAVY_PROOF_CHILD_START_FAILED',
  'BACKSTAGE_HEAVY_PROOF_CHILD_TEARDOWN_FAILED',
  'BACKSTAGE_HEAVY_PROOF_CHILD_TEARDOWN_TIMEOUT',
  'BACKSTAGE_HEAVY_PROOF_DATA_IDENTITY_INVALID',
  'BACKSTAGE_HEAVY_PROOF_DATA_URL_INVALID',
  'BACKSTAGE_HEAVY_PROOF_DATABASE_CLIENT_UNAVAILABLE',
  'BACKSTAGE_HEAVY_PROOF_DATABASE_NOT_EMPTY',
  'BACKSTAGE_HEAVY_PROOF_DATABASE_NOT_FRESH',
  'BACKSTAGE_HEAVY_PROOF_DATABASE_NOT_READ_ONLY',
  'BACKSTAGE_HEAVY_PROOF_DATABASE_PREFLIGHT_FAILED',
  'BACKSTAGE_HEAVY_PROOF_DATABASE_SCHEMA_MISSING',
  'BACKSTAGE_HEAVY_PROOF_ENV_FORBIDDEN',
  'BACKSTAGE_HEAVY_PROOF_FIXTURE_EXITED_BEFORE_READY',
  'BACKSTAGE_HEAVY_PROOF_FIXTURE_HANDSHAKE_FAILED',
  'BACKSTAGE_HEAVY_PROOF_FIXTURE_HANDSHAKE_INVALID',
  'BACKSTAGE_HEAVY_PROOF_FIXTURE_HANDSHAKE_TIMEOUT',
  'BACKSTAGE_HEAVY_PROOF_FIXTURE_START_FAILED',
  'BACKSTAGE_HEAVY_PROOF_FIXTURE_STDOUT_REQUIRED',
  'BACKSTAGE_HEAVY_PROOF_ISOLATION_REQUIRED',
  'BACKSTAGE_HEAVY_PROOF_PROVIDER_ENV_INVALID',
  'BACKSTAGE_HEAVY_PROOF_PURPOSE_CREDENTIAL_INVALID',
  'BACKSTAGE_HEAVY_PROOF_SERVICE_IDENTITY_INVALID',
  'BACKSTAGE_HEAVY_PROOF_SUPERVISOR_FAILED',
  'BACKSTAGE_HEAVY_PROOF_TARGET_ID_INVALID',
  'BACKSTAGE_HEAVY_PROOF_TARGET_INVALID',
]);

class BackstageHeavyProofError extends Error {}

function proofError(code) {
  return KNOWN_PROOF_ERRORS.has(code)
    ? new BackstageHeavyProofError(code)
    : new Error('BACKSTAGE_HEAVY_PROOF_FAILED');
}

function fail(code) {
  throw proofError(code);
}

function isKnownProofError(error) {
  return error instanceof BackstageHeavyProofError
    && KNOWN_PROOF_ERRORS.has(error.message);
}

function validateUuid(rawValue) {
  const value = rawValue?.trim().toLowerCase() || '';
  if (!UUID_PATTERN.test(value) || CANONICAL_IDS.has(value)) {
    fail('BACKSTAGE_HEAVY_PROOF_TARGET_ID_INVALID');
  }
  return value;
}

function validateInternalServiceUrl(rawValue, options) {
  let parsed;
  try {
    parsed = new URL(rawValue);
  } catch {
    fail('BACKSTAGE_HEAVY_PROOF_DATA_URL_INVALID');
  }
  if (
    !options.protocols.has(parsed.protocol)
    || parsed.hostname.toLowerCase() !== options.hostname
    || parsed.port !== options.port
    || !parsed.username
    || !parsed.password
    || (
      options.requireDatabasePath
        ? parsed.pathname.length <= 1
        : (
            parsed.pathname === ''
              ? options.allowEmptyPath !== true
              : !/^\/(?:[0-9]+)?$/u.test(parsed.pathname)
          )
    )
    || parsed.search
    || parsed.hash
  ) {
    fail('BACKSTAGE_HEAVY_PROOF_DATA_URL_INVALID');
  }
  return rawValue;
}

function hasOwn(env, name) {
  return Object.prototype.hasOwnProperty.call(env, name);
}

/** Resolve one exact disposable proof target without exposing any values. */
export function resolveBackstageHeavyProofTargetOrThrow(
  processKind,
  env = process.env
) {
  if (env[BACKSTAGE_HEAVY_PROOF_TARGET_ENV] !== BACKSTAGE_HEAVY_PROOF_TARGET) {
    fail('BACKSTAGE_HEAVY_PROOF_TARGET_INVALID');
  }
  if (
    (processKind !== 'web' && processKind !== 'worker')
    || env.ARCANOS_PROCESS_KIND !== processKind
    || env.NODE_ENV !== 'production'
    || env.ARCANOS_PREVIEW_ISOLATION !== 'true'
    || env.FORCE_MOCK !== 'true'
    || env.ALLOW_MOCK_OPENAI !== 'true'
    || env.OPENAI_API_KEY_REQUIRED !== 'false'
  ) {
    fail('BACKSTAGE_HEAVY_PROOF_ISOLATION_REQUIRED');
  }

  const environmentName = env.RAILWAY_ENVIRONMENT_NAME?.trim().toLowerCase() || '';
  const environmentMatch = ENVIRONMENT_PATTERN.exec(environmentName);
  const projectName = env.RAILWAY_PROJECT_NAME?.trim() || '';
  const projectMatch = PROJECT_NAME_PATTERN.exec(projectName);
  const prNumber = environmentMatch?.[1] || '';
  if (
    !environmentMatch
    || !projectMatch
    || projectMatch[1] !== prNumber
    || projectName.length > 32
    || env.RAILWAY_SERVICE_NAME !== `arcanos-${processKind}-pr${prNumber}-heavy`
  ) {
    fail('BACKSTAGE_HEAVY_PROOF_SERVICE_IDENTITY_INVALID');
  }

  const projectId = validateUuid(env.RAILWAY_PROJECT_ID);
  const environmentId = validateUuid(env.RAILWAY_ENVIRONMENT_ID);
  const serviceId = validateUuid(env.RAILWAY_SERVICE_ID);
  const deploymentId = validateUuid(env.RAILWAY_DEPLOYMENT_ID);
  const postgresServiceId = validateUuid(
    env.ARCANOS_BACKSTAGE_HEAVY_POSTGRES_SERVICE_ID
  );
  const redisServiceId = validateUuid(
    env.ARCANOS_BACKSTAGE_HEAVY_REDIS_SERVICE_ID
  );
  const sourceCommit = env[BACKSTAGE_HEAVY_PROOF_SOURCE_SHA_ENV];
  const railwayGitCommitPresent = hasOwn(env, 'RAILWAY_GIT_COMMIT_SHA');
  const railwayGitCommit = env.RAILWAY_GIT_COMMIT_SHA;
  const runId = env[BACKSTAGE_HEAVY_PROOF_RUN_ID_ENV]?.trim().toLowerCase() || '';
  if (
    typeof sourceCommit !== 'string'
    || !SHA_PATTERN.test(sourceCommit)
    || (
      railwayGitCommitPresent
      && (
        typeof railwayGitCommit !== 'string'
        || !SHA_PATTERN.test(railwayGitCommit)
        || railwayGitCommit !== sourceCommit
      )
    )
    || !RUN_ID_PATTERN.test(runId)
    || new Set([serviceId, postgresServiceId, redisServiceId]).size !== 3
  ) {
    fail('BACKSTAGE_HEAVY_PROOF_TARGET_ID_INVALID');
  }
  if (
    env.ARCANOS_BACKSTAGE_HEAVY_POSTGRES_SERVICE_NAME !== 'Postgres'
    || env.ARCANOS_BACKSTAGE_HEAVY_REDIS_SERVICE_NAME !== 'Redis'
    || env.ARCANOS_BACKSTAGE_HEAVY_POSTGRES_INTERNAL_HOST
      !== 'postgres.railway.internal'
    || env.ARCANOS_BACKSTAGE_HEAVY_REDIS_INTERNAL_HOST
      !== 'redis.railway.internal'
  ) {
    fail('BACKSTAGE_HEAVY_PROOF_DATA_IDENTITY_INVALID');
  }

  const databaseUrl = validateInternalServiceUrl(env.DATABASE_URL, {
    hostname: 'postgres.railway.internal',
    port: '5432',
    protocols: new Set(['postgres:', 'postgresql:']),
    requireDatabasePath: true,
  });
  validateInternalServiceUrl(env.REDIS_URL, {
    hostname: 'redis.railway.internal',
    port: '6379',
    protocols: new Set(['redis:']),
    requireDatabasePath: false,
    allowEmptyPath: true,
  });

  for (const [name, value] of Object.entries(env)) {
    const upperName = name.toUpperCase();
    if (
      FORBIDDEN_ENV_NAMES.has(upperName)
      || PROVIDER_KEY_NAMES.has(upperName)
      || (
        /(?:OPENAI|API)_KEY$/iu.test(name)
        && typeof value === 'string'
        && value.length > 0
      )
      || (PROVIDER_BASE_NAMES.has(upperName) && upperName !== 'OPENAI_BASE_URL')
    ) {
      fail('BACKSTAGE_HEAVY_PROOF_ENV_FORBIDDEN');
    }
  }
  const expectedBaseUrl = processKind === 'worker'
    ? BACKSTAGE_HEAVY_OPENAI_FIXTURE_BASE_URL
    : 'http://127.0.0.1:9/v1';
  if (
    env.OPENAI_BASE_URL !== expectedBaseUrl
    || (
      processKind === 'worker'
      && env[FIXTURE_MARKER_ENV] !== BACKSTAGE_HEAVY_OPENAI_FIXTURE_MARKER
    )
    || (processKind === 'web' && hasOwn(env, FIXTURE_MARKER_ENV))
  ) {
    fail('BACKSTAGE_HEAVY_PROOF_PROVIDER_ENV_INVALID');
  }

  const payloadKey = env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY;
  const accessToken = env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN;
  const jobReadSecret = env.ARCANOS_JOB_READ_CAPABILITY_SECRET;
  if (
    typeof payloadKey !== 'string'
    || !/^[A-Za-z0-9+/]{43}=$/u.test(payloadKey)
    || hasOwn(env, 'ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_PREVIOUS_KEY')
    || hasOwn(env, 'ARCANOS_JOB_READ_CAPABILITY_PREVIOUS_SECRET')
    || (
      processKind === 'web'
      && (
        env.ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED !== 'true'
        || typeof accessToken !== 'string'
        || accessToken.length < 32
        || accessToken.length > 4_096
        || !/^[\x21-\x7e]+$/u.test(accessToken)
        || typeof jobReadSecret !== 'string'
        || jobReadSecret.length < 32
        || jobReadSecret.length > 4_096
        || !/^[\x21-\x7e]+$/u.test(jobReadSecret)
        || jobReadSecret === accessToken
        || jobReadSecret === payloadKey
        || accessToken === payloadKey
      )
    )
    || (
      processKind === 'worker'
      && (
        hasOwn(env, 'ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED')
        || hasOwn(env, 'ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN')
        || hasOwn(env, 'ARCANOS_JOB_READ_CAPABILITY_SECRET')
      )
    )
  ) {
    fail('BACKSTAGE_HEAVY_PROOF_PURPOSE_CREDENTIAL_INVALID');
  }

  return {
    enabled: true,
    processKind,
    projectId,
    projectName,
    environmentId,
    environmentName,
    serviceId,
    deploymentId,
    sourceCommit,
    runId,
    postgresServiceId,
    postgresInternalHost: 'postgres.railway.internal',
    redisServiceId,
    redisInternalHost: 'redis.railway.internal',
    databaseUrl,
  };
}

/** Read-only one-shot role gate; this never initializes or migrates schema. */
export async function preflightBackstageHeavyProofDatabase(
  proofTarget,
  options = {}
) {
  let Client = options.Client;
  if (!Client) {
    const pgModule = await import('pg');
    Client = pgModule.Client ?? pgModule.default?.Client;
  }
  if (typeof Client !== 'function') {
    fail('BACKSTAGE_HEAVY_PROOF_DATABASE_CLIENT_UNAVAILABLE');
  }
  const client = new Client({
    application_name: 'arcanos_backstage_heavy_preflight_v1',
    connectionString: proofTarget.databaseUrl,
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
    options:
      '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000',
  });
  let transactionStarted = false;
  try {
    await client.connect();
    await client.query(
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'
    );
    transactionStarted = true;
    await client.query('SET LOCAL search_path = pg_catalog, public');
    const readOnly = await client.query('SHOW transaction_read_only');
    if (readOnly.rows?.[0]?.transaction_read_only !== 'on') {
      fail('BACKSTAGE_HEAVY_PROOF_DATABASE_NOT_READ_ONLY');
    }
    const relationResult = await client.query(
      `SELECT
         to_regclass('public.job_data') IS NOT NULL AS job_data_exists,
         to_regclass('public.job_events') IS NOT NULL AS job_events_exists`
    );
    const relations = relationResult.rows?.[0];
    if (proofTarget.processKind === 'worker') {
      if (relations?.job_data_exists || relations?.job_events_exists) {
        fail('BACKSTAGE_HEAVY_PROOF_DATABASE_NOT_FRESH');
      }
    } else {
      if (!relations?.job_data_exists || !relations?.job_events_exists) {
        fail('BACKSTAGE_HEAVY_PROOF_DATABASE_SCHEMA_MISSING');
      }
      const countResult = await client.query(
        `SELECT
           (SELECT COUNT(*)::integer FROM public.job_data) AS job_count,
           (SELECT COUNT(*)::integer FROM public.job_events) AS event_count`
      );
      if (
        countResult.rows?.[0]?.job_count !== 0
        || countResult.rows?.[0]?.event_count !== 0
      ) {
        fail('BACKSTAGE_HEAVY_PROOF_DATABASE_NOT_EMPTY');
      }
    }
    await client.query('ROLLBACK');
    transactionStarted = false;
    return {
      enabled: true,
      mode: proofTarget.processKind === 'worker'
        ? 'absent-job-tables'
        : 'empty-worker-created-job-tables',
    };
  } catch (error) {
    if (isKnownProofError(error)) {
      throw error;
    }
    fail('BACKSTAGE_HEAVY_PROOF_DATABASE_PREFLIGHT_FAILED');
  } finally {
    if (transactionStarted) {
      await client.query('ROLLBACK').catch(() => undefined);
    }
    await client.end().catch(() => undefined);
  }
}

export function buildBackstageHeavyFixtureChildEnvironment(proofTarget) {
  return {
    [BACKSTAGE_HEAVY_OPENAI_FIXTURE_CHILD_ENV]:
      BACKSTAGE_HEAVY_OPENAI_FIXTURE_CHILD_VALUE,
    [BACKSTAGE_HEAVY_PROOF_RUN_ID_ENV]: proofTarget.runId,
    NODE_ENV: 'production',
    TZ: 'UTC',
  };
}

export function buildBackstageHeavyApplicationChildEnvironment(
  proofTarget,
  env = process.env
) {
  return {
    ...env,
    // The disposable Railway Postgres template uses a self-signed TLS chain.
    // The parent preflight has already rejected query parameters and bound the
    // URL to the exact private host, port, database, and credentials before
    // this proof-child-only transport override is derived.
    DATABASE_URL: `${proofTarget.databaseUrl}?sslmode=no-verify`,
    // Readiness requires an initialized adapter. This fixed nonsecret value is
    // derived only after the parent has rejected ambient provider credentials;
    // the web child retains its validated dead-loopback provider base.
    OPENAI_API_KEY: BACKSTAGE_HEAVY_OPENAI_FIXTURE_SDK_KEY,
    OPENAI_MAX_RETRIES: '0',
    ...(proofTarget.processKind === 'worker'
      ? {
          GPT5_MODEL: 'gpt-5.1',
          GPT51_MODEL: 'gpt-5.1',
          OPENAI_MODEL: 'gpt-5.1',
          RAILWAY_OPENAI_MODEL: 'gpt-5.1',
          BOOKER_REPAIR_STAGE_TIMEOUT_MS: '45000',
          BOOKER_TOKEN_LIMIT: '2400',
          BOOKER_WORKER_GENERATION_STAGE_TIMEOUT_MS: '80000',
          BOOKER_WORKER_JOB_TIMEOUT_MS: '180000',
          BOOKER_WORKER_TOKEN_LIMIT: '6000',
          JOB_EVENT_RECORD_HEARTBEATS: 'true',
          JOB_WORKER_CONCURRENCY: '1',
          JOB_WORKER_HEARTBEAT_MS: '5000',
          JOB_WORKER_LEASE_MS: '15000',
          JOB_WORKER_ID: 'backstage-heavy-proof-worker-v1',
          JOB_WORKER_STATS_ID: 'backstage-heavy-proof-worker-v1',
        }
      : {}),
  };
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    child.once('error', () => finish(
      reject,
      proofError('BACKSTAGE_HEAVY_PROOF_CHILD_START_FAILED')
    ));
    child.once('close', (code, signal) => finish(resolve, { code, signal }));
  });
}

function waitForFixtureReady(child, timeoutMs = START_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (!child.stdout) {
      reject(proofError('BACKSTAGE_HEAVY_PROOF_FIXTURE_STDOUT_REQUIRED'));
      return;
    }
    let buffer = '';
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.removeListener('data', onData);
      child.stdout.removeListener('error', onError);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onError = () => finish(
      reject,
      proofError('BACKSTAGE_HEAVY_PROOF_FIXTURE_HANDSHAKE_FAILED')
    );
    const onData = chunk => {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (buffer.length > BACKSTAGE_HEAVY_OPENAI_FIXTURE_READY_SENTINEL.length + 2) {
        finish(
          reject,
          proofError('BACKSTAGE_HEAVY_PROOF_FIXTURE_HANDSHAKE_INVALID')
        );
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline).replace(/\r$/u, '');
      if (line !== BACKSTAGE_HEAVY_OPENAI_FIXTURE_READY_SENTINEL) {
        finish(
          reject,
          proofError('BACKSTAGE_HEAVY_PROOF_FIXTURE_HANDSHAKE_INVALID')
        );
        return;
      }
      finish(resolve, true);
    };
    const timeout = setTimeout(() => finish(
      reject,
      proofError('BACKSTAGE_HEAVY_PROOF_FIXTURE_HANDSHAKE_TIMEOUT')
    ), timeoutMs);
    timeout.unref?.();
    child.stdout.on('data', onData);
    child.stdout.once('error', onError);
  });
}

async function waitWithin(exitPromise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => resolve(null), timeoutMs);
    timeout.unref?.();
    exitPromise.then(value => {
      clearTimeout(timeout);
      resolve(value);
    }).catch(error => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function terminateChild(child, exitPromise, signal = 'SIGTERM') {
  if (!child || !exitPromise) return null;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill(signal);
  }
  const graceful = await waitWithin(exitPromise, STOP_TIMEOUT_MS);
  if (graceful !== null) return graceful;
  child.kill('SIGKILL');
  const forced = await waitWithin(exitPromise, KILL_TIMEOUT_MS);
  if (forced === null) {
    fail('BACKSTAGE_HEAVY_PROOF_CHILD_TEARDOWN_TIMEOUT');
  }
  return forced;
}

async function startFixture(proofTarget, spawnImpl, onStarted) {
  const child = spawnImpl(
    process.execPath,
    [FIXTURE_SCRIPT, BACKSTAGE_HEAVY_OPENAI_FIXTURE_CHILD_ARGUMENT],
    {
      cwd: REPOSITORY_ROOT,
      env: buildBackstageHeavyFixtureChildEnvironment(proofTarget),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }
  );
  child.stderr?.resume();
  const exitPromise = waitForExit(child);
  void exitPromise.catch(() => undefined);
  const runtime = { child, exitPromise };
  onStarted(runtime);
  try {
    await Promise.race([
      waitForFixtureReady(child),
      exitPromise.then(() => fail(
        'BACKSTAGE_HEAVY_PROOF_FIXTURE_EXITED_BEFORE_READY'
      )),
    ]);
  } catch {
    await terminateChild(child, exitPromise).catch(() => undefined);
    fail('BACKSTAGE_HEAVY_PROOF_FIXTURE_START_FAILED');
  }
  child.stdout?.resume();
  return runtime;
}

/** Start the unchanged protected wrapper after every proof-only gate succeeds. */
export async function runBackstageHeavyProofSupervisor(
  processKind,
  env = process.env,
  options = {}
) {
  const proofTarget = resolveBackstageHeavyProofTargetOrThrow(processKind, env);
  const spawnImpl = options.spawnImpl ?? spawn;
  const processRef = options.processRef ?? process;
  let fixtureRuntime = null;
  let applicationChild = null;
  let applicationExit = null;
  let shutdownRequested = false;
  const signalHandlers = new Map();
  try {
    for (const signal of ['SIGTERM', 'SIGINT']) {
      const handler = () => {
        shutdownRequested = true;
        applicationChild?.kill(signal);
        fixtureRuntime?.child.kill(signal);
      };
      signalHandlers.set(signal, handler);
      processRef.once(signal, handler);
    }
    const preflight = await preflightBackstageHeavyProofDatabase(
      proofTarget,
      options
    );
    console.log('[backstage-heavy-proof] backstage.proof.preflight.ready', JSON.stringify({
      mode: preflight.mode,
      role: processKind,
    }));
    if (shutdownRequested) {
      return 0;
    }
    if (processKind === 'worker') {
      fixtureRuntime = await startFixture(
        proofTarget,
        spawnImpl,
        runtime => {
          fixtureRuntime = runtime;
          if (shutdownRequested) {
            runtime.child.kill('SIGTERM');
          }
        }
      );
      console.log('[backstage-heavy-proof] backstage.fixture.ready', JSON.stringify({
        fixture: BACKSTAGE_HEAVY_OPENAI_FIXTURE_MARKER,
        role: processKind,
      }));
    }
    if (shutdownRequested) {
      return 0;
    }
    console.log('[backstage-heavy-proof] backstage.proof.application.start', JSON.stringify({
      role: processKind,
      wrapper: INTEGRITY_WRAPPER_SCRIPT,
    }));
    applicationChild = spawnImpl(
      process.execPath,
      [INTEGRITY_WRAPPER_SCRIPT],
      {
        cwd: REPOSITORY_ROOT,
        env: buildBackstageHeavyApplicationChildEnvironment(proofTarget, env),
        stdio: 'inherit',
        windowsHide: true,
      }
    );
    applicationExit = waitForExit(applicationChild);
    void applicationExit.catch(() => undefined);
    const first = await Promise.race([
      applicationExit.then(outcome => ({ source: 'application', outcome })),
      ...(fixtureRuntime
        ? [fixtureRuntime.exitPromise.then(outcome => ({
            source: 'fixture',
            outcome,
          }))]
        : []),
    ]);
    if (first.source === 'fixture') {
      await terminateChild(applicationChild, applicationExit).catch(
        () => undefined
      );
      return shutdownRequested ? 0 : 1;
    }
    if (typeof first.outcome.code !== 'number') {
      return shutdownRequested ? 0 : 1;
    }
    return !shutdownRequested && first.outcome.code === 0
      ? 1
      : first.outcome.code;
  } catch (error) {
    if (shutdownRequested) {
      return 0;
    }
    if (isKnownProofError(error)) {
      throw error;
    }
    fail('BACKSTAGE_HEAVY_PROOF_SUPERVISOR_FAILED');
  } finally {
    for (const [signal, handler] of signalHandlers) {
      processRef.removeListener(signal, handler);
    }
    let teardownFailed = false;
    try {
      await terminateChild(applicationChild, applicationExit);
    } catch {
      teardownFailed = true;
    }
    try {
      await terminateChild(
        fixtureRuntime?.child,
        fixtureRuntime?.exitPromise
      );
    } catch {
      teardownFailed = true;
    }
    if (teardownFailed) {
      fail('BACKSTAGE_HEAVY_PROOF_CHILD_TEARDOWN_FAILED');
    }
  }
}

async function main() {
  if (process.argv.length !== 2) {
    fail('BACKSTAGE_HEAVY_PROOF_ARGUMENT_INVALID');
  }
  const processKind = process.env.ARCANOS_PROCESS_KIND?.trim().toLowerCase();
  const exitCode = await runBackstageHeavyProofSupervisor(processKind);
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const code = isKnownProofError(error)
      ? error.message
      : 'BACKSTAGE_HEAVY_PROOF_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
