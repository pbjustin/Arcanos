import { describe, expect, it } from '@jest/globals';

import { interpretClear2Outcome } from '../src/services/clearDecision.js';

const principleScores = {
  clarity: 0.8,
  leverage: 0.8,
  efficiency: 0.8,
  alignment: 0.8,
  resilience: 0.8,
};

function evaluation(overall: unknown, decision: unknown, overrides: Record<string, unknown> = {}) {
  return {
    ...principleScores,
    overall,
    decision,
    notes: 'synthetic CLEAR decision fixture',
    ...overrides,
  };
}

describe('CLEAR execution outcome contract', () => {
  it.each([
    ['block below lower boundary', 0, 'block', 'block'],
    ['block immediately below lower boundary', 0.399_999, 'block', 'block'],
    ['confirm at lower boundary', 0.4, 'confirm', 'confirm'],
    ['confirm immediately below upper boundary', 0.699_999, 'confirm', 'confirm'],
    ['allow at upper boundary', 0.7, 'allow', 'allow'],
    ['allow above upper boundary', 1, 'allow', 'allow'],
  ])('accepts %s', (_label, overall, decision, expectedKind) => {
    expect(interpretClear2Outcome(evaluation(overall, decision))).toEqual({
      kind: expectedKind,
      decision,
      overall,
    });
  });

  it.each([
    ['allow with null score', null, 'allow', 'allow'],
    ['allow with undefined score', undefined, 'allow', 'allow'],
    ['confirm with null score', null, 'confirm', 'confirm'],
    ['block with null score', null, 'block', 'block'],
  ])('preserves an explicit %s', (_label, overall, decision, expectedKind) => {
    expect(interpretClear2Outcome(evaluation(overall, decision))).toEqual({
      kind: expectedKind,
      decision,
      overall: null,
    });
  });

  it('preserves an explicit decision when the score field is missing', () => {
    expect(interpretClear2Outcome({ ...principleScores, decision: 'block' })).toEqual({
      kind: 'block',
      decision: 'block',
      overall: null,
    });
  });

  it.each([
    ['null result', null],
    ['undefined result', undefined],
  ])('classifies %s as indeterminate without inventing a decision', (_label, input) => {
    expect(interpretClear2Outcome(input)).toEqual({
      kind: 'indeterminate',
      reason: 'missing_result',
    });
  });

  it.each([
    ['empty result', {}],
    ['missing decision', { ...principleScores, overall: 0.8 }],
    ['undefined decision', evaluation(0.8, undefined)],
    ['null decision', evaluation(0.8, null)],
  ])('classifies %s as indeterminate without deriving a decision from score', (_label, input) => {
    expect(interpretClear2Outcome(input)).toEqual({
      kind: 'indeterminate',
      reason: 'missing_decision',
    });
  });

  it.each([
    ['unknown decision', evaluation(0.8, 'unknown'), 'invalid_decision'],
    ['case-variant decision', evaluation(0.8, 'ALLOW'), 'invalid_decision'],
    ['numeric decision', evaluation(0.8, 1), 'invalid_decision'],
    ['NaN score', evaluation(Number.NaN, 'block'), 'invalid_score'],
    ['positive infinity', evaluation(Number.POSITIVE_INFINITY, 'allow'), 'invalid_score'],
    ['negative infinity', evaluation(Number.NEGATIVE_INFINITY, 'block'), 'invalid_score'],
    ['numeric string', evaluation('0.8', 'allow'), 'invalid_score'],
    ['boolean score', evaluation(true, 'allow'), 'invalid_score'],
    ['object score', evaluation({ value: 0.8 }, 'allow'), 'invalid_score'],
    ['array score', evaluation([0.8], 'allow'), 'invalid_score'],
    ['negative score', evaluation(-0.001, 'block'), 'invalid_score'],
    ['excessively large score', evaluation(10, 'allow'), 'invalid_score'],
    ['array result', [], 'malformed_result'],
    ['string result', 'allow', 'malformed_result'],
    ['boolean result', true, 'malformed_result'],
    ['allow contradicts block score', evaluation(0.2, 'allow'), 'contradictory_result'],
    ['block contradicts allow score', evaluation(0.8, 'block'), 'contradictory_result'],
    ['confirm contradicts allow score', evaluation(0.8, 'confirm'), 'contradictory_result'],
  ])('rejects %s', (_label, input, expectedReason) => {
    expect(interpretClear2Outcome(input)).toEqual({
      kind: 'invalid',
      reason: expectedReason,
    });
  });

  it('does not infer a decision from a valid score when the decision is missing', () => {
    const outcome = interpretClear2Outcome({ ...principleScores, overall: 0.9 });

    expect(outcome).toEqual({ kind: 'indeterminate', reason: 'missing_decision' });
    expect(outcome).not.toHaveProperty('decision');
  });

  it('ignores unknown provider metadata after validating the authoritative fields', () => {
    expect(interpretClear2Outcome(evaluation(0.8, 'allow', {
      provider_metadata: { opaque: true },
      unknown_field: 'preserved outside interpretation',
    }))).toEqual({
      kind: 'allow',
      decision: 'allow',
      overall: 0.8,
    });
  });
});
