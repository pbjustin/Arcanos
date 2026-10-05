import { describe, expect, it, jest } from '@jest/globals';
import { createGamingHybridWorkflow } from '../src/services/gamingHybridKnowledge.js';
import { isGamingMcpOutput } from '../src/shared/chatgpt/gamingMcpContract.js';

const query = { idempotencyKey: 'october4-samurai-query', game: 'Elden Ring', mode: 'build', class: 'Samurai',
  progressPoint: 'just left the tutorial', question: 'Build me an early-game Samurai katana blade build.' };
const context = { actorKey: 'october4-fixture-reader' };
const empty = { context: '', sources: [], evidence: [], sourceKnown: false };

function fixture(reasons: string[]) {
  const generate = jest.fn();
  const evaluateCandidates = jest.fn(async () => ({ knowledge: empty, accepted: [],
    decisions: reasons.map((reason, submittedIndex) => ({ submittedIndex, url: `https://guides.example.org/source-${submittedIndex}`,
      decision: 'rejected' as const, reasonCodes: [reason] })) }));
  const workflow = createGamingHybridWorkflow({ retrieve: async () => empty, evaluateCandidates, generate });
  return { workflow, generate, evaluateCandidates };
}

describe('sanitized mixed candidate failure diagnostics', () => {
  it('preserves the exact October 4 legacy pattern after its single discovery round', async () => {
    const reasons = ['SOURCE_FETCH_FAILED', 'EDITION_REQUIRED', 'GAME_IDENTITY_UNVERIFIED'];
    const test = fixture(reasons);
    const first = await test.workflow.query({ ...query, contractVersion: 'gaming-hybrid-v1' }, context);
    const submitted = { contractVersion: 'gaming-hybrid-v1', workflowId: first.body.workflowId,
      idempotencyKey: 'october4-original-submission', candidates: reasons.map((_reason, index) => ({ url: `https://guides.example.org/source-${index}` })) };
    const result = await test.workflow.candidates(submitted, context);
    expect(result.body).toMatchObject({ frontendOutcome: 'need_new_source', nextAction: 'stop',
      reason: 'CANDIDATE_SOURCES_REJECTED', discovery: { round: 1, maxRounds: 1, continuationRequired: false } });
    expect(result.body.candidates?.map(item => item.reasonCodes[0])).toEqual(reasons);
    expect(result.body.qualification).toContain('1 source acquisition failed; 1 source edition scope unresolved; 1 source game identity unverified');
    expect(result.body.qualification).toContain('do not establish that public evidence does not exist');
    expect(result.body.reason).not.toBe('COVERAGE_INSUFFICIENT');
    expect(await test.workflow.candidates(submitted, context)).toEqual(result);
    expect(test.evaluateCandidates).toHaveBeenCalledTimes(1);
    expect(test.generate).not.toHaveBeenCalled();
  });

  it('retains all sanitized gameplay outcomes across the two bounded v2 rounds', async () => {
    const reasons = ['SOURCE_TOO_LARGE', 'EDITION_CONFLICT', 'QUESTION_COVERAGE_INSUFFICIENT'];
    const test = fixture(reasons);
    const first = await test.workflow.query({ ...query, contractVersion: 'gaming-hybrid-v2' }, context);
    const submitted = { contractVersion: 'gaming-hybrid-v2', workflowId: first.body.workflowId, expectedRevision: first.body.revision,
      idempotencyKey: 'october4-new-submission', candidates: reasons.map((_reason, index) => ({ url: `https://guides.example.org/source-${index}` })) };
    const initial = await test.workflow.candidates(submitted, context);
    expect(initial.body).toMatchObject({ frontendOutcome: 'need_new_source', nextAction: 'search',
      reason: 'CANDIDATE_SOURCES_REJECTED', discovery: { replacementAllowed: true, recoveryRemaining: 1 } });
    expect(initial.body.qualification).toContain('1 source too large; 1 source edition conflicts with the request; 1 source insufficiently relevant');
    const recovery = await test.workflow.candidates({ ...submitted, expectedRevision: initial.body.revision,
      idempotencyKey: 'october4-recovery-submission', candidates: reasons.map((_reason, index) => ({ url: `https://guides.example.org/replacement-${index}` })) }, context);
    expect(recovery.body).toMatchObject({ frontendOutcome: 'need_new_source', nextAction: 'stop',
      reason: 'CANDIDATE_SOURCES_REJECTED', discovery: { round: 2, maxRounds: 2, continuationRequired: false } });
    expect(recovery.body.candidates).toHaveLength(6);
    expect(recovery.body.qualification).toContain('2 source too large; 2 source edition conflicts with the request; 2 source insufficiently relevant');
    expect(isGamingMcpOutput('arcanos_gaming_submit_candidates', { statusCode: recovery.status, result: recovery.body })).toBe(true);
    expect(test.generate).not.toHaveBeenCalled();
  });

  it('keeps a single decoded-size failure actionable at workflow level', async () => {
    const test = fixture(['SOURCE_TOO_LARGE']);
    const first = await test.workflow.query({ ...query, contractVersion: 'gaming-hybrid-v1' }, context);
    const result = await test.workflow.candidates({ contractVersion: 'gaming-hybrid-v1', workflowId: first.body.workflowId,
      idempotencyKey: 'october4-size-submission', candidates: [{ url: 'https://guides.example.org/source-0' }] }, context);
    expect(result.body).toMatchObject({ frontendOutcome: 'need_new_source', reason: 'SOURCE_TOO_LARGE', nextAction: 'stop' });
  });
});
