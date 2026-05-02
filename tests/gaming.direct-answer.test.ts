import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockResponsesCreate = jest.fn();
const mockGetOpenAIClientOrAdapter = jest.fn();
const mockGetPrompt = jest.fn((_section: string, key: string) => `${key}-prompt`);
const mockGetDefaultModel = jest.fn();
const mockGetGPT5Model = jest.fn();
const mockGenerateMockResponse = jest.fn();
const mockFetchAndClean = jest.fn();
const mockGetEnv = jest.fn();
const mockGetEnvNumber = jest.fn();
const mockGetEnvIntegerAtLeast = jest.fn();
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
  getEnvIntegerAtLeast: mockGetEnvIntegerAtLeast,
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
    mockGetEnvIntegerAtLeast.mockReturnValue(512);
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

  it('deduplicates guide URLs and uses the configured gaming context size', async () => {
    await runGuidePipeline({
      prompt: 'Use the linked guides for a direct boss strategy.',
      guideUrl: 'https://example.com/guide-a',
      guideUrls: ['https://example.com/guide-a', 'https://example.com/guide-b'],
      auditEnabled: false
    });

    expect(mockFetchAndClean).toHaveBeenNthCalledWith(1, 'https://example.com/guide-a', 512);
    expect(mockFetchAndClean).toHaveBeenNthCalledWith(2, 'https://example.com/guide-b', 512);
    expect(mockFetchAndClean).toHaveBeenCalledTimes(2);
    expect(mockRunTrinityWritingPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          prompt: expect.stringContaining('[Source 1] https://example.com/guide-a')
        })
      })
    );
  });

  it('preserves source ordering when guide fetches resolve out of order', async () => {
    mockFetchAndClean.mockImplementation(async (url: string) => {
      if (url.endsWith('/slow')) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return `snippet for ${url}`;
    });

    const result = await runGuidePipeline({
      prompt: 'Use both linked guides for a direct answer.',
      guideUrl: 'https://example.com/slow',
      guideUrls: ['https://example.com/fast'],
      auditEnabled: false
    });

    expect(result.data.sources).toEqual([
      {
        url: 'https://example.com/slow',
        snippet: 'snippet for https://example.com/slow'
      },
      {
        url: 'https://example.com/fast',
        snippet: 'snippet for https://example.com/fast'
      }
    ]);
    expect(mockRunTrinityWritingPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          prompt: expect.stringMatching(
            /\[Source 1\] https:\/\/example\.com\/slow[\s\S]*\[Source 2\] https:\/\/example\.com\/fast/
          )
        })
      })
    );
  });

  it('short-circuits exact-literal prompts before any provider call', async () => {
    const result = await runGuidePipeline({
      prompt: 'Answer directly. Do not simulate, role-play, or describe a hypothetical run. Say exactly: no-simulation.',
      guideUrls: ['https://example.com/guide'],
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
    expect(mockFetchAndClean).not.toHaveBeenCalled();
    expect(mockResponsesCreate).not.toHaveBeenCalled();
    expect(mockRunTrinityWritingPipeline).not.toHaveBeenCalled();
  });

  it('does not emit a misleading audit trace when audit is folded into the Trinity prompt', async () => {
    const result = await runGuidePipeline({
      prompt: 'Give a direct guide to defensive positioning.',
      guideUrls: [],
      auditEnabled: true
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      data: expect.not.objectContaining({
        auditTrace: expect.anything()
      })
    }));
    expect(mockRunTrinityWritingPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          prompt: expect.stringContaining('audit_system-prompt')
        })
      })
    );
  });
});
