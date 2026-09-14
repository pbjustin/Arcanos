import { describe, expect, test } from '@jest/globals';
import { evaluateGamingFreshness, extractGamingFreshnessMetadata, GAMING_FRESHNESS_DEFAULTS, GAMING_SOURCE_POLICY_VERSION,
  type GamingFreshnessEvidence, type GamingReviewedSourceRule } from '../src/shared/gaming/gamingFreshnessCore.js';
import { assessGamingClearEvidence } from '../src/shared/gaming/gamingClearEvidence.js';
import type { GamingStoredKnowledgeContext } from '../src/shared/gaming/gamingStoredEvidenceCore.js';

const now = new Date('2026-09-14T12:00:00Z');
const game = 'Elden Ring';
const rules: readonly GamingReviewedSourceRule[] = [
  { id: 'synthetic-publisher-index', game, hosts: ['publisher.test'], path: '/updates', pathMatch: 'exact', category: 'official_updates',
    currentness: 'current_index', metadataAdapter: 'labeled-v1', durableAllowed: false, autoStoreAllowed: false },
  { id: 'synthetic-publisher-notes', game, hosts: ['publisher.test'], path: '/updates/', pathMatch: 'prefix', category: 'official_updates',
    currentness: 'article', durableAllowed: true, autoStoreAllowed: false },
  { id: 'synthetic-specialist', game, hosts: ['specialist.test'], path: '/builds/', pathMatch: 'prefix', category: 'specialist_guide',
    currentness: 'none', durableAllowed: true, autoStoreAllowed: false }
];
const guideProse = 'In Elden Ring, the copper staff mage build combines Intelligence, spell slots and sufficient equipment capacity. Equip the copper staff and select sorcery spells compatible with its requirements before increasing Intelligence.';
function extract(url: string, body: string, at = now): GamingFreshnessEvidence {
  return extractGamingFreshnessMetadata({ publicUrl: url, canonicalUrl: url, text: `Game: ${game}\n${body}`,
    metadata: { title: `${game} ${url.includes('builds') ? 'mage build' : 'patch notes'}` } }, { game }, at, rules);
}
const guide = (labels = 'Patch: 1.10'): GamingFreshnessEvidence => extract('https://specialist.test/builds/mage', `${labels}\n${guideProse}`);
const index = (labels = 'Current patch: 1.10'): GamingFreshnessEvidence => extract('https://publisher.test/updates', `${labels}\nEffective from: 2026-09-12`);
const notes = (labels = 'Patch: 1.10'): GamingFreshnessEvidence => extract('https://publisher.test/updates/patch', `${labels}\nEffective from: 2026-09-12`);
function evaluate(evidence: GamingFreshnessEvidence[], options: Partial<Parameters<typeof evaluateGamingFreshness>[0]> = {}) {
  return evaluateGamingFreshness({ game, question: 'What is a good copper staff mage build now?', mode: 'build', evidence, now, ...options });
}
function knowledge(evidence: GamingFreshnessEvidence[]): GamingStoredKnowledgeContext {
  const passages = evidence.map(item => item.category === 'specialist_guide' ? guideProse : 'Official release record: active patch and effective release date.');
  return { context: passages.join('\n\n'), sources: evidence.map((item, i) => ({ sourceId: item.id, url: item.url, game,
    sourceType: item.category, fetchedAt: item.fetchedAt, snippet: passages[i], freshnessMetadata: { ...item } })),
  evidence: evidence.map((item, i) => ({ sourceId: item.id, revisionId: `revision-${i}`, recordId: `chunk-${i}`, recordType: 'build',
    publicUrl: item.url, text: passages[i], lexicalScore: 1, combinedScore: 1, provenance: { fetchedAt: item.fetchedAt } })) };
}

describe('explicit guide applicability against independent official currentness', () => {
  test('matching acquired patch plus current official index supports combined evidence', () => {
    const evidence = [guide(), index()];
    expect(evaluate(evidence)).toMatchObject({ status: 'current', usable: true, guideApplicability: [{ status: 'verified_current', reasons: ['GUIDE_MATCHES_CURRENT_VERSION'] }] });
    expect(assessGamingClearEvidence({ game, prompt: 'What is a good copper staff mage build now?', mode: 'build' }, knowledge(evidence), { now }))
      .toMatchObject({ decision: 'accept', gates: { freshness: 'verified', claimSupport: 'verified' } });
  });
  test.each(['Patch: 1.9', ''])('old or unversioned guide is not promoted by a relevant current article: %s', labels => {
    const evidence = [guide(labels), index(), notes()];
    expect(evaluate(evidence)).toMatchObject({ usable: false, status: 'unverified', guideApplicability: [{ status: 'unverified' }] });
    expect(assessGamingClearEvidence({ game, prompt: 'What is a good copper staff mage build now?', mode: 'build' }, knowledge(evidence), { now }).decision).not.toBe('accept');
  });
  test('an excellent guide without official verification remains unverified', () => {
    expect(evaluate([guide()])).toMatchObject({ status: 'unverified', reasons: ['CURRENT_OFFICIAL_INDEX_REQUIRED'],
      guideApplicability: [{ status: 'unverified' }] });
  });
  test('an older guide may assert an explicit compatibility baseline without version arithmetic', () => {
    expect(evaluate([guide('Patch: 1.9\nBaseline valid for patches: 1.10'), index()])).toMatchObject({ usable: true,
      guideApplicability: [{ status: 'verified_current', reasons: ['EXPLICIT_COMPATIBILITY_BASELINE'] }] });
  });
  test('a newer guide cannot answer an older historical patch request', () => {
    expect(evaluate([guide()], { question: 'Explain the mage build for historical patch 1.9.', requestedVersion: '1.9' }))
      .toMatchObject({ usable: false, reasons: ['HISTORICAL_PATCH_COVERAGE_MISSING'] });
    expect(evaluate([guide('Patch: 1.9')], { question: 'Explain the mage build for historical patch 1.9.', requestedVersion: '1.9' }))
      .toMatchObject({ usable: true, effectivePatch: '1.9', reasons: ['HISTORICAL_PATCH_APPLICABILITY_VERIFIED'] });
  });
  test('current official mechanic changes invalidate the guide even with the same patch label', () => {
    expect(evaluate([guide('Patch: 1.10\nMechanic: copper staff damage = 20'), index(), notes('Patch: 1.10\nMechanic: copper staff damage = 10')]))
      .toMatchObject({ usable: false, status: 'stale', guideApplicability: [{ status: 'stale', reasons: ['CURRENT_UPDATE_CHANGES_GUIDE_MECHANIC'] }] });
  });
  test('silence in newest notes does not extend older or unspecified guide mechanics', () => {
    for (const patch of ['Patch: 1.9\n', '']) expect(evaluate([guide(`${patch}Mechanic: copper staff damage = 20`), index(), notes('Patch: 1.10\nMechanic: shield weight = 5')]).usable).toBe(false);
  });
  test('explicit supersession marks a mismatched guide stale without guessing version ordering', () => {
    expect(evaluate([guide('Patch: 1.9'), index(), notes('Patch: 1.10\nSupersedes patches: 1.9')])).toMatchObject({
      usable: false, status: 'stale', guideApplicability: [{ status: 'stale', reasons: ['GUIDE_VERSION_EXPLICITLY_SUPERSEDED'] }] });
  });
  test('a new hotfix requires explicit build compatibility separately from patch compatibility', () => {
    const current = index('Current patch: 1.10\nCurrent build: hotfix-copper');
    expect(evaluate([guide(), current])).toMatchObject({ usable: false, guideApplicability: [{ status: 'partially_verified', reasons: ['CURRENT_BUILD_COVERAGE_MISSING'] }] });
    expect(evaluate([guide('Patch: 1.10\nBuild: hotfix-copper'), current]).usable).toBe(true);
    expect(evaluate([guide('Patch: 1.10\nBaseline valid for builds: hotfix-copper'), current]).usable).toBe(true);
  });
  test.each([
    { scope: { platform: 'PC' }, labels: 'Platforms: PlayStation 5', reason: 'PLATFORM_MISMATCH' },
    { scope: { region: 'EU' }, labels: 'Regions: US', reason: 'REGION_MISMATCH' }
  ])('wrong rollout scope remains blocking: $reason', ({ scope, labels, reason }) => {
    expect(evaluate([guide(`Patch: 1.10\n${labels}`), index(`Current patch: 1.10\n${labels}`)], scope).reasons).toContain(reason);
  });
  test('an expired currentness record forces revalidation even if stored guide compatibility is unchanged', () => {
    const at = new Date(now.getTime() - GAMING_FRESHNESS_DEFAULTS.patch_sensitive - 1);
    const old = extract('https://publisher.test/updates', 'Current patch: 1.10\nEffective from: 2026-09-12', at);
    const before = evaluate([guide(), old]);
    expect(before).toMatchObject({ usable: false, status: 'stale', reasons: ['REVALIDATION_DUE'], guideApplicability: [{ status: 'unverified' }] });
    expect(evaluate([guide(), index()]).usable).toBe(true);
  });
  test('old policy source artifacts need revalidation and cannot retain current authority', () => {
    expect(evaluate([guide(), { ...index(), policyVersion: 'previous-policy' as typeof GAMING_SOURCE_POLICY_VERSION }]))
      .toMatchObject({ usable: false, reasons: expect.arrayContaining(['SOURCE_POLICY_REVALIDATION_REQUIRED', 'CURRENT_OFFICIAL_INDEX_REQUIRED']) });
    expect(evaluate([{ ...guide(), policyVersion: 'previous-policy' as typeof GAMING_SOURCE_POLICY_VERSION }, index(), notes()]))
      .toMatchObject({ usable: false, guideApplicability: [{ status: 'unverified', reasons: ['SOURCE_POLICY_REVALIDATION_REQUIRED'] }] });
  });
  test('static walkthrough remains independent of current index and version metadata', () => {
    expect(evaluate([guide('')], { question: 'Where is the copper gate?', mode: 'guide' })).toMatchObject({ usable: true, classification: 'stable' });
  });
  test('a wrong-game guide cannot be masked by a correctly scoped current index and patch article', () => {
    const wrong = extractGamingFreshnessMetadata({ publicUrl: 'https://specialist.test/builds/mage', text: 'Game: Diablo 4\nPatch: 1.10',
      metadata: { title: 'Diablo 4 mage build' } }, { game }, now, rules);
    expect(evaluate([wrong, index(), notes()])).toMatchObject({ usable: false,
      guideApplicability: [{ status: 'conflicting', reasons: ['GAME_MISMATCH'] }] });
  });
});
