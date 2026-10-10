import { describe, expect, it } from '@jest/globals';
import { assessGamingClearSourceIdentity } from '../src/shared/gaming/gamingClearSource.js';
import { assessGamingSourcePolicy } from '../src/shared/gaming/gamingFreshnessCore.js';
import { extractGamingDocumentEvidence } from '../src/services/gamingDocumentEvidence.js';
import { gamingDocumentFetchOptions } from '../src/services/gamingDocumentExtraction.js';
import { extractFetchAndCleanDocument } from '../src/shared/webFetcher.js';

const url = 'https://publisher-shaped.example/articles/samurai';
const input = { game: 'Elden Ring', edition: 'base-game', mode: 'build' as const,
  prompt: 'Recommend an early-game Samurai build using Uchigatana.' };
const policy = assessGamingSourcePolicy(url, input.game);
const prose = 'In Elden Ring, the Samurai begins with Uchigatana. Raise Vigor and upgrade Uchigatana. Preserve stamina for dodging after attacks.';

function nativeDocument(preface: string, heading = 'Elden Ring Nightreign Samurai build guide') {
  const body = '<html><title>Elden Ring Samurai build guide</title><body><article>'
    + `<p>${preface}</p><h1>${heading}</h1><p>Game: Elden Ring.</p><p>Edition: base-game.</p><p>${prose}</p></article></body></html>`;
  const extracted = extractGamingDocumentEvidence({ body, contentType: 'text/html', sourceUrl: url });
  let metadata: { title?: string; headings?: string } = {};
  const cleaned = extractFetchAndCleanDocument(url, extracted.proseBody, 'text/html', 100_000,
    gamingDocumentFetchOptions(url, { retainFullSelectedText: true, maxSelectedTextChars: 100_000,
      onExtraction: metrics => { metadata = { title: metrics.documentTitle, headings: metrics.headingText }; } }));
  return { publicUrl: url, metadata, evidenceUnits: extracted.units,
    text: [cleaned.text, ...extracted.units.map(unit => unit.text)].join('\n') };
}

describe('primary acquired heading after a publisher preface', () => {
  it('retains a conflicting primary heading after an acquired update date and byline', () => {
    const doc = nativeDocument('Updated October 9, 2026 by Gaming Editor');
    expect(doc.text.startsWith('Updated October 9, 2026 by Gaming Editor')).toBe(true);
    expect(doc.metadata.headings).toBe('Elden Ring Nightreign Samurai build guide');
    expect(assessGamingClearSourceIdentity(doc, input, policy)).toMatchObject({ status: 'conflict',
      reasonCodes: ['GAME_MISMATCH'], diagnostic: { evidenceCategory: 'body_heading' } });
  });

  it.each(['By Gaming Editor', 'Written by Gaming Editor', 'Published October 9, 2026',
    'Last updated 2026-10-09', 'By Gaming Editor. Updated October 9, 2026.'])
  ('retains a conflicting primary heading after the closed publisher preface %s', preface => {
    expect(assessGamingClearSourceIdentity(nativeDocument(preface), input, policy)).toMatchObject({
      status: 'conflict', reasonCodes: ['GAME_MISMATCH'],
      diagnostic: { ruleId: 'gaming.identity.distinct_primary_heading_scope', evidenceCategory: 'body_heading' }
    });
  });

  it('preserves a primary expansion conflict after publisher metadata', () => {
    expect(assessGamingClearSourceIdentity(nativeDocument('By Gaming Editor',
      'Elden Ring Shadow of the Erdtree Samurai build guide'), input, policy))
      .toMatchObject({ status: 'conflict', reasonCodes: ['EDITION_CONFLICT'] });
  });

  it('keeps a matching primary heading applicable after publisher metadata', () => {
    expect(assessGamingClearSourceIdentity(nativeDocument('Updated October 9, 2026 by Gaming Editor',
      'Elden Ring Samurai build guide'), input, policy).status).toBe('verified');
  });

  it.each(['Unlike', 'Comparison with', 'Recommended:', 'Related:'])
  ('keeps a qualified %s heading separate from an affirmative subject after a byline', qualifier => {
    expect(assessGamingClearSourceIdentity(nativeDocument('By Gaming Editor',
      `${qualifier} Elden Ring Nightreign Samurai build guide`), input, policy).status).toBe('verified');
  });

  it.each(['Unlike in', 'Recommended:', 'Updated October 9, 2026 by Gaming Editor Recommended:'])
  ('does not erase arbitrary prose before a pooled heading: %s', preface => {
    const heading = 'Elden Ring Nightreign Samurai build guide';
    const doc = { publicUrl: url, metadata: { title: 'Elden Ring Samurai build guide', headings: heading },
      text: `${preface} ${heading}. ${prose}` };
    expect(assessGamingClearSourceIdentity(doc, input, policy).status).toBe('verified');
  });

  it('does not grant positive identity to a referenced pooled heading behind publisher-shaped text', () => {
    const heading = 'Elden Ring Samurai build guide';
    const doc = { publicUrl: url, metadata: { title: 'Samurai Blade Build Guide', headings: heading },
      text: `Updated October 9, 2026 by Gaming Editor Recommended: ${heading}. Unlike in Elden Ring, preserve stamina for dodging.` };
    expect(assessGamingClearSourceIdentity(doc, input, policy)).toMatchObject({ status: 'unknown',
      reasonCodes: ['GAME_IDENTITY_UNVERIFIED'] });
  });

  it('retains uncertainty when a publisher preface precedes a clipped heading', () => {
    const heading = 'Elden Ring Nightreign Samurai build guide '.padEnd(240, 'x');
    const doc = { publicUrl: url, metadata: { title: 'Elden Ring Samurai build guide', headings: heading },
      text: `By Gaming Editor ${heading}longer heading continues. ${prose}` };
    expect(assessGamingClearSourceIdentity(doc, input, policy)).toMatchObject({ status: 'unknown',
      diagnostic: { ruleId: 'gaming.identity.primary_heading_boundary_unverified', evidenceCategory: 'body_heading' } });
  });

  it('does not search beyond the bounded publisher preface for a positive heading anchor', () => {
    const heading = 'Elden Ring Samurai build guide';
    const doc = { publicUrl: url, metadata: { title: 'Samurai Blade Build Guide', headings: heading },
      text: `By ${'a'.repeat(160)} ${heading}. Unlike in Elden Ring, preserve stamina for dodging.` };
    expect(assessGamingClearSourceIdentity(doc, input, policy).status).toBe('unknown');
  });

  it('requires an acquired boundary between a publisher name and the heading', () => {
    const heading = 'Elden Ring Samurai build guide';
    const doc = { publicUrl: url, metadata: { title: 'Samurai Blade Build Guide', headings: heading },
      text: `By Gaming Editor${heading}. Unlike in Elden Ring, preserve stamina for dodging.` };
    expect(assessGamingClearSourceIdentity(doc, input, policy).status).toBe('unknown');
  });
});
