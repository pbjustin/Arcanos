import { describe, expect, it, jest } from '@jest/globals';
import { createGamingHybridWorkflow } from '../src/services/gamingHybridKnowledge.js';
import type { GamingHybridDependencies } from '../src/services/gamingHybridKnowledge.js';

const actor = { actorKey: 'edition-budget-actor', requestId: 'edition-budget-request' };
const query = { contractVersion: 'gaming-hybrid-v2', idempotencyKey: 'edition-budget-query', game: 'Elden Ring',
  question: 'How do I use the Uchigatana immediately after the tutorial?', class: 'Samurai',
  progressPoint: 'just left the tutorial' };
const empty = { context: '', sources: [], evidence: [], sourceKnown: false };
const aliases = ['Base game', 'base-game', 'BASE GAME'];

function setup(now: () => number = () => Date.parse('2026-10-04T12:00:00Z')) {
  const retrieve = jest.fn<GamingHybridDependencies['retrieve']>(async () => empty);
  const evaluateCandidates = jest.fn<GamingHybridDependencies['evaluateCandidates']>(async input => ({
    knowledge: empty, accepted: [], acquisitionWorkMs: 12_000,
    decisions: input.candidates.map((candidate, submittedIndex) => ({ submittedIndex, url: candidate.url,
      decision: 'rejected', reasonCodes: ['SOURCE_INACCESSIBLE'] })) }));
  const ingest = jest.fn<GamingHybridDependencies['ingest']>();
  const workflow = createGamingHybridWorkflow({ retrieve, evaluateCandidates, ingest, now });
  return { workflow, retrieve, evaluateCandidates, ingest };
}
function candidates(workflowId: string, expectedRevision: number, suffix: string) {
  return { contractVersion: query.contractVersion, workflowId, expectedRevision, idempotencyKey: `edition-candidates-${suffix}`,
    candidates: [0, 1, 2].map(index => ({ url: `https://guides.example.org/${suffix}-${index}` })) };
}

describe('v2 acquisition budget binds the effective request edition', () => {
  it('cannot replenish charged or exhausted budgets by adding a base-game alias under a new key', async () => {
    const { workflow, retrieve, evaluateCandidates, ingest } = setup();
    const initial = await workflow.query(query, actor);
    const first = await workflow.candidates(candidates(initial.body.workflowId!, 0, 'first'), actor);
    expect(first.body).toMatchObject({ revision: 1, discovery: { round: 1, remainingCandidateUrls: 3,
      remainingTotalAcquisitionMs: 12_000, recoveryRemaining: 1 } });
    for (const [index, edition] of aliases.entries()) {
      const replay = await workflow.query({ ...query, edition, idempotencyKey: `edition-charged-${index}` }, actor);
      expect(replay.body).toMatchObject({ workflowId: initial.body.workflowId, revision: 1,
        discovery: { round: 1, remainingCandidateUrls: 3, remainingTotalAcquisitionMs: 12_000, recoveryRemaining: 1 } });
    }
    const exhausted = await workflow.candidates(candidates(initial.body.workflowId!, 1, 'recovery'), actor);
    expect(exhausted.body).toMatchObject({ revision: 2, nextAction: 'stop', discovery: { round: 2,
      remainingCandidateUrls: 0, remainingTotalAcquisitionMs: 0, recoveryRemaining: 0 } });
    for (const [index, edition] of aliases.entries()) {
      const replay = await workflow.query({ ...query, edition, idempotencyKey: `edition-exhausted-${index}` }, actor);
      expect(replay.body).toMatchObject({ workflowId: initial.body.workflowId, revision: 2, nextAction: 'stop',
        discovery: { round: 2, remainingCandidateUrls: 0, remainingTotalAcquisitionMs: 0, recoveryRemaining: 0 } });
      expect((await workflow.candidates(candidates(replay.body.workflowId!, 2, `denied-${index}`), actor)).body.reason)
        .toBe('WORKFLOW_CLOSED');
    }
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(evaluateCandidates).toHaveBeenCalledTimes(2);
    expect(ingest).not.toHaveBeenCalled();
  });

  it('keeps raw payload idempotency strict for added or changed edition fields', async () => {
    const { workflow, retrieve } = setup();
    await workflow.query(query, actor);
    expect((await workflow.query({ ...query, edition: 'Base game' }, actor)))
      .toMatchObject({ status: 409, body: { reason: 'IDEMPOTENCY_CONFLICT' } });
    const explicit = { ...query, edition: 'Base game', idempotencyKey: 'edition-explicit-query' };
    await workflow.query(explicit, actor);
    expect((await workflow.query({ ...explicit, edition: 'base-game' }, actor)))
      .toMatchObject({ status: 409, body: { reason: 'IDEMPOTENCY_CONFLICT' } });
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it('shares the budget when the explicit base-game request arrives first', async () => {
    const { workflow, retrieve } = setup();
    const explicit = await workflow.query({ ...query, edition: 'Base game' }, actor);
    const implicit = await workflow.query({ ...query, idempotencyKey: 'edition-implicit-later' }, actor);
    expect(implicit.body.workflowId).toBe(explicit.body.workflowId);
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it('does not invent a base-game edition for a catalog without a safe default', async () => {
    const { workflow, retrieve } = setup();
    const request = { ...query, game: 'Amber Pilgrim' };
    const unspecified = await workflow.query(request, actor);
    const explicit = await workflow.query({ ...request, edition: 'Base game', idempotencyKey: 'edition-catalog-explicit' }, actor);
    expect(explicit.body.workflowId).not.toBe(unspecified.body.workflowId);
    expect(retrieve).toHaveBeenCalledTimes(2);
  });

  it('does not renew the original absolute expiry through a base-game alias', async () => {
    let clock = Date.parse('2026-10-04T12:00:00Z');
    const { workflow, retrieve, evaluateCandidates } = setup(() => clock);
    const first = await workflow.query(query, actor);
    clock += 9 * 60_000;
    const alias = { ...query, edition: 'base-game', idempotencyKey: 'edition-before-expiry' };
    expect((await workflow.query(alias, actor)).body.workflowId).toBe(first.body.workflowId);
    clock += 60_000;
    expect(await workflow.query(alias, actor)).toMatchObject({ status: 409, body: { reason: 'WORKFLOW_EXPIRED' } });
    expect((await workflow.candidates(candidates(first.body.workflowId!, 0, 'expired'), actor)).body.reason)
      .toBe('WORKFLOW_UNAVAILABLE');
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(evaluateCandidates).not.toHaveBeenCalled();
  });

  it('does not upgrade the retained transient storage policy through an edition alias', async () => {
    const { workflow, ingest } = setup();
    const first = await workflow.query(query, actor);
    const upgraded = await workflow.query({ ...query, edition: 'Base game', idempotencyKey: 'edition-storage-upgrade',
      storagePolicy: 'auto_store_approved' }, actor);
    expect(upgraded.body.workflowId).toBe(first.body.workflowId);
    const result = await workflow.ingest({ contractVersion: query.contractVersion, workflowId: upgraded.body.workflowId,
      idempotencyKey: 'edition-ingest-denied', candidateIds: ['11111111-1111-4111-8111-111111111111'],
      storagePolicy: 'auto_store_approved', confirmStore: true }, { ...actor, canStore: true, canAutoStore: true });
    expect(result).toMatchObject({ status: 403, body: { reason: 'STORAGE_POLICY_DENIED' } });
    expect(ingest).not.toHaveBeenCalled();
  });

  it.each([{ mode: 'meta' }, { spoilerTolerance: 'full' }, { answerDepth: 'detailed' }])
  ('preserves mode, spoiler and depth fences for shared budgets: %j', async changed => {
    const { workflow, retrieve } = setup();
    await workflow.query(query, actor);
    expect(await workflow.query({ ...query, ...changed, edition: 'base-game', idempotencyKey: 'edition-context-changed' }, actor))
      .toMatchObject({ status: 409, body: { reason: 'QUERY_CONTEXT_CONFLICT' } });
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it('keeps explicit DLC intent and other actors isolated from the default base-game workflow', async () => {
    const { workflow, retrieve } = setup();
    const base = await workflow.query(query, actor);
    const dlc = await workflow.query({ ...query, edition: 'Shadow of the Erdtree', idempotencyKey: 'edition-dlc-intent' }, actor);
    const otherActor = await workflow.query({ ...query, edition: 'base-game', idempotencyKey: 'edition-another-actor' },
      { actorKey: 'edition-other-actor' });
    expect(dlc.body.workflowId).not.toBe(base.body.workflowId);
    expect(otherActor.body.workflowId).not.toBe(base.body.workflowId);
    expect(new Set([base.body.workflowId, dlc.body.workflowId, otherActor.body.workflowId]).size).toBe(3);
    expect(retrieve).toHaveBeenCalledTimes(3);
  });

  it('preserves explicit v1 budget behavior', async () => {
    const { workflow, retrieve } = setup();
    const request = { ...query, contractVersion: 'gaming-hybrid-v1' };
    const first = await workflow.query(request, actor);
    const explicit = await workflow.query({ ...request, edition: 'base-game', idempotencyKey: 'edition-v1-explicit' }, actor);
    expect(explicit.body.workflowId).not.toBe(first.body.workflowId);
    expect(retrieve).toHaveBeenCalledTimes(2);
  });
});
