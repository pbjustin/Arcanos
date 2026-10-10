import { describe, expect, it } from '@jest/globals';
import { assessGamingClearSourceIdentity } from '../src/shared/gaming/gamingClearSource.js';
import { assessGamingSourcePolicy } from '../src/shared/gaming/gamingFreshnessCore.js';
import { selectGamingEditionScopedEvidence } from '../src/shared/gaming/gamingStructuralEvidence.js';
import { extractGamingDocumentEvidence } from '../src/services/gamingDocumentEvidence.js';
import { gamingDocumentFetchOptions } from '../src/services/gamingDocumentExtraction.js';
import { extractFetchAndCleanDocument } from '../src/shared/webFetcher.js';
import { GAMING_GAME_REGISTRY } from '../src/shared/gaming/gamingGameRegistry.js';

const url = 'https://independent.example/guides/equipment';
const input = { game: 'Portal 2', edition: 'base-game', mode: 'build' as const,
  prompt: 'Explain the practice build equipment and skill.' };
const title = 'Portal 2 equipment build guide';
// These are labeled synthetic mechanics, not assertions about the real game's equipment.
const prose = 'In Portal 2, this synthetic practice build combines a practice item with a practice skill. '
  + 'Use the practice item carefully, retain room for movement, and choose the practice skill before starting the equipment route.';
const row = (game: string, scope = 'Base game', note = '') => `<tr><td>${game}</td><td>Practice</td><td>Practice item</td><td>Practice skill</td><td>${scope}</td><td>${note || 'Synthetic regression example.'}</td></tr>`;
const table = (rows: string) => '<table><caption>Independently scoped equipment records</caption><tr>'
  + '<th>Game</th><th>Build</th><th>Item</th><th>Skill</th><th>Scope</th><th>Notes</th></tr>' + rows + '</table>';
function document(content: string, pageTitle = title) {
  const body = `<html><title>${pageTitle}</title><body><article><h1>${title}</h1><p>${prose}</p>${content}</article></body></html>`;
  const extracted = extractGamingDocumentEvidence({ body, contentType: 'text/html', sourceUrl: url });
  let metadata: { title?: string; headings?: string } = {};
  const cleaned = extractFetchAndCleanDocument(url, extracted.proseBody, 'text/html', 100_000,
    gamingDocumentFetchOptions(url, { retainFullSelectedText: true, maxSelectedTextChars: 100_000,
      onExtraction: metrics => { metadata = { title: metrics.documentTitle, headings: metrics.headingText }; } }));
  return { publicUrl: url, metadata, evidenceUnits: extracted.units,
    text: [cleaned.text, ...extracted.units.map(unit => unit.text)].join('\n') };
}
const identity = (doc: ReturnType<typeof document>) => assessGamingClearSourceIdentity(doc, input, assessGamingSourcePolicy(url, input.game));

describe('generic acquired local gameplay record scope', () => {
  it.each(['Historically, in Diablo IV, the practice skill behaved differently.',
    'Historically, in the game Lantern Vale, the practice skill behaved differently.',
    'Related article: Diablo IV build guide: use the practice skill carefully.',
    'Recommended reading: Lantern Vale guide: the practice equipment differs.'])
  ('keeps an explicitly bounded reference separate from the primary subject: %s', reference => {
    expect(identity(document(`<p>${reference}</p>`)).status).toBe('verified');
  });

  it('does not use a historical mention as independent acquired identity', () => {
    const sourceTitle = 'Portal 2 beginner guide';
    const doc = { publicUrl: url, metadata: { title: sourceTitle, headings: sourceTitle },
      text: `${sourceTitle}. Historically, in Portal 2, the practice equipment behaved differently. `
        + 'Collect practice items, inspect the practice route, and preserve room for movement before starting.' };
    expect(assessGamingClearSourceIdentity(doc, input, assessGamingSourcePolicy(url, input.game)).status).toBe('unknown');
  });

  it('keeps a following affirmative guide identity terminal after a historical reference', () => {
    const doc = document('<p>Historically, in Hades, the practice skill behaved differently. This guide covers Lantern Vale.</p>');
    expect(identity(doc)).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it.each(['Portal 2', 'Lantern Vale'])('does not count a repeated primary heading as independent %s gameplay identity', game => {
    const sourceTitle = `${game} beginner guide`;
    const doc = { publicUrl: url, metadata: { title: sourceTitle, headings: sourceTitle },
      text: `${sourceTitle}. Collect the practice item, follow the practice route, and use the practice skill carefully. `
        + 'Retain movement space and inspect the equipment before starting the synthetic exercise.' };
    expect(assessGamingClearSourceIdentity(doc, { ...input, game }, assessGamingSourcePolicy(url, game)))
      .toMatchObject({ status: 'unknown', reasonCodes: ['GAME_IDENTITY_UNVERIFIED'] });
  });

  it('binds a complete gameplay tuple using its separately acquired game caption', () => {
    const body = `<html><title>${title}</title><body><table><caption>Portal 2</caption>`
      + '<tr><th>Build</th><th>Item</th><th>Skill</th><th>Scope</th></tr>'
      + '<tr><td>Practice</td><td>Practice item</td><td>Practice skill</td><td>Base game</td></tr>'
      + '</table></body></html>';
    const extracted = extractGamingDocumentEvidence({ body, contentType: 'text/html', sourceUrl: url });
    const doc = { publicUrl: url, metadata: { title }, evidenceUnits: extracted.units,
      text: extracted.units.map(unit => unit.text).join('\n') };
    expect(identity(doc).status).toBe('verified');
  });

  it('does not let an inherited duplicate primary heading ground an unnamed tuple', () => {
    const body = `<html><title>${title}</title><body><article><h1>${title}</h1>`
      + '<table><tr><th>Build</th><th>Item</th><th>Skill</th><th>Scope</th></tr>'
      + '<tr><td>Practice</td><td>Practice item</td><td>Practice skill</td><td>Base game</td></tr>'
      + '</table></article></body></html>';
    const extracted = extractGamingDocumentEvidence({ body, contentType: 'text/html', sourceUrl: url });
    const doc = { publicUrl: url, metadata: { title, headings: title }, evidenceUnits: extracted.units,
      text: [title, ...extracted.units.map(unit => unit.text)].join('\n') };
    expect(identity(doc).status).toBe('unknown');
  });

  it.each(['Hades', 'Lantern Vale'])('keeps requested-game evidence when a complete local record names %s', otherGame => {
    const doc = document(table(row(input.game) + row(otherGame)));
    expect(doc.evidenceUnits.filter(unit => unit.kind === 'table_row')).toHaveLength(2);
    expect(identity(doc).status).toBe('verified');
    const selected = selectGamingEditionScopedEvidence(doc, input);
    expect(selected.status).toBe('verified');
    expect(selected.units).toHaveLength(1);
    expect(selected.units[0].fields.find(field => field.label === 'Game')?.value).toBe(input.game);
    expect(selected.text).not.toContain(otherGame);
  });

  it('keeps a contradictory global structured Game declaration terminal', () => {
    const doc = document('<p>Game: Hades.</p>' + table(row(input.game)));
    expect(identity(doc)).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
    expect(selectGamingEditionScopedEvidence(doc, input).status).toBe('conflict');
  });

  it('does not let a correct local record override a wrong primary article identity', () => {
    expect(identity(document(table(row(input.game)), 'Diablo IV equipment build guide')))
      .toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it.each(['partial', 'ambiguous'] as const)('does not discard an %s foreign record to manufacture safe scope', status => {
    const doc = document(table(row(input.game) + row('Hades')));
    const foreign = doc.evidenceUnits.find(unit => unit.fields.some(field => field.label === 'Game' && field.value === 'Hades'))!;
    const unsafe = { ...doc, evidenceUnits: doc.evidenceUnits.map(unit => unit === foreign
      ? { ...unit, integrity: { status, reasons: ['incomplete_record'] } } : unit) };
    expect(identity(unsafe).status).not.toBe('verified');
    expect(selectGamingEditionScopedEvidence(unsafe, input).status).not.toBe('verified');
  });

  it('preserves source-wide guide declarations inherited by an otherwise local foreign record', () => {
    const doc = document('<section><p>This guide covers Hades.</p>' + table(row('Hades')) + '</section>' + table(row(input.game)));
    expect(identity(doc)).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it.each(['This article covers Hades.', 'This source is for Hades.', 'This guide is about Hades.',
    'This walkthrough is about Hades.', 'This build is for Hades.'])
  ('never projects a foreign record containing the global declaration %s', declaration => {
    const doc = document(table(row(input.game) + row('Hades', 'Base game', declaration)));
    expect(doc.evidenceUnits.filter(unit => unit.kind === 'table_row')).toHaveLength(2);
    expect(identity(doc)).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
    expect(selectGamingEditionScopedEvidence(doc, input).status).not.toBe('verified');
  });

  it('keeps a completely quoted passage incidental in an otherwise unrelated local record', () => {
    const doc = document(table(row(input.game) + row('Hades', 'Base game', 'A historical quotation: "This article covers Hades."')));
    expect(identity(doc).status).toBe('verified');
    expect(selectGamingEditionScopedEvidence(doc, input).units).toHaveLength(1);
  });

  it.each(['This article covers "Hades".', 'Quotation: "This article covers Hades." This source is for Hades.'])
  ('does not treat a quoted name or later affirmative source scope as an incidental passage: %s', declaration => {
    const doc = document(table(row(input.game) + row('Hades', 'Base game', declaration)));
    expect(identity(doc)).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it.each(['This article covers Lantern Vale.', 'This source is for Lantern Vale.', 'This guide is about Lantern Vale.'])
  ('preserves an affirmative global declaration following a historical reference: %s', declaration => {
    expect(identity(document(`<p>Historically, in Hades, the practice skill differed. ${declaration}</p>`)))
      .toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it('binds a sparse tuple under an acquired exact game heading without requiring a row Game field', () => {
    const game = 'Void Frontier';
    const sourceTitle = `${game} guide`;
    const body = `<html><title>${sourceTitle}</title><body><main><h1>${game}</h1>`
      + '<table><tr><th>System</th><th>Body</th><th>Site</th><th>Resource</th></tr>'
      + '<tr><td>TEST-ORION-01</td><td>B 2</td><td>PML 7</td><td>Platinum</td></tr></table>'
      + '</main></body></html>';
    const extracted = extractGamingDocumentEvidence({ body, contentType: 'text/html', sourceUrl: url });
    const doc = { publicUrl: url, metadata: { title: sourceTitle, headings: game }, evidenceUnits: extracted.units,
      text: [game, ...extracted.units.map(unit => unit.text)].join('\n') };
    expect(assessGamingClearSourceIdentity(doc, { game, mode: 'guide', prompt: 'Which system, body and site reports Platinum in TEST-ORION-01?' },
      assessGamingSourcePolicy(url, game)).status).toBe('verified');
  });

  it('preserves incompatible editions for the requested game', () => {
    const doc = document(table(row(input.game, 'Expansion')));
    expect(identity(doc).status).not.toBe('verified');
    expect(selectGamingEditionScopedEvidence(doc, input).status).toBe('conflict');
  });

  it.each(['div', 'p', 'aside'])('preserves a parser-owned related-title correction in a %s wrapper', tag => {
    const game = 'Minecraft';
    const body = `<article><h1>${game} equipment guide</h1><${tag}>Correction: Dungeons equipment is no longer available.</${tag}>`
      + '<ul><li>Game: Minecraft; Build: Practice; Item: Practice item; Skill: Practice skill; Scope: Base game</li></ul></article>';
    const extracted = extractGamingDocumentEvidence({ body, contentType: 'text/html', sourceUrl: url });
    expect(extracted.units[0].context.qualifiers).toContain('Correction: Dungeons equipment is no longer available.');
    expect(selectGamingEditionScopedEvidence({ publicUrl: url, text: extracted.units.map(unit => unit.text).join('\n'), evidenceUnits: extracted.units },
      { game, edition: 'base-game' })).toMatchObject({ status: 'conflict', reasonCodes: ['CONFLICTING_EDITION_SCOPE'] });
  });

  it('does not import a related-title comparison as a direct-record correction', () => {
    const body = '<article><h1>Minecraft equipment guide</h1><div>Unlike Correction: Dungeons equipment is no longer available, this compares an unrelated route.</div>'
      + '<ul><li>Game: Minecraft; Build: Practice; Item: Practice item; Skill: Practice skill; Scope: Base game</li></ul></article>';
    const extracted = extractGamingDocumentEvidence({ body, contentType: 'text/html', sourceUrl: url });
    expect(extracted.units[0].context.qualifiers).toBeUndefined();
    expect(selectGamingEditionScopedEvidence({ publicUrl: url, text: extracted.units.map(unit => unit.text).join('\n'), evidenceUnits: extracted.units },
      { game: 'Minecraft', edition: 'base-game' })).toMatchObject({ status: 'verified', reasonCodes: ['INTACT_BASE_GAME_SCOPE'] });
  });

  it('reports edition conflict for an expansion-only primary declaration without inventing a new game identity', () => {
    const base = 'Portal 2';
    const sourceTitle = `${base} expansion equipment guide`;
    const doc = { publicUrl: url, metadata: { title: sourceTitle }, text: `Game: ${base}. Edition: Expansion. `
      + 'This guide covers only expansion content. In Portal 2, the synthetic expansion equipment differs from the base game.' };
    expect(assessGamingClearSourceIdentity(doc, input, assessGamingSourcePolicy(url, base)))
      .toMatchObject({ status: 'conflict', reasonCodes: ['EDITION_CONFLICT'] });
  });

  it.each(GAMING_GAME_REGISTRY.games.flatMap(game => game.editions.filter(edition => edition.kind === 'base')
    .map(edition => ({ game: game.name, edition: edition.name }))))
  ('recognizes an exact requested game-and-base-edition body scope: $game / $edition', ({ game, edition }) => {
    const sourceTitle = `${game} equipment build guide`;
    const doc = { publicUrl: url, metadata: { title: sourceTitle, headings: sourceTitle },
      text: `${sourceTitle}. In ${game} ${edition}, the synthetic practice build combines a practice item with a practice skill. `
        + 'Use the practice item carefully and preserve movement space while choosing the practice skill.' };
    expect(assessGamingClearSourceIdentity(doc, { ...input, game, edition }, assessGamingSourcePolicy(url, game)).status)
      .toBe('verified');
  });

  it.each(GAMING_GAME_REGISTRY.games.flatMap(game => game.editions.filter(edition => edition.kind === 'expansion' || edition.kind === 'dlc')
    .map(edition => ({ game: game.name, edition: edition.name }))))
  ('reports registered expansion-only scope as an applicability conflict: $game / $edition', ({ game, edition }) => {
    const doc = { publicUrl: url, metadata: { title: `${game} ${edition} guide` }, text: `Game: ${game}. Edition: ${edition}. `
      + `This guide covers only ${edition} expansion content. In ${game}, this synthetic expansion equipment differs from the base game.` };
    expect(assessGamingClearSourceIdentity(doc, { ...input, game }, assessGamingSourcePolicy(url, game)))
      .toMatchObject({ status: 'conflict', reasonCodes: ['EDITION_CONFLICT'] });
  });

  it.each(GAMING_GAME_REGISTRY.games.flatMap(game => game.editions.filter(edition => edition.kind === 'expansion' || edition.kind === 'dlc')
    .map(edition => ({ game: game.name, edition: edition.name }))))
  ('cannot launder a second primary game behind a matching expansion prefix: $game / $edition', ({ game, edition }) => {
    const doc = { publicUrl: url, metadata: { title: `${game} ${edition} guide` }, text: `Game: ${game}. Edition: ${edition}. `
      + `This guide covers only ${edition} expansion content and Lantern Vale. In ${game}, this synthetic equipment differs.` };
    expect(assessGamingClearSourceIdentity(doc, { ...input, game, edition }, assessGamingSourcePolicy(url, game)).status)
      .toBe('conflict');
  });

  it('does not classify a lone foreign Game and item label as independently usable gameplay', () => {
    const doc = document('<table><tr><th>Game</th><th>Item</th></tr><tr><td>Hades</td><td>Practice item</td></tr></table>' + table(row(input.game)));
    expect(identity(doc).status).not.toBe('verified');
  });
});
