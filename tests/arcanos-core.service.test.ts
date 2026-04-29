import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRunTrinityWritingPipeline = jest.fn();
const mockGenerateMockResponse = jest.fn();
const mockGetOpenAIClientOrAdapter = jest.fn();
const mockCreateRuntimeBudget = jest.fn();
const loggerInfoMock = jest.fn();
const loggerErrorMock = jest.fn();
const runWithRequestAbortTimeoutMock = jest.fn(async (_config: unknown, operation: () => Promise<unknown>) => operation());
const getRequestRemainingMsMock = jest.fn(() => null);
const getRequestAbortContextMock = jest.fn(() => null);

jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({
  runTrinityWritingPipeline: mockRunTrinityWritingPipeline,
  applyTrinityGenerationInvariant: (result: any, params: any) => ({
    ...result,
    meta: {
      ...(result.meta ?? {}),
      pipeline: 'trinity',
      bypass: false,
      sourceEndpoint: params.sourceEndpoint,
      classification: 'writing'
    }
  }),
}));

jest.unstable_mockModule('@services/openai.js', () => ({
  generateMockResponse: mockGenerateMockResponse,
}));

jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: mockGetOpenAIClientOrAdapter,
}));

jest.unstable_mockModule('@platform/resilience/runtimeBudget.js', () => ({
  createRuntimeBudgetWithLimit: mockCreateRuntimeBudget,
  getSafeRemainingMs: jest.fn(() => 36_750),
}));

jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
  aiLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  },
  logger: {
    info: loggerInfoMock,
    warn: jest.fn(),
    error: loggerErrorMock
  }
}));

jest.unstable_mockModule('@arcanos/runtime', () => ({
  getRequestAbortSignal: jest.fn(() => undefined),
  getRequestAbortContext: getRequestAbortContextMock,
  getRequestRemainingMs: getRequestRemainingMsMock,
  isAbortError: jest.fn(() => false),
  runWithRequestAbortTimeout: runWithRequestAbortTimeoutMock
}));

const { ArcanosCore } = await import('../src/services/arcanos-core.js');

describe('ARCANOS:CORE service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ARCANOS_CORE_HANDLER_TIMEOUT_MS;
    delete process.env.ARCANOS_CORE_PIPELINE_TIMEOUT_MS;
    getRequestRemainingMsMock.mockReturnValue(null);
    getRequestAbortContextMock.mockReturnValue(null);
    mockCreateRuntimeBudget.mockReturnValue({ budget: 'runtime' });
  });

  it('routes query requests through Trinity with the core source endpoint', async () => {
    const client = { id: 'openai-client' };
    const trinityResult = { result: 'core-response' };

    mockGetOpenAIClientOrAdapter.mockReturnValue({ client });
    getRequestAbortContextMock.mockReturnValue({ requestId: 'req-core-1' });
    mockRunTrinityWritingPipeline.mockResolvedValue(trinityResult);

    const result = await ArcanosCore.actions.query({
      prompt: 'Explain the main pipeline.',
      sessionId: 'sess-core-1',
      overrideAuditSafe: 'allow',
      answerMode: 'direct',
      max_words: 42,
    });

    expect(mockRunTrinityWritingPipeline).toHaveBeenCalledWith({
      input: expect.objectContaining({
        prompt: 'Explain the main pipeline.',
        sessionId: 'sess-core-1',
        overrideAuditSafe: 'allow',
        sourceEndpoint: 'gpt.arcanos-core.query',
        moduleId: 'ARCANOS:CORE',
        requestedAction: 'query',
        executionMode: 'request',
        body: expect.objectContaining({ prompt: 'Explain the main pipeline.' })
      }),
      context: expect.objectContaining({
        client,
        requestId: 'req-core-1',
        runtimeBudget: { budget: 'runtime' },
        runOptions: expect.objectContaining({
          answerMode: 'direct',
          maxWords: 42,
        })
      })
    });
    expect(runWithRequestAbortTimeoutMock).toHaveBeenCalledTimes(1);
    expect(runWithRequestAbortTimeoutMock).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 37_000,
        abortMessage: 'ARCANOS:CORE pipeline timeout after 37000ms'
      }),
      expect.any(Function)
    );
    expect(mockCreateRuntimeBudget).toHaveBeenCalledWith(37_000, 250);
    expect(loggerInfoMock).toHaveBeenCalledWith(
      '[core] handler.start',
      expect.objectContaining({
        sourceEndpoint: 'gpt.arcanos-core.query',
        timeoutMs: 37_000,
        totalTimeoutMs: 45_000,
        degradedTimeoutMs: 8_000
      })
    );
    expect(result).toBe(trinityResult);
  });

  it('keeps the default handler timeout aligned with the route budget instead of aborting after five seconds', async () => {
    const client = { id: 'openai-client' };
    mockGetOpenAIClientOrAdapter.mockReturnValue({ client });
    getRequestAbortContextMock.mockReturnValue({ requestId: 'req-core-default-1' });
    mockRunTrinityWritingPipeline.mockResolvedValue({ result: 'core-response' });
    getRequestRemainingMsMock.mockReturnValue(60_000);

    await ArcanosCore.actions.query({
      prompt: 'Reply with exactly OK.'
    });

    expect(runWithRequestAbortTimeoutMock).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 37_000
      }),
      expect.any(Function)
    );
  });

  it('falls back to a mock response when the OpenAI client is unavailable', async () => {
    mockGetOpenAIClientOrAdapter.mockReturnValue({ client: null });
    mockGenerateMockResponse.mockReturnValue({ result: 'mock-core-response' });

    const result = await ArcanosCore.actions.query({
      prompt: 'Health check.',
    });

    expect(mockRunTrinityWritingPipeline).not.toHaveBeenCalled();
    expect(mockGenerateMockResponse).toHaveBeenCalledWith('Health check.', 'gpt/arcanos-core');
    expect(result).toEqual({ result: 'mock-core-response' });
  });

  it('uses background budgets only when the caller explicitly requests background execution', async () => {
    const client = { id: 'openai-client' };
    mockGetOpenAIClientOrAdapter.mockReturnValue({ client });
    mockRunTrinityWritingPipeline.mockResolvedValue({ result: 'background-core-response' });
    getRequestRemainingMsMock.mockReturnValue(null);
    getRequestAbortContextMock.mockReturnValue({ requestId: 'req-core-background-1' });

    await ArcanosCore.actions.query({
      prompt: 'Process this in worker mode.',
      __arcanosExecutionMode: 'background'
    });

    expect(runWithRequestAbortTimeoutMock).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 110_000,
        abortMessage: 'ARCANOS:CORE pipeline timeout after 110000ms'
      }),
      expect.any(Function)
    );
    expect(mockCreateRuntimeBudget).toHaveBeenCalledWith(110_000, 250);
    expect(mockRunTrinityWritingPipeline).toHaveBeenCalledWith({
      input: expect.objectContaining({
        prompt: 'Process this in worker mode.',
        sessionId: undefined,
        overrideAuditSafe: undefined,
        sourceEndpoint: 'gpt.arcanos-core.query',
        moduleId: 'ARCANOS:CORE',
        requestedAction: 'query',
        executionMode: 'background',
        background: { reason: 'arcanos_core_background' },
        body: expect.objectContaining({ prompt: 'Process this in worker mode.' })
      }),
      context: expect.objectContaining({
        client,
        requestId: 'req-core-background-1',
        runtimeBudget: { budget: 'runtime' },
        runOptions: expect.objectContaining({
          watchdogModelTimeoutMs: 110_000
        })
      })
    });
    expect(loggerInfoMock).toHaveBeenCalledWith(
      '[core] handler.start',
      expect.objectContaining({
        executionMode: 'background',
        timeoutMs: 110_000,
        watchdogModelTimeoutMs: 110_000
      })
    );
  });
});
