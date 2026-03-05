import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const aiLoggerMock = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
};
const recordTraceEventMock = jest.fn();

jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
  aiLogger: aiLoggerMock
}));

jest.unstable_mockModule('@platform/logging/telemetry.js', () => ({
  recordTraceEvent: recordTraceEventMock
}));

const unifiedConfig = await import('../src/platform/runtime/unifiedConfig.js');

const ENV_KEYS_TO_RESTORE = [
  'SELF_IMPROVE_ENV',
  'SELF_IMPROVE_ACTUATOR_MODE',
  'OPENAI_API_KEY',
  'NODE_ENV',
  'DATABASE_URL'
] as const;

const originalEnvValues = new Map<string, string | undefined>();

describe('platform/runtime/unifiedConfig self-improve parsing', () => {
  beforeEach(() => {
    aiLoggerMock.info.mockReset();
    aiLoggerMock.warn.mockReset();
    aiLoggerMock.error.mockReset();
    recordTraceEventMock.mockReset();

    for (const envKey of ENV_KEYS_TO_RESTORE) {
      originalEnvValues.set(envKey, process.env[envKey]);
      delete process.env[envKey];
    }
  });

  afterEach(() => {
    for (const envKey of ENV_KEYS_TO_RESTORE) {
      const original = originalEnvValues.get(envKey);
      if (original === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = original;
      }
    }
  });

  it('defaults invalid self-improve env and actuator mode values', () => {
    process.env.SELF_IMPROVE_ENV = 'INVALID_ENVIRONMENT';
    process.env.SELF_IMPROVE_ACTUATOR_MODE = 'UNKNOWN_MODE';

    const config = unifiedConfig.getConfig();

    expect(config.selfImproveEnvironment).toBe('development');
    expect(config.selfImproveActuatorMode).toBe('pr_bot');
  });

  it('reports validation warnings for invalid self-improve overrides', () => {
    process.env.SELF_IMPROVE_ENV = 'INVALID_ENVIRONMENT';
    process.env.SELF_IMPROVE_ACTUATOR_MODE = 'UNKNOWN_MODE';

    const validation = unifiedConfig.validateConfig();

    expect(validation.valid).toBe(true);
    expect(validation.warnings).toContain('SELF_IMPROVE_ENV invalid - defaulted to development');
    expect(validation.warnings).toContain('SELF_IMPROVE_ACTUATOR_MODE invalid - defaulted to pr_bot');
  });
});
