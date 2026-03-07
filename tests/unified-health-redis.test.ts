import { describe, expect, it, jest } from '@jest/globals';

type UnifiedHealthModule = typeof import('../src/platform/resilience/unifiedHealth.js');

interface UnifiedHealthRedisHarnessOptions {
  redisResolution?: {
    configured: boolean;
    source: 'REDIS_URL' | 'discrete' | 'none';
    url?: string;
  };
  redis?: {
    connectError?: Error;
    pingError?: Error;
    pingResponse?: string;
  };
}

interface UnifiedHealthRedisHarness {
  moduleUnderTest: UnifiedHealthModule;
  createClientMock: jest.Mock;
  redisConnectMock: jest.Mock;
  redisPingMock: jest.Mock;
  redisQuitMock: jest.Mock;
  redisDisconnectMock: jest.Mock;
}

/**
 * Load unified health helpers with isolated Redis mocks.
 *
 * Purpose:
 * - Keep Redis health probe tests deterministic without real network I/O.
 *
 * Inputs/outputs:
 * - Input: harness options for Redis configuration and client behavior.
 * - Output: imported module plus Redis mock spies.
 *
 * Edge case behavior:
 * - Defaults to a healthy `PONG` round trip when no Redis failures are requested.
 */
async function loadUnifiedHealthRedisHarness(
  options: UnifiedHealthRedisHarnessOptions = {}
): Promise<UnifiedHealthRedisHarness> {
  jest.resetModules();

  const redisConnectMock = jest.fn(async () => {
    if (options.redis?.connectError) {
      throw options.redis.connectError;
    }
  });
  const redisPingMock = jest.fn(async () => {
    if (options.redis?.pingError) {
      throw options.redis.pingError;
    }

    return options.redis?.pingResponse ?? 'PONG';
  });
  const redisQuitMock = jest.fn(async () => {});
  const redisDisconnectMock = jest.fn(async () => {});

  const createClientMock = jest.fn(() => ({
    on: jest.fn(),
    connect: redisConnectMock,
    ping: redisPingMock,
    quit: redisQuitMock,
    disconnect: redisDisconnectMock,
    isOpen: true
  }));

  jest.unstable_mockModule('redis', () => ({
    createClient: createClientMock
  }));
  jest.unstable_mockModule('@platform/runtime/redis.js', () => ({
    resolveConfiguredRedisConnection: jest.fn(() => (
      options.redisResolution ?? {
        configured: true,
        source: 'REDIS_URL',
        url: 'redis://localhost:6379'
      }
    ))
  }));
  jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
    aiLogger: {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn()
    }
  }));
  jest.unstable_mockModule('@platform/logging/telemetry.js', () => ({
    recordTraceEvent: jest.fn(() => 'trace-id')
  }));
  jest.unstable_mockModule('@arcanos/openai/unifiedClient', () => ({
    validateClientHealth: jest.fn(() => ({
      healthy: true,
      error: undefined,
      apiKeyConfigured: true,
      apiKeySource: 'env',
      defaultModel: 'test-model',
      circuitBreakerHealthy: true
    }))
  }));
  jest.unstable_mockModule('@core/adapters/openai.adapter.js', () => ({
    isOpenAIAdapterInitialized: jest.fn(() => true)
  }));
  jest.unstable_mockModule('@platform/runtime/unifiedConfig.js', () => ({
    getConfig: jest.fn(() => ({
      databaseUrl: undefined,
      nodeEnv: 'test',
      isRailway: false,
      railwayEnvironment: undefined
    }))
  }));
  jest.unstable_mockModule('@platform/resilience/healthChecks.js', () => ({
    assessCoreServiceReadiness: jest.fn(),
    mapReadinessToHealthStatus: jest.fn()
  }));
  jest.unstable_mockModule('@platform/resilience/serviceUnavailable.js', () => ({
    sendTimestampedStatus: jest.fn()
  }));

  const moduleUnderTest = await import('../src/platform/resilience/unifiedHealth.js');

  return {
    moduleUnderTest,
    createClientMock,
    redisConnectMock,
    redisPingMock,
    redisQuitMock,
    redisDisconnectMock
  };
}

describe('platform/resilience/unifiedHealth redis checks', () => {
  it('reports healthy and unconfigured when Redis is not configured', async () => {
    const harness = await loadUnifiedHealthRedisHarness({
      redisResolution: {
        configured: false,
        source: 'none'
      }
    });

    const result = await harness.moduleUnderTest.checkRedisHealth();

    expect(result).toEqual({
      healthy: true,
      name: 'redis',
      metadata: {
        configured: false,
        source: 'none',
        reason: 'Redis not configured (optional)'
      }
    });
    expect(harness.createClientMock).not.toHaveBeenCalled();
  });

  it('reports healthy when Redis connect and ping succeed', async () => {
    const harness = await loadUnifiedHealthRedisHarness({
      redisResolution: {
        configured: true,
        source: 'discrete',
        url: 'redis://redis.internal:6379'
      }
    });

    const result = await harness.moduleUnderTest.checkRedisHealth();

    expect(harness.createClientMock).toHaveBeenCalledWith(expect.objectContaining({
      url: 'redis://redis.internal:6379'
    }));
    expect(harness.redisConnectMock).toHaveBeenCalledTimes(1);
    expect(harness.redisPingMock).toHaveBeenCalledTimes(1);
    expect(harness.redisQuitMock).toHaveBeenCalledTimes(1);
    expect(result.healthy).toBe(true);
    expect(result.metadata).toEqual(expect.objectContaining({
      configured: true,
      connected: true,
      source: 'discrete'
    }));
  });

  it('reports unhealthy when Redis ping fails', async () => {
    const harness = await loadUnifiedHealthRedisHarness({
      redisResolution: {
        configured: true,
        source: 'REDIS_URL',
        url: 'redis://localhost:6379'
      },
      redis: {
        pingError: new Error('redis ping failed')
      }
    });

    const result = await harness.moduleUnderTest.checkRedisHealth();

    expect(result).toEqual({
      healthy: false,
      name: 'redis',
      error: 'redis ping failed',
      metadata: {
        configured: true,
        connected: false,
        source: 'REDIS_URL'
      }
    });
    expect(harness.redisQuitMock).toHaveBeenCalledTimes(1);
    expect(harness.redisDisconnectMock).not.toHaveBeenCalled();
  });
});
