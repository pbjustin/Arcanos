import { describe, expect, it, jest } from '@jest/globals';
import { createGamingHybridWorkflow } from '../src/services/gamingHybridKnowledge.js';
import { GAMING_HYBRID_CONTRACT_VERSION as contractVersion } from '../src/shared/gaming/gamingHybridContract.js';
import { GAMING_SOURCE_POLICY_VERSION } from '../src/shared/gaming/gamingFreshnessCore.js';
import { GAMING_CURRENTNESS_ADAPTER_VERSION } from '../src/shared/gaming/gamingCurrentnessAdapters.js';
import { gamingClearHash } from '../src/shared/gaming/gamingClearPolicy.js';
import type { GamingStoredKnowledgeContext } from '../src/services/gamingStoredKnowledge.js';

const now = Date.now();
const context = { actorKey: 'synthetic-official-corroboration', requestId: 'official-corroboration-test' };
const query = { contractVersion, idempotencyKey: 'mage-currentness-query', game: 'Elden Ring', mode: 'build',
  question: 'What is a good mage build now?', storagePolicy: 'transient_only' };
const guideId = '30000000-0000-4000-8000-000000000001';
const indexId = '30000000-0000-4000-8000-000000000002';
const guideUrl = 'https://guides.example.org/elden-ring-mage';
const indexUrl = 'https://en.bandainamcoent.eu/elden-ring/elden-ring/news';
const empty: GamingStoredKnowledgeContext = { context: '', sources: [], sourceKnown: false };
const passage = 'For a good Elden Ring mage build, invest in intelligence and vigor, carry a sorcery staff and a light backup weapon, and select ranged spells for safe attacks. This specialist mage build explains equipment, stats, spells and progression. INTERNAL_PAGE_CONTENT';
function fixture(patch: string | undefined = '1.10') {
  const metadata = { id: guideId, game: query.game, url: guideUrl, policyVersion: GAMING_SOURCE_POLICY_VERSION,
    category: 'specialist_guide', authority: 'specialist', currentness: 'none', durableAllowed: true, autoStoreAllowed: false,
    fetchedAt: new Date(now).toISOString(), verifiedAt: new Date(now).toISOString(), metadataConfidence: 'content_extracted',
    patch, platforms: ['all'], regions: ['all'] };
  const guide = { candidateId: guideId, publicUrl: guideUrl, contentHash: 'a'.repeat(64), expiresAt: now + 600_000,
    document: { text: passage }, freshness: metadata };
  const knowledge: GamingStoredKnowledgeContext = { context: '', sourceKnown: true,
    sources: [{ sourceId: guideId, url: guideUrl, sourceType: 'specialist_guide', fetchedAt: metadata.fetchedAt, snippet: passage }],
    evidence: [{ sourceId: guideId, revisionId: 'guide-revision', recordId: 'guide-record', recordType: 'build',
      publicUrl: guideUrl, text: passage, lexicalScore: 1, combinedScore: 1, provenance: { fetchedAt: metadata.fetchedAt } }] };
  const index = { candidateId: indexId, publicUrl: indexUrl, contentHash: 'b'.repeat(64), expiresAt: now + 600_000,
    document: { text: 'Official release index.' }, freshness: { ...metadata, id: indexId, url: indexUrl,
      category: 'official_updates', authority: 'official', currentness: 'current_index', ruleId: 'elden-ring-update-index',
      patch: '1.10', currentPatch: '1.10', effectiveFrom: new Date(now - 86_400_000).toISOString() } };
  return { guide, index, knowledge };
}
function setup(patch: string | undefined = '1.10') {
  const data = fixture(patch);
  const retrieve = jest.fn(async () => empty);
  const evaluateCandidates = jest.fn(async (input: any) => input.discoveryType === 'currentness_verification'
    ? { decisions: [{ candidateId: indexId, decision: 'accepted_transient', reasonCodes: ['VALIDATED_APPLICABILITY_SOURCE'] }], accepted: [data.index], knowledge: empty }
    : { decisions: [{ candidateId: guideId, decision: 'accepted_transient', reasonCodes: ['VALIDATED_RELEVANT_CONTENT'] },
      { decision: 'rejected', reasonCodes: ['QUESTION_COVERAGE_INSUFFICIENT'] },
      { decision: 'rejected', reasonCodes: ['QUESTION_COVERAGE_INSUFFICIENT'] }], accepted: [data.guide], knowledge: data.knowledge });
  const generate = jest.fn(async (_input: unknown, prepared: any) => ({ ok: true, route: 'gaming', mode: 'build',
    data: { response: 'Use the mage build with the verified patch qualification. [1]', sources: prepared.knowledge.sources,
      grounding: { groundingStatus: 'grounded' } } } as any));
  const ingest = jest.fn();
  const workflow = createGamingHybridWorkflow({ retrieve, evaluateCandidates: evaluateCandidates as any, generate, ingest: ingest as any, now: () => now });
  const submit = (workflowId: string, discoveryType: 'gameplay_evidence' | 'currentness_verification', key = discoveryType) => ({
    contractVersion, workflowId, discoveryType, idempotencyKey: `operation-${key}`,
    candidates: [{ url: discoveryType === 'gameplay_evidence' ? guideUrl : indexUrl }] });
  return { ...data, workflow, evaluateCandidates, generate, ingest, submit, retrieve };
}

describe('bounded official currentness corroboration', () => {
  it('reuses the accepted mage guide through one distinct official operation and generates only after verification', async () => {
    const { workflow, submit, evaluateCandidates, generate, ingest } = setup();
    const first = await workflow.query(query, context);
    expect(first.body).toMatchObject({ nextAction: 'search', discovery: { type: 'gameplay_evidence', round: 0, maxRounds: 1 } });
    const found = await workflow.candidates(submit(first.body.workflowId!, 'gameplay_evidence'), context);
    expect(found.body).toMatchObject({ state: 'discovery_required', nextAction: 'verify_currentness',
      sourceKnown: true, evidenceSelected: false, acceptedGameplayCandidateCount: 1, gameplayEvidenceStatus: 'currentness_pending',
      discovery: { type: 'currentness_verification', round: 0, maxRounds: 1, maxCandidates: 3 } });
    expect(found.body.candidates?.filter(item => item.decision === 'rejected')).toHaveLength(2);
    expect(found.body.currentnessRequirements).toContain('official_source_required');
    expect(generate).not.toHaveBeenCalled();
    const official = submit(first.body.workflowId!, 'currentness_verification');
    const verified = await workflow.candidates(official, context);
    expect(verified.body).toMatchObject({ state: 'answer_ready', nextAction: 'answer', freshnessStatus: 'current',
      applicabilityStatus: 'verified_current', gameplayEvidenceStatus: 'freshness_verified', effectivePatch: '1.10' });
    expect(await workflow.candidates(official, context)).toEqual(verified);
    expect(evaluateCandidates).toHaveBeenCalledTimes(2);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(ingest).not.toHaveBeenCalled();
    expect(JSON.stringify(verified.body)).not.toContain('INTERNAL_PAGE_CONTENT');
  });
  it.each(['1.9', undefined])('stops after official verification when guide patch %s is insufficient', async patch => {
    const test = setup(patch);
    if (patch === undefined) delete test.guide.freshness.patch;
    const first = await test.workflow.query(query, context);
    await test.workflow.candidates(test.submit(first.body.workflowId!, 'gameplay_evidence'), context);
    const final = await test.workflow.candidates(test.submit(first.body.workflowId!, 'currentness_verification'), context);
    expect(final.body.nextAction).toBe('stop');
    expect(final.body.answer).toBeUndefined();
    expect(test.generate).not.toHaveBeenCalled();
    expect((await test.workflow.candidates(test.submit(first.body.workflowId!, 'gameplay_evidence', 'another-guide'), context)).status).toBe(409);
    expect((await test.workflow.candidates(test.submit(first.body.workflowId!, 'currentness_verification', 'another-index'), context)).status).toBe(409);
  });
  it('infers an omitted legacy operation type from server state without granting extra rounds', async () => {
    const test = setup();
    const first = await test.workflow.query(query, context);
    await test.workflow.candidates(test.submit(first.body.workflowId!, 'gameplay_evidence'), context);
    const { discoveryType: _type, ...legacy } = test.submit(first.body.workflowId!, 'currentness_verification');
    expect((await test.workflow.candidates(legacy, context)).body.state).toBe('answer_ready');
    const reset = await test.workflow.query({ ...query, idempotencyKey: 'reset-new-query-key', storagePolicy: 'auto_store_approved' }, context);
    expect(reset.body.workflowId).toBe(first.body.workflowId);
    expect((await test.workflow.candidates(test.submit(reset.body.workflowId!, 'currentness_verification', 'reset-index'), context)).status).toBe(409);
    expect(test.retrieve).toHaveBeenCalledTimes(1);
    for (const [index, presentation] of [{ answerDepth: 'detailed' }, { spoilerTolerance: 'full' }, { mode: 'guide' }].entries()) {
      const repeated = await test.workflow.query({ ...query, ...presentation, idempotencyKey: `presentation-reset-${index}` }, context);
      expect(repeated.body.workflowId).toBe(first.body.workflowId);
    }
    expect(test.evaluateCandidates).toHaveBeenCalledTimes(2);
  });
  it('charges concurrent official submissions atomically and enforces payload/count boundaries', async () => {
    const test = setup();
    const first = await test.workflow.query(query, context);
    expect((await test.workflow.candidates(test.submit(first.body.workflowId!, 'currentness_verification'), context)).status).toBe(409);
    await test.workflow.candidates(test.submit(first.body.workflowId!, 'gameplay_evidence'), context);
    const official = test.submit(first.body.workflowId!, 'currentness_verification', 'valid-index');
    expect((await test.workflow.candidates({ ...official, candidates: Array(4).fill({ url: indexUrl }) }, context)).status).toBe(400);
    const [one, two] = await Promise.all([test.workflow.candidates(official, context),
      test.workflow.candidates({ ...official, idempotencyKey: 'concurrent-index-2' }, context)]);
    expect(one.body.state).toBe('answer_ready');
    expect(two.status).toBe(409);
    expect((await test.workflow.candidates({ ...official, candidates: [{ url: `${indexUrl}/changed` }] }, context)).status).toBe(409);
    expect(test.evaluateCandidates).toHaveBeenCalledTimes(2);
  });
  it('distinguishes official fetch failure from an absence of updates and stops', async () => {
    const test = setup();
    const first = await test.workflow.query(query, context);
    await test.workflow.candidates(test.submit(first.body.workflowId!, 'gameplay_evidence'), context);
    test.evaluateCandidates.mockResolvedValueOnce({ decisions: [{ decision: 'rejected', reasonCodes: ['SOURCE_FETCH_FAILED'] }], accepted: [], knowledge: empty } as any);
    const failed = await test.workflow.candidates(test.submit(first.body.workflowId!, 'currentness_verification'), context);
    expect(failed.body).toMatchObject({ nextAction: 'stop', reason: 'SOURCE_ACQUISITION_UNVERIFIED',
      freshnessStatus: 'unverified', gameplayEvidenceStatus: 'unverified' });
    expect(test.generate).not.toHaveBeenCalled();
  });
  it('prioritizes missing official currentness after an accepted guide even when retained old policy evidence was excluded', async () => {
    const test = setup();
    const oldUrl = 'https://guides.example.org/old-mage';
    test.retrieve.mockResolvedValueOnce({ ...test.knowledge,
      sources: [{ ...test.knowledge.sources[0], sourceId: 'old-source', url: oldUrl,
        freshnessMetadata: { ...test.guide.freshness, id: 'old-source', url: oldUrl, policyVersion: 'gaming-hybrid-source-policy-v1' } }],
      evidence: [{ ...test.knowledge.evidence![0], sourceId: 'old-source', publicUrl: oldUrl }] });
    const first = await test.workflow.query(query, context);
    expect(first.body.nextAction).toBe('search');
    const accepted = await test.workflow.candidates(test.submit(first.body.workflowId!, 'gameplay_evidence'), context);
    expect(accepted.body).toMatchObject({ nextAction: 'verify_currentness', reason: 'CURRENT_OFFICIAL_INDEX_REQUIRED',
      acceptedGameplayCandidateCount: 1, discovery: { type: 'currentness_verification', round: 0 } });
    const final = await test.workflow.candidates(test.submit(first.body.workflowId!, 'currentness_verification'), context);
    expect(final.body.state).toBe('answer_ready');
  });
  it('reuses origin-bound durable currentness across workflows without refreshing its age or accepting a different actor or scope', async () => {
    const test = setup();
    (test.index.freshness as any).currentnessMetadata = { game: query.game, ruleId: test.index.freshness.ruleId,
      adapterId: 'bandai-news-index-v1', adapterVersion: GAMING_CURRENTNESS_ADAPTER_VERSION,
      verifiedAt: test.index.freshness.verifiedAt, status: 'verified', reasons: ['SYNTHETIC_OFFICIAL_INDEX'],
      currentPatch: '1.10', effectiveFrom: test.index.freshness.effectiveFrom,
      evidenceRefs: [{ url: indexUrl, contentHash: test.index.contentHash }] };
    const first = await test.workflow.query(query, context);
    await test.workflow.candidates(test.submit(first.body.workflowId!, 'gameplay_evidence'), context);
    const initial = await test.workflow.candidates(test.submit(first.body.workflowId!, 'currentness_verification'), context);
    expect(initial.body.state).toBe('answer_ready');
    const verification = (test.guide.freshness as any).currentVerification;
    expect(verification.workflowId).toBe(first.body.workflowId);
    const stored = (): GamingStoredKnowledgeContext => ({ context: '', sourceKnown: true,
      sources: [{ ...test.knowledge.sources.find(source => source.sourceId === guideId)!,
        approvedContentHash: test.guide.contentHash, freshnessMetadata: structuredClone(test.guide.freshness) }],
      evidence: structuredClone(test.knowledge.evidence!.filter(chunk => chunk.sourceId === guideId)) });
    const reader = (ageMs = 0) => createGamingHybridWorkflow({ retrieve: async () => stored(),
      generate: test.generate, now: () => now + ageMs });
    const fresh = await reader().query({ ...query, idempotencyKey: 'new-workflow-cached-proof' }, context);
    expect(fresh.body.workflowId).not.toBe(first.body.workflowId);
    expect(fresh.body).toMatchObject({ state: 'answer_ready', freshnessStatus: 'current', effectivePatch: '1.10' });
    expect(fresh.body.verifiedAsOf).toBe(initial.body.verifiedAsOf);
    const reordered = (value: unknown): unknown => Array.isArray(value) ? value.map(reordered)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse()
        .map(([key, child]) => [key, reordered(child)])) : value;
    const reorderedStored = (): GamingStoredKnowledgeContext => reordered(JSON.parse(JSON.stringify(stored()))) as GamingStoredKnowledgeContext;
    const reorderedProof = reorderedStored().sources[0].freshnessMetadata!.currentVerification as any;
    expect(Object.keys(reorderedProof)).toEqual(Object.keys(verification).reverse());
    expect(Object.keys(reorderedProof.evidence.currentnessMetadata)).toEqual(Object.keys(verification.evidence.currentnessMetadata).reverse());
    const reorderedReader = createGamingHybridWorkflow({ retrieve: async () => reorderedStored(), generate: test.generate, now: () => now });
    expect((await reorderedReader.query({ ...query, idempotencyKey: 'jsonb-reordered-proof' }, context)).body)
      .toMatchObject({ state: 'answer_ready', freshnessStatus: 'current', verifiedAsOf: initial.body.verifiedAsOf });
    const changedValueReader = createGamingHybridWorkflow({ retrieve: async () => {
      const knowledge = reorderedStored();
      const proof = knowledge.sources[0].freshnessMetadata!.currentVerification as any;
      proof.evidence.currentnessMetadata.evidenceRefs[0].contentHash = 'c'.repeat(64);
      return knowledge;
    }, generate: test.generate, now: () => now });
    const changed = await changedValueReader.query({ ...query, idempotencyKey: 'jsonb-changed-proof-value' }, context);
    expect(changed.body).toMatchObject({ nextAction: 'verify_currentness', reason: 'CURRENT_OFFICIAL_INDEX_REQUIRED', freshnessStatus: 'unverified' });
    expect(changed.body.answer).toBeUndefined();
    const expired = await reader(7 * 60 * 60_000).query({ ...query, idempotencyKey: 'expired-cached-proof' }, context);
    expect(expired.body).toMatchObject({ state: 'discovery_required', nextAction: 'verify_currentness',
      freshnessStatus: 'stale', reason: 'REVALIDATION_DUE' });
    expect(expired.body.answer).toBeUndefined();
    for (const scope of [{ platform: 'PC' }, { region: 'EU' }, { requestedVersion: '1.10' }]) {
      const mismatched = await reader().query({ ...query, ...scope, idempotencyKey: 'scope-mismatched-cached-proof' }, context);
      expect(mismatched.body.answer).toBeUndefined();
      expect(mismatched.body.freshnessStatus).toBe('unverified');
    }
    const otherActor = await reader().query({ ...query, idempotencyKey: 'other-actor-cached-proof' },
      { ...context, actorKey: 'unrelated-currentness-actor' });
    expect(otherActor.body.answer).toBeUndefined();
    expect(otherActor.body.freshnessStatus).toBe('unverified');
    const retired = structuredClone(verification);
    retired.evidence.currentnessMetadata = { status: 'verified', adapterVersion: 'gaming-currentness-adapters/retired' };
    retired.bindingHash = gamingClearHash({ ...retired, bindingHash: undefined });
    const staleAdapterReader = createGamingHybridWorkflow({ retrieve: async () => {
      const knowledge = stored();
      knowledge.sources[0].freshnessMetadata!.currentVerification = retired;
      return knowledge;
    }, generate: test.generate, now: () => now });
    const staleAdapter = await staleAdapterReader.query({ ...query, idempotencyKey: 'retired-adapter-cached-proof' }, context);
    expect(staleAdapter.body).toMatchObject({ state: 'discovery_required', nextAction: 'verify_currentness', freshnessStatus: 'unverified' });
    expect(staleAdapter.body.answer).toBeUndefined();
    expect(test.generate).toHaveBeenCalledTimes(3);
    expect(test.evaluateCandidates).toHaveBeenCalledTimes(2);
  });
});
