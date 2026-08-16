import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const createSingleChatCompletionMock = jest.fn();
const getTokenParameterMock = jest.fn();
const loggerInfoMock = jest.fn();
const loggerWarnMock = jest.fn();

jest.unstable_mockModule('@services/openai/credentialProvider.js', () => ({
  getDefaultModel: () => 'ft:test-default',
  getGPT5Model: () => 'gpt-5.1',
  getComplexModel: () => 'ft:test-complex',
  getFallbackModel: () => 'gpt-4.1'
}));

jest.unstable_mockModule('@services/openai/chatFallbacks.js', () => ({
  createSingleChatCompletion: createSingleChatCompletionMock,
}));

jest.unstable_mockModule('@services/openai/structuredReasoning.js', () => ({
  runStructuredReasoning: jest.fn()
}));

jest.unstable_mockModule('@shared/tokenParameterHelper.js', () => ({
  getTokenParameter: getTokenParameterMock
}));

jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
  aiLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  },
  logger: {
    info: loggerInfoMock,
    warn: loggerWarnMock,
    error: jest.fn(),
    child: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    })
  }
}));

const { runDirectAnswerStage } = await import('../src/core/logic/trinityStages.js');
const { createRuntimeBudgetWithLimit } = await import('../src/platform/resilience/runtimeBudget.js');

describe('runDirectAnswerStage', () => {
  beforeEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    delete process.env.TRINITY_DIRECT_ANSWER_STAGE_TIMEOUT_MS;
    getTokenParameterMock.mockReturnValue({ max_completion_tokens: 320 });
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.TRINITY_DIRECT_ANSWER_STAGE_TIMEOUT_MS;
  });

  it('uses the stable fallback model for direct-answer prompts', async () => {
    createSingleChatCompletionMock.mockResolvedValue({
      choices: [{ message: { content: 'Mutexes guard shared state.' } }],
      activeModel: 'gpt-4.1',
      fallbackFlag: false,
      usage: { total_tokens: 42 },
      id: 'resp_direct_answer',
      created: 123
    });

    const result = await runDirectAnswerStage(
      {} as never,
      'No relevant memory context is available.',
      'What is a mutex?',
      undefined,
      undefined,
      'trinity_req_direct_answer'
    );

    expect(createSingleChatCompletionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        model: 'gpt-4.1',
        max_completion_tokens: 320
      })
    );
    expect(result).toMatchObject({
      output: 'Mutexes guard shared state.',
      activeModel: 'gpt-4.1',
      fallbackUsed: false
    });
    expect(loggerInfoMock).toHaveBeenCalledWith(
      'trinity.direct_answer.execution_plan',
      expect.objectContaining({
        requestId: 'trinity_req_direct_answer',
        model: 'gpt-4.1'
      })
    );
  });

  it('honors explicit direct-answer provider overrides and timeout at the provider boundary', async () => {
    getTokenParameterMock.mockImplementation((_model: string, tokenLimit: number) => ({
      max_completion_tokens: tokenLimit
    }));
    createSingleChatCompletionMock.mockResolvedValue({
      choices: [{ message: { content: 'Expanded booking output.' }, finish_reason: 'stop' }],
      activeModel: 'gpt-5.1',
      fallbackFlag: false,
      usage: { total_tokens: 142 },
      id: 'resp_direct_answer_override',
      created: 123
    });

    await runDirectAnswerStage(
      {} as never,
      'No relevant memory context is available.',
      'Build a complete wrestling show.',
      undefined,
      undefined,
      'trinity_req_direct_answer_override',
      'gpt-5.1',
      1200,
      4_321
    );

    expect(getTokenParameterMock).toHaveBeenCalledWith('gpt-5.1', 1200);
    expect(createSingleChatCompletionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        model: 'gpt-5.1',
        max_completion_tokens: 1200,
        reasoning_effort: 'none',
        timeoutMs: 4_321
      })
    );
    expect(loggerInfoMock).toHaveBeenCalledWith(
      'trinity.direct_answer.execution_plan',
      expect.objectContaining({
        model: 'gpt-5.1',
        tokenLimit: 1200,
        timeoutMs: 4_321
      })
    );
  });

  it('disables reasoning for the configured GPT-5.6 Terra direct-answer model', async () => {
    getTokenParameterMock.mockImplementation((_model: string, tokenLimit: number) => ({
      max_completion_tokens: tokenLimit
    }));
    createSingleChatCompletionMock.mockResolvedValue({
      choices: [{ message: { content: 'Complete Terra booking output.' }, finish_reason: 'stop' }],
      activeModel: 'gpt-5.6-terra',
      fallbackFlag: false
    });

    await runDirectAnswerStage(
      {} as never,
      'No relevant memory context is available.',
      'Build five short booking bullets.',
      undefined,
      undefined,
      'trinity_req_direct_answer_terra',
      'gpt-5.6-terra',
      240
    );

    expect(createSingleChatCompletionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        model: 'gpt-5.6-terra',
        reasoning_effort: 'none',
        max_completion_tokens: 240
      })
    );
  });

  it.each(['gpt-5', 'gpt-5.6-pro', 'custom-booker-model'])(
    'does not send an unsupported reasoning override for %s',
    async (model) => {
      createSingleChatCompletionMock.mockResolvedValue({
        choices: [{ message: { content: 'Complete booking output.' }, finish_reason: 'stop' }],
        activeModel: model,
        fallbackFlag: false
      });

      await runDirectAnswerStage(
        {} as never,
        'No relevant memory context is available.',
        'Build a complete wrestling show.',
        undefined,
        undefined,
        'trinity_req_direct_answer_unclassified',
        model,
        1200
      );

      const providerParams = createSingleChatCompletionMock.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(providerParams).not.toHaveProperty('reasoning_effort');
    }
  );

  it('derives truncation flags from provider finish_reason length', async () => {
    createSingleChatCompletionMock.mockResolvedValue({
      choices: [{ message: { content: 'Partial answer' }, finish_reason: 'length' }],
      activeModel: 'gpt-4.1',
      fallbackFlag: false,
      usage: { total_tokens: 42 },
      id: 'resp_direct_answer_length',
      created: 123
    });

    const result = await runDirectAnswerStage(
      {} as never,
      'No relevant memory context is available.',
      'Write a guide.',
      undefined,
      undefined,
      'trinity_req_direct_answer_length'
    );

    expect(result.provider).toEqual(expect.objectContaining({
      finishReason: 'length',
      truncated: true,
      lengthTruncated: true
    }));
  });

  it.each(['   ', '...', '\u034f', '\u061c', '\u200b', '\u202e', '\u2060', '\ufe0f', '\ufeff'])(
    'records raw blank or invisible provider output before downstream translation',
    async (providerOutput) => {
      createSingleChatCompletionMock.mockResolvedValue({
        choices: [{ message: { content: providerOutput }, finish_reason: 'stop' }],
        activeModel: 'gpt-4.1',
        fallbackFlag: false,
        usage: { total_tokens: 42 },
        id: 'resp_direct_answer_empty',
        created: 123
      });

      const result = await runDirectAnswerStage(
        {} as never,
        'No relevant memory context is available.',
        'Write a guide.',
        undefined,
        undefined,
        'trinity_req_direct_answer_empty'
      );

      expect(result.provider?.emptyOutput).toBe(true);
    }
  );

  it('fails fast when the direct-answer stage exceeds the bounded stage timeout', async () => {
    process.env.TRINITY_DIRECT_ANSWER_STAGE_TIMEOUT_MS = '25';
    jest.useFakeTimers();

    createSingleChatCompletionMock.mockImplementation(
      () => new Promise(() => undefined)
    );

    const runtimeBudget = createRuntimeBudgetWithLimit(1_000, 0);
    const resultPromise = runDirectAnswerStage(
      {} as never,
      'No relevant memory context is available.',
      'What is a mutex?',
      undefined,
      runtimeBudget,
      'trinity_req_timeout'
    );
    const rejectionExpectation = expect(resultPromise).rejects.toThrow(
      'Trinity direct-answer stage timed out after 25ms using gpt-4.1.'
    );

    await jest.advanceTimersByTimeAsync(60);

    await rejectionExpectation;
    expect(loggerWarnMock).toHaveBeenCalledWith(
      'trinity.direct_answer.stage_timeout',
      expect.objectContaining({
        requestId: 'trinity_req_timeout',
        model: 'gpt-4.1',
        timeoutMs: 25
      })
    );
  });
});
