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
const mockGetEnvBoolean = jest.fn();
const mockRunTrinityWritingPipeline = jest.fn();

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
  getEnvNumber: mockGetEnvNumber,
  getEnvBoolean: mockGetEnvBoolean
}));

jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({
  runTrinityWritingPipeline: mockRunTrinityWritingPipeline
}));

const { runGuidePipeline } = await import('../src/services/gaming.js');

describe('gaming direct-answer hardening', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockGetEnv.mockReturnValue(undefined);
    mockGetEnvNumber.mockReturnValue(512);
    mockGetEnvBoolean.mockReturnValue(false);
    mockGetDefaultModel.mockReturnValue('ft:test-intake');
    mockGetGPT5Model.mockReturnValue('gpt-5.1-test');
    mockGenerateMockResponse.mockReturnValue({ result: 'mock guide result' });
    mockGetPrompt.mockImplementation((_section: string, key: string) => `${key}-prompt`);
    mockFetchAndClean.mockResolvedValue('clean snippet');
    mockRunTrinityWritingPipeline.mockResolvedValue({ result: 'Direct gameplay answer' });
    mockGetOpenAIClientOrAdapter.mockReturnValue({
      adapter: {
        responses: {
          create: mockResponsesCreate
        }
      },
      client: {}
    });
  });

  it('bypasses the hotline persona pipeline for anti-simulation prompts', async () => {
    mockResponsesCreate.mockResolvedValue({
      choices: [{ message: { content: 'Direct gameplay answer' } }]
    });

    const result = await runGuidePipeline({
      prompt: 'Answer directly. Do not simulate, role-play, or describe a hypothetical run. How do I beat the temple boss?',
      guideUrls: [],
      auditEnabled: false
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      route: 'gaming',
      mode: 'guide',
      data: expect.objectContaining({
        response: 'Direct gameplay answer',
        sources: []
      })
    }));
    expect(mockResponsesCreate).not.toHaveBeenCalled();
    expect(mockRunTrinityWritingPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          moduleId: 'ARCANOS:GAMING',
          sourceEndpoint: 'arcanos-gaming.guide',
          requestedAction: 'query',
          prompt: expect.stringContaining('add hotline banter or theatrical framing')
        }),
        context: expect.objectContaining({
          runOptions: expect.objectContaining({
            answerMode: 'direct',
            strictUserVisibleOutput: true
          })
        })
      })
    );
  });

  it('short-circuits exact-literal prompts before any provider call', async () => {
    const result = await runGuidePipeline({
      prompt: 'Answer directly. Do not simulate, role-play, or describe a hypothetical run. Say exactly: no-simulation.',
      guideUrls: [],
      auditEnabled: false
    });

    expect(result).toEqual({
      ok: true,
      route: 'gaming',
      mode: 'guide',
      data: {
        response: 'no-simulation',
        sources: []
      }
    });
    expect(mockResponsesCreate).not.toHaveBeenCalled();
    expect(mockRunTrinityWritingPipeline).not.toHaveBeenCalled();
  });
});
