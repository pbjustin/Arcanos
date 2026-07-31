import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const ENV_NAMES = [
  'NODE_ENV',
  'ARCANOS_PROCESS_KIND',
  'RUN_WORKERS',
  'OPENAI_API_KEY',
  'DATABASE_URL',
  'RAILWAY_DATABASE_URL',
  'DATABASE_PRIVATE_URL',
  'DATABASE_PUBLIC_URL',
  'PGUSER',
  'PGPASSWORD',
  'PGHOST',
  'PGPORT',
  'PGDATABASE',
  'REDIS_URL',
  'REDISHOST',
  'REDIS_HOST'
] as const;

const originalEnvironment = Object.fromEntries(
  ENV_NAMES.map(name => [name, process.env[name]])
) as Record<(typeof ENV_NAMES)[number], string | undefined>;

describe('production web readiness policy', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'production';
    process.env.ARCANOS_PROCESS_KIND = 'web';
    process.env.RUN_WORKERS = 'false';
    process.env.OPENAI_API_KEY = 'test-openai-api-key';
    for (const name of ENV_NAMES.slice(4)) {
      process.env[name] = '';
    }
  });

  afterEach(() => {
    for (const name of ENV_NAMES) {
      const originalValue = originalEnvironment[name];
      if (originalValue === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = originalValue;
      }
    }
    jest.resetModules();
  });

  it('uses the real environment predicate and fails only readiness when both backends are absent', async () => {
    const createClientMock = jest.fn(() => {
      throw new Error('Readiness must not create a Redis client.');
    });
    const getDatabaseStatusMock = jest.fn(() => ({
      connected: true,
      hasPool: true,
      error: null
    }));
    const getDatabaseSchemaReadyMock = jest.fn(() => true);
    jest.unstable_mockModule('redis', () => ({
      createClient: createClientMock
    }));
    jest.unstable_mockModule('@core/db/index.js', () => ({
      getStatus: getDatabaseStatusMock,
      isDatabaseSchemaReady: getDatabaseSchemaReadyMock
    }));
    jest.unstable_mockModule('@platform/runtime/redisLifecycle.js', () => ({
      RedisLifecycleManager: class {},
      executeRedisOperation: jest.fn(async () => {
        throw new Error('Readiness must not execute a Redis command.');
      }),
      getRedisLifecycleSnapshot: jest.fn(() => ({
        state: 'READY',
        configured: false,
        connected: false,
        attemptInFlight: false,
        readyGeneration: 0,
        circuitEnabled: false,
        circuitState: 'CLOSED',
        circuitFailureThreshold: 1,
        attempt: 0,
        recoveryCount: 0,
        retryScheduled: false,
        lastTransitionAt: '2026-07-31T00:00:00.000Z',
        lastReadyAt: null,
        lastErrorCode: null,
        operationGate: {
          inFlight: 0,
          admittedTotal: 0,
          rejectedTotal: 0,
          succeededTotal: 0,
          failedTotal: 0,
          timedOutTotal: 0,
          lastOperation: null,
          lastOutcome: null,
          lastDurationMs: null
        }
      })),
      getReadyRedisClient: jest.fn(() => null),
      startRedisLifecycle: jest.fn(),
      stopRedisLifecycle: jest.fn(async () => undefined),
      subscribeRedisLifecycle: jest.fn(() => jest.fn())
    }));
    jest.unstable_mockModule('@platform/runtime/startupLifecycle.js', () => ({
      getStartupLifecycleSnapshot: jest.fn(() => ({
        phase: 'READY',
        ready: true,
        listenerBound: true,
        runtimeInitialized: true,
        runtimeErrorCode: null,
        shuttingDown: false,
        redis: {
          configured: false,
          status: 'ready',
          attempt: 0,
          lastErrorCode: null
        },
        changedAt: '2026-07-31T00:00:00.000Z'
      }))
    }));
    jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => {
      const logger: Record<string, jest.Mock> = {
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn()
      };
      logger.child = jest.fn(() => logger);
      return {
        aiLogger: logger,
        logger
      };
    });
    jest.unstable_mockModule('@platform/logging/telemetry.js', () => ({
      recordTraceEvent: jest.fn(() => 'trace-id')
    }));
    jest.unstable_mockModule('@arcanos/openai/unifiedClient', () => ({
      validateClientHealth: jest.fn(() => ({
        healthy: true,
        error: undefined,
        apiKeyConfigured: true,
        apiKeySource: 'env',
        defaultModel: 'test-model',
        circuitBreakerHealthy: true
      }))
    }));
    jest.unstable_mockModule('@core/adapters/openai.adapter.js', () => ({
      isOpenAIAdapterInitialized: jest.fn(() => true)
    }));

    const { getConfig, getStableWorkerRuntimeMode } = await import(
      '../src/platform/runtime/unifiedConfig.js'
    );
    const express = (await import('express')).default;
    const request = (await import('supertest')).default;
    const healthRouter = (await import('../src/routes/health.js')).default;
    const app = express();
    app.use(healthRouter);

    expect(getConfig().isProduction).toBe(true);
    expect(getStableWorkerRuntimeMode().processKind).toBe('web');

    const liveness = await request(app).get('/healthz');
    const diagnostics = await request(app).get('/health');
    const readiness = await request(app).get('/readyz');
    const readinessHead = await request(app).head('/readyz');

    expect(liveness.status).toBe(200);
    expect(diagnostics.status).toBe(200);
    expect(diagnostics.body.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'database',
        healthy: true,
        metadata: expect.objectContaining({ configured: false })
      }),
      expect.objectContaining({
        name: 'redis',
        healthy: true,
        metadata: expect.objectContaining({ configured: false })
      })
    ]));
    expect(readiness.status).toBe(503);
    expect(readiness.headers['cache-control']).toBe('no-store');
    expect(readiness.body).toEqual(expect.objectContaining({
      ready: false,
      status: 'unhealthy'
    }));
    expect(readiness.body.checks).toEqual(expect.arrayContaining([
      {
        healthy: false,
        name: 'database',
        code: 'DATABASE_DEPENDENCY_UNAVAILABLE',
        error: 'Database dependency is unavailable.',
        duration: expect.any(Number)
      },
      {
        healthy: false,
        name: 'redis',
        code: 'REDIS_DEPENDENCY_UNAVAILABLE',
        error: 'Redis dependency is unavailable.',
        duration: expect.any(Number)
      }
    ]));
    expect(JSON.stringify(readiness.body)).not.toContain('not configured');
    expect(readinessHead.status).toBe(503);
    expect(readinessHead.headers['cache-control']).toBe('no-store');
    expect(readinessHead.text).toBeUndefined();
    expect(createClientMock).not.toHaveBeenCalled();
    expect(getDatabaseStatusMock).not.toHaveBeenCalled();
    expect(getDatabaseSchemaReadyMock).not.toHaveBeenCalled();

    process.env.PGUSER = 'arcanos';
    process.env.PGPASSWORD = 'test-password';
    process.env.PGHOST = 'postgres.railway.internal';
    process.env.PGPORT = '5432';
    process.env.PGDATABASE = 'railway';

    const discreteDatabaseDiagnostics = await request(app).get('/health');

    expect(discreteDatabaseDiagnostics.status).toBe(200);
    expect(discreteDatabaseDiagnostics.body.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'database',
        healthy: true,
        metadata: expect.objectContaining({ configured: false })
      })
    ]));
    expect(getDatabaseStatusMock).not.toHaveBeenCalled();
    expect(getDatabaseSchemaReadyMock).not.toHaveBeenCalled();

    const discreteDatabaseReadiness = await request(app).get('/readyz');

    expect(discreteDatabaseReadiness.status).toBe(503);
    expect(discreteDatabaseReadiness.body.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'database',
        healthy: true
      }),
      expect.objectContaining({
        name: 'redis',
        healthy: false
      })
    ]));
    expect(getDatabaseStatusMock).toHaveBeenCalled();
    expect(getDatabaseSchemaReadyMock).toHaveBeenCalled();
  });
});
