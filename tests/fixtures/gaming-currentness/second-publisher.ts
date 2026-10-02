import { validateGamingCurrentnessSourceRegistry } from '../../../src/shared/gaming/gamingCurrentnessRegistry.js';

/** Synthetic second publisher: different selectors, date format, titles and field labels; no production authority is added. */
export const SECOND_PUBLISHER_GAME = 'Clockwork Citadel';
export const SECOND_PUBLISHER_INDEX = 'https://auroraforge.test/releases';
export const SECOND_PUBLISHER_ARTICLE = 'https://auroraforge.test/releases/revision-210';
export const SECOND_PUBLISHER_RULES = validateGamingCurrentnessSourceRegistry({
  version: 'gaming-currentness-sources/v1', rules: [
    { id: 'aurora-current', game: SECOND_PUBLISHER_GAME, hosts: ['auroraforge.test'], path: '/releases', pathMatch: 'exact',
      category: 'official_updates', authority: 'official', currentness: 'current_index', durableAllowed: false, autoStoreAllowed: false,
      metadataAdapter: 'article-index-v1', currentnessArticleRuleIds: ['aurora-release'], metadataAdapterConfig: {
        kind: 'article-index', pageTitle: 'Clockwork Citadel releases', pageText: 'Recent releases for Clockwork Citadel',
        releaseTitle: { prefix: 'Clockwork Citadel', label: 'Release Notes', versionLabel: 'Revision' }, dateFormat: 'year-month-day',
        versionSemantics: 'opaque', headingSelector: 'main h2#releases', headingLabel: 'Releases', sectionSelector: '.releases',
        cardsSelector: 'ol.release-cards > li', anchorSelector: 'a[href]', titleSelector: 'h4', dateSelector: 'span.date', pageSize: 2
      } },
    { id: 'aurora-release', game: SECOND_PUBLISHER_GAME, hosts: ['auroraforge.test'], path: '/releases/', pathMatch: 'prefix',
      category: 'official_updates', authority: 'official', currentness: 'article', durableAllowed: false, autoStoreAllowed: false,
      metadataAdapter: 'patch-article-v1', metadataAdapterConfig: {
        kind: 'patch-article', releaseTitle: { prefix: 'Clockwork Citadel', label: 'Release Notes', versionLabel: 'Revision' },
        patchLabel: 'Application Version', buildLabel: 'Data Version', versionSemantics: 'opaque',
        platformSelector: 'article p', platformLabel: 'Available Platforms', platforms: [{ label: 'Windows', aliases: ['PC'] }],
        activeReleaseStatements: ['Update {patch} is available now for {game}']
      } }
  ]
}).rules;
export const SECOND_PUBLISHER_INDEX_HTML = `<main><section class="releases"><h2 id="releases">Releases (1)</h2>
  <ol class="release-cards"><li><a href="/releases/revision-210"><h4>Clockwork Citadel - Release Notes Revision 2.10</h4>
  <span class="date">2026-09-08</span></a></li></ol></section></main>`;
export const SECOND_PUBLISHER_ARTICLE_HTML = '<article><p><u>Available Platforms</u><br>Windows</p></article>';
