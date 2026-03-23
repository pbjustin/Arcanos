import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const createSingleChatCompletionMock = jest.fn();
const getTokenParameterMock = jest.fn();
const loggerInfoMock = jest.fn();
const loggerWarnMock = jest.fn();

jest.unstable_mockModule('@services/openai.js', () => ({
  getDefaultModel: () => 'ft:test-default',
  getGPT5Model: () => 'gpt-5.1',
  getComplexModel: () => 'ft:test-complex',
  getFallbackModel: () => 'gpt-4.1',
  createChatCompletionWithFallback: jest.fn(),
  createSingleChatCompletion: createSingleChatCompletionMock,
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

  it('fails fast when the direct-answer model call exceeds the stage timeout', async () => {
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

    await jest.advanceTimersByTimeAsync(30);

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
