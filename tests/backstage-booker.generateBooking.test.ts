import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRunTrinityWritingPipeline = jest.fn();
const mockGetGPT5Model = jest.fn();
const mockGetOpenAIClientOrAdapter = jest.fn();
const mockQuery = jest.fn();
const mockSaveMemory = jest.fn();
const mockGetEnv = jest.fn();
const mockGetEnvNumber = jest.fn();
const mockGetEnvBoolean = jest.fn();
const { AUDITED_TRANSIENT_READ_QUERIES } =
  await import('../src/core/db/transientReadRegistry.js');

jest.unstable_mockModule('@services/openai.js', () => ({
  getGPT5Model: mockGetGPT5Model,
  getDefaultModel: jest.fn(() => 'gpt-4.1-mini'),
  getFallbackModel: jest.fn(() => 'gpt-4.1'),
  getComplexModel: jest.fn(() => 'gpt-4.1'),
  hasValidAPIKey: jest.fn(() => true),
  default: {
    getGPT5Model: mockGetGPT5Model
  }
}));

jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({
  runTrinityWritingPipeline: mockRunTrinityWritingPipeline
}));

jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: mockGetOpenAIClientOrAdapter
}));

jest.unstable_mockModule('@core/db/index.js', () => ({
  AUDITED_TRANSIENT_READ_QUERIES,
  applyBackstageRosterMutation: jest.fn(),
  applyBackstageStorylineMutation: jest.fn(),
  isTransactionCommitAmbiguousError: jest.fn(() => false),
  query: mockQuery,
  saveMemory: mockSaveMemory,
  transaction: jest.fn()
}));

jest.unstable_mockModule('@platform/runtime/env.js', () => ({
  getEnv: mockGetEnv,
  getEnvNumber: mockGetEnvNumber,
  getEnvBoolean: mockGetEnvBoolean
}));

const { generateBooking } = await import('../src/services/backstage-booker.js');

describe('backstage-booker generateBooking', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetEnv.mockReturnValue(undefined);
    mockGetEnvNumber.mockImplementation((_name: string, fallback: number) => fallback);
    mockGetEnvBoolean.mockReturnValue(false);
    mockGetGPT5Model.mockReturnValue('gpt-5.1-test');
    mockGetOpenAIClientOrAdapter.mockReturnValue({ client: { responses: {} } });
    mockQuery.mockResolvedValue({ rows: [] });
    mockSaveMemory.mockResolvedValue(undefined);
    mockRunTrinityWritingPipeline.mockResolvedValue({
      result: 'Rivalry matrix output',
      activeModel: 'trinity-model',
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
        sourceEndpoint: 'backstage-booker.generateBooking',
        classification: 'writing',
      },
    });
  });

  it('uses the shared GPT-5 model and default output budget when USER_GPT_ID is absent', async () => {
    await expect(generateBooking('Generate three rivalries for RAW after WrestleMania.')).resolves.toBe('Rivalry matrix output');

    expect(mockRunTrinityWritingPipeline).toHaveBeenCalledWith({
      input: expect.objectContaining({
        prompt: expect.stringContaining('Generate three rivalries for RAW after WrestleMania.'),
        moduleId: 'BACKSTAGE:BOOKER',
        sourceEndpoint: 'backstage-booker.generateBooking',
        requestedAction: 'generateBooking',
        tokenLimit: 1200,
        body: expect.objectContaining({
          model: 'gpt-5.1-test',
          tokenLimit: 1200,
        }),
      }),
      context: expect.objectContaining({
        client: expect.anything(),
        runOptions: expect.objectContaining({
          answerMode: 'direct',
          strictUserVisibleOutput: true,
          directAnswerModelOverride: 'gpt-5.1-test',
          directAnswerTokenLimitOverride: 1200,
          directAnswerUserIntentPrompt: 'Generate three rivalries for RAW after WrestleMania.',
        }),
      }),
    });
  });

  it('normalizes the obsolete base GPT-5 alias to the GPT-5.1 direct-answer baseline', async () => {
    mockGetGPT5Model.mockReturnValue('gpt-5');

    await expect(generateBooking('Generate three rivalries for RAW after WrestleMania.')).resolves.toBe('Rivalry matrix output');

    expect(mockRunTrinityWritingPipeline).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        body: expect.objectContaining({ model: 'gpt-5.1' })
      }),
      context: expect.objectContaining({
        runOptions: expect.objectContaining({
          directAnswerModelOverride: 'gpt-5.1'
        })
      })
    }));
  });

  it('falls back to the GPT-5.1 direct-answer baseline when the shared model is blank', async () => {
    mockGetGPT5Model.mockReturnValue('   ');

    await expect(generateBooking('Generate three rivalries for RAW after WrestleMania.')).resolves.toBe('Rivalry matrix output');

    expect(mockRunTrinityWritingPipeline).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        body: expect.objectContaining({ model: 'gpt-5.1' })
      }),
      context: expect.objectContaining({
        runOptions: expect.objectContaining({
          directAnswerModelOverride: 'gpt-5.1'
        })
      })
    }));
  });

  it('does not treat the legacy user-facing GPT ID as a provider model', async () => {
    mockGetEnv.mockImplementation((name: string) =>
      name === 'USER_GPT_ID' ? 'backstage-booker' : undefined
    );
    mockGetGPT5Model.mockReturnValue('gpt-5.6-terra');

    await expect(generateBooking('Generate three rivalries for RAW after WrestleMania.')).resolves.toBe('Rivalry matrix output');

    expect(mockRunTrinityWritingPipeline).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        body: expect.objectContaining({ model: 'gpt-5.6-terra' })
      }),
      context: expect.objectContaining({
        runOptions: expect.objectContaining({
          directAnswerModelOverride: 'gpt-5.6-terra'
        })
      })
    }));
  });

  it('preserves an explicit positive Booker token limit for ordinary generation', async () => {
    mockGetEnvNumber.mockImplementation((name: string, fallback: number) =>
      name === 'BOOKER_TOKEN_LIMIT' ? 512 : fallback
    );

    await expect(generateBooking('Generate three rivalries for RAW after WrestleMania.')).resolves.toBe('Rivalry matrix output');

    expect(mockRunTrinityWritingPipeline).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ tokenLimit: 512 }),
      context: expect.objectContaining({
        runOptions: expect.objectContaining({
          directAnswerTokenLimitOverride: 512
        })
      })
    }));
  });

  it.each([0, -1])(
    'uses the default Booker token limit when the configured value is %s',
    async (configuredTokenLimit) => {
      mockGetEnvNumber.mockImplementation((name: string, fallback: number) =>
        name === 'BOOKER_TOKEN_LIMIT' ? configuredTokenLimit : fallback
      );

      await expect(generateBooking('Generate three rivalries for RAW after WrestleMania.')).resolves.toBe('Rivalry matrix output');

      expect(mockRunTrinityWritingPipeline).toHaveBeenCalledWith(expect.objectContaining({
        input: expect.objectContaining({ tokenLimit: 1200 }),
        context: expect.objectContaining({
          runOptions: expect.objectContaining({
            directAnswerTokenLimitOverride: 1200
          })
        })
      }));
    }
  );

  it('short-circuits exact-literal anti-simulation prompts before OpenAI executes', async () => {
    await expect(
      generateBooking(
        'Answer directly. Do not simulate, role-play, or describe a hypothetical run. Say exactly: backstage-check.'
      )
    ).resolves.toBe('backstage-check');

    expect(mockRunTrinityWritingPipeline).not.toHaveBeenCalled();
  });

  it('switches to direct-answer execution mode for anti-simulation booking prompts', async () => {
    await expect(
      generateBooking(
        'Answer directly. Do not simulate, role-play, or describe a hypothetical booking meeting. Book a WWE Raw title-picture rivalry map for the next month.'
      )
    ).resolves.toBe('Rivalry matrix output');

    expect(mockRunTrinityWritingPipeline).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        prompt: expect.stringContaining('<<EXECUTION_MODE>>'),
        tokenLimit: 400,
      }),
      context: expect.objectContaining({
        runOptions: expect.objectContaining({
          directAnswerTokenLimitOverride: 400,
        })
      })
    }));
    const dispatchedPrompt = (mockRunTrinityWritingPipeline.mock.calls[0][0] as { input: { prompt: string } }).input.prompt;
    expect(dispatchedPrompt).not.toContain('<<PERSONA>>');
    expect(dispatchedPrompt).toContain('Return only 5 top-level numbered bullets.');
    expect(dispatchedPrompt).toContain('No sub-bullets, no production notes, no consequences section, and no meta commentary.');
    expect(dispatchedPrompt).not.toContain('Keep the response direct, non-theatrical, and free of role-play framing.');
  });

  it('removes preambles and trims direct-answer output to the requested short bullet count', async () => {
    mockRunTrinityWritingPipeline.mockResolvedValue({
      result: [
        'Gut read: center Punk vs. Drew immediately.',
        '',
        '---',
        '',
        '## 4-Week Raw Title-Picture Spine (5 Bullets)',
        '',
        '1. Quick gut check: with this six we lean into a chaotic multi-man scene that still keeps Punk vs. Drew at the center.',
        '2. **Week 2 - Crown the contender**',
        '   - Gunther wins the eliminator.',
        '3. **Week 3 - Punk and Drew implode**',
        '   - Seth stirs the chaos.',
        '4. **Week 4 - Gunther steps in**',
        '   - Contract signing turns physical.',
        '5. **PLE go-home hook**',
        '   - End with a three-way stare down.',
        '6. **Overflow**',
        '   - This should be removed.'
      ].join('\n')
    });

    await expect(
      generateBooking(
        'Answer directly. Do not simulate, role-play, or describe a hypothetical booking meeting. Book a WWE Raw title-picture rivalry for the next four weeks in five short bullets.'
      )
    ).resolves.toBe(
      [
        '1. with this six we lean into a chaotic multi-man scene that still keeps Punk vs. Drew at the center.',
        '2. Week 2 - Crown the contender',
        '3. Week 3 - Punk and Drew implode',
        '4. Week 4 - Gunther steps in',
        '5. PLE go-home hook'
      ].join('\n')
    );

    const dispatchedPrompt = (mockRunTrinityWritingPipeline.mock.calls[0][0] as { input: { prompt: string } }).input.prompt;
    expect(dispatchedPrompt).toContain('Return only 5 top-level numbered bullets.');
    expect(dispatchedPrompt).toContain('No preamble, headings, divider lines, or conclusion.');
    expect(dispatchedPrompt).toContain('Each bullet must be one compact sentence.');
    expect(mockRunTrinityWritingPipeline).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        tokenLimit: 240
      }),
      context: expect.objectContaining({
        runOptions: expect.objectContaining({
          directAnswerTokenLimitOverride: 240
        })
      })
    }));
  });

  it('preserves the provider failure as the internal cause of the public booking error', async () => {
    const providerError = Object.assign(
      new Error('OpenAI completion ended before a complete answer was available.'),
      { code: 'OPENAI_COMPLETION_INCOMPLETE', incompleteReason: 'max_output_tokens' }
    );
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockRunTrinityWritingPipeline.mockRejectedValueOnce(providerError);

    try {
      await generateBooking('Generate three rivalries for RAW after WrestleMania.');
      throw new Error('Expected generateBooking to reject.');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Booking generation failed');
      expect((error as Error & { cause?: unknown }).cause).toBe(providerError);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
