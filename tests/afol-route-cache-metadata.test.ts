import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const runTrinityWritingPipelineMock = jest.fn();
const getOpenAIClientOrAdapterMock = jest.fn();
const recordTraceEventMock = jest.fn();
const createRuntimeBudgetMock = jest.fn(() => ({ budgetId: 'runtime-budget' }));

jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({
  runTrinityWritingPipeline: runTrinityWritingPipelineMock
}));

jest.unstable_mockModule('@services/openai.js', () => ({
  getDefaultModel: jest.fn(() => 'ft:primary-model'),
  getFallbackModel: jest.fn(() => 'ft:backup-model'),
  generateMockResponse: jest.fn(() => ({
    result: 'mock fallback',
    activeModel: 'mock'
  }))
}));

jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: getOpenAIClientOrAdapterMock
}));

jest.unstable_mockModule('@platform/logging/telemetry.js', () => ({
  recordTraceEvent: recordTraceEventMock,
  recordLogEvent: jest.fn()
}));

jest.unstable_mockModule('@platform/resilience/runtimeBudget.js', () => ({
  createRuntimeBudget: createRuntimeBudgetMock
}));

const { executeRoute } = await import('../src/core/afol/routes.js');

const cacheMetadataCases: Array<[string, Record<string, unknown>]> = [
  ['meta.cached', { cached: true }],
  ['meta.cacheHit', { cacheHit: true }],
  ['meta.cache.hit', { cache: { hit: true } }]
];

describe('AFOL route cache metadata', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getOpenAIClientOrAdapterMock.mockReturnValue({ client: { responses: {} } });
  });

  it.each(cacheMetadataCases)('reports Trinity %s as an AFOL cache hit', async (_label, meta) => {
    runTrinityWritingPipelineMock.mockResolvedValue({
      result: 'cached AFOL answer',
      activeModel: 'ft:primary-model',
      meta
    });

    const result = await executeRoute(
      { name: 'primary', reason: 'Primary healthy' },
      {
        prompt: 'Explain the cache status.',
        intent: 'cache-check'
      }
    );

    expect(result).toEqual({
      route: 'primary',
      input: 'Explain the cache status.',
      output: 'cached AFOL answer',
      model: 'ft:primary-model',
      cached: true,
      metadata: {
        routeReason: 'Primary healthy',
        intent: 'cache-check'
      }
    });
    expect(recordTraceEventMock).toHaveBeenCalledWith('afol.route.success', {
      route: 'primary',
      model: 'ft:primary-model',
      cached: true
    });
  });
});
