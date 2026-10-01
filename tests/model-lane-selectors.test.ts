import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import {
  GenerativeModelPolicyError, getClearAuditEscalationModel, getClearAuditModel,
  getComplexModel, getDefaultModel, getFallbackModel, getGPT5Model,
  getTrinityFinalEscalationModel, getTrinityFinalModel, getTrinityIntakeModel,
  getTrinityReasoningModel, resetCredentialCache, resolveGenerativeModel, setDefaultModel
} from '../src/services/openai/credentialProvider.js';
import { getConfig } from '../src/platform/runtime/unifiedConfig.js';

const authority = 'ft:gpt-4.1:synthetic:service-authority';
const authorityKeys = ['FINETUNED_MODEL_ID', 'FINE_TUNED_MODEL_ID', 'AI_MODEL', 'OPENAI_MODEL', 'RAILWAY_OPENAI_MODEL'];
const legacyKeys = ['GPT5_MODEL', 'GPT51_MODEL', 'FALLBACK_MODEL', 'AI_FALLBACK_MODEL',
  'RAILWAY_OPENAI_FALLBACK_MODEL', 'TRINITY_INTAKE_MODEL', 'TRINITY_REASONING_MODEL',
  'TRINITY_FINAL_MODEL', 'TRINITY_FINAL_ESCALATION_MODEL', 'CLEAR_AUDIT_MODEL',
  'CLEAR_AUDIT_ESCALATION_MODEL'];
const keys = [...new Set([...authorityKeys, ...legacyKeys,
  ...[...authorityKeys, ...legacyKeys].map(key => `RAILWAY_${key}`)])];
const saved = new Map(keys.map(key => [key, process.env[key]]));
const helperLanes = [
  ['intake', getTrinityIntakeModel, 'gpt-6-luna', 'trinityIntakeModel'],
  ['reasoning', getTrinityReasoningModel, 'gpt-6.1-sol', 'trinityReasoningModel'],
  ['audit', getClearAuditModel, 'gpt-6-luna', 'clearAuditModel'],
  ['audit-escalation', getClearAuditEscalationModel, 'gpt-6.1-sol', 'clearAuditEscalationModel']
] as const;
const finalSelectors = [getDefaultModel, getFallbackModel, getComplexModel,
  getTrinityFinalModel, getTrinityFinalEscalationModel];

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

describe('shared generative role selectors', () => {
  it.each(helperLanes)('resolves %s independently of final authority', (role, selector, model, configKey) => {
    expect(selector()).toBe(model);
    expect(resolveGenerativeModel(role)).toBe(model);
    expect(getConfig()[configKey]).toBe(model);
  });

  it('uses Sol through the legacy reasoning-selector compatibility API', () => {
    expect(getGPT5Model()).toBe('gpt-6.1-sol');
    expect(getConfig()).toMatchObject({ gpt5Model: 'gpt-6.1-sol', gpt51Model: 'gpt-6.1-sol' });
  });

  it.each(authorityKeys)('preserves configured authority from %s for every final path', key => {
    process.env[key] = '  ' + authority + '  ';
    finalSelectors.forEach(selector => expect(selector()).toBe(authority));
    expect(getConfig()).toMatchObject({
      defaultModel: authority, fallbackModel: authority,
      trinityFinalModel: authority, trinityFinalEscalationModel: authority
    });
    helperLanes.forEach(([, selector, model]) => expect(selector()).toBe(model));
  });

  it('retains existing authority alias precedence rather than choosing any available fine-tune', () => {
    authorityKeys.forEach((key, index) => { process.env[key] = authority + '-' + index; });
    for (const [index, key] of authorityKeys.entries()) {
      finalSelectors.forEach(selector => expect(selector()).toBe(authority + '-' + index));
      delete process.env[key];
    }
  });

  it('retains Railway primary-alias precedence before later authority aliases', () => {
    process.env.RAILWAY_FINETUNED_MODEL_ID = authority + '-railway';
    process.env.FINE_TUNED_MODEL_ID = authority + '-secondary';
    process.env.AI_MODEL = authority + '-ai';
    expect(getDefaultModel()).toBe(authority + '-railway');
    process.env.FINETUNED_MODEL_ID = '  ' + authority + '  ';
    expect(getTrinityFinalEscalationModel()).toBe(authority);
  });

  it('resolves distinct service authorities without a shared model cache or historical ID', () => {
    process.env.AI_MODEL = authority + '-web';
    expect(getTrinityFinalModel()).toBe(authority + '-web');
    process.env.AI_MODEL = authority + '-worker';
    expect(getTrinityFinalModel()).toBe(authority + '-worker');
    expect(getFallbackModel()).toBe(authority + '-worker');
    expect(getTrinityIntakeModel()).toBe('gpt-6-luna');
  });

  it.each(legacyKeys)('cannot change any role through legacy/lane override %s', key => {
    process.env.AI_MODEL = authority;
    process.env[key] = 'gpt-5.1';
    process.env['RAILWAY_' + key] = 'gpt-4o-mini';
    finalSelectors.forEach(selector => expect(selector()).toBe(authority));
    helperLanes.forEach(([, selector, model]) => expect(selector()).toBe(model));
    expect(getGPT5Model()).toBe('gpt-6.1-sol');
  });

  it.each([undefined, '', '   ', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-5.1', 'ft:', 'ft:bad model'])(
    'fails every final selector safely for unavailable authority %p', model => {
      if (model !== undefined) process.env.AI_MODEL = model;
      finalSelectors.forEach(selector => expect(selector).toThrow(GenerativeModelPolicyError));
      for (const role of ['final', 'final-escalation'] as const) {
        expect(() => resolveGenerativeModel(role)).toThrow(expect.objectContaining({ code: 'FINAL_AUTHORITY_UNAVAILABLE' }));
      }
      helperLanes.forEach(([, selector, expected]) => expect(selector()).toBe(expected));
    }
  );

  it('fails closed for an invalid higher-precedence identity instead of substituting a lower alias', () => {
    process.env.FINETUNED_MODEL_ID = 'gpt-6-luna';
    process.env.AI_MODEL = authority;
    expect(getDefaultModel).toThrow(expect.objectContaining({ code: 'FINAL_AUTHORITY_UNAVAILABLE' }));
  });

  it.each([
    ['intake', 'gpt-6-luna'], ['reasoning', 'gpt-6.1-sol'],
    ['audit', 'gpt-6-luna'], ['audit-escalation', 'gpt-6.1-sol'],
    ['final', authority], ['final-escalation', authority]
  ] as const)('allows only a matching explicit caller model for %s', (role, model) => {
    process.env.AI_MODEL = authority;
    expect(resolveGenerativeModel(role, '  ' + model + '  ')).toBe(model);
    expect(() => resolveGenerativeModel(role, 'gpt-5.1')).toThrow(expect.objectContaining({ code: 'MODEL_OVERRIDE_CONFLICT' }));
    expect(() => resolveGenerativeModel(role, '')).toThrow(GenerativeModelPolicyError);
  });

  it('prevents the legacy runtime-default setter from replacing configured authority', () => {
    process.env.AI_MODEL = authority;
    setDefaultModel(authority);
    expect(() => setDefaultModel('gpt-6.1-sol')).toThrow(expect.objectContaining({ code: 'MODEL_OVERRIDE_CONFLICT' }));
    expect(getDefaultModel()).toBe(authority);
  });

  it('returns bounded policy errors without disclosing configured or rejected identities', () => {
    process.env.AI_MODEL = authority;
    const rejected = 'ft:gpt-4.1:synthetic:other-private-identity';
    try {
      resolveGenerativeModel('final', rejected);
      throw new Error('Expected model policy rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(GenerativeModelPolicyError);
      expect((error as Error).message).not.toContain(authority);
      expect((error as Error).message).not.toContain(rejected);
    }
  });
});
