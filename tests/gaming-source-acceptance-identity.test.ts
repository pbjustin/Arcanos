import { describe, expect, it } from '@jest/globals';
import { assessGamingClearSourceIdentity, gamingClearIntactSourceText } from '../src/shared/gaming/gamingClearSource.js';
import { assessGamingSourcePolicy } from '../src/shared/gaming/gamingFreshnessCore.js';
import { detectGamingDocumentGame } from '../src/shared/gaming/gamingDocumentIngestionCore.js';
import { extractGamingDocumentEvidence } from '../src/services/gamingDocumentEvidence.js';
import { gamingDocumentFetchOptions } from '../src/services/gamingDocumentExtraction.js';
import { extractFetchAndCleanDocument } from '../src/shared/webFetcher.js';
import { assessGamingStructuralUsability } from '../src/shared/gaming/gamingStructuralEvidence.js';
import { detectGamingRegistryAlias, gamingRegistrySourceGameMatchesRequest } from '../src/shared/gaming/gamingGameRegistry.js';
import { gamingSourceAcceptanceCases, gamingSourceAcceptanceHtml, type GamingSourceAcceptanceCase } from './fixtures/gaming-source-acceptance.js';

const url = 'https://synthetic-guides.example/source';
function extract(body: string, transportTruncated = false) {
  const extracted = extractGamingDocumentEvidence({ body, contentType: 'text/html', sourceUrl: url, transportTruncated });
  let metadata: { title?: string; headings?: string } = {};
  const cleaned = extractFetchAndCleanDocument(url, extracted.proseBody, 'text/html', 100_000,
    gamingDocumentFetchOptions(url, { retainFullSelectedText: true, maxSelectedTextChars: 100_000,
      onExtraction: metrics => { metadata = { title: metrics.documentTitle, headings: metrics.headingText }; } }));
  return { publicUrl: url, metadata, evidenceUnits: extracted.units,
    metrics: { truncated: transportTruncated, instructionFiltered: extracted.instructionFiltered,
      rawTextLength: body.length, cleanedTextLength: cleaned.text.length },
    text: [cleaned.text, ...extracted.units.map(unit => unit.text)].join('\n') };
}
function assess(fixture: GamingSourceAcceptanceCase, options: Parameters<typeof gamingSourceAcceptanceHtml>[1] = {}) {
  const document = extract(gamingSourceAcceptanceHtml(fixture, options));
  const input = { game: fixture.game, mode: 'build' as const, prompt: fixture.question };
  return { document, identity: assessGamingClearSourceIdentity(document, input, assessGamingSourcePolicy(url, input.game)) };
}

describe('incident-shaped source identity and extraction (synthetic evidence)', () => {
  it.each(gamingSourceAcceptanceCases)('accepts independent $game body identity with a generic topic heading and unrelated furniture', fixture => {
    const { document, identity } = assess(fixture, { furniture: true });
    expect(identity).toMatchObject({ status: 'verified', reasonCodes: ['ACQUIRED_BODY_SCOPE_IDENTITY'],
      diagnostic: { ruleId: 'gaming.identity.acquired_anchors_verified' } });
    expect(document.metadata.headings).toBe(fixture.genericTitle);
    expect(document.text).not.toContain(fixture.unrelatedGame);
    expect(document.evidenceUnits.every(unit => unit.integrity.status === 'complete')).toBe(true);
  });

  it.each(['Heavy Gunner build guide', 'Beginner Power Armor Heavy Gunner guide', 'Heavy Weapons guide'])
  ('does not invent an acquired game named %s', title => {
    const fixture = gamingSourceAcceptanceCases[1];
    expect(detectGamingDocumentGame({ canonicalUrl: '', pageTitle: title }).game).toBeUndefined();
    expect(assess(fixture, { title }).identity.status).toBe('verified');
    expect(assess(fixture, { title, prose: fixture.prose.replace('In Fallout 76, ', '') }).identity)
      .toMatchObject({ status: 'unknown', diagnostic: { ruleId: 'gaming.identity.independent_anchor_required' } });
  });

  it.each(gamingSourceAcceptanceCases)('does not turn generic $game topics or complete records into independent game proof', fixture => {
    const { document, identity } = assess(fixture, { prose: fixture.prose.replace(`In ${fixture.game}, `, ''),
      records: Array.from({ length: 25 }, (_, index) => fixture.record.replace('Weapon: ', `Weapon: synthetic record ${index} `)).join('') });
    expect(document.evidenceUnits).toHaveLength(25);
    expect(document.evidenceUnits.every(unit => unit.integrity.status === 'complete')).toBe(true);
    expect(identity).toMatchObject({ status: 'unknown', reasonCodes: ['GAME_IDENTITY_UNVERIFIED'],
      diagnostic: { ruleId: 'gaming.identity.independent_anchor_required' } });
  });

  it.each(gamingSourceAcceptanceCases)('requires affirmative acquired $game scope despite comparison references', fixture => {
    const prose = fixture.prose.replace(`In ${fixture.game}, `, `Unlike in ${fixture.game}, `);
    expect(assess(fixture, { prose }).identity).toMatchObject({ status: 'unknown',
      diagnostic: { ruleId: 'gaming.identity.independent_anchor_required' } });
  });

  it.each(['Heavy Weapons', 'Heavy Gunner', 'Power Armor'])('does not let topic vocabulary erase an explicit game named %s', game => {
    const fixture = gamingSourceAcceptanceCases[1];
    expect(assess(fixture, { title: fixture.title, prose: `${fixture.prose} In the game ${game}, use another weapon.` }).identity)
      .toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'],
        diagnostic: { ruleId: 'gaming.identity.affirmative_body_scope_conflict' } });
  });

  it.each(gamingSourceAcceptanceCases)('does not let a generic instruction heading override independently verified $game', fixture => {
    expect(assess(fixture, { title: fixture.title, prose: `${fixture.prose} ${fixture.genericTitle} guide: use available equipment.` }).identity)
      .toMatchObject({ status: 'verified', diagnostic: { ruleId: 'gaming.identity.acquired_anchors_verified' } });
  });

  it.each(['Fallout 4', 'Fallout: New Vegas', 'Fallout 3'])('retains an affirmative %s body contradiction despite a Fallout 76 title', wrongGame => {
    const fixture = gamingSourceAcceptanceCases[1];
    expect(assess(fixture, { title: fixture.title, prose: `${fixture.prose} In ${wrongGame}, use an unrelated weapon.` }).identity)
      .toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'],
        diagnostic: { ruleId: 'gaming.identity.affirmative_body_scope_conflict' } });
    expect(gamingRegistrySourceGameMatchesRequest(wrongGame, 'Fallout 76')).toBe(false);
    expect(detectGamingRegistryAlias(`${wrongGame} Heavy Gunner guide`, true)?.name).toBe(wrongGame);
  });

  it.each(gamingSourceAcceptanceCases)('keeps an explicit wrong-game declaration authoritative for $game', fixture => {
    expect(assess(fixture, { title: fixture.title, prose: `${fixture.prose} Game: ${fixture.unrelatedGame}.` }).identity)
      .toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'],
        diagnostic: { ruleId: 'gaming.identity.acquired_game_label_conflict' } });
  });

  it.each([
    ['In Elden Ring Nightreign, use this weapon.', 'GAME_MISMATCH', 'gaming.identity.distinct_body_scope'],
    ['In Elden Ring Shadow of the Erdtree, use this weapon.', 'EDITION_CONFLICT', 'gaming.identity.edition_scope_conflict'],
    ['Fallout 4 build: use this weapon.', 'GAME_MISMATCH', 'gaming.identity.instruction_heading_conflict']
  ])('preserves the exact conflict rule for %s', (prose, reason, ruleId) => {
    const fixture = gamingSourceAcceptanceCases[0];
    expect(assess(fixture, { title: fixture.title, prose: `${fixture.prose} ${prose}` }).identity)
      .toMatchObject({ status: 'conflict', reasonCodes: [reason], diagnostic: { ruleId } });
  });

  it.each(gamingSourceAcceptanceCases)('preserves complete, partial, ambiguous and truncated $game units without promotion', fixture => {
    const records = fixture.record
      + '<table><tr><th>Weapon</th><th>Skill</th></tr><tr><td>Partialblade</td><td></td></tr></table>'
      + '<ul><li>Weapon: Ambiguousblade; Weapon: Conflictingblade; Skill: Unknown</li></ul>'
      + `<ul><li>Weapon: Truncatedblade; Skill: ${'x'.repeat(1_025)}</li></ul>`;
    const document = extract(gamingSourceAcceptanceHtml(fixture, { title: fixture.title, records }));
    expect(document.evidenceUnits.map(unit => unit.integrity.status).sort()).toEqual(['ambiguous', 'complete', 'partial', 'partial']);
    expect(document.evidenceUnits.find(unit => unit.text.includes('Truncatedblade'))?.integrity.reasons).toContain('content_truncated');
    for (const unit of document.evidenceUnits.filter(unit => unit.integrity.status !== 'complete')) {
      expect(assessGamingStructuralUsability({ units: [unit] }).hasIntactUsableUnit).toBe(false);
    }
    const intact = gamingClearIntactSourceText(document);
    expect(intact).toContain(fixture.prose);
    expect(intact).not.toMatch(/Partialblade|Ambiguousblade|Conflictingblade|Truncatedblade/u);
    const transportCut = extract(`<article><h1>${fixture.title}</h1><ul><li>Weapon: Cutblade; Skill:`, true);
    expect(transportCut.evidenceUnits.length).toBeGreaterThan(0);
    expect(transportCut.evidenceUnits.every(unit => unit.integrity.status !== 'complete')).toBe(true);
  });

  it('inspects late contradictions after a 70k-character guide without importing sidebar references', () => {
    const fixture = gamingSourceAcceptanceCases[0];
    const filler = 'Practice the starting weapon and preserve stamina for the next dodge. '.repeat(1_040);
    const { document, identity } = assess(fixture, { title: fixture.title, furniture: true,
      prose: `${fixture.prose} ${filler} In Elden Ring Nightreign, use an unrelated weapon.`, records: '' });
    expect(document.text.length).toBeGreaterThan(70_000);
    expect(identity).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'],
      diagnostic: { ruleId: 'gaming.identity.distinct_body_scope' } });
  });
});
