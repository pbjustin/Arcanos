import { describe, expect, test } from '@jest/globals';
import {
  assessGamingSourcePolicy, classifyGamingQuestionFreshness, evaluateGamingFreshness, extractGamingFreshnessMetadata,
  GAMING_FRESHNESS_DEFAULTS, GAMING_SOURCE_POLICY_VERSION,
  type GamingFreshnessEvidence, type GamingReviewedSourceRule
} from '../src/shared/gaming/gamingFreshnessCore.js';

const NOW = new Date('2026-09-08T12:00:00Z');
const AGO = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
const RULES: readonly GamingReviewedSourceRule[] = [
  { id: 'lantern-guide', game: 'Lantern Vault', hosts: ['lantern.test'], path: '/guides/', pathMatch: 'prefix', category: 'specialist_guide', currentness: 'none', durableAllowed: true, autoStoreAllowed: false },
  { id: 'prism-current', game: 'Prism Siege', hosts: ['prism.test'], path: '/updates/current', pathMatch: 'exact', category: 'official_updates', currentness: 'current_index', durableAllowed: false, autoStoreAllowed: false },
  { id: 'prism-patch', game: 'Prism Siege', hosts: ['prism.test'], path: '/updates/', pathMatch: 'prefix', category: 'official_updates', currentness: 'article', durableAllowed: true, autoStoreAllowed: true },
  { id: 'prism-status', game: 'Prism Siege', hosts: ['prism.test'], path: '/status', pathMatch: 'exact', category: 'official_status', currentness: 'live_status', durableAllowed: false, autoStoreAllowed: false },
  { id: 'prism-community', game: 'Prism Siege', hosts: ['prism-community.test'], path: '/guides/', pathMatch: 'prefix', category: 'community', currentness: 'none', durableAllowed: true, autoStoreAllowed: false },
  { id: 'citadel-current', game: 'Clockwork Citadel', hosts: ['citadel.test'], path: '/seasons/current', pathMatch: 'exact', category: 'official_updates', currentness: 'current_index', durableAllowed: false, autoStoreAllowed: false },
  { id: 'citadel-notes', game: 'Clockwork Citadel', hosts: ['citadel.test'], path: '/updates/', pathMatch: 'prefix', category: 'official_updates', currentness: 'article', durableAllowed: true, autoStoreAllowed: true }
];

function source(id: string, overrides: Partial<GamingFreshnessEvidence> = {}): GamingFreshnessEvidence {
  return { id, url: `https://prism.test/updates/${id}`, game: 'Prism Siege', category: 'official_updates', authority: 'official',
    currentness: 'article', durableAllowed: true, autoStoreAllowed: true, policyVersion: GAMING_SOURCE_POLICY_VERSION,
    fetchedAt: NOW.toISOString(), verifiedAt: NOW.toISOString(), metadataConfidence: 'content_extracted', patch: '2.4.1',
    effectiveFrom: AGO(24 * 60 * 60 * 1_000), ...overrides };
}
function index(overrides: Partial<GamingFreshnessEvidence> = {}): GamingFreshnessEvidence {
  return source('current', { currentness: 'current_index', currentPatch: '2.4.1', durableAllowed: false, autoStoreAllowed: false, ...overrides });
}
function evaluate(evidence: GamingFreshnessEvidence[], overrides: Record<string, unknown> = {}) {
  return evaluateGamingFreshness({ question: 'What is the best weapon build?', game: 'Prism Siege', evidence, now: NOW, ...overrides });
}
function extract(url: string, text: string, game = 'Prism Siege') {
  return extractGamingFreshnessMetadata({ publicUrl: url, text, metadata: { title: game } }, { game }, NOW, RULES);
}

describe('Gaming question freshness is separate from relevance and source age', () => {
  test.each([
    ['How do I open the Azure Gate in Lantern Vault?', 'stable'],
    ['What is the best way to solve the bell puzzle?', 'stable'],
    ['What is the best dungeon route?', 'stable'],
    ['My current area is the tower; what next?', 'stable'],
    ['What is the best weapon build in Prism Siege?', 'patch_sensitive'],
    ['Which build is best?', 'patch_sensitive'],
    ['What weapons are strong today?', 'patch_sensitive'],
    ['How effective are these abilities?', 'patch_sensitive'],
    ['Which class is weakest?', 'patch_sensitive'],
    ['How much damage do weapons do today?', 'patch_sensitive'],
    ['Did the hotfix reduce beam damage?', 'patch_sensitive'],
    ['How does the current season work in Clockwork Citadel?', 'seasonal'],
    ['Are the servers down right now?', 'live_status']
  ] as const)('classifies %s', (prompt, expected) => {
    expect(classifyGamingQuestionFreshness({ prompt, mode: 'guide' })).toBe(expected);
  });

  test('an explicit version or meta question triggers verification', () => {
    expect(classifyGamingQuestionFreshness({ prompt: 'Beam rotation', requestedVersion: '2.4.1' })).toBe('patch_sensitive');
    expect(classifyGamingQuestionFreshness({ prompt: 'Beam rotation', mode: 'meta' })).toBe('patch_sensitive');
    expect(classifyGamingQuestionFreshness({ prompt: 'Which build is best?', mode: 'build' })).toBe('patch_sensitive');
    expect(classifyGamingQuestionFreshness({ prompt: 'Beam rotation', mode: 'build' })).toBe('patch_sensitive');
  });

  test('a stable adventure question can use old publication with recent independent checking', () => {
    const result = evaluate([source('lantern', { game: 'Lantern Vault', publishedAt: '2002-01-01', patch: undefined })],
      { game: 'Lantern Vault', question: 'How do I open the Azure Gate?' });
    expect(result).toMatchObject({ status: 'current', usable: true, selectedEvidenceIds: ['lantern'] });
    expect(result.qualification).toContain('coverage is evaluated separately');
  });

  test('a stable TTL expiry requests revalidation without claiming every old fact is invalid', () => {
    const old = AGO(GAMING_FRESHNESS_DEFAULTS.stable + 1);
    expect(evaluate([source('old', { fetchedAt: old, verifiedAt: old })], { question: 'Where is the gate key?' })).toMatchObject({ status: 'stale', reasons: ['REVALIDATION_DUE'] });
  });
});

describe('reviewed ownership and independently extracted source metadata', () => {
  test('official source eligibility is exact host, path, game, and not frontend category', () => {
    expect(assessGamingSourcePolicy('https://prism.test/updates/2.4.1', 'Prism Siege', RULES)).toMatchObject({ authority: 'official', autoStoreAllowed: true });
    for (const url of ['https://prism.test.evil.test/updates/2.4.1', 'https://evil-prism.test/updates/2.4.1', 'https://prism.test/forums/updates', 'https://prism.test/updates-other/2.4.1']) {
      expect(assessGamingSourcePolicy(url, 'Prism Siege', RULES)).toMatchObject({ authority: 'unreviewed', autoStoreAllowed: false });
    }
    expect(assessGamingSourcePolicy('https://prism.test/updates/2.4.1', 'Prism Siege 2', RULES).authority).toBe('unreviewed');
  });

  test.each(['http://prism.test/updates/a', 'https://user:secret@prism.test/updates/a', 'https://prism.test:8443/updates/a', 'https://prism.test/updates/%2Fsecret', 'not a URL'])('unsafe ownership input never qualifies for storage: %s', url => {
    expect(assessGamingSourcePolicy(url, 'Prism Siege', RULES)).toMatchObject({ autoStoreAllowed: false, durableAllowed: false });
  });

  test('community recommendations keep separate authority and require explicit storage consent', () => {
    const community = extract('https://prism-community.test/guides/beam', 'Game: Prism Siege\nPatch: 2.4.1\nThe beam build is our recommendation.');
    expect(community).toMatchObject({ category: 'community', authority: 'community', autoStoreAllowed: false, patch: '2.4.1' });
    expect(evaluate([index(), community])).toMatchObject({ status: 'current', selectedEvidenceIds: [community.id, 'current'] });
    expect(evaluate([community])).toMatchObject({ status: 'unverified', reasons: ['CURRENT_OFFICIAL_INDEX_REQUIRED'] });
  });

  test('source-updated and publication dates do not derive from copyright/footer dates', () => {
    const metadata = extract('https://prism.test/updates/old', 'Game: Prism Siege\nPatch: 1.0\nCopyright 2026\nUpdated footer September 8, 2026');
    expect(metadata.publishedAt).toBeUndefined();
    expect(metadata.sourceUpdatedAt).toBeUndefined();
    expect(metadata.fetchedAt).toBe(NOW.toISOString());
    expect(evaluate([metadata])).toMatchObject({ status: 'unverified' });
  });

  test('flattened resolver evidence preserves the closed metadata grammar without treating version dots as sentences', () => {
    const metadata = extract('https://prism.test/updates/current', 'Game: Prism Siege. Patch: 2.4.1. Current patch: 2.4.1. Effective from: 2026-09-07. Source updated at: 2026-09-08T11:00:00Z. The beam deals twenty damage.');
    expect(metadata).toMatchObject({ game: 'Prism Siege', patch: '2.4.1', currentPatch: '2.4.1', effectiveFrom: '2026-09-07T00:00:00.000Z', sourceUpdatedAt: '2026-09-08T11:00:00.000Z' });
  });

  test('official namespace alone never allows automatic storage of a developer opinion', () => {
    const opinion = extract('https://prism.test/updates/design-thoughts', 'Game: Prism Siege\nPatch: 2.4.1\nPublished at: 2026-09-07\nOur design thoughts.');
    expect(opinion.autoStoreAllowed).toBe(false);
    const notes = extractGamingFreshnessMetadata({ publicUrl: 'https://prism.test/updates/2.4.1', text: 'Game: Prism Siege\nPatch: 2.4.1\nEffective from: 2026-09-07', metadata: { title: 'Prism Siege Patch Notes 2.4.1' } }, { game: 'Prism Siege' }, NOW, RULES);
    expect(notes.autoStoreAllowed).toBe(true);
  });

  test('an official article cannot declare itself the current official index', () => {
    const metadata = extract('https://prism.test/updates/old', 'Game: Prism Siege\nCurrent patch: 1.0\nPatch: 1.0\nEffective from: 2020-01-01');
    expect(metadata.currentPatch).toBeUndefined();
    expect(evaluate([metadata]).usable).toBe(false);
  });

  test('conflicting explicit labels are rejected rather than choosing the newest-looking value', () => {
    const metadata = extract('https://prism.test/updates/current', 'Game: Prism Siege\nPatch: 2.4.1\nPatch: 999.0\nCurrent patch: 2.4.1\nEffective from: 2026-09-07');
    expect(metadata.metadataConflict).toBe(true);
    expect(evaluate([metadata])).toMatchObject({ status: 'conflicting', reasons: ['CONTRADICTORY_SOURCE_METADATA'] });
  });

  test('unsupported and invalid dates remain unknown, while distinct metadata is preserved', () => {
    const metadata = extract('https://prism.test/updates/current', 'Game: Prism Siege\nEdition: Reforged\nPlatforms: PC, Console\nRegions: EU\nPatch: 2.4.1\nCurrent patch: 2.4.1\nPublished at: 2026-02-30\nSource updated at: 2026-09-07T12:00:00Z\nEffective from: 2026-09-07\nEffective until: 2026-09-10');
    expect(metadata).toMatchObject({ edition: 'Reforged', platforms: ['PC', 'Console'], regions: ['EU'], sourceUpdatedAt: '2026-09-07T12:00:00.000Z', effectiveFrom: '2026-09-07T00:00:00.000Z' });
    expect(metadata.publishedAt).toBeUndefined();
  });

  test('metadata beyond its independent bound is never used as freshness proof', () => {
    const metadata = extract('https://prism.test/updates/current', `${'x'.repeat(GAMING_FRESHNESS_DEFAULTS.maxMetadataChars)}\nCurrent patch: 999.0\nEffective from: 2026-09-07`);
    expect(metadata.currentPatch).toBeUndefined();
  });
});

describe('current patch, hotfix, baseline, and rollout applicability', () => {
  test('newly fetched obsolete notes fail without an applicable current index', () => {
    expect(evaluate([source('obsolete', { patch: '1.0', publishedAt: '2020-01-01', effectiveFrom: '2020-01-01' })])).toMatchObject({ status: 'unverified', usable: false });
  });

  test('a current official index and matching specialist evidence can answer without redundant discovery', () => {
    const result = evaluate([index(), source('guide', { authority: 'specialist', category: 'specialist_guide', currentness: 'none' })]);
    expect(result).toMatchObject({ status: 'current', effectivePatch: '2.4.1', verifiedAsOf: NOW.toISOString(), selectedEvidenceIds: ['guide', 'current'] });
  });

  test('a recent HTTP revalidation of an old article does not prove no newer update exists', () => {
    expect(evaluate([source('old', { sourceUpdatedAt: NOW.toISOString(), patch: '1.0' })]).reasons).toContain('CURRENT_OFFICIAL_INDEX_REQUIRED');
    expect(evaluate([index(), source('old', { patch: '1.0' })]).reasons).toContain('CURRENT_PATCH_COVERAGE_MISSING');
  });

  test('the official current hotfix supersedes old conflicting balance evidence, never by numeric ordering', () => {
    const result = evaluate([index({ currentPatch: '2.4.1-hotfix-b' }), source('old-main', { patch: '2.4.1' }),
      source('hotfix', { patch: '2.4.1-hotfix-b', supersedesPatches: ['2.4.1'] }), source('looks-highest', { patch: '999.0' })]);
    expect(result).toMatchObject({ status: 'current', effectivePatch: '2.4.1-hotfix-b', selectedEvidenceIds: ['hotfix', 'current'] });
  });

  test('an official current build excludes same-patch pre-hotfix balance values and unknown build applicability', () => {
    const currentIndex = index({ currentBuild: '2026.09.08b' });
    const hotfix = source('hotfix-build', { build: '2026.09.08b', supersedesBuilds: ['2026.09.08a'] });
    const result = evaluate([currentIndex, source('old-balance', { build: '2026.09.08a' }), source('unknown-build'), hotfix]);
    expect(result).toMatchObject({ status: 'current', effectivePatch: '2.4.1', effectiveBuild: '2026.09.08b', selectedEvidenceIds: ['hotfix-build', 'current'] });
    expect(evaluate([currentIndex, index({ id: 'inconsistent-build-index', currentBuild: '2026.09.08a' }), hotfix]).status).toBe('conflicting');
  });

  test('unparseable announced effective dates are uncertainty, not an absent restriction', () => {
    const announced = extract('https://prism.test/updates/announced', 'Game: Prism Siege\nPatch: 2.4.1\nEffective from: tomorrow');
    expect(announced.metadataUnverified).toBe(true);
    expect(evaluate([index(), announced]).reasons).toContain('APPLICABILITY_METADATA_UNVERIFIED');
    expect(evaluate([index(), announced]).usable).toBe(false);
  });

  test.each(['Effective from', 'Effective until', 'Published at', 'Source updated at'])(
    'an overlong %s assertion cannot disappear and admit an unverified update', label => {
      const value = 'tomorrow after the scheduled worldwide maintenance window announced in our separate service bulletin for all players';
      const announced = extract('https://prism.test/updates/announced', `Game: Prism Siege\nPatch: 2.4.1\n${label}: ${value}`);
      expect(announced.metadataUnverified).toBe(true);
      expect(announced.autoStoreAllowed).toBe(false);
      expect(evaluate([index(), announced]).usable).toBe(false);
      expect(evaluate([index(), announced]).reasons).toContain('APPLICABILITY_METADATA_UNVERIFIED');
    }
  );

  test('a patch-only index cannot merge explicitly different hotfix builds', () => {
    const before = source('before-hotfix', { build: 'build-a' });
    const after = source('after-hotfix', { build: 'build-b' });
    expect(evaluate([index(), before, after])).toMatchObject({
      status: 'conflicting', usable: false, reasons: ['CURRENT_BUILD_APPLICABILITY_CONFLICT'],
    });
    expect(evaluate([index(), before, { ...after, supersedesBuilds: ['build-a'] }])).toMatchObject({
      status: 'unverified', usable: false, reasons: ['CURRENT_BUILD_UNVERIFIED'],
    });
    const resolved = evaluate([index({ currentBuild: 'build-b' }), before, { ...after, supersedesBuilds: ['build-a'] },
      source('unknown-build'), source('patch-only-baseline', { baselineForPatches: ['2.4.1'] }),
      source('exact-build-baseline', { baselineForBuilds: ['build-b'] })]);
    expect(resolved.selectedEvidenceIds).toEqual(['after-hotfix', 'exact-build-baseline', 'current']);
  });

  test.each(['official', 'community'] as const)('a lone %s build is not established as current by a patch-only index', authority => {
    const evidence = source('only-observed-build', { authority, patch: '2.1', build: '2.1.0' });
    expect(evaluate([index({ currentPatch: '2.1' }), evidence])).toMatchObject({
      status: 'unverified', usable: false, reasons: ['CURRENT_BUILD_UNVERIFIED'],
    });
    expect(evaluate([index({ currentPatch: '2.1', currentBuild: '2.1.0' }), evidence])).toMatchObject({
      status: 'current', usable: true, effectiveBuild: '2.1.0',
    });
  });

  test('a build-scoped baseline also needs independent current-build identity', () => {
    expect(evaluate([index(), source('baseline', { baselineForBuilds: ['build-a'] })])).toMatchObject({
      status: 'unverified', usable: false, reasons: ['CURRENT_BUILD_UNVERIFIED'],
    });
  });

  test('an empty recognized effective-date assertion remains unverified', () => {
    const announced = extract('https://prism.test/updates/announced', 'Game: Prism Siege\nPatch: 2.4.1\nEffective from: ');
    expect(announced.metadataUnverified).toBe(true);
    expect(evaluate([index(), announced]).usable).toBe(false);
  });

  test.each(['Platforms', 'Regions'])('malformed %s lists cannot widen stable evidence to unspecified scope', label => {
    for (const value of ['x'.repeat(81), 'all, ', Array.from({ length: 9 }, (_, i) => `scope-${i}`).join(', ')]) {
      const metadata = extract('https://prism.test/updates/scoped', `Game: Prism Siege\nPatch: 2.4.1\n${label}: ${value}`);
      expect(metadata.metadataUnverified).toBe(true);
      expect(metadata.autoStoreAllowed).toBe(false);
      expect(evaluate([metadata], { question: 'Where is the cave entrance?', platform: 'PC', region: 'EU' }))
        .toMatchObject({ usable: false, reasons: ['APPLICABILITY_METADATA_UNVERIFIED'] });
    }
  });

  test('explicit same-mechanic numeric conflicts are bounded and use source authority', () => {
    const first = extract('https://prism.test/updates/first', 'Game: Prism Siege\nPatch: 2.4.1\nMechanic: beam damage = 20\nMechanic: beam cooldown = 5 seconds');
    const changed = extract('https://prism.test/updates/changed', 'Game: Prism Siege\nPatch: 2.4.1\nMechanic: beam damage = 30');
    expect(first.mechanicValues).toEqual({ 'beam damage': '20', 'beam cooldown': '5s' });
    expect(evaluate([index(), first, changed])).toMatchObject({
      status: 'conflicting', usable: false, reasons: ['EXPLICIT_MECHANIC_VALUE_CONFLICT'],
    });
    const community = extract('https://prism-community.test/guides/beam', 'Game: Prism Siege\nPatch: 2.4.1\nMechanic: beam damage = 30');
    expect(evaluate([index(), first, community])).toMatchObject({
      status: 'current', selectedEvidenceIds: [first.id, 'current'],
      reasons: expect.arrayContaining(['LOWER_AUTHORITY_CONFLICT_EXCLUDED']),
    });
    const equivalent = extract('https://prism.test/updates/equivalent', 'Game: Prism Siege\nPatch: 2.4.1\nMechanic: beam damage = 20.0000\nMechanic: beam cooldown = 5s');
    expect(evaluate([index(), first, equivalent]).usable).toBe(true);
    const excessive = extract('https://prism.test/updates/excessive', `Game: Prism Siege\nPatch: 2.4.1\n${Array.from({ length: 17 }, (_, index) => `Mechanic: skill ${index} damage = 20`).join('\n')}`);
    expect(Object.keys(excessive.mechanicValues ?? {})).toHaveLength(16);
    expect(excessive.metadataUnverified).toBe(true);
  });

  test.each([[false, false], [false, true], [true, false], [true, true]])(
    'excluded weaker sources contribute no other mechanics (source order=%s, claim order=%s)', (reverseSources, reverseClaims) => {
      const official = source('official-balance', { mechanicValues: { 'beam damage': '20' } });
      const rejectedClaims: Array<[string, string]> = [['beam damage', '30'], ['beam cooldown', '5s']];
      const rejected = source('rejected-community', { authority: 'community', category: 'community',
        mechanicValues: Object.fromEntries(reverseClaims ? rejectedClaims.reverse() : rejectedClaims) });
      const valid = source('valid-community', { authority: 'community', category: 'community',
        mechanicValues: { 'beam damage': '20', 'beam cooldown': '6s' } });
      const weaker = reverseSources ? [valid, rejected] : [rejected, valid];
      expect(evaluate([index(), official, ...weaker])).toMatchObject({
        status: 'current', selectedEvidenceIds: ['official-balance', 'valid-community', 'current'],
        reasons: expect.arrayContaining(['LOWER_AUTHORITY_CONFLICT_EXCLUDED'])
      });
    }
  );

  test('future and expired patch announcements are not active gameplay evidence', () => {
    const result = evaluate([index(), source('future', { effectiveFrom: '2026-09-09' }), source('expired', { effectiveUntil: '2026-09-08T12:00:00Z' })]);
    expect(result.usable).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining(['NOT_YET_EFFECTIVE', 'NO_LONGER_EFFECTIVE', 'CURRENT_PATCH_COVERAGE_MISSING']));
  });

  test('an old baseline is retained only with explicit applicability to the current patch', () => {
    const result = evaluate([index(), source('old-unproven', { patch: '1.0' }), source('baseline-confirmed', { patch: '1.0', baselineForPatches: ['2.4.1'] }), source('update')]);
    expect(result.selectedEvidenceIds).toEqual(['baseline-confirmed', 'update', 'current']);
    expect(result.reasons).toContain('INAPPLICABLE_PATCH_EVIDENCE_EXCLUDED');
  });

  test('contradictory applicable official indexes produce uncertainty, not recency sorting', () => {
    expect(evaluate([index(), index({ id: 'other-index', currentPatch: '2.4.2', verifiedAt: AGO(60_000), fetchedAt: AGO(60_000) }), source('guide')]))
      .toMatchObject({ status: 'conflicting', reasons: ['OFFICIAL_CURRENT_APPLICABILITY_CONFLICT'] });
  });

  test('unknown edition, platform, and region are not silently assumed compatible', () => {
    expect(evaluate([index(), source('guide')], { edition: 'Reforged' }).reasons).toContain('EDITION_UNVERIFIED_OR_MISMATCH');
    expect(evaluate([index(), source('guide')], { platform: 'PC' }).reasons).toContain('CURRENT_OFFICIAL_INDEX_REQUIRED');
    expect(evaluate([index({ platforms: ['Console'] }), source('guide', { platforms: ['Console'] })], { platform: 'PC' }).reasons).toContain('PLATFORM_MISMATCH');
    expect(evaluate([index({ regions: ['EU'] }), source('guide', { regions: ['EU'] })], { region: 'NA' }).reasons).toContain('REGION_MISMATCH');
    expect(evaluate([index({ platforms: ['PC'], regions: ['EU'] }), source('guide', { platforms: ['PC'], regions: ['EU'] })], { platform: 'PC', region: 'EU' }).usable).toBe(true);
  });

  test('a patch in another sequel or edition never establishes the requested game', () => {
    expect(evaluate([index({ game: 'Prism Siege 2' }), source('other-guide', { game: 'Prism Siege 2' })])).toMatchObject({ status: 'not_applicable', reasons: ['GAME_MISMATCH'] });
    expect(evaluate([index({ edition: 'Reforged' }), source('guide', { edition: 'Reforged' })]).reasons).toContain('EDITION_REQUIRED');
  });

  test('index verification expires independently of a recently fetched guide', () => {
    const old = AGO(GAMING_FRESHNESS_DEFAULTS.patch_sensitive + 1);
    expect(evaluate([index({ verifiedAt: old, fetchedAt: old }), source('guide')])).toMatchObject({ status: 'stale', reasons: ['REVALIDATION_DUE'] });
  });

  test('source policy changes require revalidation rather than silently inheriting old authority', () => {
    expect(evaluate([source('guide', { policyVersion: 'old-policy' as typeof GAMING_SOURCE_POLICY_VERSION })], { question: 'Where is the gate?' }).reasons).toContain('SOURCE_POLICY_REVALIDATION_REQUIRED');
  });

  test('historical limitations are explicit even when an old revision is still stored', () => {
    expect(evaluate([index(), source('guide')], { requestedVersion: '1.0' }).reasons).toContain('HISTORICAL_AS_OF_UNSUPPORTED');
    expect(evaluate([source('old')], { question: 'What was this weapon as of last year?' }).reasons).toContain('HISTORICAL_AS_OF_UNSUPPORTED');
  });

  test('future verification timestamps and excessive evidence do not bypass deadlines', () => {
    expect(evaluate([index({ verifiedAt: '2026-09-09', fetchedAt: '2026-09-09' }), source('guide')]).usable).toBe(false);
    expect(evaluate(Array.from({ length: 21 }, (_, i) => source(String(i)))).reasons).toContain('EVIDENCE_LIMIT_EXCEEDED');
    expect(evaluate([], { now: new Date('invalid') }).reasons).toContain('INVALID_VERIFICATION_TIME');
  });
});

describe('MMO seasons and operational status remain time-scoped', () => {
  test('Clockwork Citadel season mechanics require explicit active season verification', () => {
    const seasonIndex = extract('https://citadel.test/seasons/current', 'Game: Clockwork Citadel\nSeason: Gears\nCurrent season: Gears\nEffective from: 2026-09-01', 'Clockwork Citadel');
    const mechanics = extract('https://citadel.test/updates/gears', 'Game: Clockwork Citadel\nSeason: Gears\nEffective from: 2026-09-01\nGear tokens upgrade companions.', 'Clockwork Citadel');
    expect(evaluate([seasonIndex, mechanics], { game: 'Clockwork Citadel', question: 'How do current season tokens work?' })).toMatchObject({ status: 'current', classification: 'seasonal', season: 'Gears' });
    expect(evaluate([seasonIndex, { ...mechanics, season: 'Old Cog' }], { game: 'Clockwork Citadel', question: 'How do season tokens work?' }).usable).toBe(false);
  });

  test('season identity cannot override an explicitly current patch or contradictory patch indexes', () => {
    const scope = { game: 'Clockwork Citadel', question: 'What are the current season weapon damage mechanics?' };
    const seasonIndex = index({ game: scope.game, currentSeason: 'Gears', currentPatch: '2.0' });
    const current = source('current-balance', { game: scope.game, season: 'Gears', patch: '2.0' });
    const old = source('obsolete-balance', { game: scope.game, season: 'Gears', patch: '1.0' });
    expect(evaluate([seasonIndex, old, current], scope)).toMatchObject({
      status: 'current', effectivePatch: '2.0', selectedEvidenceIds: ['current-balance', 'current'],
    });
    expect(evaluate([seasonIndex, { ...seasonIndex, id: 'other-index', currentPatch: '3.0' }, current], scope))
      .toMatchObject({ status: 'conflicting', reasons: ['OFFICIAL_CURRENT_APPLICABILITY_CONFLICT'] });
  });

  test.each([
    { question: 'What is the best weapon build for the current season?', mode: 'guide' },
    { question: 'What are the latest hotfix beam damage values this season?', mode: 'guide' },
    { question: 'Describe the seasonal loadout.', mode: 'build' }
  ])('a season-only index cannot verify patch-sensitive intent: $question', ({ question, mode }) => {
    const scope = { game: 'Clockwork Citadel', question, mode };
    const seasonIndex = index({ game: scope.game, currentSeason: 'Gears', currentPatch: undefined });
    const old = source('obsolete-balance', { game: scope.game, season: 'Gears', patch: '1.0' });
    expect(evaluate([seasonIndex, old], scope)).toMatchObject({
      classification: 'seasonal', usable: false, reasons: ['CURRENT_OFFICIAL_INDEX_REQUIRED']
    });
    const current = source('current-balance', { game: scope.game, season: 'Gears', patch: '2.0' });
    expect(evaluate([{ ...seasonIndex, currentPatch: '2.0' }, old, current], scope)).toMatchObject({
      status: 'current', effectivePatch: '2.0', selectedEvidenceIds: ['current-balance', 'current']
    });
  });

  test('operational status needs a live official page with a recent source timestamp', () => {
    const status = extract('https://prism.test/status', `Game: Prism Siege\nSource updated at: ${AGO(10_000)}\nServers operational.`);
    expect(status).toMatchObject({ durableAllowed: false, autoStoreAllowed: false });
    expect(evaluate([status], { question: 'Are Prism Siege servers down?' })).toMatchObject({ classification: 'live_status', usable: true });
    expect(evaluate([{ ...status, sourceUpdatedAt: AGO(60_001) }], { question: 'Are servers down?' }).reasons).toContain('LIVE_OFFICIAL_STATUS_REQUIRED');
    expect(evaluate([source('community-outage', { sourceUpdatedAt: NOW.toISOString() })], { question: 'Server status?' }).usable).toBe(false);
  });

  test('reviewed SWTOR release-index adapter includes later hotfixes and ignores a future patch', () => {
    const metadata = extractGamingFreshnessMetadata({ publicUrl: 'https://www.swtor.com/patchnotes',
      text: 'Patch Notes 09/09/26 - Game Update 8.0 09/07/26 - Game Update 7.9.1b 09/01/2026 - Game Update 7.9.1a' },
      { game: 'Star Wars: The Old Republic' }, NOW);
    expect(metadata).toMatchObject({ currentPatch: '7.9.1b', effectiveFrom: '2026-09-07T00:00:00.000Z' });
    expect(metadata.currentPatch).not.toBe('8.0');
  });

  test('same-date release ambiguity requires further verification', () => {
    const metadata = extractGamingFreshnessMetadata({ publicUrl: 'https://www.swtor.com/patchnotes',
      text: '09/07/26 - Game Update 7.9.1b\n09/07/26 - Game Update 7.9.1a' }, { game: 'Star Wars: The Old Republic' }, NOW);
    expect(metadata).toMatchObject({ metadataConflict: true });
    expect(metadata.currentPatch).toBeUndefined();
  });

  test('date-only release notes on rollout day do not claim a future same-day deployment is active', () => {
    const metadata = extractGamingFreshnessMetadata({ publicUrl: 'https://www.swtor.com/patchnotes',
      text: '09/08/26 - Game Update 8.0 09/07/26 - Game Update 7.9.1b' }, { game: 'Star Wars: The Old Republic' }, NOW);
    expect(metadata.metadataUnverified).toBe(true);
    expect(metadata.currentPatch).toBeUndefined();
  });
});
