import { describe, expect, it, jest } from '@jest/globals';

type KillSwitchModule = typeof import('../src/services/incidentResponse/killSwitch.js');

interface KillSwitchHarnessOptions {
  config?: {
    selfImproveFrozen: boolean;
    selfImproveAutonomyLevel: number;
  };
  env?: Record<string, string | undefined>;
  redis?: {
    connectError?: Error;
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
  triggerRedisError: (error: unknown) => void;
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

  let redisErrorHandler: ((error: unknown) => void) | null = null;
  const redisConnectMock = jest.fn(async () => {
    if (options.redis?.connectError) {
      throw options.redis.connectError;
    }
  });
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
  const redisOnMock = jest.fn((event: string, handler: (error: unknown) => void) => {
    if (event === 'error') {
      redisErrorHandler = handler;
    }
  });

  const createClientMock = jest.fn(() => ({
    on: redisOnMock,
    connect: redisConnectMock,
    get: redisGetMock,
    set: redisSetMock
  }));

  jest.unstable_mockModule('redis', () => ({
    createClient: createClientMock
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
    triggerRedisError: (error: unknown) => {
      if (redisErrorHandler) {
        redisErrorHandler(error);
      }
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

    expect(harness.createClientMock).toHaveBeenCalledTimes(1);
    expect(harness.redisConnectMock).toHaveBeenCalledTimes(1);
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

  it('builds redis urls from user/pass, pass-only, and default-port fallbacks', async () => {
    const userPassHarness = await loadKillSwitchHarness({
      env: {
        REDISHOST: 'redis.internal',
        REDISPORT: '6380',
        REDISUSER: 'svc',
        REDISPASSWORD: 'pwd'
      },
      redis: { getValue: null }
    });
    await userPassHarness.moduleUnderTest.getKillSwitchStatus();
    expect((userPassHarness.createClientMock.mock.calls[0]?.[0] as { url?: string })?.url)
      .toBe('redis://svc:pwd@redis.internal:6380');

    const passOnlyHarness = await loadKillSwitchHarness({
      env: {
        REDIS_HOST: 'redis.internal',
        REDIS_PORT: '6390',
        REDIS_PASSWORD: 'secret'
      },
      redis: { getValue: null }
    });
    await passOnlyHarness.moduleUnderTest.getKillSwitchStatus();
    expect((passOnlyHarness.createClientMock.mock.calls[0]?.[0] as { url?: string })?.url)
      .toBe('redis://:secret@redis.internal:6390');

    const defaultPortHarness = await loadKillSwitchHarness({
      env: {
        REDIS_HOST: 'redis.internal'
      },
      redis: { getValue: null }
    });
    await defaultPortHarness.moduleUnderTest.getKillSwitchStatus();
    expect((defaultPortHarness.createClientMock.mock.calls[0]?.[0] as { url?: string })?.url)
      .toBe('redis://redis.internal:6379');
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
      expect.objectContaining({ module: 'killSwitch' })
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
      expect.objectContaining({ module: 'killSwitch' })
    );
    expect(harness.loggerErrorMock).toHaveBeenCalledWith(
      'Self-improve frozen (kill switch)',
      expect.objectContaining({ module: 'killSwitch', reason: 'operator-trigger' })
    );
  });

  it('logs redis runtime errors once to avoid log spam', async () => {
    const harness = await loadKillSwitchHarness({
      config: { selfImproveFrozen: false, selfImproveAutonomyLevel: 1 },
      env: { REDIS_URL: 'redis://localhost:6379' },
      redis: { getValue: null }
    });

    await harness.moduleUnderTest.getKillSwitchStatus();
    harness.triggerRedisError(new Error('socket closed'));
    harness.triggerRedisError(new Error('socket closed again'));

    const redisErrorLogs = harness.loggerWarnMock.mock.calls.filter(
      ([message]) => String(message).includes('Kill switch Redis client error')
    );

    expect(redisErrorLogs).toHaveLength(1);
  });

  it('handles redis connect failure and exercises reconnect strategy clamp', async () => {
    const harness = await loadKillSwitchHarness({
      config: { selfImproveFrozen: false, selfImproveAutonomyLevel: 1 },
      env: { REDIS_URL: 'redis://localhost:6379' },
      redis: { connectError: new Error('connect failed') }
    });

    const status = await harness.moduleUnderTest.getKillSwitchStatus();
    expect(status.frozen).toBe(false);
    expect(status.autonomyLevel).toBe(1);

    const createClientOptions = harness.createClientMock.mock.calls[0]?.[0] as
      | { socket?: { reconnectStrategy?: (retries: number) => number } }
      | undefined;

    expect(createClientOptions?.socket?.reconnectStrategy?.(30)).toBe(2000);
    expect(harness.loggerWarnMock).toHaveBeenCalledWith(
      'Kill switch Redis unavailable; using local fallback',
      expect.objectContaining({ module: 'killSwitch' })
    );
  });
});
