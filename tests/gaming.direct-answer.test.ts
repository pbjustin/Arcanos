import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockResponsesCreate = jest.fn();
const mockGetOpenAIClientOrAdapter = jest.fn();
const mockGetPrompt = jest.fn();
const mockGetDefaultModel = jest.fn();
const mockGetGPT5Model = jest.fn();
const mockGenerateMockResponse = jest.fn();
const mockFetchAndClean = jest.fn();
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

jest.unstable_mockModule('@platform/runtime/prompts.js', () => ({
  getPrompt: mockGetPrompt
}));

jest.unstable_mockModule('@shared/webFetcher.js', () => ({
  fetchAndClean: mockFetchAndClean
}));

jest.unstable_mockModule('@platform/runtime/env.js', () => ({
  getEnv: mockGetEnv,
  getEnvNumber: mockGetEnvNumber
}));

const { runGaming } = await import('../src/services/gaming.js');

describe('gaming direct-answer hardening', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockGetEnv.mockReturnValue(undefined);
    mockGetEnvNumber.mockReturnValue(512);
    mockGetDefaultModel.mockReturnValue('ft:test-intake');
    mockGetGPT5Model.mockReturnValue('gpt-5.1-test');
    mockGenerateMockResponse.mockReturnValue({ result: 'mock guide result' });
    mockGetPrompt.mockImplementation((_section: string, key: string) => `${key}-prompt`);
    mockFetchAndClean.mockResolvedValue('clean snippet');
    mockGetOpenAIClientOrAdapter.mockReturnValue({
      adapter: {
        responses: {
          create: mockResponsesCreate
        }
      },
      client: null
    });
  });

  it('bypasses the hotline persona pipeline for anti-simulation prompts', async () => {
    mockResponsesCreate.mockResolvedValue({
      choices: [{ message: { content: 'Direct gameplay answer' } }]
    });

    const result = await runGaming(
      'Answer directly. Do not simulate, role-play, or describe a hypothetical run. How do I beat the temple boss?'
    );

    expect(result.gaming_response).toBe('Direct gameplay answer');
    expect(result.audit_trace.intake).toBe('[DIRECT_ANSWER] Persona pipeline bypassed.');
    expect(mockResponsesCreate).toHaveBeenCalledTimes(1);
    expect(mockResponsesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.1-test',
        temperature: 0.2,
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining('Do not simulate hotline dialogue')
          })
        ])
      })
    );
  });

  it('short-circuits exact-literal prompts before any provider call', async () => {
    const result = await runGaming(
      'Answer directly. Do not simulate, role-play, or describe a hypothetical run. Say exactly: no-simulation.'
    );

    expect(result).toEqual({
      gaming_response: 'no-simulation',
      audit_trace: {
        intake: '[SHORTCUT] Exact literal gaming shortcut matched.',
        reasoning: '[SHORTCUT] Model reasoning bypassed.',
        finalized: 'no-simulation'
      },
      sources: []
    });
    expect(mockResponsesCreate).not.toHaveBeenCalled();
  });
});
