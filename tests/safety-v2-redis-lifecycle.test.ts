import { beforeEach, describe, expect, it, jest } from '@jest/globals';

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
const requireReadyRedisClientMock = jest.fn(() => {
  if (!readyClient) {
    throw dependencyUnavailableError();
  }
  return readyClient;
});
const executeRedisOperationMock = jest.fn(async (
  operation: (client: FakeRedisClient) => Promise<unknown>
) => {
  const client = requireReadyRedisClientMock();
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
  executeRedisOperation: executeRedisOperationMock,
  requireReadyRedisClient: requireReadyRedisClientMock
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

describe('safety v2 shared Redis lifecycle boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    readyClient = null;
  });

  it('fails closed immediately and uses the recovered shared client without a restart', async () => {
    const unavailableClient = redisBoundary.getRedis();

    expect(requireReadyRedisClientMock).toHaveBeenCalledTimes(1);
    await expect(unavailableClient).rejects.toMatchObject({
      name: 'DependencyUnavailableError',
      code: 'REDIS_DEPENDENCY_UNAVAILABLE',
      dependency: 'redis',
      message: 'Redis dependency is unavailable.'
    });
    await expect(redisBoundary.setNX('nonce:unavailable', 30)).rejects.toMatchObject({
      code: 'REDIS_DEPENDENCY_UNAVAILABLE'
    });

    const client = createFakeRedisClient();
    readyClient = client;

    await expect(redisBoundary.getRedis()).resolves.toBe(client);
    await expect(redisBoundary.setNX('nonce:recovered', 30)).resolves.toBe(true);
    expect(client.set).toHaveBeenCalledWith('nonce:recovered', '1', {
      NX: true,
      EX: 30
    });

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
});
