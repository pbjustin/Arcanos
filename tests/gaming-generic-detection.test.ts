import { describe, expect, it } from '@jest/globals';
import { detectGamingGame } from '../src/services/gamingGameDetection.js';
import { assessGamingClearSourceIdentity } from '../src/shared/gaming/gamingClearSource.js';
import { assessGamingSourcePolicy } from '../src/shared/gaming/gamingFreshnessCore.js';
import { gamingRegistrySourceGameMatchesRequest, readGamingRegistryEditionScope,
  validateGamingGameRegistry } from '../src/shared/gaming/gamingGameRegistry.js';
import { extractGamingDocumentEvidence } from '../src/services/gamingDocumentEvidence.js';
import { gamingDocumentFetchOptions } from '../src/services/gamingDocumentExtraction.js';
import { extractFetchAndCleanDocument } from '../src/shared/webFetcher.js';

const url = 'https://community-fixture.example/walkthrough';
const guidance = 'Check your supplies before leaving the starting area. Complete the nearby objectives first and return to rest before continuing the route.';

// Original synthetic article layouts; no captured publisher passages or network use.
function assess(game: string, title: string, prose: string) {
  const body = `<html><title>${title}</title><body><main><article><h1>${title}</h1><p>${prose}</p><p>${guidance}</p></article></main></body></html>`;
  const extracted = extractGamingDocumentEvidence({ body, contentType: 'text/html', sourceUrl: url });
  let metadata: { title?: string; headings?: string } = {};
  const cleaned = extractFetchAndCleanDocument(url, extracted.proseBody, 'text/html', 100_000,
    gamingDocumentFetchOptions(url, { retainFullSelectedText: true, maxSelectedTextChars: 100_000,
      onExtraction: metrics => { metadata = { title: metrics.documentTitle, headings: metrics.headingText }; } }));
  const document = { publicUrl: url, metadata, evidenceUnits: extracted.units,
    text: [cleaned.text, ...extracted.units.map(unit => unit.text)].join('\n') };
  return assessGamingClearSourceIdentity(document, { game, mode: 'guide', prompt: 'Explain the starting route and nearby objectives.' },
    assessGamingSourcePolicy(url, game));
}

describe('article subjects and independently established game ownership', () => {
  it.each(['White Orchard Walkthrough', 'Mira Early Game Guide', 'Copper Harbor Walkthrough', 'Prism Dial Guide'])
  ('labels the unregistered subject of %s without declaring it an established game', title => {
    expect(detectGamingGame({ pageTitle: title, excludeAcquiredTopicIdentities: true }))
      .toMatchObject({ source: 'page_metadata', subjectKind: 'article_subject' });
  });

  it.each([
    ['The Witcher 3', 'White Orchard Walkthrough', 'White Orchard is an introductory area in The Witcher 3.'],
    ['Xenoblade Chronicles X', 'Mira Early Game Guide', 'Mira is a planet in Xenoblade Chronicles X.'],
    ['Lantern Voyage', 'Copper Harbor Walkthrough', 'Copper Harbor is an optional quest in Lantern Voyage.'],
    ['Velvet Circuit', 'Prism Dial Guide', 'Prism Dial is a character in Velvet Circuit.']
  ])('retains %s ownership when the acquired title describes %s', (game, title, prose) => {
    expect(assess(game, title, prose)).toMatchObject({ status: 'verified', gameIdentityVerified: true });
    expect(assess(game, title, guidance)).toMatchObject({ status: 'unknown', reasonCodes: ['GAME_IDENTITY_UNVERIFIED'] });
  });

  it('preserves a recognized opposing game identity despite a relevant topic', () => {
    expect(assess('Elden Ring', 'Diablo IV Walkthrough', 'In the game Elden Ring, complete nearby objectives.'))
      .toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it('preserves an independently declared opposing unregistered primary article identity', () => {
    expect(assess('Lantern Voyage', 'Copper Harbor Walkthrough', 'In the game Copper Harbor, complete nearby objectives.'))
      .toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it.each(['minecraft', 'elden ring', 'stardew valley'])('retains the recognized lowercase game scope %s before a gameplay predicate', other => {
    expect(assess('Lantern Voyage', 'Lantern Voyage Walkthrough',
      `In the game Lantern Voyage, complete nearby objectives. In the game ${other} combat rewards patience.`))
      .toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it.each(['Minecraft Moonbound can inspect equipment', 'minecraft moonbound combat rewards patience'])
  ('does not erase an unreviewed family qualifier before the predicate: %s', scope => {
    expect(assess('Minecraft', 'Minecraft Walkthrough',
      `In the game Minecraft, complete nearby objectives. In the game ${scope}.`).status).not.toBe('verified');
  });
});

describe('corroborated acquired alternate titles preserve edition and sequel boundaries', () => {
  it.each([
    ['The Witcher 3', 'Witcher 3'],
    ['The Legend of Zelda: Tears of the Kingdom', 'Zelda: Tears of the Kingdom'],
    ['The Lantern Voyage: Copper Horizons', 'Lantern Voyage: Copper Horizons']
  ])('accepts the explicit %s / %s alias only alongside separate canonical game scope', (game, alias) => {
    const declaration = `The game ${game} is also known as ${alias}.`;
    expect(assess(game, `${alias} Walkthrough`, `${declaration} In the game ${game}, complete the nearby objectives. In the game ${alias}, return to rest before continuing.`))
      .toMatchObject({ status: 'verified', gameIdentityVerified: true });
    expect(assess(game, `${alias} Walkthrough`, declaration).status).not.toBe('verified');
    expect(gamingRegistrySourceGameMatchesRequest(alias, game)).toBe(false);
  });

  it.each(['Xenoblade Chronicles X: Definitive Edition', 'Xenoblade Chronicles X II', 'Xenoblade Chronicles X: Remastered'])
  ('does not silently collapse the unreviewed relationship %s into the base game', title => {
    expect(gamingRegistrySourceGameMatchesRequest(title, 'Xenoblade Chronicles X')).toBe(false);
    expect(assess('Xenoblade Chronicles X', `${title} Guide`, `In the game ${title}, complete nearby objectives.`).status)
      .not.toBe('verified');
  });

  it.each([
    ['Xenoblade Chronicles X', 'Xenoblade Chronicles X: Definitive Edition'],
    ['Copper Harbor', 'Copper Harbor II'],
    ['Copper Harbor', 'Copper Harbor Remastered'],
    ['Lantern Voyage', 'Lantern Voyage: DLC'],
    ['Copper Harbor II', 'Copper Harbor III']
  ])('does not let an acquired alias erase distinct edition or sequel scope %s / %s', (game, other) => {
    const prose = `The game ${game} is also known as ${other}. In the game ${game}, complete nearby objectives. In the game ${other}, use an incompatible route.`;
    expect(assess(game, `${other} Walkthrough`, prose).status).not.toBe('verified');
  });

  it.each(['Lantern Voyage', 'Velvet Circuit'])('uses an explicit configured edition relationship for %s with a subtitle separator', game => {
    const registry = validateGamingGameRegistry({ version: 'gaming-game-registry/v1', revision: 'synthetic-edition-v1', games: [{
      id: game.toLowerCase().replaceAll(' ', '-'), name: game, aliases: [], related: [], platforms: [],
      editions: [
        { id: 'original', name: 'Original Edition', kind: 'edition', aliases: [], platforms: [] },
        { id: 'definitive', name: 'Definitive Edition', kind: 'edition', aliases: [], platforms: [] }
      ], provenance: { reviewedAt: '2026-10-18', references: ['tests/gaming-generic-detection.test.ts'] }
    }] });
    expect(gamingRegistrySourceGameMatchesRequest(`${game}: Definitive Edition`, game, registry)).toBe(true);
    expect(readGamingRegistryEditionScope({ text: `In ${game}: Definitive Edition, complete the nearby objectives.` }, game, registry))
      .toMatchObject({ status: 'verified', edition: 'Definitive Edition' });
    expect(readGamingRegistryEditionScope({ text: `Edition: Original Edition. In ${game}: Definitive Edition, complete the nearby objectives.` }, game, registry))
      .toMatchObject({ status: 'conflict' });
  });
});
