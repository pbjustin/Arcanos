import { describe, expect, test } from '@jest/globals';
import { assessGamingClearSource } from '../src/shared/gaming/gamingClearSource.js';
import { assessGamingClearEvidence } from '../src/shared/gaming/gamingClearEvidence.js';
import { assessGamingSourcePolicy, extractGamingFreshnessMetadata } from '../src/shared/gaming/gamingFreshnessCore.js';
import { createGamingClearAssessment, GAMING_CLEAR_DIMENSIONS, gamingClearHash, type GamingClearDimensions } from '../src/shared/gaming/gamingClearPolicy.js';
import type { ResolvedGamingDocument } from '../src/services/gamingDocumentResolution.js';
import type { GamingStoredKnowledgeContext } from '../src/shared/gaming/gamingStoredEvidenceCore.js';
import { gamingClearCalibrationGames, gamingClearCalibrationCases, gamingClearAnswerLabels } from './fixtures/gamingClearCalibration.js';

const now = new Date('2026-09-09T12:00:00.000Z');
const allCases = gamingClearCalibrationGames.flatMap(game => gamingClearCalibrationCases.map(fixture => ({ ...game, ...fixture })));

function document(game: string, topic: string, action: string): ResolvedGamingDocument {
  const url = 'https://synthetic.example/training';
  const text = `In ${game}, this synthetic training scenario concerns the ${topic}. ${action} Confirm the listed prerequisite before proceeding; this bounded passage makes no claim about other mechanics.`;
  return { requestedUrl: url, canonicalUrl: url, publicUrl: url, host: 'synthetic.example', text,
    metadata: { title: `${game}: ${topic} and training choices`, headings: `${game} ${topic}` },
    extraction: { strategy: 'article', rawTextLength: text.length, cleanedTextLength: text.length, navigationDensity: 0 },
    resolution: { resolverId: 'generic-web', resolverVersion: 'gaming-document-v1', strategy: 'article', documentType: 'html', supportsStructuredExtraction: false },
    metrics: { rawTextLength: text.length, cleanedTextLength: text.length, instructionFiltered: false, truncated: false } };
}

describe('labeled Gaming CLEAR calibration and held-out policy corpus', () => {
  test.each(allCases)('source / $split / $kind / $variant', fixture => {
    const input = { game: fixture.game, mode: 'guide' as const, prompt: `Explain the ${fixture.topic} training step.`,
      ...(fixture.variant === 'wrong_patch' ? { requestedVersion: '2.0' } : {}) };
    const doc = document(fixture.game, fixture.topic, fixture.action);
    if (fixture.variant === 'wrong_game') doc.text = `Game: Unrelated Galaxy. ${doc.text}`;
    if (fixture.variant === 'wrong_patch') doc.text = `Patch: 1.0. ${doc.text}`;
    if (fixture.variant === 'unknown') { doc.metadata = { title: 'Unidentified training notes' }; doc.text = doc.text.replaceAll(fixture.game, 'an unidentified world'); }
    if (fixture.variant === 'missing_support') doc.text = `In ${fixture.game}, the museum displays decorative tapestries and weather paintings. No gameplay steps or equipment requirements are described in this intact synthetic passage.`;
    if (fixture.variant === 'paraphrased') doc.metadata.title = `Training choices for the ${fixture.topic} in ${fixture.game}`;
    const result = assessGamingClearSource(input, doc, { subjectId: 'source-1', subjectHash: gamingClearHash(doc.text), actorScopeHash: gamingClearHash('caller'),
      sourcePolicy: assessGamingSourcePolicy(doc.publicUrl, fixture.game), freshness: extractGamingFreshnessMetadata(doc, input, now), now });
    expect(result.decision === 'accept').toBe(fixture.expected === 'accept');
    if (fixture.expected === 'reject') expect(result.decision).toBe('reject');
  });

  test.each(allCases)('evidence / $split / $kind / $variant', fixture => {
    const input = { game: fixture.game, mode: 'guide' as const, prompt: `Explain the ${fixture.topic} training step.`,
      ...(fixture.variant === 'wrong_patch' ? { requestedVersion: '2.0' } : {}) };
    const doc = document(fixture.game, fixture.topic, fixture.action);
    if (fixture.variant === 'missing_support') doc.text = 'The museum displays weather paintings and decorative tapestries in an unrelated synthetic exhibition.';
    const metadata = extractGamingFreshnessMetadata(doc, input, now);
    if (fixture.variant === 'wrong_patch') metadata.patch = '1.0';
    const knowledge: GamingStoredKnowledgeContext = { context: doc.text, sources: [{ sourceId: 'source-1', url: doc.publicUrl,
      game: fixture.variant === 'wrong_game' ? 'Unrelated Galaxy' : fixture.variant === 'unknown' ? undefined : fixture.game,
      sourceType: 'supplied', fetchedAt: now.toISOString(), snippet: doc.text, freshnessMetadata: { ...metadata, id: 'source-1' } }],
    evidence: [{ sourceId: 'source-1', revisionId: 'revision-1', recordId: 'chunk-1', recordType: 'guide', publicUrl: doc.publicUrl,
      text: doc.text, lexicalScore: 1, combinedScore: 1, provenance: { fetchedAt: now.toISOString() } }] };
    const result = assessGamingClearEvidence(input, knowledge, { now });
    expect(result.decision === 'accept').toBe(fixture.expected === 'accept');
    if (fixture.expected === 'reject') expect(result.decision).toBe('reject');
  });

  // The semantic labels are supplied by a gold fixture. These tests measure enforcement,
  // never whether a real model will discover an invented mechanic or misleading citation.
  test.each(gamingClearCalibrationGames.flatMap(game => gamingClearAnswerLabels.map(fixture => ({ ...game, ...fixture }))))(
    'answer policy (gold judgment) / $split / $kind / $variant', fixture => {
      const dimensions = Object.fromEntries(GAMING_CLEAR_DIMENSIONS.map(name => [name, { status: 'evaluated', score: 4,
        reasonCodes: ['GOLD_FIXTURE_JUDGMENT'], evidenceRefs: ['chunk-1'], unresolvedFacts: [] }])) as GamingClearDimensions;
      const status = fixture.variant === 'audit_unavailable' ? 'unavailable' as const : 'completed' as const;
      const result = createGamingClearAssessment({ profile: 'answer', questionProfile: 'walkthrough', subjectId: 'answer-1',
        subjectHash: gamingClearHash(fixture.code ? `Invented ${fixture.topic} guidance` : fixture.action),
        contextFingerprint: gamingClearHash({ game: fixture.game, topic: fixture.topic }), evidenceRefs: ['chunk-1'],
        gates: { identity: 'verified', compatibility: 'verified', claimSupport: 'verified', freshness: 'not_applicable', provenance: 'verified', security: 'verified' },
        dimensions, assessmentMethod: 'model_assisted', assessmentStatus: status,
        findings: fixture.code ? [{ code: fixture.code, severity: status === 'unavailable' ? 'warning' : 'blocking', evidenceRefs: ['chunk-1'] }] : [],
        evaluatedAt: now.toISOString() });
      expect(result.decision === 'accept').toBe(fixture.code === null);
      if (status === 'unavailable') expect(result.overall).toBeNull();
    });
});
