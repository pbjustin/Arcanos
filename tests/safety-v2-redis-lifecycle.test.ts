import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

interface FakeRedisClient {
  set: jest.Mock;
  pExpire: jest.Mock;
  del: jest.Mock;
  eval: jest.Mock;
  quit: jest.Mock;
  close: jest.Mock;
  destroy: jest.Mock;
}

function dependencyUnavailableError(): Error & { code: string; dependency: string } {
  return Object.assign(new Error('Redis dependency is unavailable.'), {
    name: 'DependencyUnavailableError',
    code: 'REDIS_DEPENDENCY_UNAVAILABLE',
    dependency: 'redis'
  });
}

let readyClient: FakeRedisClient | null = null;
const executeRedisOperationMock = jest.fn(async (
  operation: (client: FakeRedisClient) => Promise<unknown>,
  _options?: Record<string, unknown>
) => {
  const client = readyClient;
  if (!client) {
    throw dependencyUnavailableError();
  }
  try {
    return await operation(client);
  } catch (error) {
    if ((error as { code?: unknown }).code === 'REDIS_DEPENDENCY_UNAVAILABLE') {
      throw error;
    }
    throw dependencyUnavailableError();
  }
});

jest.unstable_mockModule('@platform/runtime/redisLifecycle.js', () => ({
  executeRedisOperation: executeRedisOperationMock
}));

const redisBoundary = await import('../src/services/safety/v2/redisClient.js');
const { DistributedLock } = await import('../src/services/safety/v2/lock.js');

function createFakeRedisClient(): FakeRedisClient {
  return {
    set: jest.fn(async () => 'OK'),
    pExpire: jest.fn(async () => true),
    del: jest.fn(async () => 1),
    eval: jest.fn(async () => 1),
    quit: jest.fn(async () => undefined),
    close: jest.fn(async () => undefined),
    destroy: jest.fn()
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('safety v2 shared Redis lifecycle boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    readyClient = null;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('fails closed immediately and uses the recovered shared client without a restart', async () => {
    await expect(redisBoundary.setNX(
      'nonce:unavailable',
      30,
      'trace-unavailable'
    )).rejects.toMatchObject({
      code: 'REDIS_DEPENDENCY_UNAVAILABLE'
    });

    const client = createFakeRedisClient();
    readyClient = client;

    await expect(redisBoundary.setNX(
      'nonce:recovered',
      30,
      'trace-recovered'
    )).resolves.toBe(true);
    expect(client.set).toHaveBeenCalledWith('nonce:recovered', '1', {
      NX: true,
      EX: 30
    });
    expect(executeRedisOperationMock).toHaveBeenLastCalledWith(
      expect.any(Function),
      {
        operation: 'safety.nonce.consume',
        correlationId: 'trace-recovered'
      }
    );

    await redisBoundary.disconnectRedis();
    expect(client.quit).not.toHaveBeenCalled();
    expect(client.close).not.toHaveBeenCalled();
    expect(client.destroy).not.toHaveBeenCalled();
  });

  it('routes helper commands through the shared operation boundary', async () => {
    const client = createFakeRedisClient();
    client.set.mockResolvedValueOnce(null);
    readyClient = client;

    await expect(redisBoundary.setNX('nonce:duplicate', 15)).resolves.toBe(false);
    await expect(redisBoundary.extendTTL('lock:active', 2_000)).resolves.toBe(true);
    await expect(redisBoundary.deleteKey('lock:active')).resolves.toBeUndefined();

    expect(executeRedisOperationMock).toHaveBeenCalledTimes(3);
    expect(client.pExpire).toHaveBeenCalledWith('lock:active', 2_000);
    expect(client.del).toHaveBeenCalledWith('lock:active');

    await expect(redisBoundary.setNX('nonce:expired', 0)).rejects.toThrow('Invalid TTL');
    expect(executeRedisOperationMock).toHaveBeenCalledTimes(3);
  });

  it('keeps atomic lock release on the shared boundary and emits no sensitive error detail', async () => {
    const client = createFakeRedisClient();
    client.eval.mockRejectedValueOnce(new Error('redis://user:secret@private.internal:6379'));
    readyClient = client;
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const lock = new DistributedLock('sensitive-operation', {
      ttlMs: 5_000,
      heartbeatMs: 2_000
    });

    await lock.acquire();
    await expect(lock.release()).resolves.toBeUndefined();

    expect(client.set).toHaveBeenCalledWith(
      'lock:sensitive-operation',
      expect.any(String),
      { NX: true, PX: 5_000 }
    );
    expect(client.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("del"'),
      {
        keys: ['lock:sensitive-operation'],
        arguments: [expect.any(String)]
      }
    );
    expect(consoleError).toHaveBeenCalledWith('[v2/lock] failed to release lock');
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('secret');
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('private.internal');
  });

  it('serializes heartbeat work and waits for it before conditional release', async () => {
    jest.useFakeTimers();
    const heartbeat = createDeferred<number>();
    const client = createFakeRedisClient();
    client.eval
      .mockImplementationOnce(() => heartbeat.promise)
      .mockResolvedValueOnce(1);
    readyClient = client;
    const onLockLost = jest.fn();
    const lock = new DistributedLock('serialized-heartbeat', {
      ttlMs: 10_000,
      heartbeatMs: 2_000,
      onLockLost
    });
    await lock.acquire();

    await jest.advanceTimersByTimeAsync(2_000);
    expect(client.eval).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(client.eval).toHaveBeenCalledTimes(1);

    let releaseSettled = false;
    const releasePromise = lock.release().finally(() => {
      releaseSettled = true;
    });
    await Promise.resolve();
    expect(releaseSettled).toBe(false);
    expect(client.eval).toHaveBeenCalledTimes(1);

    heartbeat.resolve(1);
    await releasePromise;
    expect(client.eval).toHaveBeenCalledTimes(2);
    expect(onLockLost).not.toHaveBeenCalled();
  });
});
