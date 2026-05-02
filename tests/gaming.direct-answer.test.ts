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

describe('gaming guide output hardening', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ARCANOS_GAMING_PIPELINE_TIMEOUT_MS;
    delete process.env.ARCANOS_GAMING_GUIDE_PIPELINE_TIMEOUT_MS;
    delete process.env.ARCANOS_GAMING_STAGE_TIMEOUT_MS;
    delete process.env.ARCANOS_GAMING_GUIDE_STAGE_TIMEOUT_MS;

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

  it('routes anti-simulation guide prompts without enabling the implicit direct-answer cap', async () => {
    mockResponsesCreate.mockResolvedValue({
      choices: [{ message: { content: 'Direct gameplay answer' } }]
    });

    const result = await runGuidePipeline({
      prompt: 'Answer directly. Do not simulate, no role-play, no hypothetical runs. How do I beat the temple boss?',
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
          prompt: expect.stringContaining('Avoid gameplay reenactment')
        }),
        context: expect.objectContaining({
          runOptions: expect.objectContaining({
            answerMode: 'explained',
            requestedVerbosity: 'detailed',
            strictUserVisibleOutput: true
          })
        })
      })
    );
    const trinityRequest = mockRunTrinityWritingPipeline.mock.calls[0][0] as { input: { prompt: string } };
    expect(trinityRequest.input.prompt).not.toContain('Answer directly');
    expect(trinityRequest.input.prompt).not.toContain('Do not simulate');
    expect(trinityRequest.input.prompt).toContain('avoid hypothetical run narration');
    expect(trinityRequest.input.prompt).not.toContain('avoid run narration narration');
  });

  it('keeps SWTOR guide requests on an uncapped guide output path', async () => {
    mockRunTrinityWritingPipeline.mockResolvedValueOnce({
      result: [
        '1. Set your role and discipline.',
        '2. Gear around your current item rating.',
        '3. Practice interrupts and defensive cooldowns.',
        '4. Use companions and travel unlocks to reduce downtime.'
      ].join('\n')
    });

    const result = await runGuidePipeline({
      prompt: 'Answer directly. Do not simulate. Give me a complete SWTOR guide for gearing, combat basics, and daily progression.',
      game: 'SWTOR',
      guideUrls: [],
      auditEnabled: false
    });

    expect(result.data.response).toContain('1. Set your role and discipline.');
    expect(mockRunTrinityWritingPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          runOptions: expect.objectContaining({
            answerMode: 'explained',
            requestedVerbosity: 'detailed',
            strictUserVisibleOutput: true
          })
        })
      })
    );
  });

  it('preserves the original SWTOR guide request as direct guide output without fallback splicing', async () => {
    const swtorGuide = [
      '1. Mechanics: face enemies away from the group and learn boss swap tells before they matter.',
      '2. Threat: open with high-threat tools, tab through packs, and save taunts for swaps or loose enemies.',
      '3. Mitigation: rotate cooldowns before spikes and keep defensive buffs active instead of panic-stacking everything.',
      '4. Positioning: hold enemies still, move early out of ground effects, and keep cleaves away from allies.',
      '5. Group play: communicate swaps, protect healers, mark priority targets, and ask damage dealers for a setup beat.'
    ].join('\n');
    mockRunTrinityWritingPipeline.mockResolvedValueOnce({ result: swtorGuide });

    const result = await runGuidePipeline({
      game: 'Star Wars: The Old Republic',
      prompt: 'Beginner to intermediate guide for tanking in Star Wars The Old Republic including mechanics, threat management, mitigation, positioning, and group play tips.',
      guideUrls: [],
      auditEnabled: false
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      mode: 'guide',
      data: {
        response: swtorGuide,
        sources: []
      }
    }));
    expect(result.data.response).not.toContain('bounded fallback response');
    expect(result.data.response).not.toContain('Retry with a narrower scope');
    expect(mockRunTrinityWritingPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          prompt: expect.stringContaining('Beginner to intermediate guide for tanking in Star Wars The Old Republic'),
          sourceEndpoint: 'arcanos-gaming.guide'
        }),
        context: expect.objectContaining({
          runOptions: expect.objectContaining({
            answerMode: 'explained',
            requestedVerbosity: 'detailed',
            strictUserVisibleOutput: true,
            watchdogModelTimeoutMs: 15_000
          })
        })
      })
    );
    expect(mockResponsesCreate).not.toHaveBeenCalled();
  });

  it('uses a bounded guide budget for the reported SWTOR regression prompt', async () => {
    const swtorGuide = [
      '1. Mechanics: learn swap cues, cleaves, interrupts, and avoidable ground effects before they hit the group.',
      '2. Threat: open decisively, tab through packs, and reserve taunts for swaps or enemies that peel away.',
      '3. Mitigation: rotate short cooldowns before spikes and keep class mitigation active instead of panic-stacking.',
      '4. Positioning: face enemies away, hold them still when possible, and move early when mechanics force movement.',
      '5. Group play: mark priorities, communicate defensive gaps, and protect healers during add waves.'
    ].join('\n');
    mockRunTrinityWritingPipeline.mockResolvedValueOnce({
      result: swtorGuide,
      activeModel: 'gpt-test',
      meta: { provider: { finishReason: 'stop' } }
    });

    const result = await runGuidePipeline({
      game: 'Star Wars: The Old Republic',
      prompt: 'Regression check only: Beginner to intermediate guide for tanking in Star Wars The Old Republic including mechanics, threat management, mitigation, positioning, and group play tips. Return a complete coherent answer with valid numbering.',
      guideUrls: [],
      auditEnabled: false
    });

    expect(result.data.response).toBe(swtorGuide);
    const trinityRequest = mockRunTrinityWritingPipeline.mock.calls[0][0] as {
      input: { prompt: string };
      context: {
        runtimeBudget: { watchdogLimit: number; safetyBuffer: number };
        runOptions: { watchdogModelTimeoutMs?: number };
      };
    };
    expect(trinityRequest.input.prompt).toContain('Regression check only');
    expect(trinityRequest.context.runtimeBudget).toEqual(expect.objectContaining({
      watchdogLimit: 50_000,
      safetyBuffer: 500
    }));
    expect(trinityRequest.context.runOptions).toEqual(expect.objectContaining({
      watchdogModelTimeoutMs: 15_000
    }));
  });

  it('passes a small guide smoke request through the bounded guide path', async () => {
    mockRunTrinityWritingPipeline.mockResolvedValueOnce({
      result: '1. Hold threat. 2. Face enemies away. 3. Use mitigation before spikes.',
      activeModel: 'gpt-test',
      meta: { provider: { finishReason: 'stop' } }
    });

    const result = await runGuidePipeline({
      game: 'Star Wars: The Old Republic',
      prompt: 'Smoke test: give three short tanking tips with valid numbering.',
      guideUrls: [],
      auditEnabled: false
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      mode: 'guide',
      data: expect.objectContaining({
        response: '1. Hold threat. 2. Face enemies away. 3. Use mitigation before spikes.'
      })
    }));
    expect(mockRunTrinityWritingPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          runOptions: expect.objectContaining({
            watchdogModelTimeoutMs: 15_000
          })
        })
      })
    );
  });

  it('converts a provider abort into a bounded gaming timeout error', async () => {
    const providerAbort = Object.assign(new Error('Request was aborted.'), {
      name: 'AbortError',
      timeoutPhase: 'intake'
    });
    mockRunTrinityWritingPipeline.mockRejectedValueOnce(providerAbort);

    await expect(runGuidePipeline({
      game: 'Star Wars: The Old Republic',
      prompt: 'Regression check only: Beginner to intermediate guide for tanking in Star Wars The Old Republic including mechanics, threat management, mitigation, positioning, and group play tips. Return a complete coherent answer with valid numbering.',
      guideUrls: [],
      auditEnabled: false
    })).rejects.toMatchObject({
      code: 'GAMING_PROVIDER_TIMEOUT',
      timeoutMs: 50_000,
      stageTimeoutMs: 15_000,
      timeoutPhase: 'intake'
    });
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
