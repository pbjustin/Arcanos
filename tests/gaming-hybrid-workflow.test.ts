import { afterEach, beforeEach, describe, it, expect, jest } from '@jest/globals';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';
import { createGamingAcquisitionStages } from './testUtils/gamingAcquisitionStages.js';
import { GAMING_HYBRID_CONTRACT_VERSION as contractVersion, GAMING_HYBRID_LIMITS } from '../src/shared/gaming/gamingHybridContract.js';
import type { GamingStoredKnowledgeContext } from '../src/services/gamingStoredKnowledge.js';
import { GAMING_SOURCE_POLICY_VERSION } from '../src/shared/gaming/gamingFreshnessCore.js';
import { projectGamingHybridCandidateRetention, GAMING_HYBRID_RETAINED_ARTIFACT_CHARS } from '../src/shared/gaming/gamingHybridPolicyCore.js';

const acceptedHttp = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(acceptedHttp) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
const { createGamingHybridWorkflow } = await import('../src/services/gamingHybridKnowledge.js');
const { evaluateGamingHybridCandidates } = await import('../src/services/gamingHybridCandidates.js');
const { logger } = await import('../src/platform/logging/structuredLogging.js');

const now = Date.now();
const context = { actorKey: 'synthetic-gaming-caller', requestId: 'synthetic-request' };
const query = { contractVersion, idempotencyKey: 'synthetic-query-1', question: 'How do I open the copper gate?', game: 'Lantern Voyage' };
const empty: GamingStoredKnowledgeContext = { context: '', sources: [], sourceKnown: false };
let acquisitionStages: ReturnType<typeof createGamingAcquisitionStages> | undefined;
function acquiredGuide(chars?: number, effectiveUntil?: string) {
  const prose = `In the game ${query.game}, open the copper gate using the copper key. `;
  const text = chars === undefined ? prose : prose + 'x'.repeat(chars - prose.length);
  acceptedHttp.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' },
    data: `<html><title>${query.game} guide</title><article><p>${text}</p>`
      + (effectiveUntil ? `<p>Effective until: ${effectiveUntil}.</p>` : '') + '</article></html>' });
}
beforeEach(async () => {
  await acquisitionStages?.dispose(); acquisitionStages = undefined;
  acceptedHttp.mockReset(); acquiredGuide();
  jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
});
afterEach(async () => { await acquisitionStages?.dispose(); jest.restoreAllMocks(); });
const knowledge = (): GamingStoredKnowledgeContext => ({ context: '', sourceKnown: true,
  sources: [{ sourceId: 'source-1', url: 'https://example.com/lantern', title: 'Lantern Voyage', sourceType: 'supplied',
    fetchedAt: new Date(now).toISOString(), snippet: 'Open the copper gate using the copper key.' }],
  evidence: [{ sourceId: 'source-1', revisionId: 'revision-1', recordId: 'record-1', recordType: 'guide',
    publicUrl: 'https://example.com/lantern', text: 'Open the copper gate using the copper key.', lexicalScore: 1, combinedScore: 1,
    provenance: { fetchedAt: new Date(now).toISOString() } }] });
function setup(initial = empty) {
  const retrieve = jest.fn(async () => initial);
  const evaluateCandidates = jest.fn(async () => ({ decisions: [], accepted: [], knowledge: empty }));
  const generate = jest.fn(async (_input: unknown, prepared: any) => ({ ok: true as const, route: 'gaming' as const, mode: 'guide' as const,
    data: { response: 'Use the copper key to open the gate. [1]', sources: prepared.knowledge.sources,
      grounding: { groundingStatus: 'grounded' as const, requestedSourceCount: 0, fetchedSourceCount: 1, fetchedSuppliedSourceCount: 0,
        usableSourceCount: 1, citableSourceCount: 1, selectedChunkCount: 1, suppliedEvidenceSourceCount: 0, groundedInSuppliedEvidence: false } } }));
  const workflow = createGamingHybridWorkflow({ retrieve, evaluateCandidates, generate, now: () => now });
  return { workflow, retrieve, generate, evaluateCandidates };
}

describe('Gaming hybrid authenticated handoff', () => {
  it('never projects capacity-excluded reference artifacts as accepted gameplay evidence', () => {
    const decisions = [{ candidateId: '30000000-0000-4000-8000-000000000001', decision: 'requires_confirmation',
      reasonCodes: ['REFERENCE_ONLY_REQUIRES_CONFIRMATION'], classification: 'reference_only' as const, generationEligible: false }];
    const retained = projectGamingHybridCandidateRetention({ retainedChars: 0, candidateChars: 100, decisions });
    expect(retained.decisions[0]).toMatchObject({ candidateId: decisions[0].candidateId, decision: 'requires_confirmation' });
    expect(retained.decisions[0]).not.toHaveProperty('classification');
    expect(retained.decisions[0]).not.toHaveProperty('generationEligible');
    const overflow = projectGamingHybridCandidateRetention({ retainedChars: GAMING_HYBRID_RETAINED_ARTIFACT_CHARS,
      candidateChars: 100, decisions });
    expect(overflow.retainArtifacts).toBe(false);
    expect(overflow.decisions[0]).toMatchObject({ decision: 'rejected', reasonCodes: [
      'ARTIFACT_CAPACITY_REACHED', 'REFERENCE_ONLY_REQUIRES_CONFIRMATION' ] });
    expect(overflow.decisions[0]).not.toHaveProperty('candidateId');
  });

  it('reports failed acquisition without asserting absence and preserves the one-round stop on replay', async () => {
    const { workflow, evaluateCandidates, generate } = setup();
    evaluateCandidates.mockResolvedValue({ decisions: [{ decision: 'rejected', reasonCodes: ['URL_BLOCKED'] }],
      accepted: [], knowledge: empty } as any);
    const queried = await workflow.query(query, context);
    const submitted = { contractVersion, workflowId: queried.body.workflowId, idempotencyKey: 'test-failure-1',
      candidates: [{ url: 'https://guides.example.com/lantern' }] };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await workflow.candidates(submitted, context);
      expect(result.body).toMatchObject({ reason: 'SOURCE_ACQUISITION_UNVERIFIED', nextAction: 'stop',
        discovery: { round: 1, maxRounds: 1, maxCandidates: 3 } });
      expect(result.body.qualification).toContain('could not be verified through backend acquisition');
      expect(result.body.qualification).toContain('does not establish');
    }
    expect(evaluateCandidates).toHaveBeenCalledTimes(1);
    expect(evaluateCandidates).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ workflowId: queried.body.workflowId }));
    expect(generate).not.toHaveBeenCalled();
  });
  it('requests bounded discovery without generation for unknown knowledge', async () => {
    const { workflow, generate, retrieve } = setup();
    const result = await workflow.query(query, context);
    expect(result.body).toMatchObject({ state: 'discovery_required', nextAction: 'search', sourceKnown: false, evidenceSelected: false,
      discovery: { round: 0, maxRounds: 1, maxCandidates: 3 } });
    expect(generate).not.toHaveBeenCalled();
    expect(retrieve).toHaveBeenCalledWith(expect.objectContaining({ failOnUnavailable: true }));
  });
  it('uses existing fresh active evidence without discovery and preserves backend provenance', async () => {
    const { workflow, generate, evaluateCandidates } = setup(knowledge());
    const result = await workflow.query(query, context);
    expect(result.body).toMatchObject({ state: 'answer_ready', freshnessStatus: 'current', evidenceSelected: true,
      answer: { provenance: 'arcanos-trinity', requestId: context.requestId, response: 'Use the copper key to open the gate. [1]' } });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(evaluateCandidates).not.toHaveBeenCalled();
  });
  it('withholds a retained spoiler-permitting answer when a new query tightens spoiler permission', async () => {
    const { workflow, generate, retrieve, evaluateCandidates } = setup(knowledge());
    const first = await workflow.query({ ...query, spoilerTolerance: 'full' }, context);
    expect(first.body.state).toBe('answer_ready');
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ spoilerMode: 'full' }), expect.anything());
    const restricted = await workflow.query({ ...query, spoilerTolerance: 'none', idempotencyKey: 'restricted-query' }, context);
    expect(restricted).toMatchObject({ status: 409, body: { nextAction: 'stop', reason: 'QUERY_CONTEXT_CONFLICT' } });
    expect(restricted.body.answer).toBeUndefined();
    // Initial lookup plus entry, pre/post-generation and return authority checks.
    expect(retrieve).toHaveBeenCalledTimes(5);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(evaluateCandidates).not.toHaveBeenCalled();
  });
  it('does not replay a stable guide answer as a patch-sensitive build answer', async () => {
    const { workflow, generate, retrieve } = setup(knowledge());
    expect((await workflow.query(query, context)).body.state).toBe('answer_ready');
    const build = await workflow.query({ ...query, mode: 'build', idempotencyKey: 'changed-build-query' }, context);
    expect(build).toMatchObject({ status: 409, body: { reason: 'QUERY_CONTEXT_CONFLICT' } });
    expect(build.body.answer).toBeUndefined();
    expect(retrieve).toHaveBeenCalledTimes(5);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('preserves equivalent effective preferences and the original response after a rejected change', async () => {
    const { workflow, generate, retrieve } = setup(knowledge());
    const first = await workflow.query({ ...query, spoilerTolerance: 'none' }, context);
    const changed = await workflow.query({ ...query, answerDepth: 'detailed', idempotencyKey: 'depth-change-query' }, context);
    expect(changed).toMatchObject({ status: 409, body: { reason: 'QUERY_CONTEXT_CONFLICT' } });
    expect(changed.body.answer).toBeUndefined();
    const equivalent = await workflow.query({ ...query, spoilerTolerance: 'avoid', answerDepth: 'auto', idempotencyKey: 'equivalent-query' }, context);
    expect(equivalent).toEqual(first);
    expect(await workflow.query({ ...query, spoilerTolerance: 'none' }, context)).toEqual(first);
    expect(retrieve).toHaveBeenCalledTimes(7);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('rejects a preference change while discovery is pending without granting another workflow', async () => {
    const { workflow, retrieve, evaluateCandidates, generate } = setup();
    const first = await workflow.query(query, context);
    expect(first.body.nextAction).toBe('search');
    const changed = await workflow.query({ ...query, answerDepth: 'detailed', idempotencyKey: 'pending-depth-change' }, context);
    expect(changed).toMatchObject({ status: 409, body: { workflowId: first.body.workflowId, reason: 'QUERY_CONTEXT_CONFLICT' } });
    expect(await workflow.query({ ...query, idempotencyKey: 'pending-equivalent' }, context)).toEqual(first);
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(evaluateCandidates).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });
  it('reuses preferences whose effective values are fixed by the question', async () => {
    const { workflow, retrieve } = setup();
    const prompt = { ...query, question: `${query.question} No spoilers; keep it short.`, spoilerTolerance: 'full', answerDepth: 'detailed' };
    const first = await workflow.query(prompt, context);
    const repeated = await workflow.query({ ...prompt, spoilerTolerance: 'none', answerDepth: 'concise', idempotencyKey: 'question-equivalent' }, context);
    expect(repeated).toEqual(first);
    expect(retrieve).toHaveBeenCalledTimes(1);
  });
  it.each(['EU', 'US', undefined])('retains region %s through evidence assessment and generation', async region => {
    const data = knowledge();
    data.sources[0].freshnessMetadata = { id: 'source-1', game: query.game, url: data.sources[0].url,
      regions: ['EU'], fetchedAt: data.sources[0].fetchedAt, verifiedAt: data.sources[0].fetchedAt,
      metadataConfidence: 'content_extracted' };
    const { workflow, generate } = setup(data);
    const result = await workflow.query({ ...query, ...(region ? { region } : {}) }, context);
    if (region === 'EU' || region === undefined) {
      expect(result.body.state).toBe('answer_ready');
      expect(generate).toHaveBeenCalledWith(expect.objectContaining({ region }), expect.any(Object));
      if (region === undefined) expect(result.body.qualification).toContain('region scope ["EU"]');
    } else {
      expect(result.body.answer).toBeUndefined();
      expect(generate).not.toHaveBeenCalled();
    }
  });
  it('surfaces a nonmaterial acquired publication-date warning in the answer qualification', async () => {
    const data = knowledge();
    data.sources[0].freshnessMetadata = { id: 'source-1', game: query.game, url: data.sources[0].url,
      fetchedAt: data.sources[0].fetchedAt, verifiedAt: data.sources[0].fetchedAt, metadataConfidence: 'unknown',
      metadataWarnings: ['PUBLICATION_DATE_UNVERIFIED'] };
    const { workflow } = setup(data);
    const result = await workflow.query(query, context);
    expect(result.body.state).toBe('answer_ready');
    expect(result.body.qualification).toContain('unusable publication or update date');
  });
  it('asks one targeted question for a known source and vague progression', async () => {
    const { workflow, generate } = setup({ ...empty, sourceKnown: true });
    const result = await workflow.query({ ...query, question: 'What next?' }, context);
    expect(result.body).toMatchObject({ state: 'clarification_required', nextAction: 'clarify', sourceKnown: true, evidenceSelected: false });
    expect(result.body.clarification?.match(/\?/gu)).toHaveLength(1);
    expect(generate).not.toHaveBeenCalled();
  });
  it('requests targeted discovery when a known corpus lacks specific coverage', async () => {
    const { workflow } = setup({ ...empty, sourceKnown: true });
    expect((await workflow.query(query, context)).body).toMatchObject({ state: 'discovery_required', sourceKnown: true, reason: 'COVERAGE_INSUFFICIENT' });
  });
  it('never treats database failure as an empty corpus', async () => {
    const retrieve = jest.fn(async () => { throw new Error('synthetic database unavailable'); });
    const workflow = createGamingHybridWorkflow({ retrieve });
    expect(await workflow.query(query, context)).toMatchObject({ status: 503, body: { state: 'temporarily_unavailable', nextAction: 'retry_later' } });
  });
  it('expires a live-status workflow before replay can outlast its applicability window', async () => {
    let clock = now;
    const retrieve = jest.fn(async () => empty);
    const workflow = createGamingHybridWorkflow({ retrieve, now: () => clock });
    const liveQuery = { ...query, question: 'What is the live server status?' };
    const first = await workflow.query(liveQuery, context);
    clock += 59_999;
    expect((await workflow.query(liveQuery, context)).body.workflowId).toBe(first.body.workflowId);
    expect(retrieve).toHaveBeenCalledTimes(1);
    clock += 1;
    expect((await workflow.query(liveQuery, context)).body.workflowId).not.toBe(first.body.workflowId);
    expect(retrieve).toHaveBeenCalledTimes(2);
  });
  it('CLEAR evidence judgment blocks generation when retained good sources lack combined question coverage', async () => {
    const data = knowledge();
    const { workflow, generate } = setup(data);
    const result = await workflow.query({ ...query, question: 'Where are the sapphire compass and violet tablet?' }, context);
    expect(result.body).toMatchObject({ state: 'discovery_required', nextAction: 'search', evidenceSelected: false,
      reason: 'QUESTION_COVERAGE_INSUFFICIENT', discovery: { maxRounds: 1, maxCandidates: 3 } });
    expect(generate).not.toHaveBeenCalled();
  });
  it('cached substantive answers expire with the actual proof age, without another discovery round or generation', async () => {
    let clock = now;
    const data = knowledge();
    data.sources[0].fetchedAt = new Date(now - (30 * 24 * 60 * 60 * 1_000) + 1_000).toISOString();
    const { generate } = setup();
    const retrieve = jest.fn(async () => data);
    const workflow = createGamingHybridWorkflow({ retrieve, generate, now: () => clock });
    const first = await workflow.query(query, context);
    expect(first.body.state).toBe('answer_ready');
    clock += 1_000;
    const expired = await workflow.query(query, context);
    expect(expired).toMatchObject({ status: 409, body: { reason: 'EVIDENCE_REVALIDATION_REQUIRED', nextAction: 'stop', sourceKnown: true } });
    expect(expired.body.answer).toBeUndefined();
    expect(retrieve).toHaveBeenCalledTimes(6);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('withholds a newly generated answer if its applicability proof expired during generation', async () => {
    let clock = now;
    const data = knowledge();
    data.sources[0].fetchedAt = new Date(now - (30 * 24 * 60 * 60 * 1_000) + 1_000).toISOString();
    const { generate } = setup();
    const workflow = createGamingHybridWorkflow({ retrieve: async () => data, now: () => clock,
      generate: async (request, prepared) => { clock += 1_000; return generate(request, prepared); } });
    const result = await workflow.query(query, context);
    expect(result.status).toBe(409);
    expect(result.body.answer).toBeUndefined();
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('does not attach an expired earlier answer when an ingestion operation throws', async () => {
    let clockOffset = 0;
    acquiredGuide(undefined, new Date(Date.now() + 1_000).toISOString());
    const { generate } = setup();
    const workflow = createGamingHybridWorkflow({ now: () => Date.now() + clockOffset, retrieve: async () => empty, generate,
      evaluateCandidates: evaluateGamingHybridCandidates,
      ingest: async () => { clockOffset += 1_000; throw new Error('Synthetic ingestion failure'); } });
    const first = await workflow.query({ ...query, storagePolicy: 'ask_before_store' }, context);
    const accepted = await workflow.candidates({ contractVersion, workflowId: first.body.workflowId,
      idempotencyKey: 'expiring-candidate-1', candidates: [{ url: 'https://example.com/lantern' }] }, context);
    expect(accepted.body.candidates?.[0].reasonCodes).toContain('VALIDATED_RELEVANT_CONTENT');
    expect(accepted.body.state).toBe('answer_ready');
    const candidateId = accepted.body.candidates![0].candidateId!;
    const failed = await workflow.ingest({ contractVersion, workflowId: first.body.workflowId, idempotencyKey: 'expiring-storage-1',
      candidateIds: [candidateId], storagePolicy: 'ask_before_store', confirmStore: true }, context);
    expect(failed).toMatchObject({ status: 409, body: { reason: 'EVIDENCE_REVALIDATION_REQUIRED' } });
    expect(failed.body.answer).toBeUndefined();
  });
  it.each(['patch_sensitive', 'live_status'] as const)('cached %s proof expires by its checked time', async category => {
    let clock = now;
    const age = category === 'live_status' ? 60_000 : 6 * 60 * 60_000;
    const checked = new Date(now - age + 1_000).toISOString();
    const data = knowledge();
    const question = category === 'live_status' ? 'What is the current server status?' : 'What changed for the copper gate in the patch?';
    const sourceText = category === 'live_status' ? 'The current server status is online with normal access to this synthetic game.' : 'The copper gate now requires a carved key after the documented patch change.';
    const metadata = { id: 'source-1', url: data.sources[0].url, game: query.game, policyVersion: GAMING_SOURCE_POLICY_VERSION,
      category: category === 'live_status' ? 'official_status' : 'official_updates', authority: 'official',
      currentness: category === 'live_status' ? 'live_status' : 'article', metadataConfidence: 'content_extracted',
      fetchedAt: checked, verifiedAt: checked, sourceUpdatedAt: checked, patch: '2.1', effectiveFrom: new Date(now - age - 1000).toISOString() };
    data.sources[0].freshnessMetadata = metadata;
    data.sources[0].snippet = sourceText;
    data.evidence![0].text = sourceText;
    if (category === 'patch_sensitive') {
      data.sources.push({ ...data.sources[0], sourceId: 'index-1', url: 'https://example.com/index',
        freshnessMetadata: { ...metadata, id: 'index-1', url: 'https://example.com/index', currentness: 'current_index', currentPatch: '2.1' } });
      data.evidence!.push({ ...data.evidence![0], sourceId: 'index-1', recordId: 'index:verification', publicUrl: 'https://example.com/index',
        text: 'The current official patch index identifies active patch 2.1.' });
    }
    const { generate } = setup();
    const workflow = createGamingHybridWorkflow({ retrieve: async () => data, generate, now: () => clock });
    const request = { ...query, question };
    expect((await workflow.query(request, context)).body.state).toBe('answer_ready');
    clock += 1_000;
    const expired = await workflow.query(request, context);
    expect(expired).toMatchObject({ status: 409, body: { reason: 'EVIDENCE_REVALIDATION_REQUIRED' } });
    expect(expired.body.answer).toBeUndefined();
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('allows same-key recovery after a database outage without losing payload binding', async () => {
    let available = false;
    const retrieve = jest.fn(async () => { if (!available) throw new Error('synthetic outage'); return empty; });
    const workflow = createGamingHybridWorkflow({ retrieve });
    expect((await workflow.query(query, context)).status).toBe(503);
    expect((await workflow.query({ ...query, question: 'Substituted question' }, context)).status).toBe(409);
    available = true;
    expect((await workflow.query(query, context)).body.state).toBe('discovery_required');
    expect(retrieve).toHaveBeenCalledTimes(2);
  });
  it.each(['reasoning', 'final'])('reports a %s provider timeout with retained evidence and waits for a client retry', async timeoutPhase => {
    const { workflow, generate, retrieve } = setup(knowledge());
    generate.mockImplementationOnce(async (_input: unknown, prepared: any) => ({ ok: true, route: 'gaming', mode: 'guide',
      data: { response: 'Answer generation timed out.', sources: prepared.knowledge.sources,
        grounding: { groundingStatus: 'grounded' }, fallbackReason: 'INTAKE_UPSTREAM_TIMEOUT', timeoutPhase } } as any));
    const failed = await workflow.query(query, context);
    expect(failed).toMatchObject({ status: 503, body: { state: 'temporarily_unavailable', nextAction: 'retry_later',
      reason: 'PROVIDER_TIMEOUT_WITH_EVIDENCE', sourceKnown: true, evidenceSelected: true, freshnessStatus: 'current' } });
    expect(failed.body.qualification).toBeTruthy();
    expect(failed.body.answer).toBeUndefined();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(retrieve).toHaveBeenCalledTimes(5);
    expect((await workflow.query({ ...query, question: 'Substituted question' }, context)).status).toBe(409);
    expect(generate).toHaveBeenCalledTimes(1);
    const [recovered, replay] = await Promise.all([workflow.query(query, context), workflow.query(query, context)]);
    expect(recovered.body).toMatchObject({ workflowId: failed.body.workflowId, state: 'answer_ready', evidenceSelected: true });
    expect(replay).toEqual(recovered);
    expect(retrieve).toHaveBeenCalledTimes(10);
    expect(generate).toHaveBeenCalledTimes(2);
  });
  it('reassesses aged evidence before a same-workflow client retry after a provider timeout', async () => {
    let clock = now;
    const data = knowledge();
    data.sources[0].fetchedAt = new Date(now - (30 * 24 * 60 * 60 * 1_000) + 1_000).toISOString();
    const retrieve = jest.fn(async () => data);
    const generate = jest.fn(async (_input: unknown, prepared: any) => ({ ok: true, route: 'gaming', mode: 'guide',
      data: { response: 'Answer generation timed out.', sources: prepared.knowledge.sources,
        grounding: { groundingStatus: 'grounded' }, fallbackReason: 'INTAKE_UPSTREAM_TIMEOUT' } } as any));
    const workflow = createGamingHybridWorkflow({ retrieve, generate, now: () => clock });
    const failed = await workflow.query(query, context);
    expect(failed.body.reason).toBe('PROVIDER_TIMEOUT_WITH_EVIDENCE');
    clock += 1_001;
    const retry = await workflow.query(query, context);
    expect(retry.body).toMatchObject({ workflowId: failed.body.workflowId, state: 'discovery_required', evidenceSelected: false });
    expect(retry.body.answer).toBeUndefined();
    expect(retrieve).toHaveBeenCalledTimes(6);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('binds retained-evidence timeout retry to the original operation after another workflow response', async () => {
    const { workflow, generate, retrieve, evaluateCandidates } = setup(knowledge());
    generate.mockImplementationOnce(async (_input: unknown, prepared: any) => ({ ok: true, route: 'gaming', mode: 'guide',
      data: { response: 'Answer generation timed out.', sources: prepared.knowledge.sources,
        grounding: { groundingStatus: 'grounded' }, fallbackReason: 'INTAKE_UPSTREAM_TIMEOUT' } } as any));
    const failed = await workflow.query(query, context);
    expect(failed.body.reason).toBe('PROVIDER_TIMEOUT_WITH_EVIDENCE');
    const intervening = await workflow.candidates({ contractVersion, workflowId: failed.body.workflowId,
      idempotencyKey: 'timeout-interleaved-candidates', candidates: [{ url: 'https://example.com/lantern' }] }, context);
    expect(intervening).toMatchObject({ status: 409, body: { reason: 'DISCOVERY_LIMIT_REACHED' } });
    const [retry, replay] = await Promise.all([workflow.query(query, context), workflow.query(query, context)]);
    expect(retry.body).toMatchObject({ workflowId: failed.body.workflowId, state: 'answer_ready', evidenceSelected: true });
    expect(replay).toEqual(retry);
    expect(retrieve).toHaveBeenCalledTimes(10);
    expect(evaluateCandidates).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledTimes(2);
  });
  it('retries generation from held candidate evidence without refetch or changed-key payload reuse', async () => {
    const { generate } = setup();
    let available = false;
    const evaluateCandidates = jest.fn(async () => ({ decisions: [], accepted: [], knowledge: knowledge() }));
    const workflow = createGamingHybridWorkflow({ retrieve: async () => empty, evaluateCandidates,
      generate: async (input, prepared) => { if (!available) throw new Error('synthetic provider unavailable'); return generate(input, prepared); } });
    const first = await workflow.query(query, context);
    const submission = { contractVersion, workflowId: first.body.workflowId, idempotencyKey: 'retry-candidate-1', candidates: [{ url: 'https://example.com/lantern' }] };
    expect((await workflow.candidates(submission, context)).status).toBe(503);
    expect((await workflow.candidates({ ...submission, candidates: [{ url: 'https://example.com/substitute' }] }, context)).status).toBe(409);
    available = true;
    expect((await workflow.candidates(submission, context)).body.state).toBe('answer_ready');
    expect(evaluateCandidates).toHaveBeenCalledTimes(1);
  });
  it('retries failed acquisition with the same payload-bound key while keeping the discovery round charged', async () => {
    const { generate } = setup();
    let available = false;
    const evaluateCandidates = jest.fn(async () => {
      if (!available) throw new Error('Synthetic acquisition cancellation');
      return { decisions: [], accepted: [], knowledge: knowledge() };
    });
    const workflow = createGamingHybridWorkflow({ retrieve: async () => empty, evaluateCandidates, generate });
    const first = await workflow.query(query, context);
    const submission = { contractVersion, workflowId: first.body.workflowId, idempotencyKey: 'retry-acquisition-1',
      candidates: [{ url: 'https://example.com/lantern' }] };
    expect(await workflow.candidates(submission, context)).toMatchObject({ status: 503, body: { nextAction: 'retry_later' } });
    expect((await workflow.candidates({ ...submission, idempotencyKey: 'alternative-acquisition-1' }, context)).status).toBe(409);
    expect((await workflow.candidates({ ...submission, candidates: [{ url: 'https://example.com/substitute' }] }, context)).status).toBe(409);
    available = true;
    const [recovered, replay] = await Promise.all([workflow.candidates(submission, context), workflow.candidates(submission, context)]);
    expect(recovered.body.state).toBe('answer_ready');
    expect(replay).toEqual(recovered);
    expect(evaluateCandidates).toHaveBeenCalledTimes(2);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it.each([
    { response: 'Fallback text', fallbackReason: 'GAMING_PROVIDER_ERROR' },
    { response: 'Unavailable', fallbackReason: 'GAMING_PROVIDER_UNAVAILABLE' },
    { response: 'Incomplete', fallbackReason: 'PROVIDER_COMPLETION_INCOMPLETE' },
    { response: 'I cannot browse or access the web.', fallbackReason: 'GAMING_PROVIDER_ERROR' },
    { response: 'Refused', fallbackReason: 'GAMING_ANSWER_REJECTED' },
    { response: '' },
    { response: 'Insufficient grounding', grounding: { groundingStatus: 'insufficient_evidence' } },
    { response: 'a'.repeat(18_001) }
  ])('keeps a non-timeout generation failure unavailable without a timeout label', async data => {
    const generate = jest.fn(async () => ({ ok: true, route: 'gaming', mode: 'guide', data: {
      grounding: { groundingStatus: 'grounded' }, ...data, sources: [] } } as any));
    const workflow = createGamingHybridWorkflow({ retrieve: async () => knowledge(), generate });
    expect((await workflow.query(query, context)).body).toMatchObject({ state: 'temporarily_unavailable',
      nextAction: 'retry_later', reason: 'GENERATION_UNAVAILABLE', sourceKnown: true, evidenceSelected: true });
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('keeps a provider answer integrity exception separate from timeout recovery', async () => {
    const generate = jest.fn(async () => { throw Object.assign(new Error('Private integrity diagnostic'), {
      code: 'TRINITY_OUTPUT_INTEGRITY_FAILED'
    }); });
    const workflow = createGamingHybridWorkflow({ retrieve: async () => knowledge(), generate });
    const result = await workflow.query(query, context);
    expect(result.body).toMatchObject({ state: 'temporarily_unavailable', nextAction: 'retry_later', reason: 'SERVICE_UNAVAILABLE' });
    expect(JSON.stringify(result.body)).not.toContain('Private integrity diagnostic');
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('coalesces concurrent same-key retries and rejects payload substitution', async () => {
    const { workflow, retrieve } = setup();
    const results = await Promise.all([workflow.query(query, context), workflow.query(query, context)]);
    expect(results[0]).toEqual(results[1]);
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect((await workflow.query({ ...query, question: 'Changed question' }, context)).status).toBe(409);
  });
  it('preserves the same workflow budget when a new key repeats the logical lookup', async () => {
    const { workflow, retrieve } = setup();
    const first = await workflow.query(query, context);
    const second = await workflow.query({ ...query, idempotencyKey: 'new-refresh-query' }, context);
    expect(first.body.workflowId).toBe(second.body.workflowId);
    expect(retrieve).toHaveBeenCalledTimes(1);
  });
  it('conceals workflows from other authenticated callers', async () => {
    const { workflow, evaluateCandidates } = setup();
    const first = await workflow.query(query, context);
    const result = await workflow.candidates({ contractVersion, workflowId: first.body.workflowId, idempotencyKey: 'candidate-submit-1',
      candidates: [{ url: 'https://example.com/lantern' }] }, { ...context, actorKey: 'unrelated-caller' });
    expect(result.status).toBe(404);
    expect(evaluateCandidates).not.toHaveBeenCalled();
  });
  it('atomically charges the only discovery round; same-key retry is safe', async () => {
    const { workflow, evaluateCandidates } = setup();
    const first = await workflow.query(query, context);
    const submission = { contractVersion, workflowId: first.body.workflowId, idempotencyKey: 'candidate-submit-1', candidates: [{ url: 'https://example.com/lantern' }] };
    const [one, two] = await Promise.all([workflow.candidates(submission, context), workflow.candidates({ ...submission, idempotencyKey: 'candidate-submit-2' }, context)]);
    expect(one.body).toMatchObject({ state: 'discovery_required', nextAction: 'stop', discovery: { round: 1 } });
    expect(two.status).toBe(409);
    expect(await workflow.candidates(submission, context)).toEqual(one);
    expect(evaluateCandidates).toHaveBeenCalledTimes(1);
  });
  it('preserves validated spoiler and player context across both calls', async () => {
    const { workflow, evaluateCandidates } = setup();
    const first = await workflow.query({ ...query, currentArea: 'Copper Quay', spoilerTolerance: 'none', answerDepth: 'detailed', constraints: ['No consumables'] }, context);
    await workflow.candidates({ contractVersion, workflowId: first.body.workflowId, idempotencyKey: 'candidate-context-1', candidates: [{ url: 'https://example.com/lantern' }] }, context);
    expect(evaluateCandidates).toHaveBeenCalledWith(expect.objectContaining({ prompt: query.question, currentArea: 'Copper Quay',
      spoilerMode: 'none', answerDepth: 'detailed', constraints: ['No consumables'] }), expect.anything());
  });
  it('transient-only workflows cannot be upgraded by a later storage request', async () => {
    const { workflow } = setup();
    const first = await workflow.query(query, context);
    const result = await workflow.ingest({ contractVersion, workflowId: first.body.workflowId, idempotencyKey: 'store-source-1',
      candidateIds: ['10000000-0000-4000-8000-000000000001'], storagePolicy: 'ask_before_store', confirmStore: true }, { ...context, canStore: true });
    expect(result.status).toBe(403);
  });
  describe('real acquired-artifact retention capacity', () => {
    let fixture: ReturnType<typeof setup>;
    let workflow: ReturnType<typeof createGamingHybridWorkflow>;
    let ingest: jest.Mock;
    let evaluateCandidates: jest.Mock<typeof evaluateGamingHybridCandidates>;
    let results: Awaited<ReturnType<typeof workflow.candidates>>[];
    beforeEach(() => {
      fixture = setup(); acquiredGuide(1_000_000); results = [];
      acquisitionStages = createGamingAcquisitionStages(acceptedHttp);
      evaluateCandidates = jest.fn<typeof evaluateGamingHybridCandidates>(async (input, callContext) => {
        const evaluated = await evaluateGamingHybridCandidates(input, callContext);
        expect(evaluated.accepted).toHaveLength(3);
        expect(evaluated.accepted.map(candidate => candidate.document.text.length)).toEqual([1_000_000, 1_000_000, 1_000_000]);
        return evaluated;
      });
      ingest = jest.fn(async () => ({ statusCode: 202, payload: { ok: true,
        ingestionId: '20000000-0000-4000-8000-000000000001', status: 'queued' } } as any));
      workflow = createGamingHybridWorkflow({ retrieve: async () => empty, evaluateCandidates, generate: fixture.generate, ingest: ingest as never });
    });
    // Keep all five real three-document submissions and the full 15m boundary;
    // each hook advances one acquired document within the unchanged deadline.
    for (let index = 0; index < 5; index += 1) {
      let batch: { advance(): Promise<unknown>; result: Promise<Awaited<ReturnType<typeof workflow.candidates>>> };
      beforeEach(async () => {
        const first = await workflow.query({ ...query, currentArea: `Copper Quay ${index}`,
          idempotencyKey: `capacity-query-${index}`, storagePolicy: 'ask_before_store' }, context);
        const urls = [1, 2, 3].map(candidate => `https://example.com/lantern-capacity-${candidate}`);
        batch = acquisitionStages!.begin(urls, signal => workflow.candidates({ contractVersion, workflowId: first.body.workflowId,
          idempotencyKey: `capacity-candidates-${index}`, candidates: [1, 2, 3].map(candidate => ({
            url: `https://example.com/lantern-capacity-${candidate}` })) }, { ...context, signal }));
        await batch.advance();
      });
      beforeEach(async () => { await batch.advance(); });
      beforeEach(async () => { await batch.advance(); results.push(await batch.result); });
    }
    it('keeps overflow artifacts transient without invalidating previously retained storage handles', async () => {
      expect(results[3].body.candidates?.every(candidate => candidate.candidateId)).toBe(true);
      const overflow = results[4];
      expect(overflow.body.state).toBe('answer_ready');
      expect(overflow.body.candidates).toHaveLength(3);
      for (const candidate of overflow.body.candidates!) {
        expect(candidate).toMatchObject({ decision: 'accepted_transient', reasonCodes: expect.arrayContaining(['ARTIFACT_CAPACITY_REACHED']) });
        expect(candidate).not.toHaveProperty('candidateId');
      }
      const storage = { contractVersion, idempotencyKey: 'capacity-storage-1', candidateIds: [results[0].body.candidates![0].candidateId!],
        storagePolicy: 'ask_before_store', confirmStore: true };
      expect((await workflow.ingest({ ...storage, workflowId: overflow.body.workflowId }, context)).status).toBe(404);
      expect(ingest).not.toHaveBeenCalled();
      expect((await workflow.ingest({ ...storage, workflowId: results[0].body.workflowId }, context)).body.state).toBe('ingestion_pending');
      expect(ingest).toHaveBeenCalledTimes(1);
      expect(evaluateCandidates).toHaveBeenCalledTimes(5); expect(acceptedHttp).toHaveBeenCalledTimes(15);
    });
  });
  it.each(([true, false] as const).flatMap(supported => [
    ['queued', 'INGESTION_QUEUED'], ['running', 'INGESTION_PROCESSING'],
    ['completed', 'INGESTION_RESULT_REQUIRED'], ['completed_with_errors', 'INGESTION_RESULT_REQUIRED'],
    ['failed', 'INGESTION_FAILED'], ['cancelled', 'INGESTION_CANCELLED'], ['expired', 'INGESTION_EXPIRED']
  ].map(([status, reason]) => ({ supported, status, reason }))))('reports existing ingestion $status with supported answer $supported truthfully', async ({ supported, status, reason }) => {
    const ingestionId = '20000000-0000-4000-8000-000000000001';
    const { generate } = setup();
    const workflow = createGamingHybridWorkflow({ retrieve: async () => empty, generate,
      evaluateCandidates: async (input, callContext) => {
        const evaluated = await evaluateGamingHybridCandidates(input, callContext);
        return { ...evaluated, knowledge: supported ? evaluated.knowledge : empty };
      },
      ingest: async () => ({ statusCode: 202, payload: { ok: true, ingestionId, status, deduplicated: true } } as any) });
    const first = await workflow.query({ ...query, storagePolicy: 'ask_before_store' }, context);
    const evaluated = await workflow.candidates({ contractVersion, workflowId: first.body.workflowId,
      idempotencyKey: 'terminal-candidate-1', candidates: [{ url: 'https://example.com/lantern' }] }, context);
    const candidateId = evaluated.body.candidates![0].candidateId!;
    const result = await workflow.ingest({ contractVersion, workflowId: first.body.workflowId,
      idempotencyKey: 'terminal-ingestion-1', candidateIds: [candidateId], storagePolicy: 'ask_before_store', confirmStore: true }, context);
    const failed = ['failed', 'cancelled', 'expired'].includes(status);
    const completed = ['completed', 'completed_with_errors'].includes(status);
    expect(result.body).toMatchObject({
      state: failed || completed ? supported ? 'answer_ready' : failed ? 'temporarily_unavailable' : 'ingestion_pending' : 'ingestion_pending',
      nextAction: failed ? supported ? 'answer' : 'stop' : 'poll_ingestion', reason,
      ingestion: { ingestionId, status, statusUrl: `/gpt-access/gaming/sources/ingestions/${ingestionId}` }
    });
    expect(result.body.answer).toEqual(evaluated.body.answer);
    if (status !== 'queued') expect(result.body.reason).not.toBe('INGESTION_QUEUED');
  });
  it.each([
    { contractVersion: 'unknown' }, { contextOrigins: { currentArea: 'explicit' } },
    { question: 'x'.repeat(4_001) }, { idempotencyKey: 'tiny' }
  ])('rejects invalid contract fields %j', async invalid => {
    const { workflow, retrieve } = setup();
    expect((await workflow.query({ ...query, ...invalid }, context)).status).toBe(400);
    expect(retrieve).not.toHaveBeenCalled();
  });
  it('enforces candidate count on the server', async () => {
    const { workflow } = setup();
    const first = await workflow.query(query, context);
    expect((await workflow.candidates({ contractVersion, workflowId: first.body.workflowId, idempotencyKey: 'too-many-candidates',
      candidates: Array.from({ length: 4 }, (_, index) => ({ url: `https://example.com/${index}` })) }, context)).status).toBe(400);
  });
  it('bounds authenticated retries independently of frontend cooperation', async () => {
    const { workflow } = setup();
    for (let index = 0; index < GAMING_HYBRID_LIMITS.operationsPerActor; index += 1) await workflow.query(query, context);
    expect((await workflow.query(query, context)).status).toBe(429);
  });
  it('expires held artifacts and original request context', async () => {
    let clock = now;
    const workflow = createGamingHybridWorkflow({ retrieve: async () => empty, now: () => clock });
    const first = await workflow.query(query, context);
    clock += GAMING_HYBRID_LIMITS.workflowTtlMs;
    expect((await workflow.candidates({ contractVersion, workflowId: first.body.workflowId, idempotencyKey: 'expired-candidates', candidates: [{ url: 'https://example.com/lantern' }] }, context)).status).toBe(404);
  });
});
