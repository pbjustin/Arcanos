import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { buildDryRunPreview, runDirectAnswerStage, runFinalStage, runIntakeStage, runReasoningStage, validateModel } from '../src/core/logic/trinityStages.js';
import { createSingleChatCompletion } from '../src/services/openai/chatFallbacks.js';
import { resetCredentialCache, getDefaultModel } from '../src/services/openai/credentialProvider.js';
import { createRuntimeBudgetWithLimit } from '../src/platform/resilience/runtimeBudget.js';

const capabilityFlags = {
  canBrowse: false, canVerifyProvidedData: false, canVerifyLiveData: false,
  canConfirmExternalState: false, canPersistData: false, canCallBackend: false
};
const envNames = ['TRINITY_INTAKE_MODEL', 'TRINITY_REASONING_MODEL', 'TRINITY_FINAL_MODEL', 'TRINITY_FINAL_ESCALATION_MODEL'];
const saved = envNames.map(key => process.env[key]);
const create = jest.fn();
const retrieve = jest.fn();
const client = { responses: { create }, models: { retrieve } } as any;
const budget = () => createRuntimeBudgetWithLimit(30_000, 0);
const controls = { strictUserVisibleOutput: true };
const structured = {
  response_mode: 'answer', achievable_subtasks: ['Classify the synthetic request'], blocked_subtasks: [],
  user_visible_caveats: [], claim_tags: [], final_answer: 'Synthetic answer.'
};

beforeEach(() => {
  jest.clearAllMocks();
  envNames.forEach((key, index) => { process.env[key] = index === 1 || index === 3 ? 'gpt-6.1-sol' : 'gpt-6-luna'; });
  resetCredentialCache();
  retrieve.mockResolvedValue({ id: 'gpt-6-luna' });
  create.mockImplementation(async (payload: any) => ({
    id: 'synthetic-response', model: payload.model, status: 'completed',
    output_text: payload.text?.format?.type === 'json_schema' ? JSON.stringify(structured) : 'Synthetic answer.',
    usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 }, output: []
  }));
});
afterEach(() => {
  envNames.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
  resetCredentialCache();
});

describe('Trinity model lanes at the real Responses/schema boundary', () => {
  it('validates and passes the scoped intake model explicitly, independent of the shared default', async () => {
    const model = await validateModel(client, budget());
    await runIntakeStage(client, model, 'Synthetic classification', '', capabilityFlags, controls, undefined, undefined, budget());
    expect(model).toBe('gpt-6-luna');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ model: 'gpt-6-luna', reasoning: { effort: 'none' }, max_output_tokens: 500 });
  });

  it('selects Sol and normalizes simple reasoning to low with the real JSON validator', async () => {
    const result = await runReasoningStage(client, 'Synthetic reasoning', capabilityFlags, controls, 'simple', { effort: 'none' }, budget());
    expect(result.model).toBe('gpt-6.1-sol');
    expect(create.mock.calls[0][0]).toMatchObject({ model: 'gpt-6.1-sol', reasoning: { effort: 'low' }, max_output_tokens: 8000, text: { format: { type: 'json_schema', strict: true } } });
    expect(create.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it.each([['routine', 'gpt-6-luna', 'none'], ['escalation', 'gpt-6.1-sol', 'low']] as const)(
    'selects %s final model with one bounded call', async (lane, model, effort) => {
      const result = await runFinalStage(client, '', 'Synthetic final', 'Synthetic reasoning', capabilityFlags, controls, undefined, undefined, undefined, budget(), undefined, lane);
      expect(result.activeModel).toBe(model);
      expect(create).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0][0]).toMatchObject({ model, reasoning: { effort }, max_output_tokens: 1000 });
      expect(create.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    }
  );

  it('uses the same final lane for dry-run metadata', () => {
    expect(buildDryRunPreview('synthetic', 'Prompt', 'Prompt', capabilityFlags, [], 0, false).finalModelCandidate).toBe('gpt-6-luna');
    expect(buildDryRunPreview('synthetic', 'Prompt', 'Prompt', capabilityFlags, [], 0, false, undefined, 'escalation').finalModelCandidate).toBe('gpt-6.1-sol');
  });

  it('preserves unrelated default completions when intake is Luna', async () => {
    const expectedModel = getDefaultModel();
    await createSingleChatCompletion(client, { messages: [{ role: 'user', content: 'Synthetic unrelated request' }], max_tokens: 100 });
    expect(create.mock.calls[0][0].model).toBe(expectedModel);
  });

  it('does not send reasoning fields to a legacy final rollback model', async () => {
    process.env.TRINITY_FINAL_MODEL = 'gpt-4.1';
    await runFinalStage(client, '', 'Synthetic', 'Synthetic', capabilityFlags, controls, undefined, undefined, undefined, budget());
    expect(create.mock.calls[0][0].model).toBe('gpt-4.1');
    expect(create.mock.calls[0][0]).not.toHaveProperty('reasoning');
  });

  it('supports an explicit Sol direct-answer escalation with unchanged visible output cap', async () => {
    const result = await runDirectAnswerStage(client, '', 'Synthetic direct answer', undefined, budget(), undefined, 'gpt-6.1-sol');
    expect(result.activeModel).toBe('gpt-6.1-sol');
    expect(create.mock.calls[0][0].reasoning).toEqual({ effort: 'low' });
    expect(create.mock.calls[0][0].max_output_tokens).toBeLessThanOrEqual(1200);
  });
});
