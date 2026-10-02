import { describe, expect, it, jest } from '@jest/globals';
import { createGamingHybridWorkflow } from '../src/services/gamingHybridKnowledge.js';
import { GAMING_HYBRID_CONTRACT_VERSION as contractVersion } from '../src/shared/gaming/gamingHybridContract.js';
import { GAMING_SOURCE_POLICY_VERSION, type GamingFreshnessEvidence } from '../src/shared/gaming/gamingFreshnessCore.js';
import { gamingAnswerClaimsVerifiedCurrentness, resolveGamingFreshnessDisposition } from '../src/shared/gaming/gamingFreshnessDisposition.js';
import type { GamingStoredKnowledgeContext } from '../src/services/gamingStoredKnowledge.js';

const now = Date.now();
const actor = { actorKey: 'synthetic-advisory-strictness', requestId: 'advisory-strictness-test' };
const guideId = '36000000-0000-4000-8000-000000000001';
const indexId = '36000000-0000-4000-8000-000000000002';
const guideUrl = 'https://guides.example.org/samurai-bleed-build';
const indexUrl = 'https://en.bandainamcoent.eu/elden-ring/elden-ring/news';
const passage = 'For an Elden Ring Samurai bleed build, equip a katana and improve vigor and dexterity. This Samurai bleed build guide covers equipment, stats and weapon strategy. The available guide recommends a katana for the bleed mechanic and explains its grounded build recommendation.';
const query = { contractVersion, idempotencyKey: 'advisory-strictness-query', game: 'Elden Ring',
  mode: 'build' as const, question: 'bleed Samurai build', storagePolicy: 'transient_only' as const };
const empty: GamingStoredKnowledgeContext = { context: '', sources: [], evidence: [], sourceKnown: false };

function sourceMetadata(id = guideId, url = guideUrl): GamingFreshnessEvidence {
  return { id, url, game: query.game, policyVersion: GAMING_SOURCE_POLICY_VERSION, category: 'specialist_guide',
    authority: 'specialist', currentness: 'none', durableAllowed: true, autoStoreAllowed: false,
    fetchedAt: new Date(now).toISOString(), verifiedAt: new Date(now).toISOString(),
    metadataConfidence: 'content_extracted', patch: '1.10', platforms: ['all'], regions: ['all'] };
}

function setup(rejection = 'INSUFFICIENT_EXTRACTION') {
  const metadata = sourceMetadata();
  const guide = { candidateId: guideId, publicUrl: guideUrl, contentHash: 'a'.repeat(64), expiresAt: now + 600_000,
    document: { text: passage }, freshness: metadata };
  const knowledge: GamingStoredKnowledgeContext = { context: '', sourceKnown: true,
    sources: [{ game: query.game, sourceId: guideId, url: guideUrl, sourceType: 'specialist_guide',
      fetchedAt: metadata.fetchedAt, snippet: passage }],
    evidence: [{ sourceId: guideId, revisionId: 'strict-guide-revision', recordId: 'strict-guide-record',
      recordType: 'build', publicUrl: guideUrl, text: passage, lexicalScore: 1, combinedScore: 1,
      provenance: { fetchedAt: metadata.fetchedAt } }] };
  const evaluateCandidates = jest.fn(async (input: any) => input.discoveryType === 'currentness_verification'
    ? { decisions: [{ decision: 'rejected', reasonCodes: [rejection] }], accepted: [], knowledge: empty }
    : { decisions: [{ candidateId: guideId, decision: 'accepted_transient', reasonCodes: ['VALIDATED_RELEVANT_CONTENT'] }],
      accepted: [guide], knowledge });
  const generate = jest.fn(async (_input: unknown, prepared: any) => ({ ok: true, route: 'gaming', mode: 'build',
    data: { response: 'Use the Samurai bleed build described by the accepted guide. [1]',
      sources: prepared.knowledge.sources, grounding: { groundingStatus: 'grounded' } } } as any));
  const ingest = jest.fn();
  const workflow = createGamingHybridWorkflow({ retrieve: async () => empty,
    evaluateCandidates: evaluateCandidates as any, generate, ingest: ingest as any, now: () => now });
  const submit = (workflowId: string, discoveryType: 'gameplay_evidence' | 'currentness_verification') => ({
    contractVersion, workflowId, discoveryType, idempotencyKey: `strictness-${discoveryType}`,
    candidates: [{ url: discoveryType === 'gameplay_evidence' ? guideUrl : indexUrl }] });
  return { workflow, generate, ingest, evaluateCandidates, guide, knowledge, submit };
}

async function continueCurrentness(test: ReturnType<typeof setup>) {
  const initial = await test.workflow.query(query, actor);
  const gameplay = await test.workflow.candidates(test.submit(initial.body.workflowId!, 'gameplay_evidence'), actor);
  expect(gameplay.body.nextAction).toBe('verify_currentness');
  expect(test.generate).not.toHaveBeenCalled();
  const request = test.submit(initial.body.workflowId!, 'currentness_verification');
  return { request, result: await test.workflow.candidates(request, actor) };
}

describe('advisory Gaming currentness keeps strict evidence boundaries', () => {
  it('qualifies intact gameplay after extraction failure without extra generation or durable writes', async () => {
    const test = setup();
    const { request, result } = await continueCurrentness(test);
    expect(result.body).toMatchObject({ state: 'answer_ready', nextAction: 'answer', evidenceSelected: true,
      freshnessStatus: 'unverified' });
    expect(result.body.applicabilityStatus).not.toBe('verified_current');
    expect(result.body.answer?.response).toMatch(/(?:could not be verified|unverified).*may be outdated/iu);
    expect(await test.workflow.candidates(request, actor)).toEqual(result);
    expect(test.generate).toHaveBeenCalledTimes(1);
    expect(test.evaluateCandidates).toHaveBeenCalledTimes(2);
    expect(test.ingest).not.toHaveBeenCalled();
  });

  it.each(['SOURCE_INACCESSIBLE', 'URL_BLOCKED', 'REDIRECT_NOT_ALLOWED', 'RESOLVED_SOURCE_IDENTITY_MISMATCH',
    'SOURCE_INSTRUCTIONS_REJECTED', 'SOURCE_USE_RESTRICTED', 'GAME_MISMATCH', 'QUESTION_COVERAGE_INSUFFICIENT'])
  ('does not turn currentness rejection %s into advisory generation', async rejection => {
    const test = setup(rejection);
    const { request, result } = await continueCurrentness(test);
    expect(result.body.answer).toBeUndefined();
    expect(result.body.nextAction).toBe('stop');
    expect(test.generate).not.toHaveBeenCalled();
    expect(await test.workflow.candidates(request, actor)).toEqual(result);
    expect((await test.workflow.candidates({ ...request, idempotencyKey: 'strictness-extra-currentness' }, actor)).status).toBe(409);
    expect(test.ingest).not.toHaveBeenCalled();
  });

  it('blocks material conflicts between accepted gameplay guides after ordinary currentness failure', async () => {
    const test = setup();
    test.guide.freshness.mechanicValues = { 'bleed buildup': '50' };
    const secondId = '36000000-0000-4000-8000-000000000003';
    const secondUrl = 'https://guides.example.org/second-samurai-bleed-build';
    const second = { ...test.guide, candidateId: secondId, publicUrl: secondUrl,
      freshness: { ...sourceMetadata(secondId, secondUrl), mechanicValues: { 'bleed buildup': '90' } } };
    test.knowledge.sources.push({ ...test.knowledge.sources[0], sourceId: secondId, url: secondUrl });
    test.knowledge.evidence!.push({ ...test.knowledge.evidence![0], sourceId: secondId, publicUrl: secondUrl,
      recordId: 'strict-second-guide-record', revisionId: 'strict-second-guide-revision' });
    test.evaluateCandidates.mockImplementation(async (input: any) => input.discoveryType === 'currentness_verification'
      ? { decisions: [{ decision: 'rejected', reasonCodes: ['INSUFFICIENT_EXTRACTION'] }], accepted: [], knowledge: empty }
      : { decisions: [{ candidateId: guideId, decision: 'accepted_transient', reasonCodes: ['VALIDATED_RELEVANT_CONTENT'] }],
        accepted: [test.guide, second], knowledge: test.knowledge } as any);
    const initial = await test.workflow.query(query, actor);
    const gameplay = await test.workflow.candidates(test.submit(initial.body.workflowId!, 'gameplay_evidence'), actor);
    const result = gameplay.body.nextAction === 'verify_currentness'
      ? await test.workflow.candidates(test.submit(initial.body.workflowId!, 'currentness_verification'), actor) : gameplay;
    expect(result.body.answer).toBeUndefined();
    expect(test.generate).not.toHaveBeenCalled();
    expect(test.ingest).not.toHaveBeenCalled();
  });

  it('blocks reliable official mechanic conflicts even when guide applicability is reported stale', async () => {
    const test = setup();
    test.guide.freshness.mechanicValues = { 'bleed buildup': '50' };
    const index = { ...test.guide, candidateId: indexId, publicUrl: indexUrl, contentHash: 'b'.repeat(64),
      freshness: { ...sourceMetadata(indexId, indexUrl), category: 'official_updates' as const, authority: 'official' as const,
        currentness: 'current_index' as const, ruleId: 'elden-ring-update-index', currentPatch: '1.10',
        effectiveFrom: new Date(now - 86_400_000).toISOString(), mechanicValues: { 'bleed buildup': '90' } } };
    test.evaluateCandidates.mockImplementation(async (input: any) => input.discoveryType === 'currentness_verification'
      ? { decisions: [{ candidateId: indexId, decision: 'accepted_transient', reasonCodes: ['VALIDATED_APPLICABILITY_SOURCE'] }],
        accepted: [index], knowledge: empty }
      : { decisions: [{ candidateId: guideId, decision: 'accepted_transient', reasonCodes: ['VALIDATED_RELEVANT_CONTENT'] }],
        accepted: [test.guide], knowledge: test.knowledge } as any);
    const { result } = await continueCurrentness(test);
    expect(result.body.answer).toBeUndefined();
    expect(result.body.nextAction).toBe('stop');
    expect(test.generate).not.toHaveBeenCalled();
  });

  it('rejects a generated verified-current claim despite an advisory warning', async () => {
    const test = setup();
    test.generate.mockImplementation(async (_input: unknown, prepared: any) => ({ ok: true, route: 'gaming', mode: 'build',
      data: { response: 'This Samurai bleed build is verified current and compatible with the latest patch. [1]',
        sources: prepared.knowledge.sources, grounding: { groundingStatus: 'grounded' } } } as any));
    const { result } = await continueCurrentness(test);
    expect(result.body).toMatchObject({ reason: 'GENERATION_UNAVAILABLE', freshnessStatus: 'unverified' });
    expect(result.body.answer).toBeUndefined();
    expect(test.generate).toHaveBeenCalledTimes(1);
  });

  it('keeps a mixed patch-notes request blocking after currentness extraction fails', async () => {
    const test = setup();
    const datedNotes = `${passage} This guide can inform a recommendation and summarize dated patch notes from patch 1.10. The notes describe katana bleed changes; latest patch applicability is unknown.`;
    test.guide.document.text = datedNotes;
    test.knowledge.sources[0].snippet = datedNotes;
    test.knowledge.evidence![0].text = datedNotes;
    const initial = await test.workflow.query({ ...query,
      question: 'Recommend a bleed Samurai build and summarize the latest patch notes.' }, actor);
    const gameplay = await test.workflow.candidates(test.submit(initial.body.workflowId!, 'gameplay_evidence'), actor);
    expect(gameplay.body.nextAction).toBe('verify_currentness');
    const result = await test.workflow.candidates(test.submit(initial.body.workflowId!, 'currentness_verification'), actor);
    expect(result.body.nextAction).toBe('stop');
    expect(result.body.answer).toBeUndefined();
    expect(test.generate).not.toHaveBeenCalled();
  });

  it('retains an honest passive freshness qualification after the bounded attempt', async () => {
    const test = setup();
    test.generate.mockImplementation(async (_input: unknown, prepared: any) => ({ ok: true, route: 'gaming', mode: 'build',
      data: { response: 'This build has not been tested on the current patch. Use the cited Samurai bleed build. [1]',
        sources: prepared.knowledge.sources, grounding: { groundingStatus: 'grounded' } } } as any));
    const { result } = await continueCurrentness(test);
    expect(result.body).toMatchObject({ state: 'answer_ready', nextAction: 'answer', evidenceSelected: true,
      freshnessStatus: 'unverified' });
    expect(result.body.answer?.response).toContain('has not been tested on the current patch');
    expect(test.generate).toHaveBeenCalledTimes(1);
  });
});

describe('current state facts retain REQUIRED freshness inside recommendation requests', () => {
  it.each([
    'Give me a Samurai bleed build and tell me what the latest Elden Ring patch actually is.',
    'Recommend a healer class and tell me whether the live event is active now.',
    'Give me a weapon recommendation and tell me whether servers are down right now.',
    'Recommend a build and tell me the current game build number.',
    'What is the current/latest Elden Ring patch?',
    'What patch is Elden Ring on now?',
    'Which Elden Ring patch is live?',
    'What version is current?',
    'What build is Elden Ring running now?',
    'Give me a Samurai bleed build and tell me which patch is active today.',
    'Give me an event strategy and tell me if the event has ended.'
  ])('%s', prompt => {
    expect(resolveGamingFreshnessDisposition({ prompt, mode: 'build' })).toBe('REQUIRED');
  });
});

describe('advisory warning cannot coexist with affirmative currentness claims', () => {
  it.each([
    'Here is a current Samurai bleed build.',
    'This up-to-date Samurai bleed build is recommended.',
    'These recommendations work on the latest patch.',
    'This build is verified current.',
    'This Samurai bleed build is current.',
    'These katana recommendations are up to date.',
    'This Samurai bleed build remains latest-patch compatible.',
    'The guide has not been updated for the latest patch, but this build works on the latest patch.'
  ])('rejects: %s', answer => {
    expect(gamingAnswerClaimsVerifiedCurrentness(answer)).toBe(true);
  });
  it.each([
    'Current patch compatibility could not be verified. These recommendations may be outdated.',
    'The available guide describes patch 1.10; compatibility with the current patch has not been established.',
    'These recommendations are not verified current.',
    'This build has not been tested on the current patch.',
    'The guide has not been updated for the latest patch.',
    'The guide has never been verified compatible with the latest patch.',
    'Use the Samurai bleed build described in the cited guide.',
    'This guide is not current.'
  ])('permits honest qualification: %s', answer => {
    expect(gamingAnswerClaimsVerifiedCurrentness(answer)).toBe(false);
  });
});
