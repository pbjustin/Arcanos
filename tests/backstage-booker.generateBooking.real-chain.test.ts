import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

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
process.env.GPT5_MODEL = 'gpt-5';
process.env.BOOKER_TOKEN_LIMIT = '1200';

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
      max_output_tokens: 1200,
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

  it('retains the honesty caveat when the user directive requests current external events', async () => {
    await expect(
      generateBooking('Generate three rivalries using current external events.')
    ).resolves.toBe(
      "I can't verify current external state here without live access. Rivalry matrix output."
    );
  });
});
