import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { RedisLifecycleSnapshot } from '../src/platform/runtime/redisLifecycle.js';
import type { StartServerOptions } from '../src/server.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeHttpServer extends EventEmitter {
  readonly close = jest.fn((callback?: (error?: Error) => void) => {
    callback?.();
    return this;
  });

  readonly closeIdleConnections = jest.fn();
  readonly closeAllConnections = jest.fn();
}

function buildFakeApp(sequence: string[]): {
  app: Express;
  server: FakeHttpServer;
  listenMock: jest.Mock;
} {
  const server = new FakeHttpServer();
  const listenMock = jest.fn(() => {
    sequence.push('listener.bind');
    queueMicrotask(() => server.emit('listening'));
    return server as unknown as Server;
  });
  const app = {
    listen: listenMock
  } as unknown as Express;

  return { app, server, listenMock };
}

function redisSnapshot(
  state: RedisLifecycleSnapshot['state'],
  overrides: Partial<RedisLifecycleSnapshot> = {}
): RedisLifecycleSnapshot {
  return {
    state,
    configured: true,
    connected: state === 'READY',
    attemptInFlight: state === 'STARTING',
    readyGeneration: state === 'READY' ? 1 : 0,
    circuitEnabled: true,
    circuitState: state === 'READY' ? 'CLOSED' : state === 'STARTING' ? 'HALF_OPEN' : 'OPEN',
    circuitFailureThreshold: 1,
    attempt: state === 'STARTING' ? 0 : 1,
    recoveryCount: 0,
    retryScheduled: state === 'DEGRADED',
    lastTransitionAt: '2026-07-21T12:00:00.000Z',
    lastReadyAt: state === 'READY' ? '2026-07-21T12:00:00.000Z' : null,
    lastErrorCode: state === 'DEGRADED' ? 'REDIS_CONNECTION_REFUSED' : null,
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
    },
    ...overrides
  };
}

async function flushAsyncWork(iterations = 10): Promise<void> {
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    await Promise.resolve();
  }
}

describe('web server startup resilience', () => {
  const originalPort = process.env.PORT;
  const originalHost = process.env.HOST;
  const originalNodeEnv = process.env.NODE_ENV;
  let consoleLogSpy: ReturnType<typeof jest.spyOn>;
  let consoleErrorSpy: ReturnType<typeof jest.spyOn>;
  let consoleWarnSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.PORT = '32123';
    process.env.HOST = '127.0.0.1';
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    if (originalPort === undefined) {
      delete process.env.PORT;
    } else {
      process.env.PORT = originalPort;
    }
    if (originalHost === undefined) {
      delete process.env.HOST;
    } else {
      process.env.HOST = originalHost;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('binds before deferred dependencies and Redis, then starts the full runtime once', async () => {
    jest.resetModules();
    const serverModule = await import('../src/server.js');
    const startupLifecycle = await import('../src/platform/runtime/startupLifecycle.js');
    startupLifecycle.resetStartupLifecycleForTests();

    const sequence: string[] = [];
    const dependencies = createDeferred<void>();
    const { app, server, listenMock } = buildFakeApp(sequence);
    let lifecycleListener: ((snapshot: RedisLifecycleSnapshot) => void) | null = null;
    const performPreflight = jest.fn(async () => {
      sequence.push('preflight');
    });
    const initializeDependencies = jest.fn(() => {
      sequence.push('dependencies.start');
      return dependencies.promise;
    });
    const startRedis = jest.fn(() => {
      sequence.push('redis.start');
    });
    const startAppRuntimeOnce = jest.fn(() => {
      sequence.push('runtime.start');
      return true;
    });
    const startSelfHealing = jest.fn(() => ({
      loopRunning: true,
      intervalMs: 30_000
    }));
    const subscribeRedis = jest.fn((listener: (snapshot: RedisLifecycleSnapshot) => void) => {
      lifecycleListener = listener;
      return jest.fn();
    });

    const startedServer = await serverModule.startServer({
      app,
      startAppRuntimeOnce,
      performPreflight,
      initializeDependencies,
      startRedis,
      stopRedis: jest.fn(async () => undefined),
      primeTelemetry: jest.fn(async () => undefined),
      stopTelemetry: jest.fn(async () => undefined),
      getRedisSnapshot: () => redisSnapshot('STARTING'),
      subscribeRedis,
      startSelfHealing: startSelfHealing as never,
      closeDatabase: jest.fn(async () => undefined),
      registerSignalHandlers: false
    });

    expect(startedServer).toBe(server);
    expect(listenMock).toHaveBeenCalledWith(32123, '127.0.0.1');
    expect(sequence.indexOf('listener.bind')).toBeLessThan(sequence.indexOf('redis.start'));
    expect(sequence.indexOf('listener.bind')).toBeLessThan(sequence.indexOf('dependencies.start'));
    expect(startAppRuntimeOnce).not.toHaveBeenCalled();
    expect(startSelfHealing).not.toHaveBeenCalled();
    expect(startupLifecycle.getStartupLifecycleSnapshot()).toEqual(expect.objectContaining({
      phase: 'STARTING',
      ready: false,
      listenerBound: true,
      runtimeInitialized: false,
      redis: expect.objectContaining({ status: 'connecting' })
    }));

    dependencies.resolve(undefined);
    await flushAsyncWork();

    expect(startupLifecycle.getStartupLifecycleSnapshot()).toEqual(expect.objectContaining({
      phase: 'STARTING',
      ready: false,
      listenerBound: true,
      runtimeInitialized: true
    }));
    expect(startAppRuntimeOnce).not.toHaveBeenCalled();

    expect(lifecycleListener).not.toBeNull();
    lifecycleListener?.(redisSnapshot('READY'));
    await flushAsyncWork();

    expect(startupLifecycle.getStartupLifecycleSnapshot()).toEqual(expect.objectContaining({
      phase: 'READY',
      ready: true,
      runtimeInitialized: true,
      redis: expect.objectContaining({ status: 'ready' })
    }));
    expect(startAppRuntimeOnce).toHaveBeenCalledTimes(1);
    expect(startSelfHealing).toHaveBeenCalledTimes(1);

    lifecycleListener?.(redisSnapshot('DEGRADED'));
    lifecycleListener?.(redisSnapshot('READY', { recoveryCount: 1 }));
    await flushAsyncWork();

    expect(startupLifecycle.getStartupLifecycleSnapshot().phase).toBe('READY');
    expect(startAppRuntimeOnce).toHaveBeenCalledTimes(1);
    expect(startSelfHealing).toHaveBeenCalledTimes(1);
  });

  it('suppresses the real canonical coordinator through the explicit web production startup path', async () => {
    const originalRole = process.env.ARCANOS_PROCESS_KIND;
    const originalWorkers = process.env.RUN_WORKERS;
    process.env.ARCANOS_PROCESS_KIND = 'web';
    process.env.RUN_WORKERS = 'true';
    jest.resetModules();
    const serverModule = await import('../src/server.js');
    const coordinator = await import('../src/services/selfImprove/selfHealingLoop.js');
    const startupLifecycle = await import('../src/platform/runtime/startupLifecycle.js');
    startupLifecycle.resetStartupLifecycleForTests();
    coordinator.resetSelfHealingLoopStateForTests();
    const { app } = buildFakeApp([]);
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      await serverModule.startServer({
        app, startAppRuntimeOnce: () => true,
        performPreflight: async () => undefined,
        initializeDependencies: async () => undefined,
        startRedis: () => undefined, stopRedis: async () => undefined,
        primeTelemetry: async () => undefined, stopTelemetry: async () => undefined,
        getRedisSnapshot: () => redisSnapshot('READY'),
        subscribeRedis: () => () => undefined,
        closeDatabase: async () => undefined,
        registerSignalHandlers: false,
      });
      await flushAsyncWork();
      expect(startupLifecycle.getStartupLifecycleSnapshot().ready).toBe(true);
      expect(coordinator.getSelfHealingLoopStatus()).toMatchObject({
        coordinatorState: 'DISABLED', coordinatorReasonCode: 'service_role_suppressed',
        loopRunning: false, tickCount: 0, processKind: 'web',
      });
      await serverModule.shutdownServer('SIGTERM');
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      coordinator.resetSelfHealingLoopStateForTests();
      exitSpy.mockRestore();
      if (originalRole === undefined) delete process.env.ARCANOS_PROCESS_KIND;
      else process.env.ARCANOS_PROCESS_KIND = originalRole;
      if (originalWorkers === undefined) delete process.env.RUN_WORKERS;
      else process.env.RUN_WORKERS = originalWorkers;
    }
  });

  it('keeps the bound listener observable when deferred runtime initialization fails', async () => {
    jest.resetModules();
    const serverModule = await import('../src/server.js');
    const startupLifecycle = await import('../src/platform/runtime/startupLifecycle.js');
    startupLifecycle.resetStartupLifecycleForTests();

    const sequence: string[] = [];
    const { app, server } = buildFakeApp(sequence);
    let lifecycleListener: ((snapshot: RedisLifecycleSnapshot) => void) | null = null;
    const startAppRuntimeOnce = jest.fn(() => true);
    const startSelfHealing = jest.fn(() => ({
      loopRunning: false,
      intervalMs: 30_000
    }));

    const startedServer = await serverModule.startServer({
      app,
      startAppRuntimeOnce,
      performPreflight: jest.fn(async () => undefined),
      initializeDependencies: jest.fn(async () => {
        throw new Error('telemetry initialization failed');
      }),
      startRedis: jest.fn(),
      stopRedis: jest.fn(async () => undefined),
      primeTelemetry: jest.fn(async () => undefined),
      stopTelemetry: jest.fn(async () => undefined),
      getRedisSnapshot: () => redisSnapshot('READY'),
      subscribeRedis: (listener) => {
        lifecycleListener = listener;
        return jest.fn();
      },
      startSelfHealing: startSelfHealing as never,
      closeDatabase: jest.fn(async () => undefined),
      registerSignalHandlers: false
    });
    await flushAsyncWork();

    expect(startedServer).toBe(server);
    expect(startupLifecycle.getStartupLifecycleSnapshot()).toEqual(expect.objectContaining({
      phase: 'DEGRADED',
      ready: false,
      listenerBound: true,
      runtimeInitialized: false,
      runtimeErrorCode: 'RUNTIME_INITIALIZATION_FAILED'
    }));
    expect(startAppRuntimeOnce).not.toHaveBeenCalled();
    expect(startSelfHealing).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[STARTUP] Runtime dependency initialization failed',
      { errorType: 'Error' }
    );

    lifecycleListener?.(redisSnapshot('DEGRADED'));
    await flushAsyncWork();
    expect(startupLifecycle.getStartupLifecycleSnapshot().phase).toBe('DEGRADED');
  });

  it('keeps startup progressing when telemetry priming fails', async () => {
    jest.resetModules();
    const serverModule = await import('../src/server.js');
    const startupLifecycle = await import('../src/platform/runtime/startupLifecycle.js');
    startupLifecycle.resetStartupLifecycleForTests();

    const sequence: string[] = [];
    const { app, server } = buildFakeApp(sequence);
    let lifecycleListener: ((snapshot: RedisLifecycleSnapshot) => void) | null = null;
    const startAppRuntimeOnce = jest.fn(() => true);
    const startSelfHealing = jest.fn(() => ({
      loopRunning: true,
      intervalMs: 30_000
    }));
    const primeTelemetry = jest.fn(async () => {
      throw new Error('telemetry persistence failed');
    });

    const startedServer = await serverModule.startServer({
      app,
      startAppRuntimeOnce,
      performPreflight: jest.fn(async () => undefined),
      initializeDependencies: jest.fn(async () => undefined),
      startRedis: jest.fn(),
      stopRedis: jest.fn(async () => undefined),
      primeTelemetry,
      stopTelemetry: jest.fn(async () => undefined),
      getRedisSnapshot: () => redisSnapshot('STARTING'),
      subscribeRedis: (listener) => {
        lifecycleListener = listener;
        return jest.fn();
      },
      startSelfHealing: startSelfHealing as never,
      closeDatabase: jest.fn(async () => undefined),
      registerSignalHandlers: false
    });
    await flushAsyncWork();

    expect(startedServer).toBe(server);
    expect(primeTelemetry).toHaveBeenCalledTimes(1);
    expect(startupLifecycle.getStartupLifecycleSnapshot()).toEqual(expect.objectContaining({
      phase: 'STARTING',
      listenerBound: true,
      runtimeInitialized: true,
      runtimeErrorCode: null
    }));
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[STARTUP] Self-heal telemetry priming deferred',
      { errorType: 'Error' }
    );

    lifecycleListener?.(redisSnapshot('READY'));
    await flushAsyncWork();

    expect(startupLifecycle.getStartupLifecycleSnapshot().phase).toBe('READY');
    expect(startAppRuntimeOnce).toHaveBeenCalledTimes(1);
    expect(startSelfHealing).toHaveBeenCalledTimes(1);
  });

  it('stops accepting work and closes each resource once in dependency order', async () => {
    jest.resetModules();
    const serverModule = await import('../src/server.js');
    const startupLifecycle = await import('../src/platform/runtime/startupLifecycle.js');
    startupLifecycle.resetStartupLifecycleForTests();

    const sequence: string[] = [];
    const { app, server } = buildFakeApp(sequence);
    const unsubscribe = jest.fn(() => sequence.push('redis.unsubscribe'));
    const stopTelemetry = jest.fn(async () => {
      sequence.push('telemetry.stop');
    });
    const stopRedis = jest.fn(async () => {
      sequence.push('redis.stop');
    });
    const closeDatabase = jest.fn(async () => {
      sequence.push('database.close');
    });
    server.close.mockImplementation((callback?: (error?: Error) => void) => {
      sequence.push('listener.drain');
      callback?.();
      return server;
    });
    server.closeIdleConnections.mockImplementation(() => {
      sequence.push('listener.stop_accepting');
    });
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    try {
      await serverModule.startServer({
        app,
        startAppRuntimeOnce: jest.fn(() => true),
        performPreflight: jest.fn(async () => undefined),
        initializeDependencies: jest.fn(async () => undefined),
        startRedis: jest.fn(),
        stopRedis,
        primeTelemetry: jest.fn(async () => undefined),
        stopTelemetry,
        getRedisSnapshot: () => redisSnapshot('READY'),
        subscribeRedis: (listener) => {
          listener(redisSnapshot('READY'));
          return unsubscribe;
        },
        startSelfHealing: jest.fn(() => ({
          loopRunning: true,
          intervalMs: 30_000
        })) as never,
        closeDatabase,
        registerSignalHandlers: false
      });
      await flushAsyncWork();

      await serverModule.shutdownServer('SIGTERM');

      expect(sequence).toEqual(expect.arrayContaining([
        'listener.stop_accepting',
        'listener.drain',
        'redis.unsubscribe',
        'telemetry.stop',
        'redis.stop',
        'database.close'
      ]));
      expect(sequence.indexOf('listener.stop_accepting')).toBeLessThan(sequence.indexOf('listener.drain'));
      expect(sequence.indexOf('listener.drain')).toBeLessThan(sequence.indexOf('redis.unsubscribe'));
      expect(sequence.indexOf('redis.unsubscribe')).toBeLessThan(sequence.indexOf('telemetry.stop'));
      expect(sequence.indexOf('telemetry.stop')).toBeLessThan(sequence.indexOf('redis.stop'));
      expect(sequence.indexOf('redis.stop')).toBeLessThan(sequence.indexOf('database.close'));
      expect(stopTelemetry).toHaveBeenCalledTimes(1);
      expect(stopRedis).toHaveBeenCalledTimes(1);
      expect(closeDatabase).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(startupLifecycle.getStartupLifecycleSnapshot()).toEqual(expect.objectContaining({
        phase: 'DEGRADED',
        ready: false,
        shuttingDown: true
      }));
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('preserves dependencies while an active request is still draining', async () => {
    jest.resetModules();
    const serverModule = await import('../src/server.js');
    const startupLifecycle = await import('../src/platform/runtime/startupLifecycle.js');
    startupLifecycle.resetStartupLifecycleForTests();

    const sequence: string[] = [];
    const { app, server } = buildFakeApp(sequence);
    let finishListenerDrain: ((error?: Error) => void) | null = null;
    server.close.mockImplementation((callback?: (error?: Error) => void) => {
      sequence.push('listener.drain_started');
      finishListenerDrain = callback ?? null;
      return server;
    });
    server.closeIdleConnections.mockImplementation(() => {
      sequence.push('listener.stop_accepting');
    });
    const stopTelemetry = jest.fn(async () => {
      sequence.push('telemetry.stop');
    });
    const stopRedis = jest.fn(async () => {
      sequence.push('redis.stop');
    });
    const closeDatabase = jest.fn(async () => {
      sequence.push('database.close');
    });
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    try {
      await serverModule.startServer({
        app,
        startAppRuntimeOnce: jest.fn(() => true),
        performPreflight: jest.fn(async () => undefined),
        initializeDependencies: jest.fn(async () => undefined),
        startRedis: jest.fn(),
        stopRedis,
        primeTelemetry: jest.fn(async () => undefined),
        stopTelemetry,
        getRedisSnapshot: () => redisSnapshot('READY'),
        subscribeRedis: (listener) => {
          listener(redisSnapshot('READY'));
          return jest.fn(() => sequence.push('redis.unsubscribe'));
        },
        startSelfHealing: jest.fn(() => ({
          loopRunning: true,
          intervalMs: 30_000
        })) as never,
        closeDatabase,
        registerSignalHandlers: false
      });
      await flushAsyncWork();

      const shutdownPromise = serverModule.shutdownServer('SIGTERM');
      await flushAsyncWork();

      expect(stopTelemetry).not.toHaveBeenCalled();
      expect(stopRedis).not.toHaveBeenCalled();
      expect(closeDatabase).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(sequence).toContain('listener.stop_accepting');

      expect(finishListenerDrain).not.toBeNull();
      finishListenerDrain?.();
      await shutdownPromise;

      expect(stopTelemetry).toHaveBeenCalledTimes(1);
      expect(stopRedis).toHaveBeenCalledTimes(1);
      expect(closeDatabase).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe('bounded server shutdown with admitted coordinator operations', () => {
  const originalEnvironment = process.env;

  beforeEach(() => {
    process.env = { ...originalEnvironment, NODE_ENV: 'test', PORT: '32123', HOST: '127.0.0.1', ARCANOS_SHUTDOWN_TIMEOUT_MS: '100' };
    jest.resetModules();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    process.env = originalEnvironment;
  });

  async function startFixture(overrides: Partial<StartServerOptions> = {}) {
    const serverModule = await import('../src/server.js');
    const startupLifecycle = await import('../src/platform/runtime/startupLifecycle.js');
    startupLifecycle.resetStartupLifecycleForTests();
    const sequence: string[] = [];
    const { app, server } = buildFakeApp(sequence);
    const stopSelfHealing = jest.fn(async () => { sequence.push('coordinator.drained'); });
    const stopTelemetry = jest.fn(async () => { sequence.push('telemetry.stop'); });
    const stopRedis = jest.fn(async () => { sequence.push('redis.stop'); });
    const closeDatabase = jest.fn(async () => { sequence.push('database.close'); });
    const startSelfHealing = jest.fn(() => ({ loopRunning: false, intervalMs: 30_000 }));
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    await serverModule.startServer({
      app,
      performPreflight: async () => undefined,
      startAppRuntimeOnce: () => true,
      initializeDependencies: async () => undefined,
      startRedis: () => undefined,
      primeTelemetry: async () => undefined,
      getRedisSnapshot: () => redisSnapshot('READY'),
      subscribeRedis: () => () => { sequence.push('redis.unsubscribe'); },
      startSelfHealing: startSelfHealing as never,
      stopSelfHealing,
      stopTelemetry,
      stopRedis,
      closeDatabase,
      registerSignalHandlers: false,
      ...overrides
    });
    await flushAsyncWork();
    return { ...serverModule, startupLifecycle, server, sequence, exit, stopSelfHealing, stopTelemetry, stopRedis, closeDatabase, startSelfHealing };
  }

  it('waits for the coordinator to release admitted dependency operations before closing them', async () => {
    const operation = createDeferred<void>();
    let activeOperations = 1;
    let admitsEvaluations = true;
    const stopSelfHealing = jest.fn(async () => {
      admitsEvaluations = false;
      await operation.promise;
      activeOperations -= 1;
    });
    const stopRedis = jest.fn(async () => { expect(activeOperations).toBe(0); });
    const fixture = await startFixture({ stopSelfHealing, stopRedis });
    const shutdown = fixture.shutdownServer('SIGTERM');
    await flushAsyncWork();
    expect(admitsEvaluations).toBe(false);
    expect(fixture.startupLifecycle.getStartupLifecycleSnapshot()).toMatchObject({ ready: false, shuttingDown: true });
    expect(fixture.server.close).toHaveBeenCalledTimes(1);
    expect(fixture.stopTelemetry).not.toHaveBeenCalled();
    expect(stopRedis).not.toHaveBeenCalled();
    expect(fixture.closeDatabase).not.toHaveBeenCalled();
    expect(fixture.exit).not.toHaveBeenCalled();
    operation.resolve(undefined);
    await shutdown;
    expect(stopRedis).toHaveBeenCalledTimes(1);
    expect(fixture.closeDatabase).toHaveBeenCalledTimes(1);
    expect(fixture.exit.mock.calls).toEqual([[0]]);
  });

  it('returns one pending completion and runs cleanup once for duplicate shutdown calls', async () => {
    const operation = createDeferred<void>();
    const stopSelfHealing = jest.fn(() => operation.promise);
    const fixture = await startFixture({ stopSelfHealing });
    const first = fixture.shutdownServer('SIGTERM');
    const second = fixture.shutdownServer('SIGINT');
    expect(second).toBe(first);
    await flushAsyncWork();
    expect(stopSelfHealing).toHaveBeenCalledTimes(1);
    expect(fixture.server.close).toHaveBeenCalledTimes(1);
    expect(fixture.exit).not.toHaveBeenCalled();
    operation.resolve(undefined);
    await Promise.all([first, second]);
    expect(fixture.stopTelemetry).toHaveBeenCalledTimes(1);
    expect(fixture.stopRedis).toHaveBeenCalledTimes(1);
    expect(fixture.closeDatabase).toHaveBeenCalledTimes(1);
    expect(fixture.exit.mock.calls).toEqual([[0]]);
  });

  it.each(['rejected coordinator', 'throwing coordinator', 'failed listener'] as const)(
    'keeps the other drain observed after a %s and reports failure without unsafe teardown',
    async (failure) => {
      const remainingDrain = createDeferred<void>();
      const error = new Error(`synthetic ${failure}`);
      const stopSelfHealing = jest.fn(() => {
        if (failure === 'throwing coordinator') throw error;
        return failure === 'rejected coordinator' ? Promise.reject(error) : remainingDrain.promise;
      });
      const fixture = await startFixture({ stopSelfHealing });
      fixture.server.close.mockImplementation(callback => {
        if (failure === 'failed listener') callback?.(error);
        else void remainingDrain.promise.then(() => { callback?.(); });
        return fixture.server;
      });
      const shutdown = fixture.shutdownServer('SIGTERM');
      await flushAsyncWork();
      expect(fixture.server.close).toHaveBeenCalledTimes(1);
      expect(fixture.exit).not.toHaveBeenCalled();
      expect(fixture.stopTelemetry).not.toHaveBeenCalled();
      remainingDrain.resolve(undefined);
      await shutdown;
      expect(fixture.stopTelemetry).not.toHaveBeenCalled();
      expect(fixture.stopRedis).not.toHaveBeenCalled();
      expect(fixture.closeDatabase).not.toHaveBeenCalled();
      expect(fixture.server.closeAllConnections).toHaveBeenCalledTimes(1);
      expect(fixture.exit.mock.calls).toEqual([[1]]);
      expect(console.error).toHaveBeenCalledWith('[SHUTDOWN] Graceful shutdown failed:', error);
    }
  );

  it('bounds a hung coordinator by the original deadline and never tears dependencies down after timeout', async () => {
    const operation = createDeferred<void>();
    const fixture = await startFixture({ stopSelfHealing: () => operation.promise });
    jest.useFakeTimers();
    const shutdown = fixture.shutdownServer('SIGTERM');
    await jest.advanceTimersByTimeAsync(99);
    expect(fixture.exit).not.toHaveBeenCalled();
    expect(fixture.shutdownServer('SIGINT')).toBe(shutdown);
    await jest.advanceTimersByTimeAsync(1);
    await shutdown;
    expect(fixture.server.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(fixture.exit.mock.calls).toEqual([[1]]);
    expect(console.error).toHaveBeenCalledWith('[SHUTDOWN] Timed out after 100ms; forcing process exit.');
    operation.resolve(undefined);
    await flushAsyncWork();
    expect(fixture.stopTelemetry).not.toHaveBeenCalled();
    expect(fixture.stopRedis).not.toHaveBeenCalled();
    expect(fixture.closeDatabase).not.toHaveBeenCalled();
    expect(fixture.exit).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('applies the same deadline to dependency cleanup and prevents later phases after it expires', async () => {
    const telemetry = createDeferred<void>();
    const fixture = await startFixture({ stopTelemetry: () => telemetry.promise });
    jest.useFakeTimers();
    const shutdown = fixture.shutdownServer('SIGTERM');
    await jest.advanceTimersByTimeAsync(100);
    await shutdown;
    telemetry.resolve(undefined);
    await flushAsyncWork();
    expect(fixture.stopRedis).not.toHaveBeenCalled();
    expect(fixture.closeDatabase).not.toHaveBeenCalled();
    expect(fixture.exit.mock.calls).toEqual([[1]]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['completed', 'failed'] as const)('drains partially initialized startup when initialization %s', async outcome => {
    const initialization = createDeferred<void>();
    const fixture = await startFixture({ initializeDependencies: () => initialization.promise });
    expect(fixture.startSelfHealing).not.toHaveBeenCalled();
    const shutdown = fixture.shutdownServer('SIGTERM');
    await flushAsyncWork();
    expect(fixture.stopTelemetry).not.toHaveBeenCalled();
    expect(fixture.stopRedis).not.toHaveBeenCalled();
    if (outcome === 'completed') initialization.resolve(undefined);
    else initialization.reject(new Error('synthetic startup failure'));
    await shutdown;
    expect(fixture.startSelfHealing).not.toHaveBeenCalled();
    expect(fixture.stopTelemetry).toHaveBeenCalledTimes(1);
    expect(fixture.stopRedis).toHaveBeenCalledTimes(1);
    expect(fixture.closeDatabase).toHaveBeenCalledTimes(1);
    expect(fixture.exit.mock.calls).toEqual([[0]]);
    expect(fixture.startupLifecycle.getStartupLifecycleSnapshot()).toMatchObject({ ready: false, shuttingDown: true });
  });
});

describe('startup lifecycle transitions', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    jest.resetModules();
  });

  it('moves STARTING to DEGRADED to READY and refuses recovery after shutdown', async () => {
    jest.resetModules();
    const lifecycle = await import('../src/platform/runtime/startupLifecycle.js');
    lifecycle.resetStartupLifecycleForTests();

    expect(lifecycle.getStartupLifecycleSnapshot().phase).toBe('STARTING');
    lifecycle.markStartupListenerBound();
    lifecycle.markStartupRuntimeInitialized();
    lifecycle.updateStartupRedisLifecycle({
      configured: true,
      status: 'unavailable',
      attempt: 1,
      lastErrorCode: 'REDIS_CONNECTION_REFUSED'
    });
    expect(lifecycle.getStartupLifecycleSnapshot()).toEqual(expect.objectContaining({
      phase: 'DEGRADED',
      ready: false
    }));

    lifecycle.updateStartupRedisLifecycle({
      configured: true,
      status: 'ready',
      attempt: 2,
      lastErrorCode: null
    });
    expect(lifecycle.getStartupLifecycleSnapshot()).toEqual(expect.objectContaining({
      phase: 'READY',
      ready: true
    }));

    lifecycle.markStartupShutdown();
    lifecycle.updateStartupRedisLifecycle({
      configured: true,
      status: 'ready',
      attempt: 3,
      lastErrorCode: null
    });
    expect(lifecycle.getStartupLifecycleSnapshot()).toEqual(expect.objectContaining({
      phase: 'DEGRADED',
      ready: false,
      shuttingDown: true,
      redis: expect.objectContaining({ status: 'stopped' })
    }));
  });
});

describe('server entrypoint failure handling', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('logs only a sanitized error type before exiting', async () => {
    jest.resetModules();
    const secretSentinel = 'redis://user:secret@startup.invalid:6379';
    const startServer = jest.fn(async () => {
      throw new Error(secretSentinel);
    });
    jest.unstable_mockModule('../src/server.js', () => ({ startServer }));
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    try {
      await import('../src/start-server.js');
      await flushAsyncWork();

      expect(startServer).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[STARTUP] Fatal startup failure:',
        { errorType: 'Error' }
      );
      expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain(secretSentinel);
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });

});
