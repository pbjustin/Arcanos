import { describe, it, expect, jest } from '@jest/globals';
import { createGamingHybridWorkflow } from '../src/services/gamingHybridKnowledge.js';
import { GAMING_HYBRID_CONTRACT_VERSION as contractVersion, GAMING_HYBRID_LIMITS } from '../src/shared/gaming/gamingHybridContract.js';
import type { GamingStoredKnowledgeContext } from '../src/services/gamingStoredKnowledge.js';

const now = Date.now();
const context = { actorKey: 'synthetic-gaming-caller', requestId: 'synthetic-request' };
const query = { contractVersion, idempotencyKey: 'synthetic-query-1', question: 'How do I open the copper gate?', game: 'Lantern Voyage' };
const empty: GamingStoredKnowledgeContext = { context: '', sources: [], sourceKnown: false };
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
  it('does not promote provider fallback or overlarge output to an answer', async () => {
    for (const data of [{ response: 'Fallback text', fallbackReason: 'GAMING_PROVIDER_ERROR' }, { response: 'a'.repeat(18_001) }]) {
      const workflow = createGamingHybridWorkflow({ retrieve: async () => knowledge(), generate: async () => ({ ok: true, route: 'gaming', mode: 'guide', data: { ...data, sources: [] } } as any) });
      expect((await workflow.query(query, context)).body.state).toBe('temporarily_unavailable');
    }
  });
  it('coalesces concurrent same-key retries and rejects payload substitution', async () => {
    const { workflow, retrieve } = setup();
    const results = await Promise.all([workflow.query(query, context), workflow.query(query, context)]);
    expect(results[0]).toEqual(results[1]);
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect((await workflow.query({ ...query, question: 'Changed question' }, context)).status).toBe(409);
  });
  it('permits a new logical lookup under a new key', async () => {
    const { workflow, retrieve } = setup();
    const first = await workflow.query(query, context);
    const second = await workflow.query({ ...query, idempotencyKey: 'new-refresh-query' }, context);
    expect(first.body.workflowId).not.toBe(second.body.workflowId);
    expect(retrieve).toHaveBeenCalledTimes(2);
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
  it.each(([true, false] as const).flatMap(supported => [
    ['queued', 'INGESTION_QUEUED'], ['running', 'INGESTION_PROCESSING'],
    ['completed', 'INGESTION_RESULT_REQUIRED'], ['completed_with_errors', 'INGESTION_RESULT_REQUIRED'],
    ['failed', 'INGESTION_FAILED'], ['cancelled', 'INGESTION_CANCELLED'], ['expired', 'INGESTION_EXPIRED']
  ].map(([status, reason]) => ({ supported, status, reason }))))('reports existing ingestion $status with supported answer $supported truthfully', async ({ supported, status, reason }) => {
    const candidateId = '10000000-0000-4000-8000-000000000001';
    const ingestionId = '20000000-0000-4000-8000-000000000001';
    const { generate } = setup();
    const workflow = createGamingHybridWorkflow({ retrieve: async () => empty, generate,
      evaluateCandidates: async () => ({ decisions: [], knowledge: supported ? knowledge() : empty,
        accepted: [{ candidateId, document: { text: '' }, freshness: { id: candidateId, game: query.game,
          url: 'https://example.com/lantern', fetchedAt: new Date(now).toISOString(), verifiedAt: new Date(now).toISOString() } }] } as any),
      ingest: async () => ({ statusCode: 202, payload: { ok: true, ingestionId, status, deduplicated: true } } as any) });
    const first = await workflow.query({ ...query, storagePolicy: 'ask_before_store' }, context);
    const evaluated = await workflow.candidates({ contractVersion, workflowId: first.body.workflowId,
      idempotencyKey: 'terminal-candidate-1', candidates: [{ url: 'https://example.com/lantern' }] }, context);
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
