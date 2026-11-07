import { describe, expect, it, jest } from '@jest/globals';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';

const fetch = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(fetch) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
const { evaluateGamingHybridCandidates } = await import('../src/services/gamingHybridCandidates.js');
const { selectGamingGameScopedDocument } = await import('../src/shared/gaming/gamingStructuralEvidence.js');
const { extractGamingFreshnessMetadata, evaluateGamingFreshness } = await import('../src/shared/gaming/gamingFreshnessCore.js');

const game = 'Elden Ring';
const publicUrl = 'https://guides.example.org/elden-ring/uchigatana';
const title = `${game} Samurai guide`;
const prose = 'In the game Elden Ring, the Samurai starts with the Uchigatana. Use Unsheathe after an enemy attack misses, preserve stamina for a dodge, and avoid attacking while the enemy prepares another strike.';
const actor = { actorKey: 'global-applicability-fixture', requestId: 'global-applicability-request' };
const request = { game, mode: 'guide' as const, prompt: 'How do Samurai katana attacks work?', platform: 'PC', edition: 'base-game',
  protocolVersion: 'gaming-hybrid-v2', candidates: [{ url: publicUrl }] };
const frames = ['For comparison,', 'For comparison:', 'By comparison,', 'By comparison:'];

function document(restriction: string) {
  return { publicUrl, metadata: { title, headings: title }, text: `${prose} ${restriction}` };
}
async function candidate(restriction: string, platform = 'PC', region?: string, prompt = request.prompt) {
  fetch.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' },
    data: `<html><title>${title}</title><body><article><h1>${title}</h1><p>${prose}</p><p>${restriction}</p></article></body></html>` });
  return evaluateGamingHybridCandidates({ ...request, platform, region, prompt }, actor);
}

describe('comparison projection retains source-global applicability', () => {
  it('rejects the independently acquired plain PS5 restriction for a PC request', async () => {
    const result = await candidate('This page is platform-specific; Platform: PS5.');
    expect(result.accepted).toEqual([]);
    expect(result.decisions[0].reasonCodes).toContain('PLATFORM_MISMATCH');
  });

  it.each(frames)('keeps an embedded platform declaration inspectable under %s', frame => {
    const restriction = `${frame} in Fallout 4, this page is platform-specific; Platform: PS5.`;
    const original = document(restriction);
    const scoped = selectGamingGameScopedDocument(original, game);
    expect(scoped.document.text).not.toContain('For comparison');
    expect(scoped.document.text).not.toContain('By comparison');
    expect(original.text).toContain('Platform: PS5');
    const freshness = extractGamingFreshnessMetadata(original, request);
    expect(freshness.platforms).toEqual(['PS5']);
    expect(evaluateGamingFreshness({ ...request, question: request.prompt, evidence: [freshness] }))
      .toMatchObject({ usable: false, reasons: expect.arrayContaining(['PLATFORM_MISMATCH']) });
  });

  it.each(frames)('rejects incompatible acquired evidence through real candidate admission under %s', async frame => {
    const result = await candidate(`${frame} in Fallout 4, this page is platform-specific; Platform: PS5.`);
    expect(result.accepted).toEqual([]);
    expect(result.decisions[0].decision).toBe('rejected');
  });

  it.each(['Platform: PC.', 'Platforms: PC, PS5.'])('retains compatible source-global scope: %s', async field => {
    const result = await candidate(`For comparison: in Fallout 4, this page is platform-specific; ${field}`);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].freshness.platforms).toContain('PC');
    expect(result.knowledge.evidence?.some(chunk => chunk.text.includes('Fallout 4'))).toBe(false);
  });

  it.each(['Edition: Shadow of the Erdtree.', 'Game: Dark Souls.'])('retains existing global contradiction checks: %s', async field => {
    const result = await candidate(`For comparison: in Elden Ring, this page has source-specific scope; ${field}`);
    expect(result.accepted).toEqual([]);
    expect(result.decisions[0].decision).toBe('rejected');
  });

  it('continues excluding legitimate comparison gameplay from selected claim support', async () => {
    const comparison = 'For comparison: in Fallout 4, collect the invented comparison reward in the game shop.';
    const result = await candidate(comparison);
    expect(result.accepted).toHaveLength(1);
    expect(result.knowledge.evidence?.some(chunk => chunk.text.includes('invented comparison reward'))).toBe(false);
    expect(result.knowledge.evidence?.some(chunk => chunk.text.includes('Samurai starts with the Uchigatana'))).toBe(true);
  });

  it('keeps a complete quoted platform example local to its comparison', async () => {
    const comparison = 'For comparison: in Fallout 4, the example says "Platform: PS5".';
    expect(selectGamingGameScopedDocument(document(comparison), game).document.text).not.toContain('Platform: PS5');
    expect((await candidate(comparison)).accepted).toHaveLength(1);
  });

  it('keeps a quoted value on an unquoted platform declaration globally binding', async () => {
    const restriction = 'For comparison: in Elden Ring, this page is platform-specific; Platform: "PS5".';
    const result = await candidate(restriction);
    expect(result.accepted).toEqual([]);
    expect(result.decisions[0].reasonCodes).toContain('PLATFORM_MISMATCH');
  });

  it.each(['', 'For comparison: in Elden Ring, '])('preserves the adjacent global region restriction under %s', async frame => {
    const restriction = `${frame}this page is region-specific; Region: EU.`;
    const freshness = extractGamingFreshnessMetadata(document(restriction), { ...request, region: 'US' });
    expect(freshness.regions).toEqual(['EU']);
    expect(evaluateGamingFreshness({ ...request, question: request.prompt, region: 'US', evidence: [freshness] }))
      .toMatchObject({ usable: false, reasons: expect.arrayContaining(['REGION_MISMATCH']) });
    expect((await candidate(restriction, 'PC', 'US')).accepted).toEqual([]);
  });

  it('preserves compatible region declarations', async () => {
    expect((await candidate('For comparison: in Elden Ring, this page is region-specific; Region: US.', 'PC', 'US')).accepted).toHaveLength(1);
  });

  it.each([{ field: 'Platform: PC', region: undefined }, { field: 'Region: EU', region: 'EU' }])(
    'does not let a compatible $field restore comparison-only claim support', async ({ field, region }) => {
      const comparison = `For comparison: in Elden Ring, buy the wooden shield at the training shop for 25 coins; ${field}.`;
      const result = await candidate(comparison, 'PC', region, 'How do I buy the wooden shield in Elden Ring?');
      expect(result.accepted).toEqual([]);
      expect(result.decisions[0].reasonCodes).toContain('QUESTION_COVERAGE_INSUFFICIENT');
      expect((result.knowledge.evidence ?? []).some(chunk => chunk.text.includes('wooden shield'))).toBe(false);
    });

  it.each([{ field: 'Platform: PC', region: undefined }, { field: 'Region: EU', region: 'EU' }])(
    'keeps a gameplay comma-tail inside $field out of selected claim evidence', async ({ field, region }) => {
      const comparison = `For comparison: in Elden Ring, buy the wooden shield at the training shop for 25 coins; ${field}, buy the wooden shield at the training shop for 25 coins.`;
      const result = await candidate(comparison, 'PC', region, 'How do I buy the wooden shield in Elden Ring?');
      expect(result.accepted).toEqual([]);
      expect(result.decisions[0].reasonCodes).toContain('QUESTION_COVERAGE_INSUFFICIENT');
    });
});
