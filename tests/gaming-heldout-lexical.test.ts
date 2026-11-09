import { describe, expect, it } from '@jest/globals';
import { assessGamingClearEvidence, assessGamingRequestCoverage } from '../src/shared/gaming/gamingClearEvidence.js';
import { formatStoredGamingEvidence, selectStoredGamingEvidence } from '../src/services/gamingStoredKnowledge.js';
import { heldoutGamingPassages, heldoutGamingQuestions, heldoutGamingRecord,
  HELDOUT_GAMING_HEAD, HELDOUT_GAMING_LEXICAL_VERSION, HELDOUT_GAMING_NOW } from './testUtils/gamingHeldoutLexicalFixtures.js';

describe('held-out Gaming post-query selection and authority controls', () => {
  const observations = heldoutGamingQuestions.map(question => {
    const records = question.pool.map(id => heldoutGamingRecord(heldoutGamingPassages.find(passage => passage.id === id)!));
    const selected = selectStoredGamingEvidence(records, question.input);
    const knowledge = formatStoredGamingEvidence(selected, question.input);
    const ids = selected.map(candidate => candidate.evidence.recordId);
    const hits = ids.filter(id => question.relevant.includes(id)).length;
    return { id: question.id, kind: question.kind, selected: ids, relevant: question.relevant,
      recallAt3: question.relevant.length ? hits / question.relevant.length : null,
      precisionAt3: question.relevant.length ? hits / 3 : null,
      coverage: assessGamingRequestCoverage(question.input, knowledge).coverageSatisfied,
      clearDecision: assessGamingClearEvidence(question.input, knowledge,
        { identityVerified: true, now: new Date(HELDOUT_GAMING_NOW), requireRequestCoverage: true }).decision,
      originalProvenance: selected.every(candidate => records.some(record => candidate.evidence.recordId === record.recordId
        && candidate.evidence.revisionId === record.revisionId && candidate.evidence.publicUrl === record.publicUrl
        && candidate.source.url === record.publicUrl && candidate.evidence.provenance.fetchedAt === record.fetchedAt.toISOString())),
      spoilerExcluded: question.id !== 'heldout-spoiler-scope' || !JSON.stringify(knowledge).includes('destroys the observatory') };
  });

  it.each(heldoutGamingQuestions.filter(question => ['exact', 'complementary'].includes(question.kind)))(
    'selects independently labeled support and complete coverage for $id', question => {
      const observed = observations.find(row => row.id === question.id)!;
      expect([...observed.selected].sort()).toEqual([...question.relevant].sort());
      expect(observed).toMatchObject({ coverage: true, clearDecision: 'accept', originalProvenance: true, spoilerExcluded: true });
    });

  it.each(heldoutGamingQuestions.filter(question => question.kind === 'restriction'))(
    'keeps $id from becoming approved generation evidence', question => {
      expect(observations.find(row => row.id === question.id)!.clearDecision).not.toBe('accept');
    });

  it.each(heldoutGamingQuestions.filter(question => question.kind === 'complementary'))(
    'retains one useful passage without approving complete coverage for $id', question => {
      const record = heldoutGamingRecord(heldoutGamingPassages.find(passage => passage.id === question.relevant[0])!);
      const selected = selectStoredGamingEvidence([record], question.input);
      const knowledge = formatStoredGamingEvidence(selected, question.input);
      expect(selected).toHaveLength(1);
      expect(assessGamingRequestCoverage(question.input, knowledge).coverageSatisfied).toBe(false);
      expect(assessGamingClearEvidence(question.input, knowledge, { identityVerified: true,
        now: new Date(HELDOUT_GAMING_NOW), requireRequestCoverage: true }).decision).not.toBe('accept');
    });

  it('records held-out paraphrase failures as retrieval limits instead of relaxed verification', () => {
    expect(observations.filter(row => row.kind === 'paraphrase')).toHaveLength(4);
    expect(observations.find(row => row.id === 'heldout-anchor-paraphrase')!.selected).toEqual([]);
    expect(observations.find(row => row.id === 'heldout-frost-paraphrase')!.selected).toEqual([]);
    expect(observations.every(row => row.originalProvenance && row.spoilerExcluded)).toBe(true);
    const positives = observations.filter(row => row.recallAt3 !== null);
    console.info('GAMING_HELDOUT_SELECTION_REPORT', JSON.stringify({ version: HELDOUT_GAMING_LEXICAL_VERSION,
      studyHead: HELDOUT_GAMING_HEAD, scope: 'actual service projection/selection/formatting and deterministic CLEAR; supplied equal-rank rows; no SQL or generated answer',
      positiveQuestions: positives.length, restrictionControls: observations.length - positives.length,
      macroRecallAt3: positives.reduce((sum, row) => sum + row.recallAt3!, 0) / positives.length,
      macroPrecisionAt3: positives.reduce((sum, row) => sum + row.precisionAt3!, 0) / positives.length,
      clearAcceptCount: positives.filter(row => row.clearDecision === 'accept').length,
      falseAuthorityAccepted: observations.filter(row => row.kind === 'restriction' && row.clearDecision === 'accept').length,
      observations }));
  });
});
