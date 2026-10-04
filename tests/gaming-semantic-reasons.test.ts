import { describe, expect, it } from '@jest/globals';
import { assessGamingClearSource, assessGamingClearSourceIdentity } from '../src/shared/gaming/gamingClearSource.js';
import { assessGamingSourcePolicy, extractGamingFreshnessMetadata } from '../src/shared/gaming/gamingFreshnessCore.js';
import { gamingApplicabilityScopeRequired, evaluateGamingGuideApplicability } from '../src/shared/gaming/gamingGuideApplicability.js';
import type { ResolvedGamingDocument } from '../src/services/gamingDocumentResolution.js';

const now = new Date('2026-10-04T12:00:00Z');
const request = { game: 'Elden Ring', mode: 'guide' as const, prompt: 'How do Samurai katana attacks work?' };
function document(text: string, title = 'Elden Ring guide'): ResolvedGamingDocument {
  const url = 'https://guides.example.org/synthetic';
  return { requestedUrl: url, canonicalUrl: url, publicUrl: url, host: 'guides.example.org', text, metadata: { title },
    extraction: { strategy: 'article', rawTextLength: text.length, cleanedTextLength: text.length, navigationDensity: 0 },
    resolution: { resolverId: 'generic-web', resolverVersion: 'gaming-document-v1', strategy: 'article', documentType: 'html', supportsStructuredExtraction: false },
    metrics: { rawTextLength: text.length, cleanedTextLength: text.length, instructionFiltered: false, truncated: false } };
}
const policy = assessGamingSourcePolicy('https://guides.example.org/synthetic', request.game);
function assessment(doc: ResolvedGamingDocument) {
  return assessGamingClearSource(request, doc, { subjectId: 'semantic-source', subjectHash: 'a'.repeat(64), actorScopeHash: 'b'.repeat(64),
    sourcePolicy: policy, freshness: extractGamingFreshnessMetadata(doc, request, now), now });
}
const prose = 'In Elden Ring, Samurai katana attacks require stamina management. Use an Uchigatana katana and wait until an enemy recovers before attacking, leaving enough stamina for a dodge after using the Samurai weapon.';
const guide = () => extractGamingFreshnessMetadata(document(`Patch: 1.10. ${prose}`), request, now);

describe('independent Gaming evidence failure semantics', () => {
  it('verifies acquired game identity independently of Samurai topical coverage', () => {
    const doc = document('In Elden Ring, the map records discovered locations. Mark an explored cave and inspect its paths before returning to a nearby site of grace. This exploration guide explains general map markers and navigation.');
    expect(assessGamingClearSourceIdentity(doc, request, policy)).toMatchObject({ status: 'verified' });
    const source = assessment(doc);
    expect(source.gates.identity).toBe('verified');
    expect(source.dimensionScores.leverage.reasonCodes).toEqual(['QUESTION_COVERAGE_INSUFFICIENT']);
    expect(source.dimensionScores.alignment.reasonCodes).not.toContain('GAME_IDENTITY_UNVERIFIED');
    expect(source.decision).not.toBe('accept');
  });
  it('separates unproved game identity from explicit wrong-game evidence', () => {
    const unknown = document(prose.replace('In Elden Ring, ', ''), 'Unidentified notebook guide');
    expect(assessGamingClearSourceIdentity(unknown, request, policy)).toEqual({ status: 'unknown', reasonCodes: ['GAME_IDENTITY_UNVERIFIED'] });
    const wrong = document(prose.replace('Elden Ring', 'Diablo 4'), 'Diablo 4 guide');
    expect(assessGamingClearSourceIdentity(wrong, request, policy)).toEqual({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });
  it('uses coupled acquired title and body proof for games outside the alias catalog', () => {
    const wrong = document('Stardew Valley gameplay guide. Plant crops in the spring and water them each morning. This Stardew Valley guide covers copper tools and the first farm upgrade.', 'Stardew Valley guide');
    expect(assessGamingClearSourceIdentity(wrong, request, policy)).toEqual({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
    expect(assessment(wrong).gates.identity).toBe('conflict');
  });
  it('checks explicit wrong-game body before a same-title DLC scope conflict', () => {
    const wrong = document('In Diablo 4, the barbarian build uses fury and shouts. This guide describes Diablo 4 equipment and class skills for a melee leveling route.', 'Elden Ring Shadow of the Erdtree guide');
    const source = assessment(wrong);
    expect(source.gates.identity).toBe('conflict');
    expect(source.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'GAME_MISMATCH' })]));
    expect(source.dimensionScores.alignment.reasonCodes).not.toContain('EDITION_CONFLICT');
  });
  it('does not report date or patch metadata uncertainty as an edition problem', () => {
    const doc = document(`Effective until: malformed. ${prose}`);
    const source = assessment(doc);
    expect(source.gates.identity).toBe('verified');
    expect(source.gates.compatibility).toBe('unknown');
    expect(source.dimensionScores.alignment.reasonCodes).not.toContain('EDITION_UNVERIFIED');
  });
  it('distinguishes explicit edition conflict from missing expansion applicability', () => {
    const base = { ...guide(), edition: 'base-game' };
    expect(evaluateGamingGuideApplicability({ guide: base, game: request.game, edition: 'Shadow of the Erdtree', now }))
      .toMatchObject({ status: 'conflicting', reasons: ['EDITION_CONFLICT'] });
    expect(evaluateGamingGuideApplicability({ guide: guide(), game: request.game, edition: 'Shadow of the Erdtree', now }))
      .toMatchObject({ status: 'unverified', reasons: ['EDITION_UNVERIFIED'] });
    expect(assessGamingClearSourceIdentity(document(`This DLC-only guide requires Shadow of the Erdtree. ${prose}`), request, policy))
      .toEqual({ status: 'conflict', reasonCodes: ['EDITION_CONFLICT'] });
  });
  it.each(['Elden Ring Shadow of the Erdtree guide', 'Elden Ring DLC guide'])('keeps same-game scope conflict separate from game identity: %s', title => {
    expect(assessment(document(prose, title))).toMatchObject({ decision: 'reject', gates: { identity: 'verified', compatibility: 'conflict' },
      findings: expect.arrayContaining([expect.objectContaining({ code: 'EDITION_CONFLICT' })]) });
  });
  it.each(['Elden Ring Nightreign guide', 'Elden Ring 2 guide'])('keeps distinct game identity strict: %s', title => {
    expect(assessment(document(prose, title))).toMatchObject({ decision: 'reject', gates: { identity: 'conflict' },
      findings: expect.arrayContaining([expect.objectContaining({ code: 'GAME_MISMATCH' })]) });
  });
  it('requires scope decisions only for questions whose facts depend on them', () => {
    expect(gamingApplicabilityScopeRequired({ prompt: 'Recommend a Samurai katana build' }, 'platform')).toBe(false);
    expect(gamingApplicabilityScopeRequired({ prompt: 'What keybindings should I use?' }, 'platform')).toBe(true);
    expect(gamingApplicabilityScopeRequired({ prompt: 'What is the regional release time?' }, 'region')).toBe(true);
  });
  it('reports missing currentness separately from applicability contradictions', () => {
    expect(evaluateGamingGuideApplicability({ guide: guide(), game: request.game, now }))
      .toMatchObject({ status: 'unverified', reasons: ['CURRENTNESS_UNVERIFIED'] });
  });
  it.each(['platform', 'region'] as const)('separates unknown %s from explicit conflicts', field => {
    const plural = field === 'platform' ? 'platforms' : 'regions';
    const code = field.toUpperCase();
    expect(evaluateGamingGuideApplicability({ guide: guide(), game: request.game, [field]: 'wanted', now }))
      .toMatchObject({ status: 'unverified', reasons: [`${code}_UNVERIFIED`] });
    expect(evaluateGamingGuideApplicability({ guide: { ...guide(), [plural]: ['other'] }, game: request.game, [field]: 'wanted', now }))
      .toMatchObject({ status: 'conflicting', reasons: [`${code}_CONFLICT`] });
  });
});
