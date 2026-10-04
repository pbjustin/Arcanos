import { describe, expect, it, jest } from '@jest/globals';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';
import { resolveGamingRequestEdition } from '../src/shared/gaming/gamingGameIdentity.js';

const fetch = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(fetch) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
const { evaluateGamingHybridCandidates, assertGamingHybridEvidenceMembership } = await import('../src/services/gamingHybridCandidates.js');
const { assessGamingClearEvidence } = await import('../src/shared/gaming/gamingClearEvidence.js');
const { evaluateGamingFreshness } = await import('../src/shared/gaming/gamingFreshnessCore.js');
const actor = { actorKey: 'base-default-test', workflowId: 'base-default-workflow', requestId: 'base-default-request' };
const input = { game: 'Elden Ring', mode: 'guide' as const, prompt: 'How do Samurai katana attacks work?',
  protocolVersion: 'gaming-hybrid-v2', candidates: [{ url: 'https://guides.example.org/samurai' }] };
const prose = 'In Elden Ring, Samurai katana attacks use the starting Uchigatana. Read enemy recovery windows before using Unsheathe, avoid spending all stamina on attacks, and preserve stamina for a dodge after each katana strike.';
async function acquire(scope = '', body = prose, title = 'Elden Ring Samurai katana guide', request = input) {
  fetch.mockImplementation(async () => ({ status: 200, headers: { 'content-type': 'text/html' },
    data: `<html><title>${title}</title><body><article><p>${scope}</p><p>${body}</p></article></body></html>` }));
  return evaluateGamingHybridCandidates(request, actor);
}

describe('ordinary base-game request interpretation', () => {
  it.each(['', 'Edition: Base game.', 'Edition: base-game.'])('accepts acquired base-game guidance without a caller edition: %s', async scope => {
    const result = await acquire(scope);
    expect(result.accepted).toHaveLength(1);
    expect(result.decisions[0].reasonCodes).not.toContain('EDITION_REQUIRED');
    expect(result.accepted[0].sourceContext.edition).toBe('base-game');
    if (!scope) expect(result.accepted[0].freshness.edition).toBeUndefined();
    expect(() => assertGamingHybridEvidenceMembership(result.knowledge, result.accepted, actor)).not.toThrow();
    const freshness = evaluateGamingFreshness({ question: input.prompt, game: input.game, mode: input.mode,
      evidence: result.accepted.map(item => item.freshness) });
    expect(freshness.usable).toBe(true);
    expect(assessGamingClearEvidence(input, result.knowledge, { identityVerified: true, freshness,
      freshnessEvidence: result.accepted.map(item => item.freshness), requireRequestCoverage: true }).decision).toBe('accept');
  });
  it('rejects explicit expansion-only evidence for the default base-game request', async () => {
    const result = await acquire('Edition: Shadow of the Erdtree.', `${prose} This guide requires the expansion.`);
    expect(result.accepted).toEqual([]);
    expect(result.decisions[0].decision).toBe('rejected');
  });
  it('rejects acquired DLC-only restrictions without an Edition metadata label', async () => {
    const result = await acquire('', `${prose} This DLC-only guide requires Shadow of the Erdtree.`);
    expect(result.accepted).toEqual([]);
    expect(result.decisions[0].decision).toBe('rejected');
  });
  it('requires expansion evidence when the question explicitly names Shadow of the Erdtree', async () => {
    const request = { ...input, prompt: 'How do Samurai katana attacks work in Shadow of the Erdtree?' };
    expect(resolveGamingRequestEdition(request)).toBe('shadow of the erdtree');
    expect((await acquire('Edition: Base game.', prose, undefined, request)).accepted).toEqual([]);
    const dlc = await acquire('Edition: Shadow of the Erdtree.', `${prose} In Shadow of the Erdtree, Samurai katana attacks require expansion access.`,
      'Elden Ring Shadow of the Erdtree Samurai katana guide', request);
    expect(dlc.accepted).toHaveLength(1);
  });
  it('preserves explicit editions and leaves materially unspecified expansion requests unresolved', () => {
    expect(resolveGamingRequestEdition({ ...input, edition: 'Base game' })).toBe('base-game');
    expect(resolveGamingRequestEdition({ ...input, edition: 'Remastered' })).toBe('remastered');
    expect(resolveGamingRequestEdition({ ...input, prompt: 'Recommend a DLC build' })).toBeUndefined();
    expect(resolveGamingRequestEdition({ game: 'Minecraft', prompt: 'Recommend a build' })).toBeUndefined();
  });
});
