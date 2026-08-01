import express, { type NextFunction, type Request, type Response } from 'express';
import { describe, expect, it, jest } from '@jest/globals';

import { DependencyUnavailableError } from '../src/platform/runtime/dependencyLifecycle.js';
import {
  createConfiguredPublicProviderRateLimitStore,
  createInMemoryPublicProviderRateLimitStore,
  createPublicProviderRateLimitCapabilityGate,
  createRedisPublicProviderRateLimitStore,
  probeRedisPublicProviderRateLimitCapability,
  PublicProviderRedisOperationStartRateError,
} from '../src/platform/runtime/publicProviderRateLimitStore.js';
import type {
  RedisLifecycleClient,
  RedisLifecycleSnapshot,
  RedisOperationOptions,
} from '../src/platform/runtime/redisLifecycle.js';
import {
  createPublicProviderRateLimitMiddleware,
} from '../src/transport/http/middleware/publicProviderAdmission.js';
import errorHandler from '../src/transport/http/middleware/errorHandler.js';

const request = (await import('supertest')).default;

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const allowedDecision = {
  allowed: true,
  limitedTier: null,
  client: {
    limit: 2,
    remaining: 1,
    retryAfterMs: 60_000,
    resetTimeMs: 2_060_000,
  },
  global: {
    limit: 3,
    remaining: 2,
    retryAfterMs: 60_000,
    resetTimeMs: 2_060_000,
  },
} as const;

async function waitForStoreCall(storeCall: jest.Mock): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (storeCall.mock.calls.length > 0) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for the rate-limit store call');
}

describe('public provider hierarchical rate-limit stores', () => {
  it('does not spend global capacity when a client is already exhausted', async () => {
    let nowMs = 1_000_000;
    const store = createInMemoryPublicProviderRateLimitStore({ now: () => nowMs });
    const input = {
      clientMaximum: 1,
      globalMaximum: 2,
      windowMs: 60_000,
    };

    const firstA = await store.consume({ ...input, clientIdentity: 'caller-a' });
    const deniedA = await store.consume({ ...input, clientIdentity: 'caller-a' });
    const firstB = await store.consume({ ...input, clientIdentity: 'caller-b' });
    const deniedC = await store.consume({ ...input, clientIdentity: 'caller-c' });

    expect(firstA).toMatchObject({
      allowed: true,
      client: { remaining: 0 },
      global: { remaining: 1 },
    });
    expect(deniedA).toMatchObject({
      allowed: false,
      limitedTier: 'client',
      global: { remaining: 1 },
    });
    expect(firstB).toMatchObject({
      allowed: true,
      global: { remaining: 0 },
    });
    expect(deniedC).toMatchObject({
      allowed: false,
      limitedTier: 'global',
      global: { remaining: 0 },
    });

    nowMs += 60_000;
    await expect(store.consume({ ...input, clientIdentity: 'caller-a' })).resolves.toMatchObject({
      allowed: true,
      client: { remaining: 0 },
      global: { remaining: 1 },
    });
  });

  it('reports the deployment bucket for the legacy maximum of one', async () => {
    const store = createInMemoryPublicProviderRateLimitStore({ now: () => 1_000_000 });
    const input = {
      clientIdentity: 'caller-a',
      clientMaximum: 1,
      globalMaximum: 1,
      windowMs: 60_000,
    };

    await expect(store.consume(input)).resolves.toMatchObject({ allowed: true });
    await expect(store.consume(input)).resolves.toMatchObject({
      allowed: false,
      limitedTier: 'global',
      global: { remaining: 0 },
    });
  });

  it('caches denials for at most one second without shortening Redis Retry-After', async () => {
    let nowMs = 1_000_000;
    const clientDeniedRedis = {
      eval: jest.fn(async () => [0, 1, 1, 60_000, 1, 60_000, 2_000_000]),
    } as unknown as RedisLifecycleClient;
    const clientExecute = async <T>(
      operation: (client: RedisLifecycleClient) => Promise<T>
    ): Promise<T> => operation(clientDeniedRedis);
    const clientStore = createRedisPublicProviderRateLimitStore({
      namespace: 'railway:project:environment:service',
      execute: clientExecute,
      now: () => nowMs,
    });
    const clientInput = {
      clientIdentity: 'caller-a',
      clientMaximum: 1,
      globalMaximum: 3,
      windowMs: 60_000,
    };

    await expect(clientStore.consume(clientInput)).resolves.toMatchObject({
      allowed: false,
      limitedTier: 'client',
    });
    const cachedClientDecisions = await Promise.all(
      Array.from({ length: 20 }, () => clientStore.consume(clientInput))
    );
    expect(clientDeniedRedis.eval).toHaveBeenCalledTimes(1);
    expect(cachedClientDecisions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        allowed: false,
        limitedTier: 'client',
        globalSnapshotFresh: false,
      }),
    ]));

    nowMs += 500;
    await expect(clientStore.consume(clientInput)).resolves.toMatchObject({
      allowed: false,
      client: { retryAfterMs: 59_500 },
    });
    expect(clientDeniedRedis.eval).toHaveBeenCalledTimes(1);

    nowMs += 500;
    await clientStore.consume(clientInput);
    expect(clientDeniedRedis.eval).toHaveBeenCalledTimes(2);

    const globalDeniedRedis = {
      eval: jest.fn(async () => [0, 2, 0, 1000, 3, 1000, 2_000_000]),
    } as unknown as RedisLifecycleClient;
    const globalExecute = async <T>(
      operation: (client: RedisLifecycleClient) => Promise<T>
    ): Promise<T> => operation(globalDeniedRedis);
    const globalStore = createRedisPublicProviderRateLimitStore({
      namespace: 'railway:project:environment:other-service',
      execute: globalExecute,
      now: () => nowMs,
    });
    const globalInput = {
      clientMaximum: 1,
      globalMaximum: 3,
      windowMs: 60_000,
    };

    await globalStore.consume({ ...globalInput, clientIdentity: 'caller-a' });
    await expect(globalStore.consume({
      ...globalInput,
      clientIdentity: 'rotated-caller-b',
    })).resolves.toMatchObject({
      allowed: false,
      limitedTier: 'global',
      clientSnapshotFresh: false,
    });
    expect(globalDeniedRedis.eval).toHaveBeenCalledTimes(1);
  });

  it('never caches beyond a short Redis TTL after operation elapsed time', async () => {
    let nowMs = 1_000_000;
    const redisClient = {
      eval: jest.fn(async () => {
        nowMs += 200;
        return [0, 1, 1, 500, 1, 500, 2_000_000];
      }),
    } as unknown as RedisLifecycleClient;
    const execute = async <T>(
      operation: (client: RedisLifecycleClient) => Promise<T>
    ): Promise<T> => operation(redisClient);
    const store = createRedisPublicProviderRateLimitStore({
      namespace: 'railway:project:environment:short-ttl-service',
      execute,
      now: () => nowMs,
    });
    const input = {
      clientIdentity: 'caller-a',
      clientMaximum: 1,
      globalMaximum: 3,
      windowMs: 60_000,
    };

    await store.consume(input);
    nowMs += 299;
    await expect(store.consume(input)).resolves.toMatchObject({
      allowed: false,
      client: { retryAfterMs: 1 },
    });
    expect(redisClient.eval).toHaveBeenCalledTimes(1);

    nowMs += 1;
    await store.consume(input);
    expect(redisClient.eval).toHaveBeenCalledTimes(2);

    let expiredNowMs = 3_000_000;
    const expiredRedisClient = {
      eval: jest.fn(async () => {
        expiredNowMs += 500;
        return [0, 1, 1, 500, 1, 500, 4_000_000];
      }),
    } as unknown as RedisLifecycleClient;
    const expiredStore = createRedisPublicProviderRateLimitStore({
      namespace: 'railway:project:environment:expired-ttl-service',
      execute: async <T>(
        operation: (client: RedisLifecycleClient) => Promise<T>
      ): Promise<T> => operation(expiredRedisClient),
      now: () => expiredNowMs,
    });

    await expiredStore.consume(input);
    await expiredStore.consume(input);
    expect(expiredRedisClient.eval).toHaveBeenCalledTimes(2);
  });

  it('bounds the process-local client denial cache', async () => {
    const redisClient = {
      eval: jest.fn(async () => [0, 1, 1, 1000, 1, 1000, 2_000_000]),
    } as unknown as RedisLifecycleClient;
    const execute = async <T>(
      operation: (client: RedisLifecycleClient) => Promise<T>
    ): Promise<T> => operation(redisClient);
    const store = createRedisPublicProviderRateLimitStore({
      denialCacheMaximumEntries: 1,
      namespace: 'railway:project:environment:bounded-service',
      execute,
      now: () => 1_000_000,
    });
    const input = {
      clientMaximum: 1,
      globalMaximum: 3,
      windowMs: 60_000,
    };

    await store.consume({ ...input, clientIdentity: 'caller-a' });
    await Promise.all(Array.from(
      { length: 5 },
      () => store.consume({ ...input, clientIdentity: 'caller-a' })
    ));
    expect(redisClient.eval).toHaveBeenCalledTimes(1);
    await store.consume({ ...input, clientIdentity: 'caller-b' });
    await store.consume({ ...input, clientIdentity: 'caller-a' });

    expect(redisClient.eval).toHaveBeenCalledTimes(3);
  });

  it('does not let a saturated Redis-start guard mask lifecycle unavailability', async () => {
    let redisState: Pick<RedisLifecycleSnapshot, 'state' | 'readyGeneration'> = {
      state: 'READY',
      readyGeneration: 1,
    };
    const redisClient = {
      eval: jest.fn(async () => [1, 0, 1, 60_000, 1, 60_000, 2_000_000]),
    } as unknown as RedisLifecycleClient;
    const execute = async <T>(
      operation: (client: RedisLifecycleClient) => Promise<T>
    ): Promise<T> => {
      if (redisState.state !== 'READY') {
        throw new DependencyUnavailableError(
          'redis',
          'REDIS_DEPENDENCY_UNAVAILABLE',
          'Redis dependency is unavailable.'
        );
      }
      return operation(redisClient);
    };
    const store = createRedisPublicProviderRateLimitStore({
      namespace: 'railway:project:environment:outage-service',
      execute,
      getRedisSnapshot: () => redisState,
      now: () => 1_000_000,
      redisOperationStartMaximum: 1,
    });
    const input = {
      clientIdentity: 'caller-a',
      clientMaximum: 2,
      globalMaximum: 3,
      windowMs: 60_000,
    };

    await expect(store.consume(input)).resolves.toMatchObject({ allowed: true });
    redisState = { state: 'DEGRADED', readyGeneration: 1 };
    await expect(store.consume(input)).rejects.toBeInstanceOf(DependencyUnavailableError);
    expect(redisClient.eval).toHaveBeenCalledTimes(1);
  });

  it('uses a default burst of 100 Redis starts with a 100-per-second refill', async () => {
    let nowMs = 1_000_000;
    const redisClient = {
      eval: jest.fn(async () => [1, 0, 1, 60_000, 1, 60_000, 2_000_000]),
    } as unknown as RedisLifecycleClient;
    const execute = async <T>(
      operation: (client: RedisLifecycleClient) => Promise<T>
    ): Promise<T> => operation(redisClient);
    const store = createRedisPublicProviderRateLimitStore({
      namespace: 'railway:project:environment:default-start-rate-service',
      execute,
      now: () => nowMs,
    });
    const input = {
      clientMaximum: 1,
      globalMaximum: 1_000_000,
      windowMs: 60_000,
    };

    for (let index = 0; index < 100; index += 1) {
      await store.consume({ ...input, clientIdentity: `caller-${index}` });
    }
    await expect(store.consume({ ...input, clientIdentity: 'caller-overflow' }))
      .rejects.toMatchObject({
        maximum: 100,
        retryAfterMs: 10,
      });
    expect(redisClient.eval).toHaveBeenCalledTimes(100);

    nowMs += 10;
    await expect(store.consume({ ...input, clientIdentity: 'caller-refilled' }))
      .resolves.toMatchObject({ allowed: true });
    expect(redisClient.eval).toHaveBeenCalledTimes(101);
  });

  it('generation-fences denial caches and bypasses them while Redis is unavailable', async () => {
    let redisState: Pick<RedisLifecycleSnapshot, 'state' | 'readyGeneration'> = {
      state: 'READY',
      readyGeneration: 1,
    };
    const redisClient = {
      eval: jest.fn()
        .mockResolvedValueOnce([0, 2, 0, 1000, 3, 1000, 2_000_000])
        .mockResolvedValueOnce([1, 0, 1, 1000, 1, 1000, 2_000_000])
        .mockResolvedValueOnce([0, 2, 0, 1000, 3, 1000, 2_000_000])
        .mockResolvedValueOnce([1, 0, 1, 1000, 1, 1000, 2_000_000]),
    } as unknown as RedisLifecycleClient;
    const execute = async <T>(
      operation: (client: RedisLifecycleClient) => Promise<T>
    ): Promise<T> => {
      if (redisState.state !== 'READY') {
        throw new DependencyUnavailableError(
          'redis',
          'REDIS_DEPENDENCY_UNAVAILABLE',
          'Redis dependency is unavailable.'
        );
      }
      return operation(redisClient);
    };
    const store = createRedisPublicProviderRateLimitStore({
      namespace: 'railway:project:environment:generation-service',
      execute,
      getRedisSnapshot: () => redisState,
      now: () => 1_000_000,
    });
    const input = {
      clientMaximum: 1,
      globalMaximum: 3,
      windowMs: 60_000,
    };

    await expect(store.consume({ ...input, clientIdentity: 'caller-a' }))
      .resolves.toMatchObject({ allowed: false, limitedTier: 'global' });
    await expect(store.consume({ ...input, clientIdentity: 'caller-b' }))
      .resolves.toMatchObject({ allowed: false, clientSnapshotFresh: false });
    expect(redisClient.eval).toHaveBeenCalledTimes(1);

    redisState = { state: 'READY', readyGeneration: 2 };
    await expect(store.consume({ ...input, clientIdentity: 'caller-c' }))
      .resolves.toMatchObject({ allowed: true });
    await expect(store.consume({ ...input, clientIdentity: 'caller-d' }))
      .resolves.toMatchObject({ allowed: false, limitedTier: 'global' });
    await expect(store.consume({ ...input, clientIdentity: 'caller-e' }))
      .resolves.toMatchObject({ allowed: false, clientSnapshotFresh: false });
    expect(redisClient.eval).toHaveBeenCalledTimes(3);

    redisState = { state: 'DEGRADED', readyGeneration: 2 };
    await expect(store.consume({ ...input, clientIdentity: 'caller-f' }))
      .rejects.toBeInstanceOf(DependencyUnavailableError);
    expect(redisClient.eval).toHaveBeenCalledTimes(3);

    redisState = { state: 'READY', readyGeneration: 3 };
    await expect(store.consume({ ...input, clientIdentity: 'caller-g' }))
      .resolves.toMatchObject({ allowed: true });
    expect(redisClient.eval).toHaveBeenCalledTimes(4);
  });

  it('bounds Redis operation starts when client-denial cache churns', async () => {
    let nowMs = 1_000_000;
    const redisClient = {
      eval: jest.fn(async () => [0, 1, 1, 1000, 1, 1000, 2_000_000]),
    } as unknown as RedisLifecycleClient;
    const execute = async <T>(
      operation: (client: RedisLifecycleClient) => Promise<T>
    ): Promise<T> => operation(redisClient);
    const store = createRedisPublicProviderRateLimitStore({
      denialCacheMaximumEntries: 1,
      namespace: 'railway:project:environment:churn-service',
      execute,
      now: () => nowMs,
      redisOperationStartMaximum: 2,
    });
    const input = {
      clientMaximum: 1,
      globalMaximum: 1_000_000,
      windowMs: 60_000,
    };

    await store.consume({ ...input, clientIdentity: 'caller-a' });
    await store.consume({ ...input, clientIdentity: 'caller-b' });
    await expect(store.consume({ ...input, clientIdentity: 'caller-a' }))
      .rejects.toBeInstanceOf(PublicProviderRedisOperationStartRateError);
    expect(redisClient.eval).toHaveBeenCalledTimes(2);

    nowMs += 500;
    await expect(store.consume({ ...input, clientIdentity: 'caller-a' }))
      .resolves.toMatchObject({ allowed: false, limitedTier: 'client' });
    expect(redisClient.eval).toHaveBeenCalledTimes(3);
  });

  it('shares Redis keys across store instances while isolating namespaces and hashing callers', async () => {
    const counters = new Map<string, { count: number; resetTimeMs: number }>();
    const observedKeys: string[][] = [];
    const nowMs = 2_000_000;
    const redisClient = {
      eval: jest.fn(async (
        script: string,
        options: { keys: string[]; arguments: string[] }
      ) => {
        expect(script).toContain('redis.call("TIME")');
        expect(script).toContain('redis.call("INCR", KEYS[1])');
        expect(script).toContain('redis.call("INCR", KEYS[2])');
        observedKeys.push([...options.keys]);
        const [clientKey, globalKey] = options.keys;
        const [windowText, clientMaximumText, globalMaximumText] = options.arguments;
        const windowMs = Number(windowText);
        const clientMaximum = Number(clientMaximumText);
        const globalMaximum = Number(globalMaximumText);
        const read = (key: string) => {
          const entry = counters.get(key);
          return !entry || nowMs >= entry.resetTimeMs
            ? { count: 0, resetTimeMs: nowMs + windowMs }
            : entry;
        };
        const client = read(String(clientKey));
        const global = read(String(globalKey));
        if (client.count >= clientMaximum) {
          return [
            0,
            1,
            client.count,
            client.resetTimeMs - nowMs,
            global.count,
            global.resetTimeMs - nowMs,
            nowMs,
          ];
        }
        if (global.count >= globalMaximum) {
          return [
            0,
            2,
            client.count,
            client.resetTimeMs - nowMs,
            global.count,
            global.resetTimeMs - nowMs,
            nowMs,
          ];
        }
        client.count += 1;
        global.count += 1;
        counters.set(String(clientKey), client);
        counters.set(String(globalKey), global);
        return [
          1,
          0,
          client.count,
          client.resetTimeMs - nowMs,
          global.count,
          global.resetTimeMs - nowMs,
          nowMs,
        ];
      }),
    } as unknown as RedisLifecycleClient;
    const execute = async <T>(
      operation: (client: RedisLifecycleClient) => Promise<T>,
      options: RedisOperationOptions
    ): Promise<T> => {
      expect(options.operation).toBe('public_provider.rate_limit.consume');
      return operation(redisClient);
    };
    const sharedOptions = { namespace: 'railway:project:environment:service', execute };
    const firstReplica = createRedisPublicProviderRateLimitStore(sharedOptions);
    const restartedReplica = createRedisPublicProviderRateLimitStore(sharedOptions);
    const otherEnvironment = createRedisPublicProviderRateLimitStore({
      namespace: 'railway:project:other-environment:service',
      execute,
    });
    const input = {
      clientMaximum: 1,
      globalMaximum: 2,
      windowMs: 60_000,
    };

    await expect(firstReplica.consume({ ...input, clientIdentity: '198.51.100.1' }))
      .resolves.toMatchObject({ allowed: true, global: { remaining: 1 } });
    await expect(restartedReplica.consume({ ...input, clientIdentity: '198.51.100.1' }))
      .resolves.toMatchObject({
        allowed: false,
        limitedTier: 'client',
        global: { remaining: 1 },
      });
    await expect(restartedReplica.consume({ ...input, clientIdentity: '198.51.100.2' }))
      .resolves.toMatchObject({ allowed: true, global: { remaining: 0 } });
    await expect(restartedReplica.consume({ ...input, clientIdentity: '198.51.100.3' }))
      .resolves.toMatchObject({ allowed: false, limitedTier: 'global' });
    await expect(otherEnvironment.consume({ ...input, clientIdentity: '198.51.100.1' }))
      .resolves.toMatchObject({ allowed: true, global: { remaining: 1 } });

    expect(observedKeys.flat().join('\n')).not.toContain('198.51.100');
    for (const [clientKey, globalKey] of observedKeys) {
      const clientHashTag = /\{([^}]+)\}/u.exec(String(clientKey))?.[1];
      const globalHashTag = /\{([^}]+)\}/u.exec(String(globalKey))?.[1];
      expect(clientHashTag).toBeTruthy();
      expect(clientHashTag).toBe(globalHashTag);
    }
    expect(observedKeys[0]?.[1]).toBe(observedKeys[1]?.[1]);
    expect(observedKeys[0]?.[1]).not.toBe(observedKeys.at(-1)?.[1]);
  });

  it('probes the limiter command family with an isolated expiring hashed key', async () => {
    const namespace = 'railway:private-project:preview-environment:web-service';
    const redisClient = {
      eval: jest.fn(async () => [1, 1, 999, 1, 2_000_000]),
    } as unknown as RedisLifecycleClient;
    const execute = async <T>(
      operation: (client: RedisLifecycleClient) => Promise<T>,
      options: RedisOperationOptions
    ): Promise<T> => {
      expect(options.operation).toBe('public_provider.rate_limit.probe');
      return operation(redisClient);
    };

    await expect(probeRedisPublicProviderRateLimitCapability(namespace, {
      execute,
      probeId: 'deterministic-probe',
    })).resolves.toBeUndefined();

    expect(redisClient.eval).toHaveBeenCalledTimes(1);
    const [script, commandOptions] = redisClient.eval.mock.calls[0] ?? [];
    expect(script).toEqual(expect.stringContaining('redis.call("TIME")'));
    expect(script).toEqual(expect.stringContaining('redis.call("GET", KEYS[1])'));
    expect(script).toEqual(expect.stringContaining('redis.call("PTTL", KEYS[1])'));
    expect(script).toEqual(expect.stringContaining('redis.call("PEXPIRE", KEYS[1], 1000)'));
    expect(script).toEqual(expect.stringContaining('redis.call("INCR", KEYS[1])'));
    expect(commandOptions).toEqual({
      keys: [expect.stringContaining(':capability:')],
      arguments: [],
    });
    expect(JSON.stringify(commandOptions)).not.toContain(namespace);
    expect(JSON.stringify(commandOptions)).not.toContain('private-project');
  });

  it('fails malformed Redis capability responses closed', async () => {
    const redisClient = {
      eval: jest.fn(async () => [1, 1, 0, 1, 2_000_000]),
    } as unknown as RedisLifecycleClient;
    const execute = async <T>(
      operation: (client: RedisLifecycleClient) => Promise<T>
    ): Promise<T> => operation(redisClient);

    await expect(probeRedisPublicProviderRateLimitCapability(
      'railway:project:environment:service',
      { execute, probeId: 'malformed-probe' }
    )).rejects.toBeInstanceOf(DependencyUnavailableError);
  });

  it('rejects an impossible capability-probe count for its unique key', async () => {
    const redisClient = {
      eval: jest.fn(async () => [2, 1, 999, 2, 2_000_000]),
    } as unknown as RedisLifecycleClient;
    const execute = async <T>(
      operation: (client: RedisLifecycleClient) => Promise<T>
    ): Promise<T> => operation(redisClient);

    await expect(probeRedisPublicProviderRateLimitCapability(
      'railway:project:environment:service',
      { execute, probeId: 'impossible-count-probe' }
    )).rejects.toBeInstanceOf(DependencyUnavailableError);
  });

  it('fails closed without a production Redis namespace and never enters the handler', async () => {
    const handler = jest.fn((_req: Request, res: Response) => res.json({ ok: true }));
    const store = createConfiguredPublicProviderRateLimitStore({
      mode: 'redis',
      namespace: null,
    });
    const app = express();
    app.use(createPublicProviderRateLimitMiddleware({
      clientIdentityResolver: () => 'caller-a',
      clientMaxRequests: 1,
      maxRequests: 2,
      store,
      windowMs: 60_000,
    }));
    app.post('/provider', handler);
    app.use(errorHandler);

    const response = await request(app).post('/provider');

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('REDIS_DEPENDENCY_UNAVAILABLE');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(handler).not.toHaveBeenCalled();
  });

  it('load-sheds excess Redis admissions without queueing and releases the slot', async () => {
    const deferred = createDeferred<typeof allowedDecision>();
    const store = {
      consume: jest.fn()
        .mockImplementationOnce(() => deferred.promise)
        .mockResolvedValue(allowedDecision),
    };
    const handler = jest.fn((_req: Request, res: Response) => res.json({ ok: true }));
    const limiter = createPublicProviderRateLimitMiddleware({
      clientIdentityResolver: () => 'caller-a',
      clientMaxRequests: 2,
      maxConcurrentStoreOperations: 1,
      maxRequests: 3,
      store,
      windowMs: 60_000,
    });
    const app = express();
    app.use(limiter);
    app.use(limiter);
    app.post('/provider', handler);
    app.use(errorHandler);

    const firstPromise = request(app).post('/provider').then((response) => response);
    await waitForStoreCall(store.consume);
    const overloaded = await request(app).post('/provider');

    expect(overloaded.status).toBe(429);
    expect(overloaded.headers['x-ratelimit-bucket']).toBe(
      'public-provider-admission-concurrency'
    );
    expect(overloaded.headers['x-ratelimit-limit']).toBe('1');
    expect(overloaded.headers['x-ratelimit-remaining']).toBe('0');
    expect(overloaded.headers['x-public-provider-client-remaining']).toBeUndefined();
    expect(overloaded.headers['x-public-provider-global-remaining']).toBeUndefined();
    expect(overloaded.headers['retry-after']).toBe('2');
    expect(overloaded.headers['cache-control']).toBe('no-store');
    expect(store.consume).toHaveBeenCalledTimes(1);

    deferred.resolve(allowedDecision);
    const first = await firstPromise;
    expect(first.status).toBe(200);
    expect(store.consume).toHaveBeenCalledTimes(1);

    const afterRelease = await request(app).post('/provider');
    expect(afterRelease.status).toBe(200);
    expect(store.consume).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('maps the Redis operation-start guard to a distinct no-store 429', async () => {
    const redisClient = {
      eval: jest.fn(async () => [1, 0, 1, 60_000, 1, 60_000, 2_000_000]),
    } as unknown as RedisLifecycleClient;
    const execute = async <T>(
      operation: (client: RedisLifecycleClient) => Promise<T>
    ): Promise<T> => operation(redisClient);
    const store = createRedisPublicProviderRateLimitStore({
      namespace: 'railway:project:environment:start-rate-service',
      execute,
      now: () => 1_000_000,
      redisOperationStartMaximum: 1,
    });
    const handler = jest.fn((_req: Request, res: Response) => res.json({ ok: true }));
    const app = express();
    app.use(createPublicProviderRateLimitMiddleware({
      clientIdentityResolver: () => 'caller-a',
      clientMaxRequests: 2,
      maxRequests: 3,
      store,
      windowMs: 60_000,
    }));
    app.post('/provider', handler);
    app.use(errorHandler);

    expect((await request(app).post('/provider')).status).toBe(200);
    const response = await request(app).post('/provider');

    expect(response.status).toBe(429);
    expect(response.headers['x-ratelimit-bucket']).toBe(
      'public-provider-admission-redis-start-rate'
    );
    expect(response.headers['x-ratelimit-limit']).toBe('1');
    expect(response.headers['x-ratelimit-remaining']).toBe('0');
    expect(response.headers['retry-after']).toBe('1');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(redisClient.eval).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('releases the load-shed slot when the Redis store rejects', async () => {
    const deferred = createDeferred<typeof allowedDecision>();
    const store = {
      consume: jest.fn()
        .mockImplementationOnce(() => deferred.promise)
        .mockResolvedValue(allowedDecision),
    };
    const handler = jest.fn((_req: Request, res: Response) => res.json({ ok: true }));
    const app = express();
    app.use(createPublicProviderRateLimitMiddleware({
      clientIdentityResolver: () => 'caller-a',
      clientMaxRequests: 2,
      maxConcurrentStoreOperations: 1,
      maxRequests: 3,
      store,
      windowMs: 60_000,
    }));
    app.post('/provider', handler);
    app.use(errorHandler);

    const firstPromise = request(app).post('/provider').then((response) => response);
    await waitForStoreCall(store.consume);
    const overloaded = await request(app).post('/provider');
    expect(overloaded.status).toBe(429);

    deferred.reject(new DependencyUnavailableError(
      'redis',
      'REDIS_DEPENDENCY_UNAVAILABLE',
      'Redis dependency is unavailable.'
    ));
    const first = await firstPromise;
    expect(first.status).toBe(503);

    const afterRelease = await request(app).post('/provider');
    expect(afterRelease.status).toBe(200);
    expect(store.consume).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('forwards Redis dependency failures without falling back to memory', async () => {
    const handler = jest.fn((_req: Request, res: Response) => res.json({ ok: true }));
    const failingStore = {
      consume: jest.fn(async () => {
        throw new DependencyUnavailableError(
          'redis',
          'REDIS_DEPENDENCY_UNAVAILABLE',
          'Redis dependency is unavailable.'
        );
      }),
    };
    const app = express();
    app.use(createPublicProviderRateLimitMiddleware({
      clientIdentityResolver: () => 'caller-a',
      clientMaxRequests: 1,
      maxRequests: 2,
      store: failingStore,
      windowMs: 60_000,
    }));
    app.post('/provider', handler);
    app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
      errorHandler(error, req, res, next);
    });

    const response = await request(app).post('/provider');

    expect(response.status).toBe(503);
    expect(failingStore.consume).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it('fails malformed Redis decisions closed before entering the handler', async () => {
    const handler = jest.fn((_req: Request, res: Response) => res.json({ ok: true }));
    const redisClient = {
      eval: jest.fn(async () => [1, 1, 1, 60_000, 1, 60_000, 2_000_000]),
    } as unknown as RedisLifecycleClient;
    const execute = async <T>(
      operation: (client: RedisLifecycleClient) => Promise<T>
    ): Promise<T> => operation(redisClient);
    const onCapabilityFailure = jest.fn();
    const store = createRedisPublicProviderRateLimitStore({
      namespace: 'railway:project:environment:service',
      execute,
      getRedisSnapshot: () => ({ state: 'READY', readyGeneration: 7 }),
      onCapabilityFailure,
    });
    const app = express();
    app.use(createPublicProviderRateLimitMiddleware({
      clientIdentityResolver: () => 'caller-a',
      clientMaxRequests: 1,
      maxRequests: 2,
      store,
      windowMs: 60_000,
    }));
    app.post('/provider', handler);
    app.use(errorHandler);

    const response = await request(app).post('/provider');

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('REDIS_DEPENDENCY_UNAVAILABLE');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(onCapabilityFailure).toHaveBeenCalledWith(7);
    expect(handler).not.toHaveBeenCalled();
  });

  it('invalidates capability readiness and clears cached denials after NOPERM', async () => {
    const redisClient = {
      eval: jest.fn()
        .mockResolvedValueOnce([0, 1, 1, 60_000, 1, 60_000, 2_000_000])
        .mockRejectedValue(new Error('NOPERM this user has no permissions to run EVAL')),
    } as unknown as RedisLifecycleClient;
    const execute = async <T>(
      operation: (client: RedisLifecycleClient) => Promise<T>
    ): Promise<T> => operation(redisClient);
    const onCapabilityFailure = jest.fn();
    const store = createRedisPublicProviderRateLimitStore({
      namespace: 'railway:project:environment:acl-service',
      execute,
      getRedisSnapshot: () => ({ state: 'READY', readyGeneration: 11 }),
      onCapabilityFailure,
    });

    const input = {
      clientMaximum: 1,
      globalMaximum: 2,
      windowMs: 60_000,
    };

    await expect(store.consume({
      ...input,
      clientIdentity: 'caller-a',
    })).resolves.toMatchObject({ allowed: false, limitedTier: 'client' });
    await expect(store.consume({
      ...input,
      clientIdentity: 'caller-b',
    })).rejects.toThrow('NOPERM');
    await expect(store.consume({
      ...input,
      clientIdentity: 'caller-a',
    })).rejects.toThrow('NOPERM');
    expect(redisClient.eval).toHaveBeenCalledTimes(3);
    expect(onCapabilityFailure).toHaveBeenCalledTimes(2);
    expect(onCapabilityFailure).toHaveBeenCalledWith(11);
  });

  it('fails fast while a same-generation capability circuit is open', async () => {
    let nowMs = 1_000_000;
    const capabilityGate = createPublicProviderRateLimitCapabilityGate();
    const redisClient = {
      eval: jest.fn()
        .mockRejectedValueOnce(new Error('NOPERM this user has no permissions to run EVAL'))
        .mockResolvedValueOnce([1, 0, 1, 60_000, 1, 60_000, 2_000_000]),
    } as unknown as RedisLifecycleClient;
    const execute = jest.fn(async <T>(
      operation: (client: RedisLifecycleClient) => Promise<T>
    ): Promise<T> => operation(redisClient));
    const onCapabilityFailure = jest.fn();
    const store = createRedisPublicProviderRateLimitStore({
      capabilityGate,
      namespace: 'railway:project:environment:capability-circuit-service',
      execute,
      getRedisSnapshot: () => ({ state: 'READY', readyGeneration: 21 }),
      now: () => nowMs,
      onCapabilityFailure,
      redisOperationStartMaximum: 1,
    });
    const input = {
      clientIdentity: 'caller-a',
      clientMaximum: 1,
      globalMaximum: 2,
      windowMs: 60_000,
    };

    await expect(store.consume(input)).rejects.toThrow('NOPERM');
    await expect(store.consume(input)).rejects.toBeInstanceOf(DependencyUnavailableError);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(redisClient.eval).toHaveBeenCalledTimes(1);
    expect(onCapabilityFailure).toHaveBeenCalledTimes(1);

    capabilityGate.markReadyGeneration(21);
    nowMs += 1000;
    await expect(store.consume(input)).resolves.toMatchObject({ allowed: true });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(redisClient.eval).toHaveBeenCalledTimes(2);
  });

  it('does not let an older in-flight denial repopulate a cleared cache', async () => {
    const failedOperation = createDeferred<unknown>();
    const staleDenial = createDeferred<unknown>();
    const redisClient = {
      eval: jest.fn()
        .mockImplementationOnce(() => failedOperation.promise)
        .mockImplementationOnce(() => staleDenial.promise)
        .mockRejectedValue(new Error('NOPERM this user has no permissions to run EVAL')),
    } as unknown as RedisLifecycleClient;
    const execute = async <T>(
      operation: (client: RedisLifecycleClient) => Promise<T>
    ): Promise<T> => operation(redisClient);
    const onCapabilityFailure = jest.fn();
    const store = createRedisPublicProviderRateLimitStore({
      namespace: 'railway:project:environment:overlap-service',
      execute,
      getRedisSnapshot: () => ({ state: 'READY', readyGeneration: 13 }),
      onCapabilityFailure,
    });
    const input = {
      clientMaximum: 1,
      globalMaximum: 2,
      windowMs: 60_000,
    };

    const failingConsume = store.consume({ ...input, clientIdentity: 'caller-a' });
    const staleConsume = store.consume({ ...input, clientIdentity: 'caller-b' });
    const failingExpectation = expect(failingConsume).rejects.toThrow('NOPERM');
    failedOperation.reject(new Error('NOPERM this user has no permissions to run EVAL'));
    await failingExpectation;

    staleDenial.resolve([0, 1, 1, 60_000, 1, 60_000, 2_000_000]);
    await expect(staleConsume).resolves.toMatchObject({
      allowed: false,
      limitedTier: 'client',
    });

    await expect(store.consume({ ...input, clientIdentity: 'caller-b' }))
      .rejects.toThrow('NOPERM');
    expect(redisClient.eval).toHaveBeenCalledTimes(3);
    expect(onCapabilityFailure).toHaveBeenCalledTimes(2);
  });

  it('does not invalidate capability readiness for a lifecycle-gate rejection', async () => {
    let redisState: Pick<RedisLifecycleSnapshot, 'state' | 'readyGeneration'> = {
      state: 'READY',
      readyGeneration: 12,
    };
    const execute = async <T>(
      _operation: (client: RedisLifecycleClient) => Promise<T>
    ): Promise<T> => {
      redisState = { state: 'DEGRADED', readyGeneration: 12 };
      throw new DependencyUnavailableError(
        'redis',
        'REDIS_DEPENDENCY_UNAVAILABLE',
        'Redis dependency is unavailable.'
      );
    };
    const onCapabilityFailure = jest.fn();
    const store = createRedisPublicProviderRateLimitStore({
      namespace: 'railway:project:environment:gate-service',
      execute,
      getRedisSnapshot: () => redisState,
      onCapabilityFailure,
    });

    await expect(store.consume({
      clientIdentity: 'caller-a',
      clientMaximum: 1,
      globalMaximum: 2,
      windowMs: 60_000,
    })).rejects.toBeInstanceOf(DependencyUnavailableError);
    expect(onCapabilityFailure).not.toHaveBeenCalled();
  });
});
