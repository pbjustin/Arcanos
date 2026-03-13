import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockResponsesCreate = jest.fn();
const mockGetOpenAIClientOrAdapter = jest.fn();
const mockGetDefaultModel = jest.fn();
const mockGetGPT5Model = jest.fn();
const mockGenerateMockResponse = jest.fn();
const mockSearchScholarly = jest.fn();
const mockGetEnv = jest.fn();
const mockGetEnvNumber = jest.fn();

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

jest.unstable_mockModule('@platform/runtime/env.js', () => ({
  getEnv: mockGetEnv,
  getEnvNumber: mockGetEnvNumber
}));

const { dispatch } = await import('../src/core/logic/tutor-logic.js');

describe('tutor logic prompt forwarding', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockGetEnv.mockReturnValue(undefined);
    mockGetEnvNumber.mockReturnValue(200);
    mockGetDefaultModel.mockReturnValue('ft:test-intake');
    mockGetGPT5Model.mockReturnValue('gpt-5.1');
    mockGenerateMockResponse.mockReturnValue({ result: 'mock tutor fallback' });
    mockSearchScholarly.mockResolvedValue([]);
    mockResponsesCreate
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'refined prompt' } }]
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'reasoning output' } }]
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'final tutor answer' } }]
      });
    mockGetOpenAIClientOrAdapter.mockReturnValue({
      adapter: {
        responses: {
          create: mockResponsesCreate
        }
      },
      client: null
    });
  });

  it('forwards top-level prompt aliases into the generic tutor payload', async () => {
    const directPrompt = 'Answer directly without role-play. Summarize the backend dispatcher flow.';

    const result = await dispatch({
      prompt: directPrompt
    });

    expect(result.arcanos_tutor).toBe('final tutor answer');
    expect(mockResponsesCreate).toHaveBeenCalledTimes(3);

    const intakeRequest = mockResponsesCreate.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
    };

    expect(intakeRequest.messages[1]?.content).toContain(directPrompt);
    expect(intakeRequest.messages[1]?.content).not.toContain('Input: {}');
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
    expect(mockResponsesCreate).not.toHaveBeenCalled();
  });
});
