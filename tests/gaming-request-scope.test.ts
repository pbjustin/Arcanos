import { describe, expect, it, jest } from '@jest/globals';
import { createGamingHybridWorkflow } from '../src/services/gamingHybridKnowledge.js';
import type { GamingHybridDependencies } from '../src/services/gamingHybridKnowledge.js';

const actor = { actorKey: 'request-scope-fixture' };
const query = { contractVersion: 'gaming-hybrid-v2', idempotencyKey: 'request-scope-query',
  game: 'Elden Ring', mode: 'guide', question: 'Can I use a controller on PC?' };
const empty = { context: '', sources: [], evidence: [], sourceKnown: false };

function setup() {
  const retrieve = jest.fn<GamingHybridDependencies['retrieve']>(async () => empty);
  const evaluateCandidates = jest.fn<GamingHybridDependencies['evaluateCandidates']>(async () => ({ knowledge: empty, accepted: [],
    decisions: [{ submittedIndex: 0, decision: 'rejected', reasonCodes: ['QUESTION_COVERAGE_INSUFFICIENT'] }] }));
  const ingest = jest.fn<any>();
  const workflow = createGamingHybridWorkflow({ retrieve, evaluateCandidates, ingest });
  return { workflow, retrieve, evaluateCandidates, ingest };
}

describe('v2 explicit question scope is request context, never source truth', () => {
  it.each([
    ['Can I use a controller on PC?', { platform: 'PC' }],
    ['Can I use a controller on PC? https://guides.example.org/without-DLC/PS5', { platform: 'PC' }],
    ['What are the controls on PlayStation 5?', { platform: 'PlayStation 5' }],
    ['What is the regional release time in Europe?', { region: 'Europe' }]
  ])('does not ask the user to repeat an unambiguous scope in %s', async (question, scope) => {
    const { workflow, retrieve } = setup();
    const result = await workflow.query({ ...query, question }, actor);
    expect(result.body).toMatchObject({ frontendOutcome: 'need_new_source', nextAction: 'search', revision: 0 });
    expect(result.body.clarification).toBeUndefined();
    expect(retrieve).toHaveBeenCalledWith(expect.objectContaining(scope));
    if ('platform' in scope) expect(retrieve).toHaveBeenCalledWith(expect.objectContaining({
      contextOrigins: expect.objectContaining({ platform: 'question' }) }));
  });

  it.each([
    ['Can I use a controller on PC or PlayStation 5?', 'PLATFORM_REQUIRED'],
    ['Can I use a controller on PC and my console?', 'PLATFORM_REQUIRED'],
    ['What are the controls on PC (or another device)?', 'PLATFORM_REQUIRED'],
    ['I play on PC and on PS4. What are the controls?', 'PLATFORM_REQUIRED'],
    ['Can I use a controller on an unknown platform?', 'PLATFORM_REQUIRED'],
    ['If I play on PC, what are the controls?', 'PLATFORM_REQUIRED'],
    ['I am not on PC. What are the controls?', 'PLATFORM_REQUIRED'],
    ["I don't play on PC. What are the controls?", 'PLATFORM_REQUIRED'],
    ['What controls apply without playing on PC?', 'PLATFORM_REQUIRED'],
    ['Show controls excluding playing on PC.', 'PLATFORM_REQUIRED'],
    ['What controls apply somewhere other than on PC?', 'PLATFORM_REQUIRED'],
    ['What is the regional release time in Europe or Asia?', 'REGION_REQUIRED'],
    ['I am in Europe but use a US server. What is the regional release time?', 'REGION_REQUIRED'],
    ['The guide says controls on PC. What controls should I use?', 'PLATFORM_REQUIRED'],
    ['The source states controls on PC. What controls should I use?', 'PLATFORM_REQUIRED'],
    ['According to the guide, controls on PC are listed. What controls should I use?', 'PLATFORM_REQUIRED'],
    ['What controls should I use? The title is "Controls on PC".', 'PLATFORM_REQUIRED'],
    ["What controls should I use? The title is 'Controls on PC'.", 'PLATFORM_REQUIRED'],
    ['What controls should I use? https://guides.example.org/on-PC', 'PLATFORM_REQUIRED']
  ])('keeps an ambiguous, hypothetical or negated scope unresolved in %s', async (question, reason) => {
    const result = await setup().workflow.query({ ...query, question }, actor);
    expect(result.body).toMatchObject({ frontendOutcome: 'clarification_required', reason });
  });

  it('keeps explicit structured scope authoritative over competing question mentions', async () => {
    const { workflow, retrieve } = setup();
    const result = await workflow.query({ ...query, platform: 'PC',
      question: 'Compare controls on PC or PlayStation 5.' }, actor);
    expect(result.body.nextAction).toBe('search');
    expect(retrieve).toHaveBeenCalledWith(expect.objectContaining({ platform: 'PC',
      contextOrigins: expect.objectContaining({ platform: 'explicit' }) }));
  });

  it('binds resolved scope to the query hash, candidate evaluation and existing revision fence', async () => {
    const { workflow, retrieve, evaluateCandidates, ingest } = setup();
    const request = { ...query, question: 'What are the regional controls on PC in Europe?' };
    const first = await workflow.query(request, actor);
    expect(first.body.nextAction).toBe('search');
    expect(await workflow.query(request, actor)).toEqual(first);
    expect(await workflow.query({ ...request, platform: 'PC', region: 'Europe' }, actor)).toEqual(first);
    expect((await workflow.query({ ...request, platform: 'PC', region: 'Europe',
      idempotencyKey: 'request-scope-same-budget' }, actor)).body.workflowId).toBe(first.body.workflowId);
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect((await workflow.query({ ...request, platform: 'PlayStation 5' }, actor)).body.reason).toBe('IDEMPOTENCY_CONFLICT');
    const submission = { contractVersion: query.contractVersion, workflowId: first.body.workflowId,
      expectedRevision: 0, idempotencyKey: 'request-scope-candidates', candidates: [{
        url: 'https://guides.example.org/controls', title: 'Controls on PlayStation 5 in Asia',
        claimedGame: 'Diablo IV', claimedCategory: 'PlayStation 5 in Asia' }] };
    const next = await workflow.candidates(submission, actor);
    expect(next.body.revision).toBe(1);
    expect(evaluateCandidates).toHaveBeenCalledWith(expect.objectContaining({ platform: 'PC', region: 'Europe',
      contextOrigins: expect.objectContaining({ platform: 'question' }) }), expect.anything());
    expect(await workflow.candidates(submission, actor)).toEqual(next);
    expect((await workflow.candidates({ ...submission, idempotencyKey: 'request-scope-stale',
      candidates: [{ url: 'https://guides.example.org/replacement' }] }, actor)).body.reason).toBe('STALE_WORKFLOW_REVISION');
    expect(evaluateCandidates).toHaveBeenCalledTimes(1);
    expect(ingest).not.toHaveBeenCalled();
  });

  it('does not add question scope extraction to explicit v1 workflows', async () => {
    const { workflow, retrieve } = setup();
    const result = await workflow.query({ ...query, contractVersion: 'gaming-hybrid-v1' }, actor);
    expect(result.body.nextAction).toBe('search');
    expect(retrieve.mock.calls[0]?.[0]).not.toHaveProperty('platform');
  });
});
