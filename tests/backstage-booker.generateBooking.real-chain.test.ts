import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const responsesCreate = jest.fn();
const query = jest.fn();
const saveMemory = jest.fn();
const storePattern = jest.fn();
const recordTrinityJudgedFeedback = jest.fn();
const { AUDITED_TRANSIENT_READ_QUERIES } =
  await import('../src/core/db/transientReadRegistry.js');

jest.unstable_mockModule('@services/safety/configIntegrity.js', () => ({
  assertProtectedConfigIntegrity: jest.fn(() => 'fixture-integrity-hash')
}));

jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: () => ({
    adapter: null,
    client: { responses: { create: responsesCreate } }
  })
}));

jest.unstable_mockModule('@core/db/index.js', () => ({
  AUDITED_TRANSIENT_READ_QUERIES,
  applyBackstageRosterMutation: jest.fn(),
  applyBackstageStorylineMutation: jest.fn(),
  isTransactionCommitAmbiguousError: jest.fn(() => false),
  query,
  saveMemory,
  transaction: jest.fn()
}));

jest.unstable_mockModule('@services/memoryAware.js', () => ({
  getMemoryContext: jest.fn(() => ({
    relevantEntries: [],
    contextSummary: 'No memory context available.',
    accessLog: []
  })),
  storePattern
}));

jest.unstable_mockModule('../src/core/logic/trinityJudgedFeedback.js', () => ({
  recordTrinityJudgedFeedback
}));

jest.unstable_mockModule('@services/selfImprove/selfHealingV2.js', () => ({
  getTrinitySelfHealingMitigation: () => ({
    activeAction: null,
    stage: null,
    bypassFinalStage: false,
    forceDirectAnswer: false,
    verified: false
  }),
  noteTrinityMitigationOutcome: jest.fn(),
  recordTrinityStageFailure: jest.fn(() => 'retry_once')
}));

jest.unstable_mockModule('@services/selfImprove/controller.js', () => ({
  runSelfImproveCycle: jest.fn()
}));

const originalGpt5Model = process.env.GPT5_MODEL;
const originalBookerTokenLimit = process.env.BOOKER_TOKEN_LIMIT;
const originalBookerGenerationStageTimeoutMs = process.env.BOOKER_GENERATION_STAGE_TIMEOUT_MS;
process.env.GPT5_MODEL = 'gpt-5';
process.env.BOOKER_TOKEN_LIMIT = '2400';
process.env.BOOKER_GENERATION_STAGE_TIMEOUT_MS = '40000';

const { generateBooking } = await import('../src/services/backstage-booker.js');

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

afterAll(() => {
  restoreEnv('GPT5_MODEL', originalGpt5Model);
  restoreEnv('BOOKER_TOKEN_LIMIT', originalBookerTokenLimit);
  restoreEnv(
    'BOOKER_GENERATION_STAGE_TIMEOUT_MS',
    originalBookerGenerationStageTimeoutMs
  );
});

describe('backstage-booker generateBooking real provider chain', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    query.mockResolvedValue({ rows: [] });
    saveMemory.mockResolvedValue(undefined);
    recordTrinityJudgedFeedback.mockResolvedValue({
      enabled: false,
      attempted: false,
      source: 'clear_audit',
      reason: 'fixture'
    });
    responsesCreate.mockResolvedValue({
      id: 'resp_backstage_booking',
      model: 'gpt-5.1',
      status: 'completed',
      output_text: 'Rivalry matrix output.',
      output: [],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15
      }
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('preserves the Booker model and token budget through the Responses request', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          data: { name: 'Current external events' },
          created_at: new Date('2026-08-16T00:00:00.000Z')
        }]
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      generateBooking('Generate three rivalries for RAW after WrestleMania.')
    ).resolves.toBe('Rivalry matrix output.');

    expect(responsesCreate).toHaveBeenCalledTimes(1);
    const [request, options] = responsesCreate.mock.calls[0] as unknown as [
      Record<string, unknown>,
      { signal?: AbortSignal }
    ];
    expect(request).toEqual(expect.objectContaining({
      model: 'gpt-5.1',
      max_output_tokens: 2400,
      reasoning: { effort: 'none' }
    }));
    expect(request).not.toHaveProperty('reasoning_effort');
    expect(JSON.stringify(request.input)).toContain(
      'Generate three rivalries for RAW after WrestleMania.'
    );
    expect(JSON.stringify(request.input)).toContain('Current external events');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal?.aborted).toBe(false);
  });

  it('completes a near-limit full-state review through the bounded provider path', async () => {
    const providerReview = [
      '1. The show has a coherent through-line.',
      '2. The results and ratings establish the hierarchy.',
      '3. The promos and segments advance the central conflict.',
      '4. The rivalries preserve established continuity.',
      '5. The pacing needs one earlier transition.',
      '6. The unfinished matches should determine the next branch.'
    ].join('\n');
    responsesCreate.mockResolvedValueOnce({
      id: 'resp_backstage_extended_booking',
      model: 'gpt-5.1',
      status: 'completed',
      output_text: providerReview,
      output: [],
      usage: {
        input_tokens: 1_100,
        output_tokens: 1_500,
        total_tokens: 2_600
      }
    });
    const directive = 'BACKEND REVIEW REQUEST:\nEvaluate this complete Raw card and its established continuity.\n';
    const trailer = '\nEND SHOW STATE';
    const stateSeed = [
      'Recorded match result, rating, headcanon segment, and rivalry development.',
      'Punk said "book the match and write the next chapter."',
      'Becky Lynch vs. Lyra Valkyria remains unfinished.'
    ].join(' ');
    const stateLength = 9_800 - directive.length - trailer.length;
    const fullShowReviewPrompt = directive + stateSeed
      .repeat(Math.ceil(stateLength / stateSeed.length))
      .slice(0, stateLength) + trailer;
    expect(fullShowReviewPrompt).toHaveLength(9_800);

    await expect(
      generateBooking(fullShowReviewPrompt)
    ).resolves.toBe(providerReview);

    const [request] = responsesCreate.mock.calls[0] as unknown as [
      Record<string, unknown>
    ];
    expect(request).toEqual(expect.objectContaining({
      model: 'gpt-5.1',
      max_output_tokens: 1600
    }));
    const serializedInput = JSON.stringify(request.input);
    expect(serializedInput).toContain('Return exactly 6 top-level numbered bullets:');
    expect(serializedInput).toContain('Synthesize instead of recapping');
    expect(serializedInput).toContain('Punk said \\"book the match and write the next chapter.\\"');
    expect(serializedInput).not.toContain('Open with a quick human check-in or gut reaction');
  });

  it('continues to reject partial output that exhausts the extended Booker budget', async () => {
    responsesCreate.mockResolvedValueOnce({
      id: 'resp_backstage_incomplete_booking',
      model: 'gpt-5.1',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output_text: 'Partial booking review that must not be returned.',
      output: [],
      usage: {
        input_tokens: 1_100,
        output_tokens: 1_600,
        total_tokens: 2_700
      }
    });
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await generateBooking('Review a complete nine-match Raw card and its established continuity.');
      throw new Error('Expected generateBooking to reject partial provider output.');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Booking generation failed');
      expect((error as Error & { cause?: unknown }).cause).toEqual(expect.objectContaining({
        code: 'OPENAI_COMPLETION_INCOMPLETE',
        incompleteReason: 'max_output_tokens'
      }));
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('retains the honesty caveat when the user directive requests current external events', async () => {
    await expect(
      generateBooking('Generate three rivalries using current external events.')
    ).resolves.toBe(
      "I can't verify current external state here without live access. Rivalry matrix output."
    );
  });

  it('allows the provider to finish after the generic twelve-second direct-answer deadline', async () => {
    jest.useFakeTimers();
    responsesCreate.mockImplementationOnce(
      () => new Promise(resolve => {
        setTimeout(() => resolve({
          id: 'resp_backstage_slow_booking',
          model: 'gpt-5.1',
          status: 'completed',
          output_text: 'Long-form booking output.',
          output: [],
          usage: {
            input_tokens: 20,
            output_tokens: 12,
            total_tokens: 32
          }
        }), 13_000);
      })
    );

    const bookingPromise = generateBooking(
      'Generate a complete long-form Raw card with coherent story progression.'
    );
    const completionExpectation = expect(bookingPromise).resolves.toBe(
      'Long-form booking output.'
    );

    await jest.advanceTimersByTimeAsync(13_001);

    await completionExpectation;
    const [, options] = responsesCreate.mock.calls[0] as unknown as [
      Record<string, unknown>,
      { signal?: AbortSignal }
    ];
    expect(options.signal?.aborted).toBe(false);
  });
});
