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
const actor = { actorKey: 'body-identity-fixture', workflowId: 'body-identity-workflow' };
const url = 'https://guides.example.org/samurai';
const title = 'Elden Ring Samurai build guide';
const input = { game: 'Elden Ring', mode: 'guide' as const, prompt: 'How do Samurai katana attacks work?',
  protocolVersion: 'gaming-hybrid-v2', candidates: [{ url, claimedGame: 'Elden Ring', title }] };
const correct = 'In Elden Ring, Samurai katana attacks use the starting Uchigatana. Raise Vigor and Dexterity for this early-game blade build, and preserve stamina for dodging after each katana attack.';
const wrong = 'In Diablo 4, use the Samurai katana blade and Uchigatana. Raise Vigor and Dexterity for this early-game blade build, and preserve stamina for dodging after each katana attack.';
function document(text: string): ResolvedGamingDocument {
  return { requestedUrl: url, canonicalUrl: url, publicUrl: url, host: 'guides.example.org', text,
    metadata: { title, headings: title }, extraction: { strategy: 'article', rawTextLength: text.length,
      cleanedTextLength: text.length, navigationDensity: 0 },
    resolution: { resolverId: 'generic-web', resolverVersion: 'gaming-document-v1', strategy: 'article',
      documentType: 'html', supportsStructuredExtraction: false },
    metrics: { rawTextLength: text.length, cleanedTextLength: text.length, instructionFiltered: false, truncated: false } };
}
async function acquire(body: string, acquiredTitle = title) {
  fetch.mockImplementation(async () => ({ status: 200, headers: { 'content-type': 'text/html' },
    data: `<html><title>${acquiredTitle}</title><body><article><h1>${acquiredTitle}</h1><p>${body}</p></article></body></html>` }));
  return evaluateGamingHybridCandidates(input, actor);
}

describe('acquired game scope cannot be hidden by matching headings or earlier subjects', () => {
  it.each([
    `${title}. ${wrong}`,
    `${title}\n${wrong}`,
    `${title} ${wrong}`,
    `Samurai build in Elden Ring ${wrong}`,
    `${correct} ${wrong}`,
    `This guide covers Elden Ring. ${wrong}`,
    'In Diablo IV, unlike Elden Ring, use the Samurai katana blade and Uchigatana. Raise Vigor and Dexterity and save stamina for dodging.',
    'In Diablo IV unlike Elden Ring use the Samurai katana blade and Uchigatana. Raise Vigor and Dexterity and save stamina for dodging.',
    `Do not forget that ${wrong}`,
    `In "Diablo 4", use the Samurai blade and Uchigatana. ${correct}`,
    `This guide covers 'Diablo IV'. ${correct}`
  ])('rejects an affirmative wrong-game body scope: %s', text => {
    expect(assessGamingClearSourceIdentity(document(text), input, assessGamingSourcePolicy(url, input.game)))
      .toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it.each([wrong, `${correct} ${wrong}`,
    'In Diablo IV, unlike Elden Ring, use the Samurai katana blade and Uchigatana. Raise Vigor and Dexterity and save stamina for dodging.',
    'In Diablo IV unlike Elden Ring use the Samurai katana blade and Uchigatana. Raise Vigor and Dexterity and save stamina for dodging.'])
  ('rejects independently acquired wrong-game content despite acquired h1 and frontend claims: %s', async body => {
    const result = await acquire(body);
    expect(result.accepted).toEqual([]);
    expect(result.decisions).toMatchObject([{ decision: 'rejected', reasonCodes: ['GAME_MISMATCH'] }]);
    expect(result.knowledge.sources).toEqual([]);
  });

  it.each([
    'Unlike Dark Souls, Elden Ring uses the listed Samurai equipment.',
    'Unlike in Diablo 4, the Elden Ring Samurai uses the starting Uchigatana.',
    'In contrast to Diablo 4, the Elden Ring Samurai uses the starting Uchigatana.',
    'As in Diablo 4, Elden Ring requires choosing equipment for a build.',
    'Like in Diablo 4, Elden Ring requires choosing equipment for a build.',
    'These recommendations do not apply in Diablo 4.',
    'The source quotes: "In Diablo 4, use a different weapon."',
    'The source quotes: "\nIn Diablo 4, use a different weapon.\n"',
    'In Limgrave, upgrade the Uchigatana before tackling stronger enemies.'
  ])('keeps comparative, negative, quoted and location references separate: %s', reference => {
    expect(assessGamingClearSourceIdentity(document(`${reference} ${correct}`), input, assessGamingSourcePolicy(url, input.game)))
      .toMatchObject({ status: 'verified' });
  });

  it('still rejects an affirmative wrong-game clause after a comparative clause', () => {
    const text = `Unlike in Elden Ring, in Diablo 4, use the Samurai katana blade and Uchigatana. ${correct}`;
    expect(assessGamingClearSourceIdentity(document(text), input, assessGamingSourcePolicy(url, input.game)))
      .toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it('keeps a visible quotation from hiding later affirmative wrong-game instructions', () => {
    const text = `"In Elden Ring, the quoted guide mentions Diablo 4." ${wrong} ${correct}`;
    expect(assessGamingClearSourceIdentity(document(text), input, assessGamingSourcePolicy(url, input.game)))
      .toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it.each([['Elden Ring Nightreign', 'GAME_MISMATCH'], ['Elden Ring Shadow of the Erdtree', 'EDITION_CONFLICT']])
  ('keeps acquired %s scope categorized independently of earlier Elden Ring prose', (game, reason) => {
    const text = `${correct} In ${game}, use the Samurai katana blade and Uchigatana.`;
    expect(assessGamingClearSourceIdentity(document(text), input, assessGamingSourcePolicy(url, input.game)))
      .toMatchObject({ status: 'conflict', reasonCodes: [reason] });
  });

  it.each(['"Elden Ring Shadow of the Erdtree"', "'Elden Ring Shadow of the Erdtree'",
    '“Elden Ring Shadow of the Erdtree”', '`Elden Ring Shadow of the Erdtree`'])
  ('does not erase an affirmative quoted expansion name: %s', name => {
    const text = `${correct} In ${name}, use the Samurai katana blade and Uchigatana.`;
    expect(assessGamingClearSourceIdentity(document(text), input, assessGamingSourcePolicy(url, input.game)))
      .toMatchObject({ status: 'conflict', reasonCodes: ['EDITION_CONFLICT'] });
  });

  it('preserves an applicable quoted qualified game name', () => {
    const scopedInput = { ...input, game: 'Minecraft Java' };
    const scopedDocument = { ...document('In "Minecraft Java", gather wood before crafting your first tools.'),
      metadata: { title: 'Minecraft Java beginner guide', headings: 'Minecraft Java beginner guide' } };
    expect(assessGamingClearSourceIdentity(scopedDocument, scopedInput, assessGamingSourcePolicy(url, scopedInput.game)))
      .toMatchObject({ status: 'verified' });
  });

  it.each(['"Baldur\'s Gate 3"', "'Baldur's Gate 3'"])
  ('preserves internal name punctuation in an affirmative quoted wrong-game scope: %s', name => {
    const text = `In ${name}, use the Samurai katana blade and Uchigatana. ${correct}`;
    expect(assessGamingClearSourceIdentity(document(text), input, assessGamingSourcePolicy(url, input.game)))
      .toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it('retains existing explicit acquired guide-name detection outside the alias catalog', () => {
    const text = `In "Stardew Valley" guide, farm crops before gathering supplies. ${correct}`;
    expect(assessGamingClearSourceIdentity(document(text), input, assessGamingSourcePolicy(url, input.game)))
      .toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it('inspects a later scope independently of an acquired title containing an introducer', async () => {
    const result = await acquire(wrong, 'Samurai build in Elden Ring');
    expect(result.accepted).toEqual([]);
    expect(result.decisions).toMatchObject([{ decision: 'rejected', reasonCodes: ['GAME_MISMATCH'] }]);
    expect(result.knowledge.sources).toEqual([]);
  });

  it('admits independently acquired applicable Elden Ring guidance with incidental comparisons', async () => {
    const result = await acquire(`Unlike Dark Souls, Elden Ring uses the listed Samurai equipment. ${correct}`);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].publicUrl).toBe(url);
    expect(result.accepted[0].sourceAssessment.gates.identity).toBe('verified');
  });
});
