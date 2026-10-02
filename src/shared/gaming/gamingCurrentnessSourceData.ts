import type { GamingCurrentnessSourceRegistry } from './gamingCurrentnessRegistryTypes.js';

/** Declarative reviewed identities and extraction literals. Acquisition and durable-write controls remain in code. */
export const GAMING_CURRENTNESS_SOURCE_DATA = {
  version: 'gaming-currentness-sources/v1',
  rules: [
    { id: 'swtor-patch-index', game: 'Star Wars: The Old Republic', hosts: ['www.swtor.com', 'swtor.com'], path: '/patchnotes', pathMatch: 'exact',
      category: 'official_updates', authority: 'official', currentness: 'current_index', durableAllowed: false, autoStoreAllowed: false,
      metadataAdapter: 'dated-release-index-v1', metadataAdapterConfig: { kind: 'dated-release-index', releaseLabel: 'Game Update',
        dateFormat: 'month/day/year', allowLabeledFallback: true } },
    { id: 'swtor-patch-article', game: 'Star Wars: The Old Republic', hosts: ['www.swtor.com', 'swtor.com'], path: '/patchnotes/', pathMatch: 'prefix',
      category: 'official_updates', authority: 'official', currentness: 'article', durableAllowed: true, autoStoreAllowed: true },
    { id: 'destiny-news-article', game: 'Destiny 2', hosts: ['www.bungie.net'], path: '/7/en/News/Article/', pathMatch: 'prefix',
      category: 'official_updates', authority: 'official', currentness: 'article', durableAllowed: true, autoStoreAllowed: true },
    { id: 'wow-news-article', game: 'World of Warcraft', hosts: ['worldofwarcraft.blizzard.com'], path: '/en-us/news/', pathMatch: 'prefix',
      category: 'official_updates', authority: 'official', currentness: 'article', durableAllowed: true, autoStoreAllowed: true },
    { id: 'elden-ring-update-index', game: 'Elden Ring', hosts: ['en.bandainamcoent.eu'], path: '/elden-ring/elden-ring/news', pathMatch: 'exact',
      category: 'official_updates', authority: 'official', currentness: 'current_index', durableAllowed: false, autoStoreAllowed: false,
      metadataAdapter: 'article-index-v1', currentnessArticleRuleIds: ['elden-ring-news'], metadataAdapterConfig: {
        kind: 'article-index', pageTitle: 'Elden Ring news', pageText: 'Latest News on Elden Ring',
        releaseTitle: { prefix: 'Elden Ring', label: 'Patch Notes', versionLabel: 'Version' }, dateFormat: 'day/month/year',
        versionSemantics: 'app-regulation', headingSelector: 'main h2#patch-notes, [role="main"] h2#patch-notes', headingLabel: 'Patch Notes',
        sectionSelector: '.search__section', cardsSelector: 'ul.cards-list > li', anchorSelector: 'a[href]', titleSelector: 'h3', dateSelector: 'time', pageSize: 3
      } },
    { id: 'elden-ring-news', game: 'Elden Ring', hosts: ['en.bandainamcoent.eu'], path: '/elden-ring/news/', pathMatch: 'prefix',
      category: 'official_updates', authority: 'official', currentness: 'article', durableAllowed: true, autoStoreAllowed: true,
      metadataAdapter: 'patch-article-v1', metadataAdapterConfig: {
        kind: 'patch-article', releaseTitle: { prefix: 'Elden Ring', label: 'Patch Notes', versionLabel: 'Version' },
        patchLabel: 'App Ver.', buildLabel: 'Regulation Ver.', versionSemantics: 'app-regulation',
        platformSelector: 'main p, article p, [role="main"] p', platformLabel: 'Targeted Platforms',
        platforms: [{ label: 'PlayStation 4', aliases: ['PS4'] }, { label: 'PlayStation 5', aliases: ['PS5'] },
          { label: 'Xbox One', aliases: [] }, { label: 'Xbox Series X|S', aliases: [] }, { label: 'Steam', aliases: ['PC'] }],
        activeReleaseStatements: ['Patch {patch} has been released for {game}', 'This update is available now',
          'This update is required for online play', 'Online play requires the player to apply this update'],
        installedVersionCaption: 'after applying this update will be as follows:'
      } },
    { id: 'wow-specialist', game: 'World of Warcraft', hosts: ['www.icy-veins.com', 'icy-veins.com'], path: '/wow/', pathMatch: 'prefix',
      category: 'specialist_guide', authority: 'specialist', currentness: 'none', durableAllowed: true, autoStoreAllowed: false },
    { id: 'bg3-community-wiki', game: "Baldur's Gate 3", hosts: ['bg3.wiki'], path: '/wiki/', pathMatch: 'prefix',
      category: 'community', authority: 'community', currentness: 'none', durableAllowed: true, autoStoreAllowed: false }
  ]
} satisfies GamingCurrentnessSourceRegistry;
