import { describe, expect, it, jest } from '@jest/globals';

/**
 * Load unifiedConfig with env access mocked to return undefined for self-improve keys.
 *
 * Purpose: exercise nullish fallback branches in parse helpers used by getConfig().
 * Inputs/outputs: none -> imported unifiedConfig module with deterministic env behavior.
 * Edge cases: retains default return contracts for number/boolean getters.
 */
async function loadUnifiedConfigWithNullishSelfImproveEnv() {
  jest.resetModules();

  jest.unstable_mockModule('@platform/runtime/env.js', () => ({
    getEnv: (key: string, defaultValue?: string) => {
      if (key === 'SELF_IMPROVE_ENV' || key === 'SELF_IMPROVE_ACTUATOR_MODE') {
        return undefined;
      }
      return defaultValue;
    },
    getEnvNumber: (_key: string, defaultValue: number) => defaultValue,
    getEnvBoolean: (_key: string, defaultValue: boolean) => defaultValue
  }));

  jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
    aiLogger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    }
  }));

  jest.unstable_mockModule('@platform/logging/telemetry.js', () => ({
    recordTraceEvent: jest.fn()
  }));

  return await import('../src/platform/runtime/unifiedConfig.js');
}

describe('platform/runtime/unifiedConfig nullish parsing branches', () => {
  it('falls back to defaults when self-improve env getters resolve undefined', async () => {
    const unifiedConfig = await loadUnifiedConfigWithNullishSelfImproveEnv();

    const config = unifiedConfig.getConfig();

    expect(config.selfImproveEnvironment).toBe('development');
    expect(config.selfImproveActuatorMode).toBe('pr_bot');
  });
});
