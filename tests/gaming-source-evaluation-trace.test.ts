import { describe, expect, it } from '@jest/globals';
import { createGamingSourceEvaluation, updateGamingSourceEvaluation, rejectGamingSourceEvaluation,
  projectGamingSourceEvaluation, GAMING_SOURCE_EVALUATION_STAGES } from '../src/shared/gaming/gamingSourceEvaluation.js';

describe('Gaming source evaluation decision trace', () => {
  it('does not let later selection or freshness erase a definitive identity conflict', () => {
    const trace = createGamingSourceEvaluation({ candidateReference: '10000000-0000-4000-8000-000000000001', submittedIndex: 0 });
    updateGamingSourceEvaluation(trace, 'acquisition', 'passed', 'SOURCE_ACQUIRED');
    rejectGamingSourceEvaluation(trace, 'GAME_MISMATCH');
    updateGamingSourceEvaluation(trace, 'identity', 'passed', 'ACQUIRED_IDENTITY_VERIFIED');
    updateGamingSourceEvaluation(trace, 'selection', 'passed', 'EVIDENCE_SELECTED');
    expect(trace.stages.identity).toMatchObject({ status: 'rejected', reasonCode: 'GAME_MISMATCH' });
    expect(trace.stages.selection.status).toBe('not_run');
    expect(trace.outcome).toBe('rejected');
    expect(trace.recovery).toEqual({ eligible: true, reasonCode: 'REPLACEMENT_CANDIDATE_ELIGIBLE' });
  });

  it.each([
    ['SOURCE_INACCESSIBLE', 'acquisition'], ['INSUFFICIENT_EXTRACTION', 'extraction'],
    ['GAME_IDENTITY_UNVERIFIED', 'identity'], ['EDITION_CONFLICT', 'applicability'],
    ['QUESTION_COVERAGE_INSUFFICIENT', 'relevance'], ['SOURCE_USE_RESTRICTED', 'provenance'],
    ['SOURCE_INSTRUCTIONS_REJECTED', 'extraction']
  ] as const)('keeps %s separate from game mismatch', (reason, stage) => {
    const trace = createGamingSourceEvaluation({ submittedIndex: 1 });
    rejectGamingSourceEvaluation(trace, reason);
    expect(trace.stages[stage].reasonCode).toBe(reason);
    expect(trace.rejectionReasons).toEqual([reason]);
    expect(Object.keys(trace.stages)).toEqual([...GAMING_SOURCE_EVALUATION_STAGES]);
  });

  it('projects only bounded diagnostic fields and safe correlation formats', () => {
    const trace = createGamingSourceEvaluation({ submittedIndex: 0, requestId: 'private passage and token',
      workflowId: '10000000-0000-4000-8000-000000000001', traceId: 'a'.repeat(32) });
    updateGamingSourceEvaluation(trace, 'extraction', 'passed', 'EXTRACTION_INTACT', {
      completeRecords: 1, partialRecords: -1, rawText: 'copyrighted passage', token: 'secret',
      contentHash: 'a'.repeat(64), identityRuleId: 'publisher text', authority: 'official'
    } as never);
    const publicTrace = projectGamingSourceEvaluation(trace);
    expect(publicTrace.requestId).toBeUndefined();
    expect(publicTrace.workflowId).toBe(trace.workflowId);
    expect(publicTrace.stages.extraction.diagnostic).toEqual({ completeRecords: 1, contentHash: 'a'.repeat(64), authority: 'official' });
    expect(JSON.stringify(publicTrace)).not.toMatch(/copyrighted|passage|secret|token|rawText/);
  });

  it('never grants another workflow round through candidate recovery eligibility', () => {
    const trace = createGamingSourceEvaluation({ submittedIndex: 0 });
    rejectGamingSourceEvaluation(trace, 'URL_BLOCKED');
    expect(trace.recovery).toEqual({ eligible: false, reasonCode: 'CANDIDATE_RECOVERY_DENIED' });
    expect(trace).not.toHaveProperty('remainingRounds');
    expect(trace).not.toHaveProperty('workflowExpiry');
  });

  it('retains native bounded request and trace IDs', () => {
    const trace = createGamingSourceEvaluation({ submittedIndex: 0,
      requestId: 'req_1770000000000_abc123', traceId: 'trace_1770000000000_abc123' });
    expect(projectGamingSourceEvaluation(trace)).toMatchObject({
      requestId: 'req_1770000000000_abc123', traceId: 'trace_1770000000000_abc123' });
  });

  it('records cancellation without overwriting completed source stages', () => {
    const trace = createGamingSourceEvaluation({ submittedIndex: 0 });
    updateGamingSourceEvaluation(trace, 'acquisition', 'passed', 'SOURCE_ACQUIRED');
    updateGamingSourceEvaluation(trace, 'extraction', 'passed', 'EXTRACTION_INTACT');
    rejectGamingSourceEvaluation(trace, 'REQUEST_CANCELLED');
    updateGamingSourceEvaluation(trace, 'selection', 'passed', 'EVIDENCE_SELECTED');
    expect(trace.outcome).toBe('interrupted');
    expect(trace.stages.acquisition).toMatchObject({ status: 'passed', reasonCode: 'SOURCE_ACQUIRED' });
    expect(trace.stages.extraction).toMatchObject({ status: 'passed', reasonCode: 'EXTRACTION_INTACT' });
    expect(trace.stages.selection.status).toBe('not_run');
    expect(trace.rejectionReasons).toEqual(['REQUEST_CANCELLED']);
    expect(trace.recovery.eligible).toBe(false);
  });
});
