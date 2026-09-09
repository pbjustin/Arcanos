import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createGamingClearAssessment } from '../src/shared/gaming/gamingClearPolicy.js';
import { GAMING_SOURCE_POLICY_VERSION, GAMING_FRESHNESS_DEFAULTS } from '../src/shared/gaming/gamingFreshnessCore.js';
import type { GamingStoredKnowledgeContext } from '../src/shared/gaming/gamingStoredEvidenceCore.js';
const runTrinityWritingPipeline = jest.fn();
const createSingleChatCompletion = jest.fn();
jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({ runTrinityWritingPipeline }));
jest.unstable_mockModule('@services/openai/chatFallbacks.js', () => ({ createSingleChatCompletion }));
jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({ getOpenAIClientOrAdapter: () => ({ client: {} }) }));
jest.unstable_mockModule('@services/openai/credentialProvider.js', () => ({ getGPT5Model: () => 'gpt-5.1' }));
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
const dimensions = () => Object.fromEntries(['clarity', 'leverage', 'efficiency', 'alignment', 'resilience'].map(name => [name,
  { status: 'evaluated', score: 4.5, reasonCodes: ['SUPPORTED'], evidenceRefs: ['chunk-1'], unresolvedFacts: [] }
])) as Parameters<typeof createGamingClearAssessment>[0]['dimensions'];
let findings: Array<{ code: string; severity: string; evidenceRefs: string[] }> = [];
let tamper = false;
const run = (overrides = {}, evidence = knowledge()) => runGameplayPipeline({ ...input, ...overrides }, { knowledge: evidence, current: true, qualification: '' });

describe('Gaming CLEAR real pipeline delivery decisions', () => {
  afterEach(() => jest.useRealTimers());
  beforeEach(() => {
    jest.clearAllMocks(); findings = []; tamper = false;
    createSingleChatCompletion.mockImplementation(async () => ({ choices: [{ finish_reason: 'stop', message: {
      content: JSON.stringify({ dimensions: dimensions(), findings }) } }], usage: { prompt_tokens: 500, completion_tokens: 150, total_tokens: 650 } }));
    runTrinityWritingPipeline.mockImplementation(async (request: {
      context: { runtimeBudget: never; runOptions: { gamingClearAnswerAudit: (text: string, budget: never) => Promise<{ assessment: unknown }> } }
    }) => {
      const audit = await request.context.runOptions.gamingClearAnswerAudit(answer, request.context.runtimeBudget);
      return { result: tamper ? `${answer}\nInvented mechanic.` : answer, gamingClearAudit: audit.assessment,
        fallbackFlag: false, dryRun: false, activeModel: 'synthetic', meta: { provider: { finishReason: 'stop', responseStatus: 'completed' } } };
    });
  });

  it('accepts supported prose, preserves exact reviewed citations through composer, and hides scores', async () => {
    const result = await run();
    expect(result.data.response).toBe(answer);
    expect(result.data.fallbackReason).toBeUndefined();
    expect(createSingleChatCompletion).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('dimensionScores');
    const composed = ResponseComposerAgent.compose({ intent: { ...input, mode: 'build' } as never, backendEnvelope: result });
    expect(composed.data.response).toBe(answer);
  });

  it('blocks a high-scoring material defect even with auditEnabled false and no retry/repair', async () => {
    findings = [{ code: 'UNSUPPORTED_MECHANIC', severity: 'blocking', evidenceRefs: ['chunk-1'] }];
    const result = await run();
    expect(result.data.response).not.toContain('west valve');
    expect(result.data.fallbackReason).toBe('GAMING_ANSWER_REJECTED');
    expect(result.data.grounding?.groundedInSuppliedEvidence).toBe(false);
    expect(runTrinityWritingPipeline).toHaveBeenCalledTimes(1);
    expect(createSingleChatCompletion).toHaveBeenCalledTimes(1);
  });

  it('uses honest recovery on unavailable audit while provider completion remains independently recorded', async () => {
    createSingleChatCompletion.mockRejectedValue(Object.assign(new Error('synthetic timeout'), { name: 'AbortError' }));
    const result = await run();
    expect(result.data.response).toContain('couldn’t complete a reliable answer');
    expect(result.data.fallbackReason).toBe('GAMING_ANSWER_AUDIT_UNAVAILABLE');
    expect(runTrinityWritingPipeline).toHaveBeenCalledTimes(1);
    expect(createSingleChatCompletion).toHaveBeenCalledTimes(1);
  });

  it('invalidates a pass when returned substantive text changes after the callback', async () => {
    tamper = true;
    const result = await run();
    expect(result.data.response).not.toContain('Invented mechanic');
    expect(result.data.fallbackReason).toBe('GAMING_ANSWER_REJECTED');
    expect(createSingleChatCompletion).toHaveBeenCalledTimes(1);
  });

  it('fails evidence identity before generation and never lets an answer score override it', async () => {
    const evidence = knowledge(); evidence.sources[0].game = 'Other Game';
    const result = await run({}, evidence);
    expect(result.data.fallbackReason).toBe('INTAKE_RETRIEVAL_FAILED');
    expect(runTrinityWritingPipeline).not.toHaveBeenCalled();
    expect(createSingleChatCompletion).not.toHaveBeenCalled();
  });

  it('clarifies missing progress without auditing a fixed question or invoking a provider', async () => {
    const result = await run({ prompt: 'What next in Lantern Vale?', currentArea: undefined, lastCompletedObjective: undefined });
    expect(result.data.response).toContain('Where are you now');
    expect(runTrinityWritingPipeline).not.toHaveBeenCalled();
    expect(createSingleChatCompletion).not.toHaveBeenCalled();
  });

  it('keeps provider failure separate and never attempts an audit without a candidate answer', async () => {
    runTrinityWritingPipeline.mockRejectedValue(new Error('synthetic generation failure'));
    const result = await run();
    expect(result.data.fallbackReason).toBe('GAMING_PROVIDER_ERROR');
    expect(createSingleChatCompletion).not.toHaveBeenCalled();
  });

  it('withholds an otherwise approved answer if its verified currentness expires during the audit', async () => {
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
    createSingleChatCompletion.mockImplementation(async () => {
      jest.setSystemTime(new Date(now.getTime() + 10));
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ dimensions: dimensions(), findings: [] }) } }] };
    });
    const result = await runGameplayPipeline({ ...input, prompt: 'On the current patch, how do I open the return route?' },
      { knowledge: evidence, current: true, qualification: '' });
    expect(createSingleChatCompletion).toHaveBeenCalledTimes(1);
    expect(result.data.fallbackReason).toBe('CURRENT_EVIDENCE_UNAVAILABLE');
    expect(result.data.response).not.toContain('west valve');
  });
});
