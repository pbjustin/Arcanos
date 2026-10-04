import { describe, expect, it, jest } from '@jest/globals';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';
import type { ResolvedGamingDocument } from '../src/services/gamingDocumentResolution.js';

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
const url = 'https://guides.example.org/guide';
const elden = 'In Elden Ring, Samurai katana attacks use the starting Uchigatana. Raise Vigor and Dexterity for an early-game blade build, and preserve stamina for dodging after each katana attack.';
const citizen = 'In Star Citizen, use the ship targeting controls to acquire a target before firing. The ship targeting guide recommends checking your range and preserving shields during combat.';
function document(title: string, text: string): ResolvedGamingDocument {
  return { requestedUrl: url, canonicalUrl: url, publicUrl: url, host: 'guides.example.org', text,
    metadata: { title, headings: title }, extraction: { strategy: 'article', rawTextLength: text.length,
      cleanedTextLength: text.length, navigationDensity: 0 },
    resolution: { resolverId: 'generic-web', resolverVersion: 'gaming-document-v1', strategy: 'article',
      documentType: 'html', supportsStructuredExtraction: false },
    metrics: { rawTextLength: text.length, cleanedTextLength: text.length, instructionFiltered: false, truncated: false } };
}
const locations = [
  ['Elden Ring', 'Elden Ring Samurai build guide', elden, 'In Stormveil Castle, upgrade the Uchigatana before fighting stronger enemies.'],
  ['Elden Ring', 'Elden Ring Samurai build guide', elden, 'In Deathtouched Catacombs, look for another Uchigatana before choosing your katana setup.'],
  ['Elden Ring', 'Elden Ring Samurai build guide', elden, 'In Stormveil Castle guide your Samurai carefully and preserve stamina for the route.'],
  ['Elden Ring', 'Elden Ring Samurai build guide', elden, 'In Deathtouched Catacombs build a safe katana route before fighting enemies.'],
  ['Star Citizen', 'Star Citizen ship targeting guide', citizen, 'In Pyro System, check the ship targeting range before combat.'],
  ['Star Citizen', 'Star Citizen ship targeting guide', citizen, 'In Nyx System, preserve your ship shields before combat.'],
  ['Star Citizen', 'Star Citizen ship targeting guide', citizen, 'In Pyro System guide your ship through the targeting route.'],
  ['Star Citizen', 'Star Citizen ship targeting guide', citizen, 'In Nyx System build a safe targeting route for your ship.']
] as const;
describe('acquired location instructions remain separate from game declarations', () => {
  it.each(locations)('keeps valid %s location instructions: %s %s %s', (game, title, anchor, location) => {
    const input = { game, mode: 'guide' as const, prompt: game === 'Elden Ring' ? 'How do Samurai katana attacks work?' : 'How does ship targeting work?' };
    expect(assessGamingClearSourceIdentity(document(title, `${anchor} ${location}`), input, assessGamingSourcePolicy(url, game)))
      .toMatchObject({ status: 'verified' });
  });
  it.each(['In Diablo 4 build a katana route.', 'In Diablo IV guide your Samurai carefully.',
    'In the game Star Citizen guide your ship through the targeting route.',
    'This guide covers Stardew Valley build a safe farming route.',
    'This guide is for Star Citizen guide your ship through the targeting route.',
    'In Stardew Valley guide gather crops and build a safe farming route.',
    'In Stardew Valley build gather crops and guide your farmer through the route.',
    'In Stardew Valley loadout gather crops and build a safe farming route.',
    'Game: Diablo 4. Build a katana route.'])('retains explicit different-game declarations: %s', scope => {
    const input = { game: 'Elden Ring', mode: 'guide' as const, prompt: 'How do Samurai katana attacks work?' };
    expect(assessGamingClearSourceIdentity(document('Elden Ring Samurai build guide', `${elden} ${scope}`), input,
      assessGamingSourcePolicy(url, input.game))).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });
  it.each(locations.filter(([game, , , location]) => game === 'Elden Ring' && /\b(?:guide|build)\s+(?:your|a)\b/u.test(location)))
  ('admits independently acquired %s guide with location instructions: %s %s %s', async (game, title, anchor, location) => {
    fetch.mockImplementation(async () => ({ status: 200, headers: { 'content-type': 'text/html' },
      data: `<html><title>${title}</title><body><article><h1>${title}</h1><p>${anchor} ${location}</p></article></body></html>` }));
    const result = await evaluateGamingHybridCandidates({ game, mode: 'guide', prompt: 'How do Samurai katana attacks work?',
      protocolVersion: 'gaming-hybrid-v2', candidates: [{ url }] }, { actorKey: 'location-scope-fixture', workflowId: 'location-scope-fixture' });
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].publicUrl).toBe(url);
    expect(result.decisions).toMatchObject([{ decision: 'eligible_for_ingestion',
      reasonCodes: expect.arrayContaining(['VALIDATED_RELEVANT_CONTENT']) }]);
  });
});
