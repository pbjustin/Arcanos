import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { GamingClearAssessment, GamingClearDimensions } from '../src/shared/gaming/gamingClearPolicy.js';

const actualSource = await import('../src/shared/gaming/gamingClearSource.js');
const actualEvidence = await import('../src/shared/gaming/gamingClearEvidence.js');
const actualPolicy = await import('../src/shared/gaming/gamingClearPolicy.js');
const actualBinding = await import('../src/shared/gaming/gamingClearAnswerBinding.js');
const mockSource = jest.fn(actualSource.assessGamingClearSource);
const mockIntactText = jest.fn(actualSource.gamingClearIntactSourceText);
const mockEvidence = jest.fn(actualEvidence.assessGamingClearEvidence);
const mockCreate = jest.fn(actualPolicy.createGamingClearAssessment);
const mockParseModel = jest.fn(actualPolicy.parseGamingClearModelAssessment);
const mockParseAudit = jest.fn(actualPolicy.parseGamingClearAssessment);
const mockBinding = jest.fn(actualBinding.hasBoundGamingClearAnswer);
jest.unstable_mockModule('../src/shared/gaming/gamingClearSource.js', () => ({ ...actualSource,
  assessGamingClearSource: mockSource, gamingClearIntactSourceText: mockIntactText }));
jest.unstable_mockModule('../src/shared/gaming/gamingClearEvidence.js', () => ({ ...actualEvidence,
  assessGamingClearEvidence: mockEvidence }));
jest.unstable_mockModule('../src/shared/gaming/gamingClearPolicy.js', () => ({ ...actualPolicy,
  createGamingClearAssessment: mockCreate, parseGamingClearModelAssessment: mockParseModel, parseGamingClearAssessment: mockParseAudit }));
jest.unstable_mockModule('../src/shared/gaming/gamingClearAnswerBinding.js', () => ({ ...actualBinding,
  hasBoundGamingClearAnswer: mockBinding }));
const { runGamingClearPreview, GAMING_CLEAR_PREVIEW_VERSION } = await import('../src/shared/gaming/gamingClearPreviewFixture.js');
const FAILURE = 'PREVIEW_GAMING_CLEAR_CONTRACT_INVALID';

describe('sealed Gaming CLEAR production-core fixture', () => {
  beforeEach(() => {
    mockSource.mockReset().mockImplementation(actualSource.assessGamingClearSource);
    mockIntactText.mockReset().mockImplementation(actualSource.gamingClearIntactSourceText);
    mockEvidence.mockReset().mockImplementation(actualEvidence.assessGamingClearEvidence);
    mockCreate.mockReset().mockImplementation(actualPolicy.createGamingClearAssessment);
    mockParseModel.mockReset().mockImplementation(actualPolicy.parseGamingClearModelAssessment);
    mockParseAudit.mockReset().mockImplementation(actualPolicy.parseGamingClearAssessment);
    mockBinding.mockReset().mockImplementation(actualBinding.hasBoundGamingClearAnswer);
  });

  it('repeats fixed source, evidence, model projection and final answer assertions without caller input', () => {
    expect(runGamingClearPreview()).toBeUndefined();
    expect(runGamingClearPreview()).toBeUndefined();
    expect(GAMING_CLEAR_PREVIEW_VERSION).toBe('gaming-clear/v1');
    expect(mockSource).toHaveBeenCalledWith(expect.objectContaining({ requestedVersion: '2.0' }),
      expect.objectContaining({ text: expect.stringContaining('Baseline valid for patches: 2.0') }), expect.objectContaining({ now: new Date('2026-09-09T12:00:00.000Z') }));
    expect(mockEvidence).toHaveBeenCalledWith(expect.objectContaining({ region: 'EU' }), expect.any(Object), expect.any(Object));
    expect(mockEvidence).toHaveBeenCalledWith(expect.objectContaining({ region: 'US' }), expect.any(Object), expect.any(Object));
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ profile: 'answer', findings: [expect.objectContaining({ code: 'UNSUPPORTED_MECHANIC', severity: 'warning' })] }));
    expect(mockBinding).toHaveBeenCalledWith(expect.objectContaining({ response: expect.stringContaining('Guaranteed on every patch.') }));
  });

  it.each(['valid baseline rejected', 'wrong patch admitted', 'wrong game admitted', 'filtered source admitted'])(
    'fails closed when source behavior drifts: %s', scenario => {
      mockSource.mockImplementation((input, doc, options) => {
        const result = actualSource.assessGamingClearSource(input, doc, options);
        if (scenario === 'valid baseline rejected' && doc.text.includes('Baseline valid for patches: 2.0'))
          return { ...result, decision: 'reject', gates: { ...result.gates, compatibility: 'conflict' } };
        if (scenario === 'wrong patch admitted' && result.gates.compatibility === 'conflict')
          return { ...result, decision: 'accept', gates: { ...result.gates, compatibility: 'verified' } };
        if (scenario === 'wrong game admitted' && result.gates.identity === 'conflict')
          return { ...result, decision: 'accept', gates: { ...result.gates, identity: 'verified' } };
        if (scenario === 'filtered source admitted' && doc.metrics.instructionFiltered)
          return { ...result, decision: 'accept', gates: { ...result.gates, security: 'verified' } };
        return result;
      });
      expect(runGamingClearPreview).toThrow(FAILURE);
    }
  );

  it('fails closed when clipped source claims become intact evidence', () => {
    mockIntactText.mockImplementation(doc => doc.text);
    expect(runGamingClearPreview).toThrow(FAILURE);
  });

  it.each(['matching region discarded', 'missing region accepted', 'conflicting region accepted', 'insufficient support accepted', 'currentness bypassed'])(
    'fails closed when evidence behavior drifts: %s', scenario => {
      mockEvidence.mockImplementation((input, data, options) => {
        const result = actualEvidence.assessGamingClearEvidence(input, data, options);
        if (scenario === 'matching region discarded' && input.region === 'EU')
          return { ...result, decision: 'reject', gates: { ...result.gates, compatibility: 'unknown' } };
        if (scenario === 'missing region accepted' && !input.region && result.gates.compatibility === 'unknown')
          return { ...result, decision: 'accept', gates: { ...result.gates, compatibility: 'verified' } };
        if (scenario === 'conflicting region accepted' && input.region === 'US')
          return { ...result, decision: 'accept', gates: { ...result.gates, compatibility: 'verified' } };
        if (scenario === 'insufficient support accepted' && result.gates.claimSupport === 'unknown')
          return { ...result, decision: 'accept', gates: { ...result.gates, claimSupport: 'verified' } };
        if (scenario === 'currentness bypassed' && result.gates.freshness === 'unknown')
          return { ...result, decision: 'accept', gates: { ...result.gates, freshness: 'verified' } };
        return result;
      });
      expect(runGamingClearPreview).toThrow(FAILURE);
    }
  );

  it('fails closed when malformed model projections are accepted', () => {
    mockParseModel.mockImplementation((value, refs) => actualPolicy.parseGamingClearModelAssessment(value, refs)
      ?? { dimensions: {} as GamingClearDimensions, findings: [] });
    expect(runGamingClearPreview).toThrow(FAILURE);
  });

  it('fails closed when forged persisted aggregates are accepted', () => {
    mockParseAudit.mockImplementation(value => value as GamingClearAssessment);
    expect(runGamingClearPreview).toThrow(FAILURE);
  });

  it.each(['material warning downgraded', 'unresolved fact hidden', 'audit unavailable accepted'])(
    'fails closed when answer policy drifts: %s', scenario => {
      mockCreate.mockImplementation(input => {
        const result = actualPolicy.createGamingClearAssessment(input);
        if (scenario === 'material warning downgraded' && input.findings?.some(finding => finding.code === 'UNSUPPORTED_MECHANIC'))
          return { ...result, decision: 'accept', blockingFindings: [] };
        if (scenario === 'unresolved fact hidden' && input.dimensions.resilience.unresolvedFacts.length > 0)
          return { ...result, decision: 'accept', blockingFindings: [] };
        if (scenario === 'audit unavailable accepted' && input.assessmentStatus === 'unavailable')
          return { ...result, decision: 'accept', overall: 5 };
        return result;
      });
      expect(runGamingClearPreview).toThrow(FAILURE);
    }
  );

  it('fails closed when post-audit text changes retain approval', () => {
    mockBinding.mockImplementation(carrier => carrier.response.endsWith('Guaranteed on every patch.') || actualBinding.hasBoundGamingClearAnswer(carrier));
    expect(runGamingClearPreview).toThrow(FAILURE);
  });

  it('returns only a fixed failure when a production core throws private diagnostics', () => {
    mockEvidence.mockImplementation(() => { throw new Error('synthetic-clear-private-diagnostic'); });
    let failure: unknown;
    try { runGamingClearPreview(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(FAILURE);
    expect((failure as Error).cause).toBeUndefined();
    expect(String(failure)).not.toContain('synthetic-clear-private-diagnostic');
  });
});
