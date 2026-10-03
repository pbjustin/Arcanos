import { createHash } from 'node:crypto';
import { describe, expect, it, jest } from '@jest/globals';
import { createGamingHybridWorkflow } from '../src/services/gamingHybridKnowledge.js';
import { GAMING_HYBRID_CONTRACT_VERSION, GAMING_HYBRID_V2_CONTRACT_VERSION as contractVersion,
  GAMING_HYBRID_V2_LIMITS } from '../src/shared/gaming/gamingHybridContract.js';
import { gamingHybridCitationTargets, projectGamingHybridSuppliedGuides } from '../src/shared/gaming/gamingHybridPolicyCore.js';
import type { GamingStoredKnowledgeContext } from '../src/services/gamingStoredKnowledge.js';

const start = Date.parse('2026-10-03T12:00:00.000Z');
const context = { actorKey: 'fixture-recovery-actor', requestId: 'fixture-recovery-request' };
const query = { contractVersion, idempotencyKey: 'v2-lifecycle-query', question: 'How do I open the copper gate?', game: 'Lantern Voyage' };
const empty: GamingStoredKnowledgeContext = { context: '', sources: [], evidence: [], sourceKnown: false };
function setup() {
  let clock = start;
  const evaluateCandidates = jest.fn(async () => ({ decisions: [{ decision: 'rejected' as const, submittedIndex: 0,
    url: 'https://fixture.example/failed', reasonCodes: ['SOURCE_INACCESSIBLE'] }], accepted: [], knowledge: empty,
    acquisitionWorkMs: 12_000 }));
  const generate = jest.fn<any>();
  const workflow = createGamingHybridWorkflow({ retrieve: async () => empty, evaluateCandidates, generate, now: () => clock });
  return { workflow, evaluateCandidates, generate, advance: (elapsed: number) => { clock += elapsed; } };
}
function submission(workflowId: string, expectedRevision: number, suffix = 'initial') {
  return { contractVersion, workflowId, expectedRevision, idempotencyKey: `v2-candidate-${suffix}`,
    candidates: [{ url: `https://fixture.example/${suffix}` }] };
}

describe('v2 actor-bound recovery lifecycle', () => {
  it('preserves the requested protocol on query conflicts and capacity failures', async () => {
    const { workflow } = setup();
    const first = await workflow.query(query, context);
    expect((await workflow.query({ ...query, question: 'How do I open the silver gate?' }, context)).body)
      .toMatchObject({ contractVersion, revision: 0, reason: 'IDEMPOTENCY_CONFLICT', nextAction: 'stop' });
    expect((await workflow.query({ ...query, idempotencyKey: 'v2-version-conflict',
      version: '1.0', requestedVersion: '2.0' }, context)).body)
      .toMatchObject({ contractVersion, reason: 'VERSION_CONTEXT_CONFLICT', nextAction: 'stop' });
    expect((await workflow.query({ ...query, idempotencyKey: 'v2-context-invalid', requestedVersion: 'latest' }, context)).body)
      .toMatchObject({ contractVersion, reason: 'INVALID_REQUEST', nextAction: 'stop' });
    for (let index = 1; index < GAMING_HYBRID_V2_LIMITS.workflowsPerActor; index += 1) {
      await workflow.query({ ...query, idempotencyKey: `v2-capacity-${index}`, question: `Explain fixture objective ${index}.` }, context);
    }
    expect((await workflow.query({ ...query, idempotencyKey: 'v2-capacity-overflow', question: 'Explain fixture overflow.' }, context)).body)
      .toMatchObject({ contractVersion, revision: 0, reason: 'WORKFLOW_CAPACITY_REACHED', nextAction: 'retry_later' });
    expect(first.body.contractVersion).toBe(contractVersion);
  });

  it('grants exactly one recovery, charges failures and replays completed operations without work', async () => {
    const { workflow, evaluateCandidates, generate } = setup();
    const first = await workflow.query(query, context);
    expect(first.body).toMatchObject({ contractVersion, revision: 0, nextAction: 'search',
      discovery: { maxRounds: 2, recoveryRemaining: 1, replacementAllowed: false, remainingTotalAcquisitionMs: 24_000 } });
    const initial = submission(first.body.workflowId!, 0);
    const grant = await workflow.candidates(initial, context);
    expect(grant.body).toMatchObject({ revision: 1, nextAction: 'search', gapAssessmentStatus: 'unknown',
      discovery: { replacementAllowed: true, recoveryRemaining: 1, remainingTotalAcquisitionMs: 12_000,
        remainingCandidateUrls: 5, continuationRequired: true } });
    expect(await workflow.candidates(initial, context)).toEqual(grant);
    expect(evaluateCandidates).toHaveBeenCalledTimes(1);
    const recovery = submission(first.body.workflowId!, 1, 'replacement');
    const stop = await workflow.candidates(recovery, context);
    expect(stop.body).toMatchObject({ revision: 2, nextAction: 'stop',
      discovery: { round: 2, maxRounds: 2, replacementAllowed: false, recoveryRemaining: 0,
        remainingTotalAcquisitionMs: 0, nextSubmissionCandidateLimit: 0, continuationRequired: false } });
    expect(await workflow.candidates(recovery, context)).toEqual(stop);
    expect((await workflow.candidates(submission(first.body.workflowId!, 2, 'third'), context)).body.reason).toBe('WORKFLOW_CLOSED');
    expect(evaluateCandidates).toHaveBeenCalledTimes(2);
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects changed payload, stale revisions, cross-actor IDs and version upgrades', async () => {
    const { workflow, evaluateCandidates } = setup();
    const first = await workflow.query(query, context);
    const initial = submission(first.body.workflowId!, 0);
    await workflow.candidates(initial, context);
    expect((await workflow.candidates({ ...initial, candidates: [{ url: 'https://fixture.example/changed' }] }, context)).body.reason).toBe('IDEMPOTENCY_CONFLICT');
    expect((await workflow.candidates(submission(first.body.workflowId!, 0, 'stale'), context)).body.reason).toBe('STALE_WORKFLOW_REVISION');
    expect((await workflow.candidates(submission(first.body.workflowId!, 1, 'other'), { ...context, actorKey: 'another-actor' })).body.reason).toBe('WORKFLOW_UNAVAILABLE');
    expect((await workflow.candidates({ ...initial, contractVersion: GAMING_HYBRID_CONTRACT_VERSION, expectedRevision: undefined }, context)).body.reason).toBe('INVALID_REQUEST');
    const { expectedRevision: _revision, ...legacy } = initial;
    expect((await workflow.candidates({ ...legacy, contractVersion: GAMING_HYBRID_CONTRACT_VERSION }, context)).body.reason).toBe('PROTOCOL_VERSION_MISMATCH');
    expect(evaluateCandidates).toHaveBeenCalledTimes(1);
  });

  it('cannot release another in-flight lock through a conflicting same-key request', async () => {
    const { workflow, evaluateCandidates } = setup();
    let finish!: (value: Awaited<ReturnType<typeof evaluateCandidates>>) => void;
    evaluateCandidates.mockImplementationOnce(async () => new Promise(resolve => { finish = resolve; }));
    const first = await workflow.query(query, context);
    const initial = submission(first.body.workflowId!, 0);
    const pending = workflow.candidates(initial, context);
    await Promise.resolve(); await Promise.resolve();
    expect((await workflow.candidates({ ...initial, candidates: [{ url: 'https://fixture.example/changed' }] }, context)).body.reason).toBe('IDEMPOTENCY_CONFLICT');
    expect((await workflow.candidates(submission(first.body.workflowId!, 1, 'concurrent'), context)).body.reason).toBe('SUBMISSION_IN_PROGRESS');
    finish({ decisions: [], accepted: [], knowledge: empty, acquisitionWorkMs: 12_000 });
    const result = await pending;
    expect(result.body.revision).toBe(1);
    expect(evaluateCandidates).toHaveBeenCalledTimes(1);
  });

  it('rejects expired continuations and identical expired query retries without renewed allowance', async () => {
    const { workflow, evaluateCandidates, advance } = setup();
    const first = await workflow.query(query, context);
    advance(GAMING_HYBRID_V2_LIMITS.workflowTtlMs);
    expect((await workflow.candidates(submission(first.body.workflowId!, 0), context)).body.reason).toBe('WORKFLOW_UNAVAILABLE');
    expect((await workflow.query(query, context)).body).toMatchObject({ contractVersion, nextAction: 'stop', reason: 'WORKFLOW_EXPIRED' });
    expect(evaluateCandidates).not.toHaveBeenCalled();
  });

  it('cancellation charges elapsed acquisition and closes the workflow before a continuation', async () => {
    const { workflow, evaluateCandidates, advance } = setup();
    const controller = new AbortController();
    const first = await workflow.query(query, context);
    evaluateCandidates.mockImplementationOnce(async () => {
      advance(4_000); controller.abort(); throw new Error('fixture cancellation');
    });
    const cancelled = await workflow.candidates(submission(first.body.workflowId!, 0), { ...context, signal: controller.signal });
    expect(cancelled.body).toMatchObject({ revision: 1, nextAction: 'stop', reason: 'REQUEST_CANCELLED' });
    expect((await workflow.candidates(submission(first.body.workflowId!, 1, 'after-cancel'), context)).body.reason).toBe('WORKFLOW_CLOSED');
    expect(evaluateCandidates).toHaveBeenCalledTimes(1);
  });

  it('clarifies a broad build request even when the frontend leaves the default guide mode', async () => {
    const { workflow, evaluateCandidates, generate } = setup();
    const result = await workflow.query({ ...query, question: 'Give me a build.' }, context);
    expect(result.body).toMatchObject({ state: 'clarification_required', nextAction: 'clarify', reason: 'BUILD_GOAL_REQUIRED' });
    expect(evaluateCandidates).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
  });

  it('preserves v1 cancellation failure and retry semantics', async () => {
    const { workflow, evaluateCandidates } = setup();
    const controller = new AbortController(); controller.abort();
    const result = await workflow.query({ ...query, contractVersion: GAMING_HYBRID_CONTRACT_VERSION }, { ...context, signal: controller.signal });
    expect(result).toMatchObject({ status: 503, body: { contractVersion: GAMING_HYBRID_CONTRACT_VERSION,
      reason: 'SERVICE_UNAVAILABLE', nextAction: 'retry_later' } });
    expect(evaluateCandidates).not.toHaveBeenCalled();
  });

  it('never exposes private question prose in conservative frontend search queries', async () => {
    const { workflow } = setup();
    const result = await workflow.query({ ...query, question: 'Weapon configuration for my private character QuietCobaltOwner; my account 778899 and private apartment Orchard Terrace.' }, context);
    const searches = result.body.discovery?.searchQueries.join(' ') ?? '';
    expect(searches).toContain('weapon configuration');
    expect(searches).not.toMatch(/QuietCobaltOwner|778899|Orchard|Terrace|private|account/iu);
  });

  it('supplied-guide receipts require actor/workflow validity and selected intact redirected evidence', () => {
    const acquisitionActorHash = createHash('sha256').update(context.actorKey, 'utf8').digest('hex');
    const workflowActorHash = createHash('sha256').update(JSON.stringify(context.actorKey)).digest('hex');
    const accepted = [{ candidateId: 'supplied-source', actorScopeHash: acquisitionActorHash, workflowId: 'workflow-id', expiresAt: start + 1_000,
      publicUrl: 'https://fixture.example/canonical', document: { requestedUrl: 'https://fixture.example/original' } }];
    const selected: GamingStoredKnowledgeContext = { context: '', sources: [{ sourceId: 'supplied-source',
      url: 'https://fixture.example/canonical', sourceType: 'guide', fetchedAt: new Date(start).toISOString(), snippet: 'Intact guide.' }],
      evidence: [{ sourceId: 'supplied-source', revisionId: 'revision', recordId: 'record', recordType: 'guide',
        publicUrl: 'https://fixture.example/canonical', text: 'Intact guide.', lexicalScore: 1, combinedScore: 1,
        provenance: { fetchedAt: new Date(start).toISOString() } }] };
    const request = { requiredUrls: ['https://fixture.example/original'], accepted, knowledge: selected, actorScopeHash: acquisitionActorHash,
      workflowId: 'workflow-id', now: start };
    expect(projectGamingHybridSuppliedGuides(request)).toEqual([{ requestedUrl: 'https://fixture.example/original',
      sourceId: 'supplied-source', publicUrl: 'https://fixture.example/canonical' }]);
    expect(projectGamingHybridSuppliedGuides({ ...request, actorScopeHash: 'another-actor' })).toEqual([]);
    expect(projectGamingHybridSuppliedGuides({ ...request, actorScopeHash: workflowActorHash })).toEqual([]);
    expect(projectGamingHybridSuppliedGuides({ ...request, workflowId: 'another-workflow' })).toEqual([]);
    expect(projectGamingHybridSuppliedGuides({ ...request, now: start + 1_000 })).toEqual([]);
    expect(projectGamingHybridSuppliedGuides({ ...request, knowledge: { ...selected, evidence: [] } })).toEqual([]);
    expect(projectGamingHybridSuppliedGuides({ ...request, knowledge: { ...selected, sources: [] } })).toEqual([]);
  });

  it('extracts citation targets exactly while excluding surrounding punctuation', () => {
    expect(gamingHybridCitationTargets('Read [the guide](https://fixture.example/guide). Also https://fixture.example/second, then proceed.'))
      .toEqual(['https://fixture.example/guide', 'https://fixture.example/second']);
  });
});
