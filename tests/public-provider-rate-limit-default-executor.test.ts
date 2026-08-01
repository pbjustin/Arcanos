import { beforeEach, describe, expect, it, jest } from '@jest/globals';

describe('public provider Redis default executor wiring', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('routes configured consume and capability probes through the lifecycle gate', async () => {
    const evalMock = jest.fn(async (
      _script: string,
      options: { keys: string[] }
    ) => options.keys[0]?.includes(':capability:')
      ? [1, 1, 999, 1, 2_000_000]
      : [1, 0, 1, 60_000, 1, 60_000, 2_000_000]);
    const executeRedisOperationMock = jest.fn(async (
      operation: (client: { eval: typeof evalMock }) => Promise<unknown>
    ) => operation({ eval: evalMock }));
    jest.unstable_mockModule('@platform/runtime/redisLifecycle.js', () => ({
      executeRedisOperation: executeRedisOperationMock,
      getRedisLifecycleSnapshot: () => ({ state: 'READY', readyGeneration: 1 }),
    }));

    const {
      createConfiguredPublicProviderRateLimitStore,
      probeRedisPublicProviderRateLimitCapability,
    } = await import('../src/platform/runtime/publicProviderRateLimitStore.js');
    const namespace = 'railway:project:environment:service';
    const store = createConfiguredPublicProviderRateLimitStore({
      mode: 'redis',
      namespace,
    });

    await expect(store.consume({
      clientIdentity: 'caller-a',
      clientMaximum: 2,
      globalMaximum: 3,
      windowMs: 60_000,
    })).resolves.toMatchObject({ allowed: true });
    await expect(probeRedisPublicProviderRateLimitCapability(namespace, {
      probeId: 'default-executor-probe',
    })).resolves.toBeUndefined();

    expect(executeRedisOperationMock).toHaveBeenCalledTimes(2);
    expect(executeRedisOperationMock.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ operation: 'public_provider.rate_limit.consume' }),
      { operation: 'public_provider.rate_limit.probe' },
    ]);
  });

  it('opens the configured request-path circuit after same-generation NOPERM', async () => {
    const evalMock = jest.fn(async () => {
      throw new Error('NOPERM this user has no permissions to run EVAL');
    });
    const executeRedisOperationMock = jest.fn(async (
      operation: (client: { eval: typeof evalMock }) => Promise<unknown>
    ) => operation({ eval: evalMock }));
    jest.unstable_mockModule('@platform/runtime/redisLifecycle.js', () => ({
      executeRedisOperation: executeRedisOperationMock,
      getRedisLifecycleSnapshot: () => ({ state: 'READY', readyGeneration: 1 }),
    }));

    const {
      createConfiguredPublicProviderRateLimitStore,
    } = await import('../src/platform/runtime/publicProviderRateLimitStore.js');
    const store = createConfiguredPublicProviderRateLimitStore({
      mode: 'redis',
      namespace: 'railway:project:environment:service',
    });
    const input = {
      clientIdentity: 'caller-a',
      clientMaximum: 1,
      globalMaximum: 2,
      windowMs: 60_000,
    };

    await expect(store.consume(input)).rejects.toThrow('NOPERM');
    await expect(store.consume(input)).rejects.toMatchObject({
      code: 'REDIS_DEPENDENCY_UNAVAILABLE',
    });
    expect(executeRedisOperationMock).toHaveBeenCalledTimes(1);
    expect(evalMock).toHaveBeenCalledTimes(1);
  });
});
