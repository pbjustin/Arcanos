import { createHash } from 'node:crypto';
import { normalizeGamingGameIdentity } from './gamingGameIdentity.js';
import { normalizeGamingPlatformIdentity } from './gamingPlatformIdentity.js';
import type { GamingEvidenceUnit } from './gamingEvidenceUnits.js';
import type { GamingCurrentnessAdapterId, GamingCurrentnessAdapterConfig, GamingReleaseTitleConfig } from './gamingCurrentnessRegistry.js';
export type { GamingCurrentnessAdapterId } from './gamingCurrentnessRegistry.js';

export const GAMING_CURRENTNESS_ADAPTER_VERSION = 'gaming-currentness-adapters/v2';
export const GAMING_CURRENTNESS_LIMITS = Object.freeze({ textChars: 32_000, entries: 100, evidence: 20, revalidateMs: 6 * 60 * 60_000 });

/** Supplied by the reviewed registry, never the frontend or a page's metadata. */
export interface GamingCurrentnessAdapterRule {
  id: string;
  game: string;
  metadataAdapter?: GamingCurrentnessAdapterId;
  metadataAdapterConfig?: GamingCurrentnessAdapterConfig;
  currentness: string;
  currentnessArticleRuleIds?: readonly string[];
}
export interface GamingCurrentnessFields {
  patch?: string;
  build?: string;
  season?: string;
  currentPatch?: string;
  currentBuild?: string;
  currentSeason?: string;
  effectiveFrom?: string;
  effectiveUntil?: string;
  publishedAt?: string;
  platforms?: string[];
  regions?: string[];
}
export interface GamingCurrentnessAdapterResult extends GamingCurrentnessFields {
  game: string;
  ruleId: string;
  adapterId: GamingCurrentnessAdapterId;
  adapterVersion: typeof GAMING_CURRENTNESS_ADAPTER_VERSION;
  verifiedAt: string;
  status: 'verified' | 'incomplete' | 'conflicting';
  reasons: string[];
  evidenceRefs: Array<{ url: string; contentHash: string }>;
  requiredArticlePatch?: string;
  requiredArticleUrl?: string;
  requiredArticleRuleIds?: string[];
  /** App and regulation identifiers have different meanings even when equal. */
  versionSemantics?: 'opaque' | 'app-regulation';
  /** A reviewed release article explicitly says the update is available/required now. */
  releaseActive?: boolean;
}
export interface GamingCurrentnessDocument {
  publicUrl: string;
  canonicalUrl?: string;
  text: string;
  metadata?: { title?: string; headings?: string };
  evidenceUnits?: readonly GamingEvidenceUnit[];
  metrics?: { truncated?: boolean; instructionFiltered?: boolean };
  currentnessDocument?: GamingCurrentnessDocumentMetadata;
}
/** Resolver-owned links from the reviewed current listing; includes its independently bounded DOM hash. */
export interface GamingCurrentnessDocumentIndex {
  ruleId: string;
  adapterId: 'article-index-v1';
  categoryCount: number;
  cards: Array<{ title: string; publishedDate: string; url: string }>;
  rawContentHash: string;
  status: 'complete' | 'incomplete';
}
export interface GamingCurrentnessDocumentArticle {
  ruleId: string;
  adapterId: 'patch-article-v1';
  platformText: string;
  rawContentHash: string;
  status: 'complete' | 'incomplete';
}
export type GamingCurrentnessDocumentMetadata = GamingCurrentnessDocumentIndex | GamingCurrentnessDocumentArticle;
export interface GamingCurrentnessAdapterInput {
  document: GamingCurrentnessDocument;
  rule: GamingCurrentnessAdapterRule;
  game: string;
  now: Date;
  /** Closed labels already extracted by the shared resolver metadata grammar. */
  fields?: GamingCurrentnessFields;
  metadataConflict?: boolean;
  metadataUnverified?: boolean;
}
const normalize = (value: string): string => value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
const same = (a: string | undefined, b: string | undefined): boolean => Boolean(a && b && normalize(a).toLowerCase() === normalize(b).toLowerCase());
const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const isoDate = (year: string, month: string, day: string): string | undefined => {
  const date = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  const value = Date.parse(date);
  return Number.isFinite(value) && new Date(value).toISOString().slice(0, 10) === date ? new Date(value).toISOString() : undefined;
};
const opaqueVersion = '(\\d{1,8}(?:\\.\\d{1,8}){1,3}[a-z]?)(?=$|\\s|[,;()]|\\.(?=\\s|$))';
/** Config chooses a closed date format; impossible calendar dates remain incomplete. */
export function parseGamingCurrentnessDate(value: string, format: 'day/month/year' | 'month/day/year' | 'year-month-day'): string | undefined {
  const date = format === 'year-month-day' ? /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
    : /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u.exec(value);
  if (!date) return undefined;
  return format === 'year-month-day' ? isoDate(date[1], date[2], date[3])
    : isoDate(date[3], date[format === 'month/day/year' ? 1 : 2], date[format === 'month/day/year' ? 2 : 1]);
}
function releaseTitlePattern(config: GamingReleaseTitleConfig, publisherSuffix = false): RegExp {
  return new RegExp(`^${escape(config.prefix)}\\s*[–-]\\s*${escape(config.label)}\\s*(?:[–-]\\s*)?${escape(config.versionLabel)}\\s+${opaqueVersion}${publisherSuffix ? '(?:\\s*\\||$)' : '$'}`, 'iu');
}
interface Release { patch: string; at: string }

/** Combining release evidence may narrow declared applicability, never widen it. */
function intersectScope(left: string[] | undefined, right: string[] | undefined, platform = false): { values?: string[]; conflicting: boolean } {
  if (!left?.length) return { values: right, conflicting: false };
  if (!right?.length) return { values: left, conflicting: false };
  if (left.some(value => same(value, 'all'))) return { values: right, conflicting: false };
  if (right.some(value => same(value, 'all'))) return { values: left, conflicting: false };
  const identity = (value: string): string => platform ? normalizeGamingPlatformIdentity(value) : normalize(value).toLowerCase();
  const identities = new Set(left.map(identity));
  const values = right.filter(value => identities.has(identity(value)));
  return { values: values.length ? values : undefined, conflicting: !values.length };
}

/** Dates order an explicitly reviewed release listing. Version strings are opaque identities. */
function activeRelease(releases: Release[], now: Date): { release?: Release; status: 'verified' | 'incomplete' | 'conflicting'; reason: string } {
  const ordered = releases.filter(item => Date.parse(item.at) <= now.getTime()).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  if (!ordered.length) return { status: 'incomplete', reason: 'ACTIVE_RELEASE_NOT_ESTABLISHED' };
  const latest = ordered[0];
  if (latest.at.slice(0, 10) === now.toISOString().slice(0, 10)) return { status: 'incomplete', reason: 'DATE_ONLY_ROLLOUT_NOT_ESTABLISHED' };
  if (new Set(ordered.filter(item => item.at === latest.at).map(item => item.patch)).size !== 1)
    return { status: 'conflicting', reason: 'DATED_RELEASE_CONFLICT' };
  return { release: latest, status: 'verified', reason: 'DATED_OFFICIAL_RELEASE_INDEX' };
}

/** Deterministic extraction from a safely acquired document; no fetching, model, or HTML canonical trust. */
export function runGamingCurrentnessAdapter(input: GamingCurrentnessAdapterInput): GamingCurrentnessAdapterResult {
  const { document, rule, now } = input;
  const adapterId = rule.metadataAdapter ?? 'labeled-metadata-v1';
  let result: GamingCurrentnessAdapterResult = {
    game: rule.game, ruleId: rule.id, adapterId, adapterVersion: GAMING_CURRENTNESS_ADAPTER_VERSION,
    verifiedAt: Number.isFinite(now.getTime()) ? now.toISOString() : '', status: 'incomplete', reasons: [],
    evidenceRefs: [{ url: document.publicUrl, contentHash: createHash('sha256').update(JSON.stringify({
      url: document.canonicalUrl ?? document.publicUrl, text: document.text, metadata: document.metadata,
      evidenceUnits: document.evidenceUnits, currentnessDocument: document.currentnessDocument
    })).digest('hex') }]
  };
  if (normalizeGamingGameIdentity(rule.game) !== normalizeGamingGameIdentity(input.game) || !result.verifiedAt) {
    result.reasons = ['ADAPTER_SCOPE_INVALID']; return result;
  }
  if (input.metadataConflict) { result.status = 'conflicting'; result.reasons = ['CONTRADICTORY_SOURCE_METADATA']; return result; }
  if (input.metadataUnverified || document.metrics?.truncated || document.metrics?.instructionFiltered) {
    result.reasons = ['APPLICABILITY_METADATA_UNVERIFIED']; return result;
  }
  if (adapterId !== 'article-index-v1' && document.text.length > GAMING_CURRENTNESS_LIMITS.textChars) {
    result.reasons = ['CURRENTNESS_METADATA_INPUT_LIMIT']; return result;
  }
  if ([input.fields?.currentPatch, input.fields?.currentBuild, input.fields?.currentSeason]
    .some(value => value !== undefined && (!value || value.length > 64))) {
    result.reasons = ['CURRENTNESS_IDENTIFIER_UNSUPPORTED']; return result;
  }
  if (adapterId === 'labeled-metadata-v1') {
    if ([input.fields?.patch, input.fields?.build, input.fields?.season, input.fields?.currentPatch,
      input.fields?.currentBuild, input.fields?.currentSeason].some(value => value !== undefined && (!value || value.length > 64))) {
      result.reasons = ['CURRENTNESS_IDENTIFIER_UNSUPPORTED']; return result;
    }
    result = { ...result, ...input.fields };
    if (rule.currentness !== 'current_index') result.reasons = ['ARTICLE_IS_NOT_CURRENT_INDEX'];
    else if (!(result.currentPatch || result.currentBuild || result.currentSeason) || !result.effectiveFrom)
      result.reasons = ['CURRENT_RELEASE_IDENTIFIER_REQUIRED'];
    else if (!Number.isFinite(Date.parse(result.effectiveFrom)) || Date.parse(result.effectiveFrom) > now.getTime())
      result.reasons = ['ACTIVE_RELEASE_NOT_ESTABLISHED'];
    else { result.status = 'verified'; result.reasons = ['EXPLICIT_OFFICIAL_CURRENTNESS_LABELS']; }
    return result;
  }
  const text = normalize(document.text.slice(0, GAMING_CURRENTNESS_LIMITS.textChars));
  const config = rule.metadataAdapterConfig;
  if (!config) { result.reasons = ['ADAPTER_EXTRACTION_CONTRACT_REQUIRED']; return result; }
  if (adapterId === 'dated-release-index-v1' && config.kind === 'dated-release-index') {
    const matches = [...text.matchAll(new RegExp(`\\b(\\d{1,2})/(\\d{1,2})/(\\d{2}|\\d{4})\\s*[-–]\\s*${escape(config.releaseLabel)}\\s+${opaqueVersion}\\b`, 'giu'))];
    const releaseLabels = [...text.matchAll(new RegExp(`\\b${escape(config.releaseLabel)}\\s+`, 'giu'))];
    if (matches.length !== releaseLabels.length) { result.reasons = ['OFFICIAL_RELEASE_VERSION_UNSUPPORTED']; return result; }
    // A reviewed fallback still uses the same closed currentness label contract.
    if (config.allowLabeledFallback && !releaseLabels.length && input.fields?.currentPatch) {
      const labeled = runGamingCurrentnessAdapter({ ...input, rule: { ...rule, metadataAdapter: 'labeled-metadata-v1' } });
      return { ...labeled, adapterId };
    }
    if (matches.length > GAMING_CURRENTNESS_LIMITS.entries) { result.reasons = ['CURRENTNESS_ENTRY_LIMIT']; return result; }
    const releases = matches.flatMap(match => {
      const at = isoDate(match[3].length === 2 ? `20${match[3]}` : match[3],
        match[config.dateFormat === 'month/day/year' ? 1 : 2], match[config.dateFormat === 'month/day/year' ? 2 : 1]);
      return at ? [{ at, patch: match[4] }] : [];
    });
    if (releases.length !== matches.length) { result.reasons = ['INVALID_RELEASE_DATE']; return result; }
    const active = activeRelease(releases, now);
    result.status = active.status; result.reasons = [active.reason];
    if (active.release) {
      result = { ...result, ...input.fields, patch: active.release.patch, currentPatch: active.release.patch,
        effectiveFrom: input.fields?.effectiveFrom ?? active.release.at };
      if (input.fields?.currentPatch && !same(input.fields.currentPatch, active.release.patch)) {
        result.status = 'conflicting'; result.reasons = ['CONTRADICTORY_ADAPTER_METADATA'];
      } else if (!(Date.parse(result.effectiveFrom!) <= now.getTime())
        || result.effectiveUntil && !(Date.parse(result.effectiveUntil) > now.getTime())) {
        result.status = 'incomplete'; result.reasons = ['ACTIVE_RELEASE_NOT_ESTABLISHED'];
      }
    }
    return result;
  }
  if (adapterId === 'article-index-v1' && config.kind === 'article-index') {
    if (!new RegExp(`^${escape(config.pageTitle)}(?:\\s*\\||$)`, 'iu').test(normalize(document.metadata?.title ?? ''))
      && !new RegExp(`${escape(config.pageText)}\\b`, 'iu').test(text)) {
      result.reasons = ['OFFICIAL_INDEX_LAYOUT_UNRECOGNIZED']; return result;
    }
    const listing = document.currentnessDocument;
    if (!listing || listing.ruleId !== rule.id || listing.adapterId !== adapterId || listing.status !== 'complete'
      || !/^[a-f0-9]{64}$/u.test(listing.rawContentHash)) {
      result.reasons = ['OFFICIAL_INDEX_LINKS_REQUIRED']; return result;
    }
    const categoryCount = listing.categoryCount;
    const pattern = releaseTitlePattern(config.releaseTitle);
    // The reviewed first-page contract declares the number of latest cards, or every card when fewer exist.
    // Missing/truncated cards cannot be interpreted as evidence that no later release exists.
    if (!Number.isFinite(categoryCount) || categoryCount < 1 || listing.cards.length !== Math.min(config.pageSize, categoryCount)) {
      result.reasons = ['OFFICIAL_RELEASE_CARDS_INCOMPLETE']; return result;
    }
    const releases = listing.cards.flatMap(card => {
      const title = pattern.exec(card.title);
      const at = parseGamingCurrentnessDate(card.publishedDate, config.dateFormat);
      return title && at ? [{ at, patch: title[1], url: card.url }] : [];
    });
    if (releases.length !== listing.cards.length) { result.reasons = ['OFFICIAL_RELEASE_CARD_UNSUPPORTED']; return result; }
    const active = activeRelease(releases, now);
    result.status = active.status; result.reasons = [active.reason];
    const release = active.release;
    const activeUrls = new Set(release ? releases.filter(item => item.at === release.at && item.patch === release.patch).map(item => item.url) : []);
    if (active.release && activeUrls.size !== 1) { result.status = 'conflicting'; result.reasons = ['OFFICIAL_RELEASE_LINK_CONFLICT']; return result; }
    if (active.release) result = { ...result, ...input.fields, status: 'incomplete', currentPatch: active.release.patch,
      patch: active.release.patch, effectiveFrom: input.fields?.effectiveFrom ?? active.release.at, requiredArticlePatch: active.release.patch,
      requiredArticleUrl: [...activeUrls][0],
      requiredArticleRuleIds: [...(rule.currentnessArticleRuleIds ?? [])], versionSemantics: config.versionSemantics,
      reasons: ['OFFICIAL_PATCH_ARTICLE_REQUIRED', 'HOTFIX_BUILD_CHECK_REQUIRED'] };
    return result;
  }
  if (adapterId !== 'patch-article-v1' || config.kind !== 'patch-article') {
    result.reasons = ['ADAPTER_EXTRACTION_CONTRACT_REQUIRED']; return result;
  }
  // Article version labels establish the release only, never that no later release exists.
  const title = normalize(document.metadata?.title ?? '');
  const titledPatch = releaseTitlePattern(config.releaseTitle, true).exec(title)?.[1];
  const versions = (label: string) => [...text.matchAll(new RegExp(`\\b${escape(label)}\\s*${opaqueVersion}\\b`, 'giu'))].map(match => match[1]);
  const app = versions(config.patchLabel);
  const builds = versions(config.buildLabel);
  if (app.length !== [...text.matchAll(new RegExp(`\\b${escape(config.patchLabel)}`, 'giu'))].length
    || builds.length !== [...text.matchAll(new RegExp(`\\b${escape(config.buildLabel)}`, 'giu'))].length) {
    result.reasons = ['OFFICIAL_ARTICLE_VERSION_UNSUPPORTED']; return result;
  }
  if (new Set(app).size > 1 || new Set(builds).size > 1 || titledPatch && app.length && !same(titledPatch, app[0])) {
    result.status = 'conflicting'; result.reasons = ['OFFICIAL_ARTICLE_VERSION_CONFLICT']; return result;
  }
  if (!titledPatch || !app.length || !builds.length) { result.reasons = ['OFFICIAL_ARTICLE_VERSION_REQUIRED']; return result; }
  const articleMetadata = document.currentnessDocument;
  const platformText = articleMetadata?.adapterId === 'patch-article-v1' && articleMetadata.status === 'complete'
    && articleMetadata.ruleId === rule.id && /^[a-f0-9]{64}$/u.test(articleMetadata.rawContentHash)
    ? articleMetadata.platformText : undefined;
  const platformLabels = platformText?.split(/\s*\/\s*/u);
  if (!platformLabels?.length || platformLabels.length > 8
    || platformLabels.some(value => !config.platforms.some(platform => platform.label === value))) {
    result.reasons = ['OFFICIAL_ARTICLE_PLATFORM_SCOPE_REQUIRED']; return result;
  }
  const platforms = platformLabels.flatMap(value => {
    const platform = config.platforms.find(item => item.label === value)!;
    return [platform.label, ...platform.aliases];
  });
  const platformScope = intersectScope(input.fields?.platforms, platforms, true);
  // A reviewed installed-version caption may describe displayed values, but other future qualifiers still veto.
  const releaseTimingText = config.installedVersionCaption
    ? text.replace(new RegExp(`\\b${escape(config.installedVersionCaption)}`, 'giu'), '') : text;
  const futureRelease = new RegExp(`\\b(?:This (?:patch|update)|Patch ${escape(app[0])})\\s+(?:(?:is|has been)\\s+)?(?:scheduled|planned|will)\\b`, 'iu').test(releaseTimingText);
  const releaseActive = !futureRelease && config.activeReleaseStatements.some(statement => {
    const literal = statement.replace(/\{game\}/gu, rule.game).replace(/\{patch\}/gu, app[0]);
    return new RegExp(`\\b${escape(literal)}\\b`, 'iu').test(text);
  });
  result = { ...result, patch: app[0], build: builds[0], versionSemantics: config.versionSemantics, releaseActive,
    ...(platformScope.values?.length ? { platforms: platformScope.values } : {}), ...(input.fields?.publishedAt ? { publishedAt: input.fields.publishedAt } : {}),
    ...(input.fields?.effectiveFrom ? { effectiveFrom: input.fields.effectiveFrom } : {}),
    ...(input.fields?.effectiveUntil ? { effectiveUntil: input.fields.effectiveUntil } : {}) };
  result.reasons = ['ARTICLE_IS_NOT_CURRENT_INDEX', ...(!releaseActive ? ['OFFICIAL_RELEASE_ACTIVATION_REQUIRED'] : [])];
  if (platformScope.conflicting) { result.status = 'conflicting'; result.reasons = ['OFFICIAL_ARTICLE_APPLICABILITY_CONFLICT']; }
  return result;
}

export interface GamingCurrentnessEvidenceShape extends GamingCurrentnessFields {
  id: string;
  url?: string;
  game: string;
  edition?: string;
  ruleId?: string;
  authority: string;
  currentness: string;
  fetchedAt: string;
  verifiedAt?: string;
  metadataConflict?: boolean;
  metadataUnverified?: boolean;
  currentnessMetadata?: GamingCurrentnessAdapterResult;
}
/** Complete only the article required by a reviewed release listing. No arbitrary article set proves latest. */
export function combineGamingCurrentnessEvidence<T extends GamingCurrentnessEvidenceShape>(evidence: readonly T[], now: Date): T[] {
  if (evidence.length > GAMING_CURRENTNESS_LIMITS.evidence || !Number.isFinite(now.getTime())) return [...evidence];
  const fresh = (item: T): boolean => {
    const verified = Date.parse(item.verifiedAt ?? ''); const fetched = Date.parse(item.fetchedAt);
    return Number.isFinite(verified) && Number.isFinite(fetched) && fetched <= verified && verified <= now.getTime()
      && now.getTime() - Math.min(verified, fetched) <= GAMING_CURRENTNESS_LIMITS.revalidateMs;
  };
  return evidence.map(index => {
    const metadata = index.currentnessMetadata;
    if (index.authority !== 'official' || index.currentness !== 'current_index' || !metadata?.requiredArticlePatch
      || metadata.status === 'conflicting' || index.metadataConflict || !fresh(index)
      || index.effectiveFrom && !(Date.parse(index.effectiveFrom) <= now.getTime())
      || index.effectiveUntil && !(Date.parse(index.effectiveUntil) > now.getTime())
      || metadata.adapterVersion !== GAMING_CURRENTNESS_ADAPTER_VERSION) return index;
    const articles = evidence.filter(article => article.authority === 'official' && article.currentness === 'article'
      && article.currentnessMetadata?.adapterVersion === GAMING_CURRENTNESS_ADAPTER_VERSION
      && article.currentnessMetadata.releaseActive === true
      && metadata.requiredArticleRuleIds?.includes(article.ruleId ?? '')
      && Boolean(metadata.requiredArticleUrl) && article.url === metadata.requiredArticleUrl
      && normalizeGamingGameIdentity(article.game) === normalizeGamingGameIdentity(index.game)
      && (article.edition ?? '') === (index.edition ?? '') && fresh(article)
      && same(article.patch, metadata.requiredArticlePatch) && article.build && article.platforms?.length
      && !article.metadataConflict && !article.metadataUnverified
      && (!article.effectiveFrom || Date.parse(article.effectiveFrom) <= now.getTime())
      && (!article.publishedAt || Date.parse(article.publishedAt) <= now.getTime())
      && (!article.effectiveUntil || Date.parse(article.effectiveUntil) > now.getTime()));
    if (!articles.length) return index;
    // A divergent platform/region release needs a scoped publisher adapter, not arbitrary first selection.
    const identities = new Set(articles.map(article => JSON.stringify([article.patch, article.build,
      [...(article.platforms ?? [])].sort(), [...(article.regions ?? [])].sort()])));
    if (identities.size !== 1 || index.currentBuild && articles.some(article => !same(article.build, index.currentBuild))) return { ...index, metadataConflict: true, currentnessMetadata: {
      ...metadata, status: 'conflicting', reasons: ['OFFICIAL_ARTICLE_APPLICABILITY_CONFLICT'] } };
    const article = articles[0];
    const platformScope = intersectScope(index.platforms, article.platforms, true);
    const regionScope = intersectScope(index.regions, article.regions);
    if (platformScope.conflicting || regionScope.conflicting) return { ...index, metadataConflict: true, currentnessMetadata: {
      ...metadata, status: 'conflicting', reasons: ['OFFICIAL_ARTICLE_APPLICABILITY_CONFLICT'] } };
    const verifiedAt = new Date(Math.min(Date.parse(index.verifiedAt!), Date.parse(article.verifiedAt!))).toISOString();
    const untils = [index.effectiveUntil, ...articles.map(item => item.effectiveUntil)].filter((value): value is string => Boolean(value));
    const effectiveUntil = untils.length ? new Date(Math.min(...untils.map(value => Date.parse(value)))).toISOString() : undefined;
    return { ...index, currentBuild: article.build, platforms: platformScope.values, regions: regionScope.values,
      ...(effectiveUntil ? { effectiveUntil } : {}),
      metadataUnverified: false, verifiedAt, currentnessMetadata: { ...metadata, currentBuild: article.build,
        ...(effectiveUntil ? { effectiveUntil } : {}),
        platforms: platformScope.values, regions: regionScope.values, verifiedAt, status: 'verified',
        reasons: ['OFFICIAL_INDEX_AND_RELEASE_ARTICLE_VERIFIED'], evidenceRefs: [...metadata.evidenceRefs,
          ...(article.currentnessMetadata?.evidenceRefs ?? [])].slice(0, GAMING_CURRENTNESS_LIMITS.evidence) } };
  });
}
