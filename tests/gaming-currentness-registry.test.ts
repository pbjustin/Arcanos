import { describe, expect, test } from '@jest/globals';
import { GAMING_CURRENTNESS_SOURCE_DATA } from '../src/shared/gaming/gamingCurrentnessSourceData.js';
import { GAMING_CURRENTNESS_SOURCE_REGISTRY, REVIEWED_GAMING_SOURCE_RULES, validateGamingCurrentnessSourceRegistry } from '../src/shared/gaming/gamingCurrentnessRegistry.js';
import { assessGamingSourcePolicy } from '../src/shared/gaming/gamingFreshnessCore.js';

const change = (index: number, fields: Record<string, unknown>, extraction?: Record<string, unknown>) => {
  const data = structuredClone(GAMING_CURRENTNESS_SOURCE_DATA);
  return { ...data, rules: data.rules.map((rule, position) => position === index ? {
    ...rule, ...fields, ...(extraction ? { metadataAdapterConfig: { ...rule.metadataAdapterConfig, ...extraction } } : {})
  } : rule) };
};

describe('reviewed Gaming currentness registry initialization', () => {
  test('validates and deeply freezes reviewed data, independently from the declarative artifact', () => {
    expect(validateGamingCurrentnessSourceRegistry(GAMING_CURRENTNESS_SOURCE_DATA)).toEqual(GAMING_CURRENTNESS_SOURCE_REGISTRY);
    expect(Object.isFrozen(GAMING_CURRENTNESS_SOURCE_REGISTRY)).toBe(true);
    expect(Object.isFrozen(REVIEWED_GAMING_SOURCE_RULES)).toBe(true);
    expect(Object.isFrozen(REVIEWED_GAMING_SOURCE_RULES[4].metadataAdapterConfig)).toBe(true);
    expect(Object.isFrozen(REVIEWED_GAMING_SOURCE_RULES[4].hosts)).toBe(true);
    expect(REVIEWED_GAMING_SOURCE_RULES).not.toBe(GAMING_CURRENTNESS_SOURCE_DATA.rules);
  });
  test.each([
    ['scheme in host', change(0, { hosts: ['http://swtor.com'] })],
    ['credentials in host', change(0, { hosts: ['user@swtor.com'] })],
    ['host wildcard', change(0, { hosts: ['*.swtor.com'] })],
    ['private literal host', change(0, { hosts: ['127.0.0.1'] })],
    ['private named host', change(0, { hosts: ['updates.localhost'] })],
    ['port in host', change(0, { hosts: ['swtor.com:444'] })],
    ['query in path', change(0, { path: '/patchnotes?latest=true' })],
    ['fragment in path', change(0, { path: '/patchnotes#latest' })],
    ['encoded separator', change(0, { path: '/patchnotes%2fsecret' })],
    ['normalized dot segment', change(0, { path: '/patchnotes/../private' })],
    ['relative path', change(0, { path: 'patchnotes' })],
    ['prefix lacking boundary', change(1, { path: '/patchnotes' })],
    ['duplicate rule ID', change(1, { id: 'swtor-patch-index' })],
    ['overlapping exact rule', change(1, { path: '/patchnotes', pathMatch: 'exact' })],
    ['overlapping prefix and exact rule', change(1, { path: '/', pathMatch: 'prefix' })],
    ['overlapping prefix rules', { version: 'gaming-currentness-sources/v1', rules: [GAMING_CURRENTNESS_SOURCE_DATA.rules[1],
      { ...GAMING_CURRENTNESS_SOURCE_DATA.rules[1], id: 'swtor-hotfix', path: '/patchnotes/hotfix/' }] }],
    ['unsupported adapter', change(0, { metadataAdapter: 'publisher-module-v1' })],
    ['missing extraction contract', change(4, { metadataAdapterConfig: undefined })],
    ['index without adapter', change(0, { metadataAdapter: undefined, metadataAdapterConfig: undefined })],
    ['arbitrary regex', change(4, {}, { releasePattern: '(a+)+$' })],
    ['arbitrary module', change(4, {}, { module: 'node:fs' })],
    ['unsafe CSS pseudo selector', change(4, {}, { cardsSelector: 'li:has(a)' })],
    ['malformed CSS selector', change(4, {}, { cardsSelector: 'ul[ > li' })],
    ['unbounded card count', change(4, {}, { pageSize: 4 })],
    ['unsupported date format', change(4, {}, { dateFormat: 'infer' })],
    ['arbitrary template slot', change(5, {}, { activeReleaseStatements: ['{execute}'] })],
    ['missing companion', change(4, { currentnessArticleRuleIds: ['missing-rule'] })],
    ['wrong-game companion', change(4, { currentnessArticleRuleIds: ['swtor-patch-article'] })],
    ['wrong-role companion', change(4, { currentnessArticleRuleIds: ['elden-ring-update-index'] })],
    ['article adapter assigned to index', change(4, { metadataAdapter: 'patch-article-v1' })],
    ['authority broadening', change(6, { authority: 'official' })],
    ['automatic specialist storage', change(6, { autoStoreAllowed: true })],
    ['durable live status', change(0, { category: 'official_status', currentness: 'live_status', durableAllowed: true })],
    ['transport control override', change(0, { maxBytes: 10_000_000 })]
  ])('rejects %s at runtime', (_label, registry) => {
    expect(() => validateGamingCurrentnessSourceRegistry(registry)).toThrow('Invalid Gaming currentness registry');
  });
  test('reviewed data may narrow authority while category and storage code retain their maximum', () => {
    const rules = validateGamingCurrentnessSourceRegistry(change(2, { authority: 'community', autoStoreAllowed: false })).rules;
    expect(assessGamingSourcePolicy('https://www.bungie.net/7/en/News/Article/release', 'Destiny 2', rules))
      .toMatchObject({ category: 'official_updates', authority: 'community', autoStoreAllowed: false });
    const specialist = REVIEWED_GAMING_SOURCE_RULES.find(rule => rule.id === 'wow-specialist')!;
    expect(assessGamingSourcePolicy('https://www.icy-veins.com/wow/guide', 'World of Warcraft', [{ ...specialist, authority: 'official', autoStoreAllowed: true }]))
      .toMatchObject({ authority: 'specialist', autoStoreAllowed: false });
  });
});
