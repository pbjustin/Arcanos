import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createGamingHybridWorkflow } from '../src/services/gamingHybridKnowledge.js';
import { logger } from '../src/platform/logging/structuredLogging.js';

const actor = { actorKey: 'clarification-review-fixture' };
const empty = { context: '', sources: [], evidence: [], sourceKnown: false };

beforeEach(() => { jest.spyOn(logger, 'info').mockImplementation(() => undefined); });
afterEach(() => { jest.restoreAllMocks(); });

describe('Gaming material context before pending player decisions', () => {
  it.each([
    ['PLATFORM_REQUIRED', 'Recommend early-game Samurai katana controls.', { platform: 'PC' }],
    ['REGION_REQUIRED', 'Recommend early-game Samurai katana regional guidance.', { region: 'Europe' }],
    ['EDITION_REQUIRED', 'Recommend a Samurai DLC build.', { edition: 'Shadow of the Erdtree' }],
    ['BUILD_GOAL_REQUIRED', 'Recommend a build.', { class: 'Samurai' }]
  ] as const)('allows the requested %s context while a later preference remains unresolved', async (reason, question, context) => {
    const retrieve = jest.fn(async () => empty);
    const workflow = createGamingHybridWorkflow({ retrieve });
    const request = { contractVersion: 'gaming-hybrid-v2', idempotencyKey: 'review-context-query',
      game: 'Elden Ring', mode: 'build', question: `${question} I'm undecided between bleed and pure Dexterity.` };
    const initial = await workflow.query(request, actor);
    expect(initial.body).toMatchObject({ reason, nextAction: 'clarify', revision: 0 });
    const result = await workflow.query({ ...request, ...context, workflowId: initial.body.workflowId,
      expectedRevision: initial.body.revision, idempotencyKey: 'review-context-continuation' }, actor);
    expect(result).toMatchObject({ status: 200, body: { workflowId: initial.body.workflowId, nextAction: 'search', revision: 1,
      discovery: { round: 0, remainingCandidateUrls: 6, remainingTotalAcquisitionMs: 24_000 } } });
    expect(retrieve).toHaveBeenCalledTimes(1);
  });
});
