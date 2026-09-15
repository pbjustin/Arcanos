import { describe, expect, test } from '@jest/globals';
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
    expect(parse(ARTICLE, '<main><p>Steam</p></main>')).toMatchObject({ adapterId: 'bandai-patch-article-v1', status: 'incomplete' });
    expect(parse(ARTICLE, articleHtml() + articleHtml())).toMatchObject({ status: 'incomplete' });
  });
});
