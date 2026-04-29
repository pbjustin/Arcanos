import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRunTrinityWritingPipeline = jest.fn();
const mockGetOpenAIClientOrAdapter = jest.fn();
const mockGetDefaultModel = jest.fn();
const mockGetGPT5Model = jest.fn();
const mockGenerateMockResponse = jest.fn();
const mockSearchScholarly = jest.fn();
const mockGetEnv = jest.fn();
const mockGetEnvNumber = jest.fn();
const mockGetEnvBoolean = jest.fn();

jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: mockGetOpenAIClientOrAdapter
}));

jest.unstable_mockModule('@services/openai.js', () => ({
  getDefaultModel: mockGetDefaultModel,
  getGPT5Model: mockGetGPT5Model,
  generateMockResponse: mockGenerateMockResponse
}));

jest.unstable_mockModule('@services/scholarlyFetcher.js', () => ({
  searchScholarly: mockSearchScholarly
}));

jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({
  runTrinityWritingPipeline: mockRunTrinityWritingPipeline
}));

jest.unstable_mockModule('@platform/runtime/env.js', () => ({
  getEnv: mockGetEnv,
  getEnvNumber: mockGetEnvNumber,
  getEnvBoolean: mockGetEnvBoolean
}));

const { dispatch } = await import('../src/core/logic/tutor-logic.js');

describe('tutor logic prompt forwarding', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockGetEnv.mockReturnValue(undefined);
    mockGetEnvNumber.mockReturnValue(200);
    mockGetEnvBoolean.mockReturnValue(false);
    mockGetDefaultModel.mockReturnValue('ft:test-intake');
    mockGetGPT5Model.mockReturnValue('gpt-5.1');
    mockGenerateMockResponse.mockReturnValue({ result: 'mock tutor fallback' });
    mockSearchScholarly.mockResolvedValue([]);
    mockRunTrinityWritingPipeline.mockResolvedValue({
      result: 'final tutor answer',
      activeModel: 'trinity-tutor',
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
        sourceEndpoint: 'tutor.dispatch',
        classification: 'writing',
      },
    });
    mockGetOpenAIClientOrAdapter.mockReturnValue({
      client: { responses: {} }
    });
  });

  it('forwards top-level prompt aliases into the generic tutor payload', async () => {
    const directPrompt = 'Answer directly without role-play. Summarize the backend dispatcher flow.';

    const result = await dispatch({
      prompt: directPrompt
    });

    expect(result.arcanos_tutor).toBe('final tutor answer');
    expect(mockRunTrinityWritingPipeline).toHaveBeenCalledTimes(1);
    const trinityRequest = mockRunTrinityWritingPipeline.mock.calls[0][0] as {
      input: { prompt: string };
    };

    expect(trinityRequest.input.prompt).toContain(directPrompt);
    expect(trinityRequest.input.prompt).not.toContain('Input: {}');
  });

  it('short-circuits exact-literal anti-simulation prompts before model execution', async () => {
    const directPrompt =
      'Answer directly. Do not simulate, role-play, or describe a hypothetical run. Say exactly: live-response-check.';

    const result = await dispatch({
      prompt: directPrompt
    });

    expect(result.arcanos_tutor).toBe('live-response-check');
    expect(result.metadata).toEqual({
      shortcut: 'exact_literal_directive_suffix'
    });
    expect(mockRunTrinityWritingPipeline).not.toHaveBeenCalled();
  });
});
