import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

// Only external transport and persistence are replaced. Module routing, role
// selection, request construction and response validation use production code.
const create = jest.fn();
const saveSelfReflection = jest.fn(async () => undefined);
const client = { responses: { create } } as any;
jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: () => ({ adapter: client, client })
}));
jest.unstable_mockModule('@core/db/repositories/selfReflectionRepository.js', () => ({
  saveSelfReflection
}));

const { gptFallbackClassifier } = await import('../src/dispatcher/gptDomainClassifier.js');
const { HRCCore } = await import('../src/services/hrc.js');
const { buildPatchSet } = await import('../src/services/ai-reflections.js');
const { createCapabilityRegistry, resolveLlmDispatchPlan } =
  await import('../src/dispatcher/naturalLanguage/index.js');
const { resetCredentialCache } = await import('../src/services/openai/credentialProvider.js');

const authority = 'ft:gpt-4.1:synthetic:module-authority';
const envNames = [
  'FINETUNED_MODEL_ID', 'GPT5_MODEL', 'GPT51_MODEL', 'TRINITY_INTAKE_MODEL',
  'CLEAR_AUDIT_MODEL', 'HRC_MODEL', 'AI_REFLECTION_MODEL', 'GPT_ACCESS_DISPATCH_MODEL'
];
const saved = envNames.map(key => process.env[key]);
let outputText = '';

beforeEach(() => {
  create.mockReset();
  saveSelfReflection.mockClear();
  for (const key of envNames) delete process.env[key];
  process.env.FINETUNED_MODEL_ID = authority;
  // Retired module/helper preferences cannot redirect any of these lanes.
  process.env.GPT5_MODEL = 'gpt-5.1';
  process.env.GPT51_MODEL = 'gpt-4.1';
  process.env.TRINITY_INTAKE_MODEL = 'gpt-4o-mini';
  process.env.CLEAR_AUDIT_MODEL = 'gpt-4.1-mini';
  resetCredentialCache();
  create.mockImplementation(async (payload: any) => ({
    id: 'synthetic-module-response', model: payload.model, status: 'completed',
    output_text: outputText, output: [],
    usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 }
  }));
});

afterEach(() => {
  envNames.forEach((key, index) => {
    if (saved[index] === undefined) delete process.env[key];
    else process.env[key] = saved[index];
  });
  resetCredentialCache();
});

describe('module calls resolve the real shared model policy', () => {
  it('routes domain classification to Luna with its bounded intake budget', async () => {
    outputText = 'code';
    await expect(gptFallbackClassifier(client, 'Write a synthetic helper')).resolves.toBe('code');
    expect(create.mock.calls[0][0]).toMatchObject({
      model: 'gpt-6-luna', reasoning: { effort: 'none' }, max_output_tokens: 64
    });
  });

  it('uses Luna for HRC routine audit while retaining structured validation and stateless storage', async () => {
    outputText = '{"fidelity":0.8,"resilience":0.7,"verdict":"synthetic assessment"}';
    await expect(new HRCCore().evaluate('Synthetic content', { store: false })).resolves.toEqual({
      fidelity: 0.8, resilience: 0.7, verdict: 'synthetic assessment'
    });
    expect(create.mock.calls[0][0]).toMatchObject({
      model: 'gpt-6-luna', reasoning: { effort: 'none' }, store: false,
      text: { format: { type: 'json_object' } }
    });
  });

  it('refuses a module-local legacy HRC override before transport', async () => {
    process.env.HRC_MODEL = 'gpt-4o-mini';
    const result = await new HRCCore().evaluate('Synthetic content');
    expect(result.fidelity).toBe(0);
    expect(result.verdict).toContain('model override conflicts with audit role');
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps internal reflection on Sol through the actual callOpenAI request path', async () => {
    outputText = 'Synthetic system reflection.';
    const patch = await buildPatchSet({ useMemory: false, useCache: false });
    expect(patch.content).toBe(outputText);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].model).toBe('gpt-6.1-sol');
    expect(saveSelfReflection).not.toHaveBeenCalled();
  });

  it.each(['gpt-5.1', authority])('refuses reflection override %s before transport', async model => {
    await expect(buildPatchSet({ useMemory: false, useCache: false, model }))
      .rejects.toThrow('model override conflicts with reasoning role');
    expect(create).not.toHaveBeenCalled();
    expect(saveSelfReflection).not.toHaveBeenCalled();
  });

  it('uses the intake role for structured dispatch without changing confirmation policy', async () => {
    const registry = createCapabilityRegistry([{
      action: 'synthetic.inspect', description: 'Inspect synthetic state',
      risk: 'readonly', requiresConfirmation: false,
      runner: { kind: 'gpt-access-diagnostics' }
    }]);
    outputText = JSON.stringify({
      action: 'synthetic.inspect', payload: {}, confidence: 0.9,
      requiresConfirmation: false, reason: 'synthetic_match', candidates: []
    });
    const result = await resolveLlmDispatchPlan({ utterance: 'Inspect synthetic state', registry, client });
    expect(result.action).toBe('synthetic.inspect');
    expect(result.requiresConfirmation).toBe(false);
    expect(create.mock.calls[0][0]).toMatchObject({
      model: 'gpt-6-luna', reasoning: { effort: 'none' }, max_output_tokens: 700
    });
  });

  it('rejects an explicit legacy dispatch model without provider work', async () => {
    const registry = createCapabilityRegistry([{
      action: 'synthetic.inspect', risk: 'readonly', requiresConfirmation: false,
      runner: { kind: 'gpt-access-diagnostics' }
    }]);
    const result = await resolveLlmDispatchPlan({
      utterance: 'Inspect synthetic state', registry, client, model: 'gpt-4.1-mini'
    });
    expect(result.action).toBe('INTENT_CLARIFICATION_REQUIRED');
    expect(result.reason).toBe('llm_dispatch_failed');
    expect(create).not.toHaveBeenCalled();
  });
});
