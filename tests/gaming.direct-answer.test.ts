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
const mockGetOptionalEnvIntegerAtLeast = jest.fn();
const mockGetEnvBoolean = jest.fn();
const mockRunTrinityWritingPipeline = jest.fn();
const DEFAULT_GUIDE_SNIPPET = 'Clean guide explains boss mechanics, route steps, and readable gameplay evidence.';

function expectFetchOptions(timeoutMs = 5000) {
  return expect.objectContaining({
    signal: expect.any(Object),
    timeoutMs
  });
}

function extractInlineSourceRefs(text: string): number[] {
  return Array.from(text.matchAll(/(?:\[(?:sources?)\s+([\d,\s]+)\]|\[([\d,\s]+)\]|\((?:sources?)\s+([\d,\s]+)\)|\b(?:sources?)\s+(\d+(?:\s*,\s*\d+)*))/gi))
    .flatMap((match) => [match[1], match[2], match[3], match[4]])
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .flatMap((value) => Array.from(value.matchAll(/\d+/g)).map((numberMatch) => Number.parseInt(numberMatch[0], 10)))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function expectInlineSourceRefsToMap(response: string, sourceCount: number): void {
  for (const sourceRef of extractInlineSourceRefs(response)) {
    expect(sourceRef).toBeGreaterThanOrEqual(1);
    expect(sourceRef).toBeLessThanOrEqual(sourceCount);
  }
}

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
  getOptionalEnvIntegerAtLeast: mockGetOptionalEnvIntegerAtLeast,
  getEnvBoolean: mockGetEnvBoolean
}));

jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({
  runTrinityWritingPipeline: mockRunTrinityWritingPipeline
}));

const { runBuildPipeline, runGuidePipeline, runMetaPipeline } = await import('../src/services/gaming.js');
const { buildGamingRagContext, clearGamingRagCache } = await import('../src/services/gamingWebContext.js');
const { runWithRequestAbortContext } = await import('@arcanos/runtime');
const { logger } = await import('@platform/logging/structuredLogging.js');

describe('gaming guide output hardening', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ARCANOS_GAMING_PIPELINE_TIMEOUT_MS;
    delete process.env.ARCANOS_GAMING_GUIDE_PIPELINE_TIMEOUT_MS;
    delete process.env.ARCANOS_GAMING_STAGE_TIMEOUT_MS;
    delete process.env.ARCANOS_GAMING_GUIDE_STAGE_TIMEOUT_MS;
    delete process.env.ARCANOS_GAMING_MODULE_TIMEOUT_MS;
    delete process.env.ARCANOS_GAMING_WEB_CONTEXT_CHARS;
    delete process.env.ARCANOS_GAMING_WEB_CONTEXT_MAX_URLS;
    delete process.env.ARCANOS_GAMING_WEB_CONTEXT_FETCH_TIMEOUT_MS;
    delete process.env.ARCANOS_GAMING_RAG_MAX_SOURCES;
    delete process.env.ARCANOS_GAMING_RAG_MAX_CHUNKS;
    delete process.env.ARCANOS_GAMING_RAG_CHUNK_CHARS;
    delete process.env.ARCANOS_GAMING_CURATED_SOURCES_JSON;

    mockGetEnv.mockImplementation((key: string, defaultValue?: string) => process.env[key] ?? defaultValue);
    mockGetEnvNumber.mockReturnValue(512);
    mockGetEnvIntegerAtLeast.mockImplementation((key: string, defaultValue: number, minValue: number) => {
      const rawValue = process.env[key];
      const parsed = rawValue === undefined
        ? key === 'ARCANOS_GAMING_WEB_CONTEXT_CHARS'
          ? 512
          : defaultValue
        : Number.parseInt(rawValue, 10);
      const value = Number.isFinite(parsed) ? Math.trunc(parsed) : Number.NaN;
      return Number.isFinite(value) && value >= minValue ? value : defaultValue;
    });
    mockGetOptionalEnvIntegerAtLeast.mockImplementation((key: string, minValue: number) => {
      const rawValue = process.env[key];
      if (rawValue === undefined) {
        return undefined;
      }
      const parsed = Number.parseInt(rawValue, 10);
      return Number.isFinite(parsed) && parsed >= minValue ? parsed : undefined;
    });
    mockGetEnvBoolean.mockReturnValue(false);
    mockGetDefaultModel.mockReturnValue('ft:test-intake');
    mockGetGPT5Model.mockReturnValue('gpt-5.1-test');
    mockGenerateMockResponse.mockReturnValue({ result: 'mock guide result' });
    mockGetPrompt.mockImplementation((_section: string, key: string) => `${key}-prompt`);
    mockFetchAndClean.mockResolvedValue(DEFAULT_GUIDE_SNIPPET);
    mockRunTrinityWritingPipeline.mockResolvedValue({ result: 'Direct gameplay answer' });
    mockGetOpenAIClientOrAdapter.mockReturnValue({
      adapter: {
        responses: {
          create: mockResponsesCreate
        }
      },
      client: {}
    });
    clearGamingRagCache();
  });

  it('routes anti-simulation guide prompts through compact direct guide mode', async () => {
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
            answerMode: 'direct',
            requestedVerbosity: 'normal',
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
    expect(trinityRequest.input.prompt).toContain('Return only a six-item checklist using hyphen bullets');
  });

  it('keeps SWTOR guide requests on the compact guide output path', async () => {
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
            answerMode: 'direct',
            requestedVerbosity: 'normal',
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
      data: expect.objectContaining({
        response: swtorGuide,
        sources: [
          { url: 'https://swtorista.com/articles/', snippet: DEFAULT_GUIDE_SNIPPET }
        ]
      })
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
            answerMode: 'direct',
            requestedVerbosity: 'normal',
            strictUserVisibleOutput: true,
            watchdogModelTimeoutMs: 50_000,
            modelStageTimeoutMs: 24_000
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
        runOptions: {
          answerMode?: string;
          requestedVerbosity?: string;
          watchdogModelTimeoutMs?: number;
          modelStageTimeoutMs?: number;
        };
      };
    };
    expect(trinityRequest.input.prompt).toContain('Regression check only');
    expect(trinityRequest.input.prompt).toContain('Return only a six-item checklist using hyphen bullets');
    expect(trinityRequest.context.runtimeBudget).toEqual(expect.objectContaining({
      watchdogLimit: 50_000,
      safetyBuffer: 500
    }));
    expect(trinityRequest.context.runOptions).toEqual(expect.objectContaining({
      answerMode: 'direct',
      requestedVerbosity: 'normal',
      watchdogModelTimeoutMs: 50_000,
      modelStageTimeoutMs: 24_000
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
            answerMode: 'direct',
            requestedVerbosity: 'normal',
            watchdogModelTimeoutMs: 50_000,
            modelStageTimeoutMs: 24_000
          })
        })
      })
    );
  });

  it('passes a broad Elden Ring guide lookup through the normal guide path', async () => {
    mockRunTrinityWritingPipeline.mockResolvedValueOnce({
      result: 'Follow the Limgrave route, upgrade one weapon, and delay Stormveil until you are prepared.',
      activeModel: 'gpt-test',
      meta: { provider: { finishReason: 'stop' } }
    });

    const result = await runGuidePipeline({
      game: 'Elden Ring',
      prompt: 'Look up a guide for Elden Ring.',
      guideUrls: [],
      auditEnabled: false
    });

    expect(result.data.response).toBe('Follow the Limgrave route, upgrade one weapon, and delay Stormveil until you are prepared.');
    expect(result.data.response).not.toContain('bounded deterministic fallback');
    const trinityRequest = mockRunTrinityWritingPipeline.mock.calls[0][0] as { input: { prompt: string } };
    expect(trinityRequest.input.prompt).toContain('[GAME]\nElden Ring');
    expect(trinityRequest.input.prompt).toContain('Look up a guide for Elden Ring.');
    expect(trinityRequest.input.prompt).toContain('Return only a six-item checklist using hyphen bullets');
  });

  it('passes a narrow Elden Ring progression guide through the normal guide path', async () => {
    mockRunTrinityWritingPipeline.mockResolvedValueOnce({
      result: 'Go to the Church of Elleh, then Gatefront Ruins for the map and Torrent unlock.',
      activeModel: 'gpt-test',
      meta: { provider: { finishReason: 'stop' } }
    });

    const result = await runGuidePipeline({
      game: 'Elden Ring',
      prompt: 'Where do I go first in Elden Ring after leaving the tutorial?',
      guideUrls: [],
      auditEnabled: false
    });

    expect(result.data.response).toBe('Go to the Church of Elleh, then Gatefront Ruins for the map and Torrent unlock.');
    expect(result.data.response).not.toContain('bounded deterministic fallback');
    const trinityRequest = mockRunTrinityWritingPipeline.mock.calls[0][0] as { input: { prompt: string } };
    expect(trinityRequest.input.prompt).toContain('Where do I go first in Elden Ring after leaving the tutorial?');
    expect(trinityRequest.input.prompt).toContain('Return only a six-item checklist using hyphen bullets');
  });

  it('returns a deterministic fallback when build provider generation is incomplete', async () => {
    const incompleteError = Object.assign(new Error('provider output incomplete'), {
      code: 'OPENAI_COMPLETION_INCOMPLETE',
      finishReason: 'length',
      incompleteReason: 'max_output_tokens'
    });
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    mockRunTrinityWritingPipeline.mockRejectedValueOnce(incompleteError);
    const controller = new AbortController();

    try {
      const result = await runWithRequestAbortContext({
        requestId: 'req-build-incomplete',
        controller,
        signal: controller.signal,
        deadlineAt: Date.now() + 60_000,
        timeoutMs: 60_000
      }, () => runBuildPipeline({
        game: 'Elden Ring',
        prompt: 'Make me a bleed build for Elden Ring.',
        guideUrls: [],
        auditEnabled: false
      }));

      expect(result.ok).toBe(true);
      expect(result.mode).toBe('build');
      expect(result.data.response).toContain('bounded deterministic fallback');
      expect(result.data.response).not.toContain('PROVIDER_COMPLETION_INCOMPLETE');
      expect(result.data.response).not.toMatch(/provider|incomplete|integrity|timeout/i);
      expect(result.data.response).toContain('For Elden Ring');
      const trinityRequest = mockRunTrinityWritingPipeline.mock.calls[0][0] as {
        input: { prompt: string };
        context: { runOptions: { answerMode?: string; requestedVerbosity?: string } };
      };
      expect(trinityRequest.input.prompt).toContain('Return only 5 short numbered bullets');
      expect(trinityRequest.context.runOptions).toEqual(expect.objectContaining({
        answerMode: 'direct',
        strictUserVisibleOutput: true
      }));
      expect(trinityRequest.context.runOptions).not.toHaveProperty('requestedVerbosity');
      expect(warnSpy).toHaveBeenCalledWith('gaming.provider.incomplete', expect.objectContaining({
        requestId: 'req-build-incomplete',
        traceId: 'req-build-incomplete',
        mode: 'build',
        game: 'Elden Ring',
        errorCode: 'OPENAI_COMPLETION_INCOMPLETE',
        fallbackReason: 'PROVIDER_COMPLETION_INCOMPLETE'
      }));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('passes a meta request with game through the normal path', async () => {
    mockFetchAndClean.mockResolvedValue(
      'World of Warcraft 11.2.7 Frost Mage current patch guide explains tuning, talents, rotation, and encounter tradeoffs. '
      + 'Players should verify current hotfixes before changing a competitive build.'
    );
    mockRunTrinityWritingPipeline.mockResolvedValueOnce({
      result: 'Frost Mage is viable when current tuning supports its control and cleave profile.',
      activeModel: 'gpt-test',
      meta: { provider: { finishReason: 'stop' } }
    });

    const result = await runMetaPipeline({
      game: 'World of Warcraft',
      prompt: 'Is frost mage still viable in World of Warcraft 11.2.7?',
      guideUrls: [],
      auditEnabled: false
    });

    expect(result.ok).toBe(true);
    expect(result.mode).toBe('meta');
    expect(result.data.response).toBe('Frost Mage is viable when current tuning supports its control and cleave profile.');
    expect(result.data.response).not.toContain('bounded deterministic fallback');
    const trinityRequest = mockRunTrinityWritingPipeline.mock.calls[0][0] as {
      input: { prompt: string };
      context: { runOptions: { answerMode?: string; strictUserVisibleOutput?: boolean } };
    };
    expect(trinityRequest.input.prompt).toContain('[MODE]\nmeta');
    expect(trinityRequest.input.prompt).toContain('[GAME]\nWorld of Warcraft');
    expect(trinityRequest.input.prompt).not.toContain('[OUTPUT]');
    expect(trinityRequest.input.prompt).not.toContain('Answer the request directly');
    expect(trinityRequest.context.runOptions).toEqual(expect.objectContaining({
      answerMode: 'explained',
      strictUserVisibleOutput: true
    }));
  });

  it.each([
    ['build', 'Caves of Qud Build', 'Caves of Qud'],
    ['meta', 'Broken Ranks Class Meta', 'Broken Ranks']
  ] as const)('resolves a missing %s game from a strong supplied-page metadata signal', async (mode, pageHeading, expectedGame) => {
    const url = `https://community.example/article/${mode}`;
    mockFetchAndClean.mockImplementation(async (_url: string, _maxChars: number, options?: { onExtraction?: (metrics: Record<string, unknown>) => void }) => {
      options?.onExtraction?.({
        strategy: 'article',
        selectedContainer: 'article',
        qualityScore: 0.9,
        navigationPenalty: 0.02,
        linkDensity: 0.01,
        candidateCount: 2,
        rawTextLength: 170,
        cleanedTextLength: 150,
        ...(mode === 'build' ? { documentTitle: pageHeading } : { headingText: pageHeading })
      });
      return `${expectedGame} ${mode} 1.0 evidence explains readable gameplay choices, priorities, tradeoffs, and current recommendations.`;
    });
    mockRunTrinityWritingPipeline.mockResolvedValueOnce({
      result: `Source-backed ${mode} response`,
      activeModel: 'gpt-test',
      meta: { provider: { finishReason: 'stop' } }
    });

    const pipeline = mode === 'build' ? runBuildPipeline : runMetaPipeline;
    const result = await pipeline({
      prompt: `Use the supplied article for this ${mode} request${mode === 'meta' ? ' (1.0)' : ''}.`,
      guideUrl: url,
      guideUrls: [],
      auditEnabled: false
    });

    expect(result.ok).toBe(true);
    expect(result.data.sources).toEqual([expect.objectContaining({ url })]);
    const trinityRequest = mockRunTrinityWritingPipeline.mock.calls[0][0] as { input: { prompt: string } };
    expect(trinityRequest.input.prompt).toContain(expectedGame);
  });

  it.each([
    ['build', 'best build for the current patch', runBuildPipeline],
    ['meta', 'meta for the latest season', runMetaPipeline]
  ] as const)('raises a tagged game-required result when a supplied %s page has no usable game metadata', async (_mode, prompt, pipeline) => {
    mockFetchAndClean.mockResolvedValue(
      'This community article contains readable gameplay recommendations but does not identify which game they apply to.'
    );

    await expect(pipeline({
      prompt,
      guideUrl: 'https://unknown.example/article/123',
      guideUrls: [],
      auditEnabled: false
    })).rejects.toMatchObject({ code: 'GAMING_GAME_REQUIRED' });
    expect(mockRunTrinityWritingPipeline).not.toHaveBeenCalled();
  });

  it('keeps repeated meta requests off the direct-answer integrity path', async () => {
    mockFetchAndClean.mockResolvedValue(
      'World of Warcraft 11.2.7 Frost Mage current patch guide explains tuning, talents, rotation, and encounter tradeoffs. '
      + 'Players should verify current hotfixes before changing a competitive build.'
    );
    const metaAnswer = [
      '1. Frost Mage is viable when its control, cleave, and burst windows match the current encounter profile.',
      '2. Treat exact rankings as patch-sensitive and verify tuning before committing to competitive pushes.'
    ].join('\n');
    mockRunTrinityWritingPipeline.mockResolvedValue({
      result: metaAnswer,
      activeModel: 'gpt-test',
      meta: { provider: { finishReason: 'stop' } }
    });

    for (let index = 0; index < 10; index += 1) {
      const result = await runMetaPipeline({
        game: 'World of Warcraft',
        prompt: 'Is frost mage still viable in World of Warcraft 11.2.7?',
        guideUrls: [],
        auditEnabled: false
      });

      expect(result.ok).toBe(true);
      expect(result.mode).toBe('meta');
      expect(result.data.response).toBe(metaAnswer);
      expect(result.data.response).not.toContain('bounded deterministic fallback');
    }

    expect(mockRunTrinityWritingPipeline).toHaveBeenCalledTimes(10);
    for (const [request] of mockRunTrinityWritingPipeline.mock.calls) {
      const trinityRequest = request as {
        input: { prompt: string };
        context: { runOptions: { answerMode?: string; strictUserVisibleOutput?: boolean } };
      };
      expect(trinityRequest.input.prompt).not.toContain('[OUTPUT]');
      expect(trinityRequest.input.prompt).not.toContain('Answer the request directly');
      expect(trinityRequest.context.runOptions).toEqual(expect.objectContaining({
        answerMode: 'explained',
        strictUserVisibleOutput: true
      }));
    }
  });

  it('allows numbered or bulleted meta formatting without direct-answer false positives', async () => {
    mockFetchAndClean.mockResolvedValue(
      'World of Warcraft 11.2.7 Frost Mage current patch guide explains tuning, talents, rotation, and encounter tradeoffs. '
      + 'Players should verify current hotfixes before changing a competitive build.'
    );
    const metaAnswer = [
      '- Frost Mage can be viable when control and burst windows matter.',
      '- Watch for tuning, dungeon pool, and team composition before treating it as best-in-slot.'
    ].join('\n');
    mockRunTrinityWritingPipeline.mockResolvedValueOnce({
      result: metaAnswer,
      activeModel: 'gpt-test',
      meta: { provider: { finishReason: 'stop' } }
    });

    const result = await runMetaPipeline({
      game: 'World of Warcraft',
      prompt: 'Is frost mage still viable in World of Warcraft 11.2.7?',
      guideUrls: [],
      auditEnabled: false
    });

    expect(result.ok).toBe(true);
    expect(result.mode).toBe('meta');
    expect(result.data.response).toBe(metaAnswer);
    expect(result.data.response).not.toContain('bounded deterministic fallback');
    const trinityRequest = mockRunTrinityWritingPipeline.mock.calls[0][0] as {
      context: { runOptions: { answerMode?: string } };
    };
    expect(trinityRequest.context.runOptions.answerMode).toBe('explained');
  });

  it('uses explained mode for source-backed guide requests to avoid direct-answer integrity false positives', async () => {
    await runGuidePipeline({
      prompt: 'Use this source for a simple guide summary.',
      guideUrl: 'https://example.com/',
      guideUrls: [],
      auditEnabled: false
    });

    const trinityRequest = mockRunTrinityWritingPipeline.mock.calls[0][0] as {
      input: { prompt: string };
      context: {
        runOptions: {
          answerMode?: string;
          requestedVerbosity?: string;
          watchdogModelTimeoutMs?: number;
          modelStageTimeoutMs?: number;
        };
      };
    };
    expect(trinityRequest.input.prompt).toContain('[WEB CONTEXT]');
    expect(trinityRequest.input.prompt).toContain('Return only a six-item checklist using hyphen bullets');
    expect(trinityRequest.context.runOptions).toEqual(expect.objectContaining({
      answerMode: 'explained',
      requestedVerbosity: 'normal',
      watchdogModelTimeoutMs: 50_000,
      modelStageTimeoutMs: 24_000
    }));
  });

  it('uses direct mode when supplied guide sources yield no usable context', async () => {
    const url = 'https://example.com/unreachable-guide';
    mockFetchAndClean.mockRejectedValueOnce(new Error('deterministic fetch failure'));

    const result = await runGuidePipeline({
      game: 'Palworld',
      prompt: 'Use the supplied source for a Palworld beginner guide.',
      guideUrl: url,
      guideUrls: [],
      auditEnabled: false
    });

    expect(result.data.sources).toEqual([
      expect.objectContaining({ url, error: expect.any(String) })
    ]);
    const trinityRequest = mockRunTrinityWritingPipeline.mock.calls[0][0] as {
      input: { prompt: string };
      context: { runOptions: { answerMode?: string; modelStageTimeoutMs?: number } };
    };
    expect(trinityRequest.input.prompt).toContain(
      'Source retrieval ran or sources were provided, but no usable snippets were retrieved.'
    );
    expect(trinityRequest.context.runOptions).toEqual(expect.objectContaining({
      answerMode: 'direct',
      modelStageTimeoutMs: 24_000
    }));
  });

  it('normalizes generated citations so inline source refs map to public sources', async () => {
    mockFetchAndClean.mockImplementation(async (url: string) => `Guide for ${url}: Elden Ring route, preparation, boss danger checks, and upgrades.`);
    mockRunTrinityWritingPipeline.mockResolvedValueOnce({
      result: 'Use [Source 3] for the route, (sources 1, 4) for prep, [1, 4] for danger checks, and source 2 for upgrades.',
      activeModel: 'gpt-test',
      meta: { provider: { finishReason: 'stop' } }
    });

    const result = await runGuidePipeline({
      prompt: 'Use the linked guides for source mapping.',
      guideUrl: 'https://example.com/guide-a',
      guideUrls: ['https://example.com/guide-b'],
      auditEnabled: false
    });

    expect(result.data.sources).toHaveLength(2);
    expect(result.data.response).toBe('Use for the route, (source 1) for prep, [1] for danger checks, and (source 2) for upgrades.');
    expectInlineSourceRefsToMap(result.data.response, result.data.sources.length);
  });

  it('removes inline citation numbers when public sources are empty', async () => {
    mockRunTrinityWritingPipeline.mockResolvedValueOnce({
      result: 'Start in Limgrave [Source 1], verify [1], and check source 2 later.',
      activeModel: 'gpt-test',
      meta: { provider: { finishReason: 'stop' } }
    });

    const result = await runGuidePipeline({
      prompt: 'How do I start a generic run?',
      guideUrls: [],
      auditEnabled: false
    });

    expect(result.data.sources).toEqual([]);
    expect(extractInlineSourceRefs(result.data.response)).toEqual([]);
    expect(result.data.response).not.toMatch(/\bsource\s+\d+\b/i);
  });

  it('removes inline citations when the only public source has no readable evidence', async () => {
    mockFetchAndClean.mockResolvedValue('Menu. Sign In. Cookie Settings. Privacy Policy. Related. Categories.');
    mockRunTrinityWritingPipeline.mockResolvedValueOnce({
      result: 'Treat this as verified source-backed guidance [1].',
      activeModel: 'gpt-test',
      meta: { provider: { finishReason: 'stop' } }
    });

    const result = await runGuidePipeline({
      prompt: 'Use this supplied guide.',
      guideUrl: 'https://unknown.example/chrome-only',
      guideUrls: [],
      auditEnabled: false
    });

    expect(result.data.sources).toEqual([{
      url: 'https://unknown.example/chrome-only',
      snippet: 'Relevant source retrieved, but readable article text was limited.'
    }]);
    expect(extractInlineSourceRefs(result.data.response)).toEqual([]);
  });

  it('preserves retrieved sources when generic provider generation fails', async () => {
    const warnSpy = jest.spyOn(logger, 'warn');
    try {
      mockFetchAndClean.mockResolvedValueOnce('Elden Ring route guide: start in Limgrave, follow Sites of Grace, upgrade flasks, and prepare before Stormveil Castle.');
      mockRunTrinityWritingPipeline.mockRejectedValueOnce(new Error('provider unavailable'));

      const result = await runGuidePipeline({
        game: 'Elden Ring',
        prompt: 'Look up a guide for Elden Ring.',
        guideUrl: 'https://example.com/elden-ring-route',
        guideUrls: [],
        auditEnabled: false
      });

      expect(result.ok).toBe(true);
      expect(result.data.sources.length).toBeGreaterThanOrEqual(1);
      expect(result.data.sources.map((source) => source.url)).toContain('https://example.com/elden-ring-route');
      expect(result.data.response).toContain('Sources available');
      expect(result.data.response).not.toContain('TRINITY_OUTPUT_INTEGRITY_FAILED');
      expect(result.data.response).not.toMatch(/provider|incomplete|integrity|timeout/i);
      expect(result.data.response).not.toContain('Backend-supported: none');
      expect(result.data.fallbackReason).toBe('GAMING_PROVIDER_ERROR');
      expectInlineSourceRefsToMap(result.data.response, result.data.sources.length);
      expect(warnSpy).toHaveBeenCalledWith('gaming.fallback.used', expect.objectContaining({
        fallbackReason: 'GAMING_PROVIDER_ERROR'
      }));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('preserves retrieved sources when provider generation is reported blank', async () => {
    mockFetchAndClean.mockResolvedValueOnce('Elden Ring route guide: start in Limgrave, follow Sites of Grace, upgrade flasks, and prepare before Stormveil Castle.');
    mockRunTrinityWritingPipeline.mockResolvedValueOnce({
      result: "I'd be happy to help—could you share a bit more detail about what you need?",
      activeModel: 'gpt-test',
      meta: { provider: { finishReason: 'stop', emptyOutput: true } }
    });

    const result = await runGuidePipeline({
      game: 'Elden Ring',
      prompt: 'Look up a guide for Elden Ring.',
      guideUrl: 'https://example.com/elden-ring-route',
      guideUrls: [],
      auditEnabled: false
    });

    expect(result.ok).toBe(true);
    expect(result.data.sources.map((source) => source.url)).toContain('https://example.com/elden-ring-route');
    expect(result.data.response.trim().length).toBeGreaterThan(0);
    expect(result.data.fallbackReason).toBe('GAMING_PROVIDER_ERROR');
  });

  it.each(['...', '\u034f', '\u061c', '\u200b', '\u202e', '\u2060', '\ufe0f'])(
    'treats invisible-only provider output as blank while retaining sources',
    async (providerOutput) => {
      mockFetchAndClean.mockResolvedValueOnce(
        'Elden Ring route guide: start in Limgrave, upgrade flasks, and prepare before Stormveil Castle.'
      );
      mockRunTrinityWritingPipeline.mockResolvedValueOnce({
        result: providerOutput,
        activeModel: 'gpt-test',
        meta: { provider: { finishReason: 'stop', emptyOutput: false } }
      });

      const result = await runGuidePipeline({
        game: 'Elden Ring',
        prompt: 'Look up a guide for Elden Ring.',
        guideUrl: 'https://example.com/elden-ring-route',
        guideUrls: [],
        auditEnabled: false
      });

      expect(result.data.sources.map((source) => source.url)).toContain(
        'https://example.com/elden-ring-route'
      );
      expect(result.data.response.trim().length).toBeGreaterThan(0);
      expect(result.data.fallbackReason).toBe('GAMING_PROVIDER_ERROR');
    }
  );

  it('preserves genuine output-integrity failures for the module formatter', async () => {
    const integrityError = Object.assign(new Error('secret provider integrity detail'), {
      code: 'TRINITY_OUTPUT_INTEGRITY_FAILED',
      integrityIssues: ['broken_numbering']
    });
    mockRunTrinityWritingPipeline.mockRejectedValueOnce(integrityError);

    await expect(runGuidePipeline({
      game: 'Elden Ring',
      prompt: 'Look up a guide for Elden Ring.',
      guideUrls: [],
      auditEnabled: false
    })).rejects.toBe(integrityError);
  });

  it.each([
    ['Palworld', 'Look up a current beginner guide for Palworld 1.0.'],
    ['Clockwork Odyssey', 'Look up a current beginner guide for Clockwork Odyssey 1.0.']
  ])('returns a current-evidence fallback for freshness-sensitive %s guidance', async (game, prompt) => {
    mockGetEnvBoolean.mockImplementation((key: string, defaultValue: boolean) =>
      key === 'ARCANOS_GAMING_DISCOVERY_ENABLED' ? true : defaultValue
    );

    const result = await runGuidePipeline({
      game,
      prompt,
      guideUrls: [],
      auditEnabled: false
    });

    expect(result.ok).toBe(true);
    expect(result.data.fallbackReason).toBe('CURRENT_EVIDENCE_UNAVAILABLE');
    expect(result.data.discoveryReason).toBe('DISCOVERY_NO_SOURCE_CANDIDATES');
    expect(result.data.discoveryFailureReason).toBe('DISCOVERY_PROVIDER_UNCONFIGURED');
    expect(result.data.sources).toEqual([]);
    expect(result.data.response).toContain('Sources unavailable');
    expect(result.data.evidenceRequest).toEqual({
      required: true,
      reason: 'CURRENT_VERSION_EVIDENCE_REQUIRED',
      game,
      version: '1.0',
      maxCandidateUrls: 4,
      queries: [expect.any(String)]
    });
    expect(result.data.evidenceRequest?.queries[0]).toContain(game.includes(' ') ? `"${game}"` : game);
    expect(result.data.evidenceRequest?.queries[0]).not.toContain(prompt);
    expect(mockRunTrinityWritingPipeline).not.toHaveBeenCalled();
  });

  it('terminates a zero-candidate frontend evidence retry without requesting another search', async () => {
    const result = await runGuidePipeline({
      game: 'Palworld',
      prompt: 'Look up a current beginner guide for Palworld 1.0.',
      guideUrls: [],
      evidenceOrigin: 'frontend_web_search',
      requestedVersion: '1.0',
      evidenceAttempt: 1,
      auditEnabled: false
    });

    expect(result.ok).toBe(true);
    expect(result.data.fallbackReason).toBe('CURRENT_EVIDENCE_UNAVAILABLE');
    expect(result.data.sources).toEqual([]);
    expect(result.data).not.toHaveProperty('evidenceRequest');
    expect(mockRunTrinityWritingPipeline).not.toHaveBeenCalled();
  });

  it('contains a blocked frontend candidate as a terminal safe source error', async () => {
    mockGetEnvBoolean.mockImplementation((key: string, defaultValue: boolean) =>
      key === 'ARCANOS_GAMING_RAG_ENABLED' ? true : defaultValue
    );
    mockFetchAndClean.mockRejectedValue(Object.assign(new Error('raw upstream forbidden body'), { status: 403 }));

    const result = await runGuidePipeline({
      game: 'Palworld',
      prompt: 'Look up a current beginner guide for Palworld 1.0.',
      guideUrls: ['https://example.com/blocked'],
      evidenceOrigin: 'frontend_web_search',
      requestedVersion: '1.0',
      evidenceAttempt: 1,
      auditEnabled: false
    });

    expect(result.ok).toBe(true);
    expect(result.data.fallbackReason).toBe('CURRENT_EVIDENCE_UNAVAILABLE');
    expect(result.data.sources).toEqual([{
      url: 'https://example.com/blocked',
      error: 'Source access was blocked.'
    }]);
    expect(result.data).not.toHaveProperty('evidenceRequest');
    expect(JSON.stringify(result)).not.toContain('raw upstream forbidden body');
  });

  it('does not request frontend evidence for a stable guide request', async () => {
    const result = await runGuidePipeline({
      game: 'Elden Ring',
      prompt: 'Give me a concise beginner progression guide.',
      guideUrls: [],
      auditEnabled: false
    });

    expect(result.data).not.toHaveProperty('evidenceRequest');
  });

  it('requests bounded frontend discovery for an explicitly newly released unknown game', async () => {
    const result = await runGuidePipeline({
      game: 'Moonring',
      prompt: 'Give me a beginner guide for the newly released Moonring game.',
      guideUrls: [],
      auditEnabled: false
    });

    expect(result.data.fallbackReason).toBe('CURRENT_EVIDENCE_UNAVAILABLE');
    expect(result.data.evidenceRequest).toEqual({
      required: true,
      reason: 'CURRENT_VERSION_EVIDENCE_REQUIRED',
      game: 'Moonring',
      maxCandidateUrls: 4,
      queries: [expect.stringContaining('Moonring')]
    });
    expect(result.data.evidenceRequest?.queries[0].length).toBeLessThanOrEqual(180);
  });

  it('marks the deterministic no-client path with bounded fallback metadata', async () => {
    mockGetOpenAIClientOrAdapter.mockReturnValueOnce({ client: null });

    const result = await runGuidePipeline({
      game: 'Caves of Qud',
      prompt: 'Give me a concise beginner progression guide.',
      guideUrls: [],
      auditEnabled: false
    });

    expect(result.data.fallbackReason).toBe('GAMING_PROVIDER_UNAVAILABLE');
    expect(result.data.discoveryReason).toBe('DISCOVERY_DISABLED');
    expect(mockGenerateMockResponse).toHaveBeenCalledTimes(1);
    expect(mockRunTrinityWritingPipeline).not.toHaveBeenCalled();
  });

  it('returns a controlled fallback when upstream intake slows down', async () => {
    const providerAbort = Object.assign(new Error('Request was aborted.'), {
      name: 'AbortError',
      timeoutPhase: 'intake'
    });
    mockRunTrinityWritingPipeline.mockRejectedValueOnce(providerAbort);

    const result = await runGuidePipeline({
      game: 'Elden Ring',
      prompt: 'Look up a guide for Elden Ring.',
      guideUrls: [],
      auditEnabled: false
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      route: 'gaming',
      mode: 'guide'
    }));
    expect(result.data.response).toContain('Sources available');
    expect(result.data.response).not.toContain('INTAKE_UPSTREAM_TIMEOUT');
    expect(result.data.response).not.toMatch(/provider|incomplete|integrity|timeout/i);
    expect(result.data.response).toContain('For Elden Ring');
  });

  it('returns a controlled fallback when runtime budget exhaustion reaches the guide pipeline', async () => {
    const budgetError = Object.assign(new Error('runtime_budget_exhausted'), {
      name: 'RuntimeBudgetExceededError',
      timeoutPhase: 'reasoning'
    });
    mockRunTrinityWritingPipeline.mockRejectedValueOnce(budgetError);

    const result = await runGuidePipeline({
      game: 'Star Wars: The Old Republic',
      prompt: 'Regression check only: Beginner to intermediate guide for tanking in Star Wars The Old Republic including mechanics, threat management, mitigation, positioning, and group play tips. Return a complete coherent answer with valid numbering.',
      guideUrls: [],
      auditEnabled: false
    });

    expect(result.ok).toBe(true);
    expect(result.data.response).toContain('bounded deterministic fallback');
    expect(result.data.response).not.toContain('INTAKE_UPSTREAM_TIMEOUT');
    expect(result.data.response).not.toMatch(/provider|incomplete|integrity|timeout/i);
  });

  it('defaults missing provider timeout phase consistently in the fallback response', async () => {
    const providerAbort = Object.assign(new Error('Request was aborted.'), {
      name: 'AbortError'
    });
    mockRunTrinityWritingPipeline.mockRejectedValueOnce(providerAbort);

    const result = await runGuidePipeline({
      game: 'Star Wars: The Old Republic',
      prompt: 'Smoke test: give three short tanking tips with valid numbering.',
      guideUrls: [],
      auditEnabled: false
    });

    expect(result.ok).toBe(true);
    expect(result.data.response).not.toContain('INTAKE_UPSTREAM_TIMEOUT');
    expect(result.data.response).not.toMatch(/provider|incomplete|integrity|timeout/i);
  });

  it('classifies direct-answer stage timeouts as upstream timeouts', async () => {
    const providerAbort = Object.assign(new Error('Trinity direct-answer stage timed out.'), {
      name: 'AbortError',
      timeoutPhase: 'direct-answer'
    });
    mockRunTrinityWritingPipeline.mockRejectedValueOnce(providerAbort);

    const result = await runBuildPipeline({
      game: 'Elden Ring',
      prompt: 'Make me a bleed build for Elden Ring.',
      guideUrls: [],
      auditEnabled: false
    });

    expect(result.ok).toBe(true);
    expect(result.mode).toBe('build');
    expect(result.data.response).not.toContain('INTAKE_UPSTREAM_TIMEOUT');
    expect(result.data.response).not.toMatch(/provider|incomplete|integrity|timeout/i);
    expect(result.data.response).not.toContain('INTAKE_UNKNOWN_TIMEOUT');
  });

  it('preserves parent request aborts instead of reporting provider timeouts', async () => {
    const parentAbort = Object.assign(new Error('Outer request was aborted.'), {
      name: 'AbortError'
    });
    const controller = new AbortController();
    controller.abort(parentAbort);

    await expect(runWithRequestAbortContext({
      requestId: 'req-gaming-parent-abort',
      controller,
      signal: controller.signal,
      deadlineAt: Date.now(),
      timeoutMs: 1
    }, () => runGuidePipeline({
      game: 'Star Wars: The Old Republic',
      prompt: 'Smoke test: give three short tanking tips with valid numbering.',
      guideUrls: [],
      auditEnabled: false
    }))).rejects.toBe(parentAbort);
    expect(mockRunTrinityWritingPipeline).not.toHaveBeenCalled();
  });

  it('clamps guide stage timeout below the guide pipeline timeout when env overrides exceed the budget', async () => {
    process.env.ARCANOS_GAMING_GUIDE_PIPELINE_TIMEOUT_MS = '9000';
    process.env.ARCANOS_GAMING_GUIDE_STAGE_TIMEOUT_MS = '25000';
    mockRunTrinityWritingPipeline.mockResolvedValueOnce({
      result: '1. Hold threat. 2. Face enemies away. 3. Use mitigation before spikes.',
      activeModel: 'gpt-test',
      meta: { provider: { finishReason: 'stop' } }
    });

    await runGuidePipeline({
      game: 'Star Wars: The Old Republic',
      prompt: 'Smoke test: give three short tanking tips with valid numbering.',
      guideUrls: [],
      auditEnabled: false
    });

    const trinityRequest = mockRunTrinityWritingPipeline.mock.calls[0][0] as {
      context: {
        runtimeBudget: { watchdogLimit: number; safetyBuffer: number };
        runOptions: { watchdogModelTimeoutMs?: number; modelStageTimeoutMs?: number };
      };
    };
    expect(trinityRequest.context.runtimeBudget).toEqual(expect.objectContaining({
      watchdogLimit: 9000,
      safetyBuffer: 500
    }));
    expect(trinityRequest.context.runOptions).toEqual(expect.objectContaining({
      watchdogModelTimeoutMs: 9000,
      modelStageTimeoutMs: 8000
    }));
  });

  it('uses an explicit module timeout as the default guide provider budget', async () => {
    process.env.ARCANOS_GAMING_MODULE_TIMEOUT_MS = '90000ms';
    mockRunTrinityWritingPipeline.mockResolvedValueOnce({
      result: '1. Hold threat. 2. Face enemies away. 3. Use mitigation before spikes.',
      activeModel: 'gpt-test',
      meta: { provider: { finishReason: 'stop' } }
    });

    await runGuidePipeline({
      game: 'Star Wars: The Old Republic',
      prompt: 'Smoke test: give three short tanking tips with valid numbering.',
      guideUrls: [],
      auditEnabled: false
    });

    const trinityRequest = mockRunTrinityWritingPipeline.mock.calls[0][0] as {
      context: {
        runtimeBudget: { watchdogLimit: number; safetyBuffer: number };
        runOptions: { watchdogModelTimeoutMs?: number; modelStageTimeoutMs?: number };
      };
    };
    expect(trinityRequest.context.runtimeBudget).toEqual(expect.objectContaining({
      watchdogLimit: 85_000,
      safetyBuffer: 500
    }));
    expect(trinityRequest.context.runOptions).toEqual(expect.objectContaining({
      watchdogModelTimeoutMs: 85_000,
      modelStageTimeoutMs: 24_000
    }));
  });

  it('preserves the default guide provider budget when the module timeout is explicitly set to its default', async () => {
    process.env.ARCANOS_GAMING_MODULE_TIMEOUT_MS = '60000';
    mockRunTrinityWritingPipeline.mockResolvedValueOnce({
      result: '1. Hold threat. 2. Face enemies away. 3. Use mitigation before spikes.',
      activeModel: 'gpt-test',
      meta: { provider: { finishReason: 'stop' } }
    });

    await runGuidePipeline({
      game: 'Star Wars: The Old Republic',
      prompt: 'Smoke test: give three short tanking tips with valid numbering.',
      guideUrls: [],
      auditEnabled: false
    });

    const trinityRequest = mockRunTrinityWritingPipeline.mock.calls[0][0] as {
      context: {
        runtimeBudget: { watchdogLimit: number; safetyBuffer: number };
        runOptions: { watchdogModelTimeoutMs?: number; modelStageTimeoutMs?: number };
      };
    };
    expect(trinityRequest.context.runtimeBudget).toEqual(expect.objectContaining({
      watchdogLimit: 50_000,
      safetyBuffer: 500
    }));
    expect(trinityRequest.context.runOptions).toEqual(expect.objectContaining({
      watchdogModelTimeoutMs: 50_000,
      modelStageTimeoutMs: 24_000
    }));
  });

  it('deduplicates guide URLs and uses the configured gaming context size', async () => {
    await runGuidePipeline({
      prompt: 'Use the linked guides for a direct boss strategy.',
      guideUrl: 'https://example.com/guide-a',
      guideUrls: ['https://example.com/guide-a', 'https://example.com/guide-b'],
      auditEnabled: false
    });

    expect(mockFetchAndClean).toHaveBeenNthCalledWith(1, 'https://example.com/guide-a', 512, expectFetchOptions());
    expect(mockFetchAndClean).toHaveBeenNthCalledWith(2, 'https://example.com/guide-b', 512, expectFetchOptions());
    expect(mockFetchAndClean).toHaveBeenCalledTimes(2);
    const trinityRequest = mockRunTrinityWritingPipeline.mock.calls[0][0] as { input: { prompt: string } };
    expect(mockRunTrinityWritingPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          prompt: expect.stringContaining('[Source 1] https://example.com/guide-a')
        })
      })
    );
    expect(trinityRequest.input.prompt).toContain('[Source 2] https://example.com/guide-b');
  });

  it('caps user-provided guide URLs before parallel fetches', async () => {
    process.env.ARCANOS_GAMING_WEB_CONTEXT_MAX_URLS = '2';
    mockRunTrinityWritingPipeline.mockResolvedValueOnce({
      result: 'Use [Source 1], [Source 2], and [Source 3].',
      activeModel: 'gpt-test',
      meta: { provider: { finishReason: 'stop' } }
    });

    const result = await runGuidePipeline({
      prompt: 'Use the linked guides for a direct boss strategy.',
      guideUrl: 'https://example.com/guide-a',
      guideUrls: ['https://example.com/guide-b', 'https://example.com/guide-c'],
      auditEnabled: false
    });

    expect(mockFetchAndClean).toHaveBeenCalledTimes(2);
    expect(mockFetchAndClean).toHaveBeenNthCalledWith(1, 'https://example.com/guide-a', 512, expectFetchOptions());
    expect(mockFetchAndClean).toHaveBeenNthCalledWith(2, 'https://example.com/guide-b', 512, expectFetchOptions());
    expect(result.data.sources).toEqual([
      { url: 'https://example.com/guide-a', snippet: DEFAULT_GUIDE_SNIPPET },
      { url: 'https://example.com/guide-b', snippet: DEFAULT_GUIDE_SNIPPET }
    ]);
    const trinityRequest = mockRunTrinityWritingPipeline.mock.calls[0][0] as { input: { prompt: string } };
    expect(trinityRequest.input.prompt).not.toContain('https://example.com/guide-c');
    expect(trinityRequest.input.prompt).not.toContain('[Source 3]');
    expectInlineSourceRefsToMap(result.data.response, result.data.sources.length);
  });

  it('filters blank, invalid, and non-HTTPS guide URLs before fetching', async () => {
    const result = await runGuidePipeline({
      prompt: 'Use the linked guides for a direct boss strategy.',
      guideUrl: 'not-a-url',
      guideUrls: [
        '',
        '   ',
        'ftp://example.com/guide',
        ' https://example.com/guide-a ',
        'http://example.com/guide-b'
      ],
      auditEnabled: false
    });

    expect(mockFetchAndClean).toHaveBeenCalledTimes(1);
    expect(mockFetchAndClean).toHaveBeenNthCalledWith(1, 'https://example.com/guide-a', 512, expectFetchOptions());
    expect(result.data.sources).toEqual([
      { url: 'https://example.com/guide-a', snippet: DEFAULT_GUIDE_SNIPPET },
      { url: 'invalid-source', error: 'Source URL was rejected by evidence policy.' }
    ]);
    const trinityRequest = mockRunTrinityWritingPipeline.mock.calls[0][0] as { input: { prompt: string } };
    expect(trinityRequest.input.prompt).toContain('[Source 1] https://example.com/guide-a');
    expect(trinityRequest.input.prompt).not.toContain('http://example.com/guide-b');
    expect(trinityRequest.input.prompt).not.toContain('not-a-url');
    expect(trinityRequest.input.prompt).not.toContain('ftp://example.com/guide');
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

  it('rejects guide URL credentials before fetch or prompt construction', async () => {
    const result = await runGuidePipeline({
      prompt: 'Use the linked guide for a direct boss strategy.',
      guideUrl: 'https://user:pass@example.com/guide',
      guideUrls: [],
      auditEnabled: false
    });

    expect(result.data.sources).toEqual([
      { url: 'invalid-source', error: 'Source URL was rejected by evidence policy.' }
    ]);
    expect(mockFetchAndClean).not.toHaveBeenCalled();
    expect(mockRunTrinityWritingPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          prompt: expect.not.stringContaining('https://example.com/guide')
        })
      })
    );
    const trinityRequest = mockRunTrinityWritingPipeline.mock.calls[0][0] as { input: { prompt: string } };
    expect(trinityRequest.input.prompt).not.toContain('user:pass');
  });

  it('continues with sources unavailable when retrieval fails', async () => {
    mockFetchAndClean.mockRejectedValueOnce(new Error('network unavailable'));
    mockRunTrinityWritingPipeline.mockResolvedValueOnce({
      result: 'Use the safe route and verify the linked guide later.',
      activeModel: 'gpt-test',
      meta: { provider: { finishReason: 'stop' } }
    });

    const result = await runGuidePipeline({
      prompt: 'Use the linked guide for a direct boss strategy.',
      guideUrl: 'https://example.com/guide',
      guideUrls: [],
      auditEnabled: false
    });

    expect(result.ok).toBe(true);
    expect(result.data.response).toBe('Use the safe route and verify the linked guide later.');
    expect(result.data.sources).toEqual([
      { url: 'https://example.com/guide', error: 'Source could not be retrieved.' }
    ]);
    const trinityRequest = mockRunTrinityWritingPipeline.mock.calls[0][0] as { input: { prompt: string } };
    expect(trinityRequest.input.prompt).toContain('Source retrieval ran or sources were provided, but no usable snippets were retrieved.');
  });

  it('aborts guide source fetches when the local retrieval timeout fires', async () => {
    process.env.ARCANOS_GAMING_WEB_CONTEXT_FETCH_TIMEOUT_MS = '5';
    let capturedSignal: AbortSignal | undefined;
    mockFetchAndClean.mockImplementationOnce(async (_url: string, _maxChars: number, options?: { signal?: AbortSignal }) => {
      capturedSignal = options?.signal;
      await new Promise(() => undefined);
      return 'unreachable';
    });
    mockRunTrinityWritingPipeline.mockResolvedValueOnce({
      result: 'Use a safe fallback route while source retrieval is unavailable.',
      activeModel: 'gpt-test',
      meta: { provider: { finishReason: 'stop' } }
    });

    const result = await runGuidePipeline({
      prompt: 'Use the linked guide for a direct boss strategy.',
      guideUrl: 'https://example.com/guide',
      guideUrls: [],
      auditEnabled: false
    });

    expect(capturedSignal?.aborted).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.data.sources).toEqual([
      {
        url: 'https://example.com/guide',
        error: 'Source retrieval timed out.'
      }
    ]);
    expect(mockFetchAndClean).toHaveBeenCalledWith(
      'https://example.com/guide',
      512,
      expectFetchOptions(5)
    );
  });

  it('ignores malformed retrieval inputs without logging secrets or timeout fallbacks', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    try {
      const result = await runGuidePipeline({
        prompt: 'Use the linked guide for a direct boss strategy.',
        guideUrls: [undefined as unknown as string],
        auditEnabled: false
      });

      expect(result.ok).toBe(true);
      expect(mockRunTrinityWritingPipeline).toHaveBeenCalledTimes(1);
      const retrievalFailureLog = warnSpy.mock.calls.find(([event]) => event === 'gaming.retrieval.failure')?.[1];
      expect(retrievalFailureLog).toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalledWith('gaming.fallback.used', expect.objectContaining({
        fallbackReason: 'INTAKE_RETRIEVAL_TIMEOUT'
      }));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('uses curated walkthrough context for Elden Ring guide requests', async () => {
    mockFetchAndClean.mockImplementation(async (url: string) =>
      url.includes('Game+Progress+Route')
        ? 'Limgrave route: visit The First Step, Church of Elleh, Gatefront Ruins, and unlock Torrent before Stormveil.'
        : 'less relevant source'
    );

    await runGuidePipeline({
      game: 'Elden Ring',
      prompt: 'Where do I go first in Elden Ring after leaving the tutorial?',
      guideUrls: [],
      auditEnabled: false
    });

    expect(mockFetchAndClean).toHaveBeenCalledWith(
      'https://eldenring.wiki.fextralife.com/Game+Progress+Route',
      512,
      expectFetchOptions()
    );
    const trinityRequest = mockRunTrinityWritingPipeline.mock.calls[0][0] as { input: { prompt: string } };
    expect(trinityRequest.input.prompt).toContain('[Source 1] https://eldenring.wiki.fextralife.com/Game+Progress+Route');
    expect(trinityRequest.input.prompt).toContain('Limgrave route');
    expect(trinityRequest.input.prompt).toContain('[CLEAR]');
  });

  it('uses source-backed build data for Elden Ring bleed build requests', async () => {
    mockFetchAndClean.mockImplementation(async (url: string) =>
      url.includes('Builds')
        ? 'Bleed builds prioritize Arcane, fast multi-hit weapons, blood affinity, and Lord of Blood-style pressure.'
        : 'Status Effects: Hemorrhage deals burst damage after buildup.'
    );

    const result = await runBuildPipeline({
      game: 'Elden Ring',
      prompt: 'Make me a bleed build for Elden Ring.',
      guideUrls: [],
      auditEnabled: false
    });

    expect(result.data.sources.some((source) => source.url.includes('/Builds'))).toBe(true);
    const trinityRequest = mockRunTrinityWritingPipeline.mock.calls[0][0] as { input: { prompt: string } };
    expect(trinityRequest.input.prompt).toContain('Bleed builds prioritize Arcane');
    expect(trinityRequest.input.prompt).toContain('source-backed claims');
  });

  it('prefers official patch notes for patch-sensitive Elden Ring meta requests', async () => {
    mockFetchAndClean.mockResolvedValue(
      'Elden Ring 1.16.1 official current patch notes explain balance adjustments to weapons, skills, and build interactions. '
      + 'Players should review the current version before changing a patch-sensitive build.'
    );

    await runMetaPipeline({
      game: 'Elden Ring',
      prompt: 'What changed for Elden Ring builds in patch 1.16.1?',
      guideUrls: [],
      auditEnabled: false
    });

    expect(mockFetchAndClean).toHaveBeenNthCalledWith(
      1,
      'https://en.bandainamcoent.eu/elden-ring/news/elden-ring-patch-notes-version-1161',
      512,
      expectFetchOptions()
    );
    const trinityRequest = mockRunTrinityWritingPipeline.mock.calls[0][0] as { input: { prompt: string } };
    expect(trinityRequest.input.prompt).toContain('Type: patch_notes');
    expect(trinityRequest.input.prompt).toContain('official current patch notes');
  });

  it('retrieves WoW patch and Frost Mage guide context for current viability requests', async () => {
    process.env.ARCANOS_GAMING_WEB_CONTEXT_CHARS = '1024';
    mockFetchAndClean.mockImplementation(async (url: string) =>
      url.includes('worldofwarcraft.blizzard.com')
        ? 'World of Warcraft 11.2.7 official current patch news explains hotfixes and class tuning that can change Frost Mage viability.'
        : 'World of Warcraft 11.2.7 Frost Mage guide explains current talents, rotation, damage profile, and encounter needs.'
    );

    await runMetaPipeline({
      game: 'World of Warcraft',
      prompt: 'Is Frost Mage still viable in World of Warcraft 11.2.7?',
      guideUrls: [],
      auditEnabled: false
    });

    expect(mockFetchAndClean).toHaveBeenNthCalledWith(
      1,
      'https://worldofwarcraft.blizzard.com/en-us/news',
      1024,
      expectFetchOptions()
    );
    const trinityRequest = mockRunTrinityWritingPipeline.mock.calls[0][0] as { input: { prompt: string } };
    expect(trinityRequest.input.prompt).toContain('official current patch news');
    expect(trinityRequest.input.prompt).toContain('Frost Mage guide');
  });

  it('deduplicates low-quality duplicate sources and passes CLEAR checks', async () => {
    process.env.ARCANOS_GAMING_CURATED_SOURCES_JSON = JSON.stringify([
      {
        url: 'https://example.com/curated-guide',
        title: 'Internal curated guide',
        modes: ['guide'],
        topics: ['boss'],
        sourceType: 'curated',
        stable: true
      },
      {
        url: 'https://example.com/curated-guide',
        title: 'Duplicate internal curated guide',
        modes: ['guide'],
        topics: ['boss'],
        sourceType: 'curated',
        stable: true
      },
      {
        url: 'https://youtube.com/watch?v=lowquality',
        title: 'Low quality duplicate',
        modes: ['guide'],
        topics: ['boss'],
        sourceType: 'curated'
      }
    ]);
    mockFetchAndClean.mockResolvedValue('Curated guide: use safe positioning, upgrade first, and punish only after boss recovery.');

    const result = await buildGamingRagContext({
      mode: 'guide',
      prompt: 'Help me beat the boss.',
      guideUrls: []
    });

    expect(mockFetchAndClean).toHaveBeenCalledTimes(1);
    expect(result.sources).toEqual([
      {
        url: 'https://example.com/curated-guide',
        snippet: 'Curated guide: use safe positioning, upgrade first, and punish only after boss recovery.'
      }
    ]);
    expect(result.clear).toEqual(expect.objectContaining({
      contextGrounded: true,
      limitedEvidence: true,
      explicitUncertainty: true,
      attributableSources: true,
      robustFallback: true,
      passed: true
    }));
  });

  it('keeps RAG source numbering stable after URL dedupe collapses multiple chunks', async () => {
    process.env.ARCANOS_GAMING_RAG_CHUNK_CHARS = '120';
    process.env.ARCANOS_GAMING_RAG_MAX_CHUNKS = '4';
    mockFetchAndClean.mockResolvedValue([
      'Elden Ring route guide: start in Limgrave and use Sites of Grace before Stormveil.',
      'Elden Ring preparation guide: upgrade weapons and collect flask improvements.',
      'Elden Ring danger guide: avoid early bosses that are clearly overtuned.'
    ].join(' '));

    const result = await buildGamingRagContext({
      mode: 'guide',
      prompt: 'Use the supplied guide.',
      guideUrl: 'https://example.com/elden-ring-guide',
      guideUrls: []
    });

    expect(result.sources).toHaveLength(1);
    expect(result.context).toContain('[Source 1] https://example.com/elden-ring-guide');
    expect(result.context).not.toContain('[Source 2]');
    expect(result.context).not.toContain('[Source 3]');
  });

  it('deduplicates supplied URLs before applying the source cap', async () => {
    process.env.ARCANOS_GAMING_WEB_CONTEXT_MAX_URLS = '2';
    mockFetchAndClean.mockImplementation(async (url: string) => `Guide for ${url}: route, boss checks, resources, and upgrades.`);

    const result = await runGuidePipeline({
      prompt: 'Use the linked guides for source numbering.',
      guideUrl: 'https://example.com/guide-a#first',
      guideUrls: ['https://example.com/guide-a#duplicate', 'https://example.com/guide-b', 'https://example.com/guide-c'],
      auditEnabled: false
    });

    expect(mockFetchAndClean).toHaveBeenCalledTimes(2);
    expect(result.data.sources.map((source) => source.url)).toEqual([
      'https://example.com/guide-a',
      'https://example.com/guide-b'
    ]);
    const trinityRequest = mockRunTrinityWritingPipeline.mock.calls[0][0] as { input: { prompt: string } };
    expect(trinityRequest.input.prompt).toContain('[Source 1] https://example.com/guide-a');
    expect(trinityRequest.input.prompt).toContain('[Source 2] https://example.com/guide-b');
    expect(trinityRequest.input.prompt).not.toContain('https://example.com/guide-c');
  });

  it('preserves oversized retrieved sentences by splitting them into multiple chunks', async () => {
    process.env.ARCANOS_GAMING_WEB_CONTEXT_CHARS = '2000';
    process.env.ARCANOS_GAMING_RAG_CHUNK_CHARS = '200';
    process.env.ARCANOS_GAMING_RAG_MAX_CHUNKS = '4';
    const longSentence = `oversized-start ${'collect resources and upgrade gear before each encounter '.repeat(12)}oversized-end final safe punish window.`;
    mockFetchAndClean.mockResolvedValue(longSentence);

    const result = await buildGamingRagContext({
      mode: 'guide',
      prompt: 'Use the supplied guide for oversized marker strategy.',
      guideUrl: 'https://example.com/oversized-guide',
      guideUrls: []
    });

    expect(result.context).toContain('oversized-start');
    expect(result.context).toContain('oversized-end final safe punish window');
  });

  it('bounds the RAG document cache and refetches entries evicted from the cache', async () => {
    process.env.ARCANOS_GAMING_WEB_CONTEXT_MAX_URLS = '32';
    process.env.ARCANOS_GAMING_RAG_MAX_SOURCES = '32';
    process.env.ARCANOS_GAMING_RAG_MAX_CHUNKS = '1';
    const urls = Array.from({ length: 102 }, (_value, index) => `https://example.com/cache-${index}`);
    mockFetchAndClean.mockResolvedValue('Cache guide text about boss route and safe positioning.');

    for (let index = 0; index < urls.length; index += 1) {
      await buildGamingRagContext({
        mode: 'guide',
        prompt: 'Use the supplied cache guides.',
        guideUrls: [urls[index]!]
      });
    }
    const firstFetchCount = mockFetchAndClean.mock.calls.length;

    await buildGamingRagContext({
      mode: 'guide',
      prompt: 'Use the supplied cache guides.',
      guideUrls: urls.slice(0, 2)
    });

    expect(firstFetchCount).toBe(102);
    expect(mockFetchAndClean.mock.calls.length).toBe(firstFetchCount + 2);
  });

  it('logs malformed curated source JSON without exposing the raw configured value', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    process.env.ARCANOS_GAMING_CURATED_SOURCES_JSON = '{"secret":"sk-test-secret",';

    try {
      const result = await buildGamingRagContext({
        mode: 'guide',
        prompt: 'Use curated guide context.',
        guideUrls: []
      });

      expect(result.sources).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        'gaming.config.curated_sources.parse_failed',
        expect.objectContaining({
          errorCode: 'CURATED_SOURCES_PARSE_FAILED'
        })
      );
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('sk-test-secret');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('marks no-source generation as retrieval fallback or inference context', async () => {
    await runGuidePipeline({
      prompt: 'How do I beat the temple boss?',
      guideUrls: [],
      auditEnabled: false
    });

    expect(mockFetchAndClean).not.toHaveBeenCalled();
    const trinityRequest = mockRunTrinityWritingPipeline.mock.calls[0][0] as { input: { prompt: string } };
    expect(trinityRequest.input.prompt).toContain('Source retrieval ran or sources were provided, but no usable snippets were retrieved.');
    expect(trinityRequest.input.prompt).toContain('label weak, missing, or patch-sensitive evidence as inference or fallback');
  });

  it('does not log credentials from supplied guide URLs', async () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    try {
      await runGuidePipeline({
        prompt: 'Use the linked guide for a direct boss strategy.',
        guideUrl: 'https://user:pass@example.com/guide',
        guideUrls: [],
        auditEnabled: false
      });

      const logged = JSON.stringify([...infoSpy.mock.calls, ...warnSpy.mock.calls]);
      expect(logged).not.toContain('user:pass');
      expect(logged).not.toContain('pass@example.com');
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
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
