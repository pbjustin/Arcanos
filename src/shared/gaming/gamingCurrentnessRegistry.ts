import { normalizeGamingGameIdentity } from './gamingGameIdentity.js';
import { sanitizeGamingSourceUrl } from './gamingSourceAcquisitionCore.js';
import { GAMING_CURRENTNESS_SOURCE_DATA } from './gamingCurrentnessSourceData.js';

import type { GamingSourceCategory, GamingSourceAuthority, GamingReviewedSourceRule, GamingCurrentnessSourceRegistry } from './gamingCurrentnessRegistryTypes.js';
export type * from './gamingCurrentnessRegistryTypes.js';

const AUTHORITY_RANK = { unreviewed: 0, community: 1, specialist: 2, official: 3 } as const;
export function gamingCategoryAuthority(category: GamingSourceCategory): GamingSourceAuthority {
  return category.startsWith('official_') ? 'official' : category === 'specialist_guide' ? 'specialist'
    : category === 'community' ? 'community' : 'unreviewed';
}
export function gamingRuleAuthority(rule: GamingReviewedSourceRule): GamingSourceAuthority {
  const maximum = gamingCategoryAuthority(rule.category);
  return rule.authority && AUTHORITY_RANK[rule.authority] <= AUTHORITY_RANK[maximum] ? rule.authority : maximum;
}

function fail(reason: string): never { throw new Error(`Invalid Gaming currentness registry: ${reason}`); }
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const literal = (value: unknown, max = 120): value is string => typeof value === 'string' && value.length > 0
  && value.length <= max && value === value.trim() && !/[\r\n\u0000-\u001f\u007f]/u.test(value);
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('unsupported configuration field');
}
function strings(value: unknown, max = 8): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= max && value.every(item => literal(item, 80))
    && new Set(value).size === value.length;
}
/** Deliberately small CSS grammar: no pseudo selectors, escapes, arbitrary attributes, or executable patterns. */
function selector(value: unknown): boolean {
  if (!literal(value, 160)) return false;
  return value.split(',').every(group => {
    const tokens = group.trim().split(/\s*(>)\s*|\s+/u).filter(Boolean);
    return tokens.length > 0 && tokens.length <= 8 && tokens.every((token, index) => token === '>'
      ? index > 0 && index < tokens.length - 1 && tokens[index - 1] !== '>' && tokens[index + 1] !== '>'
      : /^(?:[a-z][a-z0-9-]*)?(?:[.#][a-zA-Z_][a-zA-Z0-9_-]*)?(?:\[(?:role|id|class|href)(?:="[a-zA-Z0-9_-]+")?\])?$/u.test(token)
        && token.length > 0);
  });
}
function titleConfig(value: unknown): void {
  if (!record(value)) fail('release title contract required');
  keys(value, ['prefix', 'label', 'versionLabel']);
  if (![value.prefix, value.label, value.versionLabel].every(item => literal(item))) fail('invalid release title literals');
}
function adapterConfig(rule: GamingReviewedSourceRule): void {
  const config = rule.metadataAdapterConfig;
  if (rule.metadataAdapter === 'labeled-metadata-v1') {
    if (config !== undefined) fail('labeled metadata does not accept an extraction config');
    return;
  }
  if (!config || !record(config)) fail('extraction contract required');
  if (rule.metadataAdapter === 'dated-release-index-v1') {
    keys(config, ['kind', 'releaseLabel', 'dateFormat', 'allowLabeledFallback']);
    if (config.kind !== 'dated-release-index' || !literal(config.releaseLabel)
      || !['day/month/year', 'month/day/year'].includes(config.dateFormat)
      || typeof config.allowLabeledFallback !== 'boolean') fail('invalid dated release index contract');
  } else if (rule.metadataAdapter === 'article-index-v1') {
    keys(config, ['kind', 'pageTitle', 'pageText', 'releaseTitle', 'dateFormat', 'versionSemantics', 'headingSelector',
      'headingLabel', 'sectionSelector', 'cardsSelector', 'anchorSelector', 'titleSelector', 'dateSelector', 'pageSize']);
    if (config.kind !== 'article-index') fail('article index contract required');
    titleConfig(config.releaseTitle);
    if (![config.pageTitle, config.pageText, config.headingLabel].every(item => literal(item))
      || !['day/month/year', 'month/day/year', 'year-month-day'].includes(config.dateFormat)
      || !['opaque', 'app-regulation'].includes(config.versionSemantics)
      || !Number.isInteger(config.pageSize) || config.pageSize < 1 || config.pageSize > 3
      || ![config.headingSelector, config.sectionSelector, config.cardsSelector, config.anchorSelector,
        config.titleSelector, config.dateSelector].every(selector)) fail('invalid bounded article index contract');
    if (!rule.currentnessArticleRuleIds?.length) fail('article index companion contract required');
  } else if (rule.metadataAdapter === 'patch-article-v1') {
    keys(config, ['kind', 'releaseTitle', 'patchLabel', 'buildLabel', 'versionSemantics', 'platformSelector',
      'platformLabel', 'platforms', 'activeReleaseStatements', 'installedVersionCaption']);
    if (config.kind !== 'patch-article') fail('patch article contract required');
    titleConfig(config.releaseTitle);
    if (![config.patchLabel, config.buildLabel, config.platformLabel].every(item => literal(item))
      || config.patchLabel === config.buildLabel || !selector(config.platformSelector)
      || !['opaque', 'app-regulation'].includes(config.versionSemantics)
      || !Array.isArray(config.platforms) || !config.platforms.length || config.platforms.length > 8
      || !strings(config.activeReleaseStatements, 8)
      || config.activeReleaseStatements.some(statement => /[{}]/u.test(statement.replace(/\{(?:game|patch)\}/gu, '')))
      || config.installedVersionCaption !== undefined && !literal(config.installedVersionCaption)) fail('invalid patch article contract');
    const platformLabels = new Set<string>();
    for (const platform of config.platforms) {
      if (!record(platform)) fail('invalid platform contract');
      keys(platform, ['label', 'aliases']);
      if (!literal(platform.label, 80) || !Array.isArray(platform.aliases) || platform.aliases.length > 4
        || !platform.aliases.every(alias => literal(alias, 80)) || platformLabels.has(platform.label.toLowerCase())) fail('invalid platform contract');
      platformLabels.add(platform.label.toLowerCase());
    }
  } else fail('unsupported adapter type');
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

/** Runs on module initialization and in tests/build import checks. No config can name code, regexes, or transport limits. */
export function validateGamingCurrentnessSourceRegistry(value: unknown): GamingCurrentnessSourceRegistry {
  if (!record(value)) fail('object required');
  keys(value, ['version', 'rules']);
  if (value.version !== 'gaming-currentness-sources/v1' || !Array.isArray(value.rules)
    || !value.rules.length || value.rules.length > 100) fail('unsupported version or rule count');
  const rules = value.rules as GamingReviewedSourceRule[];
  const ids = new Set<string>();
  for (const rule of rules) {
    if (!record(rule)) fail('rule object required');
    keys(rule, ['id', 'game', 'hosts', 'path', 'pathMatch', 'category', 'authority', 'currentness', 'durableAllowed',
      'autoStoreAllowed', 'metadataAdapter', 'metadataAdapterConfig', 'currentnessArticleRuleIds', 'platforms', 'regions']);
    if (!literal(rule.id, 80) || !/^[a-z][a-z0-9-]*$/u.test(rule.id) || ids.has(rule.id)) fail('invalid or duplicate rule ID');
    ids.add(rule.id);
    if (!literal(rule.game, 160) || !strings(rule.hosts) || !literal(rule.path, 2_048)
      || !rule.path.startsWith('/') || rule.path.startsWith('//') || /[?#\\]|%(?:2f|5c|2e)/iu.test(rule.path)
      || !['exact', 'prefix'].includes(rule.pathMatch) || rule.pathMatch === 'prefix' && !rule.path.endsWith('/')) fail('invalid game/HTTPS hosts/path');
    for (const host of rule.hosts) {
      if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(host)
        || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) fail('invalid HTTPS host');
      const url = `https://${host}${rule.path}`;
      const admission = sanitizeGamingSourceUrl(url, 2_048);
      if (admission.rejected || admission.url !== url) fail('unsafe HTTPS source');
    }
    if (!['official_updates', 'official_status', 'official_documentation', 'specialist_guide', 'community', 'unreviewed'].includes(rule.category)
      || !['official', 'specialist', 'community', 'unreviewed'].includes(rule.authority ?? '')
      || !['current_index', 'article', 'live_status', 'none'].includes(rule.currentness)
      || typeof rule.durableAllowed !== 'boolean' || typeof rule.autoStoreAllowed !== 'boolean') fail('invalid source policy data');
    if (AUTHORITY_RANK[rule.authority!] > AUTHORITY_RANK[gamingCategoryAuthority(rule.category)]) fail('authority cannot broaden category policy');
    if (rule.autoStoreAllowed && (!rule.durableAllowed || rule.authority !== 'official' || rule.category !== 'official_updates')
      || (rule.currentness === 'live_status' || rule.category === 'official_status') && (rule.durableAllowed || rule.autoStoreAllowed)) fail('storage policy cannot broaden code controls');
    if (rule.platforms !== undefined && !strings(rule.platforms) || rule.regions !== undefined && !strings(rule.regions)
      || rule.currentnessArticleRuleIds !== undefined && !strings(rule.currentnessArticleRuleIds)) fail('invalid bounded scope/companion list');
    if (rule.metadataAdapter !== undefined) adapterConfig(rule);
    else if (rule.metadataAdapterConfig !== undefined || rule.currentness === 'current_index') fail('currentness index requires an extraction contract');
    if (rule.currentness === 'current_index' && (rule.category !== 'official_updates' || rule.pathMatch !== 'exact'
      || !['labeled-metadata-v1', 'dated-release-index-v1', 'article-index-v1'].includes(rule.metadataAdapter ?? ''))
      || rule.metadataAdapter === 'patch-article-v1' && rule.currentness !== 'article') fail('adapter/currentness role mismatch');
  }
  for (let index = 0; index < rules.length; index++) {
    const rule = rules[index];
    for (const other of rules.slice(index + 1)) {
      if (normalizeGamingGameIdentity(rule.game) !== normalizeGamingGameIdentity(other.game)
        || !rule.hosts.some(host => other.hosts.includes(host))) continue;
      if (rule.path === other.path || other.pathMatch === 'prefix' && rule.path.startsWith(other.path)
        || rule.pathMatch === 'prefix' && other.path.startsWith(rule.path)) fail('ambiguous overlapping source rules');
    }
    for (const id of rule.currentnessArticleRuleIds ?? []) {
      const article = rules.find(item => item.id === id);
      if (!article || article.currentness !== 'article' || article.category !== 'official_updates' || article.authority !== 'official'
        || normalizeGamingGameIdentity(article.game) !== normalizeGamingGameIdentity(rule.game)
        || rule.metadataAdapter === 'article-index-v1' && article.metadataAdapter !== 'patch-article-v1') fail('invalid companion reference');
    }
  }
  return freeze(structuredClone(value)) as unknown as GamingCurrentnessSourceRegistry;
}

export const GAMING_CURRENTNESS_SOURCE_REGISTRY = validateGamingCurrentnessSourceRegistry(GAMING_CURRENTNESS_SOURCE_DATA);
export const REVIEWED_GAMING_SOURCE_RULES = GAMING_CURRENTNESS_SOURCE_REGISTRY.rules;
