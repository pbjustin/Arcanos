import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { GAMING_SOURCE_POLICY_VERSION, GAMING_FRESHNESS_DEFAULTS } from '../src/shared/gaming/gamingFreshnessCore.js';
import type { GamingStoredKnowledgeContext } from '../src/shared/gaming/gamingStoredEvidenceCore.js';
import { GAMING_UNVERIFIED_GUIDE_WARNING } from '../src/shared/gaming/gamingFreshnessDisposition.js';
import { hasBoundGamingClearAnswer } from '../src/shared/gaming/gamingClearAnswerBinding.js';
import { hasBoundGamingPresentedAnswer } from '../src/shared/gaming/gamingPresentedAnswerBinding.js';
const runTrinityWritingPipeline = jest.fn();
const createSingleChatCompletion = jest.fn();
jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({ runTrinityWritingPipeline }));
jest.unstable_mockModule('@services/openai/chatFallbacks.js', () => ({ createSingleChatCompletion }));
jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({ getOpenAIClientOrAdapter: () => ({ client: {} }) }));
jest.unstable_mockModule('@services/openai/credentialProvider.js', () => ({
  getClearAuditModel: () => 'gpt-6-luna', getClearAuditEscalationModel: () => 'gpt-6.1-sol'
}));
jest.unstable_mockModule('@services/gamingSourceIngestion.js', () => ({ buildStoredGamingKnowledgeContext: jest.fn() }));
const { runGameplayPipeline } = await import('../src/services/gamingPipeline.js');
const { ResponseComposerAgent } = await import('../src/services/gamingAgents.js');

const text = 'Lantern Vale guide: after restoring the Tide Hall pump, turn the west valve to open the return route. The valve is beside the pump.';
const answer = '**Open the return route.**\n\nTurn the west valve beside the pump. [Source 1]';
const input = { game: 'Lantern Vale', mode: 'guide' as const, prompt: 'How do I open the return route?', guideUrls: [], auditEnabled: false,
  currentArea: 'Tide Hall', lastCompletedObjective: 'restored pump', spoilerMode: 'none' as const, answerDepth: 'concise' as const };
const knowledge = () => ({ context: `[Source 1]\n${text}`, sourceKnown: true,
  sources: [{ sourceId: 'source-1', url: 'https://example.com/guide', sourceType: 'guide', game: 'Lantern Vale', fetchedAt: '2026-09-09T12:00:00.000Z', snippet: text }],
  evidence: [{ sourceId: 'source-1', revisionId: 'revision-1', recordId: 'chunk-1', recordType: 'guide' as const,
    publicUrl: 'https://example.com/guide', text, lexicalScore: 1, combinedScore: 1, provenance: { fetchedAt: '2026-09-09T12:00:00.000Z' } }] });
const presentationPolicy = 'gaming-clear-presentation/v1' as const;
const completedProvider = { provider: { finishReason: 'stop', responseStatus: 'completed' } };
function presented(result: string) {
  return { result, gamingPresentationPolicy: presentationPolicy, fallbackFlag: false,
    dryRun: false, activeModel: 'synthetic', meta: completedProvider };
}
let candidateAnswer = answer;
const run = (overrides = {}, evidence = knowledge()) => runGameplayPipeline({ ...input, ...overrides }, { knowledge: evidence, current: true, qualification: '' });

describe('Gaming CLEAR presentation and independent pipeline delivery checks', () => {
  afterEach(() => jest.useRealTimers());
  beforeEach(() => {
    jest.clearAllMocks();
    candidateAnswer = answer;
    createSingleChatCompletion.mockImplementation(() => { throw new Error('The retired Gaming answer audit was dispatched.'); });
    runTrinityWritingPipeline.mockImplementation(() => presented(candidateAnswer));
  });

  it('preserves exact presented citations through the composer without a legacy approval marker', async () => {
    const result = await run();
    expect(result.data.response).toBe(answer);
    expect(result.data.fallbackReason).toBeUndefined();
    expect(createSingleChatCompletion).not.toHaveBeenCalled();
    expect(hasBoundGamingPresentedAnswer(result.data)).toBe(true);
    expect(hasBoundGamingClearAnswer(result.data)).toBe(false);
    expect(JSON.stringify(result)).not.toContain('dimensionScores');
    const composed = ResponseComposerAgent.compose({ intent: { ...input, mode: 'build' } as never, backendEnvelope: result });
    expect(composed.data.response).toBe(answer);
  });

  it.each(['EU', 'US', undefined])('retains region %s through the independent applicability gate', async region => {
    const evidence: GamingStoredKnowledgeContext = knowledge();
    evidence.sources[0].freshnessMetadata = { id: 'source-1', game: input.game, url: evidence.sources[0].url,
      regions: ['EU'], fetchedAt: evidence.sources[0].fetchedAt, verifiedAt: evidence.sources[0].fetchedAt,
      metadataConfidence: 'content_extracted' };
    const result = await runGameplayPipeline({ ...input, prompt: 'Region-specific: How do I open the return route?', ...(region ? { region } : {}) },
      { knowledge: evidence, current: true, qualification: '' });
    if (region === 'EU') {
      expect(result.data.response).toBe(answer);
      expect(result.data.fallbackReason).toBeUndefined();
      expect(createSingleChatCompletion).not.toHaveBeenCalled();
      expect(runTrinityWritingPipeline).toHaveBeenCalledWith(expect.objectContaining({
        context: expect.objectContaining({ runOptions: expect.objectContaining({ gamingPresentationPolicy: presentationPolicy }) })
      }));
    } else {
      expect(result.data.fallbackReason).toBe('INTAKE_RETRIEVAL_FAILED');
      expect(runTrinityWritingPipeline).not.toHaveBeenCalled();
      expect(createSingleChatCompletion).not.toHaveBeenCalled();
    }
  });

  it('allows harmless acquired regional metadata without expanding applicability', async () => {
    const evidence: GamingStoredKnowledgeContext = knowledge();
    evidence.sources[0].freshnessMetadata = { id: 'source-1', game: input.game, url: evidence.sources[0].url,
      regions: ['EU'], fetchedAt: evidence.sources[0].fetchedAt, verifiedAt: evidence.sources[0].fetchedAt,
      metadataConfidence: 'content_extracted' };
    const result = await run({}, evidence);
    expect(result.data.response).toBe(answer);
    expect(result.data.fallbackReason).toBeUndefined();
    expect(runTrinityWritingPipeline).toHaveBeenCalledTimes(1);
    expect(createSingleChatCompletion).not.toHaveBeenCalled();
  });

  it('delivers awkward wording even if a historical result includes a failing quality assessment', async () => {
    candidateAnswer = 'That west valve beside the pump, turn it for the return route. [Source 1]';
    runTrinityWritingPipeline.mockImplementationOnce(() => ({
      ...presented(candidateAnswer),
      gamingClearAudit: { decision: 'reject', findings: [{ code: 'PROFILE_FLOOR_NOT_MET', severity: 'blocking' }] }
    }));
    const result = await run();
    expect(result.data.response).toBe(candidateAnswer);
    expect(hasBoundGamingPresentedAnswer(result.data)).toBe(true);
    expect(hasBoundGamingClearAnswer(result.data)).toBe(false);
    expect(runTrinityWritingPipeline).toHaveBeenCalledTimes(1);
    expect(createSingleChatCompletion).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('PROFILE_FLOOR_NOT_MET');
  });

  it('withholds completed text lacking server-owned presentation provenance', async () => {
    runTrinityWritingPipeline.mockResolvedValueOnce({ result: answer, meta: completedProvider });
    const result = await run();
    expect(result.data.response).not.toContain('Turn the west valve');
    expect(result.data.fallbackReason).toBeDefined();
    expect(hasBoundGamingPresentedAnswer(result.data)).toBe(false);
    expect(runTrinityWritingPipeline).toHaveBeenCalledTimes(1);
    expect(createSingleChatCompletion).not.toHaveBeenCalled();
  });

  it.each(['[Other guide](mailto:other@example.com)', '[Other guide][ref]\n\n[ref]: mailto:other@example.com'])(
    'withholds a non-source Markdown link even when the answer also cites a selected source (%s)', async link => {
    candidateAnswer = `${answer} ${link}`;
    const result = await run();
    expect(result.data.fallbackReason).toBeDefined();
    expect(hasBoundGamingPresentedAnswer(result.data)).toBe(false);
    expect(result.data.response).not.toContain('mailto:');
  });

  it('invalidates presentation attestation if the exact candidate changes after integrity checks', async () => {
    const result = await run();
    expect(hasBoundGamingPresentedAnswer(result.data)).toBe(true);
    result.data.response += '\nInvented mechanic.';
    expect(hasBoundGamingPresentedAnswer(result.data)).toBe(false);
    expect(createSingleChatCompletion).not.toHaveBeenCalled();
  });

  it('fails evidence identity before generation', async () => {
    const evidence = knowledge(); evidence.sources[0].game = 'Other Game';
    const result = await run({}, evidence);
    expect(result.data.fallbackReason).toBe('INTAKE_RETRIEVAL_FAILED');
    expect(runTrinityWritingPipeline).not.toHaveBeenCalled();
    expect(createSingleChatCompletion).not.toHaveBeenCalled();
  });

  it('clarifies missing progress without invoking a provider', async () => {
    const result = await run({ prompt: 'What next in Lantern Vale?', currentArea: undefined, lastCompletedObjective: undefined });
    expect(result.data.response).toContain('Where are you now');
    expect(runTrinityWritingPipeline).not.toHaveBeenCalled();
    expect(createSingleChatCompletion).not.toHaveBeenCalled();
  });

  it('keeps provider failure separate from completed presentation', async () => {
    runTrinityWritingPipeline.mockRejectedValue(new Error('synthetic generation failure'));
    const result = await run();
    expect(result.data.fallbackReason).toBe('GAMING_PROVIDER_ERROR');
    expect(createSingleChatCompletion).not.toHaveBeenCalled();
  });

  it('admits grounded early stat guidance in build mode without an advisory grant or current-patch claim', async () => {
    const passage = 'Lantern Vale starting Sentinel stat guidance: raise the Endurance attribute first for a larger stamina reserve. This initial stat allocation supports blocking while learning the starting area.';
    const evidence = knowledge();
    evidence.context = `[Source 1]\n${passage}`;
    evidence.sources[0].snippet = passage;
    evidence.evidence[0].text = passage;
    candidateAnswer = 'Raise Endurance first for a larger stamina reserve when blocking. [Source 1]';
    const result = await runGameplayPipeline({ ...input, mode: 'build', currentArea: undefined,
      lastCompletedObjective: undefined, prompt: 'Which attribute should a starting Sentinel raise first?' },
    { knowledge: evidence, current: false, qualification: '' });
    expect(result.data.fallbackReason).toBeUndefined();
    expect(result.data.response).toBe(candidateAnswer);
    expect(runTrinityWritingPipeline).toHaveBeenCalledTimes(1);
    expect(createSingleChatCompletion).not.toHaveBeenCalled();
    expect(hasBoundGamingPresentedAnswer(result.data)).toBe(true);
  });

  it('generates once from internally authorized advisory gameplay and binds the visible warning to the presented answer', async () => {
    const result = await runGameplayPipeline({ ...input, prompt: 'Which return route strategy should I use?', mode: 'build' },
      { knowledge: knowledge(), current: false, advisoryFreshnessAllowed: true, qualification: GAMING_UNVERIFIED_GUIDE_WARNING });
    expect(result.data.response).toBe(`${GAMING_UNVERIFIED_GUIDE_WARNING}\n\n${answer}`);
    expect(result.data.fallbackReason).toBeUndefined();
    expect(runTrinityWritingPipeline).toHaveBeenCalledTimes(1);
    expect(createSingleChatCompletion).not.toHaveBeenCalled();
    expect(hasBoundGamingPresentedAnswer(result.data)).toBe(true);
    expect(hasBoundGamingPresentedAnswer(Object.assign(result.data, { response: answer }))).toBe(false);
  });

  it('rejects fabricated current compatibility even when the gameplay recommendation has adequate coverage', async () => {
    candidateAnswer = `${answer}\n\nThis strategy is compatible with the latest patch.`;
    const result = await runGameplayPipeline({ ...input, prompt: 'Which return route strategy should I use?', mode: 'build' },
      { knowledge: knowledge(), current: false, advisoryFreshnessAllowed: true, qualification: GAMING_UNVERIFIED_GUIDE_WARNING });
    expect(result.data.fallbackReason).toBeDefined();
    expect(hasBoundGamingPresentedAnswer(result.data)).toBe(false);
    expect(result.data.response).not.toContain('compatible with the latest patch');
    expect(runTrinityWritingPipeline).toHaveBeenCalledTimes(1);
    expect(createSingleChatCompletion).not.toHaveBeenCalled();
  });

  it('blocks contradictory gameplay before generation despite the advisory grant', async () => {
    const evidence: GamingStoredKnowledgeContext = knowledge();
    const contradictory = { ...evidence.sources[0], sourceId: 'source-2', url: 'https://example.com/other-guide' };
    const metadata = { game: input.game, policyVersion: GAMING_SOURCE_POLICY_VERSION, patch: '1.0',
      fetchedAt: evidence.sources[0].fetchedAt, verifiedAt: evidence.sources[0].fetchedAt,
      category: 'specialist_guide', authority: 'specialist', currentness: 'none',
      durableAllowed: true, autoStoreAllowed: false, metadataConfidence: 'content_extracted' };
    evidence.sources[0].freshnessMetadata = { ...metadata, id: 'source-1', url: evidence.sources[0].url, mechanicValues: { 'valve turns': '2' } };
    contradictory.freshnessMetadata = { ...metadata, id: 'source-2', url: contradictory.url, mechanicValues: { 'valve turns': '3' } };
    evidence.sources.push(contradictory);
    const result = await runGameplayPipeline({ ...input, prompt: 'Which return route strategy should I use?', mode: 'build' },
      { knowledge: evidence, current: false, advisoryFreshnessAllowed: true, qualification: GAMING_UNVERIFIED_GUIDE_WARNING });
    expect(result.data.fallbackReason).toBeDefined();
    expect(runTrinityWritingPipeline).not.toHaveBeenCalled();
    expect(createSingleChatCompletion).not.toHaveBeenCalled();
  });

  it('withholds an otherwise eligible answer if verified currentness expires during generation', async () => {
    jest.useFakeTimers();
    const now = new Date('2026-09-09T12:00:00.000Z');
    jest.setSystemTime(now);
    const checked = new Date(now.getTime() - GAMING_FRESHNESS_DEFAULTS.patch_sensitive + 1).toISOString();
    const evidence: GamingStoredKnowledgeContext = knowledge();
    const metadata = { game: input.game, policyVersion: GAMING_SOURCE_POLICY_VERSION, patch: '1.0',
      fetchedAt: checked, verifiedAt: checked, effectiveFrom: '2026-09-01T00:00:00.000Z',
      category: 'specialist_guide', authority: 'specialist', currentness: 'none',
      durableAllowed: true, autoStoreAllowed: false, metadataConfidence: 'content_extracted' };
    evidence.sources[0].freshnessMetadata = { ...metadata, id: 'source-1', url: evidence.sources[0].url };
    evidence.sources.push({ sourceId: 'index-1', url: 'https://example.com/current', sourceType: 'official_updates',
      game: input.game, fetchedAt: checked, snippet: 'Current patch: 1.0.',
      freshnessMetadata: { ...metadata, id: 'index-1', url: 'https://example.com/current',
        authority: 'official', category: 'official_updates', currentness: 'current_index', currentPatch: '1.0' } });
    evidence.evidence!.push({ ...evidence.evidence![0], sourceId: 'index-1', revisionId: 'index-revision',
      recordId: 'index-1:verification', publicUrl: 'https://example.com/current', text: 'Current patch: 1.0.' });
    runTrinityWritingPipeline.mockImplementation(() => {
      jest.setSystemTime(new Date(now.getTime() + 10));
      return presented(candidateAnswer);
    });
    const result = await runGameplayPipeline({ ...input, prompt: 'On the current patch, how do I open the return route?' },
      { knowledge: evidence, current: true, qualification: '' });
    expect(createSingleChatCompletion).not.toHaveBeenCalled();
    expect(result.data.fallbackReason).toBe('CURRENT_EVIDENCE_UNAVAILABLE');
    expect(result.data.response).not.toContain('west valve');
  });
});
