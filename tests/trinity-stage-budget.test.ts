import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const createSingleChatCompletionMock = jest.fn();
const runStructuredReasoningMock = jest.fn();
const getTokenParameterMock = jest.fn();

jest.unstable_mockModule('@services/openai/credentialProvider.js', () => ({
  getDefaultModel: () => 'ft:test-default',
  getGPT5Model: () => 'gpt-5.1',
  getTrinityReasoningModel: () => 'gpt-5.6-terra',
  getComplexModel: () => 'ft:test-complex',
  getFallbackModel: () => 'gpt-4.1'
}));

jest.unstable_mockModule('@services/openai/chatFallbacks.js', () => ({
  createSingleChatCompletion: createSingleChatCompletionMock,
}));

jest.unstable_mockModule('@services/openai/structuredReasoning.js', () => ({
  runStructuredReasoning: runStructuredReasoningMock
}));

jest.unstable_mockModule('@shared/tokenParameterHelper.js', () => ({
  getTokenParameter: getTokenParameterMock
}));

const { runIntakeStage, runReasoningStage, runFinalStage } = await import('../src/core/logic/trinityStages.js');
const { createRuntimeBudgetWithLimit } = await import('../src/platform/resilience/runtimeBudget.js');

describe('trinity stage budgets', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.TRINITY_INTAKE_STAGE_TIMEOUT_MS;
    delete process.env.TRINITY_REASONING_STAGE_TIMEOUT_MS;
    delete process.env.TRINITY_REASONING_MAX_OUTPUT_TOKENS;
    delete process.env.TRINITY_FINAL_STAGE_TIMEOUT_MS;
    getTokenParameterMock.mockReturnValue({ max_completion_tokens: 320 });
  });

  afterEach(() => {
    delete process.env.TRINITY_INTAKE_STAGE_TIMEOUT_MS;
    delete process.env.TRINITY_REASONING_STAGE_TIMEOUT_MS;
    delete process.env.TRINITY_REASONING_MAX_OUTPUT_TOKENS;
    delete process.env.TRINITY_FINAL_STAGE_TIMEOUT_MS;
  });

  it('uses a single bounded completion attempt for intake and final stages', async () => {
    createSingleChatCompletionMock
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'framed-request' } }],
        activeModel: 'ft:test-default',
        fallbackFlag: false,
        usage: { total_tokens: 10 },
        id: 'resp-intake',
        created: 1
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'final-answer' } }],
        activeModel: 'ft:test-complex',
        fallbackFlag: false,
        usage: { total_tokens: 12 },
        id: 'resp-final',
        created: 2
      });

    const runtimeBudget = createRuntimeBudgetWithLimit(20_000, 0);

    await runIntakeStage(
      {} as never,
      'ft:test-default',
      'Prompt',
      'Memory',
      {
        canBrowse: false,
        canVerifyProvidedData: false,
        canVerifyLiveData: false,
        canConfirmExternalState: false,
        canPersistData: false,
        canCallBackend: false
      },
      { strictUserVisibleOutput: true },
      undefined,
      undefined,
      runtimeBudget
    );

    await runFinalStage(
      {} as never,
      'Memory',
      'Prompt',
      'Reasoning',
      {
        canBrowse: false,
        canVerifyProvidedData: false,
        canVerifyLiveData: false,
        canConfirmExternalState: false,
        canPersistData: false,
        canCallBackend: false
      },
      { strictUserVisibleOutput: true },
      undefined,
      undefined,
      undefined,
      runtimeBudget
    );

    expect(createSingleChatCompletionMock).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        timeoutMs: 6000
      })
    );
    expect(createSingleChatCompletionMock).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        timeoutMs: 4000
      })
    );
  });

  it('allows worker-originated stages to override the route default timeout while staying budget-safe', async () => {
    createSingleChatCompletionMock
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'framed-request' } }],
        activeModel: 'ft:test-default',
        fallbackFlag: false,
        usage: { total_tokens: 10 },
        id: 'resp-intake',
        created: 1
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'final-answer' } }],
        activeModel: 'ft:test-complex',
        fallbackFlag: false,
        usage: { total_tokens: 12 },
        id: 'resp-final',
        created: 2
      });

    const runtimeBudget = createRuntimeBudgetWithLimit(20_000, 0);

    await runIntakeStage(
      {} as never,
      'ft:test-default',
      'Prompt',
      'Memory',
      {
        canBrowse: false,
        canVerifyProvidedData: false,
        canVerifyLiveData: false,
        canConfirmExternalState: false,
        canPersistData: false,
        canCallBackend: false
      },
      { strictUserVisibleOutput: true },
      undefined,
      undefined,
      runtimeBudget,
      15_000
    );

    await runFinalStage(
      {} as never,
      'Memory',
      'Prompt',
      'Reasoning',
      {
        canBrowse: false,
        canVerifyProvidedData: false,
        canVerifyLiveData: false,
        canConfirmExternalState: false,
        canPersistData: false,
        canCallBackend: false
      },
      { strictUserVisibleOutput: true },
      undefined,
      undefined,
      undefined,
      runtimeBudget,
      15_000
    );

    expect(createSingleChatCompletionMock).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        timeoutMs: 15_000
      })
    );
    expect(createSingleChatCompletionMock).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        timeoutMs: 15_000
      })
    );
  });

  it('uses the 20-second default structured reasoning stage timeout', async () => {
    runStructuredReasoningMock.mockImplementation(async (...args: unknown[]) => {
      const options = args[5] as { onUsage?: (usage: unknown) => void } | undefined;
      options?.onUsage?.({
        input_tokens: 40,
        input_tokens_details: { cached_tokens: 5 },
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 11 },
        total_tokens: 60
      });
      return {
        reasoning_steps: ['step'],
        assumptions: [],
        constraints: [],
        tradeoffs: [],
        alternatives_considered: [],
        chosen_path_justification: 'because',
        response_mode: 'answer',
        achievable_subtasks: ['answer'],
        blocked_subtasks: [],
        user_visible_caveats: [],
        claim_tags: [],
        final_answer: 'final'
      };
    });

    const runtimeBudget = createRuntimeBudgetWithLimit(40_000, 0);

    const result = await runReasoningStage(
      {} as never,
      'Framed request',
      {
        canBrowse: false,
        canVerifyProvidedData: false,
        canVerifyLiveData: false,
        canConfirmExternalState: false,
        canPersistData: false,
        canCallBackend: false
      },
      { strictUserVisibleOutput: true },
      'complex',
      { effort: 'low' },
      runtimeBudget
    );

    const complexReasoningCall = runStructuredReasoningMock.mock.calls[0];
    expect(runStructuredReasoningMock).toHaveBeenCalledWith(
      expect.anything(),
      'gpt-5.6-terra',
      expect.any(String),
      runtimeBudget,
      expect.any(Number),
      expect.objectContaining({
        schemaVariant: 'full',
        reasoningEffort: 'low',
        maxOutputTokens: 8000,
        onUsage: expect.any(Function)
      })
    );
    expect(complexReasoningCall?.[4]).toBeLessThanOrEqual(20_000);
    expect(complexReasoningCall?.[4]).toBeGreaterThan(19_000);
    expect(result.usage).toEqual({
      prompt_tokens: 40,
      completion_tokens: 20,
      total_tokens: 60,
      reasoning_tokens: 11
    });
  });

  it('uses the worker override for structured reasoning and clamps it to the remaining budget', async () => {
    runStructuredReasoningMock.mockResolvedValue({
      reasoning_steps: ['step'],
      assumptions: [],
      constraints: [],
      tradeoffs: [],
      alternatives_considered: [],
      chosen_path_justification: 'because',
      response_mode: 'answer',
      achievable_subtasks: ['answer'],
      blocked_subtasks: [],
      user_visible_caveats: [],
      claim_tags: [],
      final_answer: 'final'
    });

    const runtimeBudget = createRuntimeBudgetWithLimit(20_000, 0);

    await runReasoningStage(
      {} as never,
      'Framed request',
      {
        canBrowse: false,
        canVerifyProvidedData: false,
        canVerifyLiveData: false,
        canConfirmExternalState: false,
        canPersistData: false,
        canCallBackend: false
      },
      { strictUserVisibleOutput: true },
      'complex',
      { effort: 'low' },
      runtimeBudget,
      30_000
    );

    const complexReasoningCall = runStructuredReasoningMock.mock.calls[0];
    expect(complexReasoningCall?.[4]).toBeLessThanOrEqual(20_000);
    expect(complexReasoningCall?.[4]).toBeGreaterThan(0);
    expect(complexReasoningCall?.[4]).toBeGreaterThan(6_000);
  });

  it('uses the compact structured reasoning schema for simple-tier requests', async () => {
    runStructuredReasoningMock.mockResolvedValue({
      response_mode: 'answer',
      achievable_subtasks: ['answer'],
      blocked_subtasks: [],
      user_visible_caveats: [],
      claim_tags: [],
      final_answer: 'final'
    });

    const runtimeBudget = createRuntimeBudgetWithLimit(20_000, 0);

    const result = await runReasoningStage(
      {} as never,
      'Framed request',
      {
        canBrowse: false,
        canVerifyProvidedData: false,
        canVerifyLiveData: false,
        canConfirmExternalState: false,
        canPersistData: false,
        canCallBackend: false
      },
      { strictUserVisibleOutput: true },
      'simple',
      { effort: 'none' },
      runtimeBudget
    );

    const simpleReasoningCall = runStructuredReasoningMock.mock.calls[0];
    expect(runStructuredReasoningMock).toHaveBeenCalledWith(
      expect.anything(),
      'gpt-5.6-terra',
      expect.any(String),
      runtimeBudget,
      expect.any(Number),
      expect.objectContaining({
        schemaVariant: 'compact',
        reasoningEffort: 'none',
        maxOutputTokens: 8000,
        onUsage: expect.any(Function)
      })
    );
    expect(simpleReasoningCall?.[4]).toBeLessThanOrEqual(20000);
    expect(simpleReasoningCall?.[4]).toBeGreaterThan(0);
    expect(result.output).toBe('final');
    expect(result.reasoningLedger?.steps).toEqual([]);
    expect(result.reasoningLedger?.justification).toBe('');
  });

  it('uses medium effort for critical requests and never exceeds the reasoning output ceiling', async () => {
    process.env.TRINITY_REASONING_MAX_OUTPUT_TOKENS = '12000';
    runStructuredReasoningMock.mockResolvedValue({
      reasoning_steps: ['step'],
      assumptions: [],
      constraints: [],
      tradeoffs: [],
      alternatives_considered: [],
      chosen_path_justification: 'because',
      response_mode: 'answer',
      achievable_subtasks: ['answer'],
      blocked_subtasks: [],
      user_visible_caveats: [],
      claim_tags: [],
      final_answer: 'final'
    });

    await runReasoningStage(
      {} as never,
      'Framed request',
      {
        canBrowse: false,
        canVerifyProvidedData: false,
        canVerifyLiveData: false,
        canConfirmExternalState: false,
        canPersistData: false,
        canCallBackend: false
      },
      { strictUserVisibleOutput: true },
      'critical',
      { effort: 'medium' },
      createRuntimeBudgetWithLimit(20_000, 0)
    );

    expect(runStructuredReasoningMock).toHaveBeenCalledWith(
      expect.anything(),
      'gpt-5.6-terra',
      expect.any(String),
      expect.anything(),
      expect.any(Number),
      expect.objectContaining({
        schemaVariant: 'full',
        reasoningEffort: 'medium',
        maxOutputTokens: 8000
      })
    );
  });
});
