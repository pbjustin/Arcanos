import { afterEach, describe, expect, it } from '@jest/globals';
import { getConfig } from '../src/platform/runtime/unifiedConfig.js';

const originalEnv = { ...process.env };

function resetEnv(overrides: Record<string, string | undefined>): void {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }

  Object.assign(process.env, originalEnv);

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }
}

afterEach(() => {
  resetEnv({});
});

describe('predictive healing config aliases', () => {
  it('accepts the requested predictive dry-run and auto-execute aliases', () => {
    resetEnv({
      PREDICTIVE_HEALING_DRY_RUN: undefined,
      AUTO_EXECUTE_HEALING: undefined,
      PREDICTIVE_DRY_RUN: 'false',
      PREDICTIVE_AUTO_EXECUTE: 'true'
    });

    const config = getConfig();

    expect(config.predictiveHealingDryRun).toBe(false);
    expect(config.autoExecuteHealing).toBe(true);
  });

  it('accepts the requested confidence threshold alias', () => {
    resetEnv({
      PREDICTIVE_HEALING_MIN_CONFIDENCE: undefined,
      PREDICTIVE_AUTO_EXECUTE_CONFIDENCE_THRESHOLD: '0.81'
    });

    const config = getConfig();

    expect(config.predictiveHealingMinConfidence).toBe(0.81);
  });

  it('accepts the requested predictive cooldown alias', () => {
    resetEnv({
      PREDICTIVE_HEALING_COOLDOWN_MS: '45000',
      PREDICTIVE_HEALING_ACTION_COOLDOWN_MS: undefined
    });

    const config = getConfig();

    expect(config.predictiveHealingActionCooldownMs).toBe(45000);
  });
});
