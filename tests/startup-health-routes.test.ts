import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { RedisLifecycleSnapshot } from '../src/platform/runtime/redisLifecycle.js';
import type { StartupLifecycleSnapshot } from '../src/platform/runtime/startupLifecycle.js';

const request = (await import('supertest')).default;
const CURRENT_GPT_ROUTER_HASH = '8bf52c870195f165b17397ca16e87361fa401553fa10f86ebdbcc857a4fbba58';

function redisSnapshot(
  state: RedisLifecycleSnapshot['state'],
  overrides: Partial<RedisLifecycleSnapshot> = {}
): RedisLifecycleSnapshot {
  return {
    state,
    configured: true,
    connected: state === 'READY',
    attempt: state === 'STARTING' ? 0 : 1,
    recoveryCount: 0,
    retryScheduled: state === 'DEGRADED',
    lastTransitionAt: '2026-07-21T12:00:00.000Z',
    lastReadyAt: state === 'READY' ? '2026-07-21T12:00:00.000Z' : null,
    lastErrorCode: state === 'DEGRADED' ? 'REDIS_CONNECTION_REFUSED' : null,
    ...overrides
  };
}

function startupSnapshot(
  phase: StartupLifecycleSnapshot['phase'],
  overrides: Partial<StartupLifecycleSnapshot> = {}
): StartupLifecycleSnapshot {
  return {
    phase,
    ready: phase === 'READY',
    listenerBound: true,
    runtimeInitialized: phase !== 'STARTING',
    runtimeErrorCode: null,
    shuttingDown: false,
    redis: {
      configured: true,
      status: phase === 'READY'
        ? 'ready'
        : phase === 'DEGRADED'
          ? 'unavailable'
          : 'connecting',
      attempt: phase === 'STARTING' ? 0 : 1,
      lastErrorCode: phase === 'DEGRADED' ? 'REDIS_CONNECTION_REFUSED' : null
    },
    changedAt: '2026-07-21T12:00:00.000Z',
    ...overrides
  };
}

interface AppHealthHarness {
  app: import('express').Express;
  createClientMock: jest.Mock;
  setRedisSnapshot: (snapshot: RedisLifecycleSnapshot) => void;
  setStartupSnapshot: (snapshot: StartupLifecycleSnapshot) => void;
}

async function buildAppHealthHarness(): Promise<AppHealthHarness> {
  jest.resetModules();
  let currentRedisSnapshot = redisSnapshot('STARTING');
  let currentStartupSnapshot = startupSnapshot('STARTING');
  const createClientMock = jest.fn(() => {
    throw new Error('Health probes must not create a Redis client.');
  });

  jest.unstable_mockModule('redis', () => ({
    createClient: createClientMock
  }));
  jest.unstable_mockModule('@platform/runtime/redisLifecycle.js', () => ({
    RedisLifecycleManager: class {},
    getRedisLifecycleSnapshot: jest.fn(() => ({ ...currentRedisSnapshot })),
    getReadyRedisClient: jest.fn(() => null),
    startRedisLifecycle: jest.fn(),
    stopRedisLifecycle: jest.fn(async () => undefined),
    subscribeRedisLifecycle: jest.fn(() => jest.fn())
  }));
  jest.unstable_mockModule('@platform/runtime/startupLifecycle.js', () => ({
    getStartupLifecycleSnapshot: jest.fn(() => ({
      ...currentStartupSnapshot,
      redis: { ...currentStartupSnapshot.redis }
    })),
    subscribeStartupLifecycle: jest.fn(() => jest.fn()),
    markStartupListenerBound: jest.fn(),
    markStartupRuntimeInitializing: jest.fn(),
    markStartupRuntimeInitialized: jest.fn(),
    markStartupRuntimeFailed: jest.fn(),
    markStartupShutdown: jest.fn(),
    updateStartupRedisLifecycle: jest.fn(),
    resetStartupLifecycleForTests: jest.fn()
  }));

  const { createApp } = await import('../src/app.js');
  const app = createApp();
  createClientMock.mockClear();

  return {
    app,
    createClientMock,
    setRedisSnapshot(snapshot): void {
      currentRedisSnapshot = snapshot;
    },
    setStartupSnapshot(snapshot): void {
      currentStartupSnapshot = snapshot;
    }
  };
}

const HEALTH_ENV_NAMES = [
  'NODE_ENV',
  'OPENAI_API_KEY',
  'DATABASE_URL',
  'REDIS_URL',
  'ARCANOS_GPT_ACCESS_TOKEN',
  'ARCANOS_GPT_ACCESS_SCOPES',
  'DIAGNOSTICS_SHARED_METRICS',
  'SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG',
  'RUN_WORKERS',
  'DISABLE_EXTERNAL_CALLS'
] as const;

const originalHealthEnvironment = Object.fromEntries(
  HEALTH_ENV_NAMES.map((name) => [name, process.env[name]])
) as Record<(typeof HEALTH_ENV_NAMES)[number], string | undefined>;

describe('actual Express startup health route ordering', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.OPENAI_API_KEY = 'test-openai-api-key';
    // Keep an explicit blank sentinel so env.ts cannot backfill a developer
    // DATABASE_URL from .env when this isolated module graph is loaded.
    process.env.DATABASE_URL = '';
    process.env.REDIS_URL = 'redis://health.invalid:6379';
    process.env.ARCANOS_GPT_ACCESS_TOKEN = 'test-startup-health-token';
    process.env.ARCANOS_GPT_ACCESS_SCOPES = 'diagnostics.read';
    process.env.DIAGNOSTICS_SHARED_METRICS = 'false';
    process.env.SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG = CURRENT_GPT_ROUTER_HASH;
    process.env.RUN_WORKERS = 'false';
    process.env.DISABLE_EXTERNAL_CALLS = 'true';
  });

  afterEach(() => {
    for (const name of HEALTH_ENV_NAMES) {
      const originalValue = originalHealthEnvironment[name];
      if (originalValue === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = originalValue;
      }
    }
  });

  it('keeps liveness public while readiness tracks STARTING, DEGRADED, and READY', async () => {
    const harness = await buildAppHealthHarness();

    const startingHealth = await request(harness.app).get('/health');
    const startingHealthz = await request(harness.app).get('/healthz');
    const startingReady = await request(harness.app).get('/readyz');

    expect(startingHealth.status).toBe(200);
    expect(startingHealth.body).toEqual(expect.objectContaining({
      status: 'ok',
      startup: expect.objectContaining({
        phase: 'STARTING',
        ready: false,
        listener_bound: true
      }),
      dependencies: {
        redis: expect.objectContaining({
          ready: false,
          status: 'starting',
          code: 'REDIS_INITIALIZING'
        })
      }
    }));
    expect(startingHealthz.status).toBe(200);
    expect(startingHealthz.body.startup).toEqual(expect.objectContaining({
      phase: 'STARTING',
      ready: false
    }));
    expect(startingReady.status).toBe(503);
    expect(startingReady.body).toEqual(expect.objectContaining({
      ready: false,
      status: 'unhealthy'
    }));
    expect(startingReady.body.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'redis', code: 'REDIS_INITIALIZING', healthy: false }),
      expect.objectContaining({ name: 'startup', code: 'APPLICATION_STARTING', healthy: false })
    ]));

    harness.setRedisSnapshot(redisSnapshot('DEGRADED'));
    harness.setStartupSnapshot(startupSnapshot('DEGRADED'));
    const degradedHealth = await request(harness.app).get('/health');
    const degradedHealthz = await request(harness.app).get('/healthz');
    const degradedReady = await request(harness.app).get('/readyz');

    expect(degradedHealth.status).toBe(200);
    expect(degradedHealth.body).toEqual(expect.objectContaining({
      startup: expect.objectContaining({ phase: 'DEGRADED', ready: false }),
      dependencies: {
        redis: expect.objectContaining({
          ready: false,
          status: 'degraded',
          code: 'REDIS_DEPENDENCY_UNAVAILABLE',
          retry_scheduled: true
        })
      }
    }));
    expect(degradedHealthz.status).toBe(200);
    expect(degradedHealthz.body.startup.phase).toBe('DEGRADED');
    expect(degradedReady.status).toBe(503);
    expect(degradedReady.body.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'redis',
        code: 'REDIS_DEPENDENCY_UNAVAILABLE',
        healthy: false
      }),
      expect.objectContaining({
        name: 'startup',
        code: 'APPLICATION_DEGRADED',
        healthy: false
      })
    ]));

    harness.setRedisSnapshot(redisSnapshot('READY', { recoveryCount: 1 }));
    harness.setStartupSnapshot(startupSnapshot('READY'));
    const readyHealth = await request(harness.app).get('/health');
    const readyHealthz = await request(harness.app).get('/healthz');
    const readyResponse = await request(harness.app).get('/readyz');

    expect(readyHealth.status).toBe(200);
    expect(readyHealth.body.startup).toEqual(expect.objectContaining({
      phase: 'READY',
      ready: true
    }));
    expect(readyHealthz.status).toBe(200);
    expect(readyHealthz.body.startup.phase).toBe('READY');
    expect(readyResponse.status).toBe(200);
    expect(readyResponse.body).toEqual(expect.objectContaining({
      ready: true,
      status: 'healthy'
    }));

    expect(harness.createClientMock).not.toHaveBeenCalled();
  });

  it('keeps GPT Access health responsive with sanitized startup and Redis state', async () => {
    const harness = await buildAppHealthHarness();
    const authorize = () => request(harness.app)
      .get('/gpt-access/health')
      .set('Authorization', 'Bearer test-startup-health-token')
      .expect('content-type', /json/u);

    const starting = await authorize();
    expect(starting.status).toBe(200);
    expect(starting.body).toEqual(expect.objectContaining({
      ok: true,
      status: 'starting',
      startup: { phase: 'STARTING', ready: false },
      dependencies: {
        redis: expect.objectContaining({
          ready: false,
          status: 'starting',
          code: 'REDIS_INITIALIZING'
        })
      }
    }));

    harness.setRedisSnapshot(redisSnapshot('DEGRADED'));
    harness.setStartupSnapshot(startupSnapshot('DEGRADED'));
    const degraded = await authorize();
    expect(degraded.status).toBe(200);
    expect(degraded.body).toEqual(expect.objectContaining({
      ok: true,
      status: 'degraded',
      startup: { phase: 'DEGRADED', ready: false },
      dependencies: {
        redis: expect.objectContaining({
          ready: false,
          status: 'degraded',
          code: 'REDIS_DEPENDENCY_UNAVAILABLE',
          retryScheduled: true
        })
      }
    }));
    expect(JSON.stringify(degraded.body)).not.toContain('REDIS_CONNECTION_REFUSED');

    harness.setRedisSnapshot(redisSnapshot('READY', { recoveryCount: 1 }));
    harness.setStartupSnapshot(startupSnapshot('READY'));
    const ready = await authorize();
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual(expect.objectContaining({
      ok: true,
      status: 'healthy',
      startup: { phase: 'READY', ready: true },
      dependencies: {
        redis: expect.objectContaining({
          ready: true,
          status: 'ready',
          code: null,
          retryScheduled: false
        })
      }
    }));
    expect(harness.createClientMock).not.toHaveBeenCalled();
  });
});
