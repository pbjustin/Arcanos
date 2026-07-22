import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

type SelfHealTelemetryModule = typeof import('../src/services/selfImprove/selfHealTelemetry.js');
type RedisLifecycleSnapshot = import('../src/platform/runtime/redisLifecycle.js').RedisLifecycleSnapshot;

interface FakeRedisTelemetryClient {
  get: jest.Mock;
  set: jest.Mock;
}

interface TelemetryRedisHarness {
  moduleUnderTest: SelfHealTelemetryModule;
  client: FakeRedisTelemetryClient;
  setReadyClient: (client: FakeRedisTelemetryClient | null) => void;
  emitLifecycle: (snapshot: RedisLifecycleSnapshot) => void;
  subscribeMock: jest.Mock;
  unsubscribeMock: jest.Mock;
  getReadyClientMock: jest.Mock;
  loggerWarnMock: jest.Mock;
}

function lifecycleSnapshot(
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

function persistedEvent(params: {
  id: string;
  timestamp: string;
  kind: 'success' | 'failure';
  reason: string;
}) {
  return {
    id: params.id,
    timestamp: params.timestamp,
    kind: params.kind,
    type: params.kind,
    source: 'persisted-self-heal',
    trigger: 'startup',
    reason: params.reason,
    actionTaken: null,
    healedComponent: 'redis',
    payload: null,
    details: null,
    correlationId: null,
    requestId: null,
    traceId: null
  };
}

function persistedStateJson(): string {
  const success = persistedEvent({
    id: 'persisted_event_1',
    timestamp: '2026-07-21T11:59:00.000Z',
    kind: 'success',
    reason: 'persisted recovery event'
  });
  return JSON.stringify({
    version: 1,
    storedAt: '2026-07-21T11:59:01.000Z',
    nextSequence: 2,
    recentEvents: [success],
    lastTrigger: null,
    lastAttempt: null,
    lastSuccess: success,
    lastFailure: null,
    lastFallback: null
  });
}

async function flushAsyncWork(iterations = 12): Promise<void> {
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    await Promise.resolve();
  }
}

async function loadTelemetryRedisHarness(
  initialSnapshot: RedisLifecycleSnapshot = lifecycleSnapshot('STARTING')
): Promise<TelemetryRedisHarness> {
  jest.resetModules();
  Reflect.deleteProperty(globalThis, '__ARCANOS_SELF_HEAL_TELEMETRY__');

  const lifecycleListeners = new Set<(snapshot: RedisLifecycleSnapshot) => void>();
  const unsubscribeMock = jest.fn();
  let readyClient: FakeRedisTelemetryClient | null = null;
  const client: FakeRedisTelemetryClient = {
    get: jest.fn(async () => null),
    set: jest.fn(async () => 'OK')
  };
  const getReadyClientMock = jest.fn(() => readyClient);
  const loggerWarnMock = jest.fn();
  const subscribeMock = jest.fn((listener: (snapshot: RedisLifecycleSnapshot) => void) => {
    lifecycleListeners.add(listener);
    listener(initialSnapshot);
    return () => {
      lifecycleListeners.delete(listener);
      unsubscribeMock();
    };
  });

  jest.unstable_mockModule('@platform/runtime/redisLifecycle.js', () => ({
    executeRedisOperation: jest.fn(async (
      operation: (client: FakeRedisTelemetryClient) => Promise<unknown>,
      operationOptions?: { client?: FakeRedisTelemetryClient }
    ) => {
      const operationClient = operationOptions?.client ?? readyClient;
      if (!operationClient) {
        throw new Error('REDIS_DEPENDENCY_UNAVAILABLE');
      }
      return operation(operationClient);
    }),
    getReadyRedisClient: getReadyClientMock,
    subscribeRedisLifecycle: subscribeMock
  }));
  jest.unstable_mockModule('@platform/runtime/redis.js', () => ({
    resolveConfiguredRedisConnection: jest.fn(() => ({
      configured: true,
      source: 'REDIS_URL',
      url: 'redis://telemetry.invalid:6379'
    }))
  }));
  jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
    aiLogger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    },
    logger: {
      info: jest.fn(),
      warn: loggerWarnMock,
      error: jest.fn(),
      debug: jest.fn(),
      child: jest.fn(() => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
      }))
    }
  }));

  const moduleUnderTest = await import('../src/services/selfImprove/selfHealTelemetry.js');
  moduleUnderTest.resetSelfHealTelemetryForTests();

  return {
    moduleUnderTest,
    client,
    setReadyClient(nextClient): void {
      readyClient = nextClient;
    },
    emitLifecycle(snapshot): void {
      for (const listener of lifecycleListeners) {
        listener(snapshot);
      }
    },
    subscribeMock,
    unsubscribeMock,
    getReadyClientMock,
    loggerWarnMock
  };
}

const TELEMETRY_ENV_NAMES = [
  'NODE_ENV',
  'REDIS_URL',
  'SELF_HEAL_TELEMETRY_FILE',
  'RAILWAY_VOLUME_MOUNT_PATH',
  'RAILWAY_SERVICE_NAME',
  'RAILWAY_ENVIRONMENT'
] as const;

const originalTelemetryEnvironment = Object.fromEntries(
  TELEMETRY_ENV_NAMES.map((name) => [name, process.env[name]])
) as Record<(typeof TELEMETRY_ENV_NAMES)[number], string | undefined>;

describe('self-heal telemetry Redis lifecycle integration', () => {
  const loadedModules: SelfHealTelemetryModule[] = [];
  let consoleLogSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.REDIS_URL = 'redis://telemetry.invalid:6379';
    process.env.RAILWAY_SERVICE_NAME = 'ARCANOS V2';
    process.env.RAILWAY_ENVIRONMENT = 'production';
    delete process.env.SELF_HEAL_TELEMETRY_FILE;
    delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    for (const telemetryModule of loadedModules.splice(0)) {
      await telemetryModule.stopSelfHealTelemetryPersistence();
      telemetryModule.resetSelfHealTelemetryForTests();
    }
    jest.useRealTimers();
    consoleLogSpy.mockRestore();
    for (const name of TELEMETRY_ENV_NAMES) {
      const originalValue = originalTelemetryEnvironment[name];
      if (originalValue === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = originalValue;
      }
    }
  });

  it('returns immediately while Redis is absent, then merges and flushes local outage events once', async () => {
    const harness = await loadTelemetryRedisHarness();
    loadedModules.push(harness.moduleUnderTest);
    harness.client.get.mockResolvedValue(persistedStateJson());

    await expect(harness.moduleUnderTest.primeSelfHealTelemetryPersistence()).resolves.toBeUndefined();

    expect(harness.subscribeMock).toHaveBeenCalledTimes(1);
    expect(harness.client.get).not.toHaveBeenCalled();
    harness.moduleUnderTest.recordSelfHealEvent({
      kind: 'failure',
      source: 'startup',
      trigger: 'redis.outage',
      reason: 'local outage event',
      healedComponent: 'redis',
      timestamp: '2026-07-21T12:00:00.000Z'
    });
    expect(harness.moduleUnderTest.buildSelfHealTelemetrySnapshot({
      enabled: true,
      active: false
    }).recentEvents.map((event) => event.reason)).toEqual(['local outage event']);

    harness.setReadyClient(harness.client);
    harness.emitLifecycle(lifecycleSnapshot('READY'));
    await flushAsyncWork();

    expect(harness.client.get).toHaveBeenCalledTimes(1);
    expect(harness.client.set).toHaveBeenCalledTimes(1);
    const snapshot = harness.moduleUnderTest.buildSelfHealTelemetrySnapshot({
      enabled: true,
      active: false
    });
    expect(snapshot.recentEvents.map((event) => event.reason)).toEqual([
      'persisted recovery event',
      'local outage event'
    ]);
    expect(snapshot.lastSuccess?.reason).toBe('persisted recovery event');
    expect(snapshot.lastFailure?.reason).toBe('local outage event');
    expect(snapshot.persistence).toEqual(expect.objectContaining({
      mode: 'redis',
      durable: true,
      restoredFromDisk: true,
      lastSaveError: null
    }));

    const flushedState = JSON.parse(String(harness.client.set.mock.calls[0]?.[1]));
    expect(flushedState.recentEvents.map((event: { reason: string }) => event.reason)).toEqual([
      'persisted recovery event',
      'local outage event'
    ]);
  });

  it('deduplicates subscriptions and hydration across repeated READY notifications and flapping', async () => {
    const harness = await loadTelemetryRedisHarness(lifecycleSnapshot('READY'));
    loadedModules.push(harness.moduleUnderTest);
    harness.client.get.mockResolvedValue(null);
    harness.setReadyClient(harness.client);

    await harness.moduleUnderTest.primeSelfHealTelemetryPersistence();
    await harness.moduleUnderTest.primeSelfHealTelemetryPersistence();
    await harness.moduleUnderTest.primeSelfHealTelemetryPersistence();
    await flushAsyncWork();

    expect(harness.subscribeMock).toHaveBeenCalledTimes(1);
    expect(harness.client.get).toHaveBeenCalledTimes(1);
    expect(harness.client.set).not.toHaveBeenCalled();

    harness.emitLifecycle(lifecycleSnapshot('READY'));
    harness.emitLifecycle(lifecycleSnapshot('READY'));
    await flushAsyncWork();
    expect(harness.client.get).toHaveBeenCalledTimes(1);
    expect(harness.client.set).not.toHaveBeenCalled();

    harness.setReadyClient(null);
    harness.emitLifecycle(lifecycleSnapshot('DEGRADED'));
    harness.setReadyClient(harness.client);
    harness.emitLifecycle(lifecycleSnapshot('READY', {
      recoveryCount: 1,
      lastReadyAt: '2026-07-21T12:01:00.000Z'
    }));
    harness.emitLifecycle(lifecycleSnapshot('READY', {
      recoveryCount: 1,
      lastReadyAt: '2026-07-21T12:01:00.000Z'
    }));
    await flushAsyncWork();

    expect(harness.subscribeMock).toHaveBeenCalledTimes(1);
    expect(harness.client.get).toHaveBeenCalledTimes(1);
    expect(harness.client.set).toHaveBeenCalledTimes(1);
  });

  it('cancels hydration retries and lifecycle notifications when stopped', async () => {
    jest.useFakeTimers();
    const harness = await loadTelemetryRedisHarness();
    loadedModules.push(harness.moduleUnderTest);
    harness.client.get.mockRejectedValue(new Error('Redis read unavailable'));

    await harness.moduleUnderTest.primeSelfHealTelemetryPersistence();
    harness.setReadyClient(harness.client);
    harness.emitLifecycle(lifecycleSnapshot('READY'));
    await flushAsyncWork();
    expect(harness.client.get).toHaveBeenCalledTimes(1);

    await harness.moduleUnderTest.stopSelfHealTelemetryPersistence();
    expect(harness.unsubscribeMock).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(5_000);
    harness.emitLifecycle(lifecycleSnapshot('READY', {
      recoveryCount: 1,
      lastReadyAt: '2026-07-21T12:01:00.000Z'
    }));
    await flushAsyncWork();

    expect(harness.client.get).toHaveBeenCalledTimes(1);
    expect(harness.client.set).not.toHaveBeenCalled();
  });

  it('contains unexpected hydration failures and retries with sanitized telemetry', async () => {
    jest.useFakeTimers();
    const harness = await loadTelemetryRedisHarness();
    loadedModules.push(harness.moduleUnderTest);
    harness.client.get.mockResolvedValue(null);
    harness.setReadyClient(harness.client);
    const secretSentinel = 'redis://user:secret@telemetry.invalid:6379';
    const toISOStringSpy = jest.spyOn(Date.prototype, 'toISOString')
      .mockImplementationOnce(() => {
        throw new Error(secretSentinel);
      });

    try {
      await harness.moduleUnderTest.primeSelfHealTelemetryPersistence();
      harness.emitLifecycle(lifecycleSnapshot('READY'));
      await flushAsyncWork();

      expect(harness.client.get).toHaveBeenCalledTimes(1);
      expect(harness.moduleUnderTest.buildSelfHealTelemetrySnapshot({
        enabled: true,
        active: false
      }).persistence.lastSaveError).toBe('REDIS_DEPENDENCY_UNAVAILABLE');
      expect(harness.loggerWarnMock).toHaveBeenCalledWith(
        'self_heal.telemetry.redis_hydration_failed',
        {
          module: 'self-heal-telemetry',
          errorCode: 'REDIS_DEPENDENCY_UNAVAILABLE'
        }
      );
      expect(JSON.stringify(harness.loggerWarnMock.mock.calls)).not.toContain(secretSentinel);

      await jest.advanceTimersByTimeAsync(1_000);
      await flushAsyncWork();

      expect(harness.client.get).toHaveBeenCalledTimes(2);
      expect(harness.moduleUnderTest.buildSelfHealTelemetrySnapshot({
        enabled: true,
        active: false
      }).persistence.lastSaveError).toBeNull();
    } finally {
      toISOStringSpy.mockRestore();
    }
  });
});
