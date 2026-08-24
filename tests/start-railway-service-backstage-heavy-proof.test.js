import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { PassThrough } from 'node:stream';

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

import {
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_CHILD_ARGUMENT,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_READY_SENTINEL,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_SDK_KEY,
} from '../scripts/railway-backstage-heavy-openai-fixture.mjs';

import {
  BACKSTAGE_HEAVY_PROOF_TARGET,
  BACKSTAGE_HEAVY_PROOF_TARGET_ENV,
  BACKSTAGE_HEAVY_PROOF_SOURCE_SHA_ENV,
  buildBackstageHeavyApplicationChildEnvironment,
  buildBackstageHeavyFixtureChildEnvironment,
  preflightBackstageHeavyProofDatabase,
  resolveBackstageHeavyProofTargetOrThrow,
  runBackstageHeavyProofSupervisor,
} from '../scripts/railway-backstage-heavy-proof-supervisor.mjs';

const IDS = {
  project: '11111111-1111-4111-8111-111111111111',
  environment: '22222222-2222-4222-8222-222222222222',
  web: '33333333-3333-4333-8333-333333333333',
  worker: '44444444-4444-4444-8444-444444444444',
  deployment: '55555555-5555-4555-8555-555555555555',
  postgres: '66666666-6666-4666-8666-666666666666',
  redis: '77777777-7777-4777-8777-777777777777',
};

function buildEnvironment(processKind = 'worker') {
  const environment = {
    [BACKSTAGE_HEAVY_PROOF_TARGET_ENV]: BACKSTAGE_HEAVY_PROOF_TARGET,
    ...(processKind === 'worker'
      ? {
          ARCANOS_PREVIEW_OPENAI_FIXTURE:
            'backstage-heavy-compact-retry-v1',
        }
      : {}),
    ARCANOS_PROCESS_KIND: processKind,
    ARCANOS_PREVIEW_ISOLATION: 'true',
    FORCE_MOCK: 'true',
    ALLOW_MOCK_OPENAI: 'true',
    OPENAI_API_KEY_REQUIRED: 'false',
    NODE_ENV: 'production',
    ARCANOS_BACKSTAGE_HEAVY_PROOF_RUN_ID: 'proof-run-1460',
    [BACKSTAGE_HEAVY_PROOF_SOURCE_SHA_ENV]: 'a'.repeat(40),
    ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY: `${'A'.repeat(43)}=`,
    OPENAI_BASE_URL: processKind === 'worker'
      ? 'http://127.0.0.1:8766/v1'
      : 'http://127.0.0.1:9/v1',
    DATABASE_URL:
      'postgresql://proof-user:proof-password@postgres.railway.internal:5432/railway',
    REDIS_URL:
      'redis://default:proof-password@redis.railway.internal:6379',
    RAILWAY_PROJECT_ID: IDS.project,
    RAILWAY_PROJECT_NAME: 'arc-pr1460-heavy-test',
    RAILWAY_ENVIRONMENT_ID: IDS.environment,
    RAILWAY_ENVIRONMENT_NAME: 'backstage-heavy-pr-1460-e2e',
    RAILWAY_SERVICE_ID: processKind === 'worker' ? IDS.worker : IDS.web,
    RAILWAY_SERVICE_NAME: `arcanos-${processKind}-pr1460-heavy`,
    RAILWAY_DEPLOYMENT_ID: IDS.deployment,
    RAILWAY_GIT_COMMIT_SHA: 'a'.repeat(40),
    ARCANOS_BACKSTAGE_HEAVY_POSTGRES_SERVICE_ID: IDS.postgres,
    ARCANOS_BACKSTAGE_HEAVY_POSTGRES_SERVICE_NAME: 'Postgres',
    ARCANOS_BACKSTAGE_HEAVY_POSTGRES_INTERNAL_HOST:
      'postgres.railway.internal',
    ARCANOS_BACKSTAGE_HEAVY_REDIS_SERVICE_ID: IDS.redis,
    ARCANOS_BACKSTAGE_HEAVY_REDIS_SERVICE_NAME: 'Redis',
    ARCANOS_BACKSTAGE_HEAVY_REDIS_INTERNAL_HOST: 'redis.railway.internal',
  };
  if (processKind === 'web') {
    environment.ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED = 'true';
    environment.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN =
      'proof-only-fictional-access-token-0001';
    environment.ARCANOS_JOB_READ_CAPABILITY_SECRET =
      'proof-only-fictional-job-read-secret-0001';
  }
  return environment;
}

class PreflightClient {
  static relationRow = {
    job_data_exists: false,
    job_events_exists: false,
  };

  static countRow = { job_count: 0, event_count: 0 };

  static queries = [];

  constructor(config) {
    this.config = config;
  }

  async connect() {}

  async end() {}

  async query(sql) {
    PreflightClient.queries.push(sql);
    if (sql === 'SHOW transaction_read_only') {
      return { rows: [{ transaction_read_only: 'on' }] };
    }
    if (sql.includes("to_regclass('public.job_data')")) {
      return { rows: [PreflightClient.relationRow] };
    }
    if (sql.includes('COUNT(*)::integer FROM public.job_data')) {
      return { rows: [PreflightClient.countRow] };
    }
    return { rows: [] };
  }
}

class FakeChild extends EventEmitter {
  constructor(options = {}) {
    super();
    this.exitCode = null;
    this.signalCode = null;
    this.stdout = options.stdout === false ? null : new PassThrough();
    this.stderr = new PassThrough();
    this.killedSignals = [];
    this.onKill = options.onKill ?? ((signal) => {
      this.close(null, signal);
    });
    this.kill = jest.fn((signal = 'SIGTERM') => {
      this.killedSignals.push(signal);
      this.onKill(signal, this);
      return true;
    });
  }

  close(code = null, signal = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('close', code, signal);
  }
}

function makeReadyFixture(options = {}) {
  const child = new FakeChild(options);
  void Promise.resolve().then(() => {
    options.beforeReady?.();
    child.stdout.write(`${BACKSTAGE_HEAVY_OPENAI_FIXTURE_READY_SENTINEL}\n`);
  });
  return child;
}

function makeProcessRef() {
  return new EventEmitter();
}

beforeEach(() => {
  PreflightClient.queries = [];
  PreflightClient.relationRow = {
    job_data_exists: false,
    job_events_exists: false,
  };
  PreflightClient.countRow = { job_count: 0, event_count: 0 };
});

afterEach(() => {
  jest.useRealTimers();
});

describe('one-shot Backstage heavy Railway proof supervisor', () => {
  it('pins an isolated config-as-code file without overriding role pre-deploy checks', () => {
    const config = JSON.parse(readFileSync(
      new URL('../railway.backstage-heavy-proof.json', import.meta.url),
      'utf8'
    ));

    expect(config).toEqual({
      $schema: 'https://railway.app/railway.schema.json',
      deploy: {
        startCommand:
          'node scripts/railway-backstage-heavy-proof-supervisor.mjs',
      },
    });
    expect(config).not.toHaveProperty('environments');
    expect(config).not.toHaveProperty('variables');
    expect(config.deploy).not.toHaveProperty('preDeployCommand');
  });

  it('binds both roles to exact fresh private data services and accepts Redis database /', () => {
    const worker = resolveBackstageHeavyProofTargetOrThrow(
      'worker',
      buildEnvironment('worker')
    );
    const web = resolveBackstageHeavyProofTargetOrThrow(
      'web',
      buildEnvironment('web')
    );

    expect(worker).toMatchObject({
      enabled: true,
      processKind: 'worker',
      postgresServiceId: IDS.postgres,
      redisServiceId: IDS.redis,
    });
    expect(web).toMatchObject({ enabled: true, processKind: 'web' });
    expect(resolveBackstageHeavyProofTargetOrThrow('worker', {
      ...buildEnvironment('worker'),
      REDIS_URL:
        'redis://default:proof-password@redis.railway.internal:6379/',
    })).toMatchObject({ enabled: true, processKind: 'worker' });

    const withoutRailwayGitSha = buildEnvironment('worker');
    delete withoutRailwayGitSha.RAILWAY_GIT_COMMIT_SHA;
    expect(resolveBackstageHeavyProofTargetOrThrow(
      'worker',
      withoutRailwayGitSha
    )).toMatchObject({ sourceCommit: 'a'.repeat(40) });

    for (const sourceEnvironment of [
      {
        [BACKSTAGE_HEAVY_PROOF_SOURCE_SHA_ENV]: undefined,
      },
      {
        [BACKSTAGE_HEAVY_PROOF_SOURCE_SHA_ENV]: 'A'.repeat(40),
      },
      {
        [BACKSTAGE_HEAVY_PROOF_SOURCE_SHA_ENV]: ` ${'a'.repeat(40)}`,
      },
      {
        [BACKSTAGE_HEAVY_PROOF_SOURCE_SHA_ENV]: 'b'.repeat(40),
        RAILWAY_GIT_COMMIT_SHA: 'a'.repeat(40),
      },
      {
        [BACKSTAGE_HEAVY_PROOF_SOURCE_SHA_ENV]: 'a'.repeat(40),
        RAILWAY_GIT_COMMIT_SHA: '',
      },
      {
        [BACKSTAGE_HEAVY_PROOF_SOURCE_SHA_ENV]: 'a'.repeat(40),
        RAILWAY_GIT_COMMIT_SHA: 'A'.repeat(40),
      },
      {
        [BACKSTAGE_HEAVY_PROOF_SOURCE_SHA_ENV]: 'a'.repeat(40),
        RAILWAY_GIT_COMMIT_SHA: `${'a'.repeat(40)} `,
      },
    ]) {
      expect(() => resolveBackstageHeavyProofTargetOrThrow('worker', {
        ...buildEnvironment('worker'),
        ...sourceEnvironment,
      })).toThrow('BACKSTAGE_HEAVY_PROOF_TARGET_ID_INVALID');
    }
  });

  it('enforces the bounded short disposable Railway project name', () => {
    expect(resolveBackstageHeavyProofTargetOrThrow('worker', {
      ...buildEnvironment('worker'),
      RAILWAY_PROJECT_NAME: `arc-pr1460-heavy-${'a'.repeat(14)}`,
    })).toMatchObject({ projectName: `arc-pr1460-heavy-${'a'.repeat(14)}` });

    for (const projectName of [
      `arc-pr1460-heavy-${'a'.repeat(15)}`,
      'arc-pr1460-heavy-MixedCase',
      'arcanos-pr-1460-heavy-e2e-test',
    ]) {
      expect(() => resolveBackstageHeavyProofTargetOrThrow('worker', {
        ...buildEnvironment('worker'),
        RAILWAY_PROJECT_NAME: projectName,
      })).toThrow('BACKSTAGE_HEAVY_PROOF_SERVICE_IDENTITY_INVALID');
    }

    expect(() => resolveBackstageHeavyProofTargetOrThrow('worker', {
      ...buildEnvironment('worker'),
      RAILWAY_PROJECT_NAME: `arc-pr146000-heavy-${'a'.repeat(14)}`,
      RAILWAY_ENVIRONMENT_NAME: 'backstage-heavy-pr-146000-e2e',
      RAILWAY_SERVICE_NAME: 'arcanos-worker-pr146000-heavy',
    })).toThrow('BACKSTAGE_HEAVY_PROOF_SERVICE_IDENTITY_INVALID');
  });

  it.each([
    ['DATABASE_PRIVATE_URL', 'postgresql://hostile.invalid/db'],
    ['DATABASE_PUBLIC_URL', 'postgresql://hostile.invalid/db'],
    ['PGHOST', 'hostile.invalid'],
    ['REDISHOST', 'hostile.invalid'],
    ['OPENAI_API_KEY', 'sk-fixture-must-never-inherit'],
    ['AZURE_OPENAI_API_KEY', 'provider-secret-must-never-inherit'],
    ['openai_api_key', 'case-insensitive-secret'],
    ['HTTP_PROXY', 'http://hostile.invalid'],
    ['NODE_EXTRA_CA_CERTS', './hostile-root.pem'],
    ['NODE_OPTIONS', '--import=./hostile.mjs'],
    ['NODE_TLS_REJECT_UNAUTHORIZED', '0'],
    ['PGSSLMODE', 'disable'],
    ['ARCANOS_BACKSTAGE_NOTION_ACCESS_TOKEN', 'notion-secret'],
    ['ARCANOS_BACKSTAGE_NOTION_AUTHORITY_ROOTS_JSON', '{}'],
  ])('rejects conflicting alias or external-effect variable %s', (name, value) => {
    expect(() => resolveBackstageHeavyProofTargetOrThrow('worker', {
      ...buildEnvironment('worker'),
      [name]: value,
    })).toThrow(/BACKSTAGE_HEAVY_/u);
  });

  it('pins the normal worker child to one deterministic fixture consumer', () => {
    const environment = buildEnvironment('worker');
    const target = resolveBackstageHeavyProofTargetOrThrow(
      'worker',
      environment
    );
    const child = buildBackstageHeavyApplicationChildEnvironment(
      target,
      environment
    );
    expect(child).toMatchObject({
      DATABASE_URL:
        'postgresql://proof-user:proof-password@postgres.railway.internal:5432/railway?sslmode=no-verify',
      OPENAI_API_KEY: BACKSTAGE_HEAVY_OPENAI_FIXTURE_SDK_KEY,
      OPENAI_MAX_RETRIES: '0',
      GPT5_MODEL: 'gpt-5.1',
      BOOKER_WORKER_GENERATION_STAGE_TIMEOUT_MS: '80000',
      BOOKER_WORKER_TOKEN_LIMIT: '6000',
      JOB_EVENT_RECORD_HEARTBEATS: 'true',
      JOB_WORKER_CONCURRENCY: '1',
      JOB_WORKER_HEARTBEAT_MS: '5000',
      JOB_WORKER_LEASE_MS: '15000',
      JOB_WORKER_ID: 'backstage-heavy-proof-worker-v1',
      JOB_WORKER_STATS_ID: 'backstage-heavy-proof-worker-v1',
    });
    expect(environment.DATABASE_URL).toBe(
      'postgresql://proof-user:proof-password@postgres.railway.internal:5432/railway'
    );
    expect(buildBackstageHeavyFixtureChildEnvironment(target)).toEqual({
      ARCANOS_BACKSTAGE_HEAVY_OPENAI_FIXTURE_CHILD: 'v1',
      ARCANOS_BACKSTAGE_HEAVY_PROOF_RUN_ID: 'proof-run-1460',
      NODE_ENV: 'production',
      TZ: 'UTC',
    });
  });

  it('derives the TLS compatibility mode only for validated application children', () => {
    for (const processKind of ['worker', 'web']) {
      const environment = buildEnvironment(processKind);
      const target = resolveBackstageHeavyProofTargetOrThrow(
        processKind,
        environment
      );
      expect(buildBackstageHeavyApplicationChildEnvironment(
        target,
        environment
      ).DATABASE_URL).toBe(
        'postgresql://proof-user:proof-password@postgres.railway.internal:5432/railway?sslmode=no-verify'
      );
      expect(environment.DATABASE_URL).toBe(
        'postgresql://proof-user:proof-password@postgres.railway.internal:5432/railway'
      );
    }

    for (const query of ['?sslmode=no-verify', '?x=1']) {
      expect(() => resolveBackstageHeavyProofTargetOrThrow('worker', {
        ...buildEnvironment('worker'),
        DATABASE_URL:
          `postgresql://proof-user:proof-password@postgres.railway.internal:5432/railway${query}`,
      })).toThrow('BACKSTAGE_HEAVY_PROOF_DATA_URL_INVALID');
    }
  });

  it('uses read-only, role-ordered database preflights without initializing schema', async () => {
    PreflightClient.queries = [];
    PreflightClient.relationRow = {
      job_data_exists: false,
      job_events_exists: false,
    };
    const worker = resolveBackstageHeavyProofTargetOrThrow(
      'worker',
      buildEnvironment('worker')
    );
    await expect(preflightBackstageHeavyProofDatabase(worker, {
      Client: PreflightClient,
    })).resolves.toMatchObject({ mode: 'absent-job-tables' });

    PreflightClient.relationRow = {
      job_data_exists: true,
      job_events_exists: true,
    };
    PreflightClient.countRow = { job_count: 0, event_count: 0 };
    const web = resolveBackstageHeavyProofTargetOrThrow(
      'web',
      buildEnvironment('web')
    );
    await expect(preflightBackstageHeavyProofDatabase(web, {
      Client: PreflightClient,
    })).resolves.toMatchObject({
      mode: 'empty-worker-created-job-tables',
    });
    expect(PreflightClient.queries).toContain(
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'
    );
    expect(PreflightClient.queries.join('\n')).not.toMatch(/\b(?:CREATE|ALTER|INSERT|UPDATE|DELETE|TRUNCATE)\b/iu);

    PreflightClient.countRow = { job_count: 1, event_count: 0 };
    await expect(preflightBackstageHeavyProofDatabase(web, {
      Client: PreflightClient,
    })).rejects.toThrow('BACKSTAGE_HEAVY_PROOF_DATABASE_NOT_EMPTY');
  });

  it('coarsens forged database error codes and secret-bearing prefixes', async () => {
    const worker = resolveBackstageHeavyProofTargetOrThrow(
      'worker',
      buildEnvironment('worker')
    );
    const sensitiveMarker = 'database-secret-must-not-reflect';
    for (const injectedMessage of [
      'BACKSTAGE_HEAVY_PROOF_DATABASE_NOT_FRESH',
      `BACKSTAGE_HEAVY_PROOF_DATABASE_PREFLIGHT_FAILED:${sensitiveMarker}`,
    ]) {
      class FailingClient {
        async connect() {
          throw new Error(injectedMessage);
        }

        async end() {}
      }
      let observed;
      try {
        await preflightBackstageHeavyProofDatabase(worker, {
          Client: FailingClient,
        });
      } catch (error) {
        observed = error;
      }
      expect(observed).toEqual(
        new Error('BACKSTAGE_HEAVY_PROOF_DATABASE_PREFLIGHT_FAILED')
      );
      expect(observed.message).not.toContain(sensitiveMarker);
    }
  });

  it('waits for the worker fixture handshake before spawning the exact integrity wrapper environment', async () => {
    const environment = buildEnvironment('worker');
    const proofTarget = resolveBackstageHeavyProofTargetOrThrow(
      'worker',
      environment
    );
    const sequence = [];
    let fixtureChild;
    let applicationChild;
    const spawnImpl = jest.fn((command, args, options) => {
      if (!fixtureChild) {
        sequence.push('fixture-spawn');
        fixtureChild = makeReadyFixture({
          beforeReady: () => sequence.push('fixture-ready'),
        });
        expect(command).toBe(process.execPath);
        expect(args).toEqual([
          'scripts/railway-backstage-heavy-openai-fixture.mjs',
          BACKSTAGE_HEAVY_OPENAI_FIXTURE_CHILD_ARGUMENT,
        ]);
        expect(options).toMatchObject({
          env: buildBackstageHeavyFixtureChildEnvironment(proofTarget),
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
        return fixtureChild;
      }
      sequence.push('application-spawn');
      applicationChild = new FakeChild();
      expect(command).toBe(process.execPath);
      expect(args).toEqual([
        'scripts/start-railway-service-with-integrity.mjs',
      ]);
      expect(options.env).toEqual(
        buildBackstageHeavyApplicationChildEnvironment(
          proofTarget,
          environment
        )
      );
      expect(options).toMatchObject({
        stdio: 'inherit',
        windowsHide: true,
      });
      void Promise.resolve().then(() => applicationChild.close(0, null));
      return applicationChild;
    });

    await expect(runBackstageHeavyProofSupervisor('worker', environment, {
      Client: PreflightClient,
      processRef: makeProcessRef(),
      spawnImpl,
    })).resolves.toBe(1);

    expect(sequence).toEqual([
      'fixture-spawn',
      'fixture-ready',
      'application-spawn',
    ]);
    expect(spawnImpl).toHaveBeenCalledTimes(2);
    expect(fixtureChild.killedSignals).toContain('SIGTERM');
  });

  it('kills the application and fails when the ready fixture exits unexpectedly', async () => {
    let fixtureChild;
    let applicationChild;
    const spawnImpl = jest.fn(() => {
      if (!fixtureChild) {
        fixtureChild = makeReadyFixture();
        return fixtureChild;
      }
      applicationChild = new FakeChild();
      void Promise.resolve().then(() => fixtureChild.close(0, null));
      return applicationChild;
    });

    await expect(runBackstageHeavyProofSupervisor(
      'worker',
      buildEnvironment('worker'),
      {
        Client: PreflightClient,
        processRef: makeProcessRef(),
        spawnImpl,
      }
    )).resolves.toBe(1);
    expect(applicationChild.killedSignals).toEqual(['SIGTERM']);
  });

  it('treats an unsolicited clean application exit as failure and stops the fixture', async () => {
    let fixtureChild;
    let applicationChild;
    const spawnImpl = jest.fn(() => {
      if (!fixtureChild) {
        fixtureChild = makeReadyFixture();
        return fixtureChild;
      }
      applicationChild = new FakeChild();
      void Promise.resolve().then(() => applicationChild.close(0, null));
      return applicationChild;
    });

    await expect(runBackstageHeavyProofSupervisor(
      'worker',
      buildEnvironment('worker'),
      {
        Client: PreflightClient,
        processRef: makeProcessRef(),
        spawnImpl,
      }
    )).resolves.toBe(1);
    expect(fixtureChild.killedSignals).toEqual(['SIGTERM']);
  });

  it.each(['SIGTERM', 'SIGINT'])(
    'forwards %s to both children and removes every supervisor listener',
    async signal => {
      const processRef = makeProcessRef();
      let fixtureChild;
      let applicationChild;
      const spawnImpl = jest.fn(() => {
        if (!fixtureChild) {
          fixtureChild = makeReadyFixture();
          return fixtureChild;
        }
        applicationChild = new FakeChild();
        void Promise.resolve().then(() => processRef.emit(signal));
        return applicationChild;
      });

      await expect(runBackstageHeavyProofSupervisor(
        'worker',
        buildEnvironment('worker'),
        {
          Client: PreflightClient,
          processRef,
          spawnImpl,
        }
      )).resolves.toBe(0);
      expect(applicationChild.killedSignals).toEqual([signal]);
      expect(fixtureChild.killedSignals).toEqual([signal]);
      expect(processRef.listenerCount('SIGTERM')).toBe(0);
      expect(processRef.listenerCount('SIGINT')).toBe(0);
    }
  );

  it('forwards shutdown during the fixture handshake without starting the application', async () => {
    const processRef = makeProcessRef();
    let fixtureChild;
    const spawnImpl = jest.fn(() => {
      fixtureChild = new FakeChild();
      void Promise.resolve().then(() => processRef.emit('SIGTERM'));
      return fixtureChild;
    });

    await expect(runBackstageHeavyProofSupervisor(
      'worker',
      buildEnvironment('worker'),
      {
        Client: PreflightClient,
        processRef,
        spawnImpl,
      }
    )).resolves.toBe(0);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(fixtureChild.killedSignals).toEqual(['SIGTERM']);
    expect(processRef.listenerCount('SIGTERM')).toBe(0);
    expect(processRef.listenerCount('SIGINT')).toBe(0);
  });

  it('coarsens fixture spawn and handshake failures without reflecting their payloads', async () => {
    const spawnSecret = 'sk-fixture-spawn-secret-must-not-reflect';
    let spawnError;
    try {
      await runBackstageHeavyProofSupervisor(
        'worker',
        buildEnvironment('worker'),
        {
          Client: PreflightClient,
          processRef: makeProcessRef(),
          spawnImpl: () => {
            throw new Error(spawnSecret);
          },
        }
      );
    } catch (error) {
      spawnError = error;
    }
    expect(spawnError).toEqual(
      new Error('BACKSTAGE_HEAVY_PROOF_SUPERVISOR_FAILED')
    );
    expect(spawnError.message).not.toContain(spawnSecret);

    const handshakeSecret = 'fixture-handshake-secret-must-not-reflect';
    const invalidFixture = new FakeChild();
    void Promise.resolve().then(() => {
      invalidFixture.stdout.write(`${handshakeSecret}\n`);
    });
    let handshakeError;
    try {
      await runBackstageHeavyProofSupervisor(
        'worker',
        buildEnvironment('worker'),
        {
          Client: PreflightClient,
          processRef: makeProcessRef(),
          spawnImpl: () => invalidFixture,
        }
      );
    } catch (error) {
      handshakeError = error;
    }
    expect(handshakeError).toEqual(
      new Error('BACKSTAGE_HEAVY_PROOF_FIXTURE_START_FAILED')
    );
    expect(handshakeError.message).not.toContain(handshakeSecret);
  });

  it('bounds teardown by escalating fixture termination from TERM to KILL', async () => {
    jest.useFakeTimers();
    let fixtureChild;
    let applicationChild;
    const spawnImpl = jest.fn(() => {
      if (!fixtureChild) {
        fixtureChild = makeReadyFixture({
          onKill: (signal, child) => {
            if (signal === 'SIGKILL') child.close(null, signal);
          },
        });
        return fixtureChild;
      }
      applicationChild = new FakeChild();
      void Promise.resolve().then(() => applicationChild.close(1, null));
      return applicationChild;
    });
    const result = runBackstageHeavyProofSupervisor(
      'worker',
      buildEnvironment('worker'),
      {
        Client: PreflightClient,
        processRef: makeProcessRef(),
        spawnImpl,
      }
    );

    for (let turn = 0; turn < 50; turn += 1) {
      await Promise.resolve();
      if (fixtureChild?.killedSignals.includes('SIGTERM')) break;
    }
    expect(fixtureChild.killedSignals).toEqual(['SIGTERM']);
    await jest.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toBe(1);
    expect(fixtureChild.killedSignals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('fails closed when a child remains alive after bounded TERM and KILL waits', async () => {
    jest.useFakeTimers();
    let fixtureChild;
    let applicationChild;
    const spawnImpl = jest.fn(() => {
      if (!fixtureChild) {
        fixtureChild = makeReadyFixture({ onKill: () => undefined });
        return fixtureChild;
      }
      applicationChild = new FakeChild();
      void Promise.resolve().then(() => applicationChild.close(1, null));
      return applicationChild;
    });
    const result = runBackstageHeavyProofSupervisor(
      'worker',
      buildEnvironment('worker'),
      {
        Client: PreflightClient,
        processRef: makeProcessRef(),
        spawnImpl,
      }
    );
    const rejection = expect(result).rejects.toThrow(
      'BACKSTAGE_HEAVY_PROOF_CHILD_TEARDOWN_FAILED'
    );

    for (let turn = 0; turn < 50; turn += 1) {
      await Promise.resolve();
      if (fixtureChild?.killedSignals.includes('SIGTERM')) break;
    }
    expect(fixtureChild.killedSignals).toEqual(['SIGTERM']);
    await jest.advanceTimersByTimeAsync(4_000);
    await rejection;
    expect(fixtureChild.killedSignals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});
