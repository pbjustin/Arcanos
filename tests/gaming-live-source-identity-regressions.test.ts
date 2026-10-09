import { describe, expect, it } from '@jest/globals';
import { assessGamingClearSourceIdentity } from '../src/shared/gaming/gamingClearSource.js';
import { assessGamingSourcePolicy, extractGamingFreshnessMetadata } from '../src/shared/gaming/gamingFreshnessCore.js';
import { detectGamingDocumentGame } from '../src/shared/gaming/gamingDocumentIngestionCore.js';
import { extractGamingHtmlEvidence } from '../src/services/gamingHtmlEvidence.js';
import { extractGamingDocumentEvidence } from '../src/services/gamingDocumentEvidence.js';
import { gamingDocumentFetchOptions } from '../src/services/gamingDocumentExtraction.js';
import { extractFetchAndCleanDocument } from '../src/shared/webFetcher.js';

const url = 'https://publisher-shaped.example/articles/samurai';
const input = { game: 'Elden Ring', edition: 'base-game', mode: 'build' as const,
  prompt: 'Recommend an early-game Samurai bleed build using Uchigatana through level 50.' };
const prose = 'In Elden Ring, the Samurai begins with Uchigatana. In the early game: raise Vigor and upgrade Uchigatana. Preserve stamina for dodging after attacks.';
const policy = assessGamingSourcePolicy(url, input.game);
const document = (title = 'Elden Ring Samurai bleed build guide', text = prose, headings = title) =>
  ({ publicUrl: url, text, metadata: { title, headings } });
function nativeDocument(body: string) {
  const extracted = extractGamingDocumentEvidence({ body, contentType: 'text/html', sourceUrl: url });
  let metadata: { title?: string; headings?: string } = {};
  const cleaned = extractFetchAndCleanDocument(url, extracted.proseBody, 'text/html', 100_000,
    gamingDocumentFetchOptions(url, { retainFullSelectedText: true, maxSelectedTextChars: 100_000,
      onExtraction: metrics => { metadata = { title: metrics.documentTitle, headings: metrics.headingText }; } }));
  return { publicUrl: url, metadata, evidenceUnits: extracted.units,
    text: [cleaned.text, ...extracted.units.map(unit => unit.text)].join('\n') };
}

describe('live source identity failure regressions (synthetic publisher-shaped documents)', () => {
  it.each(['early game:', 'mid game:', 'late game:', 'end game:'])('does not interpret gameplay wording %s as a Game metadata field', phrase => {
    const doc = document(undefined, prose.replace('early game:', phrase));
    expect(assessGamingClearSourceIdentity(doc, input, policy).status).toBe('verified');
    expect(extractGamingFreshnessMetadata(doc, input).game).toBe('Elden Ring');
  });

  it.each(['Dexterity build guide', 'Samurai Blade Build Guide', 'Early Game Samurai Build'])('does not invent a game from the acquired topic heading %s', title => {
    expect(detectGamingDocumentGame({ canonicalUrl: '', pageTitle: title }).game).toBeUndefined();
    expect(assessGamingClearSourceIdentity(document(title), input, policy)).toMatchObject({ status: 'verified',
      reasonCodes: ['ACQUIRED_BODY_SCOPE_IDENTITY'] });
    expect(assessGamingClearSourceIdentity(document(title, prose.replace('In Elden Ring, ', '')), input, policy).status).toBe('unknown');
  });

  it('keeps unrelated pooled recommendation headings and comparison prose separate from game declarations', () => {
    const doc = document(undefined, `${prose} Unlike in Diablo IV, Elden Ring uses the starting Samurai weapon.`,
      'Elden Ring Samurai build | Recommended: Diablo IV build guide | Elden Ring Nightreign review | Shadow of the Erdtree guide');
    expect(assessGamingClearSourceIdentity(doc, input, policy).status).toBe('verified');
  });

  it.each(['Comparison with Diablo IV build: equipment systems differ.', 'Unlike Diablo IV build: Elden Ring has a starting Samurai weapon.'])
  ('keeps a qualified comparison heading separate from an affirmative scope: %s', reference => {
    expect(assessGamingClearSourceIdentity(document(undefined, `${prose}\n${reference}`), input, policy).status).toBe('verified');
  });

  it.each(['Elden Ring Nightreign Samurai build guide', 'Diablo IV Samurai build guide', 'Copper Vale Samurai build guide'])
  ('rejects a corroborated primary heading %s despite a misleading SEO title and matching labels', heading => {
    const doc = document(undefined, `${heading}. Game: Elden Ring. Edition: base-game. ${prose}`, heading);
    expect(assessGamingClearSourceIdentity(doc, input, policy)).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'],
      diagnostic: { evidenceCategory: 'body_heading' } });
  });

  it.each(['.', '\n', ' Game: Elden Ring.', ' In Elden Ring, Samurai attacks consume stamina.'])
  ('preserves a primary distinct-game heading across the acquired boundary %j', boundary => {
    const heading = 'Elden Ring Nightreign Samurai build guide';
    const doc = document(undefined, `${heading}${boundary} ${prose}`, `${heading} | Recommended: Diablo IV guide`);
    expect(assessGamingClearSourceIdentity(doc, input, policy)).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'],
      diagnostic: { ruleId: 'gaming.identity.distinct_primary_heading_scope', evidenceCategory: 'body_heading' } });
  });

  it('keeps a corroborated primary expansion heading incompatible with the base game', () => {
    const heading = 'Elden Ring Shadow of the Erdtree Samurai build guide';
    expect(assessGamingClearSourceIdentity(document(undefined, `${heading}. ${prose}`, heading), input, policy))
      .toMatchObject({ status: 'conflict', reasonCodes: ['EDITION_CONFLICT'] });
  });

  it('does not grant subject authority to a pooled heading without the same acquired leading heading', () => {
    const doc = document(undefined, `${prose} Recommended: Elden Ring Nightreign Samurai build guide.`,
      'Elden Ring Nightreign Samurai build guide | Diablo IV build guide');
    expect(assessGamingClearSourceIdentity(doc, input, policy).status).toBe('verified');
  });

  it('does not turn comparison-only game references into positive identity through unrelated pooled headings', () => {
    const reference = 'Unlike in Elden Ring, the invented practice notebook discusses Samurai blades and dexterity. Preserve stamina for dodging after attacks.';
    for (const headings of ['Samurai Blade Build Guide', 'Samurai Blade Build Guide | Recommended: Elden Ring build guide']) {
      expect(assessGamingClearSourceIdentity(document('Samurai Blade Build Guide', reference, headings), input, policy))
        .toMatchObject({ status: 'unknown', reasonCodes: ['GAME_IDENTITY_UNVERIFIED'] });
    }
    const primary = 'Elden Ring Samurai build guide';
    expect(assessGamingClearSourceIdentity(document(primary, `${primary}. ${reference}`), input, policy).status).toBe('verified');
    expect(assessGamingClearSourceIdentity(document('Samurai Blade Build Guide', `${primary}. ${reference}`, primary), input, policy).status)
      .toBe('verified');
    expect(assessGamingClearSourceIdentity(document('Samurai Blade Build Guide', prose, 'Recommended: Elden Ring build guide'), input, policy))
      .toMatchObject({ status: 'verified', reasonCodes: ['ACQUIRED_BODY_SCOPE_IDENTITY'] });
  });

  it('does not establish a requested expansion through an unrelated pooled heading', () => {
    const request = { ...input, edition: 'Shadow of the Erdtree' };
    for (const headings of ['Elden Ring Samurai guide', 'Elden Ring Samurai guide | Recommended: Shadow of the Erdtree guide']) {
      expect(assessGamingClearSourceIdentity(document(undefined, prose, headings), request, policy))
        .toMatchObject({ status: 'unknown', reasonCodes: ['EDITION_UNVERIFIED'] });
    }
  });

  it('keeps a native comparison-only generic guide unverified when a later recommendation names the game', () => {
    const doc = nativeDocument('<html><title>Samurai Blade Build Guide</title><body><article><h1>Samurai Blade Build Guide</h1>'
      + '<p>Unlike in Elden Ring, the invented practice notebook discusses Samurai blades and dexterity. Preserve stamina for dodging after attacks.</p>'
      + '<h2>Recommended: Elden Ring build guide</h2></article></body></html>');
    expect(doc.metadata.headings).toContain('Recommended: Elden Ring');
    expect(assessGamingClearSourceIdentity(doc, input, policy)).toMatchObject({ status: 'unknown', reasonCodes: ['GAME_IDENTITY_UNVERIFIED'] });
  });

  it('retains primary game identity through native HTML block whitespace normalization', () => {
    const heading = 'Elden Ring Nightreign Samurai build guide';
    const doc = nativeDocument(`<html><title>Elden Ring Samurai build guide</title><body><article><h1>${heading}</h1>
      <p>Use the listed starting weapon for close combat and preserve stamina for a dodge after each attack.</p>
      <p>Game: Elden Ring.</p><p>Edition: base-game.</p><p>${prose}</p></article></body></html>`);
    expect(doc.metadata.headings).toBe(heading);
    expect(doc.text).toContain(`${heading} Use the listed starting weapon`);
    expect(assessGamingClearSourceIdentity(doc, input, policy)).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'],
      diagnostic: { ruleId: 'gaming.identity.distinct_primary_heading_scope', evidenceCategory: 'body_heading' } });
  });

  it('keeps unrelated native page furniture outside the primary heading decision', () => {
    const doc = nativeDocument(`<html><title>Elden Ring Samurai build guide</title><body><nav><h1>Diablo IV build guide</h1></nav>
      <article><h1>Samurai Blade Build Guide</h1><p>${prose}</p><aside><h2>Elden Ring Nightreign build guide</h2>
      <p>In Diablo IV, use the invented sorcerer skill.</p></aside><div class="related-content"><h2>Shadow of the Erdtree guide</h2></div></article>
      <script type="application/json">{"game":"Diablo IV"}</script></body></html>`);
    expect(assessGamingClearSourceIdentity(doc, input, policy).status).toBe('verified');
    expect(doc.metadata.headings).not.toContain('Nightreign');
  });

  it('does not invent a primary heading boundary from a clipped metadata prefix', () => {
    const prefix = 'Elden Ring Nightreign Samurai build guide '.padEnd(240, 'x');
    const doc = document(undefined, `${prefix}longer heading continues. ${prose}`, prefix);
    expect(assessGamingClearSourceIdentity(doc, input, policy)).toMatchObject({ status: 'unknown', reasonCodes: ['GAME_IDENTITY_UNVERIFIED'],
      diagnostic: { ruleId: 'gaming.identity.primary_heading_boundary_unverified', evidenceCategory: 'body_heading' } });
  });

  it.each(['Game: Diablo IV.', 'Game: Samurai Blade.', 'In Diablo IV, use the Samurai weapon.',
    'In Elden Ring Nightreign, use the Samurai weapon.'])('preserves contradictory acquired scope %s', conflict => {
    const assessment = assessGamingClearSourceIdentity(document(undefined, `${prose} ${conflict}`), input, policy);
    expect(assessment).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
    expect(assessment.diagnostic.ruleId).toMatch(/^gaming\.identity\./u);
    expect(Object.keys(assessment.diagnostic).sort()).toEqual(['evidenceCategory', 'ruleId']);
    expect(JSON.stringify(assessment.diagnostic)).not.toContain(conflict);
  });

  it.each(['Game: Elden Ring; Game: Diablo IV.', 'Game: Elden Ring. Game: Diablo IV.', 'Game: Elden Ring\nGame: Diablo IV'])
  ('retains contradictory metadata across normalized boundaries: %s', labels => {
    const doc = document(undefined, `${labels}\n${prose}`);
    expect(assessGamingClearSourceIdentity(doc, input, policy)).toMatchObject({ status: 'conflict',
      diagnostic: { ruleId: 'gaming.identity.acquired_game_label_conflict', evidenceCategory: 'prose_metadata' } });
    expect(extractGamingFreshnessMetadata(doc, input).metadataConflict).toBe(true);
  });

  it.each(['', 'x'.repeat(161)])('retains malformed acquired Game declarations as uncertainty', value => {
    const doc = document(undefined, `${prose} Game: ${value}.`);
    expect(extractGamingFreshnessMetadata(doc, input).metadataUnverified).toBe(true);
    expect(assessGamingClearSourceIdentity(doc, input, policy).status).not.toBe('verified');
  });

  it('keeps DLC-only instructions incompatible with an acquired base-game title', () => {
    const doc = document(undefined, `${prose} This blade requires Shadow of the Erdtree.`);
    expect(assessGamingClearSourceIdentity(doc, input, policy)).toMatchObject({ status: 'conflict', reasonCodes: ['EDITION_CONFLICT'] });
  });

  it('checks parser-owned Game fields independently of prose metadata and the requested edition', () => {
    const body = '<article><h1>Elden Ring Samurai guide</h1><table><tr><th>Game</th><th>Weapon</th></tr><tr><td>Diablo IV</td><td>Uchigatana</td></tr></table></article>';
    const evidenceUnits = extractGamingHtmlEvidence({ body, contentType: 'text/html', sourceUrl: url }).units;
    const doc = { ...document(), evidenceUnits, text: `${prose}\n${evidenceUnits.map(unit => unit.text).join('\n')}` };
    expect(assessGamingClearSourceIdentity(doc, { ...input, game: 'Another Game', edition: undefined }, policy)).toMatchObject({
      status: 'conflict', diagnostic: { ruleId: 'gaming.identity.structured_game_conflict', evidenceCategory: 'structured_field' } });
  });
});
