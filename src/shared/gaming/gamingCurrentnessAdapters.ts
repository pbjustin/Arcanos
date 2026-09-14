import { createHash } from 'node:crypto';
import { normalizeGamingGameIdentity } from './gamingGameIdentity.js';
import type { GamingEvidenceUnit } from './gamingEvidenceUnits.js';

export const GAMING_CURRENTNESS_ADAPTER_VERSION = 'gaming-currentness-adapters/v1';
export const GAMING_CURRENTNESS_LIMITS = Object.freeze({ textChars: 32_000, entries: 100, evidence: 20, revalidateMs: 6 * 60 * 60_000 });
export type GamingCurrentnessAdapterId = 'labeled-v1' | 'swtor-patch-index-v1' | 'bandai-news-index-v1' | 'bandai-patch-article-v1';

/** Supplied by the reviewed registry, never the frontend or a page's metadata. */
export interface GamingCurrentnessAdapterRule {
  id: string;
  game: string;
  metadataAdapter?: GamingCurrentnessAdapterId;
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
  adapterId: 'bandai-news-index-v1';
  categoryCount: number;
  cards: Array<{ title: string; publishedDate: string; url: string }>;
  rawContentHash: string;
  status: 'complete' | 'incomplete';
}
export interface GamingCurrentnessDocumentArticle {
  ruleId: string;
  adapterId: 'bandai-patch-article-v1';
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
interface Release { patch: string; at: string }

/** Combining release evidence may narrow declared applicability, never widen it. */
function intersectScope(left: string[] | undefined, right: string[] | undefined, platform = false): { values?: string[]; conflicting: boolean } {
  if (!left?.length) return { values: right, conflicting: false };
  if (!right?.length) return { values: left, conflicting: false };
  if (left.some(value => same(value, 'all'))) return { values: right, conflicting: false };
  if (right.some(value => same(value, 'all'))) return { values: left, conflicting: false };
  const identity = (value: string): string => {
    const key = normalize(value).toLowerCase();
    // These are the same explicit publisher aliases emitted by the article adapter.
    return platform ? ({ steam: 'pc', 'playstation 4': 'ps4', 'playstation 5': 'ps5' } as Record<string, string>)[key] ?? key : key;
  };
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
  const adapterId = rule.metadataAdapter ?? 'labeled-v1';
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
  if (adapterId !== 'bandai-news-index-v1' && document.text.length > GAMING_CURRENTNESS_LIMITS.textChars) {
    result.reasons = ['CURRENTNESS_METADATA_INPUT_LIMIT']; return result;
  }
  if ([input.fields?.currentPatch, input.fields?.currentBuild, input.fields?.currentSeason]
    .some(value => value !== undefined && (!value || value.length > 64))) {
    result.reasons = ['CURRENTNESS_IDENTIFIER_UNSUPPORTED']; return result;
  }
  if (adapterId === 'labeled-v1') {
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
  if (adapterId === 'swtor-patch-index-v1') {
    const matches = [...text.matchAll(new RegExp(`\\b(\\d{1,2})/(\\d{1,2})/(\\d{2}|\\d{4})\\s*[-–]\\s*Game Update\\s+${opaqueVersion}\\b`, 'giu'))];
    const releaseLabels = [...text.matchAll(/\bGame Update\s+/giu)];
    if (matches.length !== releaseLabels.length) { result.reasons = ['OFFICIAL_RELEASE_VERSION_UNSUPPORTED']; return result; }
    // Preserve the existing reviewed index's closed currentness labels when it has no dated listing.
    if (!releaseLabels.length && input.fields?.currentPatch) {
      const labeled = runGamingCurrentnessAdapter({ ...input, rule: { ...rule, metadataAdapter: 'labeled-v1' } });
      return { ...labeled, adapterId };
    }
    if (matches.length > GAMING_CURRENTNESS_LIMITS.entries) { result.reasons = ['CURRENTNESS_ENTRY_LIMIT']; return result; }
    const releases = matches.flatMap(match => {
      const at = isoDate(match[3].length === 2 ? `20${match[3]}` : match[3], match[1], match[2]);
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
  if (adapterId === 'bandai-news-index-v1') {
    if (!new RegExp(`^${escape(rule.game)} news(?:\\s*\\||$)`, 'iu').test(normalize(document.metadata?.title ?? ''))
      && !new RegExp(`Latest News on ${escape(rule.game)}\\b`, 'iu').test(text)) {
      result.reasons = ['OFFICIAL_INDEX_LAYOUT_UNRECOGNIZED']; return result;
    }
    const listing = document.currentnessDocument;
    if (!listing || listing.ruleId !== rule.id || listing.adapterId !== adapterId || listing.status !== 'complete'
      || !/^[a-f0-9]{64}$/u.test(listing.rawContentHash)) {
      result.reasons = ['OFFICIAL_INDEX_LINKS_REQUIRED']; return result;
    }
    const categoryCount = listing.categoryCount;
    const pattern = new RegExp(`^${escape(rule.game)}\\s*[–-]\\s*Patch Notes\\s*(?:[–-]\\s*)?Version\\s+${opaqueVersion}$`, 'iu');
    // The reviewed first page publishes three latest cards, or every card when fewer exist.
    // Missing/truncated cards cannot be interpreted as evidence that no later release exists.
    if (!Number.isFinite(categoryCount) || categoryCount < 1 || listing.cards.length !== Math.min(3, categoryCount)) {
      result.reasons = ['OFFICIAL_RELEASE_CARDS_INCOMPLETE']; return result;
    }
    const releases = listing.cards.flatMap(card => {
      const title = pattern.exec(card.title);
      const date = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u.exec(card.publishedDate);
      const at = date && isoDate(date[3], date[2], date[1]);
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
      requiredArticleRuleIds: [...(rule.currentnessArticleRuleIds ?? [])], versionSemantics: 'app-regulation',
      reasons: ['OFFICIAL_PATCH_ARTICLE_REQUIRED', 'HOTFIX_BUILD_CHECK_REQUIRED'] };
    return result;
  }
  // The publisher article's App and Regulation labels establish its release only, never latest.
  const title = normalize(document.metadata?.title ?? '');
  const titledPatch = new RegExp(`^${escape(rule.game)}\\s*[–-]\\s*Patch Notes\\s*(?:[–-]\\s*)?Version\\s+${opaqueVersion}(?:\\s*\\||$)`, 'iu').exec(title)?.[1];
  const app = [...text.matchAll(new RegExp(`\\bApp Ver\\.\\s*${opaqueVersion}\\b`, 'giu'))].map(match => match[1]);
  const builds = [...text.matchAll(new RegExp(`\\bRegulation Ver\\.\\s*${opaqueVersion}\\b`, 'giu'))].map(match => match[1]);
  if (app.length !== [...text.matchAll(/\bApp Ver\./giu)].length || builds.length !== [...text.matchAll(/\bRegulation Ver\./giu)].length) {
    result.reasons = ['OFFICIAL_ARTICLE_VERSION_UNSUPPORTED']; return result;
  }
  if (new Set(app).size > 1 || new Set(builds).size > 1 || titledPatch && app.length && !same(titledPatch, app[0])) {
    result.status = 'conflicting'; result.reasons = ['OFFICIAL_ARTICLE_VERSION_CONFLICT']; return result;
  }
  if (!titledPatch || !app.length || !builds.length) { result.reasons = ['OFFICIAL_ARTICLE_VERSION_REQUIRED']; return result; }
  const articleMetadata = document.currentnessDocument;
  const platformText = articleMetadata?.adapterId === 'bandai-patch-article-v1' && articleMetadata.status === 'complete'
    && articleMetadata.ruleId === rule.id && /^[a-f0-9]{64}$/u.test(articleMetadata.rawContentHash)
    && /^(?:PlayStation 4|PlayStation 5|Xbox One|Xbox Series X\|S|Steam)(?:\s*\/\s*(?:PlayStation 4|PlayStation 5|Xbox One|Xbox Series X\|S|Steam))*$/u.test(articleMetadata.platformText)
    ? articleMetadata.platformText : undefined;
  if (!platformText) { result.reasons = ['OFFICIAL_ARTICLE_PLATFORM_SCOPE_REQUIRED']; return result; }
  const platforms = platformText.split(/\s*\/\s*/u).flatMap(value => value === 'Steam' ? ['Steam', 'PC']
    : value === 'PlayStation 4' ? ['PlayStation 4', 'PS4'] : value === 'PlayStation 5' ? ['PlayStation 5', 'PS5'] : [value]);
  const platformScope = intersectScope(input.fields?.platforms, platforms, true);
  const futureRelease = new RegExp(`\\b(?:This (?:patch|update)|Patch ${escape(app[0])})\\s+(?:(?:is|has been)\\s+)?(?:scheduled|planned|will)\\b`, 'iu').test(text);
  const releaseActive = !futureRelease && (new RegExp(`\\bPatch ${escape(app[0])} has been released for ${escape(rule.game)}\\b`, 'iu').test(text)
    || /\b(?:This update is (?:available now|required for online play)|Online play requires the player to apply this update)\b/iu.test(text));
  result = { ...result, patch: app[0], build: builds[0], versionSemantics: 'app-regulation', releaseActive,
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
