import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const modelsListMock = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const loggerErrorMock = jest.fn();
const loggerInfoMock = jest.fn();
const loggerWarnMock = jest.fn();
let configuredApiKey = 'test-provider-health-key';
let configuredBaseUrl = 'https://provider.invalid/v1';
let credentialSource: string | null = 'test';

jest.unstable_mockModule('@platform/resilience/cache.js', () => ({
  responseCache: { getStats: () => ({}) }
}));
jest.unstable_mockModule('@core/adapters/openai.adapter.js', () => ({
  instrumentOpenAIOperation: async ({ callback }: { callback: () => Promise<unknown> }) => callback(),
  isOpenAIAdapterInitialized: () => true,
  rethrowWorkerAiBudgetError: () => {},
  resetOpenAIAdapter: () => {}
}));
jest.unstable_mockModule('@services/openai/resilience.js', () => ({
  RESILIENCE_CONSTANTS: { DEFAULT_MAX_TOKENS: 1000 },
  getCircuitBreakerSnapshot: () => ({ state: 'closed' })
}));
jest.unstable_mockModule('@arcanos/openai/unifiedClient', () => ({
  getApiTimeoutMs: () => 4000,
  getUnifiedClient: jest.fn(),
  isUnifiedClientConfigured: () => false,
  validateClientHealth: () => ({
    apiKeyConfigured: true, apiKeySource: 'test', healthy: true,
    defaultModel: 'test-model', circuitBreakerHealthy: true,
    cacheEnabled: false, lastCheck: null
  })
}));
jest.unstable_mockModule('@services/openai/credentialProvider.js', () => ({
  getOpenAIKeySource: () => credentialSource,
  resetCredentialCache: () => {},
  resolveOpenAIBaseURL: () => configuredBaseUrl
}));
jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: () => ({ client: { models: { list: modelsListMock } } })
}));
jest.unstable_mockModule('@platform/runtime/unifiedConfig.js', () => ({
  getConfig: () => ({ openaiApiKey: configuredApiKey, defaultModel: 'test-model' })
}));
jest.unstable_mockModule('@platform/runtime/env.js', () => ({
  getEnv: (name: string) => process.env[name],
  getEnvNumber: (_name: string, fallback: number) => fallback
}));
jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
  logger: { info: loggerInfoMock, warn: loggerWarnMock, error: loggerErrorMock },
  aiLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.unstable_mockModule('@services/openai/aiExecutionContext.js', () => ({
  getAiExecutionContext: () => undefined
}));

const {
  getOpenAIServiceHealth, getOpenAIProviderRuntimeStatus, probeOpenAIProviderHealth,
  reinitializeOpenAIProvider, validateAPIKeyAtStartup
} = await import('../src/services/openai/serviceHealth.js');

describe('OpenAI provider health lifecycle', () => {
  beforeEach(async () => {
    jest.useFakeTimers({ now: new Date('2026-10-31T12:00:00.000Z') });
    configuredApiKey = 'test-provider-health-key';
    configuredBaseUrl = 'https://provider.invalid/v1';
    credentialSource = 'test';
    modelsListMock.mockReset().mockResolvedValue({ data: [] });
    await probeOpenAIProviderHealth({ force: true, source: 'fixture_reset' });
    modelsListMock.mockClear();
    loggerErrorMock.mockClear();
    loggerInfoMock.mockClear();
    loggerWarnMock.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not issue overlapping forced probes', async () => {
    const releases: Array<() => void> = [];
    modelsListMock.mockImplementation(() => new Promise(resolve => {
      releases.push(() => resolve({ data: [] }));
    }));
    const first = probeOpenAIProviderHealth({ force: true, source: 'startup' });
    const second = probeOpenAIProviderHealth({ force: true, source: 'runtime_recovery' });

    try {
      expect(modelsListMock).toHaveBeenCalledTimes(1);
    } finally {
      releases.forEach(release => release());
      await Promise.all([first, second]);
    }
    await expect(second).resolves.toMatchObject({
      ok: false, skipped: true, reason: 'provider_probe_in_flight'
    });
    await expect(first).resolves.toMatchObject({ ok: true, skipped: false });
  });

  it('records success at completion while retaining the attempt start', async () => {
    let release!: () => void;
    modelsListMock.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ data: [] });
    }));
    const probe = probeOpenAIProviderHealth({ force: true });
    await jest.advanceTimersByTimeAsync(500);
    release();

    await expect(probe).resolves.toMatchObject({ runtime: {
      lastAttemptAt: '2026-10-31T12:00:00.000Z',
      lastSuccessAt: '2026-10-31T12:00:00.500Z'
    } });
  });

  it('does not clear failure state for new credentials when an old probe succeeds', async () => {
    modelsListMock.mockRejectedValueOnce(Object.assign(new Error('Unauthorized'), { status: 401 }));
    await probeOpenAIProviderHealth({ force: true });
    let release!: () => void;
    modelsListMock.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ data: [] });
    }));
    const pendingA = probeOpenAIProviderHealth({ force: true, source: 'configuration_A' });
    configuredApiKey = 'test-provider-replacement-key';
    const reloadedB = await reinitializeOpenAIProvider({ ignoreBackoff: true, source: 'configuration_B' });
    expect(reloadedB.reason).toBe('provider_probe_in_flight');
    const stateBeforeCompletion = getOpenAIProviderRuntimeStatus();
    release();

    await expect(pendingA).resolves.toEqual({
      ok: false, skipped: true, reason: 'provider_configuration_changed', runtime: stateBeforeCompletion
    });
    expect(getOpenAIProviderRuntimeStatus()).toEqual(stateBeforeCompletion);
    expect(loggerInfoMock).not.toHaveBeenCalledWith('openai.provider.healthy', expect.anything());
    expect(loggerWarnMock).toHaveBeenCalledWith('openai.provider.probe_superseded', {
      module: 'openai.service_health', source: 'configuration_A', outcome: 'succeeded',
      reason: 'provider_configuration_changed'
    });
    expect(modelsListMock).toHaveBeenCalledTimes(2);
    modelsListMock.mockResolvedValueOnce({ data: [] });
    await expect(probeOpenAIProviderHealth({ force: true, source: 'configuration_B' })).resolves.toMatchObject({ ok: true });
    expect(modelsListMock).toHaveBeenCalledTimes(3);
  });

  it('does not apply an old endpoint authentication failure to the reloaded provider', async () => {
    let fail!: () => void;
    modelsListMock.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      fail = () => reject(Object.assign(new Error('Unauthorized'), { status: 401 }));
    }));
    const pendingA = probeOpenAIProviderHealth({ force: true, source: 'configuration_A' });
    configuredBaseUrl = 'https://replacement-provider.invalid/v1';
    const reloadedB = await reinitializeOpenAIProvider({ ignoreBackoff: true, source: 'configuration_B' });
    expect(reloadedB.reason).toBe('provider_probe_in_flight');
    const stateBeforeCompletion = getOpenAIProviderRuntimeStatus();
    fail();

    await expect(pendingA).resolves.toEqual({
      ok: false, skipped: true, reason: 'provider_configuration_changed', runtime: stateBeforeCompletion
    });
    expect(getOpenAIProviderRuntimeStatus()).toEqual(stateBeforeCompletion);
    expect(getOpenAIServiceHealth().providerRuntime.authenticationBlocked).toBe(false);
    expect(loggerWarnMock).toHaveBeenCalledWith('openai.provider.probe_superseded', {
      module: 'openai.service_health', source: 'configuration_A', outcome: 'failed',
      reason: 'provider_configuration_changed', category: 'authentication', status: 401
    });
    expect(modelsListMock).toHaveBeenCalledTimes(1);
  });

  it('accepts the pending probe after an unchanged forced reload despite source metadata changing', async () => {
    credentialSource = null;
    let release!: () => void;
    modelsListMock.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ data: [] });
    }));
    const pending = probeOpenAIProviderHealth({ force: true });
    const initialVersion = getOpenAIProviderRuntimeStatus().configVersion;
    credentialSource = 'test';
    const reload = await reinitializeOpenAIProvider({ forceReload: true, ignoreBackoff: true });
    expect(reload.runtime.configVersion).not.toBe(initialVersion);
    expect(reload.reason).toBe('provider_probe_in_flight');
    release();

    await expect(pending).resolves.toMatchObject({ ok: true, skipped: false });
    expect(modelsListMock).toHaveBeenCalledTimes(1);
  });

  it('records failure at completion while retaining the attempt start', async () => {
    let fail!: () => void;
    modelsListMock.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      fail = () => reject(new Error('network unavailable'));
    }));
    const probe = probeOpenAIProviderHealth({ force: true });
    await jest.advanceTimersByTimeAsync(500);
    fail();

    await expect(probe).resolves.toMatchObject({ runtime: {
      lastAttemptAt: '2026-10-31T12:00:00.000Z',
      lastFailureAt: '2026-10-31T12:00:00.500Z',
      lastFailureCategory: 'network'
    } });
  });

  it('aborts one timed-out transport, observes backoff, then recovers without a retry loop', async () => {
    let signal: AbortSignal | undefined;
    modelsListMock.mockImplementationOnce((options: unknown) => {
      signal = (options as { signal: AbortSignal }).signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal?.reason), { once: true });
      });
    });
    const probe = probeOpenAIProviderHealth({ force: true, source: 'startup' });
    await jest.advanceTimersByTimeAsync(4000);
    const failed = await probe;

    expect(failed).toMatchObject({ ok: false, runtime: {
      lastFailureCategory: 'timeout', consecutiveFailures: 1, backoffMs: 1000,
      lastFailureAt: '2026-10-31T12:00:04.000Z'
    } });
    expect(signal?.aborted).toBe(true);
    expect(modelsListMock).toHaveBeenCalledTimes(1);
    expect(modelsListMock).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 0 }));
    await expect(probeOpenAIProviderHealth()).resolves.toMatchObject({
      skipped: true, reason: 'provider_backoff_active'
    });
    await jest.advanceTimersByTimeAsync(1000);
    expect(modelsListMock).toHaveBeenCalledTimes(1);
    modelsListMock.mockResolvedValueOnce({ data: [] });
    const recovered = await probeOpenAIProviderHealth({ source: 'scheduled_recovery' });
    expect(recovered).toMatchObject({ ok: true, runtime: {
      lastFailureAt: failed.runtime.lastFailureAt,
      lastSuccessAt: '2026-10-31T12:00:05.000Z',
      lastFailureCategory: null, consecutiveFailures: 0, backoffMs: 0, nextRetryAt: null
    } });
    expect(modelsListMock).toHaveBeenCalledTimes(2);
    expect(loggerErrorMock).toHaveBeenCalledWith('openai.provider.failure', expect.objectContaining({ category: 'timeout' }));
  });

  it('retains authentication identity separately from transient connectivity', async () => {
    modelsListMock.mockRejectedValueOnce(Object.assign(new Error('Unauthorized'), { status: 401 }));
    const failed = await probeOpenAIProviderHealth({ force: true });

    expect(failed).toMatchObject({ ok: false, runtime: {
      lastFailureCategory: 'authentication', lastFailureStatus: 401
    } });
    expect(getOpenAIServiceHealth().providerRuntime.authenticationBlocked).toBe(true);
    expect(loggerErrorMock).toHaveBeenCalledWith('openai.provider.failure', expect.objectContaining({
      category: 'authentication', status: 401
    }));
  });

  it('keeps health reads provider-free throughout healthy idle polling', () => {
    for (let poll = 0; poll < 1000; poll += 1) {
      expect(getOpenAIServiceHealth().providerRuntime.consecutiveFailures).toBe(0);
    }
    expect(modelsListMock).not.toHaveBeenCalled();
  });

  it('returns from startup validation before the bounded provider probe settles', async () => {
    const originalForceMock = process.env.FORCE_MOCK;
    delete process.env.FORCE_MOCK;
    let release!: () => void;
    modelsListMock.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ data: [] });
    }));
    try {
      expect(validateAPIKeyAtStartup()).toBe(true);
      expect(modelsListMock).toHaveBeenCalledTimes(1);
      expect(loggerInfoMock).not.toHaveBeenCalledWith('openai.provider.healthy', expect.anything());
    } finally {
      release();
      // Drain the fire-and-forget startup probe before the next test.
      await jest.advanceTimersByTimeAsync(0);
      if (originalForceMock === undefined) delete process.env.FORCE_MOCK;
      else process.env.FORCE_MOCK = originalForceMock;
    }
    expect(loggerInfoMock).toHaveBeenCalledWith('openai.provider.healthy', expect.objectContaining({ source: 'startup' }));
  });
});
