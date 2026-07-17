import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const modelsListMock = jest.fn(() => Promise.resolve({ data: [] }));
const loggerInfoMock = jest.fn();
let apiKeyConfigured = true;

jest.unstable_mockModule('@platform/resilience/cache.js', () => ({
  responseCache: { getStats: jest.fn(() => ({})) }
}));
jest.unstable_mockModule('@core/adapters/openai.adapter.js', () => ({
  isOpenAIAdapterInitialized: jest.fn(() => true),
  resetOpenAIAdapter: jest.fn()
}));
jest.unstable_mockModule('@services/openai/resilience.js', () => ({
  RESILIENCE_CONSTANTS: { DEFAULT_MAX_TOKENS: 1000 },
  getCircuitBreakerSnapshot: jest.fn(() => ({}))
}));
jest.unstable_mockModule('@arcanos/openai/unifiedClient', () => ({
  getApiTimeoutMs: jest.fn(() => 4000),
  validateClientHealth: jest.fn(() => ({
    apiKeyConfigured,
    apiKeySource: apiKeyConfigured ? 'OPENAI_API_KEY' : null,
    healthy: apiKeyConfigured,
    defaultModel: 'test-model',
    circuitBreakerHealthy: true,
    cacheEnabled: false,
    lastCheck: '2026-07-17T00:00:00.000Z'
  }))
}));
jest.unstable_mockModule('@services/openai/credentialProvider.js', () => ({
  getOpenAIKeySource: jest.fn(() => 'OPENAI_API_KEY'),
  resolveOpenAIBaseURL: jest.fn(() => 'http://127.0.0.1:9/v1')
}));
jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: jest.fn(() => ({
    client: { models: { list: modelsListMock } }
  }))
}));
jest.unstable_mockModule('@platform/runtime/unifiedConfig.js', () => ({
  getConfig: jest.fn(() => ({
    openaiApiKey: 'configured-test-key',
    defaultModel: 'test-model'
  }))
}));
jest.unstable_mockModule('@platform/runtime/env.js', () => ({
  getEnv: jest.fn((name: string) => process.env[name]),
  getEnvNumber: jest.fn((_name: string, fallback: number) => fallback)
}));
jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
  logger: {
    info: loggerInfoMock,
    warn: jest.fn(),
    error: jest.fn()
  },
  aiLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }
}));

const { validateAPIKeyAtStartup } = await import('../src/services/openai/serviceHealth.js');

describe('OpenAI startup probe isolation', () => {
  const originalForceMock = process.env.FORCE_MOCK;

  beforeEach(() => {
    modelsListMock.mockClear();
    loggerInfoMock.mockClear();
    apiKeyConfigured = true;
    delete process.env.FORCE_MOCK;
  });

  afterAll(() => {
    if (originalForceMock === undefined) {
      delete process.env.FORCE_MOCK;
    } else {
      process.env.FORCE_MOCK = originalForceMock;
    }
  });

  it('does not start a provider request in explicit FORCE_MOCK mode', () => {
    process.env.FORCE_MOCK = 'true';

    expect(validateAPIKeyAtStartup()).toBe(true);
    expect(modelsListMock).not.toHaveBeenCalled();
    expect(loggerInfoMock).toHaveBeenCalledWith('openai.provider.startup_probe_skipped', {
      module: 'openai.service_health',
      reason: 'force_mock'
    });
  });

  it.each([undefined, 'false', 'TRUE'])('preserves the configured-provider startup probe when FORCE_MOCK is %s', forceMock => {
    if (forceMock === undefined) {
      delete process.env.FORCE_MOCK;
    } else {
      process.env.FORCE_MOCK = forceMock;
    }

    expect(validateAPIKeyAtStartup()).toBe(true);
    expect(modelsListMock).toHaveBeenCalledTimes(1);
  });

  it('does not probe when the API key is unavailable', () => {
    apiKeyConfigured = false;

    expect(validateAPIKeyAtStartup()).toBe(false);
    expect(modelsListMock).not.toHaveBeenCalled();
  });
});
