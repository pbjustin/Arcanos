import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRunThroughBrain = jest.fn();
const mockGenerateMockResponse = jest.fn();
const mockGetOpenAIClientOrAdapter = jest.fn();
const mockCreateRuntimeBudget = jest.fn();
const loggerInfoMock = jest.fn();
const loggerErrorMock = jest.fn();
const runWithRequestAbortTimeoutMock = jest.fn(async (_config: unknown, operation: () => Promise<unknown>) => operation());
const getRequestRemainingMsMock = jest.fn(() => null);

jest.unstable_mockModule('@core/logic/trinity.js', () => ({
  runThroughBrain: mockRunThroughBrain,
}));

jest.unstable_mockModule('@services/openai.js', () => ({
  generateMockResponse: mockGenerateMockResponse,
}));

jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: mockGetOpenAIClientOrAdapter,
}));

jest.unstable_mockModule('@platform/resilience/runtimeBudget.js', () => ({
  createRuntimeBudget: mockCreateRuntimeBudget,
}));

jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
  logger: {
    info: loggerInfoMock,
    warn: jest.fn(),
    error: loggerErrorMock
  }
}));

jest.unstable_mockModule('@arcanos/runtime', () => ({
  getRequestAbortSignal: jest.fn(() => undefined),
  getRequestRemainingMs: getRequestRemainingMsMock,
  runWithRequestAbortTimeout: runWithRequestAbortTimeoutMock
}));

const { ArcanosCore } = await import('../src/services/arcanos-core.js');

describe('ARCANOS:CORE service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ARCANOS_CORE_HANDLER_TIMEOUT_MS;
    getRequestRemainingMsMock.mockReturnValue(null);
    mockCreateRuntimeBudget.mockReturnValue({ budget: 'runtime' });
  });

  it('routes query requests through Trinity with the core source endpoint', async () => {
    const client = { id: 'openai-client' };
    const trinityResult = { result: 'core-response' };

    mockGetOpenAIClientOrAdapter.mockReturnValue({ client });
    mockRunThroughBrain.mockResolvedValue(trinityResult);

    const result = await ArcanosCore.actions.query({
      prompt: 'Explain the main pipeline.',
      sessionId: 'sess-core-1',
      overrideAuditSafe: 'allow',
      answerMode: 'direct',
      max_words: 42,
    });

    expect(mockRunThroughBrain).toHaveBeenCalledWith(
      client,
      'Explain the main pipeline.',
      'sess-core-1',
      'allow',
      {
        sourceEndpoint: 'gpt.arcanos-core.query',
        answerMode: 'direct',
        maxWords: 42,
      },
      { budget: 'runtime' }
    );
    expect(runWithRequestAbortTimeoutMock).toHaveBeenCalledTimes(1);
    expect(runWithRequestAbortTimeoutMock).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 55_000,
        abortMessage: 'ARCANOS:CORE handler timed out after 55000ms'
      }),
      expect.any(Function)
    );
    expect(loggerInfoMock).toHaveBeenCalledWith(
      '[core] handler.start',
      expect.objectContaining({
        sourceEndpoint: 'gpt.arcanos-core.query'
      })
    );
    expect(result).toBe(trinityResult);
  });

  it('keeps the default handler timeout aligned with the route budget instead of aborting after five seconds', async () => {
    const client = { id: 'openai-client' };
    mockGetOpenAIClientOrAdapter.mockReturnValue({ client });
    mockRunThroughBrain.mockResolvedValue({ result: 'core-response' });
    getRequestRemainingMsMock.mockReturnValue(60_000);

    await ArcanosCore.actions.query({
      prompt: 'Reply with exactly OK.'
    });

    expect(runWithRequestAbortTimeoutMock).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 55_000
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

    expect(mockRunThroughBrain).not.toHaveBeenCalled();
    expect(mockGenerateMockResponse).toHaveBeenCalledWith('Health check.', 'gpt/arcanos-core');
    expect(result).toEqual({ result: 'mock-core-response' });
  });
});
