import { describe, expect, it, jest } from '@jest/globals';

type KillSwitchModule = typeof import('../src/services/incidentResponse/killSwitch.js');

interface KillSwitchHarnessOptions {
  config?: {
    selfImproveFrozen: boolean;
    selfImproveAutonomyLevel: number;
  };
  env?: Record<string, string | undefined>;
  redis?: {
    ready?: boolean;
    configured?: boolean;
    getValue?: string | null;
    getError?: Error;
    setError?: Error;
  };
}

interface KillSwitchHarness {
  moduleUnderTest: KillSwitchModule;
  createClientMock: jest.Mock;
  redisConnectMock: jest.Mock;
  redisGetMock: jest.Mock;
  redisSetMock: jest.Mock;
  loggerWarnMock: jest.Mock;
  loggerErrorMock: jest.Mock;
  setRedisReady: (ready: boolean) => void;
}

/**
 * Create an isolated kill-switch module instance with dependency mocks.
 *
 * Purpose: keep per-test state deterministic for module-level caches and overrides.
 * Inputs/outputs: harness options -> imported module plus dependency spies.
 * Edge cases: defaults to local-only mode when redis env vars are missing.
 */
async function loadKillSwitchHarness(options: KillSwitchHarnessOptions = {}): Promise<KillSwitchHarness> {
  jest.resetModules();

  const envMap = options.env ?? {};
  const getEnvMock = jest.fn((key: string, defaultValue?: string) => {
    if (Object.prototype.hasOwnProperty.call(envMap, key)) {
      return envMap[key];
    }
    return defaultValue;
  });

  const getConfigMock = jest.fn(() => ({
    selfImproveFrozen: options.config?.selfImproveFrozen ?? false,
    selfImproveAutonomyLevel: options.config?.selfImproveAutonomyLevel ?? 1
  }));

  const loggerWarnMock = jest.fn();
  const loggerErrorMock = jest.fn();

  let redisReady = options.redis?.ready ?? options.redis !== undefined;
  const redisConfigured = options.redis?.configured ?? options.redis !== undefined;
  const redisConnectMock = jest.fn(async () => undefined);
  const redisGetMock = jest.fn(async () => {
    if (options.redis?.getError) {
      throw options.redis.getError;
    }
    return options.redis?.getValue ?? null;
  });
  const redisSetMock = jest.fn(async () => {
    if (options.redis?.setError) {
      throw options.redis.setError;
    }
  });
  const createClientMock = jest.fn(() => ({
    connect: redisConnectMock,
    get: redisGetMock,
    set: redisSetMock
  }));
  const sharedRedisClient = {
    get: redisGetMock,
    set: redisSetMock
  };

  jest.unstable_mockModule('redis', () => ({
    createClient: createClientMock
  }));
  jest.unstable_mockModule('@platform/runtime/redisLifecycle.js', () => ({
    executeRedisOperation: jest.fn(async (
      operation: (client: typeof sharedRedisClient) => Promise<unknown>,
      operationOptions?: { client?: typeof sharedRedisClient }
    ) => {
      const operationClient = operationOptions?.client ?? (redisReady ? sharedRedisClient : null);
      if (!operationClient) {
        throw Object.assign(new Error('Redis dependency is unavailable.'), {
          code: 'REDIS_DEPENDENCY_UNAVAILABLE'
        });
      }
      return operation(operationClient);
    }),
    getReadyRedisClient: jest.fn(() => redisReady ? sharedRedisClient : null),
    getRedisLifecycleSnapshot: jest.fn(() => ({
      state: redisReady ? 'READY' : redisConfigured ? 'DEGRADED' : 'READY',
      configured: redisConfigured,
      connected: redisReady,
      attempt: redisConfigured ? 1 : 0,
      recoveryCount: 0,
      retryScheduled: redisConfigured && !redisReady,
      lastTransitionAt: '2026-07-22T00:00:00.000Z',
      lastReadyAt: redisReady ? '2026-07-22T00:00:00.000Z' : null,
      lastErrorCode: redisConfigured && !redisReady ? 'REDIS_CONNECTION_REFUSED' : null
    }))
  }));
  jest.unstable_mockModule('@platform/runtime/env.js', () => ({
    getEnv: getEnvMock
  }));
  jest.unstable_mockModule('@platform/runtime/unifiedConfig.js', () => ({
    getConfig: getConfigMock
  }));
  jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
    aiLogger: {
      warn: loggerWarnMock,
      error: loggerErrorMock
    }
  }));

  const moduleUnderTest = await import('../src/services/incidentResponse/killSwitch.js');

  return {
    moduleUnderTest,
    createClientMock,
    redisConnectMock,
    redisGetMock,
    redisSetMock,
    loggerWarnMock,
    loggerErrorMock,
    setRedisReady: (ready: boolean) => {
      redisReady = ready;
    }
  };
}

describe('incidentResponse/killSwitch', () => {
  it('uses local overrides when redis is unavailable and clamps autonomy', async () => {
    const harness = await loadKillSwitchHarness({
      config: { selfImproveFrozen: false, selfImproveAutonomyLevel: 2 }
    });

    expect(await harness.moduleUnderTest.isSelfImproveFrozen()).toBe(false);

    await harness.moduleUnderTest.setAutonomyLevel(99, 'manual-throttle');
    expect(await harness.moduleUnderTest.getEffectiveAutonomyLevel()).toBe(3);

    await harness.moduleUnderTest.freezeSelfImprove('incident');
    const frozenStatus = await harness.moduleUnderTest.getKillSwitchStatus();
    expect(frozenStatus.frozen).toBe(true);
    expect(frozenStatus.autonomyLevel).toBe(0);
    expect(frozenStatus.overrides).toEqual({ freeze: true, autonomy: 0 });

    await harness.moduleUnderTest.unfreezeSelfImprove('clear');
    const unfrozenStatus = await harness.moduleUnderTest.getKillSwitchStatus();
    expect(unfrozenStatus.frozen).toBe(false);
    expect(unfrozenStatus.autonomyLevel).toBe(0);

    expect(harness.createClientMock).not.toHaveBeenCalled();
  });

  it('coerces non-finite autonomy values to zero', async () => {
    const harness = await loadKillSwitchHarness({
      config: { selfImproveFrozen: false, selfImproveAutonomyLevel: 2 }
    });

    await harness.moduleUnderTest.setAutonomyLevel(Number.NaN, 'non-finite input');

    expect(await harness.moduleUnderTest.getEffectiveAutonomyLevel()).toBe(0);
  });

  it('reads shared redis state and clamps out-of-range autonomy values', async () => {
    const harness = await loadKillSwitchHarness({
      config: { selfImproveFrozen: false, selfImproveAutonomyLevel: 1 },
      env: { REDIS_URL: 'redis://localhost:6379' },
      redis: { getValue: JSON.stringify({ freeze: true, autonomy: 12 }) }
    });

    const status = await harness.moduleUnderTest.getKillSwitchStatus();

    expect(harness.createClientMock).not.toHaveBeenCalled();
    expect(harness.redisConnectMock).not.toHaveBeenCalled();
    expect(harness.redisGetMock).toHaveBeenCalledWith('arcanos:self-improve:kill-switch:v1');
    expect(status).toEqual({
      frozen: true,
      autonomyLevel: 3,
      overrides: {
        freeze: true,
        autonomy: 3
      }
    });
  });

  it('falls back immediately while unavailable and uses the shared client after lifecycle recovery', async () => {
    const harness = await loadKillSwitchHarness({
      config: { selfImproveFrozen: false, selfImproveAutonomyLevel: 1 },
      redis: {
        ready: false,
        configured: true,
        getValue: JSON.stringify({ freeze: true, autonomy: 3 })
      }
    });

    await expect(harness.moduleUnderTest.getKillSwitchStatus()).resolves.toEqual({
      frozen: false,
      autonomyLevel: 1,
      overrides: {
        freeze: null,
        autonomy: null
      }
    });
    expect(harness.redisGetMock).not.toHaveBeenCalled();
    expect(harness.createClientMock).not.toHaveBeenCalled();
    expect(harness.redisConnectMock).not.toHaveBeenCalled();

    harness.setRedisReady(true);

    await expect(harness.moduleUnderTest.getKillSwitchStatus()).resolves.toEqual({
      frozen: true,
      autonomyLevel: 3,
      overrides: {
        freeze: true,
        autonomy: 3
      }
    });
    expect(harness.redisGetMock).toHaveBeenCalledTimes(1);
    expect(harness.createClientMock).not.toHaveBeenCalled();
    expect(harness.redisConnectMock).not.toHaveBeenCalled();
  });

  it('reconciles a local emergency freeze before accepting stale shared state after recovery', async () => {
    const harness = await loadKillSwitchHarness({
      config: { selfImproveFrozen: false, selfImproveAutonomyLevel: 2 },
      redis: {
        ready: false,
        configured: true,
        getValue: JSON.stringify({ freeze: false, autonomy: 3 })
      }
    });

    await harness.moduleUnderTest.freezeSelfImprove('redis-outage');
    expect(harness.redisSetMock).not.toHaveBeenCalled();

    harness.setRedisReady(true);

    await expect(harness.moduleUnderTest.getKillSwitchStatus()).resolves.toEqual({
      frozen: true,
      autonomyLevel: 0,
      overrides: {
        freeze: true,
        autonomy: 0
      }
    });
    expect(harness.redisSetMock).toHaveBeenCalledTimes(1);
    expect(harness.redisSetMock).toHaveBeenCalledWith(
      'arcanos:self-improve:kill-switch:v1',
      JSON.stringify({ freeze: true, autonomy: 0 })
    );
    expect(harness.redisGetMock).not.toHaveBeenCalled();
    expect(harness.createClientMock).not.toHaveBeenCalled();
    expect(harness.redisConnectMock).not.toHaveBeenCalled();
  });

  it('falls back safely when shared redis payload is malformed', async () => {
    const harness = await loadKillSwitchHarness({
      config: { selfImproveFrozen: false, selfImproveAutonomyLevel: 2 },
      env: {
        REDIS_URL: 'not-a-valid-url',
        REDISHOST: 'localhost',
        REDISPORT: '6379'
      },
      redis: { getValue: '{this-is-not-json' }
    });

    expect(await harness.moduleUnderTest.isSelfImproveFrozen()).toBe(false);
    expect(await harness.moduleUnderTest.getEffectiveAutonomyLevel()).toBe(2);
    expect(harness.loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining('Failed to read shared kill-switch state'),
      {
        module: 'killSwitch',
        errorCode: 'REDIS_DEPENDENCY_UNAVAILABLE'
      }
    );
  });

  it('normalizes invalid shared override field types to null', async () => {
    const harness = await loadKillSwitchHarness({
      config: { selfImproveFrozen: true, selfImproveAutonomyLevel: 2 },
      env: { REDIS_URL: 'redis://localhost:6379' },
      redis: { getValue: JSON.stringify({ freeze: 'true', autonomy: '3' }) }
    });

    const status = await harness.moduleUnderTest.getKillSwitchStatus();

    expect(status.overrides).toEqual({ freeze: null, autonomy: null });
    expect(status.frozen).toBe(true);
    expect(status.autonomyLevel).toBe(2);
  });

  it('retains local freeze state when redis write fails', async () => {
    const harness = await loadKillSwitchHarness({
      config: { selfImproveFrozen: false, selfImproveAutonomyLevel: 2 },
      env: { REDIS_URL: 'redis://localhost:6379' },
      redis: { setError: new Error('redis write failed') }
    });

    await harness.moduleUnderTest.freezeSelfImprove('operator-trigger');
    const status = await harness.moduleUnderTest.getKillSwitchStatus();

    expect(status.frozen).toBe(true);
    expect(status.autonomyLevel).toBe(0);
    expect(harness.redisSetMock).toHaveBeenCalled();
    expect(harness.loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining('Failed to persist kill-switch state to Redis'),
      {
        module: 'killSwitch',
        errorCode: 'REDIS_DEPENDENCY_UNAVAILABLE'
      }
    );
    expect(harness.loggerErrorMock).toHaveBeenCalledWith(
      'Self-improve frozen (kill switch)',
      expect.objectContaining({ module: 'killSwitch', reason: 'operator-trigger' })
    );
  });

  it('logs configured Redis unavailability once with stable non-sensitive metadata', async () => {
    const harness = await loadKillSwitchHarness({
      config: { selfImproveFrozen: false, selfImproveAutonomyLevel: 1 },
      redis: {
        ready: false,
        configured: true
      }
    });

    await harness.moduleUnderTest.getKillSwitchStatus();
    await harness.moduleUnderTest.getKillSwitchStatus();

    const redisUnavailableLogs = harness.loggerWarnMock.mock.calls.filter(
      ([message]) => String(message).includes('Kill switch Redis unavailable')
    );

    expect(redisUnavailableLogs).toEqual([[
      'Kill switch Redis unavailable; using local fallback',
      {
        module: 'killSwitch',
        errorCode: 'REDIS_DEPENDENCY_UNAVAILABLE'
      }
    ]]);
    expect(JSON.stringify(redisUnavailableLogs)).not.toContain('redis://');
    expect(harness.createClientMock).not.toHaveBeenCalled();
    expect(harness.redisConnectMock).not.toHaveBeenCalled();
  });
});
