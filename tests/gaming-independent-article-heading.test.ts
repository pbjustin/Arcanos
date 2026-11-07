import { describe, expect, it } from '@jest/globals';
import { extractGamingDocumentEvidence } from '../src/services/gamingDocumentEvidence.js';
import { gamingDocumentFetchOptions } from '../src/services/gamingDocumentExtraction.js';
import { extractFetchAndCleanDocument, type FetchAndCleanExtractionMetrics } from '../src/shared/webFetcher.js';
import { assessGamingClearSourceIdentity } from '../src/shared/gaming/gamingClearSource.js';
import { assessGamingSourcePolicy } from '../src/shared/gaming/gamingFreshnessCore.js';

const url = 'https://publisher.example/synthetic-samurai-guide';
const input = { game: 'Elden Ring', edition: 'base-game', mode: 'build' as const,
  prompt: 'Explain the synthetic Samurai practice route.' };
const title = 'Elden Ring Samurai practice guide';
const foreignHeading = 'Dark Souls III practice guide';
// Publisher-shaped markup with invented instructions; these are not game facts.
const prose = Array.from({ length: 6 }, (_, index) => `<p>In Elden Ring base-game, synthetic Samurai checkpoint ${index} `
  + 'uses a practice shield before crossing the training bridge. Inspect the three blue lamps before leaving the practice area. '
  + 'Keep the shield equipped and wait for every lamp to remain lit before proceeding.</p>').join('');
const content = (heading = '<h2>Elden Ring Samurai practice guide</h2>', paragraphs = prose) =>
  `<div class="page-content">${heading}${paragraphs}</div>`;

/** Exercise accepted HTML, Gaming prose selection and the real identity gate. */
function acquire(html: string, documentTitle = title) {
  const original = `<html><title>${documentTitle}</title><body>${html}</body></html>`;
  const structure = extractGamingDocumentEvidence({ body: original, sourceUrl: url, contentType: 'text/html' });
  let metrics: FetchAndCleanExtractionMetrics | undefined;
  const cleaned = extractFetchAndCleanDocument(url, structure.proseBody, 'text/html', 100_000,
    gamingDocumentFetchOptions(url, { retainFullSelectedText: true, onExtraction: value => { metrics = value; } }));
  const document = { publicUrl: url, text: [cleaned.text, ...structure.units.map(unit => unit.text)].join('\n'),
    evidenceUnits: structure.units, metadata: { title: metrics?.documentTitle, headings: metrics?.headingText } };
  return { cleaned, metrics, structure, identity: assessGamingClearSourceIdentity(document, input, assessGamingSourcePolicy(url, input.game)) };
}

describe('independent semantic article heading boundaries', () => {
  it.each(['main', 'article', 'div class="entry-content"'])(
    'does not inherit an enclosing %s H1 across an article with its own H2', enclosing => {
      const tag = enclosing.split(' ')[0];
      const result = acquire(`<${enclosing}><h1>${foreignHeading}</h1><article>${content()}</article></${tag}>`);
      expect(result.metrics?.selectedContainer).toBe('.page-content');
      expect(result.identity).toMatchObject({ status: 'verified', gameIdentityVerified: true });
      expect(result.cleaned.text).toMatch(/^Elden Ring Samurai practice guide/u);
      expect(result.cleaned.text).not.toContain(foreignHeading);
      expect(result.metrics?.headingText).toBe(title);
    });

  it('keeps the article boundary when its own H2 is outside the selected class body', () => {
    const result = acquire(`<main><h1>${foreignHeading}</h1><article><h2>${title}</h2>${content('')}</article></main>`);
    expect(result.metrics?.selectedContainer).toBe('.page-content');
    expect(result.cleaned.text).not.toContain(foreignHeading);
    expect(result.identity).toMatchObject({ status: 'verified', gameIdentityVerified: true });
  });

  it('does not borrow an outer subject when an independent article has no heading', () => {
    const result = acquire(`<main><h1>${foreignHeading}</h1><article>${content('')}</article></main>`);
    expect(result.metrics?.selectedContainer).toBe('.page-content');
    expect(result.cleaned.text).not.toContain(foreignHeading);
    expect(result.identity).toMatchObject({ status: 'verified', gameIdentityVerified: true });
  });

  it.each(['main', 'div role="main"'])('also stops at an independent no-H1 %s semantic boundary', semantic => {
    const tag = semantic.split(' ')[0];
    const result = acquire(`<div class="entry-content"><h1>${foreignHeading}</h1><${semantic}>${content()}</${tag}></div>`);
    expect(result.metrics?.selectedContainer).toBe('.page-content');
    expect(result.cleaned.text).not.toContain(foreignHeading);
    expect(result.identity).toMatchObject({ status: 'verified', gameIdentityVerified: true });
  });

  it('stops at the inner article when both enclosing article and main have unrelated headings', () => {
    const result = acquire(`<main><h1>Elden Ring Nightreign practice hub</h1><article><h1>${foreignHeading}</h1>`
      + `<article>${content()}</article></article></main>`);
    expect(result.cleaned.text).not.toMatch(/Dark Souls|Nightreign/u);
    expect(result.identity).toMatchObject({ status: 'verified', gameIdentityVerified: true });
  });

  it('keeps independent article ownership through ordinary inner wrappers', () => {
    const result = acquire(`<main><h1>${foreignHeading}</h1><article><section><div>${content()}</div></section></article></main>`);
    expect(result.metrics?.selectedContainer).toBe('.page-content');
    expect(result.cleaned.text).not.toContain(foreignHeading);
    expect(result.identity).toMatchObject({ status: 'verified', gameIdentityVerified: true });
  });

  it('does not cross an independent article when the selected page container surrounds it', () => {
    const result = acquire(`<main><h1>${foreignHeading}</h1><div class="page-content"><article><h2>${title}</h2>`
      + `${prose}</article></div></main>`);
    expect(result.metrics?.selectedContainer).toBe('.page-content');
    expect(result.cleaned.text).not.toContain(foreignHeading);
    expect(result.identity).toMatchObject({ status: 'verified', gameIdentityVerified: true });
  });

  it('preserves a surrounding page subject when the selected container also has prose outside its article', () => {
    const result = acquire(`<main><h1>${foreignHeading}</h1><div class="page-content">`
      + '<p>This page describes a separate training route before the embedded article.</p>'
      + `<article><h2>${title}</h2>${prose}</article></div></main>`);
    expect(result.cleaned.text).toMatch(/^Dark Souls III practice guide/u);
    expect(result.identity).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it('does not treat an incidental nested article as ownership of the whole selected page', () => {
    const result = acquire(`<main><h1>${foreignHeading}</h1><div class="page-content">${prose}`
      + `<article><h2>${title}</h2><p>A separate editorial card.</p></article></div></main>`);
    expect(result.cleaned.text).toMatch(/^Dark Souls III practice guide/u);
    expect(result.identity).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it.each(['blockquote', 'div role="menu"'])(
    'does not use a semantic article inside %s as an independent page boundary', wrapper => {
      const tag = wrapper.split(' ')[0];
      const result = acquire(`<main><h1>${foreignHeading}</h1><div class="page-content"><${wrapper}>`
        + `<article><h2>${title}</h2>${prose}</article></${tag}></div></main>`);
      expect(result.cleaned.text).toMatch(/^Dark Souls III practice guide/u);
      expect(result.identity.gameIdentityVerified).toBe(false);
    });

  it.each(['blockquote', 'div role="menu"'])(
    'does not stop at a denied %s article when the selected class body is inside it', wrapper => {
      const tag = wrapper.split(' ')[0];
      const result = acquire(`<main><h1>${foreignHeading}</h1><${wrapper}><article>${content()}</article></${tag}></main>`);
      expect(result.identity.gameIdentityVerified).toBe(false);
      expect(result.cleaned.text).toMatch(/^Dark Souls III practice guide/u);
      expect(result.metrics?.headingText).toContain(foreignHeading);
    });

  it.each(['article', 'main', 'div role="main"'])(
    'retains a genuine %s parent subject for a dependent class body', parent => {
      const tag = parent.split(' ')[0];
      const result = acquire(`<${parent}><h1>${foreignHeading}</h1>${content()}</${tag}>`);
      expect(result.cleaned.text).toMatch(/^Dark Souls III practice guide/u);
      expect(result.metrics?.headingText).toContain(foreignHeading);
      expect(result.identity).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
    });

  it.each(['entry-content', 'article-body'])('retains the global H1 of a class-only .%s parent', className => {
    const result = acquire(`<div class="${className}"><h1>${foreignHeading}</h1>${content()}</div>`);
    expect(result.cleaned.text).toMatch(/^Dark Souls III practice guide/u);
    expect(result.identity).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it('keeps a class-only body heading from hiding its enclosing article subject', () => {
    const result = acquire(`<article><header><h1>${foreignHeading}</h1></header>${content(`<h1>${title}</h1>`)}</article>`);
    expect(result.cleaned.text).toMatch(/^Dark Souls III practice guide/u);
    expect(result.identity).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it('retains an independently acquired foreign H2 inside the selected article', () => {
    const result = acquire(`<main><h1>${title}</h1><article>${content(`<h2>${foreignHeading}</h2>`)}</article></main>`);
    expect(result.cleaned.text).toMatch(/^Dark Souls III practice guide/u);
    expect(result.metrics?.headingText).toBe(foreignHeading);
    expect(result.identity).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it('does not use a matching outer heading to prove an article with no acquired game declaration', () => {
    const generic = prose.replaceAll('In Elden Ring base-game, ', 'For this exercise, ');
    const result = acquire(`<main><h1>${title}</h1><article>${content('<h2>Practice route</h2>', generic)}</article></main>`, 'Practice guide');
    expect(result.cleaned.text).not.toContain(title);
    expect(result.identity.gameIdentityVerified).toBe(false);
  });

  it.each(['nav', 'aside', 'div class="sidebar"', 'div class="recommended-links"'])(
    'does not restore headings or prose inside %s furniture', furniture => {
      const tag = furniture.split(' ')[0];
      const result = acquire(`<main><${furniture}><article><h1>${foreignHeading}</h1></article></${tag}>`
        + `<article>${content()}</article></main>`);
      expect(result.cleaned.text).not.toContain(foreignHeading);
      expect(result.identity).toMatchObject({ status: 'verified', gameIdentityVerified: true });
    });

  it('does not hide an independent body contradiction while removing an unrelated outer heading', () => {
    const result = acquire(`<main><h1>${foreignHeading}</h1><article>${content('', prose
      + '<p>In the game Dark Souls III, equip the practice shield.</p>')}</article></main>`);
    expect(result.identity).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });
});
