import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { createClient } from 'redis';

import { DependencyUnavailableError } from '../../src/platform/runtime/dependencyLifecycle.js';
import {
  createRedisPublicProviderRateLimitStore,
  type PublicProviderRateLimitStore,
} from '../../src/platform/runtime/publicProviderRateLimitStore.js';
import type {
  RedisLifecycleClient,
  RedisOperationOptions,
} from '../../src/platform/runtime/redisLifecycle.js';

const TEST_REDIS_URL_ENV_NAME = 'PUBLIC_PROVIDER_TEST_REDIS_URL';
const TEST_REDIS_CONFIRMATION_ENV_NAME =
  'PUBLIC_PROVIDER_TEST_REDIS_CONFIRM_DISPOSABLE';
const TEST_REDIS_CONFIRMATION = 'disposable-loopback-only';
const TEST_DATABASE_PATH = '/14';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', '::1']);

type TestRedisClient = ReturnType<typeof createClient>;
type RedisExecute = <T>(
  operation: (client: RedisLifecycleClient) => Promise<T>,
  options: RedisOperationOptions
) => Promise<T>;

function resolveDisposableLoopbackRedisUrl(
  environment: NodeJS.ProcessEnv
): string | null {
  const rawUrl = environment[TEST_REDIS_URL_ENV_NAME];
  const confirmation = environment[TEST_REDIS_CONFIRMATION_ENV_NAME];
  if (rawUrl === undefined && confirmation === undefined) {
    return null;
  }

  if (confirmation !== TEST_REDIS_CONFIRMATION) {
    throw new Error('Disposable loopback Redis confirmation is required');
  }
  if (
    typeof rawUrl !== 'string'
    || rawUrl !== rawUrl.trim()
    || rawUrl.length === 0
  ) {
    throw new Error('Disposable loopback Redis URL is required');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new Error('Disposable loopback Redis URL failed validation');
  }
  if (
    parsedUrl.protocol !== 'redis:'
    || !LOOPBACK_HOSTS.has(parsedUrl.hostname)
    || parsedUrl.port.length === 0
    || parsedUrl.pathname !== TEST_DATABASE_PATH
    || parsedUrl.search.length > 0
    || parsedUrl.hash.length > 0
    || parsedUrl.username.length > 0
    || parsedUrl.password.length > 0
  ) {
    throw new Error('Disposable Redis tests require explicit loopback database 14');
  }

  return rawUrl;
}

describe('public provider disposable Redis target guard', () => {
  const validUrl = 'redis://127.0.0.1:6379/14';
  const validEnvironment = {
    [TEST_REDIS_URL_ENV_NAME]: validUrl,
    [TEST_REDIS_CONFIRMATION_ENV_NAME]: TEST_REDIS_CONFIRMATION,
  };

  it('stays disabled only when both integration variables are absent', () => {
    expect(resolveDisposableLoopbackRedisUrl({})).toBeNull();
    expect(resolveDisposableLoopbackRedisUrl(validEnvironment)).toBe(validUrl);
  });

  it.each([
    ['missing URL', { [TEST_REDIS_CONFIRMATION_ENV_NAME]: TEST_REDIS_CONFIRMATION }],
    ['missing confirmation', { [TEST_REDIS_URL_ENV_NAME]: validUrl }],
    ['mismatched confirmation', {
      ...validEnvironment,
      [TEST_REDIS_CONFIRMATION_ENV_NAME]: 'not-disposable',
    }],
    ['remote host', {
      ...validEnvironment,
      [TEST_REDIS_URL_ENV_NAME]: 'redis://redis.example.com:6379/14',
    }],
    ['wrong database', {
      ...validEnvironment,
      [TEST_REDIS_URL_ENV_NAME]: 'redis://127.0.0.1:6379/15',
    }],
    ['credentials', {
      ...validEnvironment,
      [TEST_REDIS_URL_ENV_NAME]: 'redis://user:secret@127.0.0.1:6379/14',
    }],
    ['query', {
      ...validEnvironment,
      [TEST_REDIS_URL_ENV_NAME]: 'redis://127.0.0.1:6379/14?unsafe=true',
    }],
    ['fragment', {
      ...validEnvironment,
      [TEST_REDIS_URL_ENV_NAME]: 'redis://127.0.0.1:6379/14#unsafe',
    }],
    ['surrounding whitespace', {
      ...validEnvironment,
      [TEST_REDIS_URL_ENV_NAME]: ` ${validUrl}`,
    }],
  ])('rejects %s', (_caseName, environment) => {
    expect(() => resolveDisposableLoopbackRedisUrl(environment)).toThrow();
  });
});

const redisUrl = resolveDisposableLoopbackRedisUrl(process.env);
const describeRedisIntegration = redisUrl ? describe : describe.skip;
const redisClients: TestRedisClient[] = [];
const trackedKeys = new Set<string>();

function requireRedisClient(index: number): TestRedisClient {
  const client = redisClients[index];
  if (!client) {
    throw new Error(`Redis integration client ${index} is unavailable`);
  }
  return client;
}

function createExecutor(client: TestRedisClient): RedisExecute {
  return async <T>(
    operation: (readyClient: RedisLifecycleClient) => Promise<T>,
    options: RedisOperationOptions
  ): Promise<T> => {
    expect(options.operation).toBe('public_provider.rate_limit.consume');
    return operation(client);
  };
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function trackRateLimitKeys(
  namespace: string,
  clientIdentity: string
): readonly [string, string] {
  const namespaceDigest = digest(namespace).slice(0, 32);
  const keyPrefix = `arcanos:public-provider:v1:{${namespaceDigest}}`;
  const keys = [
    `${keyPrefix}:client:${digest(clientIdentity)}`,
    `${keyPrefix}:global`,
  ] as const;
  for (const key of keys) {
    trackedKeys.add(key);
  }
  return keys;
}

function createTrackedStore(
  namespace: string,
  client: TestRedisClient
): PublicProviderRateLimitStore {
  const store = createRedisPublicProviderRateLimitStore({
    namespace,
    execute: createExecutor(client),
  });
  return {
    async consume(input) {
      trackRateLimitKeys(namespace, input.clientIdentity);
      return store.consume(input);
    },
  };
}

async function closeRedisClient(client: TestRedisClient): Promise<void> {
  if (!client.isOpen) {
    return;
  }
  try {
    await client.close();
  } catch (error) {
    if (client.isOpen) {
      client.destroy();
    }
    throw error;
  }
}

describeRedisIntegration('public provider limiter against disposable Redis 7', () => {
  beforeAll(async () => {
    if (!redisUrl) {
      throw new Error('Redis integration URL was not configured');
    }

    redisClients.push(
      createClient({
        url: redisUrl,
        socket: { connectTimeout: 2000, reconnectStrategy: false },
      }),
      createClient({
        url: redisUrl,
        socket: { connectTimeout: 2000, reconnectStrategy: false },
      })
    );
    for (const client of redisClients) {
      client.on('error', () => {});
    }
    await Promise.all(redisClients.map(async (client) => {
      await client.connect();
      expect(await client.ping()).toBe('PONG');
    }));
  }, 10_000);

  afterAll(async () => {
    let cleanupFailure: unknown;
    try {
      const cleanupClient = redisClients[0];
      if (cleanupClient?.isReady && trackedKeys.size > 0) {
        await cleanupClient.del([...trackedKeys]);
      }
    } catch (error) {
      cleanupFailure = error;
    }
    const closeResults = await Promise.allSettled(redisClients.map(closeRedisClient));
    const closeFailure = closeResults.find((result) => result.status === 'rejected');
    if (cleanupFailure) {
      throw cleanupFailure;
    }
    if (closeFailure?.status === 'rejected') {
      throw closeFailure.reason;
    }
  }, 10_000);

  it('shares restart state, isolates namespaces, and preserves global capacity on client denial', async () => {
    const sharedNamespace = `redis-integration:${randomUUID()}`;
    const firstReplica = createTrackedStore(sharedNamespace, requireRedisClient(0));
    const restartedReplica = createTrackedStore(sharedNamespace, requireRedisClient(1));
    const otherNamespace = createTrackedStore(
      `redis-integration:${randomUUID()}`,
      requireRedisClient(0)
    );
    const input = {
      clientMaximum: 3,
      globalMaximum: 5,
      windowMs: 5000,
    };

    for (let index = 0; index < 3; index += 1) {
      await expect(firstReplica.consume({ ...input, clientIdentity: 'caller-a' }))
        .resolves.toMatchObject({ allowed: true });
    }
    await expect(restartedReplica.consume({ ...input, clientIdentity: 'caller-a' }))
      .resolves.toMatchObject({
        allowed: false,
        limitedTier: 'client',
        global: { remaining: 2 },
      });
    await expect(restartedReplica.consume({ ...input, clientIdentity: 'caller-b' }))
      .resolves.toMatchObject({ allowed: true, global: { remaining: 1 } });
    await expect(restartedReplica.consume({ ...input, clientIdentity: 'caller-c' }))
      .resolves.toMatchObject({ allowed: true, global: { remaining: 0 } });
    await expect(restartedReplica.consume({ ...input, clientIdentity: 'caller-d' }))
      .resolves.toMatchObject({ allowed: false, limitedTier: 'global' });
    await expect(otherNamespace.consume({ ...input, clientIdentity: 'caller-a' }))
      .resolves.toMatchObject({ allowed: true, global: { remaining: 4 } });
  });

  it('atomically admits only the configured global maximum under concurrency', async () => {
    const namespace = `redis-integration:${randomUUID()}`;
    const replicas = [
      createTrackedStore(namespace, requireRedisClient(0)),
      createTrackedStore(namespace, requireRedisClient(1)),
    ] as const;
    const input = {
      clientMaximum: 1,
      globalMaximum: 5,
      windowMs: 5000,
    };

    const decisions = await Promise.all(
      Array.from({ length: 20 }, (_, index) => (
        index % 2 === 0 ? replicas[0] : replicas[1]
      ).consume({
          ...input,
          clientIdentity: `concurrent-caller-${index}`,
        }))
    );

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(5);
    const denied = decisions.filter((decision) => !decision.allowed);
    expect(denied).toHaveLength(15);
    expect(denied.every((decision) => decision.limitedTier === 'global')).toBe(true);
  });

  it('uses Redis expiry so a restarted store opens the next window', async () => {
    const namespace = `redis-integration:${randomUUID()}`;
    const firstReplica = createTrackedStore(namespace, requireRedisClient(0));
    const input = {
      clientIdentity: 'expiring-caller',
      clientMaximum: 1,
      globalMaximum: 1,
      windowMs: 1000,
    };

    await expect(firstReplica.consume(input)).resolves.toMatchObject({ allowed: true });
    await expect(firstReplica.consume(input)).resolves.toMatchObject({
      allowed: false,
      limitedTier: 'global',
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const restartedReplica = createTrackedStore(namespace, requireRedisClient(1));
    await expect(restartedReplica.consume(input)).resolves.toMatchObject({ allowed: true });
  });

  it('rejects corrupt non-expiring counters without mutating the global counter', async () => {
    const client = requireRedisClient(0);
    const namespace = `redis-integration:${randomUUID()}`;
    const store = createTrackedStore(namespace, client);
    const input = {
      clientIdentity: 'corrupt-caller',
      clientMaximum: 2,
      globalMaximum: 3,
      windowMs: 5000,
    };

    await expect(store.consume(input)).resolves.toMatchObject({ allowed: true });
    const [clientKey, globalKey] = trackRateLimitKeys(namespace, input.clientIdentity);
    await client.set(clientKey, 'corrupt');

    await expect(store.consume(input)).rejects.toBeInstanceOf(DependencyUnavailableError);
    expect(await client.get(clientKey)).toBe('corrupt');
    expect(await client.pTTL(clientKey)).toBe(-1);
    expect(await client.get(globalKey)).toBe('1');
  });
});
