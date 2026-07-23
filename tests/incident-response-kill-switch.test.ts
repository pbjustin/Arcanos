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
    evalError?: Error;
    evalImplementation?: () => Promise<void>;
  };
}

interface KillSwitchHarness {
  moduleUnderTest: KillSwitchModule;
  createClientMock: jest.Mock;
  redisConnectMock: jest.Mock;
  redisGetMock: jest.Mock;
  redisEvalMock: jest.Mock;
  loggerWarnMock: jest.Mock;
  loggerErrorMock: jest.Mock;
  setRedisReady: (ready: boolean) => void;
  setSharedValue: (value: string | null) => void;
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
  let sharedValue = options.redis?.getValue ?? null;
  const redisConnectMock = jest.fn(async () => undefined);
  const redisGetMock = jest.fn(async () => {
    if (options.redis?.getError) {
      throw options.redis.getError;
    }
    return sharedValue;
  });
  const redisEvalMock = jest.fn(async (
    _script: string,
    command: { arguments: string[] }
  ) => {
    if (options.redis?.evalError) {
      throw options.redis.evalError;
    }
    await options.redis?.evalImplementation?.();
    const [mode, autonomyValue, freezeValue, expectedFreeze, expectedAutonomy] =
      command.arguments;
    const parsed = sharedValue
      ? JSON.parse(sharedValue) as { freeze?: unknown; autonomy?: unknown }
      : {};
    const state = {
      freeze: typeof parsed.freeze === 'boolean' ? parsed.freeze : null,
      autonomy: typeof parsed.autonomy === 'number'
        ? Math.max(0, Math.min(3, Math.trunc(parsed.autonomy)))
        : null
    };
    const freezeToken = state.freeze === null ? 'null' : String(state.freeze);
    const autonomyToken = state.autonomy === null ? 'null' : String(state.autonomy);
    if (
      expectedFreeze !== '*'
      && (freezeToken !== expectedFreeze || autonomyToken !== expectedAutonomy)
    ) {
      return '__ARCANOS_KILL_SWITCH_CONFLICT__';
    }
    if (mode === 'restrictive') {
      if (freezeValue === '1') {
        state.freeze = true;
      }
      if (autonomyValue !== '') {
        const requested = Number(autonomyValue);
        state.autonomy = state.autonomy === null
          ? requested
          : Math.min(state.autonomy, requested);
      }
    } else if (mode === 'unfreeze') {
      state.freeze = false;
    } else if (mode === 'autonomy_relax') {
      state.autonomy = Number(autonomyValue);
    }
    sharedValue = JSON.stringify(state);
    return sharedValue;
  });
  const createClientMock = jest.fn(() => ({
    connect: redisConnectMock,
    get: redisGetMock,
    eval: redisEvalMock
  }));
  const sharedRedisClient = {
    get: redisGetMock,
    eval: redisEvalMock
  };

  jest.unstable_mockModule('redis', () => ({
    createClient: createClientMock
  }));
  jest.unstable_mockModule('@platform/runtime/redisLifecycle.js', () => ({
    executeRedisOperation: jest.fn(async (
      operation: (client: typeof sharedRedisClient) => Promise<unknown>,
      _operationOptions?: Record<string, unknown>
    ) => {
      const operationClient = redisReady ? sharedRedisClient : null;
      if (!operationClient) {
        throw Object.assign(new Error('Redis dependency is unavailable.'), {
          code: 'REDIS_DEPENDENCY_UNAVAILABLE'
        });
      }
      return operation(operationClient);
    }),
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
    redisEvalMock,
    loggerWarnMock,
    loggerErrorMock,
    setRedisReady: (ready: boolean) => {
      redisReady = ready;
    },
    setSharedValue: (value: string | null) => {
      sharedValue = value;
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

  it('fails closed immediately while unavailable and uses shared state after lifecycle recovery', async () => {
    const harness = await loadKillSwitchHarness({
      config: { selfImproveFrozen: false, selfImproveAutonomyLevel: 1 },
      redis: {
        ready: false,
        configured: true,
        getValue: JSON.stringify({ freeze: true, autonomy: 3 })
      }
    });

    await expect(harness.moduleUnderTest.getKillSwitchStatus()).resolves.toEqual({
      frozen: true,
      autonomyLevel: 0,
      overrides: {
        freeze: true,
        autonomy: 0
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
    expect(harness.redisEvalMock).not.toHaveBeenCalled();

    harness.setRedisReady(true);

    await expect(harness.moduleUnderTest.getKillSwitchStatus()).resolves.toEqual({
      frozen: true,
      autonomyLevel: 0,
      overrides: {
        freeze: true,
        autonomy: 0
      }
    });
    expect(harness.redisEvalMock).toHaveBeenCalledTimes(1);
    expect(harness.redisEvalMock.mock.calls[0]?.[1]).toEqual({
      keys: ['arcanos:self-improve:kill-switch:v1'],
      arguments: ['restrictive', '0', '1', '*', '*']
    });
    expect(harness.redisGetMock).not.toHaveBeenCalled();
    expect(harness.createClientMock).not.toHaveBeenCalled();
    expect(harness.redisConnectMock).not.toHaveBeenCalled();
  });

  it('fails closed when shared redis payload is malformed', async () => {
    const harness = await loadKillSwitchHarness({
      config: { selfImproveFrozen: false, selfImproveAutonomyLevel: 2 },
      env: {
        REDIS_URL: 'not-a-valid-url',
        REDISHOST: 'localhost',
        REDISPORT: '6379'
      },
      redis: { getValue: '{this-is-not-json' }
    });

    expect(await harness.moduleUnderTest.isSelfImproveFrozen()).toBe(true);
    expect(await harness.moduleUnderTest.getEffectiveAutonomyLevel()).toBe(0);
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

  it('preserves the authoritative shared autonomy restriction when unfreezing', async () => {
    const harness = await loadKillSwitchHarness({
      config: { selfImproveFrozen: false, selfImproveAutonomyLevel: 3 },
      redis: {
        getValue: JSON.stringify({ freeze: true, autonomy: 0 })
      }
    });

    await harness.moduleUnderTest.unfreezeSelfImprove('reviewed-release');

    expect(harness.redisEvalMock.mock.calls[0]?.[1]).toEqual({
      keys: ['arcanos:self-improve:kill-switch:v1'],
      arguments: ['unfreeze', '', '0', 'true', '0']
    });
    await expect(harness.moduleUnderTest.getKillSwitchStatus()).resolves.toEqual({
      frozen: false,
      autonomyLevel: 0,
      overrides: {
        freeze: false,
        autonomy: 0
      }
    });
  });

  it('bypasses stale local observations before a relaxing mutation', async () => {
    const harness = await loadKillSwitchHarness({
      config: { selfImproveFrozen: false, selfImproveAutonomyLevel: 3 },
      redis: {
        getValue: JSON.stringify({ freeze: false, autonomy: 3 })
      }
    });

    await harness.moduleUnderTest.getKillSwitchStatus();
    harness.setSharedValue(JSON.stringify({ freeze: true, autonomy: 0 }));
    await harness.moduleUnderTest.unfreezeSelfImprove('authoritative-refresh');

    expect(harness.redisGetMock).toHaveBeenCalledTimes(2);
    expect(harness.redisEvalMock.mock.calls[0]?.[1].arguments).toEqual([
      'unfreeze',
      '',
      '0',
      'true',
      '0'
    ]);
    await expect(harness.moduleUnderTest.getEffectiveAutonomyLevel()).resolves.toBe(0);
  });

  it('rejects relaxation when another replica changes state after the read', async () => {
    let releaseMutation!: () => void;
    let observeMutation!: () => void;
    const mutationStarted = new Promise<void>((resolve) => {
      observeMutation = resolve;
    });
    const mutationBlocked = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const harness = await loadKillSwitchHarness({
      config: { selfImproveFrozen: false, selfImproveAutonomyLevel: 3 },
      redis: {
        getValue: JSON.stringify({ freeze: false, autonomy: 3 }),
        evalImplementation: async () => {
          observeMutation();
          await mutationBlocked;
        }
      }
    });

    const relaxation = harness.moduleUnderTest.unfreezeSelfImprove('cross-replica-race');
    await mutationStarted;
    harness.setSharedValue(JSON.stringify({ freeze: true, autonomy: 0 }));
    releaseMutation();

    await expect(relaxation).rejects.toMatchObject({
      dependency: 'redis',
      code: 'REDIS_DEPENDENCY_UNAVAILABLE'
    });
    await expect(harness.moduleUnderTest.getKillSwitchStatus()).resolves.toEqual({
      frozen: true,
      autonomyLevel: 0,
      overrides: {
        freeze: true,
        autonomy: 0
      }
    });
  });

  it('serializes concurrent relaxation and restriction with restriction winning', async () => {
    let releaseFirstWrite!: () => void;
    let observeFirstWrite!: () => void;
    let writeCount = 0;
    const firstWriteStarted = new Promise<void>((resolve) => {
      observeFirstWrite = resolve;
    });
    const firstWriteBlocked = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const harness = await loadKillSwitchHarness({
      config: { selfImproveFrozen: false, selfImproveAutonomyLevel: 3 },
      redis: {
        getValue: JSON.stringify({ freeze: true, autonomy: 0 }),
        evalImplementation: async () => {
          writeCount += 1;
          if (writeCount === 1) {
            observeFirstWrite();
            await firstWriteBlocked;
          }
        }
      }
    });

    const relaxation = harness.moduleUnderTest.unfreezeSelfImprove('concurrent-relax');
    await firstWriteStarted;
    const restriction = harness.moduleUnderTest.freezeSelfImprove('concurrent-freeze');
    releaseFirstWrite();
    await Promise.all([relaxation, restriction]);

    expect(
      harness.redisEvalMock.mock.calls.map((call) => call[1].arguments)
    ).toEqual([
      ['unfreeze', '', '0', 'true', '0'],
      ['restrictive', '0', '1', '*', '*']
    ]);
    await expect(harness.moduleUnderTest.getKillSwitchStatus()).resolves.toEqual({
      frozen: true,
      autonomyLevel: 0,
      overrides: {
        freeze: true,
        autonomy: 0
      }
    });
  });

  it('retains local freeze state when redis write fails', async () => {
    const harness = await loadKillSwitchHarness({
      config: { selfImproveFrozen: false, selfImproveAutonomyLevel: 2 },
      env: { REDIS_URL: 'redis://localhost:6379' },
      redis: { evalError: new Error('redis write failed') }
    });

    await harness.moduleUnderTest.freezeSelfImprove('operator-trigger');
    const status = await harness.moduleUnderTest.getKillSwitchStatus();

    expect(status.frozen).toBe(true);
    expect(status.autonomyLevel).toBe(0);
    expect(harness.redisEvalMock).toHaveBeenCalled();
    expect(harness.loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining('Failed to persist restrictive kill-switch state'),
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
      'Kill switch Redis unavailable; enforcing restrictive fallback',
      {
        module: 'killSwitch',
        errorCode: 'REDIS_DEPENDENCY_UNAVAILABLE'
      }
    ]]);
    expect(JSON.stringify(redisUnavailableLogs)).not.toContain('redis://');
    expect(harness.createClientMock).not.toHaveBeenCalled();
    expect(harness.redisConnectMock).not.toHaveBeenCalled();
  });

  it('rejects relaxation and autonomy increases without changing restrictive local state', async () => {
    const harness = await loadKillSwitchHarness({
      config: { selfImproveFrozen: false, selfImproveAutonomyLevel: 2 },
      redis: {
        ready: false,
        configured: true
      }
    });

    await harness.moduleUnderTest.freezeSelfImprove('outage');
    await expect(
      harness.moduleUnderTest.unfreezeSelfImprove('unsafe-relaxation')
    ).rejects.toMatchObject({
      code: 'REDIS_DEPENDENCY_UNAVAILABLE'
    });
    await expect(
      harness.moduleUnderTest.setAutonomyLevel(2, 'unsafe-increase')
    ).rejects.toMatchObject({
      code: 'REDIS_DEPENDENCY_UNAVAILABLE'
    });

    await expect(harness.moduleUnderTest.getKillSwitchStatus()).resolves.toEqual({
      frozen: true,
      autonomyLevel: 0,
      overrides: {
        freeze: true,
        autonomy: 0
      }
    });
    expect(harness.redisEvalMock).not.toHaveBeenCalled();
  });
});
