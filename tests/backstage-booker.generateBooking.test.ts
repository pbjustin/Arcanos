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
        tokenLimit: 2400,
        body: expect.objectContaining({
          model: 'gpt-5.1-test',
          tokenLimit: 2400,
        }),
      }),
      context: expect.objectContaining({
        client: expect.anything(),
        runOptions: expect.objectContaining({
          answerMode: 'direct',
          internalMode: false,
          strictUserVisibleOutput: true,
          directAnswerModelOverride: 'gpt-5.1-test',
          directAnswerTokenLimitOverride: 2400,
          directAnswerTokenCapOverride: 2400,
          directAnswerUserIntentPrompt: 'Generate three rivalries for RAW after WrestleMania.',
          modelStageTimeoutMs: 40_000,
        }),
      }),
    });
  });

  it('uses a bounded synthesis contract for a full-show review', async () => {
    const prompt = [
      'Review this completed portion of Raw and preserve the established continuity.',
      ...Array.from(
        { length: 24 },
        (_, index) => `Match ${index + 1}: recorded result, rating, rivalry development, and headcanon segment ${index + 1}.`
      ),
      'Punk closed his promo with: "Book the match and write the next chapter."',
      'CM Punk delivered his promo. Becky Lynch vs. Lyra Valkyria and the main event are still to come.'
    ].join('\n');

    await expect(generateBooking(prompt)).resolves.toBe('1. Rivalry matrix output');

    expect(mockRunTrinityWritingPipeline).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        prompt: expect.stringContaining('Return exactly 6 top-level numbered bullets:'),
        tokenLimit: 1600,
        body: expect.objectContaining({ tokenLimit: 1600 })
      }),
      context: expect.objectContaining({
        runOptions: expect.objectContaining({
          directAnswerTokenLimitOverride: 1600,
          directAnswerTokenCapOverride: 2400
        })
      })
    }));
    const dispatchedPrompt = (mockRunTrinityWritingPipeline.mock.calls[0][0] as {
      input: { prompt: string };
    }).input.prompt;
    expect(dispatchedPrompt).toContain('Synthesize instead of recapping');
    expect(dispatchedPrompt).toContain('never invent their results');
    expect(dispatchedPrompt).toContain('Complete the six-bullet review and stop after bullet 6.');
    expect(dispatchedPrompt).not.toContain('Open with a quick human check-in or gut reaction');
    expect(dispatchedPrompt).not.toContain('Highlight consequences, momentum shifts');
  });

  it.each([
    'Write a concise review of this card.',
    'Review Raw.',
    'Generate an assessment of Raw so far.',
    'Provide an evaluation of this booking.',
    'Rate this show and generate a score.',
    'I would like a review of this completed Raw card.',
    'I want your assessment.',
    'I need feedback on this booking.',
    "I'd like you to review this completed show.",
    'I’d like you to review this completed show.',
    'Review my Raw.',
    'Review our SmackDown.',
    'Review the current NXT.',
    "Review this week's Raw.",
    "Review last night's show.",
    'Review the WWE Raw show.',
    'Review Raw tonight.',
    'Please briefly review this completed show.',
    'Please, briefly review this completed show.',
    'Kindly, review this completed show.',
    'Could you kindly assess this card?',
    'Answer directly: review this completed card.',
    'Answer directly, review this completed card.',
    'Answer directly. Review this complete card and keep unfinished matches unresolved.',
    'Answer directly.\nReview this complete card and keep unfinished matches unresolved.',
    'BACKEND REVIEW REQUEST: Review this completed Raw card and preserve continuity.',
    'BACKEND REVIEW REQUEST — Review this completed Raw card and preserve continuity.',
    'BACKEND REVIEW REQUEST, Review this completed Raw card and preserve continuity.',
    'BACKEND REVIEW REQUEST:\nReview this completed Raw card and preserve continuity.',
    'Review this completed Raw card.\nFinish: Cody won clean.',
    'Review this completed Raw card.\nBooking: conservative.',
    'Review this completed Raw card.\nContinue: false.',
    'Review this completed Raw card.\nDraft: final.',
    'Review this completed Raw card.\nBooking Notes: Cody stays strong.',
    'Review this completed Raw card.\nFinish Type: pinfall.',
    'Review this completed Raw card.\nBooking logic was conservative throughout.',
    'Review this completed Raw card.\nPromo: "Book/rebook the main event," Punk said.',
    'Review this completed Raw card.\nRebook the unfinished main event, Punk suggested.'
  ])('recognizes an explicit review request without confusing it for creative generation: %s', async prompt => {
    await expect(generateBooking(prompt)).resolves.toBe('1. Rivalry matrix output');

    expect(mockRunTrinityWritingPipeline).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        prompt: expect.stringContaining('Return exactly 6 top-level numbered bullets:'),
        tokenLimit: 1_600
      }),
      context: expect.objectContaining({
        runOptions: expect.objectContaining({
          answerMode: 'direct',
          internalMode: false,
          directAnswerTokenLimitOverride: 1_600
        })
      })
    }));
  });

  it.each([
    'Review this show and book Becky Lynch vs. Lyra Valkyria next.',
    'Review this show, rebook Becky Lynch vs. Lyra Valkyria next.',
    'Review this show: rewrite the unfinished main event.',
    'Review this show / draft a different closing angle.',
    'Review this show. Then book Becky Lynch vs. Lyra Valkyria next.',
    'Review this show; also draft a different closing angle.',
    'Review this show before rebooking the unfinished main event.',
    'Review this show—rebook the unfinished main event.',
    'Review this show;rebook the unfinished main event.',
    'Review this show but rebook the unfinished main event.',
    'Review this show - rebook the unfinished main event.',
    'Review this show/rebook the unfinished main event.',
    'Review this show, but I also want you to rebook the unfinished main event.',
    "Review this show, but I'd also like you to rebook the unfinished main event.",
    'Review this show, but I’d also like you to rebook the unfinished main event.',
    'Review this show and then you should rebook the unfinished main event.',
    'Review this show, also rebook the unfinished main event.',
    'Review this show.\nRebook: Cody beats Gunther.',
    'Review this show.\nDraft: a new main event.',
    "Review the wrestlers' completed show; rebook the unfinished main event.",
    'Review this completed Raw card.\nRecorded show state.\nRebook the unfinished main event.',
    'Review this completed Raw card.\nRebook the unfinished main event.\nRecorded result: Cody won.',
    'Review this completed show.\nRecorded result one.\nRebook the unfinished main event.\nRecorded result two.',
    'Book Becky Lynch vs. Lyra Valkyria next.\nReview this completed show.',
    'Supplied show-state dialogue follows:\n"Review the match before you judge it," Punk said.',
    'Supplied show-state dialogue follows:\n"We finished the card. Review this show before judging it," Punk said.',
    "Supplied show-state dialogue follows:\n'We finished the card. Review this show before judging it,' Punk said.",
    'Supplied show-state dialogue follows:\n“We finished the card. Review this show before judging it,” Punk said.',
    "Supplied show-state dialogue follows:\n'We can't review this show before booking it,' Punk said.",
    'Supplied show-state dialogue follows:\n‘We can’t review this show before booking it,’ Punk said.',
    '"Review the match before you judge it," Punk said.\nContinue the current booking.',
    '(Review this show before you judge it), Punk said.',
    'Analyze whether Cody should turn heel at WrestleMania.',
    'Evaluate if Cody should retain the title.',
    'Evaluate the Raw main-event finish.',
    'Evaluate the completed Raw main-event finish.',
    "Evaluate the completed Raw women's division.",
    'Evaluate the finish of this show.',
    "Analyze Cody's title reign on Raw.",
    'Give me a recommendation for who should beat Gunther.',
    'Give me a recommendation for the Raw main event.',
    'Give me a recommendation for the PLE main event.',
    'Evaluate the PLE undercard.',
    "Evaluate this PLE women's division.",
    'Give me a recommendation for the completed Raw main event.',
    'Give me a recommendation for the full Raw roster.',
    'Give me a recommendation about booking Cody as champion.',
    'Review the promo from this show.',
    'Generate an analysis of whether Cody should turn heel.',
    "Analyze Cody's title reign on Raw.\n‘The wrestlers’ agreement matters. Review this completed show before judging it,’ Punk said.",
    'Review this completed show.\n‘Good show’ was the verdict. I’d also like you to rebook the main event.',
    'Book Becky Lynch vs. Lyra Valkyria next.\nSegment title: The Review',
    'Continue the current booking.\nPunk asked everyone to evaluate the champion.',
    'Continue the current booking.\nReview: 4/5',
    'Continue the current booking.\n"Review the match before you judge it," Punk said.'
  ])('keeps creative or state-only review language on ordinary booking mode: %s', async prompt => {
    await expect(generateBooking(prompt)).resolves.toBe('Rivalry matrix output');

    expect(mockRunTrinityWritingPipeline).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        prompt: expect.stringContaining('Open with a quick human check-in or gut reaction'),
        tokenLimit: 2_400
      }),
      context: expect.objectContaining({
        runOptions: expect.objectContaining({
          directAnswerTokenLimitOverride: 2_400
        })
      })
    }));
  });

  it('removes review preambles, extra bullets, and sentences beyond the review contract', async () => {
    mockRunTrinityWritingPipeline.mockResolvedValue({
      result: [
        'Quick gut check: the show has a clear spine.',
        '',
        '## Full review',
        '1) J. J. Dillon backed A.J. Styles after the U.S. title match. His decision clarified the feud. This third sentence must be removed.',
        '2) The results protect the right wrestlers. The ratings support the hierarchy.',
        '3) The promo work advances the central conflict. The headcanon segments add connective tissue.',
        '4) The rivalries remain coherent. One transition needs a cleaner motivation.',
        '5) The pacing builds steadily. Move one recap earlier.',
        '6) Becky vs. Lyra remains unresolved. Let the match determine the next branch.',
        '7) This overflow bullet must be removed.'
      ].join('\n')
    });

    await expect(
      generateBooking('Review and assess the completed show state; two matches are still to come.')
    ).resolves.toBe([
      '1. J. J. Dillon backed A.J. Styles after the U.S. title match. His decision clarified the feud.',
      '2. The results protect the right wrestlers. The ratings support the hierarchy.',
      '3. The promo work advances the central conflict. The headcanon segments add connective tissue.',
      '4. The rivalries remain coherent. One transition needs a cleaner motivation.',
      '5. The pacing builds steadily. Move one recap earlier.',
      '6. Becky vs. Lyra remains unresolved. Let the match determine the next branch.'
    ].join('\n'));
  });

  it('normalizes Markdown-wrapped review markers in the Booker output contract', async () => {
    mockRunTrinityWritingPipeline.mockResolvedValue({
      result: [
        '**1. The card has a coherent through-line.**',
        '__2) The results preserve the planned hierarchy.__',
        '**3. The promos sharpen the central conflict.**',
        '__4) The rivalries honor established continuity.__',
        '**5. The pacing builds toward the closing stretch.**',
        '__6) The unfinished matches should determine the next branch.__'
      ].join('\n')
    });

    await expect(generateBooking('Review this completed Raw card.')).resolves.toBe([
      '1. The card has a coherent through-line.',
      '2. The results preserve the planned hierarchy.',
      '3. The promos sharpen the central conflict.',
      '4. The rivalries honor established continuity.',
      '5. The pacing builds toward the closing stretch.',
      '6. The unfinished matches should determine the next branch.'
    ].join('\n'));
  });

  it('normalizes an unnumbered review into bounded numbered prose groups', async () => {
    mockRunTrinityWritingPipeline.mockResolvedValue({
      result: 'Quick gut check: The show has a coherent spine. Punk gives it urgency. The unfinished matches should remain unresolved.'
    });

    await expect(generateBooking('Assess this show so far.')).resolves.toBe([
      '1. The show has a coherent spine. Punk gives it urgency.',
      '2. The unfinished matches should remain unresolved.'
    ].join('\n'));
  });

  it('caps an oversized Booker generation stage timeout below the module deadline', async () => {
    mockGetEnvNumber.mockImplementation((name: string, fallback: number) =>
      name === 'BOOKER_GENERATION_STAGE_TIMEOUT_MS' ? 90_000 : fallback
    );

    await expect(generateBooking('Generate three rivalries for RAW after WrestleMania.')).resolves.toBe('Rivalry matrix output');

    expect(mockRunTrinityWritingPipeline).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({
        runOptions: expect.objectContaining({
          modelStageTimeoutMs: 45_000
        })
      })
    }));
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
          directAnswerTokenLimitOverride: 512,
          directAnswerTokenCapOverride: 2400
        })
      })
    }));
  });

  it('caps an oversized Booker token limit at the Backstage-only ceiling', async () => {
    mockGetEnvNumber.mockImplementation((name: string, fallback: number) =>
      name === 'BOOKER_TOKEN_LIMIT' ? 5_000 : fallback
    );

    await expect(generateBooking('Generate three rivalries for RAW after WrestleMania.')).resolves.toBe('Rivalry matrix output');

    expect(mockRunTrinityWritingPipeline).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        tokenLimit: 2400,
        body: expect.objectContaining({ tokenLimit: 2400 })
      }),
      context: expect.objectContaining({
        runOptions: expect.objectContaining({
          directAnswerTokenLimitOverride: 2400,
          directAnswerTokenCapOverride: 2400
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
        input: expect.objectContaining({ tokenLimit: 2400 }),
        context: expect.objectContaining({
          runOptions: expect.objectContaining({
            directAnswerTokenLimitOverride: 2400,
            directAnswerTokenCapOverride: 2400
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
