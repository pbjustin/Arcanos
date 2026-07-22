import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
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
    expect(manager.getReadyClient()).toBeNull();
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
    expect(manager.getReadyClient()).toBe(client);
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

    expect(manager.getSnapshot().state).toBe('DEGRADED');
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

    await expect(manager.executeOperation(operation)).rejects.toEqual(expect.objectContaining({
      name: 'DependencyUnavailableError',
      dependency: 'redis',
      code: 'REDIS_DEPENDENCY_UNAVAILABLE',
      message: 'Redis dependency is unavailable.'
    }));
    expect(operation).not.toHaveBeenCalled();
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
      { timeoutMs: 50 }
    );
    const operationRejection = expect(operationPromise).rejects.toEqual(expect.objectContaining({
      code: 'REDIS_DEPENDENCY_UNAVAILABLE',
      message: 'Redis dependency is unavailable.'
    }));
    await jest.advanceTimersByTimeAsync(50);

    await operationRejection;
    expect(manager.getReadyClient()).toBeNull();
    expect(manager.getSnapshot()).toEqual(expect.objectContaining({
      state: 'DEGRADED',
      connected: false,
      lastErrorCode: 'REDIS_OPERATION_TIMEOUT'
    }));
    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(clientFactory).toHaveBeenCalledTimes(1);

    reconnect.resolve(undefined);
    stalledOperation.resolve('late secret redis://user:password@host');
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
    expect(manager.getReadyClient()).toBeNull();
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
    expect(manager.getReadyClient()).toBeNull();
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
      { timeoutMs: 5_000 }
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
