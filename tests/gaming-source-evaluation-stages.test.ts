import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';

const http = jest.fn();
// Only HTTP and DNS are synthetic. Acquisition attestations, extraction, identity,
// applicability, CLEAR and selection use the production path.
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(http) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
const { evaluateGamingHybridCandidates, assertGamingHybridEvidenceMembership } = await import('../src/services/gamingHybridCandidates.js');
const actor = { actorKey: 'stage-regression-actor', requestId: 'req_1234_stageregression', traceId: 'a'.repeat(32),
  workflowId: '30000000-0000-4000-8000-000000000001' };
const url = 'https://guides.example.org/equipment';
const prose = 'In Portal 2, this synthetic equipment route uses the practice item carefully. '
  + 'Inspect the practice equipment before starting, preserve room for movement, and follow the practice route through the exercise.';

function article(metadata: string, title = 'Portal 2 equipment guide', body = prose): string {
  return `<html><title>${title}</title><body><article><h1>${title}</h1>${metadata}<p>${body}</p></article></body></html>`;
}
async function evaluate(body: string, game = 'Portal 2', sourceUrl = url, contentType = 'text/html') {
  http.mockResolvedValue({ status: 200, headers: { 'content-type': contentType }, data: body });
  return evaluateGamingHybridCandidates({ game, edition: 'base-game', platform: 'PC', mode: 'guide',
    prompt: 'Explain the practice equipment route.', protocolVersion: 'gaming-hybrid-v2', candidates: [{ url: sourceUrl }] }, actor);
}
beforeEach(() => { http.mockReset(); });

describe('independent source identity before applicability rejection', () => {
  it('reports contradictory acquired Game declarations at the identity stage', async () => {
    // Plain text establishes the prose-only path, without structural field records.
    const result = await evaluate(`Game: Portal 2. Game: Hades. Edition: Base game. ${prose}`,
      'Portal 2', url, 'text/plain');
    expect(result.accepted).toHaveLength(0);
    expect(result.decisions[0].reasonCodes).toEqual(['GAME_MISMATCH']);
    expect(result.evaluations[0].stages.identity).toMatchObject({ status: 'rejected', reasonCode: 'GAME_MISMATCH',
      diagnostic: { identityRuleId: 'gaming.identity.acquired_game_label_conflict', identityCategory: 'prose_metadata' } });
    expect(result.evaluations[0].stages.applicability.status).toBe('not_run');
  });

  it('does not hide a wrong primary subject behind an edition or platform conflict', async () => {
    const result = await evaluate(article('<div>Game: Portal 2.</div><div>Edition: Expansion.</div><div>Platforms: Xbox.</div>',
      'Hades equipment guide'));
    expect(result.accepted).toHaveLength(0);
    expect(result.decisions[0].reasonCodes).toEqual(['GAME_MISMATCH']);
    expect(result.evaluations[0].stages.identity).toMatchObject({ status: 'rejected', reasonCode: 'GAME_MISMATCH',
      diagnostic: { identityCategory: 'document_title' } });
    expect(result.evaluations[0].stages.applicability.status).toBe('not_run');
  });

  it('keeps identity unverified when only a Game declaration supplies the title', async () => {
    const result = await evaluate(article('<div>Game: Portal 2.</div><div>Edition: Base game.</div><div>Platforms: Xbox.</div>',
      'Equipment reference', 'Use the practice item carefully. Inspect the practice equipment before starting, preserve room for movement, and follow the practice route through the synthetic exercise.'));
    expect(result.accepted).toHaveLength(0);
    expect(result.decisions[0].reasonCodes).toEqual(['GAME_IDENTITY_UNVERIFIED']);
    expect(result.evaluations[0].stages.identity.status).toBe('rejected');
    expect(result.evaluations[0].stages.applicability.status).toBe('not_run');
  });

  it('preserves verified game identity beside a genuine platform rejection', async () => {
    const result = await evaluate(article('<div>Game: Portal 2.</div><div>Edition: Base game.</div><div>Platforms: Xbox.</div>'));
    expect(result.accepted).toHaveLength(0);
    expect(result.decisions[0].reasonCodes).toEqual(['PLATFORM_MISMATCH']);
    expect(result.evaluations[0].stages.identity).toMatchObject({ status: 'passed', reasonCode: 'ACQUIRED_IDENTITY_VERIFIED' });
    expect(result.evaluations[0].stages.applicability).toMatchObject({ status: 'rejected', reasonCode: 'PLATFORM_MISMATCH' });
  });

  it('retains scoped official metadata contradictions as negative currentness evidence', async () => {
    const game = 'Destiny 2';
    const body = article('<div>Game: Destiny 2.</div><div>Edition: Base game.</div><div>Platforms: PC.</div><div>Patch: 1.0.</div><div>Patch: 2.0.</div>',
      'Destiny 2 patch notes', prose.replace('Portal 2', game));
    const result = await evaluate(body, game, 'https://www.bungie.net/7/en/News/Article/stage-fixture');
    expect(result.accepted).toHaveLength(0);
    expect(result.decisions[0].reasonCodes).toEqual(['CONTRADICTORY_SOURCE_METADATA']);
    expect(result.evaluations[0].stages.identity.status).toBe('passed');
    expect(result.currentnessEvidence).toHaveLength(1);
    expect(result.currentnessEvidence?.[0]).toMatchObject({ game, authority: 'official', metadataConflict: true });
  });

  it('retains negative official conflicts even when acquired Game declarations conflict', async () => {
    const game = 'Destiny 2';
    const body = `Game: Destiny 2. Game: Hades. Edition: Base game. Platforms: PC. ${prose.replace('Portal 2', game)}`;
    const result = await evaluate(body, game, 'https://www.bungie.net/7/en/News/Article/stage-game-fixture', 'text/plain');
    expect(result.accepted).toHaveLength(0);
    expect(result.decisions[0].reasonCodes).toEqual(['GAME_MISMATCH']);
    expect(result.currentnessEvidence).toHaveLength(1);
    expect(result.currentnessEvidence?.[0]).toMatchObject({ game, authority: 'official', metadataConflict: true });
  });

  it('keeps accepted evidence bound to the original acquired document', async () => {
    const result = await evaluate(article('<div>Game: Portal 2.</div><div>Edition: Base game.</div><div>Platforms: PC.</div>'));
    expect(result.accepted).toHaveLength(1);
    expect(result.evaluations[0].stages.identity).toMatchObject({ status: 'passed', reasonCode: 'ACQUIRED_IDENTITY_VERIFIED',
      diagnostic: { contentHash: result.accepted[0].contentHash } });
    assertGamingHybridEvidenceMembership(result.knowledge, result.accepted, actor);
  });
});
