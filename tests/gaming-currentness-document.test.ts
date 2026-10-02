import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { extractGamingCurrentnessDocument } from '../src/services/gamingCurrentnessDocument.js';
import { extractGamingFreshnessMetadata } from '../src/shared/gaming/gamingFreshnessCore.js';
import { combineGamingCurrentnessEvidence } from '../src/shared/gaming/gamingCurrentnessAdapters.js';

const INDEX = 'https://en.bandainamcoent.eu/elden-ring/elden-ring/news';
const ARTICLE = 'https://en.bandainamcoent.eu/elden-ring/news/elden-ring-patch-notes-version-110-hotfix';
const NOW = new Date('2026-09-09T12:00:00Z');
const indexHtml = (href = ARTICLE) => `<main><div class="search__section"><h2 id="patch-notes">Patch Notes (1)</h2>
  <ul class="cards-list"><li><a href="${href}"><h3>Elden Ring – Patch Notes Version 1.10</h3><time>08/09/2026</time></a></li></ul></div></main>`;
const parse = (url: string, body: string, truncated = false) => extractGamingCurrentnessDocument(url, { body, truncated, contentType: 'text/html' });
const articleHtml = (platform = 'Steam') => `<main><p>Targeted Platforms</p><p>${platform}</p><h2>Bug Fixes</h2></main>`;
const metadata = (platform = 'Steam') => extractGamingFreshnessMetadata({ publicUrl: ARTICLE,
  text: `Targeted Platforms ${platform} App Ver. 1.10 Regulation Ver. 1.10.1 Online play requires the player to apply this update. Further updates will be distributed in the future.`,
  metadata: { title: 'Elden Ring – Patch Notes Version 1.10' }, currentnessDocument: parse(ARTICLE, articleHtml(platform)) }, { game: 'Elden Ring' }, NOW);
const current = () => extractGamingFreshnessMetadata({ publicUrl: INDEX, text: 'Latest News on ELDEN RING. Patch Notes (1).',
  metadata: { title: 'ELDEN RING news' }, currentnessDocument: parse(INDEX, indexHtml()) }, { game: 'Elden Ring' }, NOW);

describe('reviewed official DOM currentness references', () => {
  test('the exact current card href is retained and an older same-app article cannot substitute', () => {
    expect(parse(INDEX, indexHtml())).toMatchObject({ status: 'complete', cards: [{ url: ARTICLE }] });
    expect(current().currentnessMetadata?.requiredArticleUrl).toBe(ARTICLE);
    expect(combineGamingCurrentnessEvidence([current(), metadata()], NOW)[0].currentnessMetadata?.status).toBe('verified');
    expect(combineGamingCurrentnessEvidence([current(), { ...metadata(), url: ARTICLE.replace('-hotfix', '') }], NOW)[0].currentnessMetadata?.status).toBe('incomplete');
    expect(parse(INDEX, indexHtml())?.rawContentHash).not.toBe(parse(INDEX, indexHtml(ARTICLE.replace('-hotfix', '')))?.rawContentHash);
  });
  test('unreviewed destinations, missing links, filtered listings and truncated HTML never grant a current reference', () => {
    for (const href of ['https://evil.test/article', '/other-game/news/article', `${ARTICLE}?view=old`, `${ARTICLE}#fragment`])
      expect(parse(INDEX, indexHtml(href))?.status).toBe('incomplete');
    expect(parse(INDEX, indexHtml().replace('href=', 'data-href='))?.status).toBe('incomplete');
    expect(parse(`${INDEX}?page=1`, indexHtml())).toBeUndefined();
    expect(parse(INDEX, indexHtml(), true)?.status).toBe('incomplete');
  });
  test('hidden, duplicated, and unfamiliar card layouts remain incomplete', () => {
    expect(parse(INDEX, indexHtml().replace('<main>', '<main hidden>'))?.status).toBe('incomplete');
    expect(parse(INDEX, indexHtml() + indexHtml())?.status).toBe('incomplete');
    expect(parse(INDEX, indexHtml().replace('class="search__section"', 'class="other"'))?.status).toBe('incomplete');
  });
  test('complete platform paragraph rejects qualified or unsupported rollout tails', () => {
    expect(metadata().platforms).toEqual(['Steam', 'PC']);
    expect(metadata().currentnessMetadata?.releaseActive).toBe(true);
    for (const platform of ['Steam (rollout starts tomorrow)', 'Steam / Unknown Console', 'Steam in EU only']) {
      expect(metadata(platform).platforms).toBeUndefined();
      expect(combineGamingCurrentnessEvidence([current(), metadata(platform)], NOW)[0].currentnessMetadata?.status).toBe('incomplete');
    }
  });
  test('missing or duplicate platform fields are not interpreted as global scope', () => {
    expect(parse(ARTICLE, '<main><p>Steam</p></main>')).toMatchObject({ adapterId: 'patch-article-v1', status: 'incomplete' });
    expect(parse(ARTICLE, articleHtml() + articleHtml())).toMatchObject({ status: 'incomplete' });
  });
});

describe('a second publisher uses the same article index and patch article implementations', () => {
  test('different titles, labels, dates and selectors normalize through registry data alone', async () => {
    const fixture = await import('./fixtures/gaming-currentness/second-publisher.js');
    const parseSecond = (url: string, body: string) => extractGamingCurrentnessDocument(url,
      { body, truncated: false, contentType: 'text/html' }, fixture.SECOND_PUBLISHER_RULES);
    const listing = parseSecond(fixture.SECOND_PUBLISHER_INDEX, fixture.SECOND_PUBLISHER_INDEX_HTML);
    expect(listing).toMatchObject({ adapterId: 'article-index-v1', status: 'complete', cards: [{
      title: 'Clockwork Citadel - Release Notes Revision 2.10', publishedDate: '2026-09-08', url: fixture.SECOND_PUBLISHER_ARTICLE
    }] });
    const secondIndex = extractGamingFreshnessMetadata({ publicUrl: fixture.SECOND_PUBLISHER_INDEX,
      text: 'Recent releases for Clockwork Citadel. Releases (1).', metadata: { title: 'Clockwork Citadel releases | Aurora Forge' },
      currentnessDocument: listing }, { game: fixture.SECOND_PUBLISHER_GAME }, NOW, fixture.SECOND_PUBLISHER_RULES);
    const secondArticle = extractGamingFreshnessMetadata({ publicUrl: fixture.SECOND_PUBLISHER_ARTICLE,
      text: 'Available Platforms Windows Application Version 2.10 Data Version 2.10.3 Update 2.10 is available now for Clockwork Citadel.',
      metadata: { title: 'Clockwork Citadel - Release Notes Revision 2.10 | Aurora Forge' },
      currentnessDocument: parseSecond(fixture.SECOND_PUBLISHER_ARTICLE, fixture.SECOND_PUBLISHER_ARTICLE_HTML)
    }, { game: fixture.SECOND_PUBLISHER_GAME }, NOW, fixture.SECOND_PUBLISHER_RULES);
    expect(secondIndex).toMatchObject({ currentPatch: '2.10', effectiveFrom: '2026-09-08T00:00:00.000Z',
      currentnessMetadata: { adapterId: 'article-index-v1', status: 'incomplete' } });
    expect(secondArticle).toMatchObject({ patch: '2.10', build: '2.10.3', platforms: ['Windows', 'PC'],
      currentnessMetadata: { adapterId: 'patch-article-v1', releaseActive: true } });
    expect(combineGamingCurrentnessEvidence([secondIndex, secondArticle], NOW)[0]).toMatchObject({ currentPatch: '2.10',
      currentBuild: '2.10.3', currentnessMetadata: { status: 'verified', versionSemantics: 'opaque' } });
  });
});


describe('sanitized public Bandai HTML drift fixture (offline)', () => {
  test('preserves current card extraction while companion proof remains required', () => {
    const html = readFileSync(new URL('./fixtures/gaming-currentness/bandai-news-index-2026-10-02.sanitized.html', import.meta.url), 'utf8');
    const listing = parse(INDEX, html);
    expect(listing).toMatchObject({ adapterId: 'article-index-v1', status: 'complete', categoryCount: 27,
      cards: [{ title: 'Elden Ring – Patch Notes Version 1.17', publishedDate: '27/08/2026',
        url: 'https://en.bandainamcoent.eu/elden-ring/news/elden-ring-patch-notes-version-117' },
      { title: 'Elden Ring – Patch Notes Version 1.16.1' }, { title: 'Elden Ring – Patch Notes Version 1.16' }] });
    const evidence = extractGamingFreshnessMetadata({ publicUrl: INDEX, text: 'Latest News on ELDEN RING. Patch Notes (27).',
      metadata: { title: 'ELDEN RING news | Bandai Namco Europe' }, currentnessDocument: listing
    }, { game: 'Elden Ring' }, new Date('2026-10-02T12:00:00Z'));
    expect(evidence).toMatchObject({ currentPatch: '1.17', effectiveFrom: '2026-08-27T00:00:00.000Z',
      currentnessMetadata: { status: 'incomplete', requiredArticlePatch: '1.17',
        requiredArticleUrl: 'https://en.bandainamcoent.eu/elden-ring/news/elden-ring-patch-notes-version-117' } });
    expect(evidence.currentBuild).toBeUndefined();
  });
});
