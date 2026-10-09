import { describe, expect, it } from '@jest/globals';
import { extractGamingDocumentEvidence } from '../src/services/gamingDocumentEvidence.js';
import { gamingDocumentFetchOptions } from '../src/services/gamingDocumentExtraction.js';
import { extractFetchAndCleanDocument, type FetchAndCleanExtractionMetrics } from '../src/shared/webFetcher.js';
import { assessGamingClearSourceIdentity } from '../src/shared/gaming/gamingClearSource.js';
import { assessGamingSourcePolicy } from '../src/shared/gaming/gamingFreshnessCore.js';

const url = 'https://publisher.example/elden-ring-samurai';
const input = { game: 'Elden Ring', edition: 'base-game', mode: 'build' as const,
  prompt: 'Recommend an early-game Samurai Uchigatana build through level 50.' };
const paragraphs = Array.from({ length: 12 }, (_, index) => `<p>In Elden Ring base-game, Samurai route ${index} recommends upgrading Uchigatana with Smithing Stones. Raise Vigor for survival. Preserve stamina for dodging after attacks. Practice Unsheathe against safe early enemies.</p>`).join('');
const body = `<div class="article-content"><h2>Samurai route</h2>${paragraphs}</div>`;

function acquire(html: string, title = 'Elden Ring Samurai build guide', maxChars = 100_000) {
  const extracted = extractGamingDocumentEvidence({ body: `<html><title>${title}</title><body>${html}</body></html>`,
    sourceUrl: url, contentType: 'text/html' });
  let metrics: FetchAndCleanExtractionMetrics | undefined;
  const cleaned = extractFetchAndCleanDocument(url, extracted.proseBody, 'text/html', maxChars,
    gamingDocumentFetchOptions(url, { retainFullSelectedText: true, onExtraction: value => { metrics = value; } }));
  const metadata = { title: metrics?.documentTitle, headings: metrics?.headingText };
  const document = { publicUrl: url, metadata, evidenceUnits: extracted.units,
    text: [cleaned.text, ...extracted.units.map(unit => unit.text)].join('\n') };
  return { document, metrics, cleaned,
    identity: assessGamingClearSourceIdentity(document, input, assessGamingSourcePolicy(url, input.game)) };
}

describe('acquired primary headings outside selected Gaming article prose', () => {
  it.each([
    ['article', '<h1>Elden Ring Nightreign Samurai build guide</h1>', 'GAME_MISMATCH'],
    ['main', '<h1>Elden Ring Nightreign Samurai build guide</h1>', 'GAME_MISMATCH'],
    ['article', '<h1>Elden Ring Shadow of the Erdtree Samurai build guide</h1>', 'EDITION_CONFLICT'],
    ['article', '<header><h1>Elden Ring Nightreign Samurai build guide</h1><p>By Synthetic Author</p></header>', 'GAME_MISMATCH']
  ])('rejects the genuine %s subject behind a matching SEO title: %s', (scope, heading, reason) => {
    const result = acquire(`<${scope}>${heading}${body}</${scope}>`);
    expect(result.metrics?.selectedContainer).toBe('.article-content');
    expect(result.identity).toMatchObject({ status: 'conflict', reasonCodes: [reason] });
    expect(result.document.metadata.headings).toMatch(/^Elden Ring (?:Nightreign|Shadow of the Erdtree)/u);
    expect(result.cleaned.text).toMatch(/^Elden Ring (?:Nightreign|Shadow of the Erdtree)/u);
    expect(result.cleaned.text).not.toContain('Synthetic Author');
  });

  it.each(['<h1>Elden Ring Samurai build guide</h1>', '<header><h1>Elden Ring Samurai build guide</h1><p>By Synthetic Author</p></header>'])
    ('retains the matching primary subject %s without publisher furniture', heading => {
      const result = acquire(`<article>${heading}${body}</article>`);
      expect(result.identity.status).toBe('verified');
      expect(result.cleaned.text).toMatch(/^Elden Ring Samurai build guide Samurai route/u);
      expect(result.document.metadata.headings).toBe('Elden Ring Samurai build guide | Samurai route');
      expect(result.cleaned.text).not.toContain('Synthetic Author');
    });

  it('keeps a generic acquired primary heading unverified without an affirmative game scope', () => {
    const generic = paragraphs.replaceAll('In Elden Ring base-game, ', 'For the starting class, ');
    const result = acquire(`<article><h1>Samurai build guide</h1><div class="article-content"><h2>Dexterity route</h2>${generic}</div></article>`, 'Samurai build guide');
    expect(result.identity).toMatchObject({ status: 'unknown', reasonCodes: ['GAME_IDENTITY_UNVERIFIED'] });
    expect(result.cleaned.text).toMatch(/^Samurai build guide Dexterity route/u);
  });

  it.each(['nav', 'aside', 'div class="sidebar"', 'div class="recommended-links"'])
    ('does not borrow an unrelated primary heading from %s furniture', wrapper => {
      const tag = wrapper.split(' ')[0];
      const result = acquire(`<article><h1>Elden Ring Samurai build guide</h1><${wrapper}><h1>Elden Ring Nightreign Samurai build guide</h1></${tag}>${body}</article>`);
      expect(result.identity.status).toBe('verified');
      expect(result.document.metadata.headings).not.toContain('Nightreign');
      expect(result.cleaned.text).not.toContain('Nightreign');
    });

  it('does not borrow sibling article headings or a site banner header', () => {
    const result = acquire(`<main><header role="banner"><h1>Elden Ring Nightreign Samurai build guide</h1></header><article><h1>Elden Ring Samurai build guide</h1>${body}</article><article><h1>Elden Ring Nightreign unrelated review</h1><p>Read the unrelated review.</p></article></main>`);
    expect(result.identity.status).toBe('verified');
    expect(result.document.metadata.headings).toBe('Elden Ring Samurai build guide | Samurai route');
    expect(result.cleaned.text).not.toContain('Nightreign');
  });

  it.each(['Elden Ring Nightreign Samurai build guide', 'Recommended: Elden Ring Nightreign Samurai build guide'])
    ('does not promote a later direct-scope heading %s to the primary subject', heading => {
      const result = acquire(`<article>${body}<h1>${heading}</h1></article>`);
      expect(result.identity.status).toBe('verified');
      expect(result.document.metadata.headings).toBe('Samurai route');
      expect(result.cleaned.text).toMatch(/^Samurai route/u);
      expect(result.cleaned.text).not.toContain('Nightreign');
    });

  it('honors caller-owned heading removal rather than restoring a denied subject', () => {
    let metrics: FetchAndCleanExtractionMetrics | undefined;
    const result = extractFetchAndCleanDocument(url, `<article><h1>Elden Ring Nightreign Samurai build guide</h1>${body}</article>`,
      'text/html', 100_000, gamingDocumentFetchOptions(url, { retainFullSelectedText: true, removeSelectors: ['h1'],
        onExtraction: value => { metrics = value; } }));
    expect(metrics?.headingText).toBe('Samurai route');
    expect(result.text).toMatch(/^Samurai route/u);
    expect(result.text).not.toContain('Nightreign');
  });

  it('prefers the nearest article primary heading over an enclosing main subject', () => {
    const result = acquire(`<main><h1>Elden Ring Nightreign community hub</h1><article><h1>Elden Ring Samurai build guide</h1>${body}</article></main>`);
    expect(result.identity.status).toBe('verified');
    expect(result.document.metadata.headings).toBe('Elden Ring Samurai build guide | Samurai route');
    expect(result.cleaned.text).not.toContain('Nightreign');
  });

  it('retains a nested article contradiction despite an enclosing matching main heading', () => {
    const result = acquire(`<main><h1>Elden Ring Samurai build guide</h1><article><h1>Elden Ring Nightreign Samurai build guide</h1>${body}</article></main>`);
    expect(result.identity).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
    expect(result.document.metadata.headings).toMatch(/^Elden Ring Nightreign/u);
  });

  it('preserves the existing 240-character metadata fence for an incomplete heading boundary', () => {
    const heading = `Elden Ring Samurai build guide ${'qualification '.repeat(30)}`;
    const result = acquire(`<article><h1>${heading}</h1>${body}</article>`);
    expect(result.document.metadata.headings).toHaveLength(240);
    expect(result.cleaned.text.startsWith(result.document.metadata.headings!)).toBe(true);
    expect(result.identity).toMatchObject({ status: 'unknown', reasonCodes: ['GAME_IDENTITY_UNVERIFIED'],
      diagnostic: { ruleId: 'gaming.identity.primary_heading_boundary_unverified' } });
  });

  it('fails extraction when an acquired outside primary heading is unclosed', () => {
    expect(() => acquire(`<article><h1>Elden Ring Nightreign Samurai build guide${body}</article>`)).toThrow();
  });

  it('keeps the total selected-text limit when preserving an outside primary heading', () => {
    const result = acquire(`<article><h1>Elden Ring Samurai build guide</h1>${body}</article>`, undefined, 80);
    expect(result.cleaned.text).toHaveLength(80);
    expect(result.cleaned.text).toMatch(/^Elden Ring Samurai build guide/u);
    expect(result.metrics!.cleanedTextLength).toBeGreaterThan(result.cleaned.text.length);
  });

  it('keeps the existing scored-text ceiling when full selected text is not requested', () => {
    const longBody = `<div class="article-content"><h2>Samurai route</h2>${paragraphs.repeat(12)}</div>`;
    let metrics: FetchAndCleanExtractionMetrics | undefined;
    const result = extractFetchAndCleanDocument(url, `<article><h1>Elden Ring Samurai build guide</h1>${longBody}</article>`,
      'text/html', 100_000, gamingDocumentFetchOptions(url, { onExtraction: value => { metrics = value; } }));
    expect(result.text).toHaveLength(24_000);
    expect(result.text).toMatch(/^Elden Ring Samurai build guide/u);
    expect(metrics?.cleanedTextLength).toBe(24_000);
  });

  it('does not opt generic fetch consumers into Gaming ancestor-heading projection', () => {
    const html = `<article><h1>Elden Ring Nightreign Samurai build guide</h1>${body}</article>`;
    let metrics: FetchAndCleanExtractionMetrics | undefined;
    const result = extractFetchAndCleanDocument(url, html, 'text/html', 100_000, {
      retainFullSelectedText: true, preferredContentSelectors: ['.article-content'],
      onExtraction: value => { metrics = value; }
    });
    expect(metrics?.headingText).toBe('Samurai route');
    expect(result.text).toMatch(/^Samurai route/u);
    expect(result.text).not.toContain('Nightreign');
  });
});
