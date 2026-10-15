import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { getConfig } from '../src/platform/runtime/unifiedConfig.js';

const originalEnv = { ...process.env };
const healingEnvironmentNames = [
  'ARCANOS_PROCESS_KIND',
  'RUN_WORKERS',
  'SELF_IMPROVE_ENABLED',
  'SELF_IMPROVE_ACTUATOR_MODE',
  'SELF_IMPROVE_AUTONOMY_LEVEL',
  'SELF_IMPROVE_FREEZE',
  'PREDICTIVE_HEALING_ENABLED',
  'PREDICTIVE_HEALING_DRY_RUN',
  'RAILWAY_PREDICTIVE_HEALING_DRY_RUN',
  'PREDICTIVE_DRY_RUN',
  'PREDICTIVE_AUTO_EXECUTE',
  'RAILWAY_PREDICTIVE_AUTO_EXECUTE',
  'AUTO_EXECUTE_HEALING',
  'PREDICTIVE_HEALING_MIN_CONFIDENCE',
  'RAILWAY_PREDICTIVE_HEALING_MIN_CONFIDENCE',
  'PREDICTIVE_AUTO_EXECUTE_CONFIDENCE_THRESHOLD',
  'PREDICTIVE_HEALING_COOLDOWN_MS',
  'RAILWAY_PREDICTIVE_HEALING_COOLDOWN_MS',
  'PREDICTIVE_HEALING_ACTION_COOLDOWN_MS'
];

function resetEnv(overrides: Record<string, string | undefined>): void {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }

  Object.assign(process.env, originalEnv);

  for (const key of healingEnvironmentNames) {
    delete process.env[key];
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }
}

beforeEach(() => {
  resetEnv({});
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

describe('predictive healing config aliases', () => {
  it('defaults missing healing flags to observation without autonomous execution', () => {
    expect(getConfig()).toMatchObject({
      selfImproveEnabled: false,
      selfImproveActuatorMode: 'pr_bot',
      selfImproveAutonomyLevel: 0,
      selfImproveFrozen: false,
      predictiveHealingEnabled: false,
      predictiveHealingDryRun: true,
      autoExecuteHealing: false
    });
  });

  it.each(['', ' ', 'invalid', 'off', 'null', 'undefined', '2'])(
    'keeps dry-run enabled for missing or invalid input %j',
    (value) => {
      resetEnv({ PREDICTIVE_HEALING_DRY_RUN: value });
      expect(getConfig().predictiveHealingDryRun).toBe(true);
    }
  );

  it.each(['true', '1', 'yes', ' TRUE '])('recognizes dry-run true input %j', (value) => {
    resetEnv({ PREDICTIVE_HEALING_DRY_RUN: value });
    expect(getConfig().predictiveHealingDryRun).toBe(true);
  });

  it.each(['false', '0', 'no', ' FALSE '])('recognizes explicit dry-run false input %j', (value) => {
    resetEnv({ PREDICTIVE_HEALING_DRY_RUN: value });
    expect(getConfig().predictiveHealingDryRun).toBe(false);
  });

  it('uses primary predictive flags before Railway-prefixed values and legacy aliases', () => {
    resetEnv({
      PREDICTIVE_HEALING_DRY_RUN: 'true',
      RAILWAY_PREDICTIVE_HEALING_DRY_RUN: 'false',
      PREDICTIVE_DRY_RUN: 'false',
      PREDICTIVE_AUTO_EXECUTE: 'false',
      RAILWAY_PREDICTIVE_AUTO_EXECUTE: 'true',
      AUTO_EXECUTE_HEALING: 'true'
    });
    expect(getConfig()).toMatchObject({ predictiveHealingDryRun: true, autoExecuteHealing: false });
  });

  it('uses Railway-prefixed values before legacy aliases when primary values are blank', () => {
    resetEnv({
      PREDICTIVE_HEALING_DRY_RUN: ' ',
      RAILWAY_PREDICTIVE_HEALING_DRY_RUN: 'true',
      PREDICTIVE_DRY_RUN: 'false',
      PREDICTIVE_AUTO_EXECUTE: '',
      RAILWAY_PREDICTIVE_AUTO_EXECUTE: 'false',
      AUTO_EXECUTE_HEALING: 'true'
    });
    expect(getConfig()).toMatchObject({ predictiveHealingDryRun: true, autoExecuteHealing: false });
  });

  it.each(['PREDICTIVE_HEALING_DRY_RUN', 'RAILWAY_PREDICTIVE_HEALING_DRY_RUN'])(
    'does not fall through an invalid higher-precedence %s to a false alias',
    (key) => {
      resetEnv({ [key]: 'invalid', PREDICTIVE_DRY_RUN: 'false' });
      expect(getConfig().predictiveHealingDryRun).toBe(true);
    }
  );

  it('keeps dry-run enabled for an invalid legacy alias', () => {
    resetEnv({ PREDICTIVE_DRY_RUN: 'invalid' });
    expect(getConfig().predictiveHealingDryRun).toBe(true);
  });

  it('accepts legacy auto-execute only when higher-precedence values are absent', () => {
    resetEnv({ AUTO_EXECUTE_HEALING: 'true' });
    expect(getConfig().autoExecuteHealing).toBe(true);
  });

  it('does not infer execution authorization from an actuator selection alone', () => {
    resetEnv({ SELF_IMPROVE_ACTUATOR_MODE: 'daemon' });
    expect(getConfig()).toMatchObject({
      selfImproveActuatorMode: 'daemon',
      selfImproveEnabled: false,
      selfImproveAutonomyLevel: 0,
      predictiveHealingEnabled: false,
      predictiveHealingDryRun: true,
      autoExecuteHealing: false
    });
  });

  it.each([
    ['web', 'true', false],
    ['worker', 'false', true]
  ])('gives process role %s precedence over RUN_WORKERS=%s', (role, runWorkers, expected) => {
    resetEnv({ ARCANOS_PROCESS_KIND: role as string, RUN_WORKERS: runWorkers as string });
    expect(getConfig().runWorkers).toBe(expected);
  });

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
