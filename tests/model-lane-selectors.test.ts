import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import {
  getClearAuditEscalationModel, getClearAuditModel, getComplexModel, getDefaultModel,
  getFallbackModel, getGPT5Model, getTrinityFinalEscalationModel, getTrinityFinalModel,
  getTrinityIntakeModel, getTrinityReasoningModel, resetCredentialCache, setDefaultModel
} from '../src/services/openai/credentialProvider.js';
import { getConfig } from '../src/platform/runtime/unifiedConfig.js';

const lanes = [
  ['TRINITY_INTAKE_MODEL', getTrinityIntakeModel, 'gpt-6-luna', 'trinityIntakeModel'],
  ['TRINITY_REASONING_MODEL', getTrinityReasoningModel, 'gpt-6.1-sol', 'trinityReasoningModel'],
  ['TRINITY_FINAL_MODEL', getTrinityFinalModel, 'gpt-6-luna', 'trinityFinalModel'],
  ['TRINITY_FINAL_ESCALATION_MODEL', getTrinityFinalEscalationModel, 'gpt-6.1-sol', 'trinityFinalEscalationModel'],
  ['CLEAR_AUDIT_MODEL', getClearAuditModel, 'gpt-6-luna', 'clearAuditModel'],
  ['CLEAR_AUDIT_ESCALATION_MODEL', getClearAuditEscalationModel, 'gpt-6.1-sol', 'clearAuditEscalationModel']
] as const;
const legacyDefaultKeys = ['FINETUNED_MODEL_ID', 'FINE_TUNED_MODEL_ID', 'AI_MODEL', 'OPENAI_MODEL', 'RAILWAY_OPENAI_MODEL'];
const baseKeys = [...lanes.map(([key]) => key), ...legacyDefaultKeys, 'GPT5_MODEL', 'GPT51_MODEL',
  'FALLBACK_MODEL', 'AI_FALLBACK_MODEL', 'RAILWAY_OPENAI_FALLBACK_MODEL'];
const keys = [...new Set([...baseKeys, ...baseKeys.map(key => `RAILWAY_${key}`)])];
const saved = new Map(keys.map(key => [key, process.env[key]]));

beforeEach(() => {
  keys.forEach(key => { delete process.env[key]; });
  resetCredentialCache();
});
afterEach(() => {
  saved.forEach((value, key) => {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  resetCredentialCache();
});

describe('execution lane selectors', () => {
  it.each(lanes)('%s defaults independently to %s', (_key, selector, expected, configKey) => {
    expect(selector()).toBe(expected);
    expect(getConfig()[configKey]).toBe(expected);
  });

  it.each(lanes)('%s wins over every explicit legacy/shared selector', (key, selector) => {
    [...legacyDefaultKeys, 'GPT5_MODEL', 'GPT51_MODEL'].forEach(legacy => { process.env[legacy] = `legacy-${legacy}`; });
    process.env[key] = '  lane-override  ';
    process.env[`RAILWAY_${key}`] = 'railway-lane';
    expect(selector()).toBe('lane-override');
    process.env[key] = ' ';
    expect(selector()).toBe('railway-lane');
  });

  it.each(legacyDefaultKeys)('keeps %s as intake/routine-final rollback without inheriting it for complex work', key => {
    process.env[key] = 'legacy-default';
    expect(getTrinityIntakeModel()).toBe('legacy-default');
    expect(getTrinityFinalModel()).toBe('legacy-default');
    expect(getDefaultModel()).toBe('legacy-default');
    expect(getComplexModel()).toBe('legacy-default');
    expect(getTrinityReasoningModel()).toBe('gpt-6.1-sol');
    expect(getTrinityFinalEscalationModel()).toBe('gpt-6.1-sol');
  });

  it('resolves default rollback precedence deterministically', () => {
    legacyDefaultKeys.forEach(key => { process.env[key] = key; });
    for (const key of legacyDefaultKeys) {
      expect(getTrinityIntakeModel()).toBe(key);
      expect(getTrinityFinalModel()).toBe(key);
      delete process.env[key];
    }
  });

  it('preserves the fine-tuned Railway alias before shared default rollback selectors', () => {
    process.env.RAILWAY_FINETUNED_MODEL_ID = 'railway-finetuned';
    process.env.AI_MODEL = 'legacy-default';
    expect(getTrinityIntakeModel()).toBe('railway-finetuned');
    expect(getTrinityFinalModel()).toBe('railway-finetuned');
    expect(getDefaultModel()).toBe('railway-finetuned');
    process.env.TRINITY_INTAKE_MODEL = 'explicit-intake';
    expect(getTrinityIntakeModel()).toBe('explicit-intake');
    expect(getTrinityReasoningModel()).toBe('gpt-6.1-sol');
    expect(getTrinityFinalEscalationModel()).toBe('gpt-6.1-sol');
  });

  it('preserves explicit GPT5/GPT51 rollback order for reasoning, escalation and audit lanes', () => {
    process.env.GPT5_MODEL = 'legacy-gpt5';
    process.env.GPT51_MODEL = 'legacy-gpt51';
    const selectors = [getTrinityReasoningModel, getTrinityFinalEscalationModel, getClearAuditModel, getClearAuditEscalationModel, getGPT5Model];
    selectors.forEach(selector => expect(selector()).toBe('legacy-gpt5'));
    delete process.env.GPT5_MODEL;
    selectors.forEach(selector => expect(selector()).toBe('legacy-gpt51'));
    delete process.env.GPT51_MODEL;
    expect(getGPT5Model()).toBe('gpt-5.1');
  });

  it('preserves Railway aliases in legacy reasoning rollback precedence', () => {
    const selectors = [getTrinityReasoningModel, getTrinityFinalEscalationModel, getClearAuditModel, getClearAuditEscalationModel, getGPT5Model];
    process.env.RAILWAY_GPT5_MODEL = 'railway-gpt5';
    process.env.GPT51_MODEL = 'legacy-gpt51';
    selectors.forEach(selector => expect(selector()).toBe('railway-gpt5'));
    delete process.env.RAILWAY_GPT5_MODEL;
    delete process.env.GPT51_MODEL;
    process.env.RAILWAY_GPT51_MODEL = 'railway-gpt51';
    selectors.forEach(selector => expect(selector()).toBe('railway-gpt51'));
  });

  it.each(lanes)('changing %s cannot mutate any other lane or shared caller', (key, selector) => {
    const before = lanes.map(([, resolve]) => resolve());
    const shared = [getDefaultModel(), getComplexModel(), getGPT5Model(), getFallbackModel()];
    process.env[key] = 'isolated-model';
    expect(selector()).toBe('isolated-model');
    lanes.forEach(([otherKey, resolve], index) => {
      if (otherKey !== key) expect(resolve()).toBe(before[index]);
    });
    expect([getDefaultModel(), getComplexModel(), getGPT5Model(), getFallbackModel()]).toEqual(shared);
  });

  it('does not let a shared default of Luna steer complex Trinity calls', () => {
    process.env.OPENAI_MODEL = 'gpt-6-luna';
    expect(getTrinityIntakeModel()).toBe('gpt-6-luna');
    expect(getTrinityFinalEscalationModel()).toBe('gpt-6.1-sol');
    expect(getTrinityReasoningModel()).toBe('gpt-6.1-sol');
    expect(getGPT5Model()).toBe('gpt-5.1');
  });

  it('preserves legacy fallback order and runtime default cache independently', () => {
    process.env.FALLBACK_MODEL = 'rollback-fallback';
    setDefaultModel('runtime-default');
    expect(getDefaultModel()).toBe('runtime-default');
    expect(getFallbackModel()).toBe('rollback-fallback');
    expect(getTrinityIntakeModel()).toBe('gpt-6-luna');
    expect(getTrinityFinalEscalationModel()).toBe('gpt-6.1-sol');
  });
});
