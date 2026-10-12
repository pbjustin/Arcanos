import { describe, expect, it } from '@jest/globals';
import { extractGamingDocumentEvidence } from '../src/services/gamingDocumentEvidence.js';
import { gamingDocumentFetchOptions } from '../src/services/gamingDocumentExtraction.js';
import { assessGamingClearSourceIdentity } from '../src/shared/gaming/gamingClearSource.js';
import { assessGamingSourcePolicy } from '../src/shared/gaming/gamingFreshnessCore.js';
import { extractFetchAndCleanDocument } from '../src/shared/webFetcher.js';

// Synthetic publisher-shaped documents, not a captured copy of the reported wiki page.
const neutralUrl = 'https://publisher.example/guidance';
function acquiredDocument(title: string, prose: string, url = neutralUrl, heading = title) {
  const body = `<html><title>${title}</title><body><article><h1>${heading}</h1><p>${prose}</p></article></body></html>`;
  const extracted = extractGamingDocumentEvidence({ body, contentType: 'text/html', sourceUrl: url });
  let metadata: { title?: string; headings?: string } = {};
  const cleaned = extractFetchAndCleanDocument(url, extracted.proseBody, 'text/html', 100_000,
    gamingDocumentFetchOptions(url, { retainFullSelectedText: true, maxSelectedTextChars: 100_000,
      onExtraction: metrics => { metadata = { title: metrics.documentTitle, headings: metrics.headingText }; } }));
  return { publicUrl: url, metadata, evidenceUnits: extracted.units,
    text: [cleaned.text, ...extracted.units.map(unit => unit.text)].join('\n') };
}
const request = { game: 'Elden Ring', mode: 'guide' as const,
  prompt: 'What should I do at the Church of Elleh before moving on?' };
const location = 'Church of Elleh is a location in Elden Ring. Rest at the Church of Elleh Site of Grace before continuing. Check the merchant supplies and review equipment before leaving the church.';
function assess(title: string, prose = location, input = request, url = neutralUrl) {
  return assessGamingClearSourceIdentity(acquiredDocument(title, prose, url), input, assessGamingSourcePolicy(url, input.game));
}

describe('independently acquired named location and mechanic headings', () => {
  it('already verifies ordinary game-qualified location metadata without a distinct body scope', () => {
    expect(assess('Church of Elleh - Elden Ring Wiki')).toMatchObject({ status: 'verified', gameIdentityVerified: true });
  });

  it.each(['Church of Elleh', 'Church of Elleh guide', 'Church of Elleh walkthrough'])
  ('uses acquired location ownership instead of inventing a game from %s', title => {
    expect(assess(title)).toMatchObject({ status: 'verified', gameIdentityVerified: true,
      reasonCodes: ['ACQUIRED_BODY_SCOPE_IDENTITY'] });
  });

  it.each(['This guide covers Church of Elleh.', 'This guide is for Church of Elleh.',
    'Church of Elleh guide: rest before continuing.'])('keeps typed location ownership through an ordinary guide subject: %s', subject => {
    expect(assess('Church of Elleh guide', `${location} ${subject}`)).toMatchObject({ status: 'verified', gameIdentityVerified: true });
  });

  it.each([
    ['Stardew Valley', 'Pelican Town', 'town', 'Explore Pelican Town and check supplies before leaving.'],
    ['Minecraft', 'Equipment load', 'mechanic', 'Review equipment load before moving between areas.'],
    ['Lantern Voyage', 'Copper Harbor', 'location', 'Check supplies at Copper Harbor before continuing.']
  ])('preserves acquired %s topic ownership for %s without relying on a game catalog', (game, subject, kind, guidance) => {
    expect(assess(`${subject} guide`, `${subject} is a ${kind} in ${game}. ${guidance}`, {
      ...request, game, prompt: `Explain ${subject}.`
    })).toMatchObject({ status: 'verified', gameIdentityVerified: true });
  });

  it.each([
    'Church of Elleh is a location in Diablo IV.',
    'Church of Elleh is not a location in Elden Ring.',
    'Unlike Church of Elleh is a location in Elden Ring, this page describes another game.',
    'The article quotes: "Church of Elleh is a location in Elden Ring."',
    'Another Place is a location in Elden Ring.',
    'Church of Elleh is a game in Elden Ring.'
  ])('does not manufacture requested-game ownership from %s', prose => {
    expect(assess('Church of Elleh guide', `${prose} Review supplies before continuing.`).status).not.toBe('verified');
  });

  it('does not let the requested-game URL establish ownership', () => {
    expect(assess('Church of Elleh guide', 'Rest at the church and check supplies before continuing.', request,
      'https://eldenring.wiki.gg/wiki/Church_of_Elleh').status).not.toBe('verified');
  });

  it('uses an independently acquired game-qualified primary heading with a location-only page title', () => {
    const document = acquiredDocument('Church of Elleh', location, neutralUrl, 'Church of Elleh - Elden Ring Wiki');
    expect(document.metadata).toEqual({ title: 'Church of Elleh', headings: 'Church of Elleh - Elden Ring Wiki' });
    expect(assessGamingClearSourceIdentity(document, request, assessGamingSourcePolicy(neutralUrl, request.game)))
      .toMatchObject({ status: 'verified', gameIdentityVerified: true });
  });

  it('keeps an acquired wrong-game primary heading binding despite a requested-game page title', () => {
    const document = acquiredDocument('Church of Elleh - Elden Ring Wiki', location, neutralUrl, 'Diablo IV location guide');
    expect(assessGamingClearSourceIdentity(document, request, assessGamingSourcePolicy(neutralUrl, request.game)))
      .toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it('rejects an explicit acquired wrong-game label at a requested-game wiki URL', () => {
    expect(assess('Church of Elleh guide', `${location} Game: Diablo IV.`, request,
      'https://eldenring.wiki.gg/wiki/Church_of_Elleh'))
      .toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'],
        diagnostic: { ruleId: 'gaming.identity.acquired_game_label_conflict', evidenceCategory: 'prose_metadata' } });
  });

  it('does not let game-qualified metadata hide contradictory acquired ownership of the same location', () => {
    expect(assess('Church of Elleh - Elden Ring Wiki', `${location} Church of Elleh is a location in Copper Vale.`))
      .toMatchObject({ status: 'conflict', gameIdentityVerified: false, reasonCodes: ['GAME_MISMATCH'],
        diagnostic: { ruleId: 'gaming.identity.acquired_topic_ownership_conflict', evidenceCategory: 'body_scope' } });
  });

  it('keeps contradictory game-qualified location ownership binding outside Elden Ring', () => {
    const input = { ...request, game: 'Stardew Valley', prompt: 'What should I do in Pelican Town?' };
    expect(assess('Pelican Town - Stardew Valley Wiki',
      'Pelican Town is a town in Stardew Valley. Check your supplies in Pelican Town before continuing. '
      + 'Pelican Town is a town in Copper Vale.', input))
      .toMatchObject({ status: 'conflict', gameIdentityVerified: false, reasonCodes: ['GAME_MISMATCH'],
        diagnostic: { ruleId: 'gaming.identity.acquired_topic_ownership_conflict', evidenceCategory: 'body_scope' } });
  });

  it('still checks same-location ownership beyond the positive identity window with game-qualified metadata', () => {
    expect(assess('Church of Elleh - Elden Ring Wiki',
      `${location} ${'Review supplies before continuing. '.repeat(1_000)} Church of Elleh is a location in Copper Vale.`).status)
      .not.toBe('verified');
  });

  it.each([
    'The article quotes: "Church of Elleh is a location in Copper Vale."',
    'Church of Elleh is not a location in Copper Vale.'
  ])('does not turn non-affirmative topic references into contradictory ownership: %s', reference => {
    expect(assess('Church of Elleh - Elden Ring Wiki', `${location} ${reference}`))
      .toMatchObject({ status: 'verified', gameIdentityVerified: true });
  });

  it('keeps acquired DLC-only location applicability incompatible with an explicit base-game request', () => {
    const input = { ...request, edition: 'base-game' };
    expect(assess('Church of Elleh guide', `${location} This location guide requires Shadow of the Erdtree.`, input))
      .toMatchObject({ status: 'conflict', reasonCodes: ['EDITION_CONFLICT'] });
  });

  it.each(['Church of Elleh', 'Church of Elleh guide'])('does not choose a game for contradictory ownership of %s', title => {
    expect(assess(title, `${location} Church of Elleh is a location in Copper Vale.`).status).not.toBe('verified');
  });

  it.each([',', ';'])('inspects contradictory topic ownership after a %s boundary', boundary => {
    expect(assess('Church of Elleh guide', `Church of Elleh is a location in Elden Ring${boundary} Church of Elleh is a location in Copper Vale. Rest at the church and check supplies before continuing.`).status)
      .not.toBe('verified');
  });

  it.each([',', ';'])('inspects contradictory topic ownership after an intervening clause with %s boundaries', boundary => {
    expect(assess('Church of Elleh guide', `Church of Elleh is a location in Elden Ring${boundary} note${boundary} Church of Elleh is a location in Copper Vale. Rest at the church and check supplies before continuing.`).status)
      .not.toBe('verified');
  });

  it('does not use a definition beyond the bounded primary identity scope', () => {
    expect(assess('Church of Elleh guide', `${'Review supplies before continuing. '.repeat(1_000)} ${location}`).status)
      .not.toBe('verified');
  });

  it('still inspects contradictory definitions beyond the positive identity scope', () => {
    expect(assess('Church of Elleh guide', `${location} ${'Review supplies before continuing. '.repeat(1_000)} Church of Elleh is a location in Copper Vale.`).status)
      .not.toBe('verified');
  });

  it.each([
    ['In Diablo IV, use the starting weapon.', 'GAME_MISMATCH'],
    ['In Elden Ring Nightreign, use the starting weapon.', 'GAME_MISMATCH'],
    ['In Elden Ring II, use the starting weapon.', 'GAME_MISMATCH'],
    ['In Elden Ring Remastered, use the starting weapon.', 'GAME_MISMATCH'],
    ['In the game Church of Elleh, use the starting weapon.', 'GAME_MISMATCH'],
    ['Game: Church of Elleh.', 'GAME_MISMATCH'],
    ['This weapon requires Shadow of the Erdtree.', 'EDITION_CONFLICT']
  ])('preserves independent contradictory declarations: %s', (scope, reason) => {
    expect(assess('Church of Elleh guide', `${location} ${scope}`)).toMatchObject({ status: 'conflict', reasonCodes: [reason] });
  });

  it('does not reclassify a recognized different game as a location', () => {
    expect(assess('Diablo IV guide', 'Diablo IV is a location in Elden Ring. Review supplies before continuing.'))
      .toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });
});
