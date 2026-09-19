import { describe, expect, it, jest } from '@jest/globals';
import { createGamingHybridWorkflow } from '../src/services/gamingHybridKnowledge.js';
import { GAMING_HYBRID_CONTRACT_VERSION as contractVersion } from '../src/shared/gaming/gamingHybridContract.js';
import { extractGamingFreshnessMetadata, GAMING_SOURCE_POLICY_VERSION } from '../src/shared/gaming/gamingFreshnessCore.js';
import { GAMING_CURRENTNESS_ADAPTER_VERSION } from '../src/shared/gaming/gamingCurrentnessAdapters.js';
import { gamingClearHash } from '../src/shared/gaming/gamingClearPolicy.js';
import { resolveGamingHybridCurrentnessReason } from '../src/shared/gaming/gamingHybridPolicyCore.js';
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
function setup(patch: string | undefined = '1.10', clock = () => now) {
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
  const workflow = createGamingHybridWorkflow({ retrieve, evaluateCandidates: evaluateCandidates as any, generate, ingest: ingest as any, now: clock });
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
      discovery: { type: 'currentness_verification', round: 0, maxRounds: 1, maxCandidates: 3, continuationRequired: true,
        reviewedSources: [{ url: indexUrl, ruleId: 'elden-ring-update-index', role: 'current_index' }] } });
    expect(found.body.candidates?.filter(item => item.decision === 'rejected')).toHaveLength(2);
    expect(found.body.currentnessRequirements).toContain('official_source_required');
    expect(generate).not.toHaveBeenCalled();
    const replay = await workflow.query({ ...query, idempotencyKey: 'pending-currentness-new-query' }, context);
    expect(replay.body.workflowId).toBe(first.body.workflowId);
    expect(replay.body.discovery).toEqual(found.body.discovery);
    expect(replay.body.nextAction).toBe('verify_currentness');
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
    expect(final.body.discovery).toMatchObject({ continuationRequired: false, round: 1, maxRounds: 1 });
    expect(final.body.answer).toBeUndefined();
    expect(test.generate).not.toHaveBeenCalled();
    expect((await test.workflow.candidates(test.submit(first.body.workflowId!, 'gameplay_evidence', 'another-guide'), context)).status).toBe(409);
    expect((await test.workflow.candidates(test.submit(first.body.workflowId!, 'currentness_verification', 'another-index'), context)).status).toBe(409);
  });
  it('continues missing build verification when an official patch index is already retained', async () => {
    const test = setup();
    Object.assign(test.guide.freshness, { build: '1.10.1' });
    test.retrieve.mockResolvedValueOnce({ ...empty, sourceKnown: true, sources: [{ sourceId: 'stored-official-index',
      url: indexUrl, sourceType: 'official_updates', fetchedAt: test.index.freshness.fetchedAt,
      snippet: 'Official current patch index.', freshnessMetadata: { ...test.index.freshness, id: 'stored-official-index' } }] });
    const first = await test.workflow.query(query, context);
    const found = await test.workflow.candidates(test.submit(first.body.workflowId!, 'gameplay_evidence'), context);
    expect(found.body).toMatchObject({ nextAction: 'verify_currentness', reason: 'CURRENT_BUILD_UNVERIFIED',
      acceptedGameplayCandidateCount: 1, discovery: { type: 'currentness_verification', round: 0, continuationRequired: true } });
    expect(test.generate).not.toHaveBeenCalled();
    Object.assign(test.index.freshness, { currentBuild: '1.10.1' });
    const verified = await test.workflow.candidates(test.submit(first.body.workflowId!, 'currentness_verification'), context);
    expect(verified.body).toMatchObject({ state: 'answer_ready', effectiveBuild: '1.10.1' });
    expect(test.generate).toHaveBeenCalledTimes(1);
  });
  it.each([
    { label: 'without refreshed records', refreshedRecords: false, negative: 'none' },
    { label: 'with refreshed records', refreshedRecords: true, negative: 'none' },
    { label: 'with an independently applicable contradiction', refreshedRecords: true, negative: 'future' },
    { label: 'with an out-of-scope contradiction', refreshedRecords: true, negative: 'outside_scope' }
  ])('refreshes a submitted same-URL index $label', async ({ refreshedRecords, negative }) => {
    let currentNow = now;
    const test = setup('1.10', () => currentNow);
    const game = 'Star Wars: The Old Republic';
    const officialUrl = 'https://www.swtor.com/patchnotes';
    const text = passage.replaceAll('Elden Ring', game).replaceAll('mage', 'healer');
    Object.assign(test.guide.freshness, { game, patch: '7.0', build: '7.0.1' });
    test.guide.document.text = text;
    test.knowledge.sources[0].snippet = text;
    test.knowledge.evidence![0].text = text;
    const indexText = `Game: ${game}\nCurrent patch: 7.0\nEffective from: ${new Date(now - 86_400_000).toISOString()}\nPlatforms: all\nRegions: all`;
    const indexDocument = { publicUrl: officialUrl, text: indexText, metadata: { title: `${game} Patch Notes` } };
    const oldFreshness = extractGamingFreshnessMetadata(indexDocument, { game }, new Date(now));
    expect(oldFreshness.currentnessMetadata).toMatchObject({ adapterId: 'swtor-patch-index-v1', status: 'verified' });
    expect(oldFreshness.currentBuild).toBeUndefined();
    const oldIndex = { ...test.index, publicUrl: officialUrl, document: indexDocument,
      freshness: { ...oldFreshness, id: indexId } };
    const oldSnippet = `Older official healer build index passage. ${indexText}`;
    const oldSource = { sourceId: indexId, url: officialUrl, sourceType: 'official_updates',
      fetchedAt: oldFreshness.fetchedAt, snippet: oldSnippet, freshnessMetadata: oldIndex.freshness };
    const oldChunk = { sourceId: indexId, revisionId: oldIndex.contentHash, recordId: 'old-index-record', recordType: 'build' as const,
      publicUrl: officialUrl, text: oldSnippet, lexicalScore: 1, combinedScore: 1, provenance: { fetchedAt: oldFreshness.fetchedAt } };
    test.knowledge.sources.push(oldSource);
    test.knowledge.evidence!.push(oldChunk);
    const refreshedId = '30000000-0000-4000-8000-000000000003';
    const refreshedDocument = { ...indexDocument, text: `${indexText}\nCurrent build: 7.0.1` };
    const refreshedIndex = { ...oldIndex, candidateId: refreshedId, contentHash: 'c'.repeat(64), document: refreshedDocument,
      freshness: { ...extractGamingFreshnessMetadata(refreshedDocument, { game }, new Date(now)), id: refreshedId } };
    const freshSnippet = `Refreshed official healer build index passage. ${refreshedDocument.text}`;
    const refreshedKnowledge = refreshedRecords ? { context: '', sourceKnown: true,
      sources: [{ ...oldSource, sourceId: refreshedId, snippet: freshSnippet, freshnessMetadata: refreshedIndex.freshness }],
      evidence: [{ ...oldChunk, sourceId: refreshedId, revisionId: refreshedIndex.contentHash,
        recordId: 'refreshed-index-record', text: freshSnippet }] } : empty;
    // A separately acquired official contradiction remains negative evidence even
    // if a later acquisition of the same canonical URL supplies positive metadata.
    const negativeDocument = { ...indexDocument, text: `${indexText
      .replace(`Effective from: ${new Date(now - 86_400_000).toISOString()}`,
        `Effective from: ${new Date(negative === 'future' ? now + 1_000 : now - 86_400_000).toISOString()}`)
      .replace('Platforms: all', negative === 'outside_scope' ? 'Platforms: PS5' : 'Platforms: all')}\nCurrent patch: 7.1` };
    const negativeFreshness = { ...extractGamingFreshnessMetadata(negativeDocument, { game }, new Date(now)),
      id: '30000000-0000-4000-8000-000000000004' };
    expect(negativeFreshness.metadataConflict).toBe(true);
    test.evaluateCandidates.mockResolvedValueOnce({ accepted: [test.guide, oldIndex], knowledge: test.knowledge,
      ...(negative !== 'none' ? { currentnessEvidence: [negativeFreshness] } : {}),
      decisions: [test.guide, oldIndex].map(item => ({ candidateId: item.candidateId,
        decision: 'accepted_transient', reasonCodes: ['VALIDATED_RELEVANT_CONTENT'] })) } as any);
    test.evaluateCandidates.mockResolvedValueOnce({ accepted: [refreshedIndex], knowledge: refreshedKnowledge,
      decisions: [{ candidateId: refreshedId, decision: 'accepted_transient', reasonCodes: ['VALIDATED_APPLICABILITY_SOURCE'] }] } as any);
    const first = await test.workflow.query({ ...query, game, platform: 'PC', question: 'What is a good healer build now?' }, context);
    const found = await test.workflow.candidates({ ...test.submit(first.body.workflowId!, 'gameplay_evidence'),
      candidates: [{ url: guideUrl }, { url: officialUrl }] }, context);
    expect(found.body).toMatchObject({ nextAction: 'verify_currentness', reason: 'CURRENT_BUILD_UNVERIFIED',
      discovery: { round: 0, continuationRequired: true } });
    currentNow = now + 2_000;
    const official = { ...test.submit(first.body.workflowId!, 'currentness_verification'), candidates: [{ url: officialUrl }] };
    const verified = await test.workflow.candidates(official, context);
    if (negative === 'future') {
      expect(verified.body).toMatchObject({ nextAction: 'stop', freshnessStatus: 'conflicting', reason: 'CONFLICTING_CURRENTNESS' });
      expect(verified.body.answer).toBeUndefined();
      expect(test.generate).not.toHaveBeenCalled();
      return;
    }
    expect(verified.body).toMatchObject({ state: 'answer_ready', nextAction: 'answer', freshnessStatus: 'current',
      effectivePatch: '7.0', effectiveBuild: '7.0.1' });
    expect(await test.workflow.candidates(official, context)).toEqual(verified);
    expect(test.evaluateCandidates).toHaveBeenCalledTimes(2);
    expect(test.generate).toHaveBeenCalledTimes(1);
    const prepared = test.generate.mock.calls[0][1].knowledge;
    expect(prepared.sources.some((source: { sourceId: string }) => source.sourceId === indexId)).toBe(false);
    expect(prepared.evidence.some((chunk: { recordId: string }) => chunk.recordId === oldChunk.recordId)).toBe(false);
    expect(prepared.sources.find((source: { sourceId: string }) => source.sourceId === refreshedId)?.freshnessMetadata)
      .toMatchObject({ id: refreshedId, currentBuild: '7.0.1' });
    expect(JSON.stringify(prepared)).not.toContain(oldSnippet);
  });
  it('provides seasonal discovery queries and verifies the retained guide against the official season', async () => {
    const test = setup();
    Object.assign(test.guide.freshness, { season: 'Autumn' });
    Object.assign(test.index.freshness, { currentSeason: 'Autumn', season: 'Autumn' });
    const first = await test.workflow.query({ ...query, question: 'What is a good mage build for the current season?' }, context);
    const found = await test.workflow.candidates(test.submit(first.body.workflowId!, 'gameplay_evidence'), context);
    expect(found.body).toMatchObject({ nextAction: 'verify_currentness', reason: 'CURRENT_OFFICIAL_INDEX_REQUIRED',
      discovery: { continuationRequired: true, round: 0, maxRounds: 1 } });
    expect(found.body.discovery?.searchQueries.every(value => value.includes('season') && value.length <= 350)).toBe(true);
    expect(test.generate).not.toHaveBeenCalled();
    expect((await test.workflow.candidates(test.submit(first.body.workflowId!, 'currentness_verification'), context)).body)
      .toMatchObject({ state: 'answer_ready', freshnessStatus: 'current', applicabilityStatus: 'verified_current' });
    expect(test.generate).toHaveBeenCalledTimes(1);
  });
  it('continues a live-status request through one separately budgeted official status operation', async () => {
    const test = setup();
    const liveQuery = { ...query, mode: 'guide', question: 'Are Elden Ring servers down now?' };
    const first = await test.workflow.query(liveQuery, context);
    const found = await test.workflow.candidates(test.submit(first.body.workflowId!, 'gameplay_evidence'), context);
    expect(found.body).toMatchObject({ state: 'discovery_required', nextAction: 'verify_currentness',
      reason: 'LIVE_OFFICIAL_STATUS_REQUIRED', currentnessRequirements: ['official_source_required', 'official_live_status_required'],
      discovery: { type: 'currentness_verification', round: 0, maxRounds: 1, continuationRequired: true } });
    expect(found.body.discovery?.searchQueries.every(value => value.includes('status'))).toBe(true);
    expect(found.body.discovery?.reviewedSources).toBeUndefined();
    expect(test.generate).not.toHaveBeenCalled();
    const statusUrl = 'https://status.example.org/elden-ring';
    const statusText = 'Elden Ring servers are down now for planned maintenance. This official live server status reports the current outage and login availability. Maintenance is active and servers remain offline until the next official status update.';
    const status = { ...test.index, publicUrl: statusUrl, document: { text: statusText }, freshness: { ...test.index.freshness,
      url: statusUrl, currentness: 'live_status', category: 'official_status', sourceUpdatedAt: new Date(now).toISOString(),
      durableAllowed: false, autoStoreAllowed: false } };
    test.evaluateCandidates.mockResolvedValueOnce({ accepted: [status], decisions: [{ candidateId: indexId,
      decision: 'accepted_transient', reasonCodes: ['VALIDATED_RELEVANT_CONTENT'] }], knowledge: { context: '', sourceKnown: true,
      sources: [{ sourceId: indexId, url: statusUrl, sourceType: 'official_status', fetchedAt: status.freshness.fetchedAt, snippet: statusText }],
      evidence: [{ sourceId: indexId, revisionId: 'status-revision', recordId: 'status-record', recordType: 'guide',
        publicUrl: statusUrl, text: statusText, lexicalScore: 1, combinedScore: 1, provenance: { fetchedAt: status.freshness.fetchedAt } }] } } as any);
    const official = { ...test.submit(first.body.workflowId!, 'currentness_verification'), candidates: [{ url: statusUrl }] };
    const verified = await test.workflow.candidates(official, context);
    expect(verified.body).toMatchObject({ state: 'answer_ready', nextAction: 'answer', freshnessStatus: 'current' });
    expect(await test.workflow.candidates(official, context)).toEqual(verified);
    expect((await test.workflow.candidates({ ...official, idempotencyKey: 'second-live-operation' }, context)).status).toBe(409);
    expect(test.evaluateCandidates).toHaveBeenCalledTimes(2);
    expect(test.generate).toHaveBeenCalledTimes(1);
  });
  it('does not turn a conflicting release or stale guide into another currentness operation', () => {
    const input = { classification: 'patch_sensitive' as const, freshnessStatus: 'unverified' as const, hasGameplayEvidence: true,
      reasons: ['CURRENT_BUILD_UNVERIFIED'] };
    expect(resolveGamingHybridCurrentnessReason(input)).toBe('CURRENT_BUILD_UNVERIFIED');
    expect(resolveGamingHybridCurrentnessReason({ ...input, freshnessStatus: 'conflicting' })).toBeUndefined();
    expect(resolveGamingHybridCurrentnessReason({ ...input, reasons: ['CURRENT_PATCH_COVERAGE_MISSING', 'GUIDE_PATCH_STALE'] })).toBeUndefined();
    expect(resolveGamingHybridCurrentnessReason({ ...input, classification: 'stable', reasons: ['REVALIDATION_DUE'] })).toBeUndefined();
    expect(resolveGamingHybridCurrentnessReason({ ...input, hasGameplayEvidence: false })).toBeUndefined();
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
      expect(repeated).toMatchObject({ status: 409, body: { nextAction: 'stop', reason: 'QUERY_CONTEXT_CONFLICT' } });
      expect(repeated.body.answer).toBeUndefined();
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
