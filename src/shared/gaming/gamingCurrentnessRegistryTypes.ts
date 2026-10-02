export type GamingSourceCategory = 'official_updates' | 'official_status' | 'official_documentation' | 'specialist_guide' | 'community' | 'unreviewed';
export type GamingSourceAuthority = 'official' | 'specialist' | 'community' | 'unreviewed';
export type GamingSourceCurrentness = 'current_index' | 'article' | 'live_status' | 'none';
export type GamingCurrentnessAdapterId = 'labeled-metadata-v1' | 'dated-release-index-v1' | 'article-index-v1' | 'patch-article-v1';
export interface GamingReleaseTitleConfig { prefix: string; label: string; versionLabel: string }
export interface GamingArticleIndexConfig {
  kind: 'article-index';
  pageTitle: string;
  pageText: string;
  releaseTitle: GamingReleaseTitleConfig;
  dateFormat: 'day/month/year' | 'month/day/year' | 'year-month-day';
  versionSemantics: 'opaque' | 'app-regulation';
  headingSelector: string;
  headingLabel: string;
  sectionSelector: string;
  cardsSelector: string;
  anchorSelector: string;
  titleSelector: string;
  dateSelector: string;
  /** A reviewed first-page completeness contract, bounded by code's three candidate slots. */
  pageSize: number;
}
export interface GamingPatchArticleConfig {
  kind: 'patch-article';
  releaseTitle: GamingReleaseTitleConfig;
  patchLabel: string;
  buildLabel: string;
  versionSemantics: 'opaque' | 'app-regulation';
  platformSelector: string;
  platformLabel: string;
  platforms: readonly { label: string; aliases: readonly string[] }[];
  /** Literal templates; only {game} and {patch} are substituted and regex-escaped. */
  activeReleaseStatements: readonly string[];
  installedVersionCaption?: string;
}
export interface GamingDatedReleaseIndexConfig {
  kind: 'dated-release-index';
  releaseLabel: string;
  dateFormat: 'day/month/year' | 'month/day/year';
  allowLabeledFallback: boolean;
}
export type GamingCurrentnessAdapterConfig = GamingArticleIndexConfig | GamingPatchArticleConfig | GamingDatedReleaseIndexConfig;

/** Reviewed data can narrow category authority; it cannot grant acquisition or write privileges. */
export interface GamingReviewedSourceRule {
  id: string;
  game: string;
  hosts: readonly string[];
  path: string;
  pathMatch: 'exact' | 'prefix';
  category: GamingSourceCategory;
  authority?: GamingSourceAuthority;
  currentness: GamingSourceCurrentness;
  durableAllowed: boolean;
  autoStoreAllowed: boolean;
  metadataAdapter?: GamingCurrentnessAdapterId;
  metadataAdapterConfig?: GamingCurrentnessAdapterConfig;
  currentnessArticleRuleIds?: readonly string[];
  platforms?: readonly string[];
  regions?: readonly string[];
}
export interface GamingCurrentnessSourceRegistry { version: 'gaming-currentness-sources/v1'; rules: readonly GamingReviewedSourceRule[] }
