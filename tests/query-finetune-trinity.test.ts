import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const runTrinityWritingPipelineMock = jest.fn();
const getOpenAIClientOrAdapterMock = jest.fn();
const createRuntimeBudgetMock = jest.fn(() => ({ remainingMs: () => 30_000 }));

jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({
  runTrinityWritingPipeline: runTrinityWritingPipelineMock
}));

jest.unstable_mockModule('../src/services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: getOpenAIClientOrAdapterMock
}));

jest.unstable_mockModule('../src/platform/resilience/runtimeBudget.js', () => ({
  createRuntimeBudget: createRuntimeBudgetMock
}));

const { runTrinity } = await import('../src/trinity/trinity.js');

function buildTrinityResult(overrides: Record<string, unknown> = {}) {
  return {
    result: '{"status":"ok"}',
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
      pipeline: 'trinity',
      bypass: false,
      sourceEndpoint: 'query-finetune',
      classification: 'writing',
    },
    ...overrides,
  };
}

describe('runTrinity fine-tuned route compatibility facade', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getOpenAIClientOrAdapterMock.mockReturnValue({ client: { responses: {} } });
    runTrinityWritingPipelineMock.mockResolvedValue(buildTrinityResult());
  });

  it('preserves structured JSON prompting while executing through Trinity', async () => {
    const result = await runTrinity({
      prompt: 'health check',
      model: 'ft:custom-model',
      structured: true
    });

    expect(runTrinityWritingPipelineMock).toHaveBeenCalledTimes(1);
    expect(runTrinityWritingPipelineMock).toHaveBeenCalledWith({
      input: expect.objectContaining({
        prompt: expect.stringMatching(/json/i),
        moduleId: 'QUERY:FINETUNE',
        sourceEndpoint: 'query-finetune',
        requestedAction: 'query',
        body: expect.objectContaining({
          prompt: 'health check',
          model: 'ft:custom-model',
          structured: true,
        }),
      }),
      context: expect.objectContaining({
        client: expect.anything(),
        runOptions: expect.objectContaining({
          answerMode: 'audit',
          strictUserVisibleOutput: true,
        }),
      }),
    });
    expect(result).toEqual(expect.objectContaining({
      requestedModel: 'ft:custom-model',
      model: 'trinity-model',
      activeModel: 'trinity-model',
      fallbackFlag: false,
      output: '{"status":"ok"}',
      raw: expect.objectContaining({
        meta: expect.objectContaining({
          pipeline: 'trinity',
          bypass: false,
        }),
      }),
    }));
  });

  it('passes latency budgets into Trinity watchdog options', async () => {
    await runTrinity({
      prompt: 'health check',
      model: 'ft:slow-model',
      structured: true,
      latencyBudgetMs: 25
    });

    expect(runTrinityWritingPipelineMock).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({
        runOptions: expect.objectContaining({
          watchdogModelTimeoutMs: 25
        })
      })
    }));
  });
});
