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
    delete process.env.ARCANOS_GAMING_WEB_CONTEXT_MAX_URLS;
    delete process.env.ARCANOS_GAMING_WEB_CONTEXT_FETCH_TIMEOUT_MS;

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
    expect(trinityRequest.input.prompt).toContain('Return only 6 short numbered bullets');
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
            answerMode: 'direct',
            requestedVerbosity: 'normal',
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
        runOptions: { answerMode?: string; requestedVerbosity?: string; watchdogModelTimeoutMs?: number };
      };
    };
    expect(trinityRequest.input.prompt).toContain('Regression check only');
    expect(trinityRequest.input.prompt).toContain('Return only 6 short numbered bullets');
    expect(trinityRequest.context.runtimeBudget).toEqual(expect.objectContaining({
      watchdogLimit: 50_000,
      safetyBuffer: 500
    }));
    expect(trinityRequest.context.runOptions).toEqual(expect.objectContaining({
      answerMode: 'direct',
      requestedVerbosity: 'normal',
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
            answerMode: 'direct',
            requestedVerbosity: 'normal',
            watchdogModelTimeoutMs: 15_000
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
    expect(trinityRequest.input.prompt).toContain('Return only 6 short numbered bullets');
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
    expect(trinityRequest.input.prompt).toContain('Return only 6 short numbered bullets');
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
      expect(result.data.response).toContain('PROVIDER_COMPLETION_INCOMPLETE');
      expect(result.data.response).toContain('Provider output: incomplete.');
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
    mockRunTrinityWritingPipeline.mockResolvedValueOnce({
      result: 'Frost Mage is viable when current tuning supports its control and cleave profile.',
      activeModel: 'gpt-test',
      meta: { provider: { finishReason: 'stop' } }
    });

    const result = await runMetaPipeline({
      game: 'World of Warcraft',
      prompt: 'Is frost mage still viable this patch?',
      guideUrls: [],
      auditEnabled: false
    });

    expect(result.ok).toBe(true);
    expect(result.mode).toBe('meta');
    expect(result.data.response).toBe('Frost Mage is viable when current tuning supports its control and cleave profile.');
    expect(result.data.response).not.toContain('bounded deterministic fallback');
    const trinityRequest = mockRunTrinityWritingPipeline.mock.calls[0][0] as { input: { prompt: string } };
    expect(trinityRequest.input.prompt).toContain('[MODE]\nmeta');
    expect(trinityRequest.input.prompt).toContain('[GAME]\nWorld of Warcraft');
    expect(trinityRequest.input.prompt).not.toContain('[OUTPUT]');
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
    expect(result.data.response).toContain('Sources unavailable');
    expect(result.data.response).toContain('INTAKE_UPSTREAM_TIMEOUT');
    expect(result.data.response).toContain('Timeout phase: intake.');
    expect(result.data.response).toContain('Limgrave');
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
    expect(result.data.response).toContain('INTAKE_UPSTREAM_TIMEOUT');
    expect(result.data.response).toContain('Timeout phase: reasoning.');
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
    expect(result.data.response).toContain('INTAKE_UPSTREAM_TIMEOUT');
    expect(result.data.response).toContain('Timeout phase: provider.');
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
        runOptions: { watchdogModelTimeoutMs?: number };
      };
    };
    expect(trinityRequest.context.runtimeBudget).toEqual(expect.objectContaining({
      watchdogLimit: 9000,
      safetyBuffer: 500
    }));
    expect(trinityRequest.context.runOptions).toEqual(expect.objectContaining({
      watchdogModelTimeoutMs: 8000
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
        runOptions: { watchdogModelTimeoutMs?: number };
      };
    };
    expect(trinityRequest.context.runtimeBudget).toEqual(expect.objectContaining({
      watchdogLimit: 85_000,
      safetyBuffer: 500
    }));
    expect(trinityRequest.context.runOptions).toEqual(expect.objectContaining({
      watchdogModelTimeoutMs: 15_000
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
        runOptions: { watchdogModelTimeoutMs?: number };
      };
    };
    expect(trinityRequest.context.runtimeBudget).toEqual(expect.objectContaining({
      watchdogLimit: 50_000,
      safetyBuffer: 500
    }));
    expect(trinityRequest.context.runOptions).toEqual(expect.objectContaining({
      watchdogModelTimeoutMs: 15_000
    }));
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

  it('caps user-provided guide URLs before parallel fetches', async () => {
    process.env.ARCANOS_GAMING_WEB_CONTEXT_MAX_URLS = '2';

    const result = await runGuidePipeline({
      prompt: 'Use the linked guides for a direct boss strategy.',
      guideUrl: 'https://example.com/guide-a',
      guideUrls: ['https://example.com/guide-b', 'https://example.com/guide-c'],
      auditEnabled: false
    });

    expect(mockFetchAndClean).toHaveBeenCalledTimes(2);
    expect(mockFetchAndClean).toHaveBeenNthCalledWith(1, 'https://example.com/guide-a', 512);
    expect(mockFetchAndClean).toHaveBeenNthCalledWith(2, 'https://example.com/guide-b', 512);
    expect(result.data.sources).toEqual([
      { url: 'https://example.com/guide-a', snippet: 'clean snippet' },
      { url: 'https://example.com/guide-b', snippet: 'clean snippet' }
    ]);
    const trinityRequest = mockRunTrinityWritingPipeline.mock.calls[0][0] as { input: { prompt: string } };
    expect(trinityRequest.input.prompt).not.toContain('https://example.com/guide-c');
  });

  it('filters blank, invalid, and non-http guide URLs before fetching', async () => {
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

    expect(mockFetchAndClean).toHaveBeenCalledTimes(2);
    expect(mockFetchAndClean).toHaveBeenNthCalledWith(1, 'https://example.com/guide-a', 512);
    expect(mockFetchAndClean).toHaveBeenNthCalledWith(2, 'http://example.com/guide-b', 512);
    expect(result.data.sources).toEqual([
      { url: 'https://example.com/guide-a', snippet: 'clean snippet' },
      { url: 'http://example.com/guide-b', snippet: 'clean snippet' }
    ]);
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

  it('redacts guide URL credentials from returned sources and prompt context', async () => {
    const result = await runGuidePipeline({
      prompt: 'Use the linked guide for a direct boss strategy.',
      guideUrl: 'https://user:pass@example.com/guide',
      guideUrls: [],
      auditEnabled: false
    });

    expect(result.data.sources).toEqual([
      { url: 'https://example.com/guide', snippet: 'clean snippet' }
    ]);
    expect(mockFetchAndClean).toHaveBeenCalledWith('https://example.com/guide', 512);
    expect(mockRunTrinityWritingPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          prompt: expect.stringContaining('[Source 1] https://example.com/guide')
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
      { url: 'https://example.com/guide', error: 'network unavailable' }
    ]);
    const trinityRequest = mockRunTrinityWritingPipeline.mock.calls[0][0] as { input: { prompt: string } };
    expect(trinityRequest.input.prompt).toContain('Guides were provided but no usable snippets were retrieved.');
  });

  it('does not classify unexpected retrieval crashes as retrieval timeouts', async () => {
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
      expect(retrievalFailureLog).toEqual(expect.objectContaining({
        fallbackReason: 'INTAKE_RETRIEVAL_FAILED',
        errorName: 'TypeError'
      }));
      expect(retrievalFailureLog).not.toEqual(expect.objectContaining({
        fallbackReason: 'INTAKE_RETRIEVAL_TIMEOUT'
      }));
      expect(retrievalFailureLog).not.toEqual(expect.objectContaining({
        timeoutPhase: 'retrieval'
      }));
    } finally {
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
