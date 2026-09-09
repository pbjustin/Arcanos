import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import {
  GAMING_CLEAR_DIMENSIONS, GAMING_CLEAR_RUBRIC, GAMING_CLEAR_WEIGHTS,
  classifyGamingClearQuestion, createGamingClearAssessment, gamingClearContextFingerprint,
  gamingClearHash, parseGamingClearAssessment, parseGamingClearModelAssessment,
  type GamingClearAssessmentInput, type GamingClearDimensions, type GamingClearProfile
} from '../src/shared/gaming/gamingClearPolicy.js';

const dimensions = (score = 4): GamingClearDimensions => Object.fromEntries(GAMING_CLEAR_DIMENSIONS.map(name => [name, {
  status: 'evaluated', score, reasonCodes: ['FIXTURE_SUPPORT'], evidenceRefs: ['source:1:chunk:1'], unresolvedFacts: []
}])) as GamingClearDimensions;
const input = (profile: GamingClearProfile = 'source', score = 4): GamingClearAssessmentInput => ({
  profile, questionProfile: 'walkthrough', sourceRole: 'gameplay_guide', subjectId: 'subject:1',
  subjectHash: gamingClearHash('candidate'), contextFingerprint: gamingClearContextFingerprint({ game: 'Kingdom Hearts', prompt: 'Open the door' }),
  evidenceRefs: ['source:1:chunk:1'], gates: { identity: 'verified', compatibility: 'verified', claimSupport: 'verified',
    freshness: 'not_applicable', provenance: 'verified', security: 'verified' }, dimensions: dimensions(score), evaluatedAt: '2026-09-09T00:00:00.000Z'
});

describe('Gaming CLEAR canonical policy and strict boundary', () => {
  test('keeps canonical letters, names and server-owned normalized weights', () => {
    expect(GAMING_CLEAR_DIMENSIONS.map(name => GAMING_CLEAR_RUBRIC[name].letter).join('')).toBe('CLEAR');
    expect(GAMING_CLEAR_DIMENSIONS.map(name => GAMING_CLEAR_RUBRIC[name].name)).toEqual(['Clarity', 'Leverage', 'Efficiency', 'Alignment', 'Resilience']);
    for (const weights of Object.values(GAMING_CLEAR_WEIGHTS)) expect(Object.values(weights).reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 10);
    const candidate = input();
    candidate.dimensions.clarity.score = 5;
    candidate.dimensions.resilience.score = 2;
    const result = createGamingClearAssessment({ ...candidate, overall: 5, threshold: 0 } as GamingClearAssessmentInput);
    expect(result.overall).toBe(4.05);
    expect(result.decision).toBe('reject');
    expect(result.qualityEligible).toBe(false);
  });
  test.each(['identity', 'compatibility', 'claimSupport', 'freshness', 'provenance', 'security'] as const)('perfect aggregate cannot hide %s conflict', gate => {
    const candidate = input('source', 5);
    candidate.gates[gate] = 'conflict';
    expect(createGamingClearAssessment(candidate)).toMatchObject({ overall: 5, decision: 'reject', qualityEligible: false });
  });
  test.each(['identity', 'compatibility', 'claimSupport', 'provenance', 'security'] as const)('unknown required %s is not a pass', gate => {
    const candidate = input('answer', 5);
    candidate.gates[gate] = 'unknown';
    expect(createGamingClearAssessment(candidate).decision).toBe('clarify');
  });
  test('durable floors are inclusive and independent of transient eligibility', () => {
    const candidate = input('source', 5);
    candidate.dimensions.clarity.score = 3.5;
    candidate.dimensions.alignment.score = 4;
    candidate.dimensions.resilience.score = 3.5;
    expect(createGamingClearAssessment(candidate).qualityEligible).toBe(true);
    candidate.dimensions.resilience.score = 3.499;
    expect(createGamingClearAssessment(candidate)).toMatchObject({ decision: 'accept', qualityEligible: false });
    candidate.dimensions.clarity.score = 2.999;
    expect(createGamingClearAssessment(candidate).decision).toBe('reject');
  });
  test.each(['source', 'evidence', 'answer'] as const)('%s aggregate accepts exactly at its floor', profile => {
    const candidate = input(profile, 4);
    const floor = profile === 'source' ? 3.25 : profile === 'evidence' ? 3.5 : 4;
    candidate.dimensions.clarity.score = profile === 'answer' ? 3.5 : 3;
    candidate.dimensions.alignment.score = profile === 'source' ? 3.5 : 4;
    candidate.dimensions.resilience.score = profile === 'answer' ? 3.5 : 3;
    const fixed = candidate.dimensions.clarity.score * 0.25 + candidate.dimensions.alignment.score * 0.25 + candidate.dimensions.resilience.score * 0.1;
    candidate.dimensions.leverage.score = (floor - fixed) / 0.4;
    candidate.dimensions.efficiency.score = (floor - fixed) / 0.4;
    if (profile === 'answer') {
      candidate.dimensions.leverage.score = 5;
      candidate.dimensions.efficiency.score = 3.5;
    }
    expect(createGamingClearAssessment(candidate).decision).toBe('accept');
    candidate.dimensions.leverage.score -= 0.004;
    expect(createGamingClearAssessment(candidate).decision).toBe('reject');
  });
  test('required freshness cannot be waived by N/A; supporting source is not evidence sufficiency', () => {
    const candidate = { ...input('source', 5), questionProfile: 'current_build' as const };
    expect(createGamingClearAssessment(candidate).decision).toBe('reject');
    candidate.gates.freshness = 'unknown';
    expect(createGamingClearAssessment(candidate)).toMatchObject({ decision: 'partial', qualityEligible: false });
    candidate.sourceRole = 'patch_authority';
    expect(createGamingClearAssessment(candidate).decision).toBe('accept');
    candidate.profile = 'evidence';
    expect(createGamingClearAssessment(candidate).decision).toBe('clarify');
  });
  test('completed zeros, unavailable and not-run audits remain distinct', () => {
    const candidate = input('answer', 0);
    expect(createGamingClearAssessment(candidate)).toMatchObject({ assessmentStatus: 'completed', overall: 0, decision: 'reject' });
    for (const status of ['unavailable', 'not_run'] as const) {
      const result = createGamingClearAssessment({ ...candidate, assessmentStatus: status });
      expect(result).toMatchObject({ assessmentStatus: status, overall: null, decision: 'unavailable', qualityEligible: false });
      for (const dimension of Object.values(result.dimensionScores)) expect(dimension).toMatchObject({ status: 'unknown', score: null });
    }
  });
  test.each(['5', null, [], true, false, NaN, Infinity, -Infinity, -0.01, 5.01])('rejects nonfinite/coerced/out-of-range evaluated score %p', score => {
    const value = { dimensions: dimensions(), findings: [] };
    (value.dimensions.clarity as { score: unknown }).score = score;
    expect(parseGamingClearModelAssessment(value, input().evidenceRefs)).toBeNull();
  });
  test('rejects malformed shape, missing dimensions, fabricated references and model policy selection', () => {
    const valid = { dimensions: dimensions(), findings: [] };
    expect(parseGamingClearModelAssessment(valid, input().evidenceRefs)).not.toBeNull();
    for (const value of [null, [], true, {}, { ...valid, overall: 5 }, { ...valid, policyProfile: 'easier' },
      { ...valid, findings: Array(25).fill({ code: 'UNSUPPORTED_CLAIM', severity: 'blocking', evidenceRefs: [] }) },
      { ...valid, dimensions: { clarity: valid.dimensions.clarity } },
      { ...valid, findings: [{ code: 'UNSUPPORTED_CLAIM', severity: 'blocking', evidenceRefs: ['invented:chunk'] }] }]) {
      expect(parseGamingClearModelAssessment(value, input().evidenceRefs)).toBeNull();
    }
  });
  test('unknown facts stay unknown and cannot become maximum or N/A scores', () => {
    const candidate = input('evidence', 5);
    candidate.dimensions.resilience = { status: 'unknown', score: null, reasonCodes: ['PATCH_UNKNOWN'], evidenceRefs: [], unresolvedFacts: ['APPLICABLE_PATCH'] };
    expect(createGamingClearAssessment(candidate)).toMatchObject({ overall: null, decision: 'clarify' });
    candidate.dimensions.resilience.status = 'not_applicable';
    expect(() => createGamingClearAssessment(candidate)).toThrow('Invalid Gaming CLEAR');
  });
  test('stored projection rejects stale policy, forged aggregate, decision, and unsupported positive scores', () => {
    const audit = createGamingClearAssessment(input());
    expect(parseGamingClearAssessment(audit)).toEqual(audit);
    for (const tampered of [{ ...audit, overall: 5 }, { ...audit, decision: 'reject' },
      { ...audit, policyProfile: 'gaming-clear-policy/v0:walkthrough:source' }, { ...audit, privateReasoning: 'not allowed' }]) {
      expect(parseGamingClearAssessment(tampered)).toBeNull();
    }
    const missingReferences = dimensions(5);
    missingReferences.alignment.evidenceRefs = [];
    expect(parseGamingClearModelAssessment({ dimensions: missingReferences, findings: [] }, input().evidenceRefs)).toBeNull();
    const unavailable = createGamingClearAssessment({ ...input(), assessmentStatus: 'unavailable' });
    expect(parseGamingClearAssessment(unavailable)).toEqual(unavailable);
  });
  test('does not round a just-below aggregate up across the answer floor', () => {
    const candidate = input('answer', 4);
    candidate.dimensions.leverage.score = 3.99999;
    expect(createGamingClearAssessment(candidate).overall).toBeLessThan(4);
    expect(createGamingClearAssessment(candidate).decision).toBe('reject');
  });
  test.each(['PROFILE_FLOOR_NOT_MET', 'DIMENSION_UNEVALUATED', 'IDENTITY_UNVERIFIED', 'FRESHNESS_REQUIRED'])(
    'model warnings cannot suppress server blocking reason %s', code => {
      const candidate = input('answer', 5);
      candidate.findings = [{ code, severity: 'warning', evidenceRefs: [] }];
      if (code === 'PROFILE_FLOOR_NOT_MET') candidate.dimensions.clarity.score = 0;
      if (code === 'DIMENSION_UNEVALUATED') candidate.dimensions.clarity = { status: 'unknown', score: null, reasonCodes: [], evidenceRefs: [], unresolvedFacts: [] };
      if (code === 'IDENTITY_UNVERIFIED') candidate.gates.identity = 'unknown';
      if (code === 'FRESHNESS_REQUIRED') candidate.questionProfile = 'current_build';
      const audit = createGamingClearAssessment(candidate);
      expect(audit.decision).not.toBe('accept');
      expect(audit.blockingFindings).toContainEqual(expect.objectContaining({ code, severity: 'blocking' }));
    });
  test.each(['WRONG_PATCH', 'UNSUPPORTED_MECHANIC', 'CITATION_DOES_NOT_SUPPORT_CLAIM', 'UNKNOWN_MATERIAL_DEFECT'])(
    'model cannot downgrade material answer finding %s into a style warning', code => {
      const candidate = input('answer', 5);
      candidate.findings = [{ code, severity: 'warning', evidenceRefs: candidate.evidenceRefs as string[] }];
      expect(createGamingClearAssessment(candidate)).toMatchObject({ decision: 'reject', overall: 5,
        blockingFindings: [expect.objectContaining({ code, severity: 'blocking' })] });
      candidate.findings = [{ code: 'STYLE_CONCISION', severity: 'warning', evidenceRefs: [] }];
      expect(createGamingClearAssessment(candidate).decision).toBe('accept');
    });
  test('does not accept private model prose in unresolved facts', () => {
    const candidate = dimensions();
    candidate.alignment.unresolvedFacts = ['Let me reason privately about the player...'];
    expect(parseGamingClearModelAssessment({ dimensions: candidate, findings: [] }, input().evidenceRefs)).toBeNull();
  });
  test('an answer cannot hide material unresolved facts behind perfect scores', () => {
    const candidate = input('answer', 5);
    candidate.dimensions.resilience.unresolvedFacts = ['PATCH_APPLICABILITY_UNVERIFIED'];
    expect(createGamingClearAssessment(candidate)).toMatchObject({ decision: 'reject', overall: 5,
      blockingFindings: [expect.objectContaining({ code: 'MATERIAL_FACT_UNRESOLVED' })] });
  });
  test('context bindings invalidate across caller, content, rubric, patch, player and spoiler changes', () => {
    const context = { actor: 'actor1', game: 'Elden Ring', edition: 'base', question: 'staves', patch: '1', checkpoint: 'academy', spoilers: 'avoid', depth: 'brief' };
    const original = gamingClearContextFingerprint(context);
    for (const key of Object.keys(context)) expect(gamingClearContextFingerprint({ ...context, [key]: 'changed' })).not.toBe(original);
    expect(gamingClearContextFingerprint({ ...context, rubricVersion: 'future' })).not.toBe(original);
    expect(gamingClearHash('answer [1]')).not.toBe(gamingClearHash('changed answer [2]'));
    expect(gamingClearHash({ a: 1, b: 2 })).toBe(gamingClearHash({ b: 2, a: 1 }));
  });
  test('question text can raise applicability requirements despite frontend guide mode', () => {
    expect(classifyGamingClearQuestion({ prompt: 'Best current build', mode: 'guide' })).toBe('current_build');
    expect(classifyGamingClearQuestion({ prompt: 'Server status now', mode: 'guide' })).toBe('live_status');
    expect(classifyGamingClearQuestion({ prompt: 'Open the door', mode: 'guide' })).toBe('walkthrough');
    expect(classifyGamingClearQuestion({ prompt: 'Explain gravity', mode: 'guide' })).toBe('explanation');
  });
  test('documentation preserves the canonical definitions', () => {
    const documentation = readFileSync(new URL('../docs/GAMING_GUIDE_ASSISTANCE.md', import.meta.url), 'utf8');
    for (const dimension of Object.values(GAMING_CLEAR_RUBRIC)) expect(documentation).toContain(dimension.definition);
  });
});
