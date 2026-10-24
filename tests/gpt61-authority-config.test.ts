import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  aiLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));
jest.unstable_mockModule('@platform/logging/telemetry.js', () => ({ recordTraceEvent: jest.fn() }));

const { getConfig, validateConfig } = await import('../src/platform/runtime/unifiedConfig.js');
const { validateEnvironment } = await import('../src/platform/runtime/environmentValidation.js');
const { resolveGenerativeModel, getDefaultModel, getFallbackModel } = await import('../src/services/openai/credentialProvider.js');
const { resolveGenerativeModelFromConfig } = await import('../src/shared/gpt/generativeModelPolicyCore.js');

const originalEnvironment = process.env;
const authorityKeys = [
  'FINETUNED_MODEL_ID', 'RAILWAY_FINETUNED_MODEL_ID', 'FINE_TUNED_MODEL_ID',
  'AI_MODEL', 'OPENAI_MODEL', 'RAILWAY_OPENAI_MODEL',
  'ARCANOS_GPT61_AUTHORITY_ENABLED', 'ARCANOS_GPT61_AUTHORITY_MODEL', 'ARCANOS_BEHAVIORAL_PROFILE_ID'
];
const webAuthority = 'ft:gpt-4.1:synthetic:web-authority';
const workerAuthority = 'ft:gpt-4.1:synthetic:worker-authority';

function enableReplacement(): void {
  process.env.ARCANOS_GPT61_AUTHORITY_ENABLED = 'true';
  process.env.ARCANOS_GPT61_AUTHORITY_MODEL = 'gpt-6.1-sol';
  process.env.ARCANOS_BEHAVIORAL_PROFILE_ID = 'arcanos-behavior/v1';
}

beforeEach(() => {
  process.env = { ...originalEnvironment };
  authorityKeys.forEach(key => { delete process.env[key]; });
  process.env.FINETUNED_MODEL_ID = webAuthority;
  process.env.NODE_ENV = 'test';
  process.env.FORCE_MOCK = 'true';
  process.env.PORT = '8080';
});

afterEach(() => { process.env = originalEnvironment; });

describe('explicit GPT-6.1 Sol authority configuration', () => {
  it.each([undefined, 'false'])('retains legacy authority with switch %s and ignores inactive replacement settings', flag => {
    if (flag !== undefined) process.env.ARCANOS_GPT61_AUTHORITY_ENABLED = flag;
    process.env.ARCANOS_GPT61_AUTHORITY_MODEL = 'gpt-6-luna';
    process.env.ARCANOS_BEHAVIORAL_PROFILE_ID = 'unsupported-profile';

    expect(getConfig()).toMatchObject({ generativeAuthorityMode: 'legacy-finetune', defaultModel: webAuthority });
    expect(getDefaultModel()).toBe(webAuthority);
    expect(getFallbackModel()).toBe(webAuthority);
    expect(validateConfig().valid).toBe(true);
  });

  it('preserves historical fine-tune alias precedence', () => {
    process.env.RAILWAY_FINETUNED_MODEL_ID = workerAuthority;
    process.env.FINE_TUNED_MODEL_ID = 'ft:synthetic:lower-priority';
    process.env.AI_MODEL = 'ft:synthetic:lowest-priority';
    expect(getDefaultModel()).toBe(webAuthority);
    delete process.env.FINETUNED_MODEL_ID;
    expect(getDefaultModel()).toBe(workerAuthority);
    delete process.env.RAILWAY_FINETUNED_MODEL_ID;
    expect(getDefaultModel()).toBe('ft:synthetic:lower-priority');
  });

  it.each(['web', 'worker'])('selects the pinned profile and replacement independently for %s', service => {
    const legacyAuthority = service === 'web' ? webAuthority : workerAuthority;
    process.env.ARCANOS_PROCESS_KIND = service;
    process.env.FINETUNED_MODEL_ID = legacyAuthority;
    enableReplacement();

    expect(getConfig()).toMatchObject({
      generativeAuthorityMode: 'gpt61-sol', behavioralProfileId: 'arcanos-behavior/v1',
      defaultModel: 'gpt-6.1-sol', fallbackModel: 'gpt-6.1-sol',
      trinityFinalModel: 'gpt-6.1-sol', trinityFinalEscalationModel: 'gpt-6.1-sol',
      trinityIntakeModel: 'gpt-6-luna', trinityReasoningModel: 'gpt-6.1-sol',
      clearAuditModel: 'gpt-6-luna', clearAuditEscalationModel: 'gpt-6.1-sol'
    });
    expect(getDefaultModel()).toBe('gpt-6.1-sol');
    expect(getFallbackModel()).toBe('gpt-6.1-sol');
    expect(validateConfig().valid).toBe(true);
    expect(validateEnvironment().errors).not.toEqual(expect.arrayContaining([expect.stringContaining('AI_MODEL')]));
    expect(process.env.FINETUNED_MODEL_ID).toBe(legacyAuthority);

    process.env.ARCANOS_GPT61_AUTHORITY_ENABLED = 'false';
    expect(getDefaultModel()).toBe(legacyAuthority);
  });

  it('does not require or synthesize a fine-tune ID while replacement mode is enabled', () => {
    delete process.env.FINETUNED_MODEL_ID;
    enableReplacement();
    expect(getDefaultModel()).toBe('gpt-6.1-sol');
  });

  it.each([undefined, 'arcanos-behavior/v2'])('reports invalid profile %s without blaming a valid AI_MODEL', profile => {
    enableReplacement();
    if (profile === undefined) delete process.env.ARCANOS_BEHAVIORAL_PROFILE_ID;
    else process.env.ARCANOS_BEHAVIORAL_PROFILE_ID = profile;

    const result = validateEnvironment();

    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('ARCANOS_BEHAVIORAL_PROFILE_ID must select a supported version when replacement authority is enabled');
    expect(result.errors).not.toEqual(expect.arrayContaining([expect.stringContaining('AI_MODEL')]));
    expect(() => getDefaultModel()).toThrow(expect.objectContaining({ code: 'FINAL_AUTHORITY_UNAVAILABLE' }));
  });

  it.each(['final', 'final-escalation'] as const)('rejects conflicting caller overrides for %s', role => {
    enableReplacement();
    expect(resolveGenerativeModel(role, 'gpt-6.1-sol')).toBe('gpt-6.1-sol');
    for (const model of ['gpt-6-luna', webAuthority, 'gpt-6.1-sol-other', '']) {
      expect(() => resolveGenerativeModel(role, model)).toThrow(expect.objectContaining({ code: 'MODEL_OVERRIDE_CONFLICT' }));
    }
  });

  it.each([
    ['ARCANOS_GPT61_AUTHORITY_MODEL', undefined],
    ['ARCANOS_GPT61_AUTHORITY_MODEL', 'gpt-6-luna'],
    ['ARCANOS_GPT61_AUTHORITY_MODEL', webAuthority],
    ['ARCANOS_GPT61_AUTHORITY_MODEL', 'gpt-6.1-sol-other'],
    ['ARCANOS_BEHAVIORAL_PROFILE_ID', undefined],
    ['ARCANOS_BEHAVIORAL_PROFILE_ID', 'arcanos-behavior/v2']
  ])('fails closed when enabled replacement setting %s is %s', (key, value) => {
    enableReplacement();
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
    expect(() => getDefaultModel()).toThrow(expect.objectContaining({ code: 'FINAL_AUTHORITY_UNAVAILABLE' }));
    expect(() => getFallbackModel()).toThrow(expect.objectContaining({ code: 'FINAL_AUTHORITY_UNAVAILABLE' }));
    expect(validateConfig().valid).toBe(false);
    expect(validateEnvironment().isValid).toBe(false);
    expect(process.env.FINETUNED_MODEL_ID).toBe(webAuthority);
  });

  it.each(['TRUE', '1', 'yes', 'enabled', 'FALSE', '0'])('does not silently activate or roll back for malformed switch %s', value => {
    enableReplacement();
    process.env.ARCANOS_GPT61_AUTHORITY_ENABLED = value;
    expect(getConfig().generativeAuthorityMode).toBe('invalid');
    expect(() => getDefaultModel()).toThrow(expect.objectContaining({ code: 'FINAL_AUTHORITY_UNAVAILABLE' }));
    expect(validateConfig().errors).toContain('ARCANOS_GPT61_AUTHORITY_ENABLED must be exactly true or false');
    expect(validateEnvironment().isValid).toBe(false);
  });

  it('keeps the ft restriction for compatibility callers that provide no migration mode', () => {
    const config = { ...getConfig(), generativeAuthorityMode: undefined, trinityFinalModel: 'gpt-6.1-sol' };
    expect(() => resolveGenerativeModelFromConfig(config, 'final')).toThrow(expect.objectContaining({ code: 'FINAL_AUTHORITY_UNAVAILABLE' }));
    expect(resolveGenerativeModelFromConfig({ ...config, trinityFinalModel: webAuthority }, 'final')).toBe(webAuthority);
  });

  it('does not accept a fine-tune final accidentally paired with enabled replacement metadata', () => {
    enableReplacement();
    expect(() => resolveGenerativeModelFromConfig({ ...getConfig(), trinityFinalModel: webAuthority }, 'final')).toThrow(
      expect.objectContaining({ code: 'FINAL_AUTHORITY_UNAVAILABLE' })
    );
  });
});
