import { normalizeGamingGameIdentity } from './gamingGameIdentity.js';
import type { GamingEvidenceUnit } from './gamingEvidenceUnits.js';
import { readGamingEvidenceUnits } from './gamingStructuralEvidence.js';
import { runGamingCurrentnessAdapter, combineGamingCurrentnessEvidence, GAMING_CURRENTNESS_ADAPTER_VERSION,
  type GamingCurrentnessAdapterId, type GamingCurrentnessAdapterResult, type GamingCurrentnessDocumentMetadata } from './gamingCurrentnessAdapters.js';
import { evaluateGamingGuideApplicability, isGamingGameplayFreshnessEvidence, type GamingGuideApplicability } from './gamingGuideApplicability.js';

export const GAMING_FRESHNESS_POLICY_VERSION = 'gaming-hybrid-freshness-v1';
export const GAMING_SOURCE_POLICY_VERSION = 'gaming-hybrid-source-policy-v2';
/** These are revalidation deadlines, never evidence that a claim is correct. */
export const GAMING_FRESHNESS_DEFAULTS = Object.freeze({
  stable: 30 * 24 * 60 * 60 * 1_000,
  patch_sensitive: 6 * 60 * 60 * 1_000,
  seasonal: 6 * 60 * 60 * 1_000,
  live_status: 60 * 1_000,
  maxEvidence: 20,
  maxMetadataChars: 32_000
});

export type GamingQuestionFreshness = 'stable' | 'patch_sensitive' | 'seasonal' | 'live_status';
export type GamingFreshnessStatus = 'current' | 'stale' | 'unverified' | 'not_applicable' | 'conflicting';
export type GamingSourceCategory = 'official_updates' | 'official_status' | 'official_documentation' | 'specialist_guide' | 'community' | 'unreviewed';
export type GamingSourceAuthority = 'official' | 'specialist' | 'community' | 'unreviewed';
export type GamingSourceCurrentness = 'current_index' | 'article' | 'live_status' | 'none';

/** Code-reviewed server configuration, never candidate-supplied metadata. */
export interface GamingReviewedSourceRule {
  id: string;
  game: string;
  hosts: readonly string[];
  path: string;
  pathMatch: 'exact' | 'prefix';
  category: GamingSourceCategory;
  currentness: GamingSourceCurrentness;
  durableAllowed: boolean;
  autoStoreAllowed: boolean;
  metadataAdapter?: GamingCurrentnessAdapterId;
  /** Explicit companion article rules; neither arbitrary publisher URLs nor frontend hints qualify. */
  currentnessArticleRuleIds?: readonly string[];
  platforms?: readonly string[];
  regions?: readonly string[];
}

/** Narrow ownership paths derived from the existing Gaming catalog. No subdomain wildcard. */
export const REVIEWED_GAMING_SOURCE_RULES: readonly GamingReviewedSourceRule[] = Object.freeze([
  { id: 'swtor-patch-index', game: 'Star Wars: The Old Republic', hosts: ['www.swtor.com', 'swtor.com'], path: '/patchnotes', pathMatch: 'exact', category: 'official_updates', currentness: 'current_index', durableAllowed: false, autoStoreAllowed: false, metadataAdapter: 'swtor-patch-index-v1' },
  { id: 'swtor-patch-article', game: 'Star Wars: The Old Republic', hosts: ['www.swtor.com', 'swtor.com'], path: '/patchnotes/', pathMatch: 'prefix', category: 'official_updates', currentness: 'article', durableAllowed: true, autoStoreAllowed: true },
  { id: 'destiny-news-article', game: 'Destiny 2', hosts: ['www.bungie.net'], path: '/7/en/News/Article/', pathMatch: 'prefix', category: 'official_updates', currentness: 'article', durableAllowed: true, autoStoreAllowed: true },
  { id: 'wow-news-article', game: 'World of Warcraft', hosts: ['worldofwarcraft.blizzard.com'], path: '/en-us/news/', pathMatch: 'prefix', category: 'official_updates', currentness: 'article', durableAllowed: true, autoStoreAllowed: true },
  { id: 'elden-ring-update-index', game: 'Elden Ring', hosts: ['en.bandainamcoent.eu'], path: '/elden-ring/elden-ring/news', pathMatch: 'exact', category: 'official_updates', currentness: 'current_index', durableAllowed: false, autoStoreAllowed: false, metadataAdapter: 'bandai-news-index-v1', currentnessArticleRuleIds: ['elden-ring-news'] },
  { id: 'elden-ring-news', game: 'Elden Ring', hosts: ['en.bandainamcoent.eu'], path: '/elden-ring/news/', pathMatch: 'prefix', category: 'official_updates', currentness: 'article', durableAllowed: true, autoStoreAllowed: true, metadataAdapter: 'bandai-patch-article-v1' },
  { id: 'wow-specialist', game: 'World of Warcraft', hosts: ['www.icy-veins.com', 'icy-veins.com'], path: '/wow/', pathMatch: 'prefix', category: 'specialist_guide', currentness: 'none', durableAllowed: true, autoStoreAllowed: false },
  { id: 'bg3-community-wiki', game: "Baldur's Gate 3", hosts: ['bg3.wiki'], path: '/wiki/', pathMatch: 'prefix', category: 'community', currentness: 'none', durableAllowed: true, autoStoreAllowed: false }
]);

export interface GamingSourcePolicyAssessment {
  policyVersion: typeof GAMING_SOURCE_POLICY_VERSION;
  ruleId?: string;
  category: GamingSourceCategory;
  authority: GamingSourceAuthority;
  currentness: GamingSourceCurrentness;
  durableAllowed: boolean;
  autoStoreAllowed: boolean;
}

/** Does not replace the resolver's DNS, redirect, credential, query, and transport checks. */
export function assessGamingSourcePolicy(url: string, game: string,
  rules: readonly GamingReviewedSourceRule[] = REVIEWED_GAMING_SOURCE_RULES): GamingSourcePolicyAssessment {
  const fallback: GamingSourcePolicyAssessment = { policyVersion: GAMING_SOURCE_POLICY_VERSION,
    category: 'unreviewed', authority: 'unreviewed', currentness: 'none', durableAllowed: true, autoStoreAllowed: false };
  let parsed: URL;
  try { parsed = new URL(url); } catch { return { ...fallback, durableAllowed: false }; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')
    || /%(?:2f|5c|2e)/iu.test(parsed.pathname) || parsed.pathname.includes('\\')) return { ...fallback, durableAllowed: false };
  const identity = normalizeGamingGameIdentity(game);
  const rule = rules.slice(0, 100).find(candidate => normalizeGamingGameIdentity(candidate.game) === identity
    && candidate.hosts.includes(parsed.hostname.toLowerCase())
    && (candidate.currentness !== 'current_index' || !parsed.search)
    && (candidate.pathMatch === 'exact' ? parsed.pathname === candidate.path
      : candidate.path.endsWith('/') && parsed.pathname.startsWith(candidate.path)));
  if (!rule) return fallback;
  const authority: GamingSourceAuthority = rule.category.startsWith('official_') ? 'official'
    : rule.category === 'specialist_guide' ? 'specialist' : rule.category === 'community' ? 'community' : 'unreviewed';
  const durableAllowed = rule.durableAllowed && rule.category !== 'official_status' && rule.currentness !== 'live_status';
  return { policyVersion: GAMING_SOURCE_POLICY_VERSION, ruleId: rule.id, category: rule.category, authority,
    currentness: rule.currentness, durableAllowed,
    autoStoreAllowed: durableAllowed && rule.autoStoreAllowed && authority === 'official' };
}

export interface GamingFreshnessEvidence extends GamingSourcePolicyAssessment {
  id: string;
  url: string;
  game: string;
  edition?: string;
  platforms?: string[];
  regions?: string[];
  publishedAt?: string;
  sourceUpdatedAt?: string;
  fetchedAt: string;
  /** Time at which the backend examined this resource, not its publication date. */
  verifiedAt?: string;
  effectiveFrom?: string;
  effectiveUntil?: string;
  patch?: string;
  /** Patch identity and an independently named hotfix/build are separate. */
  build?: string;
  season?: string;
  currentPatch?: string;
  currentBuild?: string;
  currentSeason?: string;
  metadataConfidence: 'unknown' | 'content_extracted';
  /** Explicit source assertions only; absence from a hotfix is not baseline proof. */
  baselineForPatches?: string[];
  baselineForBuilds?: string[];
  supersedesPatches?: string[];
  supersedesBuilds?: string[];
  /** Closed source assertions, e.g. "Mechanic: beam damage = 20"; not arbitrary prose inference. */
  mechanicValues?: Record<string, string>;
  metadataConflict?: boolean;
  metadataUnverified?: boolean;
  /** Deterministic reviewed adapter output. Cached proof still expires at the normal freshness deadline. */
  currentnessMetadata?: GamingCurrentnessAdapterResult;
}

const normalized = (value: string): string => value.normalize('NFKC').trim().toLowerCase();
const same = (left: string | undefined, right: string | undefined): boolean => Boolean(left && right && normalized(left) === normalized(right));
const timestamp = (value: string | undefined): number | undefined => {
  if (!value || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/u.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value.slice(0, 10) ? parsed : undefined;
};
const dateValue = (value: string | undefined): string | undefined => {
  const parsed = timestamp(value);
  return parsed === undefined ? undefined : new Date(parsed).toISOString();
};

/** Question policy is conservative even when an explicit client mode says "guide". */
export function classifyGamingQuestionFreshness(input: { prompt: string; mode?: string; requestedVersion?: string }): GamingQuestionFreshness {
  const prompt = input.prompt.slice(0, 8_000);
  if (/\b(?:server\s+(?:status|outage|maintenance|down)|servers?\s+(?:are\s+)?(?:down|offline)|outage|login\s+(?:issues?|problems?)|maintenance\s+(?:now|today)|live\s+status|current\s+event\s+status)\b/iu.test(prompt)) return 'live_status';
  if (/\b(?:season|seasonal|battle\s+pass|current\s+league)\b/iu.test(prompt)) return 'seasonal';
  // Strength questions occur in either order ("best build" / "which build is best").
  // Keep ordinary routes and puzzles stable unless their own question needs freshness.
  const combatSubject = /\b(?:weapons?|builds?|class(?:es)?|loadouts?|talents?|equipment|skills?|abilit(?:y|ies)|gear|armou?r|rotations?)\b/iu.test(prompt);
  const effectivenessOrTime = /\b(?:best|better|strong(?:est|er)?|weak(?:est|er)?|effective(?:ness)?|powerful|optimal|viab(?:le|ility)|top|good|today|currently|now)\b/iu.test(prompt);
  if (input.requestedVersion || input.mode === 'meta' || input.mode === 'build' || (combatSubject && effectivenessOrTime)
    || /\b(?:patch|hotfix|balance|nerf|buff|meta|viable|latest|current(?!\s+(?:area|checkpoint|location|objective|progress|quest)\b)|right\s+now|dps|damage\s+(?:value|number)|weapon\s+effectiveness|(?:best|strongest)\s+(?:weapon|build|class|loadout|talent|equipment))\b/iu.test(prompt)) return 'patch_sensitive';
  return 'stable';
}

/**
 * Reads only fetched text. Dates from footers, HTTP Last-Modified, and frontend hints
 * cannot establish current applicability. Unsupported page layouts stay unverified.
 */
export function extractGamingFreshnessMetadata(document: { publicUrl: string; canonicalUrl?: string; text: string; metadata?: { title?: string; headings?: string }; evidenceUnits?: readonly GamingEvidenceUnit[]; metrics?: { truncated?: boolean; instructionFiltered?: boolean }; currentnessDocument?: GamingCurrentnessDocumentMetadata },
  context: { game: string; edition?: string; platform?: string; region?: string }, now = new Date(),
  rules: readonly GamingReviewedSourceRule[] = REVIEWED_GAMING_SOURCE_RULES): GamingFreshnessEvidence {
  // Citation redaction may shorten a path; only the acquired identity grants publisher policy.
  const policy = assessGamingSourcePolicy(document.canonicalUrl ?? document.publicUrl, context.game, rules);
  const evidenceUnits = readGamingEvidenceUnits(document.evidenceUnits, undefined, document.text);
  let proseText = document.text;
  for (const unit of evidenceUnits) proseText = proseText.replace(unit.text, '');
  const metadataText = proseText.slice(0, GAMING_FRESHNESS_DEFAULTS.maxMetadataChars);
  // The shared document instruction filter normalizes whitespace. Recover only
  // this closed label grammar; do not infer metadata from arbitrary date mentions.
  const labels = 'Game|Edition|Platforms?|Regions?|Published at|Source updated at|Effective from|Effective until|Patch|Build|Season|Current patch|Current build|Current season|Baseline valid for patches|Baseline valid for builds|Supersedes patches|Supersedes builds|Mechanic';
  const lines = metadataText.replace(new RegExp(`(?:^|\\s)(${labels}):\\s*`, 'giu'), '\n$1: ')
    .split(/\r?\n/u).slice(0, 500).map(line => line.split(/\.(?=\s+[A-Z])/u)[0].trim().replace(/\.$/u, ''));
  // Read explicit fields as individual source assertions. Record labels such as
  // Mechanic and Build do not become the separate prose metadata grammar.
  const structuralLabel = /^(?:Game|Edition|Platforms?|Regions?|Published at|Source updated at|Effective from|Effective until|Patch|Season|Current patch|Current build|Current season|Baseline valid for patches|Baseline valid for builds|Supersedes patches|Supersedes builds)$/iu;
  for (const unit of evidenceUnits) if (unit.integrity.status === 'complete') for (const field of unit.fields) {
    const leaf = field.label.split(/\s+\/\s+/u).at(-1)!;
    if (structuralLabel.test(leaf) && lines.length < 500) lines.push(`${leaf}: ${field.value}`);
  }
  let conflict = false;
  let invalidMetadata = false;
  const label = (name: string, max = 80): string | undefined => {
    const pattern = new RegExp(`^\\s*(?:${name}):\\s*([^\\r\\n]*)$`, 'iu');
    const claims = lines.flatMap(line => { const match = pattern.exec(line); return match ? [match[1].trim()] : []; });
    // A recognized but empty/overlong assertion is uncertainty, not an absent restriction.
    if (claims.some(value => value.length === 0 || value.length > max)) invalidMetadata = true;
    const values = [...new Set(claims.filter(value => value.length > 0 && value.length <= max))];
    if (values.length > 1) conflict = true;
    return values.length === 1 ? values[0] : undefined;
  };
  const boundedList = (value: string | undefined): string[] | undefined => {
    if (value === undefined) return undefined;
    const values = value.split(',').map(item => item.trim());
    // A malformed or incomplete restriction cannot become unspecified/global scope.
    if (values.length > 8 || values.some(item => item.length === 0 || item.length > 80)) {
      invalidMetadata = true;
      return undefined;
    }
    return values;
  };
  const game = label('Game', 160) ?? context.game;
  const edition = label('Edition', 120);
  let platforms = boundedList(label('Platforms?', 256));
  let regions = boundedList(label('Regions?', 256));
  const rawPublishedAt = label('Published at');
  const rawSourceUpdatedAt = label('Source updated at');
  const rawEffectiveFrom = label('Effective from');
  const rawEffectiveUntil = label('Effective until');
  let publishedAt = dateValue(rawPublishedAt);
  const sourceUpdatedAt = dateValue(rawSourceUpdatedAt);
  let effectiveFrom = dateValue(rawEffectiveFrom);
  const effectiveUntil = dateValue(rawEffectiveUntil);
  let invalidDate = [[rawPublishedAt, publishedAt], [rawSourceUpdatedAt, sourceUpdatedAt],
    [rawEffectiveFrom, effectiveFrom], [rawEffectiveUntil, effectiveUntil]].some(([raw, parsed]) => Boolean(raw && !parsed));
  let patch = label('Patch');
  let build = label('Build');
  const season = label('Season');
  // Only a reviewed index adapter may attest that an opaque patch ID is current.
  let currentPatch = policy.currentness === 'current_index' ? label('Current patch') : undefined;
  let currentBuild = policy.currentness === 'current_index' ? label('Current build') : undefined;
  let currentSeason = policy.currentness === 'current_index' ? label('Current season') : undefined;
  const baselineForPatches = boundedList(label('Baseline valid for patches', 256));
  const baselineForBuilds = boundedList(label('Baseline valid for builds', 256));
  const supersedesPatches = policy.authority === 'official' ? boundedList(label('Supersedes patches', 256)) : undefined;
  const supersedesBuilds = policy.authority === 'official' ? boundedList(label('Supersedes builds', 256)) : undefined;
  const mechanicValues: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const line of lines) {
    if (!/^Mechanic:/iu.test(line)) continue;
    const match = /^Mechanic:\s*([\p{L}][\p{L}\p{N} _/-]{1,63})\s*=\s*(-?\d{1,9}(?:\.\d{1,4})?)\s*(%|ms|s|seconds?|minutes?|damage|points?)?$/iu.exec(line);
    if (!match || Object.keys(mechanicValues).length >= 16) { invalidMetadata = true; continue; }
    const key = normalized(match[1]).replace(/\s+/gu, ' ');
    const unit = normalized(match[3] ?? '').replace(/^seconds?$/u, 's').replace(/^minutes?$/u, 'min').replace(/^points?$/u, 'points');
    const value = `${Number(match[2])}${unit}`;
    if (mechanicValues[key] !== undefined && mechanicValues[key] !== value) conflict = true;
    mechanicValues[key] = value;
  }
  const rule = rules.find(item => item.id === policy.ruleId);
  const currentnessMetadata = rule && policy.authority === 'official' && (rule.metadataAdapter || rule.currentness === 'current_index')
    ? runGamingCurrentnessAdapter({ document, rule, game: context.game, now, metadataConflict: conflict,
      metadataUnverified: invalidDate || invalidMetadata, fields: { patch, build, season, currentPatch, currentBuild,
        currentSeason, effectiveFrom, effectiveUntil, publishedAt, platforms, regions } }) : undefined;
  if (currentnessMetadata) {
    const contradictoryAdapterFields = [[patch, currentnessMetadata.patch], [build, currentnessMetadata.build],
      [currentPatch, currentnessMetadata.currentPatch], [currentBuild, currentnessMetadata.currentBuild]]
      .some(([claim, extracted]) => claim && extracted && !same(claim, extracted));
    if (contradictoryAdapterFields) {
      currentnessMetadata.status = 'conflicting';
      currentnessMetadata.reasons = ['CONTRADICTORY_ADAPTER_METADATA'];
    }
    patch = currentnessMetadata.patch ?? patch;
    build = currentnessMetadata.build ?? build;
    currentPatch = currentnessMetadata.currentPatch;
    currentBuild = currentnessMetadata.currentBuild;
    currentSeason = currentnessMetadata.currentSeason;
    effectiveFrom = currentnessMetadata.effectiveFrom ?? effectiveFrom;
    publishedAt = currentnessMetadata.publishedAt ?? publishedAt;
    platforms = currentnessMetadata.platforms ?? platforms ?? (rule?.platforms ? [...rule.platforms] : undefined);
    regions = currentnessMetadata.regions ?? regions ?? (rule?.regions ? [...rule.regions] : undefined);
    conflict ||= currentnessMetadata.status === 'conflicting';
    const pendingArticle = currentnessMetadata.status === 'incomplete' && Boolean(currentnessMetadata.requiredArticlePatch)
      && currentnessMetadata.reasons.every(reason => ['OFFICIAL_PATCH_ARTICLE_REQUIRED', 'HOTFIX_BUILD_CHECK_REQUIRED'].includes(reason));
    // A valid index waiting for its companion article is a usable source in that role.
    // Its separate adapter status still prevents any currentness success until corroborated.
    invalidMetadata ||= policy.currentness === 'current_index' && currentnessMetadata.status !== 'verified' && !pendingArticle;
  }
  // Date/version claims remain source claims; currentness additionally needs an official index.
  const patchArticle = /\b(?:patch\s+notes?|hotfix|game\s+update|update\s+\d)\b/iu.test(document.metadata?.title ?? '');
  const autoStoreAllowed = policy.autoStoreAllowed && policy.category === 'official_updates'
    && patchArticle && Boolean(patch || build) && Boolean(publishedAt || effectiveFrom) && !conflict && !invalidDate && !invalidMetadata;
  return { ...policy, autoStoreAllowed, id: document.publicUrl, url: document.publicUrl, game, ...(edition ? { edition } : {}),
    ...(platforms?.length ? { platforms } : {}), ...(regions?.length ? { regions } : {}),
    fetchedAt: now.toISOString(), verifiedAt: now.toISOString(),
    ...(publishedAt ? { publishedAt } : {}), ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
    ...(effectiveFrom ? { effectiveFrom } : {}), ...(effectiveUntil ? { effectiveUntil } : {}),
    ...(patch ? { patch } : {}), ...(season ? { season } : {}),
    ...(build ? { build } : {}), ...(currentBuild ? { currentBuild } : {}),
    ...(currentPatch ? { currentPatch } : {}), ...(currentSeason ? { currentSeason } : {}),
    ...(baselineForPatches?.length ? { baselineForPatches } : {}), ...(supersedesPatches?.length ? { supersedesPatches } : {}),
    ...(baselineForBuilds?.length ? { baselineForBuilds } : {}),
    ...(supersedesBuilds?.length ? { supersedesBuilds } : {}),
    ...(Object.keys(mechanicValues).length ? { mechanicValues } : {}),
    ...(conflict ? { metadataConflict: true } : {}),
    ...(invalidDate || invalidMetadata ? { metadataUnverified: true } : {}),
    ...(currentnessMetadata ? { currentnessMetadata } : {}),
    metadataConfidence: patch || build || season || effectiveFrom ? 'content_extracted' : 'unknown' };
}

export interface GamingFreshnessEvaluationInput {
  question: string;
  game: string;
  edition?: string;
  platform?: string;
  region?: string;
  mode?: string;
  requestedVersion?: string;
  evidence: readonly GamingFreshnessEvidence[];
  now?: Date;
}

export interface GamingFreshnessEvaluation {
  policyVersion: typeof GAMING_FRESHNESS_POLICY_VERSION;
  classification: GamingQuestionFreshness;
  status: GamingFreshnessStatus;
  usable: boolean;
  selectedEvidenceIds: string[];
  reasons: string[];
  verifiedAsOf?: string;
  effectivePatch?: string;
  effectiveBuild?: string;
  season?: string;
  qualification: string;
  /** Source quality stays separate from explicit guide/update compatibility. */
  guideApplicability?: GamingGuideApplicability[];
}

/** A season identity alone cannot verify balance/build claims within that season. */
export function gamingSeasonalPatchRequired(input: Pick<GamingFreshnessEvaluationInput, 'question' | 'mode' | 'requestedVersion'>): boolean {
  return classifyGamingQuestionFreshness({ prompt: input.question, mode: input.mode, requestedVersion: input.requestedVersion }) === 'seasonal'
    && classifyGamingQuestionFreshness({
    prompt: input.question.replace(/\b(?:(?:current|latest)\s+)?(?:season(?:al)?|battle\s+pass|league)\b/giu, ' '),
    mode: input.mode, requestedVersion: input.requestedVersion
  }) === 'patch_sensitive';
}

/** Freshness never substitutes for the caller's independent relevance/sufficiency selection. */
export function evaluateGamingFreshness(input: GamingFreshnessEvaluationInput): GamingFreshnessEvaluation {
  const classification = classifyGamingQuestionFreshness({ prompt: input.question, mode: input.mode, requestedVersion: input.requestedVersion });
  const seasonalPatchRequired = gamingSeasonalPatchRequired(input);
  const now = (input.now ?? new Date()).getTime();
  const historical = /\b(?:as\s+of|historical|previous\s+patch|old\s+patch)\b/iu.test(input.question);
  let guideApplicability: GamingGuideApplicability[] | undefined;
  const gameplayEvidence = input.evidence.slice(0, GAMING_FRESHNESS_DEFAULTS.maxEvidence).filter(isGamingGameplayFreshnessEvidence);
  const result = (status: GamingFreshnessStatus, reasons: string[], selected: readonly GamingFreshnessEvidence[] = [], extra: Partial<GamingFreshnessEvaluation> = {}): GamingFreshnessEvaluation => ({
    policyVersion: GAMING_FRESHNESS_POLICY_VERSION, classification, status, usable: status === 'current',
    selectedEvidenceIds: selected.map(item => item.id), reasons,
    qualification: status === 'current' ? classification === 'stable' ? 'Source applicability was checked; gameplay coverage is evaluated separately.' : 'Applies only to the verified update, time, platform, and region.'
      : 'Current applicability has not been established; do not present these claims as current.',
    ...(classification !== 'stable' && !historical && gameplayEvidence.length ? { guideApplicability: guideApplicability ?? gameplayEvidence.map(item => ({
      evidenceId: item.id, status: 'unverified' as const, reasons: reasons.slice(0, 8)
    })) } : {}), ...extra
  });
  if (!Number.isFinite(now)) return result('unverified', ['INVALID_VERIFICATION_TIME']);
  if (input.evidence.length > GAMING_FRESHNESS_DEFAULTS.maxEvidence) return result('unverified', ['EVIDENCE_LIMIT_EXCEEDED']);
  if (!input.evidence.length) return result('unverified', ['NO_EVIDENCE']);
  // An explicit historical patch is a different applicability target from today's
  // release. A date-only request still needs a reviewed version/date mapping.
  if (historical && (!input.requestedVersion || /\bas\s+of\s+\d{4}-\d{2}-\d{2}\b/iu.test(input.question)))
    return result('unverified', ['HISTORICAL_AS_OF_UNSUPPORTED']);
  const reasons = new Set<string>();
  let conflictingOfficialCurrentness = false;
  const scoped = combineGamingCurrentnessEvidence(input.evidence, new Date(now)).filter(item => {
    if (normalizeGamingGameIdentity(item.game) !== normalizeGamingGameIdentity(input.game)) { reasons.add('GAME_MISMATCH'); return false; }
    if (input.edition && !same(item.edition, input.edition)) { reasons.add('EDITION_UNVERIFIED_OR_MISMATCH'); return false; }
    if (!input.edition && item.edition) { reasons.add('EDITION_REQUIRED'); return false; }
    if (input.platform && item.platforms?.length && !item.platforms.some(platform => same(platform, input.platform) || same(platform, 'all'))) { reasons.add('PLATFORM_MISMATCH'); return false; }
    if (!input.platform && item.platforms?.length && !item.platforms.some(platform => same(platform, 'all'))) { reasons.add('PLATFORM_REQUIRED'); return false; }
    if (input.region && item.regions?.length && !item.regions.some(region => same(region, input.region) || same(region, 'all'))) { reasons.add('REGION_MISMATCH'); return false; }
    if (!input.region && item.regions?.length && !item.regions.some(region => same(region, 'all'))) { reasons.add('REGION_REQUIRED'); return false; }
    const from = timestamp(item.effectiveFrom);
    const until = timestamp(item.effectiveUntil);
    const published = timestamp(item.publishedAt);
    if ((from !== undefined && from > now) || (published !== undefined && published > now)) { reasons.add('NOT_YET_EFFECTIVE'); return false; }
    if (!historical && until !== undefined && until <= now) { reasons.add('NO_LONGER_EFFECTIVE'); return false; }
    if (item.metadataConflict || item.currentnessMetadata?.status === 'conflicting') {
      reasons.add('CONTRADICTORY_SOURCE_METADATA');
      if (item.authority === 'official' && item.category === 'official_updates') conflictingOfficialCurrentness = true;
      return false;
    }
    if (item.metadataUnverified) { reasons.add('APPLICABILITY_METADATA_UNVERIFIED'); return false; }
    if (item.policyVersion !== GAMING_SOURCE_POLICY_VERSION) { reasons.add('SOURCE_POLICY_REVALIDATION_REQUIRED'); return false; }
    return true;
  });
  // An applicable official contradiction cannot disappear merely because another
  // index agrees with a guide. Historical and static evidence retain their own scope.
  if (conflictingOfficialCurrentness && !historical && (classification === 'patch_sensitive' || classification === 'seasonal'))
    return result('conflicting', ['CONFLICTING_CURRENTNESS', ...reasons]);
  if (!scoped.length) return result(reasons.has('CONTRADICTORY_SOURCE_METADATA') ? 'conflicting' : 'not_applicable', [...reasons]);
  const recent = (item: GamingFreshnessEvidence, age: number): boolean => {
    const checked = timestamp(item.verifiedAt);
    const fetched = timestamp(item.fetchedAt);
    return checked !== undefined && fetched !== undefined && checked <= now && fetched <= checked && now - checked <= age;
  };
  const oldestVerification = (items: readonly GamingFreshnessEvidence[]): string => new Date(Math.min(...items.map(item => timestamp(item.verifiedAt)!))).toISOString();
  if (historical) {
    const matching = scoped.filter(item => item.currentness !== 'current_index'
      && item.metadataConfidence === 'content_extracted' && same(item.patch, input.requestedVersion)
      && timestamp(item.verifiedAt) !== undefined && timestamp(item.verifiedAt)! <= now
      && timestamp(item.fetchedAt) !== undefined && timestamp(item.fetchedAt)! <= timestamp(item.verifiedAt)!
      && (!input.platform || item.platforms?.some(platform => same(platform, input.platform) || same(platform, 'all')))
      && (!input.region || item.regions?.some(region => same(region, input.region) || same(region, 'all'))));
    if (!matching.length) return result('unverified', [...reasons, 'HISTORICAL_PATCH_COVERAGE_MISSING']);
    if (new Set(matching.flatMap(item => item.build ? [normalized(item.build)] : [])).size > 1)
      return result('conflicting', [...reasons, 'HISTORICAL_BUILD_APPLICABILITY_CONFLICT']);
    const claims = new Map<string, string>();
    for (const item of matching) for (const [key, value] of Object.entries(item.mechanicValues ?? {}).slice(0, 16)) {
      if (claims.has(key) && claims.get(key) !== value) return result('conflicting', [...reasons, 'EXPLICIT_MECHANIC_VALUE_CONFLICT']);
      claims.set(key, value);
    }
    return result('current', [...reasons, 'HISTORICAL_PATCH_APPLICABILITY_VERIFIED'], matching, {
      effectivePatch: input.requestedVersion, verifiedAsOf: oldestVerification(matching),
      qualification: 'Applies only to the explicitly requested historical patch; this is not a claim that the patch is currently active.'
    });
  }
  if (classification === 'stable') {
    const usable = scoped.filter(item => recent(item, GAMING_FRESHNESS_DEFAULTS.stable));
    return usable.length ? result('current', [...reasons, 'STABLE_EVIDENCE_CHECKED'], usable, { verifiedAsOf: oldestVerification(usable) })
      : result('stale', [...reasons, 'REVALIDATION_DUE']);
  }
  // Operational status always comes from a recent live official status document and is transient.
  if (classification === 'live_status') {
    const statuses = scoped.filter(item => item.authority === 'official' && item.currentness === 'live_status'
      && item.category === 'official_status' && recent(item, GAMING_FRESHNESS_DEFAULTS.live_status)
      && timestamp(item.sourceUpdatedAt) !== undefined && now - timestamp(item.sourceUpdatedAt)! >= 0
      && now - timestamp(item.sourceUpdatedAt)! <= GAMING_FRESHNESS_DEFAULTS.live_status);
    return statuses.length ? result('current', [...reasons, 'LIVE_STATUS_VERIFIED'], statuses, { verifiedAsOf: oldestVerification(statuses) })
      : result('unverified', [...reasons, 'LIVE_OFFICIAL_STATUS_REQUIRED']);
  }
  const indexes = scoped.filter(item => item.authority === 'official' && item.currentness === 'current_index'
    && (!item.currentnessMetadata || item.currentnessMetadata.status === 'verified'
      && item.currentnessMetadata.adapterVersion === GAMING_CURRENTNESS_ADAPTER_VERSION)
    && item.metadataConfidence === 'content_extracted' && recent(item, GAMING_FRESHNESS_DEFAULTS[classification])
    && (!input.platform || item.platforms?.some(platform => same(platform, input.platform) || same(platform, 'all')))
    && (!input.region || item.regions?.some(region => same(region, input.region) || same(region, 'all')))
    && timestamp(item.effectiveFrom) !== undefined && (classification === 'seasonal' ? item.currentSeason : item.currentPatch)
    && (!seasonalPatchRequired || item.currentPatch));
  if (!indexes.length) {
    const outdatedIndex = scoped.some(item => item.authority === 'official' && item.currentness === 'current_index'
      && !recent(item, GAMING_FRESHNESS_DEFAULTS[classification]));
    return result(outdatedIndex ? 'stale' : 'unverified', [...reasons, outdatedIndex ? 'REVALIDATION_DUE' : 'CURRENT_OFFICIAL_INDEX_REQUIRED']);
  }
  const versions = new Set(indexes.map(item => [classification === 'seasonal' ? item.currentSeason : '', item.currentPatch,
    item.currentBuild ?? ''].map(value => normalized(value ?? '')).join('|')));
  if (versions.size !== 1) return result('conflicting', [...reasons, 'OFFICIAL_CURRENT_APPLICABILITY_CONFLICT']);
  const index = indexes[0];
  const patch = index.currentPatch;
  const build = index.currentBuild;
  const season = classification === 'seasonal' ? index.currentSeason : undefined;
  if (input.requestedVersion && !same(input.requestedVersion, patch)) return result('not_applicable', [...reasons, 'REQUESTED_PATCH_NOT_CURRENT', 'HISTORICAL_AS_OF_UNSUPPORTED']);
  const currentOfficialEvidence = scoped.filter(item => item.authority === 'official'
    && (item.currentness === 'current_index' || (!patch || same(item.patch, patch))
      && (!build || same(item.build, build) || item.baselineForBuilds?.some(value => same(value, build)))));
  guideApplicability = gameplayEvidence.map(guide => {
    const applicability = evaluateGamingGuideApplicability({ guide, game: input.game,
      edition: input.edition, platform: input.platform, region: input.region, currentness: index,
      officialEvidence: currentOfficialEvidence, now: new Date(now) });
    // A matching version cannot restore an artifact excluded by source policy or scope.
    return applicability.status === 'verified_current' && !scoped.some(item => item.id === guide.id)
      ? { ...applicability, status: 'unverified' as const, reasons: [...reasons].slice(0, 8) } : applicability;
  });
  if (guideApplicability.some(guide => guide.reasons.includes('CURRENT_UPDATE_CHANGES_GUIDE_MECHANIC'))) reasons.add('LOWER_AUTHORITY_CONFLICT_EXCLUDED');
  // A source describing another patch is not mixed into a current recommendation.
  // Explicit baseline applicability can preserve selected unchanged facts, never an entire old corpus.
  const matching = scoped.filter(item => {
    if (item.currentness === 'current_index') return false;
    if (isGamingGameplayFreshnessEvidence(item)) return guideApplicability!.some(guide => guide.evidenceId === item.id && guide.status === 'verified_current');
    if (input.platform && !item.platforms?.some(platform => same(platform, input.platform) || same(platform, 'all'))) return false;
    if (input.region && !item.regions?.some(region => same(region, input.region) || same(region, 'all'))) return false;
    if (build && !same(item.build, build) && !item.baselineForBuilds?.some(value => same(value, build))) return false;
    return item.metadataConfidence === 'content_extracted' && (!season || same(item.season, season))
      && (!patch || same(item.patch, patch) || Boolean(item.baselineForPatches?.some(value => same(value, patch))));
  });
  // Same-patch contradictory official metadata is rejected; numeric IDs never determine precedence.
  const currentOfficial = matching.filter(item => item.authority === 'official');
  const superseded = new Set(currentOfficial.flatMap(item => item.supersedesPatches?.map(normalized) ?? []));
  const supersededBuilds = new Set(currentOfficial.flatMap(item => item.supersedesBuilds?.map(normalized) ?? []));
  let selected = matching.filter(item => (!item.build || !supersededBuilds.has(normalized(item.build)))
    && (!item.patch || !superseded.has(normalized(item.patch))
      || Boolean(patch && item.baselineForPatches?.some(value => same(value, patch)))));
  const remainingBuilds = new Set(selected.flatMap(item => item.build ? [normalized(item.build)] : []));
  if (!build && remainingBuilds.size > 1) return result('conflicting', [...reasons, 'CURRENT_BUILD_APPLICABILITY_CONFLICT']);
  // A single observed build, even an official superseding article, does not prove
  // that no later hotfix is active. Latest-build identity must come from the index.
  if (!build && (remainingBuilds.size === 1 || selected.some(item => item.baselineForBuilds?.length)))
    return result('unverified', [...reasons, 'CURRENT_BUILD_UNVERIFIED']);
  // Explicit same-mechanic numeric claims are comparable; arbitrary prose still
  // requires source-specific interpretation and is not silently asserted conflict-free.
  const authorityRank = { official: 3, specialist: 2, community: 1, unreviewed: 0 } as const;
  const claims = new Map<string, { rank: number; value: string }>();
  const lowerAuthorityConflicts = new Set<string>();
  for (const item of [...selected].sort((a, b) => authorityRank[b.authority] - authorityRank[a.authority])) {
    const mechanics = Object.entries(item.mechanicValues ?? {}).slice(0, 16);
    const rank = authorityRank[item.authority];
    // Reject the whole weaker source before any of its other claims enter comparison.
    if (mechanics.some(([key, value]) => {
      const prior = claims.get(key);
      return prior && prior.rank > rank && prior.value !== value;
    })) {
      lowerAuthorityConflicts.add(item.id);
      continue;
    }
    for (const [key, value] of mechanics) {
      const prior = claims.get(key);
      if (prior && prior.value !== value) {
        return result('conflicting', [...reasons, 'EXPLICIT_MECHANIC_VALUE_CONFLICT']);
      } else if (!prior) claims.set(key, { rank, value });
    }
  }
  if (lowerAuthorityConflicts.size) {
    selected = selected.filter(item => !lowerAuthorityConflicts.has(item.id));
    reasons.add('LOWER_AUTHORITY_CONFLICT_EXCLUDED');
  }
  if (gameplayEvidence.length && !guideApplicability.some(guide => guide.status === 'verified_current')) {
    const applicabilityStatus = guideApplicability.some(guide => guide.status === 'conflicting') ? 'conflicting'
      : guideApplicability.every(guide => guide.status === 'stale') ? 'stale' : 'unverified';
    return result(applicabilityStatus, [...reasons, 'CURRENT_PATCH_COVERAGE_MISSING',
      ...new Set(guideApplicability.flatMap(guide => guide.reasons))].slice(0, 16), [], {
      ...(patch ? { effectivePatch: patch } : {}), ...(build ? { effectiveBuild: build } : {}), ...(season ? { season } : {})
    });
  }
  if (!selected.length) return result('unverified', [...reasons, 'CURRENT_PATCH_COVERAGE_MISSING'], [], { ...(patch ? { effectivePatch: patch } : {}), ...(season ? { season } : {}) });
  return result('current', [...reasons, 'OFFICIAL_CURRENT_APPLICABILITY_VERIFIED', ...(scoped.length > selected.length + indexes.length ? ['INAPPLICABLE_PATCH_EVIDENCE_EXCLUDED'] : [])], [...selected, ...indexes],
    { verifiedAsOf: oldestVerification(indexes), ...(patch ? { effectivePatch: patch } : {}), ...(build ? { effectiveBuild: build } : {}), ...(season ? { season } : {}) });
}
