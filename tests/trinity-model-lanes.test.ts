import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { buildDryRunPreview, runDirectAnswerStage, runFinalStage, runIntakeStage, runReasoningStage, validateModel } from '../src/core/logic/trinityStages.js';
import { createSingleChatCompletion } from '../src/services/openai/chatFallbacks.js';
import { resetCredentialCache, getDefaultModel } from '../src/services/openai/credentialProvider.js';
import { createRuntimeBudgetWithLimit } from '../src/platform/resilience/runtimeBudget.js';
import { runStructuredReasoning } from '../src/services/openai/structuredReasoning.js';

const capabilityFlags = {
  canBrowse: false, canVerifyProvidedData: false, canVerifyLiveData: false,
  canConfirmExternalState: false, canPersistData: false, canCallBackend: false
};
const authorityModel = 'ft:gpt-4.1:synthetic:trinity-authority';
const envNames = ['FINETUNED_MODEL_ID', 'TRINITY_INTAKE_MODEL', 'TRINITY_REASONING_MODEL', 'TRINITY_FINAL_MODEL', 'TRINITY_FINAL_ESCALATION_MODEL'];
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
  process.env.FINETUNED_MODEL_ID = authorityModel;
  for (const key of envNames.slice(1)) process.env[key] = 'gpt-4.1';
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

  it.each(['routine', 'escalation'] as const)(
    'selects the configured authority for %s final composition with one bounded call', async lane => {
      const result = await runFinalStage(client, '', 'Synthetic final', 'Synthetic reasoning', capabilityFlags, controls, undefined, undefined, undefined, budget(), undefined, lane);
      expect(result.activeModel).toBe(authorityModel);
      expect(create).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0][0]).toMatchObject({ model: authorityModel, max_output_tokens: 1000 });
      expect(create.mock.calls[0][0]).not.toHaveProperty('reasoning');
      expect(create.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    }
  );

  it('uses the same final lane for dry-run metadata', () => {
    expect(buildDryRunPreview('synthetic', 'Prompt', 'Prompt', capabilityFlags, [], 0, false).finalModelCandidate).toBe(authorityModel);
    expect(buildDryRunPreview('synthetic', 'Prompt', 'Prompt', capabilityFlags, [], 0, false, undefined, 'escalation').finalModelCandidate).toBe(authorityModel);
  });

  it('preserves unrelated default completions when intake is Luna', async () => {
    const expectedModel = getDefaultModel();
    await createSingleChatCompletion(client, { messages: [{ role: 'user', content: 'Synthetic unrelated request' }], max_tokens: 100 });
    expect(create.mock.calls[0][0].model).toBe(expectedModel);
  });

  it('ignores a module-local final selector and keeps the configured fine-tune authority', async () => {
    process.env.TRINITY_FINAL_MODEL = 'gpt-4.1';
    await runFinalStage(client, '', 'Synthetic', 'Synthetic', capabilityFlags, controls, undefined, undefined, undefined, budget());
    expect(create.mock.calls[0][0].model).toBe(authorityModel);
    expect(create.mock.calls[0][0]).not.toHaveProperty('reasoning');
  });

  it('accepts an explicit confirmation of the configured direct-answer authority with unchanged output cap', async () => {
    const result = await runDirectAnswerStage(client, '', 'Synthetic direct answer', undefined, budget(), undefined, authorityModel);
    expect(result.activeModel).toBe(authorityModel);
    expect(create.mock.calls[0][0]).not.toHaveProperty('reasoning');
    expect(create.mock.calls[0][0].max_output_tokens).toBeLessThanOrEqual(1200);
  });

  it.each(['gpt-4.1', 'gpt-6.1-sol', 'ft:gpt-4.1:synthetic:other-service'])(
    'rejects direct-answer override %s before provider invocation', async model => {
      await expect(runDirectAnswerStage(client, '', 'Synthetic direct answer', undefined, budget(), undefined, model))
        .rejects.toThrow('model override conflicts with final role');
      expect(create).not.toHaveBeenCalled();
    }
  );

  it('fails safely when configured final authority is a helper model', async () => {
    process.env.FINETUNED_MODEL_ID = 'gpt-6.1-sol';
    await expect(runFinalStage(client, '', 'Synthetic final', 'Synthetic reasoning', capabilityFlags, controls,
      undefined, undefined, undefined, budget())).rejects.toThrow('configured fine-tune authority unavailable');
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a legacy structured reasoning override at the production adapter boundary', async () => {
    await expect(runStructuredReasoning(client, 'gpt-5.1', 'Synthetic reasoning', budget()))
      .rejects.toThrow('model override conflicts with reasoning role');
    expect(create).not.toHaveBeenCalled();
  });
});
