import { describe, expect, it, jest } from '@jest/globals';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';

const http = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(http) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
const { evaluateGamingHybridCandidates } = await import('../src/services/gamingHybridCandidates.js');
const { extractGamingFreshnessMetadata } = await import('../src/shared/gaming/gamingFreshnessCore.js');
const { readGamingRegistryEditionScope } = await import('../src/shared/gaming/gamingGameRegistry.js');
const url = 'https://guides.example.org/late-applicability-review';
const game = 'Minecraft';
const prose = 'In Minecraft Java, obtain logs by breaking a tree. Craft wooden planks by placing a log into the crafting grid. '
  + 'Place four wooden planks in the two-by-two crafting grid to craft a crafting table. A crafting table opens a three-by-three crafting grid.';
const filler = '<p>Observe crafting practice, plan recovery, and choose a careful crafting action.</p>';

/** Production acquisition/extraction/selection; only public synthetic transport is mocked. */
async function evaluate(assertion: string, options: { repeats?: number; requestedGame?: string; early?: string; region?: string } = {}) {
  const requestedGame = options.requestedGame ?? game;
  const requestedEdition = requestedGame === game ? 'Java' : 'Base game';
  const title = `${requestedGame}${requestedGame === game ? ' Java' : ''} crafting guide`;
  const body = `<html><title>${title}</title><body><article><h1>${title}</h1>`
    + `<p>Edition: ${requestedEdition}.</p><p>Platforms: PC.</p><p>Regions: North America.</p>`
    + `<p>Patch: 1.2.</p><p>Build: 1.0.</p><p>Effective from: 2020-01-01.</p><p>Effective until: 2030-01-01.</p>`
    + `<p>${prose.replaceAll('Minecraft Java', requestedGame === game ? 'Minecraft Java' : requestedGame)}</p>`
    + (options.early ?? '') + filler.repeat(options.repeats ?? 700) + `<p>${assertion}</p></article></body></html>`;
  http.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' }, data: body });
  return evaluateGamingHybridCandidates({ game: requestedGame, edition: requestedEdition, platform: 'PC', region: options.region,
    mode: 'guide', prompt: 'How do I craft a crafting table?', protocolVersion: 'gaming-hybrid-v2', candidates: [{ url }] },
  { actorKey: 'late-applicability-review', workflowId: '30000000-0000-4000-8000-000000000001' });
}

describe('generic late acquired applicability scope', () => {
  it.each([
    ['early incompatible edition', 'This guide covers Minecraft Bedrock.', { repeats: 0 }, false],
    ['late incompatible edition', 'This guide covers Minecraft Bedrock.', {}, false],
    ['late quoted edition name', 'This guide covers "Minecraft Bedrock".', {}, false],
    ['late quoted edition qualifier', 'This guide covers Minecraft "Bedrock".', {}, false],
    ['late single-quoted edition qualifier', "This guide covers Minecraft 'Bedrock'.", {}, false],
    ['late backtick-quoted edition qualifier', 'This guide covers Minecraft `Bedrock`.', {}, false],
    ['late quoted edition qualifier in Game label', 'Game: Minecraft "Bedrock".', {}, false],
    ['late matching quoted edition qualifier', 'This guide covers Minecraft "Java".', {}, true],
    ['late matching single-quoted edition qualifier', "This guide covers Minecraft 'Java'.", {}, true],
    ['late matching backtick-quoted edition qualifier', 'This guide covers Minecraft `Java`.', {}, true],
    ['late unclosed quoted edition name', 'This guide covers "Minecraft Bedrock.', {}, false],
    ['late unclosed quoted edition qualifier', 'This guide covers Minecraft "Bedrock.', {}, false],
    ['late unclosed single-quoted edition qualifier', "This guide covers Minecraft 'Bedrock.", {}, false],
    ['late unclosed curly-quoted edition qualifier', 'This guide covers Minecraft “Bedrock.', {}, false],
    ['late same-game edition Game label', 'Game: Minecraft Bedrock.', {}, false],
    ['late exclusive edition', 'This guide only works in Bedrock.', {}, false],
    ['late incompatible platform for known game', 'Platforms: PS5.', {}, false],
    ['late incompatible platform for unknown game', 'Platforms: PS5.', { requestedGame: 'Lantern Vale' }, false],
    ['late incompatible region', 'Regions: Europe.', { region: 'North America' }, false],
    ['late contradictory patch', 'Patch: 1.3.', {}, false],
    ['late contradictory build', 'Build: 2.0.', {}, false],
    ['late contradictory effective start', 'Effective from: 2035-01-01.', {}, false],
    ['late contradictory effective end', 'Effective until: 2020-01-01.', {}, false],
    ['late malformed restriction', 'Platforms:', {}, false],
    ['early complete quoted platform passage', 'The source quotes: "\nPlatforms: PS5.\n"', { repeats: 0 }, true],
    ['early complete quoted edition passage', 'The source quotes: "\nEdition: Bedrock.\n"', { repeats: 0 }, true],
    ['early quoted platform value remains binding', 'Platforms: "PS5".', { repeats: 0 }, false],
    ['late quoted platform value remains binding', 'Platforms: "PS5".', {}, false],
    ['early quoted edition value remains binding', 'Edition: "Bedrock".', { repeats: 0 }, false],
    ['late quoted edition value remains binding', 'Edition: "Bedrock".', {}, false],
    ['early exclusivity comparison', 'Unlike Bedrock-only recipes, this acquired example keeps the current scope.', { repeats: 0 }, true],
    ['early negated platform label', 'Not Platforms: PS5.', { repeats: 0 }, true],
    ['early platform label comparison', 'Unlike Platforms: PS5.', { repeats: 0 }, true],
    ['late quoted explanatory requirement', 'This guide requires "the note says Bedrock-only."', {}, true],
    ['late matching platform', 'Platforms: PC.', {}, true],
    ['late matching platform alias for known game', 'Platforms: Steam.', {}, true],
    ['late matching platform alias for unknown game', 'Platforms: Steam.', { requestedGame: 'Lantern Vale' }, true],
    ['late matching edition', 'This guide covers Minecraft Java.', {}, true],
    ['late complete quoted edition passage', '"This guide covers Minecraft Bedrock."', {}, true],
    ['late complete quoted platform passage', 'The source quotes: "\nPlatforms: PS5.\n"', {}, true],
    ['late complete quoted platform passage for unknown game', 'The source quotes: "\nPlatforms: PS5.\n"', { requestedGame: 'Lantern Vale' }, true],
    ['late edition comparison', 'Unlike in Minecraft Bedrock, crafting retains this acquired guide scope.', {}, true],
    ['late edition negation', 'This guide is not for Minecraft Bedrock.', {}, true],
    ['late complete quoted exclusivity', '"Bedrock-only recipes require a different guide."', {}, true],
    ['late exclusivity comparison', 'Unlike Bedrock-only recipes, this acquired example keeps the current scope.', {}, true],
    ['late negated requirement', 'This guide does not require Bedrock.', {}, true],
    ['complete large article', 'Continue practicing crafting carefully.', {}, true]
  ])('%s', async (label, assertion, options, valid) => {
    const result = await evaluate(assertion as string, options as Parameters<typeof evaluate>[1]);
    console.info('GENERIC_LATE_APPLICABILITY_OBSERVATION', JSON.stringify({ label, accepted: result.accepted.length,
      selected: result.knowledge.evidence?.length ?? 0, reasonCodes: result.decisions.flatMap(decision => decision.reasonCodes),
      identity: result.evaluations[0].stages.identity, applicability: result.evaluations[0].stages.applicability }));
    expect(result.accepted).toHaveLength(valid ? 1 : 0);
    if (!valid) expect(result.knowledge.evidence ?? []).toEqual([]);
  });

  it('keeps game conflict ahead of late edition and platform restrictions', async () => {
    const result = await evaluate('This guide covers Orbit Orchard. Platforms: PS5.',
      { early: '<p>This guide covers Minecraft Bedrock.</p>' });
    expect(result.accepted).toEqual([]);
    expect(result.decisions[0].reasonCodes).toEqual(['GAME_MISMATCH']);
    expect(result.evaluations[0].stages.identity.status).toBe('rejected');
    expect(result.evaluations[0].stages.applicability.status).toBe('not_run');
  });

  it('does not acquire positive platform or edition proof from a late field', () => {
    const text = `In Minecraft, crafting uses a grid. ${'Observe crafting practice. '.repeat(1_500)}Platforms: PC. Edition: Java.`;
    const document = { publicUrl: url, text, metadata: { title: 'Minecraft crafting guide' } };
    const freshness = extractGamingFreshnessMetadata(document, { game, edition: 'Java', platform: 'PC', mode: 'guide', prompt: 'How do I craft?' });
    expect(freshness.platforms).toBeUndefined();
    expect(freshness.edition).toBeUndefined();
    expect(freshness.metadataUnverified).toBe(true);
    expect(readGamingRegistryEditionScope(document, game).status).not.toBe('verified');
  });

  it('keeps contradictions beyond the positive metadata line limit', () => {
    const text = `Platforms: PC. Edition: Java. ${'Edition: Java. '.repeat(600)}Platforms: PS5.`;
    const freshness = extractGamingFreshnessMetadata({ publicUrl: url, text, metadata: { title: 'Minecraft Java crafting guide' } },
      { game, edition: 'Java', platform: 'PC', mode: 'guide', prompt: 'How do I craft?' });
    expect(freshness.metadataConflict).toBe(true);
  });

  it('keeps excessive applicability assertions unverified', () => {
    const text = `Platforms: PC. Edition: Java. ${'Edition: Java. '.repeat(12_000)}`;
    const startedAt = performance.now();
    const freshness = extractGamingFreshnessMetadata({ publicUrl: url, text, metadata: { title: 'Minecraft Java crafting guide' } },
      { game, edition: 'Java', platform: 'PC', mode: 'guide', prompt: 'How do I craft?' });
    const elapsedMs = performance.now() - startedAt;
    console.info('GENERIC_APPLICABILITY_BUDGET_OBSERVATION', JSON.stringify({ chars: text.length, elapsedMs,
      metadataConflict: freshness.metadataConflict ?? false, metadataUnverified: freshness.metadataUnverified ?? false }));
    expect(freshness.metadataUnverified).toBe(true);
    expect(elapsedMs).toBeLessThan(1_000);
  });
});
