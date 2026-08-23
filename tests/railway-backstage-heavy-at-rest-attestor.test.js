import { describe, expect, it, jest } from '@jest/globals';

import {
  BACKSTAGE_HEAVY_AT_REST_TARGET,
  resolveBackstageHeavyAtRestConfig,
  runBackstageHeavyAtRestAttestor,
} from '../scripts/railway-backstage-heavy-at-rest-attestor.mjs';
import {
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_COMPLETED_OUTPUT,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_PARTIAL_OUTPUT,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_PROMPT_SENTINEL,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_SDK_KEY,
} from '../scripts/railway-backstage-heavy-openai-fixture.mjs';

const IDS = {
  project: '11111111-1111-4111-8111-111111111111',
  environment: '22222222-2222-4222-8222-222222222222',
  worker: '44444444-4444-4444-8444-444444444444',
  deployment: '55555555-5555-4555-8555-555555555555',
  postgres: '66666666-6666-4666-8666-666666666666',
  redis: '77777777-7777-4777-8777-777777777777',
  job: '88888888-8888-4888-8888-888888888888',
};

const SOURCE_SHA = 'a'.repeat(40);
const RUN_ID = 'run-proof-001';
const REQUEST_ID = 'request-proof-a';
const TRACE_ID = 'trace-proof-a';
const DATABASE_URL =
  'postgresql://proof-user:proof-password@postgres.railway.internal:5432/railway';
const PAYLOAD_KEY = Buffer.alloc(32, 0x42).toString('base64');

function buildArguments({ execute = false, overrides = {} } = {}) {
  const values = {
    target: BACKSTAGE_HEAVY_AT_REST_TARGET,
    'project-id': IDS.project,
    'environment-id': IDS.environment,
    'environment-name': 'backstage-heavy-pr-1460-e2e',
    'worker-service-id': IDS.worker,
    'worker-deployment-id': IDS.deployment,
    'postgres-service-id': IDS.postgres,
    'postgres-service-name': 'Postgres',
    'postgres-internal-host': 'postgres.railway.internal',
    'redis-service-id': IDS.redis,
    'redis-service-name': 'Redis',
    'redis-internal-host': 'redis.railway.internal',
    'source-sha': SOURCE_SHA,
    'run-id': RUN_ID,
    'job-id': IDS.job,
    'request-id': REQUEST_ID,
    'trace-id': TRACE_ID,
    ...overrides,
  };
  const args = Object.entries(values).flatMap(([name, value]) => [
    `--${name}`,
    value,
  ]);
  if (execute) {
    args.push('--execute', '--allow-database-read');
  }
  return args;
}

function buildRuntimeEnvironment(overrides = {}) {
  return {
    ARCANOS_BACKSTAGE_HEAVY_PROOF_TARGET:
      'dedicated-backstage-heavy-preview-v1',
    ARCANOS_BACKSTAGE_HEAVY_PROOF_RUN_ID: RUN_ID,
    ARCANOS_PREVIEW_OPENAI_FIXTURE:
      'backstage-heavy-compact-retry-v1',
    ARCANOS_PROCESS_KIND: 'worker',
    ARCANOS_PREVIEW_ISOLATION: 'true',
    FORCE_MOCK: 'true',
    ALLOW_MOCK_OPENAI: 'true',
    OPENAI_API_KEY_REQUIRED: 'false',
    ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY: PAYLOAD_KEY,
    NODE_ENV: 'production',
    OPENAI_BASE_URL: 'http://127.0.0.1:8766/v1',
    DATABASE_URL,
    REDIS_URL:
      'redis://default:proof-password@redis.railway.internal:6379',
    RAILWAY_PROJECT_ID: IDS.project,
    RAILWAY_PROJECT_NAME: 'arc-pr1460-heavy-test',
    RAILWAY_ENVIRONMENT_ID: IDS.environment,
    RAILWAY_ENVIRONMENT_NAME: 'backstage-heavy-pr-1460-e2e',
    RAILWAY_SERVICE_ID: IDS.worker,
    RAILWAY_SERVICE_NAME: 'arcanos-worker-pr1460-heavy',
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
    ...overrides,
  };
}

function completeDatabaseEvidence(overrides = {}) {
  return {
    total_job_rows: 1,
    total_event_rows: 11,
    target_exists: true,
    terminal_valid: true,
    derived_idempotency_valid: true,
    protected_input_valid: true,
    protected_output_valid: true,
    plaintext_absent: true,
    total_count: 11,
    created_count: 1,
    queued_count: 1,
    claimed_count: 1,
    started_count: 1,
    ai_started_count: 2,
    ai_completed_count: 2,
    heartbeat_count: 2,
    completed_count: 1,
    failure_count: 0,
    unexpected_count: 0,
    trace_mismatch_count: 0,
    worker_mismatch_count: 0,
    ai_model_mismatch_count: 0,
    ai_context_mismatch_count: 0,
    maximum_ai_duration_ms: 12_000,
    heartbeat_span_ms: 5_000,
    lifecycle_time_ordered: true,
    ...overrides,
  };
}

function completeFixtureEvidence(overrides = {}) {
  return {
    schemaVersion: 1,
    fixture: 'backstage-heavy-compact-retry-v1',
    ready: true,
    responsePhase: 'second_complete',
    modelsListCalls: 1,
    responsesCalls: 2,
    firstResponseIncomplete: true,
    secondResponseCompleted: true,
    firstRecoveryMarkerAbsent: true,
    secondRecoveryMarkerObserved: true,
    secondRequestExcludedPartialOutput: true,
    promptSentinelObserved: true,
    bookingDirectiveObserved: true,
    runMarkerObserved: true,
    thirdResponseRejected: 0,
    unknownRequests: 0,
    authorizationFailures: 0,
    invalidRequests: 0,
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  return {
    status,
    body: {
      async *[Symbol.asyncIterator]() {
        yield payload;
      },
    },
  };
}

function createClientHarness(onQuery) {
  const harness = { instances: [] };
  harness.Client = class FakeClient {
    constructor(config) {
      this.config = config;
      this.connected = 0;
      this.ended = 0;
      this.queries = [];
      harness.instances.push(this);
    }

    async connect() {
      this.connected += 1;
    }

    async query(sql, params) {
      this.queries.push({ sql, params });
      return onQuery(sql, params, this);
    }

    async end() {
      this.ended += 1;
    }
  };
  return harness;
}

function createSuccessfulClientHarness(row = completeDatabaseEvidence()) {
  return createClientHarness(async (sql) => {
    if (sql === 'SHOW transaction_read_only') {
      return { rows: [{ transaction_read_only: 'on' }] };
    }
    if (sql.includes('WITH target AS')) {
      return { rows: [row] };
    }
    return { rows: [] };
  });
}

describe('Backstage heavy at-rest attestor', () => {
  it('keeps dry-run mode free of database and loopback effects', async () => {
    const config = resolveBackstageHeavyAtRestConfig(buildArguments());
    const Client = jest.fn(() => {
      throw new Error('dry-run must not construct a database client');
    });
    const fetchImpl = jest.fn(() => {
      throw new Error('dry-run must not issue a loopback request');
    });

    await expect(runBackstageHeavyAtRestAttestor(config, {
      Client,
      fetchImpl,
    })).resolves.toMatchObject({
      mode: 'dry-run',
      databaseReads: 0,
      loopbackRequests: 0,
      target: BACKSTAGE_HEAVY_AT_REST_TARGET,
    });
    expect(Client).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [['--execute'], 'BACKSTAGE_HEAVY_AT_REST_DATABASE_GATES_REQUIRED'],
    [['--allow-database-read'], 'BACKSTAGE_HEAVY_AT_REST_DATABASE_GATES_REQUIRED'],
    [['--unknown', 'value'], 'BACKSTAGE_HEAVY_AT_REST_ARGUMENT_UNKNOWN'],
  ])('rejects invalid config or gate additions %j', (addition, errorCode) => {
    expect(() => resolveBackstageHeavyAtRestConfig([
      ...buildArguments(),
      ...addition,
    ])).toThrow(errorCode);
  });

  it('rejects a runtime identity mismatch before database or loopback access', async () => {
    const config = resolveBackstageHeavyAtRestConfig(
      buildArguments({ execute: true })
    );
    const Client = jest.fn(() => {
      throw new Error('identity rejection must precede database access');
    });
    const fetchImpl = jest.fn(() => {
      throw new Error('identity rejection must precede loopback access');
    });

    await expect(runBackstageHeavyAtRestAttestor(config, {
      Client,
      env: buildRuntimeEnvironment({ RAILWAY_GIT_COMMIT_SHA: 'b'.repeat(40) }),
      fetchImpl,
    })).rejects.toThrow('BACKSTAGE_HEAVY_AT_REST_RUNTIME_IDENTITY_MISMATCH');
    expect(Client).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('attests one complete row through an exact read-only transaction and fixture read', async () => {
    const config = resolveBackstageHeavyAtRestConfig(
      buildArguments({ execute: true })
    );
    const harness = createSuccessfulClientHarness();
    const fetchImpl = jest.fn(async () => jsonResponse(completeFixtureEvidence()));

    await expect(runBackstageHeavyAtRestAttestor(config, {
      Client: harness.Client,
      env: buildRuntimeEnvironment(),
      fetchImpl,
    })).resolves.toMatchObject({
      mode: 'attested',
      singleJobRow: true,
      derivedIdempotencyAttested: true,
      protectedAtRest: true,
      terminalLeaseCleared: true,
      heartbeatRenewals: 2,
      heartbeatSpanMs: 5_000,
      fixtureResponsesCalls: 2,
      compactRetryAttested: true,
    });

    expect(harness.instances).toHaveLength(1);
    const [client] = harness.instances;
    expect(client.config).toEqual({
      application_name: 'arcanos_backstage_heavy_attestor_v1',
      connectionString: DATABASE_URL,
      connectionTimeoutMillis: 5_000,
      query_timeout: 5_000,
      options:
        '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000',
    });
    expect(client.connected).toBe(1);
    expect(client.ended).toBe(1);
    expect(client.queries).toHaveLength(5);
    expect(client.queries[0]).toEqual({
      sql: 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      params: undefined,
    });
    expect(client.queries[1]).toEqual({
      sql: 'SET LOCAL search_path = pg_catalog, public',
      params: undefined,
    });
    expect(client.queries[2]).toEqual({
      sql: 'SHOW transaction_read_only',
      params: undefined,
    });
    expect(client.queries[3].sql).toContain('WITH target AS');
    expect(client.queries[3].sql).toContain('FROM public.job_data');
    expect(client.queries[3].sql).toContain('FROM public.job_events');
    expect(client.queries[3].sql).not.toMatch(
      /\b(?:ALTER|CREATE|DELETE|DROP|INSERT|TRUNCATE|UPDATE)\b/iu
    );
    expect(client.queries[3].params).toEqual([
      IDS.job,
      REQUEST_ID,
      TRACE_ID,
      BACKSTAGE_HEAVY_OPENAI_FIXTURE_PROMPT_SENTINEL,
      BACKSTAGE_HEAVY_OPENAI_FIXTURE_PARTIAL_OUTPUT,
      BACKSTAGE_HEAVY_OPENAI_FIXTURE_COMPLETED_OUTPUT,
      'backstage-heavy-proof-worker-v1',
      `fixture-${RUN_ID}`,
    ]);
    expect(client.queries[4]).toEqual({ sql: 'ROLLBACK', params: undefined });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:8766/__arcanos/backstage-heavy-openai-fixture/attestation',
      expect.objectContaining({
        method: 'GET',
        headers: {
          authorization: `Bearer ${BACKSTAGE_HEAVY_OPENAI_FIXTURE_SDK_KEY}`,
        },
        redirect: 'error',
        signal: expect.anything(),
      })
    );
  });

  it('bounds polling and fails when required event evidence remains incomplete', async () => {
    const config = resolveBackstageHeavyAtRestConfig(
      buildArguments({ execute: true })
    );
    const harness = createSuccessfulClientHarness(
      completeDatabaseEvidence({ ai_completed_count: 1 })
    );
    const fetchImpl = jest.fn(async () => jsonResponse(completeFixtureEvidence()));
    let currentTime = 0;
    const sleep = jest.fn(async () => {
      currentTime = 15_000;
    });

    await expect(runBackstageHeavyAtRestAttestor(config, {
      Client: harness.Client,
      env: buildRuntimeEnvironment(),
      fetchImpl,
      now: () => currentTime,
      sleep,
    })).rejects.toThrow('BACKSTAGE_HEAVY_AT_REST_DATABASE_EVIDENCE_INCOMPLETE');

    const [client] = harness.instances;
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(250);
    expect(client.queries.filter(({ sql }) => sql.includes('WITH target AS')))
      .toHaveLength(2);
    expect(client.queries.filter(({ sql }) => sql === 'ROLLBACK'))
      .toHaveLength(2);
    expect(client.ended).toBe(1);
  });

  it('maps database query errors to a stable redacted failure', async () => {
    const config = resolveBackstageHeavyAtRestConfig(
      buildArguments({ execute: true })
    );
    const databaseFailureMarker = 'test-postgres-value-that-must-not-escape';
    const harness = createClientHarness(async (sql) => {
      if (sql === 'SHOW transaction_read_only') {
        return { rows: [{ transaction_read_only: 'on' }] };
      }
      if (sql.includes('WITH target AS')) {
        throw new Error(`query failed with ${databaseFailureMarker}`);
      }
      return { rows: [] };
    });
    const fetchImpl = jest.fn(async () => jsonResponse(completeFixtureEvidence()));

    const error = await runBackstageHeavyAtRestAttestor(config, {
      Client: harness.Client,
      env: buildRuntimeEnvironment(),
      fetchImpl,
    }).catch(caught => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('BACKSTAGE_HEAVY_AT_REST_DATABASE_READ_FAILED');
    expect(error.message).not.toContain(databaseFailureMarker);
    const [client] = harness.instances;
    expect(client.queries.filter(({ sql }) => sql === 'ROLLBACK'))
      .toHaveLength(1);
    expect(client.ended).toBe(1);
  });

  it('maps fixture transport errors to a stable redacted failure', async () => {
    const config = resolveBackstageHeavyAtRestConfig(
      buildArguments({ execute: true })
    );
    const harness = createSuccessfulClientHarness();
    const fixtureFailureMarker = 'test-fixture-value-that-must-not-escape';
    const fetchImpl = jest.fn(async () => {
      throw new Error(`loopback failed with ${fixtureFailureMarker}`);
    });

    const error = await runBackstageHeavyAtRestAttestor(config, {
      Client: harness.Client,
      env: buildRuntimeEnvironment(),
      fetchImpl,
    }).catch(caught => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('BACKSTAGE_HEAVY_AT_REST_FIXTURE_READ_FAILED');
    expect(error.message).not.toContain(fixtureFailureMarker);
    await new Promise(resolve => setImmediate(resolve));
    expect(harness.instances[0].ended).toBe(1);
  });
});
