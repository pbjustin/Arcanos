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
const { evaluateGamingHybridCandidates, assertGamingHybridEvidenceMembership, selectGamingHybridAcceptedEvidence,
  selectGamingHybridEvidence } = await import('../src/services/gamingHybridCandidates.js');
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
  it('admits ordinary gameplay advice while retaining acquired platform and region restrictions', async () => {
    const result = await acquire('Platforms: PC. Regions: North America.');
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].freshness).toMatchObject({ platforms: ['PC'], regions: ['North America'] });
    const candidate = result.accepted[0];
    expect(candidate.evidenceRecords?.[0]).toMatchObject({ contentHash: candidate.contentHash,
      clearSourceAssessment: { subjectHash: candidate.contentHash }, provenance: {
        approvedContentHash: candidate.contentHash, hybridFreshness: { id: candidate.candidateId,
          platforms: ['PC'], regions: ['North America'] } } });
    expect(result.knowledge.sources[0].freshnessMetadata).toMatchObject({ id: candidate.candidateId,
      platforms: ['PC'], regions: ['North America'] });
    expect(evaluateGamingFreshness({ question: input.prompt, game: input.game, mode: input.mode,
      evidence: result.accepted.map(item => item.freshness) }).usable).toBe(true);
    expect(assessGamingClearEvidence(input, result.knowledge, { identityVerified: true, requireRequestCoverage: true }).decision).toBe('accept');
    const selected = selectGamingHybridAcceptedEvidence(input, result.accepted, actor);
    const compact = selectGamingHybridEvidence(input, selected).knowledge;
    expect(compact.sources[0].freshnessMetadata).toMatchObject({ id: candidate.candidateId,
      platforms: ['PC'], regions: ['North America'] });
    expect(assessGamingClearEvidence(input, compact, { identityVerified: true, requireRequestCoverage: true }).decision).toBe('accept');
    const changed = { ...candidate, freshness: { ...candidate.freshness, platforms: ['PS5'] } };
    expect(() => selectGamingHybridAcceptedEvidence(input, [changed], actor)).toThrow('Accepted evidence does not belong');
    expect((await acquire('Platforms: PC.', prose, undefined, { ...input, platform: 'PS5' } as typeof input)).accepted).toEqual([]);
  });
  it('qualifies an invalid publication date without treating it as an unknown edition or applicability interval', async () => {
    const result = await acquire('Published at: malformed.');
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].freshness).toMatchObject({ metadataWarnings: ['PUBLICATION_DATE_UNVERIFIED'] });
    expect(result.accepted[0].freshness.publishedAt).toBeUndefined();
    expect(result.accepted[0].sourceAssessment.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PUBLICATION_DATE_UNVERIFIED', severity: 'warning' })]));
  });
  it('admits acquired base-game evidence for an explicitly DLC-free request', async () => {
    const request = { ...input, prompt: 'Recommend a base game Samurai build without DLC.' };
    const result = await acquire('Edition: Base game.', `${prose} This base-game Samurai build uses the starting weapons.`, undefined, request);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].sourceContext.edition).toBe('base-game');
    expect(result.decisions[0].reasonCodes).not.toContain('EDITION_UNVERIFIED');
  });
  it('rejects DLC-required source evidence for an explicit base request on a registered game without a default', async () => {
    const request = { ...input, game: 'Xenoblade Chronicles 2', prompt: 'Explain the base game combat route.' };
    const source = 'In the game Xenoblade Chronicles 2, Rex uses Driver Arts and auto-attacks to recharge Arts. This route is DLC-only and requires DLC.';
    expect(resolveGamingRequestEdition(request)).toBe('base-game');
    const result = await acquire('', source, 'Xenoblade Chronicles 2 Driver Arts guide', request);
    expect(result.accepted).toEqual([]);
    expect(result.decisions[0].decision).toBe('rejected');
    expect(result.decisions[0].reasonCodes).toContain('EDITION_CONFLICT');
  });
  it('admits acquired base-game facts for a generic DLC-necessity question', async () => {
    const request = { ...input, prompt: 'Is DLC required to obtain the Uchigatana?' };
    const source = 'In Elden Ring, the Uchigatana is the starting katana for Samurai. Obtain the Uchigatana as starting equipment by selecting Samurai. This starting weapon is available in the base game. Preserve stamina for a dodge after each katana strike.';
    const result = await acquire('Edition: Base game.', source, 'Elden Ring Uchigatana location guide', request);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].sourceContext.edition).toBe('base-game');
    expect(result.decisions[0].reasonCodes).not.toContain('EDITION_UNVERIFIED');
    expect(result.accepted[0].publicUrl).toBe(request.candidates[0].url);
    expect(() => assertGamingHybridEvidenceMembership(result.knowledge, result.accepted, actor)).not.toThrow();
  });
  it('excludes explicitly expansion-only facts for a generic DLC-necessity question', async () => {
    const request = { ...input, prompt: 'Is DLC required to obtain the Uchigatana?' };
    const result = await acquire('Edition: Shadow of the Erdtree.', `${prose} This DLC-only guide requires the expansion.`, undefined, request);
    expect(result.accepted).toEqual([]);
    expect(result.decisions[0].reasonCodes).toContain('EDITION_CONFLICT');
  });
  it('requires expansion evidence when the question explicitly names Shadow of the Erdtree', async () => {
    const request = { ...input, prompt: 'How do Samurai katana attacks work in Shadow of the Erdtree?' };
    expect(resolveGamingRequestEdition(request)).toBe('shadow of the erdtree');
    expect((await acquire('Edition: Base game.', prose, undefined, request)).accepted).toEqual([]);
    const dlc = await acquire('Edition: Shadow of the Erdtree.', `${prose} In Shadow of the Erdtree, Samurai katana attacks require expansion access.`,
      'Elden Ring Shadow of the Erdtree Samurai katana guide', request);
    expect(dlc.accepted).toHaveLength(1);
  });
  it('admits acquired expansion evidence for a named request outside the base game', async () => {
    const request = { ...input, prompt: 'How do Samurai katana attacks work in Shadow of the Erdtree outside the base game?' };
    const source = `${prose} In Shadow of the Erdtree, Samurai katana attacks require expansion access.`;
    const title = 'Elden Ring Shadow of the Erdtree Samurai katana guide';
    expect(resolveGamingRequestEdition(request)).toBe('shadow of the erdtree');
    const expansion = await acquire('Edition: Shadow of the Erdtree.', source, title, request);
    expect(expansion.accepted.map(candidate => candidate.freshness.edition)).toEqual(['Shadow of the Erdtree']);
    expect((await acquire('Edition: Base game.', prose, undefined, request)).accepted).toEqual([]);
    expect((await acquire('Edition: Shadow of the Erdtree.', source, title,
      { ...input, prompt: 'How do Samurai katana attacks work in the base game only?' })).accepted).toEqual([]);
  });
  it.each(['Elden Ring', 'Unregistered Test Game'])('keeps unnamed extra content outside the base game unresolved for %s', game => {
    expect(resolveGamingRequestEdition({ game, prompt: 'What katana attacks are available outside the base game?' })).toBeUndefined();
    expect(resolveGamingRequestEdition({ game, prompt: 'What katana attacks are in the base game only?' })).toBe('base-game');
  });
  it.each(["'outside the base game'", '‘outside the base game’'])('does not turn an attributed phrase %s into extra-content intent', phrase => {
    expect(resolveGamingRequestEdition({ ...input, prompt: `How do Samurai katana attacks work? My friend calls this ${phrase}.` }))
      .toBe('base-game');
  });
  it('does not substitute a base-game guide for a request outside the base game', async () => {
    const request = { ...input, prompt: 'What Samurai katana attacks are available outside the base game?' };
    expect((await acquire('Edition: Base game.', prose, undefined, request)).accepted).toEqual([]);
    expect((await acquire('', prose, undefined, request)).accepted).toEqual([]);
  });
  it('does not let an acquired guide choose the expansion for an unnamed extra-content request', async () => {
    const request = { ...input, prompt: 'What Samurai katana attacks are available outside the base game?' };
    const result = await acquire('Edition: Shadow of the Erdtree.',
      `${prose} In Shadow of the Erdtree, Samurai katana attacks require expansion access.`,
      'Elden Ring Shadow of the Erdtree Samurai katana guide', request);
    expect(result.accepted).toHaveLength(0);
    expect((await acquire('Edition: Shadow of the Erdtree. Edition: Base game.', prose, undefined, request)).accepted).toHaveLength(0);
    expect((await acquire('Edition: Collector Expansion.', prose, undefined, request)).accepted).toHaveLength(0);
    expect((await acquire('Edition: Shadow of the Erdtree.', prose, undefined,
      { ...request, prompt: 'What Samurai katana attacks are available outside the base game, excluding Shadow of the Erdtree?' }))
      .accepted).toHaveLength(0);
    expect((await acquire('Edition: Shadow of the Erdtree.', prose, undefined,
      { ...request, prompt: 'What Samurai katana attacks are available outside the base game of Elden Ring Nightreign?' }))
      .accepted).toHaveLength(0);
  });
  it('does not let an attributed expansion title select the player edition during acquisition', async () => {
    const request = { ...input,
      prompt: 'The submitted guide is titled "Elden Ring Shadow of the Erdtree". How do Samurai katana attacks work?' };
    const base = await acquire('Edition: Base game.', prose, undefined, request);
    expect(base.accepted).toHaveLength(1);
    expect(base.accepted[0].sourceContext.edition).toBe('base-game');
    const expansion = await acquire('Edition: Shadow of the Erdtree.',
      `${prose} In Shadow of the Erdtree, Samurai katana attacks require expansion access.`,
      'Elden Ring Shadow of the Erdtree Samurai katana guide', request);
    expect(expansion.accepted).toEqual([]);
    expect(expansion.decisions[0].reasonCodes).toContain('EDITION_CONFLICT');
  });
  it('does not admit expansion evidence by treating a negative named request as expansion scope', async () => {
    const request = { ...input, prompt: 'Do not use Shadow of the Erdtree gear. How do Samurai katana attacks work?' };
    expect(resolveGamingRequestEdition(request)).toBeUndefined();
    const expansion = await acquire('Edition: Shadow of the Erdtree.',
      `${prose} In Shadow of the Erdtree, Samurai katana attacks require expansion access.`,
      'Elden Ring Shadow of the Erdtree Samurai katana guide', request);
    expect(expansion.accepted).toEqual([]);
  });
  it('preserves explicit editions and leaves materially unspecified expansion requests unresolved', () => {
    expect(resolveGamingRequestEdition({ ...input, edition: 'Base game' })).toBe('base-game');
    expect(resolveGamingRequestEdition({ ...input, edition: 'Remastered' })).toBe('Remastered');
    expect(resolveGamingRequestEdition({ ...input, prompt: 'Recommend a DLC build' })).toBeUndefined();
    expect(resolveGamingRequestEdition({ game: 'Minecraft', prompt: 'Recommend a build' })).toBeUndefined();
  });
});


describe('candidate semantic outcome classification', () => {
  it('reports a correct-game irrelevant guide as missing question coverage', async () => {
    const result = await acquire('', 'In Elden Ring, exploration uses map markers and discovered sites of grace. Follow the route to the cave and return to a nearby checkpoint when exploration is complete. These map navigation instructions do not describe combat.', 'Elden Ring exploration guide');
    expect(result.decisions).toMatchObject([{ decision: 'rejected', reasonCodes: ['QUESTION_COVERAGE_INSUFFICIENT'] }]);
  });
  it('reports unproved game identity independently from topical relevance', async () => {
    const result = await acquire('', prose.replace('In Elden Ring, ', ''), 'Unidentified notebook guide');
    expect(result.decisions).toMatchObject([{ decision: 'rejected', reasonCodes: ['GAME_IDENTITY_UNVERIFIED'] }]);
  });
  it('reports explicit wrong-game evidence independently from topical relevance', async () => {
    const result = await acquire('', prose.replace('Elden Ring', 'Diablo 4'), 'Diablo 4 Samurai katana guide');
    expect(result.decisions).toMatchObject([{ decision: 'rejected', reasonCodes: ['GAME_MISMATCH'] }]);
  });
});
