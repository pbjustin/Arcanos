import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const createSingleChatCompletionMock = jest.fn();
const runStructuredReasoningMock = jest.fn();
const getTokenParameterMock = jest.fn();

jest.unstable_mockModule('@services/openai.js', () => ({
  getDefaultModel: () => 'ft:test-default',
  getGPT5Model: () => 'gpt-5.1',
  getComplexModel: () => 'ft:test-complex',
  getFallbackModel: () => 'gpt-4.1',
  createSingleChatCompletion: createSingleChatCompletionMock,
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
    delete process.env.TRINITY_FINAL_STAGE_TIMEOUT_MS;
    getTokenParameterMock.mockReturnValue({ max_completion_tokens: 320 });
  });

  afterEach(() => {
    delete process.env.TRINITY_INTAKE_STAGE_TIMEOUT_MS;
    delete process.env.TRINITY_REASONING_STAGE_TIMEOUT_MS;
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

  it('caps structured reasoning with an explicit stage timeout', async () => {
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
      runtimeBudget
    );

    expect(runStructuredReasoningMock).toHaveBeenCalledWith(
      expect.anything(),
      'gpt-5.1',
      expect.any(String),
      runtimeBudget,
      20000
    );
  });
});
