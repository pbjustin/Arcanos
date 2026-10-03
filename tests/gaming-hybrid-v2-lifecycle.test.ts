import { createHash } from 'node:crypto';
import { describe, expect, it, jest } from '@jest/globals';
import { createGamingHybridWorkflow } from '../src/services/gamingHybridKnowledge.js';
import { evaluateGamingHybridCandidates } from '../src/services/gamingHybridCandidates.js';
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
  it('stops when the complete structural conflict assessment is unavailable', async () => {
    const generate = jest.fn<any>();
    const evaluateCandidates = jest.fn<any>();
    const workflow = createGamingHybridWorkflow({ retrieve: async () => ({ ...empty,
      structuralConflictAssessmentUnavailable: true }), generate, evaluateCandidates, now: () => start });
    const result = await workflow.query(query, context);
    expect(result.body).toMatchObject({ contractVersion, revision: 0, nextAction: 'stop',
      reason: 'STRUCTURAL_CONFLICT_ASSESSMENT_UNVERIFIED', evidenceSelected: false, coverageSatisfied: false,
      gapAssessmentStatus: 'unknown', selectedCandidateIds: [], selectedEvidenceIds: [],
      discovery: { continuationRequired: false, replacementAllowed: false } });
    expect(result.body.answer).toBeUndefined();
    expect(generate).not.toHaveBeenCalled(); expect(evaluateCandidates).not.toHaveBeenCalled();
  });

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

  it('rejects an otherwise valid continuation on another replica or a restarted coordinator before work', async () => {
    const original = setup();
    const first = await original.workflow.query(query, context);
    const grant = await original.workflow.candidates(submission(first.body.workflowId!, 0), context);
    expect(grant.body.discovery).toMatchObject({ replacementAllowed: true, recoveryRemaining: 1 });
    const continuation = submission(first.body.workflowId!, grant.body.revision!, 'instance-continuation');
    // Fresh constructors model independent memory on another replica and after
    // restart. Neither receives the original workflow's state or allowances.
    for (const isolated of [setup(), setup()]) {
      const rejected = await isolated.workflow.candidates(continuation, context);
      expect(rejected).toMatchObject({ status: 404, body: { contractVersion, reason: 'WORKFLOW_UNAVAILABLE', nextAction: 'stop' } });
      expect(rejected.body.answer).toBeUndefined();
      expect(isolated.evaluateCandidates).not.toHaveBeenCalled(); expect(isolated.generate).not.toHaveBeenCalled();
    }
    const completed = await original.workflow.candidates(continuation, context);
    expect(completed.body).toMatchObject({ revision: 2, discovery: { round: 2, recoveryRemaining: 0 } });
    expect(original.evaluateCandidates).toHaveBeenCalledTimes(2); expect(original.generate).not.toHaveBeenCalled();
  });

  it('keeps acquisition hints and replay observations on the original absolute expiry through recovery', async () => {
    const { workflow, evaluateCandidates, generate, advance } = setup();
    const first = await workflow.query(query, context);
    advance(9 * 60_000);
    const initial = submission(first.body.workflowId!, 0);
    const grant = await workflow.candidates(initial, context);
    const expiry = new Date(start + GAMING_HYBRID_V2_LIMITS.workflowTtlMs).toISOString();
    expect(grant.body.discovery!.acquisitionHints).toEqual([{ scope: 'url', target: 'https://fixture.example/failed',
      reasonCode: 'SOURCE_INACCESSIBLE', observedAt: new Date(start + 9 * 60_000).toISOString(), expiresAt: expiry }]);
    advance(15_000);
    expect(await workflow.candidates(initial, context)).toEqual(grant);
    expect(evaluateCandidates).toHaveBeenCalledTimes(1);
    advance(15_000);
    const recovery = await workflow.candidates(submission(first.body.workflowId!, grant.body.revision!, 'hint-recovery'), context);
    expect(recovery.body.discovery!.acquisitionHints).toEqual([{ scope: 'url', target: 'https://fixture.example/failed',
      reasonCode: 'SOURCE_INACCESSIBLE', observedAt: new Date(start + 9 * 60_000 + 30_000).toISOString(), expiresAt: expiry }]);
    advance(30_000);
    const expired = await workflow.candidates(submission(first.body.workflowId!, recovery.body.revision!, 'after-hint-expiry'), context);
    expect(expired).toMatchObject({ status: 404, body: { reason: 'WORKFLOW_UNAVAILABLE', nextAction: 'stop' } });
    expect(expired.body.discovery).toBeUndefined();
    expect((await workflow.query(query, context)).body).toMatchObject({ reason: 'WORKFLOW_EXPIRED', nextAction: 'stop' });
    expect(evaluateCandidates).toHaveBeenCalledTimes(2); expect(generate).not.toHaveBeenCalled();
  });

  it('keeps one URL access observation from poisoning another allowed URL or overriding security admission', async () => {
    let clock = start;
    const resolveDocument = jest.fn(async (_url: string) => {
      clock += 250;
      throw new Error('Synthetic acquisition fixture failure.');
    });
    const evaluateCandidates = jest.fn<typeof evaluateGamingHybridCandidates>((input, callContext) =>
      evaluateGamingHybridCandidates(input, callContext, { resolveDocument }));
    const generate = jest.fn<any>();
    const workflow = createGamingHybridWorkflow({ retrieve: async () => empty, evaluateCandidates, generate, now: () => clock });
    const failedUrl = 'https://fixture.example/first-unavailable';
    const allowedUrl = 'https://fixture.example/another-guide';
    const blockedUrl = 'https://127.0.0.1/private-guide';
    const first = await workflow.query(query, context);
    const grant = await workflow.candidates({ ...submission(first.body.workflowId!, 0), candidates: [{ url: failedUrl }] }, context);
    expect(grant.body.discovery!.acquisitionHints).toEqual([expect.objectContaining({ scope: 'url', target: failedUrl,
      reasonCode: 'SOURCE_FETCH_FAILED', expiresAt: new Date(start + GAMING_HYBRID_V2_LIMITS.workflowTtlMs).toISOString() })]);
    const recovery = await workflow.candidates({ ...submission(first.body.workflowId!, grant.body.revision!, 'safe-url-recovery'),
      candidates: [{ url: allowedUrl }, { url: blockedUrl }] }, context);
    // The real candidate admission still attempts the independent safe path;
    // injected document resolution supplies the failure without network access.
    expect(resolveDocument).toHaveBeenCalledTimes(2);
    expect(resolveDocument.mock.calls.map(([url]) => url)).toEqual([failedUrl, allowedUrl]);
    expect(recovery.body.candidates).toEqual([expect.objectContaining({ url: allowedUrl, reasonCodes: ['SOURCE_FETCH_FAILED'] }),
      expect.objectContaining({ decision: 'rejected', reasonCodes: ['URL_BLOCKED'] })]);
    expect(recovery.body.discovery!.acquisitionHints).toEqual([expect.objectContaining({ scope: 'url', target: allowedUrl,
      reasonCode: 'SOURCE_FETCH_FAILED' })]);
    expect(recovery.body.discovery!.acquisitionHints!.every(hint => hint.scope === 'url' && hint.target !== blockedUrl)).toBe(true);
    expect(generate).not.toHaveBeenCalled();
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
