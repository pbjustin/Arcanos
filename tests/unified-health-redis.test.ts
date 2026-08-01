import { describe, expect, it, jest } from '@jest/globals';

type UnifiedHealthModule = typeof import('../src/platform/resilience/unifiedHealth.js');
type RedisLifecycleSnapshot = import('../src/platform/runtime/redisLifecycle.js').RedisLifecycleSnapshot;
type StartupLifecycleSnapshot = import('../src/platform/runtime/startupLifecycle.js').StartupLifecycleSnapshot;

interface UnifiedHealthHarnessOptions {
  config?: {
    databaseUrl?: string;
    isProduction?: boolean;
    nodeEnv?: string;
  };
  databaseStatus?: {
    connected: boolean;
    error: string | null;
  };
  databaseSchemaReady?: boolean;
  processKind?: 'web' | 'worker' | 'unknown';
  redisResolution?: {
    configured: boolean;
    source: 'REDIS_URL' | 'discrete' | 'none';
    url?: string;
  };
  redisLifecycle?: Partial<RedisLifecycleSnapshot>;
  publicProviderReadiness?: {
    status: 'not_required' | 'pending' | 'ready' | 'failed';
    readyGeneration: number;
    retryAttempt?: number;
    retryScheduled?: boolean;
  };
  publicProviderNamespace?: string | null;
  startupLifecycle?: Partial<StartupLifecycleSnapshot>;
}

interface UnifiedHealthHarness {
  moduleUnderTest: UnifiedHealthModule;
  createClientMock: jest.Mock;
  getDatabaseSchemaReadyMock: jest.Mock;
  getDatabaseStatusMock: jest.Mock;
  getRedisLifecycleSnapshotMock: jest.Mock;
  getStartupLifecycleSnapshotMock: jest.Mock;
  sendTimestampedStatusMock: jest.Mock;
}

const DEFAULT_REDIS_LIFECYCLE: RedisLifecycleSnapshot = {
  state: 'STARTING',
  configured: true,
  connected: false,
  attemptInFlight: true,
  readyGeneration: 0,
  circuitEnabled: true,
  circuitState: 'HALF_OPEN',
  circuitFailureThreshold: 1,
  attempt: 1,
  recoveryCount: 0,
  retryScheduled: false,
  lastTransitionAt: '2026-07-21T12:00:00.000Z',
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
};

const DEFAULT_STARTUP_LIFECYCLE: StartupLifecycleSnapshot = {
  phase: 'STARTING',
  ready: false,
  listenerBound: true,
  runtimeInitialized: false,
  runtimeErrorCode: null,
  shuttingDown: false,
  redis: {
    configured: true,
    status: 'connecting',
    attempt: 1,
    lastErrorCode: null
  },
  changedAt: '2026-07-21T12:00:00.000Z'
};

/** Load unified health with process-local lifecycle projections and no Redis I/O. */
async function loadUnifiedHealthHarness(
  options: UnifiedHealthHarnessOptions = {}
): Promise<UnifiedHealthHarness> {
  jest.resetModules();

  const redisLifecycle = {
    ...DEFAULT_REDIS_LIFECYCLE,
    ...options.redisLifecycle
  };
  const startupLifecycle = {
    ...DEFAULT_STARTUP_LIFECYCLE,
    ...options.startupLifecycle,
    redis: {
      ...DEFAULT_STARTUP_LIFECYCLE.redis,
      ...options.startupLifecycle?.redis
    }
  };
  const createClientMock = jest.fn(() => {
    throw new Error('Health checks must not create Redis clients.');
  });
  const getDatabaseStatusMock = jest.fn(() => (
    options.databaseStatus ?? {
      connected: true,
      error: null
    }
  ));
  const getDatabaseSchemaReadyMock = jest.fn(
    () => options.databaseSchemaReady ?? true
  );
  const getRedisLifecycleSnapshotMock = jest.fn(() => ({ ...redisLifecycle }));
  const getStartupLifecycleSnapshotMock = jest.fn(() => ({
    ...startupLifecycle,
    redis: { ...startupLifecycle.redis }
  }));
  const sendTimestampedStatusMock = jest.fn((
    res: { status: (statusCode: number) => { json: (payload: unknown) => unknown } },
    statusCode: number,
    payload: Record<string, unknown>
  ) => {
    res.status(statusCode).json({
      ...payload,
      timestamp: '2026-07-21T12:00:00.000Z'
    });
  });

  jest.unstable_mockModule('redis', () => ({
    createClient: createClientMock
  }));
  jest.unstable_mockModule('@platform/runtime/redis.js', () => ({
    resolveConfiguredRedisConnection: jest.fn(() => (
      options.redisResolution ?? {
        configured: true,
        source: 'REDIS_URL',
        url: 'redis://configured.invalid:6379'
      }
    ))
  }));
  jest.unstable_mockModule('@platform/runtime/redisLifecycle.js', () => ({
    getRedisLifecycleSnapshot: getRedisLifecycleSnapshotMock
  }));
  jest.unstable_mockModule('@platform/runtime/config.js', () => ({
    config: {
      limits: {
        publicProviderRateLimitNamespace:
          options.publicProviderNamespace === undefined
            ? null
            : options.publicProviderNamespace,
      },
    },
  }));
  jest.unstable_mockModule('@platform/runtime/publicProviderRateLimitReadiness.js', () => ({
    getPublicProviderRateLimitReadinessSnapshot: jest.fn(() => ({
      status: options.publicProviderReadiness?.status ?? 'not_required',
      readyGeneration: options.publicProviderReadiness?.readyGeneration ?? 0,
      retryAttempt: options.publicProviderReadiness?.retryAttempt ?? 0,
      retryScheduled: options.publicProviderReadiness?.retryScheduled ?? false,
    })),
  }));
  jest.unstable_mockModule('@platform/runtime/startupLifecycle.js', () => ({
    getStartupLifecycleSnapshot: getStartupLifecycleSnapshotMock
  }));
  jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
    aiLogger: {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn()
    }
  }));
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
  jest.unstable_mockModule('@core/db/index.js', () => ({
    getStatus: getDatabaseStatusMock,
    isDatabaseSchemaReady: getDatabaseSchemaReadyMock
  }));
  jest.unstable_mockModule('@platform/runtime/unifiedConfig.js', () => ({
    getConfig: jest.fn(() => ({
      databaseUrl: options.config?.databaseUrl,
      nodeEnv: options.config?.nodeEnv ?? 'test',
      isProduction: options.config?.isProduction ?? false,
      isRailway: false,
      railwayEnvironment: undefined
    })),
    getStableWorkerRuntimeMode: jest.fn(() => ({
      requestedRunWorkers: options.processKind === 'worker',
      resolvedRunWorkers: options.processKind === 'worker',
      processKind: options.processKind ?? 'unknown',
      railwayServiceName: null,
      reason: options.processKind === 'web'
        ? 'process_kind_web'
        : options.processKind === 'worker'
          ? 'process_kind_worker'
          : 'requested'
    }))
  }));
  jest.unstable_mockModule('@platform/resilience/healthChecks.js', () => ({
    assessCoreServiceReadiness: jest.fn(),
    mapReadinessToHealthStatus: jest.fn()
  }));
  jest.unstable_mockModule('@platform/resilience/serviceUnavailable.js', () => ({
    sendTimestampedStatus: sendTimestampedStatusMock
  }));

  const moduleUnderTest = await import('../src/platform/resilience/unifiedHealth.js');

  return {
    moduleUnderTest,
    createClientMock,
    getDatabaseSchemaReadyMock,
    getDatabaseStatusMock,
    getRedisLifecycleSnapshotMock,
    getStartupLifecycleSnapshotMock,
    sendTimestampedStatusMock
  };
}

function createResponseMock() {
  const res: any = {};
  res.setHeader = jest.fn();
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('platform/resilience/unifiedHealth Redis lifecycle checks', () => {
  it('requires the admission capability latch to match the ready Redis generation', async () => {
    const pendingHarness = await loadUnifiedHealthHarness({
      config: { isProduction: true },
      processKind: 'web',
      publicProviderNamespace: 'railway:project:environment:service',
      publicProviderReadiness: { status: 'pending', readyGeneration: 2 },
      redisLifecycle: {
        state: 'READY',
        connected: true,
        readyGeneration: 2,
        circuitState: 'CLOSED',
      },
    });

    expect(pendingHarness.moduleUnderTest.checkPublicProviderAdmissionReadiness())
      .toEqual(expect.objectContaining({
        healthy: false,
        code: 'PUBLIC_PROVIDER_ADMISSION_UNAVAILABLE',
        metadata: expect.objectContaining({
          capabilityStatus: 'pending',
          capabilityGeneration: 2,
          redisGeneration: 2,
        }),
      }));

    const failedHarness = await loadUnifiedHealthHarness({
      config: { isProduction: true },
      processKind: 'web',
      publicProviderNamespace: 'railway:project:environment:service',
      publicProviderReadiness: {
        status: 'failed',
        readyGeneration: 2,
        retryAttempt: 1,
        retryScheduled: true,
      },
      redisLifecycle: {
        state: 'READY',
        connected: true,
        readyGeneration: 2,
        circuitState: 'CLOSED',
      },
    });

    expect(failedHarness.moduleUnderTest.checkPublicProviderAdmissionReadiness())
      .toEqual(expect.objectContaining({
        healthy: false,
        code: 'PUBLIC_PROVIDER_ADMISSION_UNAVAILABLE',
        metadata: expect.objectContaining({
          capabilityStatus: 'failed',
          capabilityGeneration: 2,
          redisGeneration: 2,
          retryScheduled: true,
        }),
      }));

    const staleGenerationHarness = await loadUnifiedHealthHarness({
      config: { isProduction: true },
      processKind: 'web',
      publicProviderNamespace: 'railway:project:environment:service',
      publicProviderReadiness: { status: 'ready', readyGeneration: 2 },
      redisLifecycle: {
        state: 'READY',
        connected: true,
        readyGeneration: 3,
        circuitState: 'CLOSED',
      },
    });

    expect(staleGenerationHarness.moduleUnderTest.checkPublicProviderAdmissionReadiness())
      .toEqual(expect.objectContaining({
        healthy: false,
        code: 'PUBLIC_PROVIDER_ADMISSION_UNAVAILABLE',
        metadata: expect.objectContaining({
          capabilityStatus: 'ready',
          capabilityGeneration: 2,
          redisGeneration: 3,
        }),
      }));

    const degradedRedisHarness = await loadUnifiedHealthHarness({
      config: { isProduction: true },
      processKind: 'web',
      publicProviderNamespace: 'railway:project:environment:service',
      publicProviderReadiness: { status: 'ready', readyGeneration: 3 },
      redisLifecycle: {
        state: 'DEGRADED',
        connected: false,
        readyGeneration: 3,
        circuitState: 'OPEN',
      },
    });

    expect(degradedRedisHarness.moduleUnderTest.checkPublicProviderAdmissionReadiness())
      .toEqual(expect.objectContaining({
        healthy: false,
        code: 'PUBLIC_PROVIDER_ADMISSION_UNAVAILABLE',
      }));

    const readyHarness = await loadUnifiedHealthHarness({
      config: { isProduction: true },
      processKind: 'web',
      publicProviderNamespace: 'railway:project:environment:service',
      publicProviderReadiness: { status: 'ready', readyGeneration: 3 },
      redisLifecycle: {
        state: 'READY',
        connected: true,
        readyGeneration: 3,
        circuitState: 'CLOSED',
      },
    });

    expect(readyHarness.moduleUnderTest.checkPublicProviderAdmissionReadiness())
      .toEqual(expect.objectContaining({
        healthy: true,
        metadata: expect.objectContaining({
          capabilityStatus: 'ready',
          capabilityGeneration: 3,
          redisGeneration: 3,
        }),
      }));
  });

  it('reports healthy and optional without opening a client when Redis is unconfigured', async () => {
    const harness = await loadUnifiedHealthHarness({
      redisResolution: {
        configured: false,
        source: 'none'
      },
      redisLifecycle: {
        state: 'READY',
        configured: false,
        connected: false,
        attempt: 0
      }
    });

    await expect(harness.moduleUnderTest.checkRedisHealth()).resolves.toEqual({
      healthy: true,
      name: 'redis',
      metadata: {
        configured: false,
        source: 'none',
        reason: 'Redis not configured (optional)'
      }
    });
    expect(harness.createClientMock).not.toHaveBeenCalled();
  });

  it('projects READY from the long-lived lifecycle without connect or ping I/O', async () => {
    const harness = await loadUnifiedHealthHarness({
      redisResolution: {
        configured: true,
        source: 'discrete',
        url: 'redis://configured.invalid:6379'
      },
      redisLifecycle: {
        state: 'READY',
        configured: true,
        connected: true,
        attemptInFlight: false,
        readyGeneration: 2,
        circuitState: 'CLOSED',
        attempt: 2,
        recoveryCount: 1,
        retryScheduled: false,
        lastReadyAt: '2026-07-21T12:01:00.000Z'
      }
    });

    const result = await harness.moduleUnderTest.checkRedisHealth();

    expect(result).toEqual({
      healthy: true,
      name: 'redis',
      metadata: {
        configured: true,
        connected: true,
        source: 'discrete',
        state: 'READY',
        circuitEnabled: true,
        circuitState: 'CLOSED',
        readyGeneration: 2,
        attempt: 2,
        recoveryCount: 1
      }
    });
    expect(harness.getRedisLifecycleSnapshotMock).toHaveBeenCalledTimes(1);
    expect(harness.createClientMock).not.toHaveBeenCalled();
  });

  it('returns a stable initializing error while the lifecycle is STARTING', async () => {
    const harness = await loadUnifiedHealthHarness({
      redisLifecycle: {
        state: 'STARTING',
        configured: true,
        connected: false,
        attempt: 1,
        retryScheduled: false
      }
    });

    const result = await harness.moduleUnderTest.checkRedisHealth();

    expect(result).toEqual(expect.objectContaining({
      healthy: false,
      name: 'redis',
      code: 'REDIS_INITIALIZING',
      error: 'Redis initialization is in progress.',
      metadata: expect.objectContaining({
        configured: true,
        connected: false,
        state: 'STARTING',
        code: 'REDIS_INITIALIZING'
      })
    }));
    expect(JSON.stringify(result)).not.toContain('configured.invalid');
    expect(harness.createClientMock).not.toHaveBeenCalled();
  });

  it('returns a stable dependency error without exposing the underlying Redis failure', async () => {
    const harness = await loadUnifiedHealthHarness({
      redisLifecycle: {
        state: 'DEGRADED',
        configured: true,
        connected: false,
        attempt: 4,
        retryScheduled: true,
        lastErrorCode: 'REDIS_AUTH_FAILED'
      }
    });

    const result = await harness.moduleUnderTest.checkRedisHealth();
    const serialized = JSON.stringify(result);

    expect(result).toEqual(expect.objectContaining({
      healthy: false,
      name: 'redis',
      code: 'REDIS_DEPENDENCY_UNAVAILABLE',
      error: 'Redis dependency is unavailable.',
      metadata: expect.objectContaining({
        state: 'DEGRADED',
        attempt: 4,
        retryScheduled: true,
        code: 'REDIS_DEPENDENCY_UNAVAILABLE'
      })
    }));
    expect(serialized).not.toContain('WRONGPASS');
    expect(serialized).not.toContain('REDIS_AUTH_FAILED');
    expect(serialized).not.toContain('configured.invalid');
    expect(harness.createClientMock).not.toHaveBeenCalled();
  });
});

describe('production web readiness dependency admission', () => {
  it.each([
    {
      missingDependency: 'database',
      config: {
        databaseUrl: undefined,
        isProduction: true,
        nodeEnv: 'production'
      },
      redisResolution: {
        configured: true,
        source: 'REDIS_URL' as const,
        url: 'redis://configured.invalid:6379'
      },
      redisLifecycle: {
        state: 'READY' as const,
        configured: true,
        connected: true,
        attemptInFlight: false,
        readyGeneration: 1,
        circuitEnabled: true,
        circuitState: 'CLOSED' as const
      }
    },
    {
      missingDependency: 'redis',
      config: {
        databaseUrl: 'postgresql://configured.invalid/arcanos',
        isProduction: true,
        nodeEnv: 'production'
      },
      redisResolution: {
        configured: false,
        source: 'none' as const
      },
      redisLifecycle: {
        state: 'READY' as const,
        configured: false,
        connected: false,
        attemptInFlight: false,
        readyGeneration: 0,
        circuitEnabled: false,
        circuitState: 'CLOSED' as const
      }
    }
  ])('fails /readyz closed when production web $missingDependency configuration is absent', async ({
    missingDependency,
    config,
    redisResolution,
    redisLifecycle
  }) => {
    const harness = await loadUnifiedHealthHarness({
      config,
      processKind: 'web',
      redisResolution,
      redisLifecycle,
      startupLifecycle: {
        phase: 'READY',
        ready: true,
        listenerBound: true,
        runtimeInitialized: true,
        redis: {
          configured: redisResolution.configured,
          status: 'ready',
          attempt: 0,
          lastErrorCode: null
        }
      }
    });
    const express = (await import('express')).default;
    const request = (await import('supertest')).default;
    const healthRouter = (await import('../src/routes/health.js')).default;
    const app = express();
    app.use(healthRouter);

    const liveness = await request(app).get('/healthz');
    const readiness = await request(app).get('/readyz');
    const readinessHead = await request(app).head('/readyz');

    expect(liveness.status).toBe(200);
    expect(readiness.status).toBe(503);
    expect(readiness.headers['cache-control']).toBe('no-store');
    expect(readiness.body).toEqual(expect.objectContaining({
      ready: false,
      status: 'unhealthy'
    }));
    expect(readiness.body.checks.find(
      (check: { name?: unknown }) => check.name === missingDependency
    )).toEqual({
      healthy: false,
      name: missingDependency,
      code: missingDependency === 'database'
        ? 'DATABASE_DEPENDENCY_UNAVAILABLE'
        : 'REDIS_DEPENDENCY_UNAVAILABLE',
      error: missingDependency === 'database'
        ? 'Database dependency is unavailable.'
        : 'Redis dependency is unavailable.',
      duration: expect.any(Number)
    });
    expect(JSON.stringify(readiness.body)).not.toContain('not configured');
    expect(readinessHead.status).toBe(503);
    expect(readinessHead.headers['cache-control']).toBe('no-store');
    expect(readinessHead.text).toBeUndefined();
    expect(harness.createClientMock).not.toHaveBeenCalled();
    if (missingDependency === 'database') {
      expect(harness.getDatabaseStatusMock).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['test web', false, 'web', 'test'],
    ['development web', false, 'web', 'development'],
    ['production worker', true, 'worker', 'production'],
    ['production unknown role', true, 'unknown', 'production']
  ] as const)('preserves optional unconfigured backends for %s', async (
    _label,
    isProduction,
    processKind,
    nodeEnv
  ) => {
    const harness = await loadUnifiedHealthHarness({
      config: {
        databaseUrl: undefined,
        isProduction,
        nodeEnv
      },
      processKind,
      redisResolution: {
        configured: false,
        source: 'none'
      },
      redisLifecycle: {
        state: 'READY',
        configured: false,
        connected: false,
        attemptInFlight: false,
        readyGeneration: 0,
        circuitEnabled: false,
        circuitState: 'CLOSED'
      },
      startupLifecycle: {
        phase: 'READY',
        ready: true,
        listenerBound: true,
        runtimeInitialized: true,
        redis: {
          configured: false,
          status: 'ready',
          attempt: 0,
          lastErrorCode: null
        }
      }
    });
    const express = (await import('express')).default;
    const request = (await import('supertest')).default;
    const healthRouter = (await import('../src/routes/health.js')).default;
    const app = express();
    app.use(healthRouter);

    const readiness = await request(app).get('/readyz');

    expect(readiness.status).toBe(200);
    expect(readiness.body).toEqual(expect.objectContaining({
      ready: true,
      status: 'healthy'
    }));
    expect(readiness.body.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'database', healthy: true }),
      expect.objectContaining({ name: 'redis', healthy: true })
    ]));
    expect(harness.createClientMock).not.toHaveBeenCalled();
  });

  it('fails only readiness when the production database is connected but its schema is not ready', async () => {
    const harness = await loadUnifiedHealthHarness({
      config: {
        databaseUrl: 'postgresql://configured.invalid/arcanos',
        isProduction: true,
        nodeEnv: 'production'
      },
      databaseStatus: {
        connected: true,
        error: null
      },
      databaseSchemaReady: false,
      processKind: 'web',
      redisResolution: {
        configured: true,
        source: 'REDIS_URL',
        url: 'redis://configured.invalid:6379'
      },
      redisLifecycle: {
        state: 'READY',
        configured: true,
        connected: true,
        attemptInFlight: false,
        readyGeneration: 1,
        circuitEnabled: true,
        circuitState: 'CLOSED'
      },
      startupLifecycle: {
        phase: 'READY',
        ready: true,
        listenerBound: true,
        runtimeInitialized: true,
        redis: {
          configured: true,
          status: 'ready',
          attempt: 0,
          lastErrorCode: null
        }
      }
    });
    const express = (await import('express')).default;
    const request = (await import('supertest')).default;
    const healthRouter = (await import('../src/routes/health.js')).default;
    const app = express();
    app.use(healthRouter);

    const diagnostics = await request(app).get('/health');
    expect(diagnostics.status).toBe(200);
    expect(diagnostics.body.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'database', healthy: true })
    ]));
    expect(harness.getDatabaseSchemaReadyMock).not.toHaveBeenCalled();

    const readiness = await request(app).get('/readyz');
    const readinessHead = await request(app).head('/readyz');

    expect(readiness.status).toBe(503);
    expect(readiness.headers['cache-control']).toBe('no-store');
    expect(readiness.body.checks.find(
      (check: { name?: unknown }) => check.name === 'database'
    )).toEqual({
      healthy: false,
      name: 'database',
      code: 'DATABASE_DEPENDENCY_UNAVAILABLE',
      error: 'Database dependency is unavailable.',
      duration: expect.any(Number)
    });
    expect(readinessHead.status).toBe(503);
    expect(readinessHead.headers['cache-control']).toBe('no-store');
    expect(readinessHead.text).toBeUndefined();
    expect(harness.getDatabaseStatusMock).toHaveBeenCalled();
    expect(harness.getDatabaseSchemaReadyMock).toHaveBeenCalled();
    expect(harness.createClientMock).not.toHaveBeenCalled();
  });
});

describe('platform/resilience/unifiedHealth startup readiness', () => {
  it.each([
    ['STARTING', 'APPLICATION_STARTING'],
    ['DEGRADED', 'APPLICATION_DEGRADED']
  ] as const)('reports %s as not ready with a stable code', async (phase, code) => {
    const harness = await loadUnifiedHealthHarness({
      startupLifecycle: {
        phase,
        ready: false,
        runtimeInitialized: phase === 'DEGRADED',
        runtimeErrorCode: phase === 'DEGRADED' ? 'RUNTIME_INITIALIZATION_FAILED' : null
      }
    });

    expect(harness.moduleUnderTest.checkStartupReadiness()).toEqual(expect.objectContaining({
      healthy: false,
      name: 'startup',
      code,
      metadata: expect.objectContaining({ phase })
    }));
    expect(harness.getStartupLifecycleSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it('reports READY only after the shared startup lifecycle is ready', async () => {
    const harness = await loadUnifiedHealthHarness({
      startupLifecycle: {
        phase: 'READY',
        ready: true,
        listenerBound: true,
        runtimeInitialized: true,
        redis: {
          configured: true,
          status: 'ready',
          attempt: 2,
          lastErrorCode: null
        }
      }
    });

    expect(harness.moduleUnderTest.checkStartupReadiness()).toEqual({
      healthy: true,
      name: 'startup',
      metadata: {
        phase: 'READY',
        listenerBound: true,
        runtimeInitialized: true,
        shuttingDown: false,
        changedAt: '2026-07-21T12:00:00.000Z'
      }
    });
  });
});

describe('platform/resilience/unifiedHealth public readiness projection', () => {
  it('returns only the allowlisted healthy check contract in original order', async () => {
    const harness = await loadUnifiedHealthHarness();
    const privateMetadataSentinel = 'PRIVATE_HEALTHY_METADATA_SENTINEL';
    const nonCriticalCheckMock = jest.fn(() => ({
      healthy: false,
      name: 'non-critical'
    }));
    const handler = harness.moduleUnderTest.buildReadinessEndpoint([
      harness.moduleUnderTest.createHealthCheck('openai', () => ({
        healthy: true,
        name: 'ignored-by-checker-contract',
        error: privateMetadataSentinel,
        metadata: {
          apiKeySource: privateMetadataSentinel,
          defaultModel: 'private-model'
        }
      })),
      harness.moduleUnderTest.createHealthCheck('database', () => ({
        healthy: true,
        name: 'ignored-by-checker-contract',
        metadata: {
          configured: true,
          url: privateMetadataSentinel
        }
      })),
      harness.moduleUnderTest.createHealthCheck('non-critical', nonCriticalCheckMock, false)
    ]);
    const res = createResponseMock();

    await handler({ path: '/readyz' } as any, res);

    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ready: true,
      status: 'healthy',
      timestamp: expect.any(String),
      checks: [
        {
          healthy: true,
          name: 'openai',
          duration: expect.any(Number)
        },
        {
          healthy: true,
          name: 'database',
          duration: expect.any(Number)
        }
      ],
      duration: expect.any(Number)
    });
    expect(JSON.stringify(res.json.mock.calls[0]?.[0])).not.toContain(privateMetadataSentinel);
    expect(nonCriticalCheckMock).not.toHaveBeenCalled();
  });

  it('replaces raw unhealthy errors and metadata with stable public failures', async () => {
    const harness = await loadUnifiedHealthHarness();
    const databaseSentinel = 'PRIVATE_DATABASE_READINESS_SENTINEL';
    const customSentinel = 'PRIVATE_CUSTOM_READINESS_SENTINEL';
    const redisSentinel = 'PRIVATE_REDIS_READINESS_SENTINEL';
    const handler = harness.moduleUnderTest.buildReadinessEndpoint([
      harness.moduleUnderTest.createHealthCheck('database', () => ({
        healthy: false,
        name: 'database',
        code: 'REDIS_INITIALIZING',
        error: `database connection failed: ${databaseSentinel}`,
        metadata: {
          url: databaseSentinel
        }
      })),
      harness.moduleUnderTest.createHealthCheck('custom-dependency', () => {
        throw new Error(`custom dependency failed: ${customSentinel}`);
      }),
      harness.moduleUnderTest.createHealthCheck('redis', () => ({
        healthy: false,
        name: 'redis',
        code: 'REDIS_INITIALIZING',
        error: redisSentinel,
        metadata: {
          lastError: redisSentinel,
          recoveryCount: 2,
          readyGeneration: 3,
          circuitEnabled: true,
          circuitState: 'HALF_OPEN'
        }
      }))
    ]);
    const res = createResponseMock();

    await handler({ path: '/readyz' } as any, res);

    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      ready: false,
      status: 'unhealthy',
      timestamp: expect.any(String),
      checks: [
        {
          healthy: false,
          name: 'database',
          code: 'DATABASE_DEPENDENCY_UNAVAILABLE',
          error: 'Database dependency is unavailable.',
          duration: expect.any(Number)
        },
        {
          healthy: false,
          name: 'custom-dependency',
          code: 'READINESS_CHECK_FAILED',
          error: 'Readiness check failed.',
          duration: expect.any(Number)
        },
        {
          healthy: false,
          name: 'redis',
          code: 'REDIS_INITIALIZING',
          error: 'Redis initialization is in progress.',
          metadata: {
            recoveryCount: 2,
            readyGeneration: 3,
            circuitEnabled: true,
            circuitState: 'HALF_OPEN'
          },
          duration: expect.any(Number)
        }
      ],
      duration: expect.any(Number)
    });
    const serializedPayload = JSON.stringify(res.json.mock.calls[0]?.[0]);
    expect(serializedPayload).not.toContain(databaseSentinel);
    expect(serializedPayload).not.toContain(customSentinel);
    expect(serializedPayload).not.toContain(redisSentinel);
    expect((res.json.mock.calls[0]?.[0] as any).checks[0]).not.toHaveProperty('metadata');
    expect((res.json.mock.calls[0]?.[0] as any).checks[1]).not.toHaveProperty('metadata');
  });

  it('returns a fixed no-store response when readiness aggregation itself fails', async () => {
    const harness = await loadUnifiedHealthHarness();
    const privateErrorSentinel = 'PRIVATE_READINESS_AGGREGATION_SENTINEL';
    const checker = {
      critical: true,
      get name(): string {
        throw new Error(`readiness aggregation failed: ${privateErrorSentinel}`);
      },
      check: () => ({
        healthy: true,
        name: 'unreachable'
      })
    };
    const handler = harness.moduleUnderTest.buildReadinessEndpoint([checker]);
    const res = createResponseMock();

    await handler({ path: '/readyz' } as any, res);

    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(harness.sendTimestampedStatusMock).toHaveBeenCalledWith(
      res,
      503,
      {
        ready: false,
        status: 'unhealthy',
        code: 'READINESS_CHECK_FAILED',
        error: 'Readiness check unavailable.',
        checks: [],
        duration: expect.any(Number)
      }
    );
    expect(JSON.stringify(res.json.mock.calls[0]?.[0])).not.toContain(privateErrorSentinel);
  });
});
