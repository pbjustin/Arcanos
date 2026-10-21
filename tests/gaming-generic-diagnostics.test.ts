import { describe, expect, it, jest } from '@jest/globals';
import { createGamingSourceEvaluation, projectGamingSourceEvaluation, rejectGamingSourceEvaluation,
  updateGamingSourceEvaluation } from '../src/shared/gaming/gamingSourceEvaluation.js';

describe('generic source rejection diagnostics', () => {
  it.each([
    ['SOURCE_INSTRUCTIONS_REJECTED', 'extraction', 'security'],
    ['URL_BLOCKED', 'acquisition', 'security'],
    ['SOURCE_USE_RESTRICTED', 'provenance', 'security'],
    ['REVIEWED_OFFICIAL_CURRENTNESS_SOURCE_REQUIRED', 'provenance', 'policy'],
    ['SOURCE_INACCESSIBLE', 'acquisition', 'source_access'],
    ['SOURCE_FETCH_FAILED', 'acquisition', 'source_access'],
    ['SOURCE_EXTRACTION_FAILED', 'extraction', 'extraction'],
    ['INSUFFICIENT_EXTRACTION', 'extraction', 'gameplay_quality'],
    ['GAME_IDENTITY_UNVERIFIED', 'identity', 'gameplay_quality']
  ] as const)('classifies %s without article text', (reason, stage, failureClass) => {
    const trace = createGamingSourceEvaluation({ submittedIndex: 0 });
    rejectGamingSourceEvaluation(trace, reason);
    expect(projectGamingSourceEvaluation(trace).stages[stage].diagnostic).toMatchObject({ failureClass });
  });

  it('separates an extraction deadline from an inaccessible publisher', () => {
    const trace = createGamingSourceEvaluation({ submittedIndex: 0 });
    rejectGamingSourceEvaluation(trace, 'SOURCE_TIMEOUT', { acquisitionStage: 'extraction' });
    expect(projectGamingSourceEvaluation(trace).stages.acquisition.diagnostic).toEqual({
      acquisitionStage: 'extraction', failureClass: 'extraction'
    });
  });

  it('reports an authority-policy rejection before acquiring an unreviewed currentness source', async () => {
    const { evaluateGamingHybridCandidates } = await import('../src/services/gamingHybridCandidates.js');
    const resolveDocument = jest.fn(async () => { throw new Error('Acquisition must not run'); });
    const result = await evaluateGamingHybridCandidates({ game: 'Lantern Voyage', mode: 'guide',
      prompt: 'Verify the current patch.', protocolVersion: 'gaming-hybrid-v2', discoveryType: 'currentness_verification',
      candidates: [{ url: 'https://community.example.org/guide' }] }, { actorKey: 'synthetic-diagnostic-actor' }, { resolveDocument });
    expect(resolveDocument).not.toHaveBeenCalled();
    expect(result.accepted).toEqual([]);
    expect(result.evaluations[0].stages.provenance).toEqual({ status: 'rejected',
      reasonCode: 'REVIEWED_OFFICIAL_CURRENTNESS_SOURCE_REQUIRED', diagnostic: { acquisitionStage: 'admission', failureClass: 'policy' } });
  });

  it('retains an acquired extraction failure stage when the overall budget also expires', async () => {
    const { evaluateGamingHybridCandidates } = await import('../src/services/gamingHybridCandidates.js');
    const { GamingDocumentAcquisitionError } = await import('../src/services/gamingDocumentResolution.js');
    const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort());
    try {
      const result = await evaluateGamingHybridCandidates({ game: 'Lantern Voyage', mode: 'guide',
        prompt: 'Explain the starting route.', protocolVersion: 'gaming-hybrid-v2',
        candidates: [{ url: 'https://community.example.org/guide' }] }, { actorKey: 'synthetic-diagnostic-actor' }, {
        resolveDocument: async () => { throw new GamingDocumentAcquisitionError('SOURCE_TIMEOUT', 'extraction', 'DEADLINE_EXCEEDED'); }
      });
      expect(result.accepted).toEqual([]);
      expect(result.evaluations[0].stages.acquisition).toMatchObject({ status: 'rejected', reasonCode: 'SOURCE_TIMEOUT',
        diagnostic: { acquisitionStage: 'extraction', failureClass: 'extraction' } });
    } finally { timeout.mockRestore(); }
  });

  it('retains bounded extraction counts on a quality rejection', () => {
    const trace = createGamingSourceEvaluation({ submittedIndex: 0 });
    updateGamingSourceEvaluation(trace, 'extraction', 'unknown', 'EXTRACTION_UNVERIFIED', {
      extractedChars: 4000, completeRecords: 0, partialRecords: 12, truncated: true
    });
    rejectGamingSourceEvaluation(trace, 'INSUFFICIENT_EXTRACTION');
    expect(projectGamingSourceEvaluation(trace).stages.extraction.diagnostic).toEqual({
      extractedChars: 4000, completeRecords: 0, partialRecords: 12, truncated: true, failureClass: 'gameplay_quality'
    });
  });

  it('projects closed identity semantics while dropping raw subjects and arbitrary classifications', () => {
    const trace = createGamingSourceEvaluation({ submittedIndex: 0 });
    rejectGamingSourceEvaluation(trace, 'GAME_IDENTITY_UNVERIFIED', {
      identityRuleId: 'gaming.identity.family_scope_unverified', identityCategory: 'document_title',
      identitySubjectKind: 'article_topic', identityScope: 'unknown', identityDetermination: 'insufficient_corroboration',
      rawSubject: 'secret publisher passage', failureClass: 'secret value'
    } as never);
    expect(projectGamingSourceEvaluation(trace).stages.identity.diagnostic).toEqual({
      identityRuleId: 'gaming.identity.family_scope_unverified', identityCategory: 'document_title',
      identitySubjectKind: 'article_topic', identityScope: 'unknown', identityDetermination: 'insufficient_corroboration',
      failureClass: 'gameplay_quality'
    });
    trace.stages.identity.diagnostic = { identitySubjectKind: 'secret', identityScope: 'secret',
      identityDetermination: 'secret', failureClass: 'secret', rawText: 'secret' } as never;
    expect(projectGamingSourceEvaluation(trace).stages.identity.diagnostic).toEqual({});
  });
});
