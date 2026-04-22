import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const callTextResponseMock = jest.fn();
const getOpenAIClientOrAdapterMock = jest.fn();
const recordAiOperationMock = jest.fn();

jest.unstable_mockModule('@arcanos/openai/responses', () => ({
  callTextResponse: callTextResponseMock,
}));

jest.unstable_mockModule('@arcanos/runtime', () => ({
  getRequestAbortSignal: jest.fn(() => undefined),
  runWithRequestAbortTimeout: jest.fn(async (_options: unknown, fn: () => Promise<unknown>) => fn()),
}));

jest.unstable_mockModule('../src/services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: getOpenAIClientOrAdapterMock,
}));

jest.unstable_mockModule('../src/platform/observability/appMetrics.js', () => ({
  recordAiOperation: recordAiOperationMock,
}));

const { executeFastGptPrompt } = await import('../src/services/gptFastPath.js');

function buildDecision(timeoutMs = 8_000) {
  return {
    path: 'fast_path' as const,
    eligible: true,
    reason: 'simple_prompt_generation',
    queueBypassed: true,
    promptLength: 38,
    messageCount: 0,
    maxWords: null,
    timeoutMs,
    action: null,
    promptGenerationIntent: true,
    explicitMode: null,
  };
}

describe('executeFastGptPrompt', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GPT_FAST_PATH_MODEL;
    getOpenAIClientOrAdapterMock.mockReturnValue({ client: { responses: {} } });
    callTextResponseMock.mockResolvedValue({
      response: {
        id: 'resp_fast_test',
        usage: {
          input_tokens: 5,
          output_tokens: 7,
          total_tokens: 12,
        },
      },
      outputText: 'Generated prompt text',
    });
  });

  it('uses the lightweight fast-path model by default', async () => {
    const result = await executeFastGptPrompt({
      gptId: 'arcanos-core',
      prompt: 'Generate a prompt for a launch email.',
      timeoutMs: 8_000,
      routeDecision: buildDecision(),
    });

    expect(callTextResponseMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        model: 'gpt-4.1-mini',
        store: false,
      }),
      expect.anything()
    );
    expect(result.result.activeModel).toBe('gpt-4.1-mini');
    expect(recordAiOperationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: 'gpt_fast_path',
        model: 'gpt-4.1-mini',
        outcome: 'ok',
      })
    );
  });

  it('honors GPT_FAST_PATH_MODEL when operators need a specific inline model', async () => {
    process.env.GPT_FAST_PATH_MODEL = 'gpt-fast-override';

    const result = await executeFastGptPrompt({
      gptId: 'arcanos-core',
      prompt: 'Generate a prompt for a launch email.',
      timeoutMs: 8_000,
      routeDecision: buildDecision(),
    });

    expect(callTextResponseMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ model: 'gpt-fast-override' }),
      expect.anything()
    );
    expect(result.result.activeModel).toBe('gpt-fast-override');
  });
});
