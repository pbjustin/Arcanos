import { describe, expect, it } from '@jest/globals';
import { assessGamingClearSource, assessGamingClearSourceIdentity, gamingClearIntactSourceText } from '../src/shared/gaming/gamingClearSource.js';
import { assessGamingSourcePolicy, extractGamingFreshnessMetadata } from '../src/shared/gaming/gamingFreshnessCore.js';
import { gamingClearHash } from '../src/shared/gaming/gamingClearPolicy.js';
import type { ResolvedGamingDocument } from '../src/services/gamingDocumentResolution.js';
import type { GamingStoredKnowledgeInput } from '../src/shared/gaming/gamingStoredEvidenceCore.js';

const now = new Date('2026-09-09T12:00:00.000Z');
function document(game: string, title: string, text: string, partial = false): ResolvedGamingDocument {
  const publicUrl = 'https://guides.example.org/synthetic';
  return { requestedUrl: publicUrl, canonicalUrl: publicUrl, publicUrl, host: 'guides.example.org', text,
    metadata: { title, headings: game }, extraction: { strategy: 'article', rawTextLength: text.length, cleanedTextLength: text.length, navigationDensity: 0 },
    resolution: { resolverId: 'generic-web', resolverVersion: 'gaming-document-v1', strategy: 'article', documentType: 'html', supportsStructuredExtraction: false },
    metrics: { rawTextLength: text.length, cleanedTextLength: text.length, instructionFiltered: false, truncated: partial } };
}
const prompt = 'How do Intelligence, staves, and spell choices work?';
const prose = 'In Elden Ring, Intelligence supports the listed sorcery requirements. Compare staves and spell choices against the equipped staff requirements before choosing spells. Preserve enough equipment capacity to use the selected staff.';
function assess(doc: ResolvedGamingDocument, overrides: Partial<GamingStoredKnowledgeInput> = {}) {
  const input: GamingStoredKnowledgeInput = { game: 'Elden Ring', prompt, mode: 'guide', ...overrides };
  const sourcePolicy = assessGamingSourcePolicy(doc.publicUrl, input.game);
  const freshness = extractGamingFreshnessMetadata(doc, input, now);
  return assessGamingClearSource(input, doc, { subjectId: 'synthetic-source', subjectHash: gamingClearHash(doc.text),
    actorScopeHash: gamingClearHash('synthetic-caller'), sourcePolicy, freshness, now });
}

describe('Gaming CLEAR acquired source assessment', () => {
  it.each(['Elden Ring Mage Build: Intelligence, Staves, and Spell Choices', 'Understanding Intelligence and spell choices in Elden Ring',
    'Elden Ring: choosing staves for your spells'])('accepts relevant acquired identity without a narrow title suffix: %s', title => {
    expect(assess(document('Elden Ring', title, prose)).blockingFindings).toEqual([]);
    expect(assess(document('Elden Ring', title, prose))).toMatchObject({ assessmentStatus: 'completed', decision: 'accept',
      qualityEligible: true, gates: { identity: 'verified' } });
  });
  it('does not authorize identity from a Game label with unrelated title and body', () => {
    const doc = document('', 'Unidentified notebook', `Game: Elden Ring. ${'Compare staff requirements and Intelligence before choosing spells. '.repeat(4)}`);
    expect(assess(doc)).toMatchObject({ decision: 'clarify', overall: null, gates: { identity: 'unknown' } });
  });
  it('vetoes an explicit wrong body subject even with a misleading title and Game label', () => {
    const doc = document('Elden Ring', 'Elden Ring Mage Build', `Game: Elden Ring. In Diablo 4, Intelligence supports this spell setup. ${prose}`);
    expect(assess(doc).decision).toBe('reject');
  });
  it.each(['Diablo IV sorcerer build: Intelligence and staves determine spell choices. Read the listed prerequisites before choosing a spell.',
    'The anonymous game uses Intelligence, staves and spell choices. Check the equipment prerequisites before choosing one of the available spells.'])(
    'does not accept title-only identity with unrelated substantive body: %s', body => {
      expect(assess(document('Elden Ring', 'Elden Ring guide', `Game: Elden Ring. ${body}`)).decision).not.toBe('accept');
    });
  it.each(['Elden Ring Nightreign', 'Elden Ring Shadow of the Erdtree', 'Elden Ring 2', 'Elden Ring Remastered'])(
    'does not confuse the base game with explicitly distinct scope %s', game => {
      const doc = document(game, `${game} guide`, `${game} offers Intelligence, staves and spell choices. ${prose}`);
      expect(assess(doc).gates.identity).toBe('conflict');
    });
  it('keeps exact requested edition identity supported without broad alias collapse', () => {
    const doc = document('Minecraft Java', 'Minecraft Java guide', 'In Minecraft Java, the copper gate opens after aligning the redstone switches. Activate the eastern switch before crossing the bridge.');
    const input = { game: 'Minecraft Java', prompt: 'How do I open the copper gate?', mode: 'guide' as const };
    expect(assessGamingClearSourceIdentity(doc, input, assessGamingSourcePolicy(doc.publicUrl, input.game)).status).toBe('verified');
  });
  it('keeps a supporting official patch source distinct from a complete build', () => {
    const doc = { ...document('Star Wars: The Old Republic', 'Star Wars: The Old Republic patch notes',
      'Game: Star Wars: The Old Republic. Patch: 2.1. Published at: 2026-09-08. Mechanic: beam damage = 20. This update changes the documented beam damage value and does not recommend a complete talent build.'),
    publicUrl: 'https://swtor.com/patchnotes/synthetic-test' };
    expect(assess(doc, { game: 'Star Wars: The Old Republic', prompt: 'Which beam damage build is best currently?', mode: 'build' })).toMatchObject({
      sourceRole: 'patch_authority', decision: 'accept', gates: { freshness: 'not_applicable' } });
  });
  it('does not make an old build current because it was fetched today', () => {
    const doc = document('Elden Ring', 'Elden Ring guide', `Game: Elden Ring. Patch: 1.0. Published at: 2024-01-01. ${prose}`);
    expect(assess(doc, { prompt: 'Which Intelligence build is best currently?', mode: 'build' })).toMatchObject({ decision: 'partial', qualityEligible: false,
      gates: { freshness: 'unknown' }, dimensionScores: { resilience: { unresolvedFacts: expect.arrayContaining(['COMBINED_APPLICABILITY_REQUIRED']) } } });
  });
  it('rejects explicit wrong patch and future announced changes regardless of other features', () => {
    expect(assess(document('Elden Ring', 'Elden Ring guide', `Patch: 1.0. ${prose}`), { requestedVersion: '2.0' }).decision).toBe('reject');
    expect(assess(document('Elden Ring', 'Elden Ring guide', `Effective from: 2099-01-01. ${prose}`)).decision).toBe('reject');
  });
  it('evaluates matching historical patch evidence without treating its age as a currentness failure', () => {
    const doc = document('Elden Ring', 'Elden Ring guide', `Game: Elden Ring. Patch: 1.0. Effective from: 2024-01-01. Published at: 2024-01-01. ${prose}`);
    expect(assess(doc, { prompt: 'Explain historical patch 1.0 Intelligence spell choices.', requestedVersion: '1.0' })).toMatchObject({
      decision: 'accept', gates: { freshness: 'verified' } });
  });
  it('permits partial intact evidence only transiently and never invents extraction or corroboration', () => {
    expect(assess(document('Elden Ring', 'Elden Ring guide', prose, true))).toMatchObject({ decision: 'accept', qualityEligible: false,
      dimensionScores: { resilience: { score: 3, reasonCodes: ['EXTRACTION_PARTIAL'], unresolvedFacts: ['INDEPENDENT_CORROBORATION_NOT_ESTABLISHED'] } } });
    expect(assess(document('Elden Ring', 'Elden Ring guide', '')).decision).not.toBe('accept');
    const clipped = document('Elden Ring', 'Elden Ring guide', `${prose} The next spell requires`, true);
    expect(gamingClearIntactSourceText(clipped)).toBe(prose);
    expect(gamingClearIntactSourceText(document('Elden Ring', 'Elden Ring guide', 'The spell requires', true))).toBe('');
  });
  it('does not grant independent corroboration to copied source prose', () => {
    const one = assess(document('Elden Ring', 'Elden Ring guide', prose));
    const two = assess({ ...document('Elden Ring', 'Elden Ring guide', prose), publicUrl: 'https://copy.example.org/guide' });
    expect(one.dimensionScores.resilience.score).toBe(two.dimensionScores.resilience.score);
    expect(one.dimensionScores.resilience.unresolvedFacts).toContain('INDEPENDENT_CORROBORATION_NOT_ESTABLISHED');
  });
  it('binds authorization scope, question, patch, and player policy without storing their text', () => {
    const doc = document('Elden Ring', 'Elden Ring guide', prose);
    const baseline = assess(doc);
    for (const changes of [{ answerDepth: 'detailed' as const }, { spoilerMode: 'none' as const }, { requestedVersion: '1.0' },
      { prompt: 'Explain the spell choices.' }, { currentArea: 'Copper Quay' }]) expect(assess(doc, changes).contextFingerprint).not.toBe(baseline.contextFingerprint);
    expect(JSON.stringify(baseline)).not.toContain(prose);
  });
});
