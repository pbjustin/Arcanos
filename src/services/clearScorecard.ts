export type ClearScorecardStatus = 'green' | 'yellow' | 'red';

export interface ClearPrincipleScores {
  clarity: number;
  leverage: number;
  efficiency: number;
  alignment: number;
  resilience: number;
}

export interface ClearScorecardWeights {
  clarity: number;
  leverage: number;
  efficiency: number;
  alignment: number;
  resilience: number;
}

export interface ClearScorecardThresholds {
  greenMinimum: number;
  yellowMinimum: number;
}

export interface ClearScorecardSummary {
  scores: ClearPrincipleScores;
  weights: ClearScorecardWeights;
  compositeScore: number;
  status: ClearScorecardStatus;
}

const DEFAULT_CLEAR_SCORECARD_WEIGHTS: ClearScorecardWeights = {
  clarity: 0.25,
  leverage: 0.15,
  efficiency: 0.2,
  alignment: 0.2,
  resilience: 0.2
};

const DEFAULT_CLEAR_SCORECARD_THRESHOLDS: ClearScorecardThresholds = {
  greenMinimum: 8,
  yellowMinimum: 6
};

const CLEAR_PRINCIPLE_KEYS: Array<keyof ClearPrincipleScores> = [
  'clarity',
  'leverage',
  'efficiency',
  'alignment',
  'resilience'
];

/**
 * Normalize scorecard weights so they sum to 1.
 * Inputs: weight map to normalize.
 * Outputs: normalized weight map.
 * Edge cases: throws if weights sum to 0 or contain non-finite values.
 */
export function normalizeClearWeights(weights: ClearScorecardWeights = DEFAULT_CLEAR_SCORECARD_WEIGHTS): ClearScorecardWeights {
  const entries = CLEAR_PRINCIPLE_KEYS.map(key => [key, weights[key]] as const);
  const totalWeight = entries.reduce((sum, [, value]) => sum + value, 0);

  if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
    //audit assumption: weights sum must be positive
    //audit failure risk: division by zero or invalid composite scores
    //audit expected invariant: totalWeight is finite and > 0
    //audit handling strategy: throw with diagnostic context
    throw new Error('CLEAR scorecard weights must sum to a positive number');
  }

  const normalizedWeights = {} as ClearScorecardWeights;
  for (const [key, value] of entries) {
    if (!Number.isFinite(value)) {
      //audit assumption: each weight is finite
      //audit failure risk: NaN propagating into composite score
      //audit expected invariant: weight is finite
      //audit handling strategy: throw with diagnostic context
      throw new Error(`CLEAR scorecard weight for ${key} must be a finite number`);
    }
    normalizedWeights[key] = value / totalWeight;
  }

  return normalizedWeights;
}

/**
 * Compute the CLEAR composite score using weighted principle scores.
 * Inputs: principle scores (0-10) and optional weights.
 * Outputs: composite score on a 0-10 scale.
 * Edge cases: throws if scores are missing or non-finite.
 */
export function computeClearCompositeScore(
  scores: ClearPrincipleScores,
  weights: ClearScorecardWeights = DEFAULT_CLEAR_SCORECARD_WEIGHTS
): number {
  const normalizedWeights = normalizeClearWeights(weights);

  let compositeTotal = 0;
  for (const key of CLEAR_PRINCIPLE_KEYS) {
    const scoreValue = scores[key];
    if (!Number.isFinite(scoreValue)) {
      //audit assumption: each score is numeric
      //audit failure risk: invalid composite score output
      //audit expected invariant: scoreValue is finite
      //audit handling strategy: throw with diagnostic context
      throw new Error(`CLEAR score for ${key} must be a finite number`);
    }
    compositeTotal += scoreValue * normalizedWeights[key];
  }

  return compositeTotal;
}

/**
 * Evaluate CLEAR status based on composite score thresholds.
 * Inputs: composite score (0-10) and optional thresholds.
 * Outputs: status label (green/yellow/red).
 * Edge cases: throws if thresholds are not finite.
 */
export function evaluateClearStatus(
  compositeScore: number,
  thresholds: ClearScorecardThresholds = DEFAULT_CLEAR_SCORECARD_THRESHOLDS
): ClearScorecardStatus {
  if (!Number.isFinite(thresholds.greenMinimum) || !Number.isFinite(thresholds.yellowMinimum)) {
    //audit assumption: thresholds are numeric
    //audit failure risk: incorrect status classification
    //audit expected invariant: thresholds are finite numbers
    //audit handling strategy: throw with diagnostic context
    throw new Error('CLEAR scorecard thresholds must be finite numbers');
  }

  if (compositeScore >= thresholds.greenMinimum) {
    //audit assumption: composite score above greenMinimum is healthy
    //audit failure risk: misclassification if thresholds are misconfigured
    //audit expected invariant: green scores are >= greenMinimum
    //audit handling strategy: return green when threshold met
    return 'green';
  }

  if (compositeScore >= thresholds.yellowMinimum) {
    //audit assumption: composite score between thresholds is remediation state
    //audit failure risk: false positive on remediation
    //audit expected invariant: yellow scores fall between yellowMinimum and greenMinimum
    //audit handling strategy: return yellow when threshold met
    return 'yellow';
  }

  //audit assumption: composite score below yellowMinimum is blocking
  //audit failure risk: permitting unsafe deployments
  //audit expected invariant: red scores are below yellowMinimum
  //audit handling strategy: return red for low scores
  return 'red';
}

/**
 * Build a full CLEAR scorecard summary from principle scores.
 * Inputs: principle scores and optional weights/thresholds.
 * Outputs: summary with composite score, status, and weights used.
 * Edge cases: throws if scores or thresholds are invalid.
 */
export function buildClearScorecardSummary(
  scores: ClearPrincipleScores,
  weights: ClearScorecardWeights = DEFAULT_CLEAR_SCORECARD_WEIGHTS,
  thresholds: ClearScorecardThresholds = DEFAULT_CLEAR_SCORECARD_THRESHOLDS
): ClearScorecardSummary {
  const normalizedWeights = normalizeClearWeights(weights);
  const compositeScore = computeClearCompositeScore(scores, normalizedWeights);
  const status = evaluateClearStatus(compositeScore, thresholds);

  return {
    scores,
    weights: normalizedWeights,
    compositeScore,
    status
  };
}

/**
 * Safely parse and validate CLEAR principle scores from untyped input.
 * Inputs: unknown value that should contain principle scores.
 * Outputs: typed scores or null if validation fails.
 * Edge cases: returns null when required keys are missing.
 */
export function parseClearPrincipleScores(input: unknown): ClearPrincipleScores | null {
  if (input == null || typeof input !== 'object') {
    //audit assumption: input must be an object
    //audit failure risk: missing scorecard detail
    //audit expected invariant: input is an object
    //audit handling strategy: return null for invalid input
    return null;
  }

  const candidate = input as Record<string, unknown>;
  const scores: Partial<ClearPrincipleScores> = {};

  for (const key of CLEAR_PRINCIPLE_KEYS) {
    const value = candidate[key];
    if (typeof value !== 'number' || Number.isNaN(value)) {
      //audit assumption: each principle score is numeric
      //audit failure risk: incomplete scorecard scoring
      //audit expected invariant: each score is number
      //audit handling strategy: return null to force fallback
      return null;
    }
    scores[key] = value;
  }

  return scores as ClearPrincipleScores;
}
