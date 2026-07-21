import type { ClearDecision } from '@shared/types/actionPlan.js';

export const CLEAR2_DECISION_THRESHOLDS = Object.freeze({
  allowMinimum: 0.70,
  confirmMinimum: 0.40,
});

export const CLEAR_PUBLIC_ERRORS = Object.freeze({
  evaluationUnavailable: Object.freeze({
    code: 'CLEAR_EVALUATION_UNAVAILABLE',
    message: 'CLEAR evaluation is unavailable.',
    httpStatus: 503,
  }),
  resultInvalid: Object.freeze({
    code: 'CLEAR_RESULT_INVALID',
    message: 'CLEAR evaluation returned an invalid result.',
    httpStatus: 500,
  }),
  persistenceFailed: Object.freeze({
    code: 'CLEAR_PERSISTENCE_FAILED',
    message: 'CLEAR decision persistence failed.',
    httpStatus: 500,
  }),
  operationFailed: Object.freeze({
    code: 'CLEAR_OPERATION_FAILED',
    message: 'CLEAR operation failed.',
    httpStatus: 500,
  }),
});

export type ClearPublicError = typeof CLEAR_PUBLIC_ERRORS[keyof typeof CLEAR_PUBLIC_ERRORS];

export type Clear2Outcome =
  | { kind: 'allow' | 'confirm' | 'block'; decision: ClearDecision; overall: number | null }
  | { kind: 'indeterminate'; reason: 'missing_result' | 'missing_decision' }
  | {
      kind: 'invalid';
      reason: 'malformed_result' | 'invalid_decision' | 'invalid_score' | 'contradictory_result';
    };

const CLEAR_DECISION_VALUES = new Set<ClearDecision>(['allow', 'confirm', 'block']);

function decisionForScore(overall: number): ClearDecision {
  if (overall >= CLEAR2_DECISION_THRESHOLDS.allowMinimum) return 'allow';
  if (overall >= CLEAR2_DECISION_THRESHOLDS.confirmMinimum) return 'confirm';
  return 'block';
}

/**
 * Interpret an already-returned CLEAR 2.0 evaluation without I/O or mutation.
 * An explicit decision remains authoritative when score metadata is absent, but
 * a present malformed or contradictory score invalidates the result.
 */
export function interpretClear2Outcome(evaluation: unknown): Clear2Outcome {
  if (evaluation === null || evaluation === undefined) {
    return { kind: 'indeterminate', reason: 'missing_result' };
  }

  if (typeof evaluation !== 'object' || Array.isArray(evaluation)) {
    return { kind: 'invalid', reason: 'malformed_result' };
  }

  const candidate = evaluation as Record<string, unknown>;
  const decisionValue = candidate.decision;
  if (decisionValue === null || decisionValue === undefined) {
    return { kind: 'indeterminate', reason: 'missing_decision' };
  }
  if (typeof decisionValue !== 'string' || !CLEAR_DECISION_VALUES.has(decisionValue as ClearDecision)) {
    return { kind: 'invalid', reason: 'invalid_decision' };
  }

  const decision = decisionValue as ClearDecision;
  const overallValue = candidate.overall;
  if (overallValue === null || overallValue === undefined) {
    return { kind: decision, decision, overall: null };
  }
  if (
    typeof overallValue !== 'number'
    || !Number.isFinite(overallValue)
    || overallValue < 0
    || overallValue > 1
  ) {
    return { kind: 'invalid', reason: 'invalid_score' };
  }
  if (decisionForScore(overallValue) !== decision) {
    return { kind: 'invalid', reason: 'contradictory_result' };
  }

  return { kind: decision, decision, overall: overallValue };
}
