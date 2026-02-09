/**
 * CLEAR 2.0 Governance Scoring Engine
 *
 * Evaluates ActionPlans across five dimensions on a 0.0–1.0 scale:
 * C – Clarity, L – Leverage, E – Efficiency, A – Alignment, R – Resilience
 *
 * Decision rules:
 *   overall < 0.40  → block
 *   0.40 ≤ overall < 0.70  → confirm
 *   overall ≥ 0.70  → allow
 */

import type { ClearDecision, ClearScore, ActionDefinition } from '../types/actionPlan.js';

// --- Types ---

export interface Clear2Weights {
  clarity: number;
  leverage: number;
  efficiency: number;
  alignment: number;
  resilience: number;
}

export interface Clear2Thresholds {
  allowMinimum: number;
  confirmMinimum: number;
}

export interface Clear2PrincipleScores {
  clarity: number;
  leverage: number;
  efficiency: number;
  alignment: number;
  resilience: number;
}

export interface Clear2EvaluationInput {
  actions: ActionDefinition[];
  origin: string;
  confidence: number;
  hasRollbacks?: boolean;
  capabilitiesKnown?: boolean;
  agentsRegistered?: boolean;
}

// --- Constants ---

const PRINCIPLE_KEYS: Array<keyof Clear2PrincipleScores> = [
  'clarity', 'leverage', 'efficiency', 'alignment', 'resilience'
];

const DEFAULT_WEIGHTS: Clear2Weights = {
  clarity: 0.25,
  leverage: 0.15,
  efficiency: 0.20,
  alignment: 0.20,
  resilience: 0.20
};

const DEFAULT_THRESHOLDS: Clear2Thresholds = {
  allowMinimum: 0.70,
  confirmMinimum: 0.40
};

// --- Weight Normalization ---

export function normalizeClear2Weights(weights: Clear2Weights = DEFAULT_WEIGHTS): Clear2Weights {
  const total = PRINCIPLE_KEYS.reduce((sum, key) => sum + weights[key], 0);

  if (!Number.isFinite(total) || total <= 0) {
    throw new Error('CLEAR 2.0 weights must sum to a positive finite number');
  }

  const normalized = {} as Clear2Weights;
  for (const key of PRINCIPLE_KEYS) {
    const value = weights[key];
    if (!Number.isFinite(value)) {
      throw new Error(`CLEAR 2.0 weight for ${key} must be a finite number`);
    }
    normalized[key] = value / total;
  }
  return normalized;
}

// --- Composite Score ---

export function computeClear2CompositeScore(
  scores: Clear2PrincipleScores,
  weights: Clear2Weights = DEFAULT_WEIGHTS
): number {
  const normalized = normalizeClear2Weights(weights);
  let composite = 0;

  for (const key of PRINCIPLE_KEYS) {
    const score = scores[key];
    if (!Number.isFinite(score) || score < 0 || score > 1) {
      throw new Error(`CLEAR 2.0 score for ${key} must be a finite number between 0 and 1`);
    }
    composite += score * normalized[key];
  }

  return Math.round(composite * 1000) / 1000;
}

// --- Decision ---

export function evaluateClear2Decision(
  overall: number,
  thresholds: Clear2Thresholds = DEFAULT_THRESHOLDS
): ClearDecision {
  if (!Number.isFinite(thresholds.allowMinimum) || !Number.isFinite(thresholds.confirmMinimum)) {
    throw new Error('CLEAR 2.0 thresholds must be finite numbers');
  }

  if (overall >= thresholds.allowMinimum) return 'allow';
  if (overall >= thresholds.confirmMinimum) return 'confirm';
  return 'block';
}

// --- Heuristic Scoring ---

/**
 * Compute principle scores from plan characteristics.
 * This provides baseline heuristic scoring; production deployments
 * may replace this with model-based or policy-driven scoring.
 */
export function computeClear2PrincipleScores(input: Clear2EvaluationInput): Clear2PrincipleScores {
  const { actions, origin, confidence, hasRollbacks, capabilitiesKnown, agentsRegistered } = input;

  // Clarity: explicit intent, bounded actions, known origin
  let clarity = 0.5;
  if (origin && origin.length > 0) clarity += 0.15;
  if (actions.length > 0 && actions.every(a => a.capability && a.agent_id)) clarity += 0.2;
  if (actions.every(a => a.params && Object.keys(a.params).length > 0)) clarity += 0.15;

  // Leverage: does this advance the goal meaningfully
  let leverage = confidence;
  if (actions.length >= 1 && actions.length <= 5) leverage = Math.min(1, leverage + 0.2);
  if (actions.length > 10) leverage = Math.max(0, leverage - 0.2);

  // Efficiency: lowest-cost path
  let efficiency = 0.6;
  if (actions.length === 1) efficiency += 0.2;
  if (actions.length > 5) efficiency -= 0.1 * Math.min(actions.length - 5, 4);
  if (capabilitiesKnown) efficiency += 0.1;

  // Alignment: matches user intent, policy, system role
  let alignment = 0.5;
  if (agentsRegistered) alignment += 0.2;
  alignment += confidence * 0.3;

  // Resilience: recovery capability
  let resilience = 0.4;
  if (hasRollbacks) resilience += 0.3;
  if (actions.every(a => a.timeout_ms && a.timeout_ms > 0)) resilience += 0.15;
  if (actions.length <= 3) resilience += 0.15;

  // Clamp all to [0, 1]
  const clamp = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 100) / 100;

  return {
    clarity: clamp(clarity),
    leverage: clamp(leverage),
    efficiency: clamp(efficiency),
    alignment: clamp(alignment),
    resilience: clamp(resilience)
  };
}

// --- Full Summary ---

export function buildClear2Summary(
  input: Clear2EvaluationInput,
  weights: Clear2Weights = DEFAULT_WEIGHTS,
  thresholds: Clear2Thresholds = DEFAULT_THRESHOLDS
): ClearScore {
  const scores = computeClear2PrincipleScores(input);
  const overall = computeClear2CompositeScore(scores, weights);
  const decision = evaluateClear2Decision(overall, thresholds);

  return {
    clarity: scores.clarity,
    leverage: scores.leverage,
    efficiency: scores.efficiency,
    alignment: scores.alignment,
    resilience: scores.resilience,
    overall,
    decision,
    notes: `CLEAR 2.0 evaluated: ${decision.toUpperCase()} (${overall.toFixed(3)})`
  };
}

/**
 * Evaluate CLEAR 2.0 from raw principle scores (for POST /clear/evaluate).
 */
export function buildClear2SummaryFromScores(
  scores: Clear2PrincipleScores,
  weights: Clear2Weights = DEFAULT_WEIGHTS,
  thresholds: Clear2Thresholds = DEFAULT_THRESHOLDS
): ClearScore {
  const overall = computeClear2CompositeScore(scores, weights);
  const decision = evaluateClear2Decision(overall, thresholds);

  return {
    clarity: scores.clarity,
    leverage: scores.leverage,
    efficiency: scores.efficiency,
    alignment: scores.alignment,
    resilience: scores.resilience,
    overall,
    decision,
    notes: `CLEAR 2.0 evaluated: ${decision.toUpperCase()} (${overall.toFixed(3)})`
  };
}

export { DEFAULT_WEIGHTS as CLEAR2_DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS as CLEAR2_DEFAULT_THRESHOLDS };
