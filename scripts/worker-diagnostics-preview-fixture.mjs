#!/usr/bin/env node
/**
 * Seed and remove deterministic worker-diagnostics fixtures in one disposable
 * Railway E2E environment.
 *
 * The command is deliberately unusable against production, native passive PR
 * environments, public database endpoints, or an ambiguously identified
 * Railway service. It prints only fixture identifiers, hashes, and mutation
 * booleans; raw fixture payloads and connection material are never emitted.
 */

import { createHash } from 'node:crypto';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const FIXTURE_KIND = 'worker-diagnostics-preview-e2e';
const DB_WRITE_OPT_IN_ENV = 'ARCANOS_WORKER_DIAGNOSTICS_E2E_ALLOW_DB_WRITE';
export const AUTHORIZED_RAILWAY_PROJECT_ID =
  '7faf44e5-519c-4e73-8d7a-da9f389e6187';
export const AUTHORIZED_RAILWAY_WEB_SERVICE_ID =
  'c4ade025-3f13-4fca-9309-5d0dd81396fe';
export const AUTHORIZED_RAILWAY_DATABASE_HOST =
  'postgres-btrn.railway.internal';
export const FIXTURE_RESULT_PREFIX =
  'ARCANOS_WORKER_DIAGNOSTICS_FIXTURE_RESULT ';
const CUSTOM_ENVIRONMENT_NAME_PATTERN = /^worker-diagnostics-pr-([1-9]\d*)-e2e$/u;
const NATIVE_PR_ENVIRONMENT_PATTERN =
  /^(?:Arcanos-pr-[1-9]\d*|pr-[0-9a-f]{6}-[1-9]\d*)$/iu;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RUN_ID_PATTERN = /^wdc-pr-([1-9]\d*)-([a-z0-9][a-z0-9-]{7,63})$/u;

export const FIXTURE_ERROR_CODES = Object.freeze({
  ARGUMENT_INVALID: 'WORKER_DIAGNOSTICS_FIXTURE_ARGUMENT_INVALID',
  MODE_REQUIRED: 'WORKER_DIAGNOSTICS_FIXTURE_MODE_REQUIRED',
  MODE_CONFLICT: 'WORKER_DIAGNOSTICS_FIXTURE_MODE_CONFLICT',
  EXECUTE_REQUIRED: 'WORKER_DIAGNOSTICS_FIXTURE_EXECUTE_REQUIRED',
  PR_NUMBER_REQUIRED: 'WORKER_DIAGNOSTICS_FIXTURE_PR_NUMBER_REQUIRED',
  RUN_ID_INVALID: 'WORKER_DIAGNOSTICS_FIXTURE_RUN_ID_INVALID',
  EXPECTED_ID_INVALID: 'WORKER_DIAGNOSTICS_FIXTURE_EXPECTED_ID_INVALID',
  PROJECT_NOT_AUTHORIZED: 'WORKER_DIAGNOSTICS_FIXTURE_PROJECT_NOT_AUTHORIZED',
  SERVICE_NOT_AUTHORIZED: 'WORKER_DIAGNOSTICS_FIXTURE_SERVICE_NOT_AUTHORIZED',
  PROJECT_MISMATCH: 'WORKER_DIAGNOSTICS_FIXTURE_PROJECT_MISMATCH',
  ENVIRONMENT_MISMATCH: 'WORKER_DIAGNOSTICS_FIXTURE_ENVIRONMENT_MISMATCH',
  SERVICE_MISMATCH: 'WORKER_DIAGNOSTICS_FIXTURE_SERVICE_MISMATCH',
  ENVIRONMENT_NAME_UNSAFE: 'WORKER_DIAGNOSTICS_FIXTURE_ENVIRONMENT_NAME_UNSAFE',
  NATIVE_PR_ENVIRONMENT_FORBIDDEN:
    'WORKER_DIAGNOSTICS_FIXTURE_NATIVE_PR_ENVIRONMENT_FORBIDDEN',
  ISOLATION_REQUIRED: 'WORKER_DIAGNOSTICS_FIXTURE_ISOLATION_REQUIRED',
  MOCK_MODE_REQUIRED: 'WORKER_DIAGNOSTICS_FIXTURE_MOCK_MODE_REQUIRED',
  DB_WRITE_OPT_IN_REQUIRED: 'WORKER_DIAGNOSTICS_FIXTURE_DB_WRITE_OPT_IN_REQUIRED',
  WEB_SERVICE_REQUIRED: 'WORKER_DIAGNOSTICS_FIXTURE_WEB_SERVICE_REQUIRED',
  DATABASE_URL_REQUIRED: 'WORKER_DIAGNOSTICS_FIXTURE_DATABASE_URL_REQUIRED',
  DATABASE_TARGET_UNSAFE: 'WORKER_DIAGNOSTICS_FIXTURE_DATABASE_TARGET_UNSAFE',
  RUN_ID_ALREADY_EXISTS: 'WORKER_DIAGNOSTICS_FIXTURE_RUN_ID_ALREADY_EXISTS',
  DATABASE_INITIALIZATION_FAILED:
    'WORKER_DIAGNOSTICS_FIXTURE_DATABASE_INITIALIZATION_FAILED',
  JOB_CREATION_FAILED: 'WORKER_DIAGNOSTICS_FIXTURE_JOB_CREATION_FAILED',
  JOB_TERMINAL_UPDATE_FAILED:
    'WORKER_DIAGNOSTICS_FIXTURE_JOB_TERMINAL_UPDATE_FAILED',
  UNEXPECTED: 'WORKER_DIAGNOSTICS_FIXTURE_FAILED'
});

export class WorkerDiagnosticsFixtureError extends Error {
  constructor(code) {
    super(code);
    this.name = 'WorkerDiagnosticsFixtureError';
    this.code = code;
  }
}

function fail(code) {
  throw new WorkerDiagnosticsFixtureError(code);
}

function readRequiredArgumentValue(argv, index) {
  const value = argv[index + 1];
  if (typeof value !== 'string' || value.trim().length === 0 || value.startsWith('--')) {
    fail(FIXTURE_ERROR_CODES.ARGUMENT_INVALID);
  }
  return value.trim();
}

/**
 * Parse an explicit, mutation-oriented CLI contract.
 *
 * No mode is inferred and unknown flags fail closed.
 */
export function parseArgs(argv) {
  const options = {
    mode: null,
    execute: false,
    prNumber: null,
    runId: null,
    expectedProjectId: null,
    expectedEnvironmentId: null,
    expectedServiceId: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--seed' || argument === '--cleanup') {
      if (options.mode !== null) {
        fail(FIXTURE_ERROR_CODES.MODE_CONFLICT);
      }
      options.mode = argument.slice(2);
      continue;
    }

    if (argument === '--execute') {
      options.execute = true;
      continue;
    }

    if (argument === '--pr-number') {
      const rawValue = readRequiredArgumentValue(argv, index);
      if (!/^[1-9]\d*$/u.test(rawValue)) {
        fail(FIXTURE_ERROR_CODES.PR_NUMBER_REQUIRED);
      }
      options.prNumber = Number(rawValue);
      index += 1;
      continue;
    }

    if (argument === '--run-id') {
      options.runId = readRequiredArgumentValue(argv, index);
      index += 1;
      continue;
    }

    if (argument === '--expected-project-id') {
      options.expectedProjectId = readRequiredArgumentValue(argv, index);
      index += 1;
      continue;
    }

    if (argument === '--expected-environment-id') {
      options.expectedEnvironmentId = readRequiredArgumentValue(argv, index);
      index += 1;
      continue;
    }

    if (argument === '--expected-service-id') {
      options.expectedServiceId = readRequiredArgumentValue(argv, index);
      index += 1;
      continue;
    }

    fail(FIXTURE_ERROR_CODES.ARGUMENT_INVALID);
  }

  return options;
}

function requireExactValue(expected, actual, mismatchCode) {
  if (
    typeof expected !== 'string' ||
    !UUID_PATTERN.test(expected) ||
    typeof actual !== 'string' ||
    expected !== actual.trim()
  ) {
    fail(mismatchCode);
  }
}

function requireTrueMarker(environment, name, code) {
  if (environment[name] !== 'true') {
    fail(code);
  }
}

function validateRunId(runId, prNumber) {
  if (typeof runId !== 'string') {
    fail(FIXTURE_ERROR_CODES.RUN_ID_INVALID);
  }

  const match = RUN_ID_PATTERN.exec(runId);
  if (!match || Number(match[1]) !== prNumber) {
    fail(FIXTURE_ERROR_CODES.RUN_ID_INVALID);
  }
}

function validateExpectedIds(options) {
  const expectedIds = [
    options.expectedProjectId,
    options.expectedEnvironmentId,
    options.expectedServiceId
  ];
  if (expectedIds.some((value) => typeof value !== 'string' || !UUID_PATTERN.test(value))) {
    fail(FIXTURE_ERROR_CODES.EXPECTED_ID_INVALID);
  }
  if (options.expectedProjectId !== AUTHORIZED_RAILWAY_PROJECT_ID) {
    fail(FIXTURE_ERROR_CODES.PROJECT_NOT_AUTHORIZED);
  }
  if (options.expectedServiceId !== AUTHORIZED_RAILWAY_WEB_SERVICE_ID) {
    fail(FIXTURE_ERROR_CODES.SERVICE_NOT_AUTHORIZED);
  }
}

function validateDatabaseTarget(databaseUrl) {
  if (typeof databaseUrl !== 'string' || databaseUrl.trim().length === 0) {
    fail(FIXTURE_ERROR_CODES.DATABASE_URL_REQUIRED);
  }

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    fail(FIXTURE_ERROR_CODES.DATABASE_TARGET_UNSAFE);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    hostname !== AUTHORIZED_RAILWAY_DATABASE_HOST ||
    !parsed.pathname ||
    parsed.pathname === '/'
  ) {
    fail(FIXTURE_ERROR_CODES.DATABASE_TARGET_UNSAFE);
  }
}

/**
 * Prove that a mutation is bound to the intended disposable E2E service.
 *
 * Validation happens before database modules are loaded.
 */
export function validateExecutionTarget(options, environment = process.env) {
  if (options.mode !== 'seed' && options.mode !== 'cleanup') {
    fail(FIXTURE_ERROR_CODES.MODE_REQUIRED);
  }
  if (options.execute !== true) {
    fail(FIXTURE_ERROR_CODES.EXECUTE_REQUIRED);
  }
  if (!Number.isSafeInteger(options.prNumber) || options.prNumber <= 0) {
    fail(FIXTURE_ERROR_CODES.PR_NUMBER_REQUIRED);
  }

  validateRunId(options.runId, options.prNumber);
  validateExpectedIds(options);

  requireExactValue(
    options.expectedProjectId,
    environment.RAILWAY_PROJECT_ID,
    FIXTURE_ERROR_CODES.PROJECT_MISMATCH
  );
  requireExactValue(
    options.expectedEnvironmentId,
    environment.RAILWAY_ENVIRONMENT_ID,
    FIXTURE_ERROR_CODES.ENVIRONMENT_MISMATCH
  );
  requireExactValue(
    options.expectedServiceId,
    environment.RAILWAY_SERVICE_ID,
    FIXTURE_ERROR_CODES.SERVICE_MISMATCH
  );

  const environmentName = String(environment.RAILWAY_ENVIRONMENT_NAME ?? '').trim();
  if (NATIVE_PR_ENVIRONMENT_PATTERN.test(environmentName)) {
    fail(FIXTURE_ERROR_CODES.NATIVE_PR_ENVIRONMENT_FORBIDDEN);
  }

  const environmentMatch = CUSTOM_ENVIRONMENT_NAME_PATTERN.exec(environmentName);
  if (
    !environmentMatch ||
    Number(environmentMatch[1]) !== options.prNumber ||
    environmentName.toLowerCase() === 'production'
  ) {
    fail(FIXTURE_ERROR_CODES.ENVIRONMENT_NAME_UNSAFE);
  }

  requireTrueMarker(
    environment,
    'ARCANOS_PREVIEW_ISOLATION',
    FIXTURE_ERROR_CODES.ISOLATION_REQUIRED
  );
  requireTrueMarker(
    environment,
    'FORCE_MOCK',
    FIXTURE_ERROR_CODES.MOCK_MODE_REQUIRED
  );
  requireTrueMarker(
    environment,
    DB_WRITE_OPT_IN_ENV,
    FIXTURE_ERROR_CODES.DB_WRITE_OPT_IN_REQUIRED
  );

  if (environment.ARCANOS_PROCESS_KIND !== 'web') {
    fail(FIXTURE_ERROR_CODES.WEB_SERVICE_REQUIRED);
  }

  validateDatabaseTarget(environment.DATABASE_URL);

  return {
    mode: options.mode,
    prNumber: options.prNumber,
    runId: options.runId,
    projectId: options.expectedProjectId,
    environmentId: options.expectedEnvironmentId,
    serviceId: options.expectedServiceId,
    environmentName
  };
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Build known synthetic values from the public run identifier.
 *
 * These values are passed to persistence but never returned by the command.
 */
export function buildFixtureSentinels(runId, prNumber) {
  const suffix = runId.slice(`wdc-pr-${prNumber}-`.length);
  const workerId = `worker-diagnostics-e2e-${prNumber}-${suffix}`;
  const correlationId = `${FIXTURE_KIND}:${runId}`;

  return {
    runId,
    workerId,
    correlationId,
    prompt: `ARCANOS_WD_PROMPT_${runId}`,
    result: `ARCANOS_WD_RESULT_${runId}`,
    error: `ARCANOS_WD_ERROR_${runId}`,
    workersDirectory: `/srv/arcanos-worker-diagnostics/${runId}/workers`
  };
}

function buildSentinelHashes(sentinels) {
  return {
    prompt: sha256(sentinels.prompt),
    result: sha256(sentinels.result),
    error: sha256(sentinels.error),
    workersDirectory: sha256(sentinels.workersDirectory)
  };
}

async function loadFixtureDependencies() {
  const [database, jobs, runtime] = await Promise.all([
    import('../dist/core/db/index.js'),
    import('../dist/core/db/repositories/jobRepository.js'),
    import('../dist/core/db/repositories/workerRuntimeRepository.js')
  ]);

  return {
    initializeDatabaseWithSchema: database.initializeDatabaseWithSchema,
    closeDatabase: database.close,
    query: database.query,
    createJob: jobs.createJob,
    updateJob: jobs.updateJob,
    upsertWorkerRuntimeSnapshot: runtime.upsertWorkerRuntimeSnapshot,
    upsertWorkerRuntimeState: runtime.upsertWorkerRuntimeState,
    recordWorkerLiveness: runtime.recordWorkerLiveness,
    sleepFn: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  };
}

async function assertFixtureAbsent(query, sentinels) {
  const result = await query(
    `SELECT
       EXISTS (
         SELECT 1
         FROM job_data
         WHERE worker_id = $1
           AND correlation_id = $2
           AND job_type = 'ask'
           AND input->>'fixtureKind' = $3
           AND input->>'runId' = $4
       )
       OR EXISTS (
         SELECT 1
         FROM worker_runtime_snapshots
         WHERE worker_id = $1
       )
       OR EXISTS (
         SELECT 1
         FROM worker_runtime_state
         WHERE worker_id = $1
       )
       OR EXISTS (
         SELECT 1
         FROM worker_liveness
         WHERE worker_id = $1
       )
       OR EXISTS (
         SELECT 1
         FROM worker_runtime_history
         WHERE worker_id = $1
       )
       OR EXISTS (
         SELECT 1
         FROM job_events
         WHERE worker_id = $1
       ) AS fixture_exists`,
    [sentinels.workerId, sentinels.correlationId, FIXTURE_KIND, sentinels.runId],
    {
      traceContext: {
        queryName: 'worker_diagnostics_fixture_absence_check',
        workerId: sentinels.workerId
      }
    }
  );

  if (result.rows[0]?.fixture_exists === true) {
    fail(FIXTURE_ERROR_CODES.RUN_ID_ALREADY_EXISTS);
  }
}

/**
 * Remove only rows carrying the deterministic run identity.
 */
export async function cleanupFixture(query, sentinels, options = {}) {
  const sleepFn =
    options.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const result = await query(
    `WITH target_jobs AS (
       SELECT id
       FROM job_data
       WHERE worker_id = $1
         AND correlation_id = $2
         AND job_type = 'ask'
         AND input->>'fixtureKind' = $3
         AND input->>'runId' = $4
     ),
     deleted_events AS (
       DELETE FROM job_events
       WHERE worker_id = $1
          OR job_id IN (SELECT id FROM target_jobs)
       RETURNING id
     ),
     deleted_jobs AS (
       DELETE FROM job_data
       WHERE id IN (SELECT id FROM target_jobs)
       RETURNING id
     ),
     deleted_history AS (
       DELETE FROM worker_runtime_history
       WHERE worker_id = $1
       RETURNING id
     ),
     deleted_state AS (
       DELETE FROM worker_runtime_state
       WHERE worker_id = $1
       RETURNING worker_id
     ),
     deleted_snapshots AS (
       DELETE FROM worker_runtime_snapshots
       WHERE worker_id = $1
       RETURNING worker_id
     ),
     deleted_liveness AS (
       DELETE FROM worker_liveness
       WHERE worker_id = $1
       RETURNING worker_id
     )
     SELECT
       EXISTS (SELECT 1 FROM deleted_events) AS deleted_events,
       EXISTS (SELECT 1 FROM deleted_jobs) AS deleted_job,
       EXISTS (SELECT 1 FROM deleted_history) AS deleted_history,
       EXISTS (SELECT 1 FROM deleted_state) AS deleted_state,
       EXISTS (SELECT 1 FROM deleted_snapshots) AS deleted_snapshot,
       EXISTS (SELECT 1 FROM deleted_liveness) AS deleted_liveness`,
    [sentinels.workerId, sentinels.correlationId, FIXTURE_KIND, sentinels.runId],
    {
      traceContext: {
        queryName: 'worker_diagnostics_fixture_cleanup',
        workerId: sentinels.workerId
      }
    }
  );

  const row = result.rows[0] ?? {};
  let deletedEvents = row.deleted_events === true;

  // createJob/updateJob intentionally emit operational events without awaiting
  // their inserts. Two bounded, exact-identity sweeps reduce the chance that a
  // late event outlives partial-failure cleanup; deleting the disposable
  // environment remains the final containment boundary.
  for (const settleMs of [50, 150]) {
    await sleepFn(settleMs);
    const lateEventResult = await query(
      `DELETE FROM job_events
       WHERE worker_id = $1
       RETURNING id`,
      [sentinels.workerId],
      {
        traceContext: {
          queryName: 'worker_diagnostics_fixture_late_event_cleanup',
          workerId: sentinels.workerId
        }
      }
    );
    deletedEvents =
      deletedEvents ||
      Number(lateEventResult.rowCount ?? lateEventResult.rows.length) > 0;
  }

  return {
    events: deletedEvents,
    job: row.deleted_job === true,
    history: row.deleted_history === true,
    state: row.deleted_state === true,
    snapshot: row.deleted_snapshot === true,
    liveness: row.deleted_liveness === true
  };
}

function buildRuntimeRecord(sentinels, jobId, now) {
  const recoveryEvent = {
    kind: FIXTURE_KIND,
    currentJobId: jobId,
    lastInputPreview: sentinels.prompt,
    lastResult: {
      value: sentinels.result
    },
    lastError: sentinels.error,
    workersDirectory: sentinels.workersDirectory,
    at: now
  };

  return {
    workerId: sentinels.workerId,
    workerType: 'worker-diagnostics-e2e',
    healthStatus: 'degraded',
    currentJobId: jobId,
    lastError: sentinels.error,
    startedAt: now,
    lastHeartbeatAt: now,
    lastInspectorRunAt: now,
    updatedAt: now,
    snapshot: {
      fixtureKind: FIXTURE_KIND,
      fixtureRunId: sentinels.runId,
      dispatcherStarted: true,
      activeListeners: 1,
      activeJobs: [jobId],
      lastPollAt: now,
      lastClaimAttemptAt: now,
      lastClaimResult: sentinels.result,
      disabledReason: sentinels.prompt,
      lastActivityAt: now,
      lastProcessedJobAt: now,
      processedJobs: 1,
      scheduledRetries: 0,
      terminalFailures: 1,
      recoveredJobs: 0,
      recoveryActions: 1,
      lastRecoveryActionAt: now,
      lastRecoveryEvent: recoveryEvent,
      recentRecoveryEvents: [recoveryEvent],
      lastWatchdogRunAt: now,
      watchdog: {
        triggered: false,
        reason: sentinels.error,
        inactivityMs: 0,
        lastActivityAt: now,
        lastProcessedJobAt: now,
        lastHeartbeatAt: now,
        stale: false,
        staleAfterMs: 120_000,
        idleThresholdMs: 300_000,
        restartRecommended: false
      }
    }
  };
}

async function seedFixture(target, sentinels, dependencies, now) {
  const createdJob = await dependencies.createJob(
    sentinels.workerId,
    'ask',
    {
      fixtureKind: FIXTURE_KIND,
      runId: sentinels.runId,
      prompt: sentinels.prompt,
      workersDirectory: sentinels.workersDirectory,
      endpointName: FIXTURE_KIND
    },
    {
      // Insert directly in a terminal state so a concurrently running preview
      // worker can never claim the synthetic fixture between repository calls.
      status: 'failed',
      retryCount: 0,
      maxRetries: 0,
      lastWorkerId: sentinels.workerId,
      correlationId: sentinels.correlationId,
      autonomyState: {
        fixture: {
          kind: FIXTURE_KIND,
          runId: sentinels.runId
        }
      }
    }
  );

  if (!createdJob || typeof createdJob.id !== 'string' || !UUID_PATTERN.test(createdJob.id)) {
    fail(FIXTURE_ERROR_CODES.JOB_CREATION_FAILED);
  }

  const failedJob = await dependencies.updateJob(
    createdJob.id,
    'failed',
    {
      fixtureKind: FIXTURE_KIND,
      runId: sentinels.runId,
      result: sentinels.result,
      workersDirectory: sentinels.workersDirectory
    },
    sentinels.error,
    {
      fixture: {
        failedAt: now,
        terminal: true
      }
    }
  );

  if (
    !failedJob ||
    failedJob.id !== createdJob.id ||
    failedJob.status !== 'failed'
  ) {
    fail(FIXTURE_ERROR_CODES.JOB_TERMINAL_UPDATE_FAILED);
  }

  const runtimeRecord = buildRuntimeRecord(sentinels, createdJob.id, now);
  const stateHash = sha256(JSON.stringify(runtimeRecord.snapshot));

  await dependencies.upsertWorkerRuntimeSnapshot(runtimeRecord, {
    source: FIXTURE_KIND
  });
  await dependencies.upsertWorkerRuntimeState(runtimeRecord, {
    source: FIXTURE_KIND,
    stateHash,
    preserveLegacySnapshot: true
  });
  await dependencies.recordWorkerLiveness({
    workerId: sentinels.workerId,
    healthStatus: runtimeRecord.healthStatus,
    lastSeenAt: now
  });

  return {
    ok: true,
    command: 'seed',
    prNumber: target.prNumber,
    runId: sentinels.runId,
    jobId: createdJob.id,
    workerId: sentinels.workerId,
    sentinelSha256: buildSentinelHashes(sentinels),
    seeded: {
      job: true,
      runtimeSnapshot: true,
      runtimeState: true,
      liveness: true
    }
  };
}

/**
 * Run one validated seed or cleanup command with injectable database APIs.
 */
export async function runFixtureCommand(
  options,
  environment = process.env,
  injectedDependencies = null,
  nowFn = () => new Date().toISOString()
) {
  const target = validateExecutionTarget(options, environment);
  const sentinels = buildFixtureSentinels(target.runId, target.prNumber);
  const dependencies = injectedDependencies ?? await loadFixtureDependencies();
  let databaseInitialized = false;
  let seedMutationStarted = false;
  let seedCompleted = false;

  try {
    databaseInitialized = await dependencies.initializeDatabaseWithSchema('');
    if (!databaseInitialized) {
      fail(FIXTURE_ERROR_CODES.DATABASE_INITIALIZATION_FAILED);
    }

    if (target.mode === 'cleanup') {
      const removed = await cleanupFixture(dependencies.query, sentinels, {
        sleepFn: dependencies.sleepFn
      });
      return {
        ok: true,
        command: 'cleanup',
        prNumber: target.prNumber,
        runId: sentinels.runId,
        workerId: sentinels.workerId,
        removed
      };
    }

    await assertFixtureAbsent(dependencies.query, sentinels);
    seedMutationStarted = true;
    const result = await seedFixture(
      target,
      sentinels,
      dependencies,
      nowFn()
    );
    seedCompleted = true;
    return result;
  } catch (error) {
    if (
      databaseInitialized &&
      target.mode === 'seed' &&
      seedMutationStarted &&
      !seedCompleted
    ) {
      try {
        await cleanupFixture(dependencies.query, sentinels, {
          sleepFn: dependencies.sleepFn
        });
      } catch {
        // The disposable environment remains the final cleanup boundary.
      }
    }
    throw error;
  } finally {
    await dependencies.closeDatabase();
  }
}

export function formatSafeResult(result) {
  return `${FIXTURE_RESULT_PREFIX}${JSON.stringify(result)}\n`;
}

function printSafeResult(result) {
  process.stdout.write(formatSafeResult(result));
}

async function runWithDependencyConsoleSuppressed(operation) {
  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error
  };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return await operation();
  } finally {
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await runWithDependencyConsoleSuppressed(
    () => runFixtureCommand(options)
  );
  printSafeResult(result);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const code =
      error instanceof WorkerDiagnosticsFixtureError
        ? error.code
        : FIXTURE_ERROR_CODES.UNEXPECTED;
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
