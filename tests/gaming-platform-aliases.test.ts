import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';
import { GAMING_CLEAR_DIMENSIONS } from '../src/shared/gaming/gamingClearPolicy.js';
import type { GamingFreshnessEvidence, GamingReviewedSourceRule } from '../src/shared/gaming/gamingFreshnessCore.js';
import type { GamingStoredKnowledgeContext } from '../src/shared/gaming/gamingStoredEvidenceCore.js';
import type { GamingHybridDependencies } from '../src/services/gamingHybridKnowledge.js';

const fetch = jest.fn();
const trinity = jest.fn();
const audit = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(fetch) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({ getOpenAIClientOrAdapter: () => ({ client: {} }) }));
jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({ runTrinityWritingPipeline: trinity }));
jest.unstable_mockModule('@services/openai/chatFallbacks.js', () => ({ createSingleChatCompletion: audit,
  createChatCompletionWithFallback: jest.fn(), ensureModelMatchesExpectation: jest.fn() }));
const { resolveGamingQuestionScope } = await import('../src/shared/gaming/gamingPlayerContext.js');
const { evaluateGamingGuideApplicability } = await import('../src/shared/gaming/gamingGuideApplicability.js');
const { assessGamingClearEvidence } = await import('../src/shared/gaming/gamingClearEvidence.js');
const { evaluateGamingFreshness, extractGamingFreshnessMetadata } = await import('../src/shared/gaming/gamingFreshnessCore.js');
const { evaluateGamingHybridCandidates } = await import('../src/services/gamingHybridCandidates.js');
const { createGamingHybridWorkflow } = await import('../src/services/gamingHybridKnowledge.js');
const { gamingPlatformEvidenceMatchesRequest, normalizeGamingPlatformIdentity } = await import('../src/shared/gaming/gamingPlatformIdentity.js');

const now = new Date('2026-10-04T12:00:00Z');
const game = 'Elden Ring';
const url = 'https://guides.example.org/controls';
const indexUrl = 'https://publisher.test/updates';
const question = 'What are the controls on PS5?';
const actor = { actorKey: 'platform-alias-fixture', requestId: 'platform-alias-request' };
const prose = 'The Elden Ring controls on PS5 use the cross button to jump and the circle button to dodge. Press the triangle button to interact with the copper gate. Open the control scheme menu to review and change button bindings before play.';
const rules: GamingReviewedSourceRule[] = [
  { id: 'platform-guide', game, hosts: ['guides.example.org'], path: '/controls', pathMatch: 'exact',
    category: 'specialist_guide', currentness: 'none', durableAllowed: true, autoStoreAllowed: false },
  { id: 'platform-index', game, hosts: ['publisher.test'], path: '/updates', pathMatch: 'exact',
    category: 'official_updates', currentness: 'current_index', metadataAdapter: 'labeled-metadata-v1',
    durableAllowed: false, autoStoreAllowed: false }
];
function evidence(platform = 'PS5'): GamingFreshnessEvidence[] {
  return [url, indexUrl].map(sourceUrl => extractGamingFreshnessMetadata({ publicUrl: sourceUrl,
    text: `Game: ${game}\nEdition: base game\nPlatforms: ${platform}\n${sourceUrl === url ? 'Patch: 1.10' : 'Current patch: 1.10'}\nEffective from: 2026-10-03\n${prose}`,
    metadata: { title: `${game} ${sourceUrl === url ? 'controls guide' : 'release index'}` } }, { game }, now, rules));
}
function knowledge(items: GamingFreshnessEvidence[]): GamingStoredKnowledgeContext {
  return { context: prose, sourceKnown: true, sources: items.map(item => ({ sourceId: item.id, url: item.url, game,
    sourceType: item.category, fetchedAt: item.fetchedAt, snippet: prose, freshnessMetadata: { ...item } })),
  evidence: items.map((item, index) => ({ sourceId: item.id, revisionId: `platform-revision-${index}`, recordId: `platform-chunk-${index}`,
    recordType: 'guide', publicUrl: item.url, text: prose, lexicalScore: 1, combinedScore: 1, provenance: { fetchedAt: item.fetchedAt } })) };
}
function serve(platform = 'PS5') {
  fetch.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' }, data: `<html><title>${game} controls guide</title><body><article>
    <p>Game: ${game}. Edition: base game. Platforms: ${platform}.</p><p>${prose}</p></article></body></html>` });
}
const environment = { ARCANOS_GAMING_RAG_ENABLED: 'false', ARCANOS_GAMING_DISCOVERY_ENABLED: 'false', ARCANOS_GAMING_CURATED_SOURCES_JSON: '[]' };
let previous: Record<string, string | undefined>;
beforeEach(() => {
  previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  audit.mockImplementation(async (_client: unknown, params: any) => {
    const data = JSON.parse(params.messages[1].content);
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
      dimensions: Object.fromEntries(GAMING_CLEAR_DIMENSIONS.map(name => [name, { status: 'evaluated', score: 4.5,
        reasonCodes: ['SUPPORTED_FIXTURE'], evidenceRefs: data.evidence.map((chunk: any) => chunk.chunkId).slice(0, 8), unresolvedFacts: [] }])), findings: []
    }) } }] };
  });
  trinity.mockImplementation(async (request: any) => {
    const result = `${prose} [Source 1]`;
    const { assessment } = await request.context.runOptions.gamingClearAnswerAudit(result, {});
    return { result, gamingClearAudit: assessment, meta: { provider: { finishReason: 'stop' } } };
  });
});
afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

describe('question platform aliases preserve acquired applicability', () => {
  it('matches the inferred PlayStation 5 request to an acquired PS5 guide', () => {
    const platform = resolveGamingQuestionScope(question).platform;
    expect(platform).toBe('PlayStation 5');
    const [guide, currentness] = evidence();
    expect(guide.platforms).toEqual(['PS5']);
    expect(evaluateGamingGuideApplicability({ guide, currentness, game, question, platform, now }))
      .toMatchObject({ status: 'verified_current', reasons: ['GUIDE_MATCHES_CURRENT_VERSION'] });
  });

  it.each([question, 'What are the latest controls on PS5?', 'Explain the controls for historical patch 1.10 on PS5.'])
  ('uses matching acquired platform aliases through freshness for %s', prompt => {
    expect(evaluateGamingFreshness({ game, question: prompt, mode: 'guide', platform: 'PlayStation 5',
      ...(prompt.includes('historical') ? { requestedVersion: '1.10' } : {}), evidence: evidence(), now }))
      .toMatchObject({ status: 'current', usable: true });
  });

  it.each([question, 'What are the latest controls on PS5?'])('accepts CLEAR evidence compatibility for %s', prompt => {
    expect(assessGamingClearEvidence({ game, prompt, mode: 'guide', platform: 'PlayStation 5' }, knowledge(evidence()), { now }))
      .toMatchObject({ decision: 'accept', gates: { compatibility: 'verified' } });
  });

  it('admits acquired PS5 evidence after the request parser resolves PlayStation 5', async () => {
    serve();
    const result = await evaluateGamingHybridCandidates({ game, prompt: question, mode: 'guide', protocolVersion: 'gaming-hybrid-v2',
      platform: resolveGamingQuestionScope(question).platform, candidates: [{ url }] }, actor);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].freshness.platforms).toEqual(['PS5']);
  });

  it('reaches audited v2 generation after acquiring a guide with the same platform alias', async () => {
    serve();
    const ingest = jest.fn<any>();
    const workflow = createGamingHybridWorkflow({ retrieve: async () => ({ context: '', sources: [], evidence: [], sourceKnown: false }), ingest });
    const initial = await workflow.query({ contractVersion: 'gaming-hybrid-v2', game, mode: 'guide', question,
      idempotencyKey: 'platform-workflow-query' }, actor);
    expect(initial.body.nextAction).toBe('search');
    const answer = await workflow.candidates({ contractVersion: 'gaming-hybrid-v2', workflowId: initial.body.workflowId,
      expectedRevision: 0, idempotencyKey: 'platform-workflow-source', candidates: [{ url }] }, actor);
    expect(answer).toMatchObject({ status: 200, body: { state: 'answer_ready', nextAction: 'answer', coverageSatisfied: true } });
    expect(answer.body.answer!.response).toContain(prose);
    expect(answer.body.answer!.sources.map(source => source.url)).toEqual([url]);
    expect(trinity).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(ingest).not.toHaveBeenCalled();
  });

  it.each(['PS4', 'PC', 'PS5 Pro', 'console', 'PlayStation'])('keeps acquired %s scope incompatible with PlayStation 5', async platform => {
    const items = evidence(platform);
    expect(evaluateGamingGuideApplicability({ guide: items[0], currentness: items[1], game, question,
      platform: 'PlayStation 5', now })).toMatchObject({ status: 'conflicting', reasons: ['PLATFORM_CONFLICT'] });
    expect(evaluateGamingFreshness({ game, question, platform: 'PlayStation 5', evidence: items, now }))
      .toMatchObject({ usable: false, reasons: expect.arrayContaining(['PLATFORM_MISMATCH']) });
    expect(assessGamingClearEvidence({ game, prompt: question, mode: 'guide', platform: 'PlayStation 5' }, knowledge(items), { now }))
      .toMatchObject({ decision: 'reject', gates: { compatibility: 'conflict' } });
    serve(platform);
    const result = await evaluateGamingHybridCandidates({ game, prompt: question, mode: 'guide', protocolVersion: 'gaming-hybrid-v2',
      platform: 'PlayStation 5', candidates: [{ url }] }, actor);
    expect(result.decisions).toMatchObject([{ decision: 'rejected', reasonCodes: ['PLATFORM_MISMATCH'] }]);
    expect(result.accepted).toHaveLength(0);
  });

  it.each(['What are the controls on PS5 or PC?', 'What are the controls on PS5 or PlayStation 5?',
    'What are the controls on an unknown platform?'])('requires the unresolved request scope for %s', async prompt => {
    expect(resolveGamingQuestionScope(prompt)).not.toHaveProperty('platform');
    const workflow = createGamingHybridWorkflow({ retrieve: async () => ({ context: '', sources: [], evidence: [], sourceKnown: false }) });
    expect(await workflow.query({ contractVersion: 'gaming-hybrid-v2', game, mode: 'guide', question: prompt,
      idempotencyKey: 'platform-unresolved-query' }, actor))
      .toMatchObject({ body: { frontendOutcome: 'clarification_required', reason: 'PLATFORM_REQUIRED' } });
  });

  it('does not derive a missing request platform from acquired PS5 evidence', async () => {
    serve();
    const result = await evaluateGamingHybridCandidates({ game, prompt: 'What are the controls?', mode: 'guide',
      protocolVersion: 'gaming-hybrid-v2', candidates: [{ url }] }, actor);
    expect(result.decisions).toMatchObject([{ decision: 'rejected', reasonCodes: ['PLATFORM_UNVERIFIED'] }]);
    expect(result.accepted).toHaveLength(0);
  });

  it.each([
    ['PlayStation 5', 'PS5'], ['PlayStation 4', 'PS4'], ['Steam', 'PC'], ['  PlayStation\u00a0 5 ', 'ps5'],
    ['Prism Device', 'prism device']
  ])('preserves closed aliases and exact opaque labels for %s and %s', (left, right) => {
    expect(normalizeGamingPlatformIdentity(left)).toBe(normalizeGamingPlatformIdentity(right));
    expect(gamingPlatformEvidenceMatchesRequest([left], right)).toBe(true);
  });

  it.each([['PS4', 'PS5'], ['Nintendo Switch', 'Nintendo Switch 2'], ['PC', 'Steam Deck'],
    ['Xbox', 'Xbox Series X'], ['Prism Device', 'Prism Device 2']])('does not collapse %s into %s', (left, right) => {
    expect(gamingPlatformEvidenceMatchesRequest([left], right)).toBe(false);
  });

  it.each(['constructor', '__proto__'])('keeps the unknown platform label %s opaque', platform => {
    expect(normalizeGamingPlatformIdentity(platform)).toBe(platform);
    expect(gamingPlatformEvidenceMatchesRequest([platform], 'PS5')).toBe(false);
  });
});

describe('platform aliases share v2 acquisition limits while preserving raw operation hashes', () => {
  const query = { contractVersion: 'gaming-hybrid-v2', game, mode: 'guide', question, idempotencyKey: 'platform-budget-query' };
  const empty = { context: '', sources: [], evidence: [], sourceKnown: false };
  function setup(now: () => number = () => Date.parse('2026-10-04T12:00:00Z')) {
    const retrieve = jest.fn<GamingHybridDependencies['retrieve']>(async () => empty);
    const evaluateCandidates = jest.fn<GamingHybridDependencies['evaluateCandidates']>(async input => ({
      knowledge: empty, accepted: [], acquisitionWorkMs: 12_000,
      decisions: input.candidates.map((candidate, submittedIndex) => ({ submittedIndex, url: candidate.url,
        decision: 'rejected', reasonCodes: ['SOURCE_INACCESSIBLE'] })) }));
    return { workflow: createGamingHybridWorkflow({ retrieve, evaluateCandidates, now }), retrieve, evaluateCandidates };
  }

  it('cannot replenish charged or exhausted budgets under a platform alias and a new key', async () => {
    const { workflow, retrieve, evaluateCandidates } = setup();
    const initial = await workflow.query(query, actor);
    const submit = (revision: number) => workflow.candidates({ contractVersion: query.contractVersion, workflowId: initial.body.workflowId,
      expectedRevision: revision, idempotencyKey: `platform-budget-source-${revision}`,
      candidates: [0, 1, 2].map(index => ({ url: `https://guides.example.org/platform-${revision}-${index}` })) }, actor);
    expect((await submit(0)).body).toMatchObject({ revision: 1, discovery: { remainingTotalAcquisitionMs: 12_000 } });
    for (const [index, platform] of ['PS5', 'PlayStation 5'].entries()) {
      expect((await workflow.query({ ...query, platform, idempotencyKey: `platform-budget-charged-${index}` }, actor)).body)
        .toMatchObject({ workflowId: initial.body.workflowId, revision: 1, discovery: { remainingTotalAcquisitionMs: 12_000 } });
    }
    expect((await submit(1)).body).toMatchObject({ revision: 2, nextAction: 'stop', discovery: { remainingTotalAcquisitionMs: 0 } });
    for (const [index, platform] of ['PS5', 'PlayStation 5'].entries()) {
      expect((await workflow.query({ ...query, platform, idempotencyKey: `platform-budget-exhausted-${index}` }, actor)).body)
        .toMatchObject({ workflowId: initial.body.workflowId, revision: 2, nextAction: 'stop', discovery: { remainingTotalAcquisitionMs: 0 } });
    }
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(evaluateCandidates).toHaveBeenCalledTimes(2);
  });

  it('keeps platform alias changes payload-bound for the same idempotency key', async () => {
    const { workflow, retrieve } = setup();
    const explicit = { ...query, platform: 'PS5' };
    await workflow.query(explicit, actor);
    expect(await workflow.query({ ...explicit, platform: 'PlayStation 5' }, actor))
      .toMatchObject({ status: 409, body: { reason: 'IDEMPOTENCY_CONFLICT' } });
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it('keeps different platforms isolated and preserves the original expiry across aliases', async () => {
    let clock = Date.parse('2026-10-04T12:00:00Z');
    const { workflow, retrieve } = setup(() => clock);
    const initial = await workflow.query(query, actor);
    const different = await workflow.query({ ...query, platform: 'PS4', idempotencyKey: 'platform-budget-other-platform' }, actor);
    expect(different.body.workflowId).not.toBe(initial.body.workflowId);
    clock += 9 * 60_000;
    const alias = { ...query, platform: 'PS5', idempotencyKey: 'platform-budget-before-expiry' };
    expect((await workflow.query(alias, actor)).body.workflowId).toBe(initial.body.workflowId);
    clock += 60_000;
    expect(await workflow.query(alias, actor)).toMatchObject({ status: 409, body: { reason: 'WORKFLOW_EXPIRED' } });
    expect(retrieve).toHaveBeenCalledTimes(2);
  });
});
