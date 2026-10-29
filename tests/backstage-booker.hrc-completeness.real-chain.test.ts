import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { BACKSTAGE_BOOKER_CLEAR_GENERATION_POLICY_MARKER } from '../src/services/backstageBookerClear.js';
import { countWords } from '../src/shared/text/countWords.js';

// Keep the actual Booker action, Trinity writing pipeline, CLEAR policy,
// normalization, HRC wrapper/core, and response validators in this regression.
const responsesCreate = jest.fn();
const query = jest.fn();
const poolClientQuery = jest.fn();
const poolClientRelease = jest.fn();
const poolConnect = jest.fn();
const saveMemory = jest.fn();
const storePattern = jest.fn();
const recordTrinityJudgedFeedback = jest.fn();
const { AUDITED_TRANSIENT_READ_QUERIES } = await import('../src/core/db/transientReadRegistry.js');

jest.unstable_mockModule('@services/safety/configIntegrity.js', () => ({
  assertProtectedConfigIntegrity: jest.fn(() => 'fixture-integrity-hash'),
}));
jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: () => {
    const client = { responses: { create: responsesCreate } };
    return { adapter: client, client };
  },
}));
jest.unstable_mockModule('@core/db/index.js', () => ({
  AUDITED_TRANSIENT_READ_QUERIES,
  applyBackstageRosterMutation: jest.fn(),
  applyBackstageStorylineMutation: jest.fn(),
  isTransactionCommitAmbiguousError: jest.fn(() => false),
  getPool: () => ({ connect: poolConnect, query }),
  query,
  saveMemory,
  transaction: jest.fn(),
}));
jest.unstable_mockModule('@services/memoryAware.js', () => ({
  getMemoryContext: jest.fn(() => ({ relevantEntries: [], contextSummary: 'No memory context available.', accessLog: [] })),
  storePattern,
}));
jest.unstable_mockModule('../src/core/logic/trinityJudgedFeedback.js', () => ({ recordTrinityJudgedFeedback }));
jest.unstable_mockModule('@services/selfImprove/selfHealingV2.js', () => ({
  getTrinitySelfHealingMitigation: () => ({
    activeAction: null, stage: null, bypassFinalStage: false,
    forceDirectAnswer: false, verified: false,
  }),
  noteTrinityMitigationOutcome: jest.fn(),
  recordTrinityStageFailure: jest.fn(() => 'retry_once'),
}));
jest.unstable_mockModule('@services/selfImprove/controller.js', () => ({ runSelfImproveCycle: jest.fn() }));
// This fixture selects the existing durable legacy authority. The Notion
// authority/isolation suites cover its separate current-complete admission.
jest.unstable_mockModule('../src/services/backstageNotionAuthority.js', () => ({
  isBackstageNotionAuthorityDatabaseError: jest.fn(() => false),
  isBackstageNotionAuthorityEnforced: jest.fn(async () => false),
  readBackstageNotionAuthorityConfiguration: jest.fn(() => ({ status: 'absent' })),
  resolveEffectiveBackstageNotionAuthorityRoot: jest.fn(async () => null),
}));

const authorityModel = 'ft:gpt-4.1:synthetic:backstage-authority';
const environmentNames = [
  'FINETUNED_MODEL_ID', 'GPT5_MODEL', 'BOOKER_TOKEN_LIMIT',
  'BOOKER_WORKER_TOKEN_LIMIT', 'BOOKER_GENERATION_STAGE_TIMEOUT_MS',
  'ARCANOS_BACKSTAGE_NOTION_ACCESS_TOKEN', 'ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_JSON',
] as const;
const originalEnvironment = Object.fromEntries(environmentNames.map(name => [name, process.env[name]]));
process.env.FINETUNED_MODEL_ID = authorityModel;
process.env.GPT5_MODEL = 'gpt-5';
process.env.BOOKER_TOKEN_LIMIT = '2400';
process.env.BOOKER_WORKER_TOKEN_LIMIT = '6000';
process.env.BOOKER_GENERATION_STAGE_TIMEOUT_MS = '40000';
delete process.env.ARCANOS_BACKSTAGE_NOTION_ACCESS_TOKEN;
delete process.env.ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_JSON;

const { default: BackstageBookerModule } = await import('../src/services/backstage-booker.js');
const { runWithBackstageProtectedQueuedExecution } = await import('../src/services/backstageNotionEnrichmentAuthorization.js');

afterAll(() => {
  for (const name of environmentNames) {
    if (originalEnvironment[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnvironment[name];
  }
});

function providerResponse(outputText: string) {
  return {
    id: 'resp_booker_hrc_completeness_fixture', model: authorityModel,
    status: 'completed', output_text: outputText, output: [],
    usage: { input_tokens: 100, output_tokens: 200, total_tokens: 300 },
  };
}

function invokeHrcBooking(prompt: string) {
  return runWithBackstageProtectedQueuedExecution(true, () =>
    BackstageBookerModule.actions.generateBookingWithHRC({
      universeId: 'hrc-real-chain-fixture', prompt,
    })
  );
}

describe('Booker HRC completeness through the actual generation and audit chain', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    responsesCreate.mockReset().mockRejectedValue(new Error('Unexpected extra inference call.'));
    query.mockResolvedValue({ rows: [] });
    poolClientQuery.mockResolvedValue({ rows: [] });
    poolClientRelease.mockReturnValue(undefined);
    poolConnect.mockResolvedValue({ query: poolClientQuery, release: poolClientRelease });
    saveMemory.mockResolvedValue(undefined);
    recordTrinityJudgedFeedback.mockResolvedValue({ enabled: false, attempted: false, source: 'clear_audit', reason: 'fixture' });
  });

  it('rejects a material unmet instruction despite HRC fidelity 0.99 and resilience 0.98', async () => {
    const prompt = 'Write a short non-canon backstage promo for Logan Paul responding to Dragon Lee becoming his Night of Champions challenger, with production directions and dialogue.';
    const candidate = '[Camera tightens on Logan Paul.] Logan Paul says, “The crowd can chant all night. I own this spotlight, and nobody takes it away.” [He leaves the interview position. Cut to black.]';
    responsesCreate
      .mockResolvedValueOnce(providerResponse(candidate))
      .mockResolvedValueOnce(providerResponse(JSON.stringify({
        fidelity: 0.99, resilience: 0.98,
        verdict: 'The dialogue never responds to the named challenger or upcoming match.',
        requirementsSatisfied: false,
        unmetRequirements: ['Missing the requested response to Dragon Lee becoming the Night of Champions challenger.'],
      })));

    await expect(invokeHrcBooking(prompt)).rejects.toMatchObject({
      code: 'BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE', retryable: false,
    });
    expect(responsesCreate).toHaveBeenCalledTimes(2);
    expect(saveMemory).not.toHaveBeenCalled();
    expect(storePattern).not.toHaveBeenCalled();
  });

  it('rejects legacy score-only HRC success as unverified requirement evaluation', async () => {
    responsesCreate
      .mockResolvedValueOnce(providerResponse('[Camera holds.] Logan Paul says, “Dragon Lee earned his chance, but Night of Champions is where I intend to keep my title.” [Cut to black.]'))
      .mockResolvedValueOnce(providerResponse(JSON.stringify({ fidelity: 0.99, resilience: 0.98, verdict: 'Consistent fiction.' })));

    await expect(invokeHrcBooking('Write a short non-canon Logan Paul promo about Dragon Lee at Night of Champions, with dialogue and production cues.'))
      .rejects.toMatchObject({ code: 'BACKSTAGE_BOOKER_INTEGRITY_FAILED', retryable: false });
    expect(responsesCreate).toHaveBeenCalledTimes(2);
  });

  it('uses HRC to reject production directions that omit all explicitly requested dialogue', async () => {
    const prompt = 'Generate a 200-word backstage promo featuring Logan Paul responding to Dragon Lee becoming his Night of Champions challenger. Preserve authoritative Raw continuity, include production directions and dialogue, and run protected CLEAR with dedicated HRC. Non-canon.';
    const candidate = 'Creative direction: Logan Paul studies footage of Dragon Lee earning the Night of Champions match. The camera tracks him at the Raw interview backdrop while he raises his championship and smiles. Hold the close-up, then fade to black.';
    responsesCreate
      .mockResolvedValueOnce(providerResponse(candidate))
      .mockResolvedValueOnce(providerResponse(JSON.stringify({
        fidelity: 0.99, resilience: 0.98,
        verdict: 'Only creative and production directions were delivered; the requested spoken promo is absent.',
        requirementsSatisfied: false,
        unmetRequirements: ['Missing all requested Logan Paul dialogue; production directions alone do not deliver the requested promo.'],
      })));

    await expect(invokeHrcBooking(prompt)).rejects.toMatchObject({
      code: 'BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE', retryable: false,
    });
    expect(responsesCreate).toHaveBeenCalledTimes(2);
  });

  it.each(['as a 200-word promo', 'in about 200 words', 'in approximately 200 words'])(
    'preserves all generated dialogue under the direct-answer presentation path: %s', async requestedLength => {
      const prompt = `Answer directly. Generate a backstage promo ${requestedLength} featuring Logan Paul responding to Dragon Lee becoming his Night of Champions challenger. Preserve authoritative Raw continuity, include production directions and dialogue, and run protected CLEAR with dedicated HRC. Non-canon.`;
      const dialogue = [
        'Dragon Lee earned a ticket to Night of Champions, congratulations, but earning the right to stand across from me does not mean he is ready for the pressure of carrying this championship while the entire world waits for one mistake and every camera searches for the smallest sign of doubt.',
        'Every highlight he makes buys him another round of applause, every headline I make changes the conversation, and when that bell rings he will discover the difference between chasing a moment and owning the spotlight before the cameras even arrive that nobody admits.',
        'Bring the speed, bring the courage, bring every person who believes this is your night, because when the noise settles I intend to walk away with the title and leave you wondering how your biggest opportunity became my next highlight while the crowd finally understands exactly who controlled this story.',
        'I see the confidence, I respect the work, and I understand why the audience believes in him, but belief does not carry this championship through that final bell and the opportunity he earned comes with a lesson he will remember after cameras leave tonight.',
      ];
      const candidate = [
        'Creative direction: Kay keeps Logan arrogant while showing the anxiety beneath his carefully rehearsed confidence, framing his answer as private challenge rather than public promise.',
        '## Backstage promo: the challenger arrives',
        '[CAMERA: Track slowly toward Logan beside the Raw interview backdrop while crew clear the corridor behind him, settle into a tight close-up as he turns from the monitor showing Dragon Lee, and hold the shot while he adjusts the championship resting across his shoulder.]',
        '---',
        ...dialogue.flatMap((line, index) => [`> ${index === 0 ? '**Logan Paul:** ' : ''}"${line}"`, '>']),
        '[Logan taps the faceplate, gives the lens a narrow smile, and walks away as the camera holds the empty corridor before fading to black.]',
      ].join('\n');
      expect(countWords(candidate)).toBe(297);
      responsesCreate
        .mockResolvedValueOnce({
          ...providerResponse(candidate),
          usage: { input_tokens: 100, output_tokens: 441, total_tokens: 541 },
        })
        .mockResolvedValueOnce(providerResponse(JSON.stringify({
          fidelity: 0.99, resilience: 0.98, verdict: 'Complete non-canon promo with the requested dialogue and production content.',
          requirementsSatisfied: true, unmetRequirements: [],
        })));

      const result = await invokeHrcBooking(prompt);
      expect(result.storyline).toBe(candidate);
      for (const spokenParagraph of dialogue) expect(result.storyline).toContain(spokenParagraph);
      expect(result.hrc).toEqual({ fidelity: 0.99, resilience: 0.98, verdict: 'Complete non-canon promo with the requested dialogue and production content.' });
      expect(result.protectedGeneration).toMatchObject({ official: true, protectedGenerationCompleted: true });
      expect(responsesCreate).toHaveBeenCalledTimes(2);
      const [hrcRequest] = responsesCreate.mock.calls[1] as [{ input: Array<{ content: Array<{ text: string }> }>; store: boolean }];
      expect(JSON.parse(hrcRequest.input[1].content[0].text)).toMatchObject({ originalRequest: prompt, candidate });
      expect(hrcRequest.store).toBe(false);
      expect(saveMemory).not.toHaveBeenCalled();
      expect(storePattern).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['screenplay', '[CAMERA: Close on Logan Paul.]\nLOGAN PAUL: “Dragon Lee earned the chance. At Night of Champions, I intend to show him why I hold this championship.”\n[He raises the title. Cut to black.]'],
    ['separate-line speaker', '[CAMERA: Close on Logan Paul.]\nLOGAN PAUL\nDragon Lee earned this chance at Night of Champions. That title stays right here.\n[Cut to black.]'],
    ['em-dash speaker', 'LOGAN PAUL — Dragon Lee earned this chance at Night of Champions. That title stays right here.\n[CAMERA: Fade to black.]'],
    ['mixed cue and speaker line', 'CAMERA: Tight shot — LOGAN PAUL: Dragon Lee earned this chance at Night of Champions. That title stays right here.'],
    ['bracketed speech', '[LOGAN PAUL: Dragon Lee earned this chance at Night of Champions. That title stays right here.]\n[CAMERA: Fade to black.]'],
    ['parenthetical speech', '(LOGAN PAUL: Dragon Lee earned this chance at Night of Champions. That title stays right here.)\n[CAMERA: Fade to black.]'],
    ['prose', 'The camera closes on Logan Paul as he raises his title. “Dragon Lee earned his chance,” he says. “At Night of Champions, I intend to prove that chasing my championship is easier than taking it.” He walks away as the picture fades.'],
    ['200-word Markdown', [
      'Creative direction: Kay keeps Logan arrogant while letting the challenger expose the anxiety underneath his bravado.',
      '## Backstage promo: a challenger earned',
      '[CAMERA: Track toward Logan beside the Raw interview backdrop. Settle into a close-up as he turns from the monitor showing Dragon Lee and addresses the lens.]',
      '> **Logan Paul:** “Dragon Lee earned a ticket to Night of Champions, congratulations, but earning the right to stand across from me does not mean he is ready for the pressure of carrying this championship while the world waits for one mistake.”',
      '>',
      '> “Every highlight he makes buys him another round of applause. Every headline I make changes the conversation. When that bell rings, he will discover the difference between chasing a moment and owning the spotlight before the cameras even arrive.”',
      '>',
      '> “Bring the speed, bring the courage, bring every person who believes this is your night, because when the noise settles I intend to walk away with the title and leave you wondering how your biggest opportunity became my next highlight.”',
      '[Logan taps the faceplate, gives the lens a narrow smile, and walks out of frame. Hold the empty corridor, then cut away.]',
    ].join('\n')],
  ])('preserves complete %s content and reviews the same request and selected evidence once', async (format, candidate) => {
    const length = format === '200-word Markdown' ? '200-word' : 'short';
    const prompt = `Write a ${length} non-canon Logan Paul promo responding to Dragon Lee becoming his Night of Champions challenger. Include dialogue and production cues.`;
    responsesCreate
      .mockResolvedValueOnce(providerResponse(candidate))
      .mockResolvedValueOnce(providerResponse(JSON.stringify({
        fidelity: 0.99, resilience: 0.98, verdict: 'Complete requested promo.',
        requirementsSatisfied: true, unmetRequirements: [],
      })));

    const result = await invokeHrcBooking(prompt);
    expect(result).toEqual({
      universeId: 'hrc-real-chain-fixture', storyline: expect.any(String),
      hrc: { fidelity: 0.99, resilience: 0.98, verdict: 'Complete requested promo.' },
      protectedGeneration: {
        version: 1, protected: true, protectedGenerationCompleted: true,
        official: true, continuityVerified: true, authority: 'legacy_postgresql',
        snapshotStatus: 'not_applicable', fallbackUsed: false, fallbackPermitted: false,
      },
    });
    const substantiveText = (text: string) => text.replace(/\*\*/g, '').replace(/\s+/g, ' ');
    expect(substantiveText(result.storyline)).toBe(substantiveText(candidate));
    expect(responsesCreate).toHaveBeenCalledTimes(2);
    const [generationRequest] = responsesCreate.mock.calls[0] as [{ input: unknown }];
    const [hrcRequest] = responsesCreate.mock.calls[1] as [{ input: Array<{ content: Array<{ text: string }> }>; store: boolean }];
    const evaluationInput = JSON.parse(hrcRequest.input[1].content[0].text);
    expect(evaluationInput.originalRequest).toBe(prompt);
    expect(evaluationInput.candidate).toBe(result.storyline);
    expect(evaluationInput.continuityEvidence).toContain('hrc-real-chain-fixture');
    const serializedGeneration = JSON.stringify(generationRequest.input);
    expect(serializedGeneration).toContain(BACKSTAGE_BOOKER_CLEAR_GENERATION_POLICY_MARKER);
    expect(serializedGeneration).toContain('Spotlight');
    expect(serializedGeneration).toContain('hrc-real-chain-fixture');
    const selectedContinuity = evaluationInput.continuityEvidence
      .match(/<<CURRENT_ROSTER>>[\s\S]*?(?=<<RESPONSE_STYLE>>)/u)?.[0];
    expect(selectedContinuity).toBeDefined();
    expect(serializedGeneration).toContain(JSON.stringify(selectedContinuity).slice(1, -1));
    expect(hrcRequest.store).toBe(false);
    expect(JSON.stringify(result)).not.toContain('requirementsSatisfied');
    expect(JSON.stringify(result)).not.toContain('unmetRequirements');
    expect(saveMemory).not.toHaveBeenCalled();
    expect(storePattern).not.toHaveBeenCalled();
  });
});
