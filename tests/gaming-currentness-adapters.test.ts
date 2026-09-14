import { describe, expect, test } from '@jest/globals';
import { assessGamingSourcePolicy, extractGamingFreshnessMetadata, evaluateGamingFreshness } from '../src/shared/gaming/gamingFreshnessCore.js';
import { combineGamingCurrentnessEvidence, runGamingCurrentnessAdapter, GAMING_CURRENTNESS_LIMITS,
  type GamingCurrentnessAdapterRule } from '../src/shared/gaming/gamingCurrentnessAdapters.js';

const NOW = new Date('2026-09-09T12:00:00Z');
const INDEX_URL = 'https://en.bandainamcoent.eu/elden-ring/elden-ring/news';
const ARTICLE_URL = 'https://en.bandainamcoent.eu/elden-ring/news/elden-ring-patch-notes-version-110';
const indexText = (cards = 'Elden Ring – Patch Notes Version 1.10 2 Like 08/09/2026 Elden Ring – Patch Notes Version 1.9 1 Like 07/09/2026', count = 2) =>
  `Latest News on ELDEN RING. Patch Notes (${count}) ${cards} Load More Coming Soon (0)`;
const index = (text = indexText(), extra = {}) => extractGamingFreshnessMetadata({ publicUrl: INDEX_URL,
  text, metadata: { title: 'ELDEN RING news | Bandai Namco Europe' }, currentnessDocument: {
    ruleId: 'elden-ring-update-index', adapterId: 'bandai-news-index-v1', status: 'complete', rawContentHash: 'a'.repeat(64),
    categoryCount: Number(/Patch Notes \((\d+)\)/u.exec(text)?.[1]),
    cards: [...text.matchAll(/(Elden Ring [–-] .+?)(?:\s+\d+\s*Like)?\s*(\d{2}\/\d{2}\/\d{4})/gu)].map(match => ({
      title: match[1], publishedDate: match[2], url: `https://en.bandainamcoent.eu/elden-ring/news/elden-ring-patch-notes-version-${/Version ([\d.]+)/u.exec(match[1])?.[1].replace(/\./gu, '') ?? 'unknown'}`
    }))
  }, ...extra }, { game: 'Elden Ring' }, NOW);
const article = (text = 'Targeted Platforms PlayStation 4 / PlayStation 5 / Xbox One / Xbox Series X|S / Steam App Ver. 1.10 Regulation Ver. 1.10.1 This update is required for online play.', extra = {}) =>
  extractGamingFreshnessMetadata({ publicUrl: ARTICLE_URL, text, metadata: { title: 'Elden Ring – Patch Notes Version 1.10 | Bandai Namco Europe' },
    currentnessDocument: { ruleId: 'elden-ring-news', adapterId: 'bandai-patch-article-v1', status: 'complete', rawContentHash: 'b'.repeat(64),
      platformText: /Targeted Platforms (.+?) App Ver\./u.exec(text)?.[1] ?? '' }, ...extra }, { game: 'Elden Ring' }, NOW);

describe('reviewed publisher paths and a real-layout Elden Ring index', () => {
  test('only the exact unfiltered reviewed index qualifies; an article and lookalikes do not', () => {
    expect(assessGamingSourcePolicy(INDEX_URL, 'Elden Ring')).toMatchObject({ currentness: 'current_index', authority: 'official', durableAllowed: false });
    expect(assessGamingSourcePolicy(ARTICLE_URL, 'Elden Ring').currentness).toBe('article');
    for (const url of [`${INDEX_URL}?page=1`, `${INDEX_URL}?news-category=guide`, `${INDEX_URL}/other`,
      'https://en.bandainamcoent.eu/other-game/news', 'https://en.bandainamcoent.eu.evil.test/elden-ring/elden-ring/news'])
      expect(assessGamingSourcePolicy(url, 'Elden Ring').authority).toBe('unreviewed');
    expect(assessGamingSourcePolicy(INDEX_URL, 'Elden Ring Nightreign').authority).toBe('unreviewed');
  });
  test('dated official index establishes patch but requires the matching regulation article', () => {
    expect(index()).toMatchObject({ currentPatch: '1.10', effectiveFrom: '2026-09-08T00:00:00.000Z',
      currentnessMetadata: { status: 'incomplete', requiredArticlePatch: '1.10', requiredArticleRuleIds: ['elden-ring-news'] } });
    expect(index().currentBuild).toBeUndefined();
  });
  test('a raw article cannot establish the latest patch, even when it calls itself current', () => {
    const evidence = article('Current patch: 1.10. Targeted Platforms Steam App Ver. 1.10 Regulation Ver. 1.10.1 This update is required for online play.');
    expect(evidence).toMatchObject({ patch: '1.10', build: '1.10.1', currentness: 'article',
      currentnessMetadata: { status: 'incomplete', reasons: ['ARTICLE_IS_NOT_CURRENT_INDEX'] } });
    expect(evidence.currentPatch).toBeUndefined();
  });
  test('index plus matching official article establishes separate app/build and explicit platforms', () => {
    const officialIndex = index(); const officialArticle = article();
    const completed = combineGamingCurrentnessEvidence([officialIndex, officialArticle], NOW)[0];
    expect(completed).toMatchObject({ currentPatch: '1.10', currentBuild: '1.10.1', metadataUnverified: false,
      currentnessMetadata: { status: 'verified', versionSemantics: 'app-regulation' } });
    expect(completed.platforms).toContain('PC'); expect(completed.platforms).not.toContain('all');
    expect(completed.currentnessMetadata?.evidenceRefs).toHaveLength(2);
    expect(completed.currentnessMetadata?.evidenceRefs[0].contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(officialIndex.currentnessMetadata?.status).toBe('incomplete');
    expect(completed.durableAllowed).toBe(false);
  });
  test('missing, truncated, malformed, and same-day cards stay incomplete', () => {
    for (const evidence of [index(indexText('Elden Ring – Patch Notes Version 1.10', 1)),
      index(indexText('Elden Ring – Patch Notes Version 1.10 08/09/2026', 27)),
      index(indexText('Elden Ring – Patch Notes Version 1.10 31/02/2026', 1)),
      index(indexText('Elden Ring – Patch Notes Version 1.10 09/09/2026', 1)),
      index(indexText(), { metrics: { truncated: true } })]) {
      expect(evidence.currentnessMetadata?.status).toBe('incomplete'); expect(evidence.currentBuild).toBeUndefined();
    }
  });
  test('future official patch is not yet active, and same-date versions conflict', () => {
    expect(index(indexText('Elden Ring – Patch Notes Version 2.0 10/09/2026 Elden Ring – Patch Notes Version 1.10 08/09/2026')))
      .toMatchObject({ currentPatch: '1.10' });
    expect(index(indexText('Elden Ring – Patch Notes Version 1.10 08/09/2026 Elden Ring – Patch Notes Version 1.10.1a 08/09/2026')))
      .toMatchObject({ metadataConflict: true, currentnessMetadata: { status: 'conflicting' } });
  });
  test('mismatched title/app labels conflict; no app/regulation identifier remains incomplete', () => {
    expect(article('Targeted Platforms Steam App Ver. 1.9 Regulation Ver. 1.9')).toMatchObject({ metadataConflict: true });
    expect(article('Targeted Platforms Steam. The newest update is here.').currentnessMetadata)
      .toMatchObject({ status: 'incomplete', reasons: ['OFFICIAL_ARTICLE_VERSION_REQUIRED'] });
    expect(article('Patch: 1.9. Targeted Platforms Steam App Ver. 1.10 Regulation Ver. 1.10.1')).toMatchObject({ metadataConflict: true });
    expect(index(`Current patch: 999.0. ${indexText()}`)).toMatchObject({ metadataConflict: true });
  });
  test('wrong game, missing platform, unreviewed article, and expired cached article never complete the index', () => {
    for (const evidence of [{ ...article(), game: 'Elden Ring Nightreign' }, { ...article(), platforms: undefined },
      { ...article(), ruleId: 'unreviewed' }, { ...article(), url: `${ARTICLE_URL}-older-same-app` },
      { ...article(), verifiedAt: '2026-09-08T00:00:00Z', fetchedAt: '2026-09-08T00:00:00Z' }])
      expect(combineGamingCurrentnessEvidence([index(), evidence], NOW)[0].currentnessMetadata?.status).toBe('incomplete');
  });
  test('conflicting official regulations and different rollout scopes fail closed', () => {
    for (const conflicting of [{ ...article(), build: '1.10.2' }, { ...article(), platforms: ['Nintendo Switch 2'] },
      { ...article(), regions: ['EU'] }])
      expect(combineGamingCurrentnessEvidence([index(), article(), conflicting], NOW)[0])
        .toMatchObject({ metadataConflict: true, currentnessMetadata: { status: 'conflicting' } });
    expect(combineGamingCurrentnessEvidence([index(`Current build: 1.10.2. ${indexText()}`), article()], NOW)[0])
      .toMatchObject({ metadataConflict: true, currentnessMetadata: { status: 'conflicting' } });
  });
  test('expired index does not become current merely from a fresh article', () => {
    const expired = { ...index(), fetchedAt: new Date(NOW.getTime() - GAMING_CURRENTNESS_LIMITS.revalidateMs - 1).toISOString() };
    expect(combineGamingCurrentnessEvidence([expired, article()], NOW)[0].currentnessMetadata?.status).toBe('incomplete');
  });
  test('expired or scheduled companion releases cannot establish active currentness', () => {
    for (const companion of [{ ...article(), effectiveUntil: '2026-09-09T11:00:00Z' },
      article('Targeted Platforms Steam App Ver. 1.10 Regulation Ver. 1.10.1 This update will be released tomorrow.')])
      expect(combineGamingCurrentnessEvidence([index(), companion], NOW)[0].currentnessMetadata?.status).toBe('incomplete');
    const current = combineGamingCurrentnessEvidence([index(), { ...article(), effectiveUntil: '2026-09-09T13:00:00Z' }], NOW)[0];
    expect(current.effectiveUntil).toBe('2026-09-09T13:00:00.000Z');
  });
  test('an unfamiliar named hotfix card cannot be ignored in favor of older parseable cards', () => {
    expect(index(indexText('Elden Ring – Emergency Hotfix Moon 08/09/2026 Elden Ring – Patch Notes Version 1.10 07/09/2026 Elden Ring – Patch Notes Version 1.9 06/09/2026 Elden Ring – Patch Notes Version 1.8 05/09/2026', 27))
      .currentnessMetadata?.status).toBe('incomplete');
  });
});

describe('adapter contract supports other reviewed publisher styles without state-machine changes', () => {
  const MMO: GamingCurrentnessAdapterRule = { id: 'synthetic-mmo-patches', game: 'Synthetic MMO', currentness: 'current_index', metadataAdapter: 'swtor-patch-index-v1' };
  const SEASON: GamingCurrentnessAdapterRule = { id: 'synthetic-season', game: 'Seasonal Arena', currentness: 'current_index', metadataAdapter: 'labeled-v1' };
  const run = (rule: GamingCurrentnessAdapterRule, text: string, fields = {}) => runGamingCurrentnessAdapter({
    document: { publicUrl: 'https://official.test/current', text }, rule, game: rule.game, now: NOW, fields
  });
  test('MMO dated index supports 1.9,1.10,1.10.1,1.10.1a without numeric or lexical sorting', () => {
    expect(run(MMO, '09/07/2026 - Game Update 1.10.1 09/06/2026 - Game Update 1.10 09/05/2026 - Game Update 1.9 09/08/2026 - Game Update 1.10.1a'))
      .toMatchObject({ status: 'verified', currentPatch: '1.10.1a', effectiveFrom: '2026-09-08T00:00:00.000Z' });
    expect(run(MMO, '09/08/2026 - Game Update 1.9 09/07/2026 - Game Update 1.10').currentPatch).toBe('1.9');
    expect(run(MMO, 'Game Update 999.0').status).toBe('incomplete');
  });
  test('dated MMO index preserves explicit current build, season and effective scope', () => {
    const game = 'Star Wars: The Old Republic';
    const official = extractGamingFreshnessMetadata({ publicUrl: 'https://swtor.com/patchnotes',
      text: '09/08/2026 - Game Update 2.1. Game: Star Wars: The Old Republic. Current patch: 2.1. Current build: Hotfix-B. Current season: Autumn. Effective from: 2026-09-08. Platforms: PC. Regions: EU.' }, { game }, NOW);
    expect(official).toMatchObject({ currentPatch: '2.1', currentBuild: 'Hotfix-B', currentSeason: 'Autumn', platforms: ['PC'], regions: ['EU'] });
    const guide = extractGamingFreshnessMetadata({ publicUrl: 'https://guide.test/mmo',
      text: 'Game: Star Wars: The Old Republic. Patch: 2.1. Platforms: PC. Regions: EU. A mage build uses ranged abilities.' }, { game }, NOW);
    expect(evaluateGamingFreshness({ question: 'What is a good build now?', game, platform: 'PC', region: 'EU', evidence: [official, guide], now: NOW }).usable).toBe(false);
    expect(run(MMO, '09/08/2026 - Game Update 2.1', { currentPatch: '2.1', effectiveFrom: '2026-09-10' }))
      .toMatchObject({ status: 'incomplete', effectiveFrom: '2026-09-10' });
    expect(run(MMO, '09/08/2026 - Game Update 2.1', { currentPatch: '2.0' }).status).toBe('conflicting');
  });
  test('seasonal index keeps named build/hotfix/season and exact platform/region scope', () => {
    expect(run(SEASON, 'Source labels.', { currentPatch: 'Rift', currentBuild: 'Moonrise hotfix', currentSeason: 'Autumn',
      effectiveFrom: '2026-09-08T16:00:00Z', platforms: ['PC'], regions: ['EU'] }))
      .toMatchObject({ status: 'verified', currentPatch: 'Rift', currentBuild: 'Moonrise hotfix', currentSeason: 'Autumn', platforms: ['PC'], regions: ['EU'] });
  });
  test('date-only or future metadata cannot invent patch identity or activation', () => {
    expect(run(SEASON, '', { effectiveFrom: '2026-09-08' }).status).toBe('incomplete');
    expect(run(SEASON, '', { currentPatch: 'Rift', effectiveFrom: '2026-09-10' }).status).toBe('incomplete');
  });
  test.each(['1.10-beta', '1.10.1ab', '1.10.1.2.3', `${'9'.repeat(65)}.1`])('unsupported version %s never becomes a shorter identity', version => {
    expect(run(MMO, `09/08/2026 - Game Update ${version} 09/07/2026 - Game Update 1.9`).status).toBe('incomplete');
    expect(article(`Targeted Platforms Steam App Ver. ${version} Regulation Ver. 1.10.1 Online play requires the player to apply this update.`)
      .currentnessMetadata?.status).toBe('incomplete');
  });
  test('parser-local text truncation is never currentness proof', () => {
    expect(run(MMO, `09/08/2026 - Game Update 1.10 ${'x'.repeat(GAMING_CURRENTNESS_LIMITS.textChars)}`).status).toBe('incomplete');
  });
});
