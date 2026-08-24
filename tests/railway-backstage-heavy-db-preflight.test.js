import { describe, expect, it, jest } from '@jest/globals';

import {
  BACKSTAGE_HEAVY_DB_PREFLIGHT_EMPTY_SUCCESS,
  BACKSTAGE_HEAVY_DB_PREFLIGHT_ERROR,
  BACKSTAGE_HEAVY_DB_PREFLIGHT_SCHEMA_SUCCESS,
  attestBackstageHeavyDbPreflightRuntime,
  main,
  resolveBackstageHeavyDbPreflightConfig,
  runBackstageHeavyDbPreflight,
} from '../scripts/railway-backstage-heavy-db-preflight.mjs';

const IDS = {
  project: '11111111-1111-4111-8111-111111111111',
  environment: '22222222-2222-4222-8222-222222222222',
  web: '33333333-3333-4333-8333-333333333333',
  worker: '44444444-4444-4444-8444-444444444444',
  deployment: '55555555-5555-4555-8555-555555555555',
  postgres: '66666666-6666-4666-8666-666666666666',
  redis: '77777777-7777-4777-8777-777777777777',
};

const SOURCE_SHA = 'a'.repeat(40);
const DATABASE_URL =
  'postgresql://proof-user:credential-sentinel@postgres.railway.internal:5432/railway';
const PAYLOAD_KEY = Buffer.alloc(32, 0x42).toString('base64');

function buildEnvironment(processKind = 'worker', overrides = {}) {
  return {
    ARCANOS_BACKSTAGE_HEAVY_PROOF_TARGET:
      'dedicated-backstage-heavy-preview-v1',
    ARCANOS_BACKSTAGE_HEAVY_PROOF_RUN_ID: 'proof-run-1460',
    ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA: SOURCE_SHA,
    ARCANOS_PROCESS_KIND: processKind,
    ARCANOS_PREVIEW_ISOLATION: 'true',
    FORCE_MOCK: 'true',
    ALLOW_MOCK_OPENAI: 'true',
    OPENAI_API_KEY_REQUIRED: 'false',
    ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY: PAYLOAD_KEY,
    NODE_ENV: 'production',
    OPENAI_BASE_URL: processKind === 'worker'
      ? 'http://127.0.0.1:8766/v1'
      : 'http://127.0.0.1:9/v1',
    DATABASE_URL,
    REDIS_URL:
      'redis://default:proof-password@redis.railway.internal:6379',
    RAILWAY_PROJECT_ID: IDS.project,
    RAILWAY_PROJECT_NAME: 'arc-pr1460-heavy-test',
    RAILWAY_ENVIRONMENT_ID: IDS.environment,
    RAILWAY_ENVIRONMENT_NAME: 'backstage-heavy-pr-1460-e2e',
    RAILWAY_SERVICE_ID: processKind === 'worker' ? IDS.worker : IDS.web,
    RAILWAY_SERVICE_NAME: `arcanos-${processKind}-pr1460-heavy`,
    RAILWAY_DEPLOYMENT_ID: IDS.deployment,
    RAILWAY_GIT_COMMIT_SHA: SOURCE_SHA,
    ARCANOS_BACKSTAGE_HEAVY_POSTGRES_SERVICE_ID: IDS.postgres,
    ARCANOS_BACKSTAGE_HEAVY_POSTGRES_SERVICE_NAME: 'Postgres',
    ARCANOS_BACKSTAGE_HEAVY_POSTGRES_INTERNAL_HOST:
      'postgres.railway.internal',
    ARCANOS_BACKSTAGE_HEAVY_REDIS_SERVICE_ID: IDS.redis,
    ARCANOS_BACKSTAGE_HEAVY_REDIS_SERVICE_NAME: 'Redis',
    ARCANOS_BACKSTAGE_HEAVY_REDIS_INTERNAL_HOST:
      'redis.railway.internal',
    ...(processKind === 'worker'
      ? {
          ARCANOS_PREVIEW_OPENAI_FIXTURE:
            'backstage-heavy-compact-retry-v1',
        }
      : {
          ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED: 'true',
          ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN:
            'proof-only-fictional-access-token-0001',
          ARCANOS_JOB_READ_CAPABILITY_SECRET:
            'proof-only-fictional-job-read-secret-0001',
        }),
    ...overrides,
  };
}

function buildClientHarness(options = {}) {
  const state = {
    config: null,
    events: [],
  };
  class Client {
    constructor(config) {
      state.config = config;
    }

    async connect() {
      state.events.push('connect');
      if (options.connectError) throw options.connectError;
    }

    async query(sql) {
      state.events.push(sql);
      if (options.queryErrorPattern?.test(sql)) {
        throw options.queryError;
      }
      if (sql === 'SHOW transaction_read_only') {
        return {
          rows: [{
            transaction_read_only: options.transactionReadOnly ?? 'on',
          }],
        };
      }
      if (sql.includes('current_database()')) {
        return {
          rows: [{ database_valid: options.databaseValid ?? true }],
        };
      }
      if (sql === 'ROLLBACK' && options.rollbackError) {
        throw options.rollbackError;
      }
      if (sql.includes('AS user_table_count')) {
        return { rows: [{ user_table_count: options.userTableCount ?? 0 }] };
      }
      if (sql.includes("tablename = 'job_data'")) {
        return {
          rows: [{
            job_data_exists: options.jobDataExists ?? true,
            job_events_exists: options.jobEventsExists ?? true,
          }],
        };
      }
      if (sql.includes('COUNT(*)::integer FROM public.job_data')) {
        return {
          rows: [{
            job_count: options.jobCount ?? 0,
            event_count: options.eventCount ?? 0,
          }],
        };
      }
      return { rows: [] };
    }

    async end() {
      state.events.push('end');
      if (options.endError) throw options.endError;
    }
  }
  return { Client, state };
}

function expectOnlyReadOnlySql(state) {
  expect(state.events.join('\n')).not.toMatch(
    /\b(?:ALTER|CREATE|DELETE|DROP|GRANT|INSERT|REVOKE|TRUNCATE|UPDATE)\b/iu
  );
}

describe('sealed Backstage heavy database preflight', () => {
  it('accepts only one exact empty or schema mode', () => {
    expect(resolveBackstageHeavyDbPreflightConfig(
      ['--mode', 'empty']
    )).toEqual({ mode: 'empty', processKind: 'worker' });
    expect(resolveBackstageHeavyDbPreflightConfig(
      ['--mode', 'schema']
    )).toEqual({ mode: 'schema', processKind: 'web' });

    for (const args of [
      [],
      ['--mode'],
      ['--mode', 'other'],
      ['--mode', 'empty', '--execute'],
      ['--other', 'empty'],
    ]) {
      expect(() => resolveBackstageHeavyDbPreflightConfig(args)).toThrow(
        'BACKSTAGE_HEAVY_DB_PREFLIGHT_ARGUMENT_INVALID'
      );
    }
  });

  it('binds mode to the exact sealed Railway application and Postgres identity', () => {
    expect(attestBackstageHeavyDbPreflightRuntime(
      resolveBackstageHeavyDbPreflightConfig(['--mode', 'empty']),
      buildEnvironment('worker')
    )).toMatchObject({
      processKind: 'worker',
      projectId: IDS.project,
      environmentId: IDS.environment,
      serviceId: IDS.worker,
      postgresServiceId: IDS.postgres,
      sourceCommit: SOURCE_SHA,
    });
    expect(attestBackstageHeavyDbPreflightRuntime(
      resolveBackstageHeavyDbPreflightConfig(['--mode', 'schema']),
      buildEnvironment('web')
    )).toMatchObject({ processKind: 'web', serviceId: IDS.web });

    const withoutRailwayGitSha = buildEnvironment('worker');
    delete withoutRailwayGitSha.RAILWAY_GIT_COMMIT_SHA;
    expect(attestBackstageHeavyDbPreflightRuntime(
      resolveBackstageHeavyDbPreflightConfig(['--mode', 'empty']),
      withoutRailwayGitSha
    )).toMatchObject({ sourceCommit: SOURCE_SHA });

    expect(() => attestBackstageHeavyDbPreflightRuntime(
      resolveBackstageHeavyDbPreflightConfig(['--mode', 'empty']),
      buildEnvironment('web')
    )).toThrow(/BACKSTAGE_HEAVY_/u);
    expect(() => attestBackstageHeavyDbPreflightRuntime(
      resolveBackstageHeavyDbPreflightConfig(['--mode', 'empty']),
      buildEnvironment('worker', {
        RAILWAY_GIT_COMMIT_SHA: 'not-a-source-sha',
      })
    )).toThrow(/BACKSTAGE_HEAVY_/u);
  });

  it.each([
    { mode: 'empty', processKind: 'web' },
    { mode: 'schema', processKind: 'worker' },
    { mode: 'bogus', processKind: 'worker' },
  ])('rejects a forged imported-core mode/role pair', config => {
    expect(() => attestBackstageHeavyDbPreflightRuntime(
      config,
      buildEnvironment(config.processKind)
    )).toThrow('BACKSTAGE_HEAVY_DB_PREFLIGHT_ARGUMENT_INVALID');
  });

  it.each([
    'postgresql://proof:secret@public.invalid:5432/railway',
    'postgresql://proof:secret@postgres.railway.internal:5433/railway',
    'postgresql://proof:secret@postgres.railway.internal:5432/shared',
    'postgresql://proof@postgres.railway.internal:5432/railway',
  ])('rejects a non-exact private database URL without opening a client', async databaseUrl => {
    const Client = jest.fn();
    const config = resolveBackstageHeavyDbPreflightConfig(['--mode', 'empty']);
    await expect(runBackstageHeavyDbPreflight(
      config,
      {
        Client,
        env: buildEnvironment('worker', { DATABASE_URL: databaseUrl }),
      }
    )).rejects.toThrow(/BACKSTAGE_HEAVY_/u);
    expect(Client).not.toHaveBeenCalled();
  });

  it('proves an empty database with an exact read-only query sequence', async () => {
    const { Client, state } = buildClientHarness();
    await expect(runBackstageHeavyDbPreflight(
      resolveBackstageHeavyDbPreflightConfig(['--mode', 'empty']),
      { Client, env: buildEnvironment('worker') }
    )).resolves.toBe(BACKSTAGE_HEAVY_DB_PREFLIGHT_EMPTY_SUCCESS);

    expect(state.config).toEqual({
      application_name: 'arcanos_backstage_heavy_db_preflight_empty_v1',
      connectionString: DATABASE_URL,
      connectionTimeoutMillis: 5_000,
      query_timeout: 5_000,
      options:
        '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000',
    });
    expect(state.events[0]).toBe('connect');
    expect(state.events[1]).toBe(
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'
    );
    expect(state.events[2]).toBe(
      'SET LOCAL search_path = pg_catalog, public'
    );
    expect(state.events[3]).toBe('SHOW transaction_read_only');
    expect(state.events[4]).toContain('current_database()');
    expect(state.events[5]).toContain('FROM pg_catalog.pg_tables');
    expect(state.events[5]).toContain("schemaname NOT LIKE 'pg_temp_%'");
    expect(state.events.slice(-2)).toEqual(['ROLLBACK', 'end']);
    expectOnlyReadOnlySql(state);
  });

  it('proves the worker-created empty job schema in a read-only transaction', async () => {
    const { Client, state } = buildClientHarness();
    await expect(runBackstageHeavyDbPreflight(
      resolveBackstageHeavyDbPreflightConfig(['--mode', 'schema']),
      { Client, env: buildEnvironment('web') }
    )).resolves.toBe(BACKSTAGE_HEAVY_DB_PREFLIGHT_SCHEMA_SUCCESS);

    expect(state.events).toEqual([
      'connect',
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      'SET LOCAL search_path = pg_catalog, public',
      'SHOW transaction_read_only',
      expect.stringContaining('current_database()'),
      expect.stringContaining("tablename = 'job_data'"),
      expect.stringContaining('COUNT(*)::integer FROM public.job_data'),
      'ROLLBACK',
      'end',
    ]);
    expectOnlyReadOnlySql(state);
  });

  it('fails closed for writable, nonempty, missing, or populated state', async () => {
    const cases = [
      {
        mode: 'empty',
        processKind: 'worker',
        options: { transactionReadOnly: 'off' },
        code: 'BACKSTAGE_HEAVY_DB_PREFLIGHT_DATABASE_NOT_READ_ONLY',
      },
      {
        mode: 'empty',
        processKind: 'worker',
        options: { databaseValid: false },
        code: 'BACKSTAGE_HEAVY_DB_PREFLIGHT_DATABASE_IDENTITY_INVALID',
      },
      {
        mode: 'empty',
        processKind: 'worker',
        options: { userTableCount: 1 },
        code: 'BACKSTAGE_HEAVY_DB_PREFLIGHT_DATABASE_NOT_EMPTY',
      },
      {
        mode: 'schema',
        processKind: 'web',
        options: { jobDataExists: false },
        code: 'BACKSTAGE_HEAVY_DB_PREFLIGHT_SCHEMA_INVALID',
      },
      {
        mode: 'schema',
        processKind: 'web',
        options: { eventCount: 1 },
        code: 'BACKSTAGE_HEAVY_DB_PREFLIGHT_SCHEMA_INVALID',
      },
    ];
    for (const testCase of cases) {
      const { Client, state } = buildClientHarness(testCase.options);
      await expect(runBackstageHeavyDbPreflight(
        resolveBackstageHeavyDbPreflightConfig([
          '--mode',
          testCase.mode,
        ]),
        { Client, env: buildEnvironment(testCase.processKind) }
      )).rejects.toThrow(testCase.code);
      expect(state.events).toContain('ROLLBACK');
      expect(state.events.at(-1)).toBe('end');
    }
  });

  it('emits only fixed sentinels and redacts database errors and secrets', async () => {
    const successOut = { write: jest.fn() };
    const successErr = { write: jest.fn() };
    const successClient = buildClientHarness();
    await expect(main({
      args: ['--mode', 'empty'],
      Client: successClient.Client,
      env: buildEnvironment('worker'),
      stdout: successOut,
      stderr: successErr,
    })).resolves.toBe(0);
    expect(successOut.write).toHaveBeenCalledWith(
      `${BACKSTAGE_HEAVY_DB_PREFLIGHT_EMPTY_SUCCESS}\n`
    );
    expect(successErr.write).not.toHaveBeenCalled();

    const failureOut = { write: jest.fn() };
    const failureErr = { write: jest.fn() };
    const failureClient = buildClientHarness({
      connectError: new Error(
        'postgresql://secret-user:secret-password@host/private'
      ),
    });
    await expect(main({
      args: ['--mode', 'schema'],
      Client: failureClient.Client,
      env: buildEnvironment('web'),
      stdout: failureOut,
      stderr: failureErr,
    })).resolves.toBe(1);
    expect(failureOut.write).not.toHaveBeenCalled();
    expect(failureErr.write).toHaveBeenCalledWith(
      'BACKSTAGE_HEAVY_DB_PREFLIGHT_DATABASE_FAILED\n'
    );
    expect(failureErr.write.mock.calls.flat().join('')).not.toContain(
      'secret-password'
    );
  });

  it('emits exact known failures but rejects prefixed attacker-controlled text', async () => {
    const knownOut = { write: jest.fn() };
    const knownErr = { write: jest.fn() };
    await expect(main({
      args: ['--mode', 'empty'],
      Client: buildClientHarness({ userTableCount: 1 }).Client,
      env: buildEnvironment('worker'),
      stdout: knownOut,
      stderr: knownErr,
    })).resolves.toBe(1);
    expect(knownOut.write).not.toHaveBeenCalled();
    expect(knownErr.write).toHaveBeenCalledWith(
      'BACKSTAGE_HEAVY_DB_PREFLIGHT_DATABASE_NOT_EMPTY\n'
    );

    const identityOut = { write: jest.fn() };
    const identityErr = { write: jest.fn() };
    const missingSourceEnvironment = buildEnvironment('worker');
    delete missingSourceEnvironment.ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA;
    await expect(main({
      args: ['--mode', 'empty'],
      Client: buildClientHarness().Client,
      env: missingSourceEnvironment,
      stdout: identityOut,
      stderr: identityErr,
    })).resolves.toBe(1);
    expect(identityOut.write).not.toHaveBeenCalled();
    expect(identityErr.write).toHaveBeenCalledWith(
      'BACKSTAGE_HEAVY_DB_PREFLIGHT_RUNTIME_IDENTITY_MISMATCH\n'
    );

    const sensitiveMarker = 'credential-sentinel-should-not-escape';
    const attackerOut = { write: jest.fn() };
    const attackerErr = { write: jest.fn() };
    await expect(main({
      args: ['--mode', 'empty'],
      Client: buildClientHarness({
        connectError: new Error(
          `BACKSTAGE_HEAVY_DB_PREFLIGHT_DATABASE_FAILED:${sensitiveMarker}`
        ),
      }).Client,
      env: buildEnvironment('worker'),
      stdout: attackerOut,
      stderr: attackerErr,
    })).resolves.toBe(1);
    expect(attackerOut.write).not.toHaveBeenCalled();
    expect(attackerErr.write).toHaveBeenCalledWith(
      'BACKSTAGE_HEAVY_DB_PREFLIGHT_DATABASE_FAILED\n'
    );
    expect(attackerErr.write.mock.calls.flat().join('')).not.toContain(
      sensitiveMarker
    );

    const forgedOut = { write: jest.fn() };
    const forgedErr = { write: jest.fn() };
    await expect(main({
      args: ['--mode', 'empty'],
      Client: buildClientHarness({
        connectError: new Error(
          'BACKSTAGE_HEAVY_DB_PREFLIGHT_DATABASE_NOT_EMPTY'
        ),
      }).Client,
      env: buildEnvironment('worker'),
      stdout: forgedOut,
      stderr: forgedErr,
    })).resolves.toBe(1);
    expect(forgedOut.write).not.toHaveBeenCalled();
    expect(forgedErr.write).toHaveBeenCalledWith(
      'BACKSTAGE_HEAVY_DB_PREFLIGHT_DATABASE_FAILED\n'
    );

    const unknownOut = {
      write: jest.fn(() => {
        throw new Error('unexpected-stream-failure');
      }),
    };
    const unknownErr = { write: jest.fn() };
    await expect(main({
      args: ['--mode', 'empty'],
      Client: buildClientHarness().Client,
      env: buildEnvironment('worker'),
      stdout: unknownOut,
      stderr: unknownErr,
    })).resolves.toBe(1);
    expect(unknownOut.write).toHaveBeenCalledWith(
      `${BACKSTAGE_HEAVY_DB_PREFLIGHT_EMPTY_SUCCESS}\n`
    );
    expect(unknownErr.write).toHaveBeenCalledWith(
      `${BACKSTAGE_HEAVY_DB_PREFLIGHT_ERROR}\n`
    );

    const forgedSinkErr = { write: jest.fn() };
    await expect(main({
      args: ['--mode', 'empty'],
      Client: buildClientHarness().Client,
      env: buildEnvironment('worker'),
      stdout: {
        write: jest.fn(() => {
          throw new Error(
            'BACKSTAGE_HEAVY_DB_PREFLIGHT_DATABASE_NOT_EMPTY'
          );
        }),
      },
      stderr: forgedSinkErr,
    })).resolves.toBe(1);
    expect(forgedSinkErr.write).toHaveBeenCalledWith(
      `${BACKSTAGE_HEAVY_DB_PREFLIGHT_ERROR}\n`
    );
  });

  it.each([
    { endError: new Error('connection credential leaked by driver') },
    { rollbackError: new Error('rollback credential leaked by driver') },
  ])('treats rollback or close failure as a sanitized preflight failure', async failure => {
    const { Client } = buildClientHarness(failure);
    await expect(runBackstageHeavyDbPreflight(
      resolveBackstageHeavyDbPreflightConfig(['--mode', 'empty']),
      { Client, env: buildEnvironment('worker') }
    )).rejects.toThrow('BACKSTAGE_HEAVY_DB_PREFLIGHT_CLEANUP_FAILED');
  });
});
