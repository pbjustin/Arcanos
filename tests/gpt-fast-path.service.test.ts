import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const runTrinityWritingPipelineMock = jest.fn();
const getOpenAIClientOrAdapterMock = jest.fn();
const recordAiOperationMock = jest.fn();

jest.unstable_mockModule('@arcanos/runtime', () => ({
  createAbortError: jest.fn((message: string) => new Error(message)),
  getRequestAbortSignal: jest.fn(() => undefined),
  runWithRequestAbortTimeout: jest.fn(async (_options: unknown, fn: () => Promise<unknown>) => fn()),
}));

jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({
  runTrinityWritingPipeline: runTrinityWritingPipelineMock,
}));

jest.unstable_mockModule('../src/services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: getOpenAIClientOrAdapterMock,
}));

jest.unstable_mockModule('../src/platform/observability/appMetrics.js', () => ({
  recordAiOperation: recordAiOperationMock,
}));

const { executeDirectGptAction, executeFastGptPrompt } = await import('../src/services/gptFastPath.js');

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

function buildTrinityResult(result = 'Generated prompt text') {
  return {
    result,
    module: 'trinity',
    activeModel: 'trinity-model',
    fallbackFlag: false,
    routingStages: ['TRINITY'],
    auditSafe: { mode: 'true', passed: true, flags: [] },
    taskLineage: [],
    fallbackSummary: {
      intakeFallbackUsed: false,
      gpt5FallbackUsed: false,
      finalFallbackUsed: false,
      fallbackReasons: [],
    },
    meta: {
      tokens: {
        prompt_tokens: 5,
        completion_tokens: 7,
        total_tokens: 12,
      },
      pipeline: 'trinity',
      bypass: false,
      sourceEndpoint: 'test',
      classification: 'writing',
    },
  };
}

describe('executeFastGptPrompt', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getOpenAIClientOrAdapterMock.mockReturnValue({ client: { responses: {} } });
    runTrinityWritingPipelineMock.mockResolvedValue(buildTrinityResult());
  });

  it('routes simple fast-path prompts through Trinity', async () => {
    const result = await executeFastGptPrompt({
      gptId: 'arcanos-core',
      prompt: 'Generate a prompt for a launch email.',
      timeoutMs: 8_000,
      routeDecision: buildDecision(),
    });

    expect(runTrinityWritingPipelineMock).toHaveBeenCalledWith({
      input: expect.objectContaining({
        prompt: 'Generate a prompt for a launch email.',
        gptId: 'arcanos-core',
        moduleId: 'GPT:FAST_PATH',
        sourceEndpoint: 'gpt.fast_path',
        requestedAction: 'query',
      }),
      context: expect.objectContaining({
        client: expect.anything(),
        runOptions: expect.objectContaining({
          answerMode: 'direct',
          strictUserVisibleOutput: true,
          watchdogModelTimeoutMs: 8_000,
        }),
      }),
    });
    expect(result.result.activeModel).toBe('trinity-model');
    expect(result.result.fastPath).toMatchObject({
      trinityRequired: true,
      orchestrationBypassed: false,
      queueBypassed: true,
    });
    expect(recordAiOperationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'trinity.pipeline',
        sourceType: 'gpt_fast_path',
        model: 'trinity-model',
        outcome: 'ok',
      })
    );
  });

  it('executes query_and_wait direct actions through Trinity', async () => {
    const result = await executeDirectGptAction({
      gptId: 'arcanos-core',
      prompt: 'Summarize deployment health.',
      action: 'query_and_wait',
      timeoutMs: 24_000,
      requestId: 'req-direct-action',
    });

    expect(runTrinityWritingPipelineMock).toHaveBeenCalledWith({
      input: expect.objectContaining({
        prompt: 'Summarize deployment health.',
        gptId: 'arcanos-core',
        moduleId: 'GPT:DIRECT_ACTION',
        sourceEndpoint: 'gpt.direct_action',
        requestedAction: 'query_and_wait',
      }),
      context: expect.objectContaining({
        requestId: 'req-direct-action',
        runOptions: expect.objectContaining({
          answerMode: 'direct',
          watchdogModelTimeoutMs: 24_000,
        }),
      }),
    });
    expect(result).toMatchObject({
      ok: true,
      result: {
        result: 'Generated prompt text',
        activeModel: 'trinity-model',
        fallbackFlag: false,
        directAction: {
          trinityRequired: true,
          orchestrationBypassed: false,
          action: 'query_and_wait',
        },
      },
      directAction: {
        inline: true,
        queueBypassed: true,
        orchestrationBypassed: false,
        action: 'query_and_wait',
        timeoutMs: 24_000,
      },
      _route: {
        gptId: 'arcanos-core',
        module: 'GPT:DIRECT_ACTION',
        action: 'query_and_wait',
        route: 'direct_action',
      },
    });
    expect(recordAiOperationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'trinity.pipeline',
        sourceType: 'gpt_direct_action',
        model: 'trinity-model',
        outcome: 'ok',
      })
    );
  });
});
