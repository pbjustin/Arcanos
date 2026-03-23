import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRunThroughBrain = jest.fn();
const mockGenerateMockResponse = jest.fn();
const mockGetOpenAIClientOrAdapter = jest.fn();
const mockCreateRuntimeBudget = jest.fn();

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

const { ArcanosCore } = await import('../src/services/arcanos-core.js');

describe('ARCANOS:CORE service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
    expect(result).toBe(trinityResult);
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
