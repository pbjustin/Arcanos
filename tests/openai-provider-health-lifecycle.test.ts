import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { APIConnectionError, APIConnectionTimeoutError } from 'openai/error';

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
    try {
      await jest.advanceTimersByTimeAsync(500);
    } finally {
      release();
      await probe;
    }

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
    const reloadB = reinitializeOpenAIProvider({ ignoreBackoff: true, source: 'configuration_B' });
    const stateBeforeCompletion = getOpenAIProviderRuntimeStatus();
    try {
      expect(modelsListMock).toHaveBeenCalledTimes(2);
    } finally {
      release();
      await Promise.all([pendingA, reloadB]);
    }

    await expect(pendingA).resolves.toEqual({
      ok: false, skipped: true, reason: 'provider_configuration_changed', runtime: stateBeforeCompletion
    });
    expect(loggerWarnMock).toHaveBeenCalledWith('openai.provider.probe_superseded', {
      module: 'openai.service_health', source: 'configuration_A', outcome: 'succeeded',
      reason: 'provider_configuration_changed'
    });
    await expect(reloadB).resolves.toMatchObject({ ok: true, skipped: false });
    expect(modelsListMock).toHaveBeenCalledTimes(3);
    expect(loggerInfoMock).toHaveBeenCalledWith('openai.provider.healthy', expect.objectContaining({ source: 'configuration_B' }));
  });

  it('does not apply an old endpoint authentication failure to the reloaded provider', async () => {
    let fail!: () => void;
    modelsListMock.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      fail = () => reject(Object.assign(new Error('Unauthorized'), { status: 401 }));
    }));
    const pendingA = probeOpenAIProviderHealth({ force: true, source: 'configuration_A' });
    configuredBaseUrl = 'https://replacement-provider.invalid/v1';
    const reloadB = reinitializeOpenAIProvider({ ignoreBackoff: true, source: 'configuration_B' });
    const stateBeforeCompletion = getOpenAIProviderRuntimeStatus();
    try {
      expect(modelsListMock).toHaveBeenCalledTimes(1);
    } finally {
      fail();
      await Promise.all([pendingA, reloadB]);
    }

    await expect(pendingA).resolves.toEqual({
      ok: false, skipped: true, reason: 'provider_configuration_changed', runtime: stateBeforeCompletion
    });
    expect(getOpenAIServiceHealth().providerRuntime.authenticationBlocked).toBe(false);
    expect(loggerWarnMock).toHaveBeenCalledWith('openai.provider.probe_superseded', {
      module: 'openai.service_health', source: 'configuration_A', outcome: 'failed',
      reason: 'provider_configuration_changed', category: 'authentication', status: 401
    });
    await expect(reloadB).resolves.toMatchObject({ ok: true, skipped: false });
    expect(modelsListMock).toHaveBeenCalledTimes(2);
  });

  it('accepts the pending probe after an unchanged forced reload despite source metadata changing', async () => {
    credentialSource = null;
    let release!: () => void;
    modelsListMock.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ data: [] });
    }));
    const pending = probeOpenAIProviderHealth({ force: true });
    try {
      const initialVersion = getOpenAIProviderRuntimeStatus().configVersion;
      credentialSource = 'test';
      const reload = await reinitializeOpenAIProvider({ forceReload: true, ignoreBackoff: true });
      expect(reload.runtime.configVersion).not.toBe(initialVersion);
      expect(reload.reason).toBe('provider_probe_in_flight');
    } finally {
      release();
      await pending;
    }

    await expect(pending).resolves.toMatchObject({ ok: true, skipped: false });
    expect(modelsListMock).toHaveBeenCalledTimes(1);
  });

  it('starts only one replacement transport for concurrent reinitializations', async () => {
    let release!: () => void;
    modelsListMock.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ data: [] });
    }));
    const pendingA = probeOpenAIProviderHealth({ force: true });
    configuredApiKey = 'test-provider-replacement-key';
    const firstReload = reinitializeOpenAIProvider({ ignoreBackoff: true });
    const secondReload = reinitializeOpenAIProvider({ ignoreBackoff: true });
    try {
      expect(modelsListMock).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await Promise.all([pendingA, firstReload, secondReload]);
    }
    await expect(firstReload).resolves.toMatchObject({ ok: true, skipped: false });
    await expect(secondReload).resolves.toMatchObject({
      ok: false, skipped: true, reason: 'provider_probe_in_flight'
    });
    expect(modelsListMock).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(modelsListMock).toHaveBeenCalledTimes(2);
  });

  it('does not probe a requested replacement that changes again while waiting', async () => {
    let release!: () => void;
    modelsListMock.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ data: [] });
    }));
    const pendingA = probeOpenAIProviderHealth({ force: true });
    configuredApiKey = 'test-provider-replacement-key';
    const reloadB = reinitializeOpenAIProvider({ ignoreBackoff: true });
    configuredBaseUrl = 'https://third-provider.invalid/v1';
    try {
      expect(modelsListMock).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await Promise.all([pendingA, reloadB]);
    }
    await expect(reloadB).resolves.toMatchObject({
      ok: false, skipped: true, reason: 'provider_configuration_changed'
    });
    expect(modelsListMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 500, reason: 'provider_backoff_active', suppressUnchangedAuthenticationProbe: false },
    { status: 401, reason: 'provider_authentication_unchanged', suppressUnchangedAuthenticationProbe: true }
  ])('preserves $reason before the replacement probe', async ({ status, reason, suppressUnchangedAuthenticationProbe }) => {
    modelsListMock.mockRejectedValueOnce(Object.assign(new Error('Provider unavailable'), { status }));
    await probeOpenAIProviderHealth({ force: true });
    const failed = getOpenAIProviderRuntimeStatus();
    const originalApiKey = configuredApiKey;
    configuredApiKey = 'test-provider-intermediate-key';
    let release!: () => void;
    modelsListMock.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ data: [] });
    }));
    const pendingA = probeOpenAIProviderHealth({ force: true });
    configuredApiKey = originalApiKey;
    const reload = reinitializeOpenAIProvider({ suppressUnchangedAuthenticationProbe });
    try {
      expect(modelsListMock).toHaveBeenCalledTimes(2);
    } finally {
      release();
      await Promise.all([pendingA, reload]);
    }
    await expect(reload).resolves.toMatchObject({
      ok: false, skipped: true, reason,
      runtime: { nextRetryAt: failed.nextRetryAt, consecutiveFailures: failed.consecutiveFailures }
    });
    expect(modelsListMock).toHaveBeenCalledTimes(2);
  });

  it('records failure at completion while retaining the attempt start', async () => {
    let fail!: () => void;
    modelsListMock.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      fail = () => reject(new Error('network unavailable'));
    }));
    const probe = probeOpenAIProviderHealth({ force: true });
    try {
      await jest.advanceTimersByTimeAsync(500);
    } finally {
      fail();
      await probe;
    }

    await expect(probe).resolves.toMatchObject({ runtime: {
      lastAttemptAt: '2026-10-31T12:00:00.000Z',
      lastFailureAt: '2026-10-31T12:00:00.500Z',
      lastFailureCategory: 'network'
    } });
  });

  it('aborts one timed-out transport, observes backoff, then recovers without a retry loop', async () => {
    let signal: AbortSignal | undefined;
    let rejectTransport!: (error: Error) => void;
    modelsListMock.mockImplementationOnce((options: unknown) => {
      signal = (options as { signal: AbortSignal }).signal;
      return new Promise((_resolve, reject) => {
        rejectTransport = reject;
        signal?.addEventListener('abort', () => reject(signal?.reason), { once: true });
      });
    });
    const probe = probeOpenAIProviderHealth({ force: true, source: 'startup' });
    try {
      await jest.advanceTimersByTimeAsync(4000);
    } finally {
      rejectTransport(new Error('Fixture transport settled'));
      await probe;
    }
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

  it.each([
    { error: new APIConnectionError({ message: 'Opaque transport failure' }), category: 'network', status: null },
    { error: new APIConnectionTimeoutError({ message: 'Opaque transport failure' }), category: 'timeout', status: null },
    { error: Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' }), category: 'unknown', status: null },
    { error: Object.assign(new APIConnectionError({ message: 'Opaque transport failure' }), { status: 401 }), category: 'authentication', status: 401 }
  ])('classifies actual SDK errors without trusting a spoofed error name: $category / $status', async ({ error, category, status }) => {
    modelsListMock.mockRejectedValueOnce(error);
    await expect(probeOpenAIProviderHealth({ force: true })).resolves.toMatchObject({
      ok: false, runtime: { lastFailureCategory: category, lastFailureStatus: status }
    });
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
