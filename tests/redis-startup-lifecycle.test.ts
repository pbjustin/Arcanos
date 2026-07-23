import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { SimpleError } from 'redis';
import {
  RedisLifecycleManager,
  type RedisLifecycleClient,
  type RedisLifecycleClientFactory,
  type RedisLifecycleSleep
} from '../src/platform/runtime/redisLifecycle.js';

type RedisEventListener = (...args: unknown[]) => void;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function redisError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

class FakeRedisClient {
  isOpen = false;
  isReady = false;
  private readonly listeners = new Map<string, Set<RedisEventListener>>();
  private connectBehaviors: Array<() => Promise<void>> = [];

  readonly connect = jest.fn(async () => {
    this.isOpen = true;
    const behavior = this.connectBehaviors.shift();
    try {
      await (behavior?.() ?? Promise.resolve());
      if (this.isOpen) {
        this.isReady = true;
      }
    } catch (error) {
      this.isOpen = false;
      this.isReady = false;
      throw error;
    }
  });

  readonly ping = jest.fn(async () => 'PONG');

  readonly close = jest.fn(async () => {
    this.isOpen = false;
    this.isReady = false;
  });

  readonly destroy = jest.fn(() => {
    this.isOpen = false;
    this.isReady = false;
  });

  readonly on = jest.fn((event: string, listener: RedisEventListener) => {
    const eventListeners = this.listeners.get(event) ?? new Set<RedisEventListener>();
    eventListeners.add(listener);
    this.listeners.set(event, eventListeners);
    return this;
  });

  queueConnect(...behaviors: Array<() => Promise<void>>): void {
    this.connectBehaviors.push(...behaviors);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

interface ManualSleepCall {
  delayMs: number;
  signal: AbortSignal;
  settled: boolean;
  resolve: () => void;
  reject: (reason?: unknown) => void;
}

function createManualSleep(): {
  sleep: RedisLifecycleSleep;
  calls: ManualSleepCall[];
  resolveNext: (delayMs: number) => void;
} {
  const calls: ManualSleepCall[] = [];
  const sleep: RedisLifecycleSleep = (delayMs, signal) => new Promise<void>((resolve, reject) => {
    const call: ManualSleepCall = {
      delayMs,
      signal,
      settled: false,
      resolve: () => {
        if (call.settled) {
          return;
        }
        call.settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      reject
    };
    const onAbort = () => {
      if (call.settled) {
        return;
      }
      call.settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(new Error('sleep aborted'));
    };

    calls.push(call);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });

  return {
    sleep,
    calls,
    resolveNext(delayMs: number): void {
      const call = calls.find((candidate) => !candidate.settled && candidate.delayMs === delayMs);
      if (!call) {
        throw new Error(`No pending ${delayMs}ms sleep.`);
      }
      call.resolve();
    }
  };
}

async function flushAsyncWork(iterations = 16): Promise<void> {
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    await Promise.resolve();
  }
}

const REDIS_ENV_NAMES = [
  'REDIS_URL',
  'REDISHOST',
  'REDIS_HOST',
  'REDISPORT',
  'REDIS_PORT',
  'REDISUSER',
  'REDIS_USER',
  'REDISPASSWORD',
  'REDIS_PASSWORD'
] as const;

const originalRedisEnvironment = Object.fromEntries(
  REDIS_ENV_NAMES.map((name) => [name, process.env[name]])
) as Record<(typeof REDIS_ENV_NAMES)[number], string | undefined>;

describe('RedisLifecycleManager', () => {
  const managers: RedisLifecycleManager[] = [];

  function createManager(
    client: FakeRedisClient,
    options: {
      sleep?: RedisLifecycleSleep;
      random?: () => number;
    } = {}
  ): { manager: RedisLifecycleManager; clientFactory: jest.Mock } {
    const clientFactory = jest.fn(() => client as unknown as RedisLifecycleClient);
    const manager = new RedisLifecycleManager({
      clientFactory: clientFactory as unknown as RedisLifecycleClientFactory,
      sleep: options.sleep,
      random: options.random ?? (() => 0),
      now: () => new Date('2026-07-21T12:00:00.000Z')
    });
    managers.push(manager);
    return { manager, clientFactory };
  }

  beforeEach(() => {
    jest.useFakeTimers();
    for (const name of REDIS_ENV_NAMES) {
      delete process.env[name];
    }
    process.env.REDIS_URL = 'redis://lifecycle.invalid:6379';
  });

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.stop()));
    jest.useRealTimers();
    for (const name of REDIS_ENV_NAMES) {
      const originalValue = originalRedisEnvironment[name];
      if (originalValue === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = originalValue;
      }
    }
  });

  it('classifies connection refusal and keeps a retry scheduled', async () => {
    const client = new FakeRedisClient();
    client.queueConnect(async () => {
      throw redisError('ECONNREFUSED', 'connect ECONNREFUSED');
    });
    const { manager } = createManager(client);

    manager.start();
    await flushAsyncWork();

    expect(manager.getSnapshot()).toEqual(expect.objectContaining({
      state: 'DEGRADED',
      configured: true,
      connected: false,
      attempt: 1,
      retryScheduled: true,
      lastErrorCode: 'REDIS_CONNECTION_REFUSED'
    }));
    expect(manager.getSnapshot().connected).toBe(false);
  });

  it('bounds a stalled connect attempt and destroys its socket before retrying', async () => {
    const client = new FakeRedisClient();
    client.queueConnect(() => new Promise<void>(() => undefined));
    const { manager } = createManager(client);

    manager.start();
    await jest.advanceTimersByTimeAsync(3_000);

    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(manager.getSnapshot()).toEqual(expect.objectContaining({
      state: 'DEGRADED',
      connected: false,
      retryScheduled: true,
      lastErrorCode: 'REDIS_CONNECT_TIMEOUT'
    }));
  });

  it('classifies authentication failures without retaining the raw error', async () => {
    const client = new FakeRedisClient();
    client.queueConnect(async () => {
      throw redisError('WRONGPASS', 'WRONGPASS invalid username-password pair');
    });
    const { manager } = createManager(client);

    manager.start();
    await flushAsyncWork();

    const snapshot = manager.getSnapshot();
    expect(snapshot.lastErrorCode).toBe('REDIS_AUTH_FAILED');
    expect(JSON.stringify(snapshot)).not.toContain('username-password');
    expect(JSON.stringify(snapshot)).not.toContain('lifecycle.invalid');
  });

  it('classifies DNS failures and unexpected PING responses deterministically', async () => {
    const dnsClient = new FakeRedisClient();
    dnsClient.queueConnect(async () => {
      throw redisError('ENOTFOUND', 'getaddrinfo ENOTFOUND lifecycle.invalid');
    });
    const { manager: dnsManager } = createManager(dnsClient);
    dnsManager.start();
    await flushAsyncWork();

    expect(dnsManager.getSnapshot().lastErrorCode).toBe('REDIS_DNS_UNAVAILABLE');

    const invalidPingClient = new FakeRedisClient();
    invalidPingClient.ping.mockResolvedValue('NOT_PONG');
    const { manager: invalidPingManager } = createManager(invalidPingClient);
    invalidPingManager.start();
    await flushAsyncWork();

    expect(invalidPingManager.getSnapshot()).toEqual(expect.objectContaining({
      state: 'DEGRADED',
      retryScheduled: true,
      lastErrorCode: 'REDIS_UNEXPECTED_RESPONSE'
    }));
  });

  it('accepts TLS Redis URLs and treats malformed explicit URLs as degraded', async () => {
    const tlsClient = new FakeRedisClient();
    process.env.REDIS_URL = 'rediss://tls.invalid:6380';
    const { manager: tlsManager, clientFactory } = createManager(tlsClient);

    tlsManager.start();
    await flushAsyncWork();

    expect(clientFactory).toHaveBeenCalledWith(expect.objectContaining({
      url: 'rediss://tls.invalid:6380'
    }));
    expect(tlsManager.getSnapshot()).toEqual(expect.objectContaining({
      state: 'READY',
      configured: true,
      connected: true
    }));

    const invalidClient = new FakeRedisClient();
    process.env.REDIS_URL = 'https://user:secret@not-redis.invalid';
    const { manager: invalidManager, clientFactory: invalidClientFactory } = createManager(invalidClient);
    invalidManager.start();
    await flushAsyncWork();

    expect(invalidClientFactory).not.toHaveBeenCalled();
    expect(invalidManager.getSnapshot()).toEqual(expect.objectContaining({
      state: 'DEGRADED',
      configured: true,
      connected: false,
      retryScheduled: true,
      lastErrorCode: 'REDIS_CONFIGURATION_INVALID'
    }));
    expect(JSON.stringify(invalidManager.getSnapshot())).not.toContain('secret');
  });

  it('recovers automatically when Redis returns after startup', async () => {
    const client = new FakeRedisClient();
    client.queueConnect(
      async () => {
        throw redisError('ECONNREFUSED', 'connect ECONNREFUSED');
      },
      async () => undefined
    );
    const { manager } = createManager(client);

    manager.start();
    await flushAsyncWork();
    expect(manager.getSnapshot().state).toBe('DEGRADED');

    await jest.advanceTimersByTimeAsync(250);

    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(client.ping).toHaveBeenCalledTimes(1);
    expect(manager.getSnapshot()).toEqual(expect.objectContaining({
      state: 'READY',
      connected: true,
      retryScheduled: false,
      recoveryCount: 1,
      lastErrorCode: null
    }));
    expect(manager.getSnapshot().connected).toBe(true);
  });

  it('serializes reconnect work while Redis is flapping', async () => {
    const reconnect = createDeferred<void>();
    const client = new FakeRedisClient();
    client.queueConnect(async () => undefined, () => reconnect.promise);
    const { manager, clientFactory } = createManager(client);

    manager.start();
    await flushAsyncWork();
    expect(manager.getSnapshot().state).toBe('READY');

    client.emit('error', redisError('ECONNRESET', 'connection lost'));
    client.emit('error', redisError('ECONNRESET', 'connection lost again'));
    client.emit('error', redisError('ECONNRESET', 'connection lost again'));
    await flushAsyncWork();

    expect(manager.getSnapshot()).toEqual(expect.objectContaining({
      state: 'DEGRADED',
      circuitState: 'OPEN',
      attemptInFlight: false,
      retryScheduled: true
    }));
    expect(client.connect).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(250);

    expect(manager.getSnapshot().circuitState).toBe('HALF_OPEN');
    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(clientFactory).toHaveBeenCalledTimes(1);

    reconnect.resolve(undefined);
    await flushAsyncWork();

    expect(manager.getSnapshot()).toEqual(expect.objectContaining({
      state: 'READY',
      connected: true,
      recoveryCount: 1
    }));
    expect(client.connect).toHaveBeenCalledTimes(2);
  });

  it('reconnects after a clean Redis disconnect event', async () => {
    const client = new FakeRedisClient();
    client.queueConnect(async () => undefined, async () => undefined);
    const { manager } = createManager(client);

    manager.start();
    await flushAsyncWork();
    expect(manager.getSnapshot().state).toBe('READY');

    client.isOpen = false;
    client.isReady = false;
    client.emit('end');
    await flushAsyncWork();

    expect(manager.getSnapshot().circuitState).toBe('OPEN');
    await jest.advanceTimersByTimeAsync(250);

    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(manager.getSnapshot()).toEqual(expect.objectContaining({
      state: 'READY',
      connected: true,
      recoveryCount: 1
    }));
  });

  it('starts once and creates one client across repeated start calls', async () => {
    const client = new FakeRedisClient();
    const { manager, clientFactory } = createManager(client);

    manager.start();
    manager.start();
    manager.start();
    await flushAsyncWork();

    expect(clientFactory).toHaveBeenCalledTimes(1);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.ping).toHaveBeenCalledTimes(1);
    expect(manager.getSnapshot().state).toBe('READY');
  });

  it('fails required operations immediately while Redis is unavailable', async () => {
    const client = new FakeRedisClient();
    const { manager } = createManager(client);
    const operation = jest.fn(async () => 'unused');

    await expect(manager.executeOperation(operation, {
      operation: 'diagnostics.metrics.read'
    })).rejects.toEqual(expect.objectContaining({
      name: 'DependencyUnavailableError',
      dependency: 'redis',
      code: 'REDIS_DEPENDENCY_UNAVAILABLE',
      message: 'Redis dependency is unavailable.'
    }));
    expect(operation).not.toHaveBeenCalled();
  });

  it('rechecks the gate immediately before a Redis callback begins', async () => {
    const client = new FakeRedisClient();
    const { manager } = createManager(client);
    manager.start();
    await flushAsyncWork();
    expect(manager.getSnapshot().circuitState).toBe('CLOSED');

    const operation = jest.fn(async () => 'must-not-run');
    const operationPromise = manager.executeOperation(operation, {
      operation: 'diagnostics.metrics.read',
      correlationId: 'trace-gate-race'
    });
    client.emit('error', redisError('ECONNRESET', 'connection lost before callback'));

    await expect(operationPromise).rejects.toEqual(expect.objectContaining({
      code: 'REDIS_DEPENDENCY_UNAVAILABLE'
    }));
    expect(operation).not.toHaveBeenCalled();
    expect(manager.getSnapshot()).toEqual(expect.objectContaining({
      state: 'DEGRADED',
      circuitState: 'OPEN',
      retryScheduled: true
    }));
  });

  it('rejects stale generation results without poisoning the recovered connection', async () => {
    const oldSuccess = createDeferred<string>();
    const oldFailure = createDeferred<string>();
    const client = new FakeRedisClient();
    client.queueConnect(async () => undefined, async () => undefined);
    const { manager, clientFactory } = createManager(client);
    manager.start();
    await flushAsyncWork();

    const successPromise = manager.executeOperation(
      () => oldSuccess.promise,
      { operation: 'diagnostics.metrics.read' }
    );
    const failurePromise = manager.executeOperation(
      () => oldFailure.promise,
      { operation: 'diagnostics.metrics.record' }
    );
    await flushAsyncWork();
    expect(manager.getSnapshot().operationGate.inFlight).toBe(2);

    client.emit('error', redisError('ECONNRESET', 'connection generation one lost'));
    await flushAsyncWork();
    expect(manager.getSnapshot().circuitState).toBe('OPEN');

    await jest.advanceTimersByTimeAsync(250);
    expect(manager.getSnapshot()).toEqual(expect.objectContaining({
      state: 'READY',
      circuitState: 'CLOSED',
      readyGeneration: 2,
      recoveryCount: 1
    }));

    const successRejection = expect(successPromise).rejects.toEqual(expect.objectContaining({
      code: 'REDIS_DEPENDENCY_UNAVAILABLE'
    }));
    const failureRejection = expect(failurePromise).rejects.toEqual(expect.objectContaining({
      code: 'REDIS_DEPENDENCY_UNAVAILABLE'
    }));
    oldSuccess.resolve('late-generation-one-success');
    oldFailure.reject(redisError('ECONNRESET', 'late-generation-one-failure'));
    await Promise.all([successRejection, failureRejection]);
    await flushAsyncWork();

    expect(manager.getSnapshot()).toEqual(expect.objectContaining({
      state: 'READY',
      circuitState: 'CLOSED',
      readyGeneration: 2,
      recoveryCount: 1
    }));
    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(clientFactory).toHaveBeenCalledTimes(1);
  });

  it('admits no application work while open or half-open and runs one recovery probe', async () => {
    const reconnect = createDeferred<void>();
    const client = new FakeRedisClient();
    client.queueConnect(async () => undefined, () => reconnect.promise);
    const { manager } = createManager(client);
    manager.start();
    await flushAsyncWork();

    client.emit('error', redisError('ECONNRESET', 'connection lost'));
    await flushAsyncWork();
    const operation = jest.fn(async () => 'ok');
    const openResults = await Promise.all(
      Array.from({ length: 16 }, () => manager.executeOperation(operation, {
        operation: 'diagnostics.metrics.read'
      }).catch((error) => error))
    );
    expect(openResults).toHaveLength(16);
    expect(operation).not.toHaveBeenCalled();
    expect(manager.getSnapshot().circuitState).toBe('OPEN');

    await jest.advanceTimersByTimeAsync(250);
    expect(manager.getSnapshot().circuitState).toBe('HALF_OPEN');
    const halfOpenResults = await Promise.all(
      Array.from({ length: 16 }, () => manager.executeOperation(operation, {
        operation: 'diagnostics.metrics.read'
      }).catch((error) => error))
    );
    expect(halfOpenResults).toHaveLength(16);
    expect(operation).not.toHaveBeenCalled();
    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(client.ping).toHaveBeenCalledTimes(1);

    reconnect.resolve(undefined);
    await flushAsyncWork();
    expect(client.ping).toHaveBeenCalledTimes(2);
    expect(manager.getSnapshot().circuitState).toBe('CLOSED');
    await expect(manager.executeOperation(operation, {
      operation: 'diagnostics.metrics.read'
    })).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('caps operation deadline overrides at two seconds', async () => {
    const stalledOperation = createDeferred<string>();
    const client = new FakeRedisClient();
    const { manager } = createManager(client);
    manager.start();
    await flushAsyncWork();

    let settled = false;
    const operationPromise = manager.executeOperation(
      () => stalledOperation.promise,
      {
        operation: 'diagnostics.metrics.read',
        timeoutMs: 60_000
      }
    ).finally(() => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(1_999);
    expect(settled).toBe(false);
    const rejection = expect(operationPromise).rejects.toEqual(expect.objectContaining({
      code: 'REDIS_DEPENDENCY_UNAVAILABLE'
    }));
    await jest.advanceTimersByTimeAsync(1);
    await rejection;
    expect(manager.getSnapshot().operationGate.timedOutTotal).toBe(1);
    expect(manager.getSnapshot().operationGate.inFlight).toBe(1);
    stalledOperation.resolve('late');
    await flushAsyncWork();
    expect(manager.getSnapshot().operationGate.inFlight).toBe(0);
  });

  it('does not reconnect for a logical Redis command rejection', async () => {
    const client = new FakeRedisClient();
    const { manager } = createManager(client);
    manager.start();
    await flushAsyncWork();
    const logicalError = new SimpleError('WRONGTYPE operation against key');

    await expect(manager.executeOperation(
      async () => {
        throw logicalError;
      },
      { operation: 'diagnostics.metrics.read' }
    )).rejects.toEqual(expect.objectContaining({
      code: 'REDIS_DEPENDENCY_UNAVAILABLE'
    }));

    expect(manager.getSnapshot().circuitState).toBe('CLOSED');
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it('opens for an operational Redis reply instead of suppressing recovery', async () => {
    const client = new FakeRedisClient();
    const { manager } = createManager(client);
    manager.start();
    await flushAsyncWork();

    await expect(manager.executeOperation(
      async () => {
        throw new SimpleError('READONLY replica cannot accept writes');
      },
      { operation: 'incident.kill_switch.write_restrictive' }
    )).rejects.toEqual(expect.objectContaining({
      code: 'REDIS_DEPENDENCY_UNAVAILABLE'
    }));

    expect(manager.getSnapshot()).toEqual(expect.objectContaining({
      state: 'DEGRADED',
      circuitState: 'OPEN',
      retryScheduled: true
    }));
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it('bounds a stalled ready-state command and starts one recovery loop', async () => {
    const reconnect = createDeferred<void>();
    const stalledOperation = createDeferred<string>();
    const client = new FakeRedisClient();
    client.queueConnect(async () => undefined, () => reconnect.promise);
    const { manager, clientFactory } = createManager(client);

    manager.start();
    await flushAsyncWork();
    expect(manager.getSnapshot().state).toBe('READY');

    const operationPromise = manager.executeOperation(
      async () => stalledOperation.promise,
      {
        operation: 'diagnostics.metrics.read',
        timeoutMs: 50
      }
    );
    const operationRejection = expect(operationPromise).rejects.toEqual(expect.objectContaining({
      code: 'REDIS_DEPENDENCY_UNAVAILABLE',
      message: 'Redis dependency is unavailable.'
    }));
    await jest.advanceTimersByTimeAsync(50);

    await operationRejection;
    expect(manager.getSnapshot().connected).toBe(false);
    expect(manager.getSnapshot()).toEqual(expect.objectContaining({
      state: 'DEGRADED',
      connected: false,
      circuitState: 'OPEN',
      lastErrorCode: 'REDIS_OPERATION_TIMEOUT'
    }));
    await jest.advanceTimersByTimeAsync(250);
    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(clientFactory).toHaveBeenCalledTimes(1);

    reconnect.resolve(undefined);
    stalledOperation.resolve('late secret redis://user:password@host');
    await flushAsyncWork();
    expect(manager.getSnapshot().operationGate.inFlight).toBe(0);
  });

  it('uses exponential backoff with bounded deterministic jitter and keeps retrying', async () => {
    const manualSleep = createManualSleep();
    const client = new FakeRedisClient();
    client.queueConnect(
      async () => { throw redisError('ECONNREFUSED', 'refused 1'); },
      async () => { throw redisError('ECONNREFUSED', 'refused 2'); },
      async () => { throw redisError('ECONNREFUSED', 'refused 3'); },
      async () => { throw redisError('ECONNREFUSED', 'refused 4'); },
      async () => undefined
    );
    const { manager } = createManager(client, {
      sleep: manualSleep.sleep,
      random: () => 0.5
    });

    manager.start();
    await flushAsyncWork();

    for (const delayMs of [375, 625, 1_125, 2_125]) {
      expect(manualSleep.calls.some((call) => !call.settled && call.delayMs === delayMs)).toBe(true);
      manualSleep.resolveNext(delayMs);
      await flushAsyncWork();
    }

    expect(client.connect).toHaveBeenCalledTimes(5);
    expect(manager.getSnapshot()).toEqual(expect.objectContaining({
      state: 'READY',
      connected: true,
      recoveryCount: 1
    }));
  });

  it('caps deterministic exponential backoff at thirty seconds', async () => {
    const manualSleep = createManualSleep();
    const client = new FakeRedisClient();
    client.queueConnect(
      ...Array.from({ length: 10 }, (_unused, index) => async () => {
        throw redisError('ECONNREFUSED', `refused ${index + 1}`);
      }),
      async () => undefined
    );
    const { manager } = createManager(client, {
      sleep: manualSleep.sleep,
      random: () => 0
    });
    const expectedDelays = [
      250,
      500,
      1_000,
      2_000,
      4_000,
      8_000,
      16_000,
      30_000,
      30_000,
      30_000
    ];

    manager.start();
    await flushAsyncWork();

    for (const delayMs of expectedDelays) {
      manualSleep.resolveNext(delayMs);
      await flushAsyncWork();
    }

    expect(
      manualSleep.calls
        .map((call) => call.delayMs)
        .filter((delayMs) => delayMs !== 3_000)
    ).toEqual(expectedDelays);
    expect(client.connect).toHaveBeenCalledTimes(11);
    expect(manager.getSnapshot()).toEqual(expect.objectContaining({
      state: 'READY',
      circuitState: 'CLOSED',
      recoveryCount: 1
    }));
  });

  it('cancels a scheduled retry and does not reconnect after shutdown', async () => {
    const client = new FakeRedisClient();
    client.queueConnect(async () => {
      throw redisError('ECONNREFUSED', 'connect ECONNREFUSED');
    });
    const { manager } = createManager(client);

    manager.start();
    await flushAsyncWork();
    expect(manager.getSnapshot().retryScheduled).toBe(true);

    await manager.stop();
    await jest.advanceTimersByTimeAsync(60_000);

    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(manager.getSnapshot()).toEqual(expect.objectContaining({
      state: 'DEGRADED',
      connected: false,
      retryScheduled: false
    }));
  });

  it('cancels a pending connection attempt during shutdown and ignores late completion', async () => {
    const pendingConnect = createDeferred<void>();
    const client = new FakeRedisClient();
    client.queueConnect(() => pendingConnect.promise);
    const { manager } = createManager(client);

    manager.start();
    await flushAsyncWork();
    expect(client.connect).toHaveBeenCalledTimes(1);

    await manager.stop();
    pendingConnect.resolve(undefined);
    await flushAsyncWork();

    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(client.ping).not.toHaveBeenCalled();
    expect(manager.getSnapshot().connected).toBe(false);
    expect(manager.getSnapshot()).toEqual(expect.objectContaining({
      state: 'DEGRADED',
      connected: false,
      retryScheduled: false
    }));
  });

  it('destroys a client when shutdown interrupts readiness validation', async () => {
    const pendingPing = createDeferred<string>();
    const client = new FakeRedisClient();
    client.ping.mockImplementation(() => pendingPing.promise);
    const { manager } = createManager(client);

    manager.start();
    await flushAsyncWork();
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.ping).toHaveBeenCalledTimes(1);
    expect(client.isReady).toBe(true);

    await manager.stop();
    pendingPing.resolve('PONG');
    await flushAsyncWork();

    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(client.close).not.toHaveBeenCalled();
    expect(manager.getSnapshot().connected).toBe(false);
  });

  it('ignores stale client events after shutdown', async () => {
    const client = new FakeRedisClient();
    const { manager } = createManager(client);

    manager.start();
    await flushAsyncWork();
    await manager.stop();
    const snapshotAfterStop = manager.getSnapshot();

    client.emit('error', redisError('ECONNRESET', 'late connection loss'));
    client.emit('end');
    await flushAsyncWork();

    expect(manager.getSnapshot()).toEqual(snapshotAfterStop);
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it('closes a ready client cleanly exactly once', async () => {
    const client = new FakeRedisClient();
    const { manager } = createManager(client);

    manager.start();
    await flushAsyncWork();
    expect(manager.getSnapshot().state).toBe('READY');

    await manager.stop();
    await manager.stop();

    expect(client.close).toHaveBeenCalledTimes(1);
    expect(client.destroy).not.toHaveBeenCalled();
  });

  it('destroys a ready client during shutdown when an operation is still active', async () => {
    const stalledOperation = createDeferred<string>();
    const client = new FakeRedisClient();
    const { manager } = createManager(client);

    manager.start();
    await flushAsyncWork();
    expect(manager.getSnapshot().state).toBe('READY');

    const operationPromise = manager.executeOperation(
      async () => stalledOperation.promise,
      {
        operation: 'diagnostics.metrics.read',
        timeoutMs: 5_000
      }
    );
    await flushAsyncWork();

    await manager.stop();
    stalledOperation.resolve('late result');

    await expect(operationPromise).rejects.toEqual(expect.objectContaining({
      code: 'REDIS_DEPENDENCY_UNAVAILABLE'
    }));
    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(client.close).not.toHaveBeenCalled();
  });
});
