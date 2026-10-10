/** Existing layout hints only: profiles neither grant authority nor relax transport or integrity policy. */
export const GAMING_PUBLISHER_EXTRACTION_PROFILE_VERSION = 'gaming-publisher-extraction-profiles/v1';
export const GAMING_PUBLISHER_EXTRACTION_PROFILE_REVISION = '2026-10-10.1';
export const GAMING_PUBLISHER_EXTRACTION_PROFILE_PROVENANCE = {
  origin: 'repository-defaults',
  migratedFrom: '200463b3aac65eb494f71d842c1e2b0378530bfb',
  reviewPolicy: 'owner-reviewed-layout-evidence'
} as const;

export interface GamingPublisherExtractionProfile {
  domains: string[];
  contentSelectors: readonly string[];
  removeSelectors: readonly string[];
}

export const GAMING_PUBLISHER_EXTRACTION_PROFILES: GamingPublisherExtractionProfile[] = [
  {
    domains: ["wiki.fextralife.com", "fextralife.com"],
    contentSelectors: ["#wiki-content-block", ".wiki-content-block", "#main-content", ".page-content"],
    removeSelectors: [
      ".wiki-header-container",
      ".wiki-menu-2-left",
      ".wikiMenuMobile",
      ".left-side-menu-container",
      ".side-bar-right",
      "#featured-wikis",
      "#related-games-content",
      "#disqus_thread"
    ]
  },
  {
    domains: ["bandainamcoent.com", "bandainamcoent.eu"],
    contentSelectors: [".article__edito-content", ".article__content", ".article", "article"],
    removeSelectors: [
      ".article__sidebar",
      ".article__share-social",
      "[class*='read-next']",
      ".age-gate"
    ]
  },
  {
    domains: ["worldofwarcraft.blizzard.com", "news.blizzard.com", "blizzard.com"],
    contentSelectors: [".NewsBlog-content", ".Article-content", ".article-content", "#main", "article"],
    removeSelectors: [".SiteNav", ".SocialLinks", ".CommentTotal"]
  },
  {
    domains: ["icy-veins.com"],
    contentSelectors: [".left-column-content", ".left-column-main", ".guide-page-content", "article"],
    removeSelectors: [
      ".guide-header__breadcrumbs",
      ".content-toc",
      ".table-of-contents",
      ".left-column-sidebar"
    ]
  }
];
