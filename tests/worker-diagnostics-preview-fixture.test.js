import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, jest } from '@jest/globals';
import {
  AUTHORIZED_RAILWAY_DATABASE_HOST,
  AUTHORIZED_RAILWAY_WEB_SERVICE_ID,
  FIXTURE_ERROR_CODES,
  FIXTURE_RESULT_PREFIX,
  buildFixtureSentinels,
  cleanupFixture,
  formatSafeResult,
  parseArgs,
  runFixtureCommand,
  validateExecutionTarget
} from '../scripts/worker-diagnostics-preview-fixture.mjs';

const PROJECT_ID = '7faf44e5-519c-4e73-8d7a-da9f389e6187';
const ENVIRONMENT_ID = '11111111-1111-4111-8111-111111111111';
const SERVICE_ID = AUTHORIZED_RAILWAY_WEB_SERVICE_ID;
const JOB_ID = '33333333-3333-4333-8333-333333333333';
const PR_NUMBER = 1412;
const RUN_ID = 'wdc-pr-1412-0123456789abcdef';
const SCRIPT_PATH = fileURLToPath(
  new URL('../scripts/worker-diagnostics-preview-fixture.mjs', import.meta.url)
);

function buildOptions(mode = 'seed') {
  return {
    mode,
    execute: true,
    prNumber: PR_NUMBER,
    runId: RUN_ID,
    expectedProjectId: PROJECT_ID,
    expectedEnvironmentId: ENVIRONMENT_ID,
    expectedServiceId: SERVICE_ID
  };
}

function buildEnvironment(overrides = {}) {
  return {
    RAILWAY_PROJECT_ID: PROJECT_ID,
    RAILWAY_ENVIRONMENT_ID: ENVIRONMENT_ID,
    RAILWAY_ENVIRONMENT_NAME: 'worker-diagnostics-pr-1412-e2e',
    RAILWAY_SERVICE_ID: SERVICE_ID,
    RAILWAY_SERVICE_NAME: 'Arcanos E2E Web',
    ARCANOS_PROCESS_KIND: 'web',
    ARCANOS_PREVIEW_ISOLATION: 'true',
    FORCE_MOCK: 'true',
    ARCANOS_WORKER_DIAGNOSTICS_E2E_ALLOW_DB_WRITE: 'true',
    DATABASE_URL:
      `postgresql://fixture-user:fixture-password@${AUTHORIZED_RAILWAY_DATABASE_HOST}:5432/fixture`,
    ...overrides
  };
}

function buildDependencies(overrides = {}) {
  return {
    initializeDatabaseWithSchema: jest.fn(async () => true),
    closeDatabase: jest.fn(async () => {}),
    query: jest.fn(async (sql) => {
      if (sql.includes('AS fixture_exists')) {
        return { rows: [{ fixture_exists: false }] };
      }
      return {
        rows: [{
          deleted_events: true,
          deleted_job: true,
          deleted_history: true,
          deleted_state: true,
          deleted_snapshot: true,
          deleted_liveness: true
        }]
      };
    }),
    createJob: jest.fn(async () => ({
      id: JOB_ID,
      status: 'failed'
    })),
    updateJob: jest.fn(async () => ({
      id: JOB_ID,
      status: 'failed'
    })),
    upsertWorkerRuntimeSnapshot: jest.fn(async () => {}),
    upsertWorkerRuntimeState: jest.fn(async () => {}),
    recordWorkerLiveness: jest.fn(async () => {}),
    sleepFn: jest.fn(async () => {}),
    ...overrides
  };
}

function expectErrorCode(operation, code) {
  expect(operation).toThrow(expect.objectContaining({ code }));
}

describe('worker-diagnostics-preview-fixture', () => {
  it('parses the full explicit seed command', () => {
    expect(parseArgs([
      '--seed',
      '--execute',
      '--pr-number', String(PR_NUMBER),
      '--run-id', RUN_ID,
      '--expected-project-id', PROJECT_ID,
      '--expected-environment-id', ENVIRONMENT_ID,
      '--expected-service-id', SERVICE_ID
    ])).toEqual(buildOptions());
  });

  it('rejects absent, conflicting, and unknown mutation modes', () => {
    expectErrorCode(
      () => validateExecutionTarget({ ...buildOptions(), mode: null }, buildEnvironment()),
      FIXTURE_ERROR_CODES.MODE_REQUIRED
    );
    expectErrorCode(
      () => parseArgs(['--seed', '--cleanup']),
      FIXTURE_ERROR_CODES.MODE_CONFLICT
    );
    expectErrorCode(
      () => parseArgs(['--inspect']),
      FIXTURE_ERROR_CODES.ARGUMENT_INVALID
    );
  });

  it('requires the explicit execute flag', () => {
    expectErrorCode(
      () => validateExecutionTarget(
        { ...buildOptions(), execute: false },
        buildEnvironment()
      ),
      FIXTURE_ERROR_CODES.EXECUTE_REQUIRED
    );
  });

  it.each([
    ['ARCANOS_PREVIEW_ISOLATION', undefined, FIXTURE_ERROR_CODES.ISOLATION_REQUIRED],
    ['ARCANOS_PREVIEW_ISOLATION', 'TRUE', FIXTURE_ERROR_CODES.ISOLATION_REQUIRED],
    ['FORCE_MOCK', undefined, FIXTURE_ERROR_CODES.MOCK_MODE_REQUIRED],
    ['FORCE_MOCK', '1', FIXTURE_ERROR_CODES.MOCK_MODE_REQUIRED],
    [
      'ARCANOS_WORKER_DIAGNOSTICS_E2E_ALLOW_DB_WRITE',
      undefined,
      FIXTURE_ERROR_CODES.DB_WRITE_OPT_IN_REQUIRED
    ],
    [
      'ARCANOS_WORKER_DIAGNOSTICS_E2E_ALLOW_DB_WRITE',
      'yes',
      FIXTURE_ERROR_CODES.DB_WRITE_OPT_IN_REQUIRED
    ]
  ])('requires exact true marker %s', (name, value, code) => {
    expectErrorCode(
      () => validateExecutionTarget(
        buildOptions(),
        buildEnvironment({ [name]: value })
      ),
      code
    );
  });

  it.each([
    ['production', FIXTURE_ERROR_CODES.ENVIRONMENT_NAME_UNSAFE],
    ['staging', FIXTURE_ERROR_CODES.ENVIRONMENT_NAME_UNSAFE],
    ['worker-diagnostics-pr-1413-e2e', FIXTURE_ERROR_CODES.ENVIRONMENT_NAME_UNSAFE],
    ['Arcanos-pr-1412', FIXTURE_ERROR_CODES.NATIVE_PR_ENVIRONMENT_FORBIDDEN],
    ['pr-abcdef-1412', FIXTURE_ERROR_CODES.NATIVE_PR_ENVIRONMENT_FORBIDDEN]
  ])('rejects unsafe Railway environment %s', (environmentName, code) => {
    expectErrorCode(
      () => validateExecutionTarget(
        buildOptions(),
        buildEnvironment({ RAILWAY_ENVIRONMENT_NAME: environmentName })
      ),
      code
    );
  });

  it.each([
    [
      'RAILWAY_PROJECT_ID',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      FIXTURE_ERROR_CODES.PROJECT_MISMATCH
    ],
    [
      'RAILWAY_ENVIRONMENT_ID',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      FIXTURE_ERROR_CODES.ENVIRONMENT_MISMATCH
    ],
    [
      'RAILWAY_SERVICE_ID',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      FIXTURE_ERROR_CODES.SERVICE_MISMATCH
    ]
  ])('requires exact Railway identity for %s', (name, value, code) => {
    expectErrorCode(
      () => validateExecutionTarget(
        buildOptions(),
        buildEnvironment({ [name]: value })
      ),
      code
    );
  });

  it('rejects malformed expected target identifiers and mismatched run identifiers', () => {
    expectErrorCode(
      () => validateExecutionTarget(
        { ...buildOptions(), expectedServiceId: 'not-an-id' },
        buildEnvironment()
      ),
      FIXTURE_ERROR_CODES.EXPECTED_ID_INVALID
    );
    expectErrorCode(
      () => validateExecutionTarget(
        { ...buildOptions(), runId: 'wdc-pr-1413-0123456789abcdef' },
        buildEnvironment()
      ),
      FIXTURE_ERROR_CODES.RUN_ID_INVALID
    );
  });

  it('rejects valid but unauthorized project and service identifiers', () => {
    expectErrorCode(
      () => validateExecutionTarget(
        {
          ...buildOptions(),
          expectedProjectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        },
        buildEnvironment({
          RAILWAY_PROJECT_ID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        })
      ),
      FIXTURE_ERROR_CODES.PROJECT_NOT_AUTHORIZED
    );
    expectErrorCode(
      () => validateExecutionTarget(
        {
          ...buildOptions(),
          expectedServiceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        },
        buildEnvironment({
          RAILWAY_SERVICE_ID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        })
      ),
      FIXTURE_ERROR_CODES.SERVICE_NOT_AUTHORIZED
    );
  });

  it.each([
    [undefined, FIXTURE_ERROR_CODES.DATABASE_URL_REQUIRED],
    ['not-a-url', FIXTURE_ERROR_CODES.DATABASE_TARGET_UNSAFE],
    [
      'redis://redis.railway.internal:6379/0',
      FIXTURE_ERROR_CODES.DATABASE_TARGET_UNSAFE
    ],
    [
      'postgresql://fixture:fixture@proxy.rlwy.net:12345/fixture',
      FIXTURE_ERROR_CODES.DATABASE_TARGET_UNSAFE
    ],
    [
      'postgresql://fixture:fixture@localhost:5432/fixture',
      FIXTURE_ERROR_CODES.DATABASE_TARGET_UNSAFE
    ],
    [
      'postgresql://fixture:fixture@another-postgres.railway.internal:5432/fixture',
      FIXTURE_ERROR_CODES.DATABASE_TARGET_UNSAFE
    ]
  ])('rejects unsafe database target %s', (databaseUrl, code) => {
    expectErrorCode(
      () => validateExecutionTarget(
        buildOptions(),
        buildEnvironment({ DATABASE_URL: databaseUrl })
      ),
      code
    );
  });

  it('requires execution inside the web service role', () => {
    expectErrorCode(
      () => validateExecutionTarget(
        buildOptions(),
        buildEnvironment({ ARCANOS_PROCESS_KIND: 'worker' })
      ),
      FIXTURE_ERROR_CODES.WEB_SERVICE_REQUIRED
    );
  });

  it('builds deterministic non-credential sentinels from the run identity', () => {
    const first = buildFixtureSentinels(RUN_ID, PR_NUMBER);
    const second = buildFixtureSentinels(RUN_ID, PR_NUMBER);

    expect(first).toEqual(second);
    expect(first).toEqual(expect.objectContaining({
      runId: RUN_ID,
      workerId: 'worker-diagnostics-e2e-1412-0123456789abcdef',
      prompt: expect.stringContaining(RUN_ID),
      result: expect.stringContaining(RUN_ID),
      error: expect.stringContaining(RUN_ID),
      workersDirectory: `/srv/arcanos-worker-diagnostics/${RUN_ID}/workers`
    }));
  });

  it('formats one tagged machine-readable result record', () => {
    const rendered = formatSafeResult({
      ok: true,
      command: 'seed',
      jobId: JOB_ID
    });

    expect(rendered.startsWith(FIXTURE_RESULT_PREFIX)).toBe(true);
    expect(JSON.parse(rendered.slice(FIXTURE_RESULT_PREFIX.length))).toEqual({
      ok: true,
      command: 'seed',
      jobId: JOB_ID
    });
  });

  it('seeds one failed job plus snapshot, state, and liveness with known sentinels', async () => {
    const dependencies = buildDependencies();
    const now = '2026-07-30T12:00:00.000Z';
    const result = await runFixtureCommand(
      buildOptions(),
      buildEnvironment(),
      dependencies,
      () => now
    );
    const sentinels = buildFixtureSentinels(RUN_ID, PR_NUMBER);

    expect(dependencies.initializeDatabaseWithSchema).toHaveBeenCalledWith('');
    expect(dependencies.createJob).toHaveBeenCalledWith(
      sentinels.workerId,
      'ask',
      expect.objectContaining({
        fixtureKind: 'worker-diagnostics-preview-e2e',
        runId: RUN_ID,
        prompt: sentinels.prompt,
        workersDirectory: sentinels.workersDirectory
      }),
      expect.objectContaining({
        status: 'failed',
        maxRetries: 0,
        lastWorkerId: sentinels.workerId,
        correlationId: sentinels.correlationId
      })
    );
    expect(dependencies.updateJob).toHaveBeenCalledWith(
      JOB_ID,
      'failed',
      expect.objectContaining({
        result: sentinels.result,
        workersDirectory: sentinels.workersDirectory
      }),
      sentinels.error,
      expect.objectContaining({
        fixture: {
          failedAt: now,
          terminal: true
        }
      })
    );

    const runtimeRecord = dependencies.upsertWorkerRuntimeSnapshot.mock.calls[0][0];
    expect(runtimeRecord).toEqual(expect.objectContaining({
      workerId: sentinels.workerId,
      healthStatus: 'degraded',
      currentJobId: JOB_ID,
      lastError: sentinels.error,
      updatedAt: now,
      snapshot: expect.objectContaining({
        activeJobs: [JOB_ID],
        lastClaimResult: sentinels.result,
        disabledReason: sentinels.prompt,
        lastRecoveryEvent: expect.objectContaining({
          currentJobId: JOB_ID,
          lastInputPreview: sentinels.prompt,
          lastResult: { value: sentinels.result },
          lastError: sentinels.error,
          workersDirectory: sentinels.workersDirectory
        })
      })
    }));
    expect(dependencies.upsertWorkerRuntimeState).toHaveBeenCalledWith(
      runtimeRecord,
      expect.objectContaining({
        source: 'worker-diagnostics-preview-e2e',
        stateHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        preserveLegacySnapshot: true
      })
    );
    expect(dependencies.recordWorkerLiveness).toHaveBeenCalledWith({
      workerId: sentinels.workerId,
      healthStatus: 'degraded',
      lastSeenAt: now
    });
    expect(dependencies.closeDatabase).toHaveBeenCalledTimes(1);

    const serializedResult = JSON.stringify(result);
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      command: 'seed',
      runId: RUN_ID,
      jobId: JOB_ID,
      workerId: sentinels.workerId,
      sentinelSha256: {
        prompt: expect.stringMatching(/^[0-9a-f]{64}$/u),
        result: expect.stringMatching(/^[0-9a-f]{64}$/u),
        error: expect.stringMatching(/^[0-9a-f]{64}$/u),
        workersDirectory: expect.stringMatching(/^[0-9a-f]{64}$/u)
      },
      seeded: {
        job: true,
        runtimeSnapshot: true,
        runtimeState: true,
        liveness: true
      }
    }));
    expect(serializedResult).not.toContain(sentinels.prompt);
    expect(serializedResult).not.toContain(sentinels.result);
    expect(serializedResult).not.toContain(sentinels.error);
    expect(serializedResult).not.toContain(sentinels.workersDirectory);
    expect(serializedResult).not.toContain('fixture-password');
  });

  it('rejects reuse of a run identity before creating a job', async () => {
    const dependencies = buildDependencies({
      query: jest.fn(async () => ({
        rows: [{ fixture_exists: true }]
      }))
    });

    await expect(runFixtureCommand(
      buildOptions(),
      buildEnvironment(),
      dependencies
    )).rejects.toMatchObject({
      code: FIXTURE_ERROR_CODES.RUN_ID_ALREADY_EXISTS
    });
    expect(dependencies.createJob).not.toHaveBeenCalled();
    expect(dependencies.query).toHaveBeenCalledTimes(1);
    expect(dependencies.closeDatabase).toHaveBeenCalledTimes(1);
  });

  it('attempts exact cleanup when seeding fails after job creation', async () => {
    const dependencies = buildDependencies({
      upsertWorkerRuntimeState: jest.fn(async () => {
        throw new Error(
          'postgresql://should-never-be-emitted@postgres.railway.internal/fixture'
        );
      })
    });

    await expect(runFixtureCommand(
      buildOptions(),
      buildEnvironment(),
      dependencies
    )).rejects.toThrow(/should-never-be-emitted/u);

    const cleanupCall = dependencies.query.mock.calls.find(
      ([sql]) => sql.includes('worker_diagnostics_fixture_cleanup') === false
        && sql.includes('deleted_events')
    );
    expect(cleanupCall).toBeDefined();
    expect(cleanupCall[1]).toEqual([
      'worker-diagnostics-e2e-1412-0123456789abcdef',
      `worker-diagnostics-preview-e2e:${RUN_ID}`,
      'worker-diagnostics-preview-e2e',
      RUN_ID
    ]);
    expect(dependencies.closeDatabase).toHaveBeenCalledTimes(1);
  });

  it('cleanup uses exact job and worker predicates and returns booleans only', async () => {
    const query = jest.fn(async () => ({
      rows: [{
        deleted_events: true,
        deleted_job: true,
        deleted_history: false,
        deleted_state: true,
        deleted_snapshot: true,
        deleted_liveness: true
      }]
    }));
    const sentinels = buildFixtureSentinels(RUN_ID, PR_NUMBER);

    const removed = await cleanupFixture(query, sentinels, {
      sleepFn: async () => {}
    });
    const [sql, params] = query.mock.calls[0];

    expect(sql).toContain("job_type = 'ask'");
    expect(sql).toContain("input->>'fixtureKind' = $3");
    expect(sql).toContain("input->>'runId' = $4");
    expect(sql).toContain('WHERE worker_id = $1');
    expect(sql).toContain('WHERE worker_id = $1\n          OR job_id IN');
    expect(params).toEqual([
      sentinels.workerId,
      sentinels.correlationId,
      'worker-diagnostics-preview-e2e',
      RUN_ID
    ]);
    expect(removed).toEqual({
      events: true,
      job: true,
      history: false,
      state: true,
      snapshot: true,
      liveness: true
    });
  });

  it('runs cleanup mode without invoking seed repositories', async () => {
    const dependencies = buildDependencies();
    const result = await runFixtureCommand(
      buildOptions('cleanup'),
      buildEnvironment(),
      dependencies
    );

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      command: 'cleanup',
      runId: RUN_ID,
      removed: {
        events: true,
        job: true,
        history: true,
        state: true,
        snapshot: true,
        liveness: true
      }
    }));
    expect(dependencies.createJob).not.toHaveBeenCalled();
    expect(dependencies.updateJob).not.toHaveBeenCalled();
    expect(dependencies.upsertWorkerRuntimeSnapshot).not.toHaveBeenCalled();
    expect(dependencies.closeDatabase).toHaveBeenCalledTimes(1);
  });

  it('does not initialize the database when target validation fails', async () => {
    const dependencies = buildDependencies();

    await expect(runFixtureCommand(
      buildOptions(),
      buildEnvironment({ RAILWAY_ENVIRONMENT_NAME: 'production' }),
      dependencies
    )).rejects.toMatchObject({
      code: FIXTURE_ERROR_CODES.ENVIRONMENT_NAME_UNSAFE
    });
    expect(dependencies.initializeDatabaseWithSchema).not.toHaveBeenCalled();
    expect(dependencies.closeDatabase).not.toHaveBeenCalled();
  });

  it('prints only a bounded error code when CLI validation fails', () => {
    const privateDatabaseValue =
      `postgresql://fixture-user:cli-output-secret@${AUTHORIZED_RAILWAY_DATABASE_HOST}:5432/fixture`;
    const result = spawnSync(
      process.execPath,
      [
        SCRIPT_PATH,
        '--seed',
        '--execute',
        '--pr-number', String(PR_NUMBER),
        '--run-id', RUN_ID,
        '--expected-project-id', PROJECT_ID,
        '--expected-environment-id', ENVIRONMENT_ID,
        '--expected-service-id', SERVICE_ID
      ],
      {
        encoding: 'utf8',
        env: buildEnvironment({
          RAILWAY_ENVIRONMENT_NAME: 'production',
          DATABASE_URL: privateDatabaseValue
        })
      }
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe(
      FIXTURE_ERROR_CODES.ENVIRONMENT_NAME_UNSAFE
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain(privateDatabaseValue);
    expect(`${result.stdout}${result.stderr}`).not.toContain('cli-output-secret');
  });
});
