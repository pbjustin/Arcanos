import { describe, expect, it, jest } from '@jest/globals';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';
import { gamingGenericScopeHtml } from './fixtures/gaming-generic-scope.js';

const fetch = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(fetch) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
const { evaluateGamingHybridCandidates } = await import('../src/services/gamingHybridCandidates.js');
const { assessGamingClearSourceIdentity } = await import('../src/shared/gaming/gamingClearSource.js');
const { assessGamingSourcePolicy } = await import('../src/shared/gaming/gamingFreshnessCore.js');
const url = 'https://community-notebook.example/beginner';
const actor = { actorKey: 'generic-scope-fixture', workflowId: 'generic-scope-workflow', requestId: 'generic-scope-request' };
function request(game = 'Elden Ring') {
  return { game, mode: 'guide' as const, prompt: 'Explain starting equipment and the beginner route.',
    protocolVersion: 'gaming-hybrid-v2', candidates: [{ url }] };
}
async function acquire(extra: string, game = 'Elden Ring', title?: string) {
  fetch.mockImplementation(async () => ({ status: 200, headers: { 'content-type': 'text/html' },
    data: gamingGenericScopeHtml(game, extra, title) }));
  return evaluateGamingHybridCandidates(request(game), actor);
}

describe('generic acquired scope grammar through transport, extraction, identity and CLEAR', () => {
  it.each([
    'In the game you can explore freely.',
    'In the game you explore freely.',
    'In the game players explore freely.',
    'In the game your character starts with a sword.',
    "In the game you'll find supplies.",
    'In the game You can explore freely.',
    'In the game the world is open.',
    'In the game new players start with basic equipment.',
    'In the game combat rewards patience.',
    'In the game Lysa can inspect equipment.',
    'In the game Geralt can explore freely.',
    'In the game you begin with basic equipment.',
    'In the game, explore the opening area first.',
    'In the game we must check supplies before leaving.',
    'In the game players should keep enough stamina for a dodge.',
    'In the game your character can carry a spare weapon.',
    'In the game there are several routes through the opening area.',
    'In Elden Ring you can inspect equipment before leaving.',
    'In Elden Ring your character can return to the safe area.',
    'In the game Elden Ring you can inspect equipment before leaving.'
  ])('keeps grammatical gameplay prose eligible: %s', async extra => {
    const result = await acquire(extra);
    expect(result.evaluations[0].stages.identity).toMatchObject({ status: 'passed' });
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].document.text).toContain(extra);
    expect(result.accepted[0].sourceAssessment.gates.identity).toBe('verified');
    expect(result.accepted[0].sourceAssessment.gates.security).toBe('verified');
    expect(result.decisions[0].decision).not.toBe('rejected');
  });

  it.each(['Copperwind Loom', 'Silver Harbor'])('preserves unregistered %s scope with grammatical continuations', async game => {
    const result = await acquire(`In the game ${game} you can inspect equipment before leaving.`, game);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].sourceAssessment.gates.identity).toBe('verified');
  });

  it.each([
    'Unlike in Diablo IV, this route starts with the available equipment.',
    'Unlike combat in Diablo IV, this route starts with the available equipment.',
    'Compared to equipment progression in Diablo IV, the opening route has fewer upgrades.',
    'The source quotes: "In the game Diablo IV, use another route."',
    'Recommended reading: In the game Diablo IV, inspect another equipment guide.',
    'In Copper Harbor, inspect supplies before returning to the route.'
  ])('preserves bounded comparison, quotation, recommendation and location scopes: %s', async extra => {
    expect((await acquire(extra)).accepted).toHaveLength(1);
  });

  it.each([
    'This guide covers Diablo IV.',
    'This article is about Copperwind Afterlight.',
    'In the game Copperwind Afterlight, inspect starting equipment.',
    'In the game Diablo IV you can inspect starting equipment.',
    'In Diablo IV, inspect starting equipment.',
    'In the game Elden Ring Nightreign you can inspect starting equipment.',
    'In the game "you can explore freely", inspect starting equipment.',
    'Unlike in Elden Ring, in the game Diablo IV you can inspect equipment.',
    'Unlike combat in Elden Ring, in Diablo IV you can inspect equipment.'
  ])('retains affirmative different game ownership: %s', async extra => {
    const result = await acquire(extra);
    expect(result.accepted).toEqual([]);
    expect(result.decisions[0]).toMatchObject({ decision: 'rejected', reasonCodes: ['GAME_MISMATCH'] });
  });

  it('does not turn grammatical gameplay prose into independent identity proof', () => {
    const input = request('Silver Harbor');
    expect(assessGamingClearSourceIdentity({ publicUrl: url, metadata: { title: 'Silver Harbor beginner guide' },
      text: 'In the game you can explore freely. Inspect equipment and preserve stamina before entering the next area.' },
    input, assessGamingSourcePolicy(url, input.game))).toMatchObject({ status: 'unknown', reasonCodes: ['GAME_IDENTITY_UNVERIFIED'] });
  });
});
