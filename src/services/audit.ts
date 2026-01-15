import { aiLogger } from '../utils/structuredLogging.js';
import type { AuditResult, ClearFeedbackPayload, ClearScoreScale } from '../types/reinforcement.js';
import { createAuditRecord, getReinforcementConfig, registerAuditRecord } from './contextualReinforcement.js';
import { sendClearFeedback } from './clearClient.js';
import {
  buildClearScorecardSummary,
  parseClearPrincipleScores,
  type ClearScorecardSummary
} from './clearScorecard.js';

const CLEAR_SYSTEM_IDENTIFIER = 'CLEAR';

interface ClearPayloadValidationResult {
  score: number;
  scoreScale: ClearScoreScale;
  patternId?: string;
  payload: Record<string, unknown>;
  scorecardSummary?: ClearScorecardSummary;
}

class ClearAuditValidationError extends Error {
  public readonly details: Record<string, unknown>;

  /**
   * Describe an invalid CLEAR audit payload so callers can emit structured errors.
   * Inputs: message + contextual details to log.
   * Outputs: Error instance with details and name for classification.
   * Edge cases: details may be empty for unknown validation failures.
   */
  public constructor(message: string, details: Record<string, unknown>) {
    super(message);
    this.name = 'ClearAuditValidationError';
    this.details = details;
  }
}

/**
 * Validate and normalize CLEAR audit payloads for downstream processing.
 * Inputs: raw ClearFeedbackPayload from HTTP or internal callers.
 * Outputs: normalized score, optional pattern id, and payload object.
 * Edge cases: throws ClearAuditValidationError when required fields are missing.
 */
function validateClearPayload(payload: ClearFeedbackPayload): ClearPayloadValidationResult {
  if (payload.system !== CLEAR_SYSTEM_IDENTIFIER) {
    //audit assumption: only CLEAR system identifiers are supported
    //audit failure risk: mis-routed audit data could be stored incorrectly
    //audit expected invariant: payload.system matches CLEAR_SYSTEM_IDENTIFIER
    //audit handling strategy: throw validation error with context
    throw new ClearAuditValidationError('Unsupported audit system', { system: payload.system });
  }

  if (typeof payload.requestId !== 'string' || payload.requestId.length === 0) {
    //audit assumption: requestId is a non-empty string for traceability
    //audit failure risk: untraceable audit records
    //audit expected invariant: requestId exists and is non-empty
    //audit handling strategy: throw validation error with context
    throw new ClearAuditValidationError('Audit payload is missing a requestId', { requestId: payload.requestId });
  }

  if (payload.payload == null || typeof payload.payload !== 'object') {
    //audit assumption: payload payload is an object containing CLEAR fields
    //audit failure risk: malformed payload cannot be parsed safely
    //audit expected invariant: payload.payload is a non-null object
    //audit handling strategy: throw validation error with context
    throw new ClearAuditValidationError('Audit payload payload must be an object', { payloadType: typeof payload.payload });
  }

  const payloadRecord = payload.payload as Record<string, unknown>;
  const scorecardScores = parseClearPrincipleScores(payloadRecord.scores);
  const scorecardSummary = scorecardScores ? buildClearScorecardSummary(scorecardScores) : undefined;
  const rawScore = payloadRecord.CLEAR_score;
  const score = typeof rawScore === 'number' && !Number.isNaN(rawScore)
    ? rawScore
    : scorecardSummary?.compositeScore;

  if (typeof score !== 'number' || Number.isNaN(score)) {
    //audit assumption: CLEAR_score or scorecard summary is provided
    //audit failure risk: accepting invalid scoring data
    //audit expected invariant: score value is numeric
    //audit handling strategy: throw validation error with context
    throw new ClearAuditValidationError('Audit payload missing numeric CLEAR score', {
      score: rawScore,
      scores: payloadRecord.scores
    });
  }

  const scoreScale = resolveClearScoreScale(score, payloadRecord.score_scale);
  //audit assumption: scorecardSummary is available only when principle scores are provided
  //audit failure risk: missing scorecard details in audit payload
  //audit expected invariant: normalizedPayload includes clear_scorecard when derived
  //audit handling strategy: append clear_scorecard when summary is computed
  const normalizedPayload = scorecardSummary
    ? { ...payloadRecord, clear_scorecard: scorecardSummary }
    : payloadRecord;

  const patternId = typeof payloadRecord.pattern_id === 'string' ? payloadRecord.pattern_id : undefined;

  return {
    score,
    scoreScale,
    patternId,
    payload: normalizedPayload,
    scorecardSummary
  };
}

/**
 * Resolve the score scale using an explicit payload hint or heuristic fallback.
 * Inputs: numeric score and optional declared scale.
 * Outputs: score scale string used for normalization.
 * Edge cases: defaults to heuristic based on score magnitude.
 */
function resolveClearScoreScale(score: number, declaredScale?: unknown): ClearScoreScale {
  if (declaredScale === '0-1' || declaredScale === '0-10') {
    //audit assumption: declared scale is trusted when provided
    //audit failure risk: incorrect scale hints could skew acceptance gating
    //audit expected invariant: declared scale matches actual score scale
    //audit handling strategy: honor declared scale and rely on audits
    return declaredScale;
  }

  if (score <= 1) {
    //audit assumption: scores <= 1 are normalized 0-1 scores
    //audit failure risk: misclassifying low 0-10 scores as normalized
    //audit expected invariant: normalized scores fall between 0 and 1
    //audit handling strategy: default to 0-1 scale when score <= 1
    return '0-1';
  }

  //audit assumption: scores above 1 use 0-10 scale
  //audit failure risk: accepting over-scaled scores
  //audit expected invariant: 0-10 scale scores exceed 1
  //audit handling strategy: default to 0-10 scale for score > 1
  return '0-10';
}

/**
 * Normalize a CLEAR score to the same scale as the configured minimum.
 * Inputs: score value, score scale, and minimum configured score.
 * Outputs: normalized score for acceptance checks.
 * Edge cases: if scale differs, the score is converted to match the minimum scale.
 */
function normalizeClearScoreForThreshold(
  score: number,
  scoreScale: ClearScoreScale,
  minimumClearScore: number
): number {
  const minimumScale: ClearScoreScale = minimumClearScore <= 1 ? '0-1' : '0-10';

  if (scoreScale === minimumScale) {
    //audit assumption: score and minimum share the same scale
    //audit failure risk: mismatched comparisons if scale not aligned
    //audit expected invariant: scoreScale matches minimumScale
    //audit handling strategy: return score unchanged
    return score;
  }

  if (scoreScale === '0-10' && minimumScale === '0-1') {
    //audit assumption: converting 0-10 score to 0-1 for comparison
    //audit failure risk: inaccurate normalization if input scale is wrong
    //audit expected invariant: dividing by 10 yields normalized score
    //audit handling strategy: divide by 10 for comparison
    return score / 10;
  }

  //audit assumption: converting 0-1 score to 0-10 for comparison
  //audit failure risk: inaccurate normalization if input scale is wrong
  //audit expected invariant: multiplying by 10 yields 0-10 score
  //audit handling strategy: multiply by 10 for comparison
  return score * 10;
}

/**
 * Attempt to deliver CLEAR feedback without mutating local audit state.
 * Inputs: validated payload and sender dependency.
 * Outputs: delivery status and optional message.
 * Edge cases: network failures return a false delivery with message.
 */
async function attemptClearFeedbackDelivery(
  payload: ClearFeedbackPayload,
  sendClearFeedbackRequest: typeof sendClearFeedback
): Promise<{ delivered: boolean; deliveryMessage?: string }> {
  try {
    const delivery = await sendClearFeedbackRequest(payload);
    //audit assumption: sendClearFeedbackRequest resolves to a delivery result
    //audit failure risk: missing message details for operators
    //audit expected invariant: delivery.delivered reflects downstream response
    //audit handling strategy: return structured delivery status
    return { delivered: delivery.delivered, deliveryMessage: delivery.message };
  } catch (error) {
    //audit assumption: delivery may fail due to network or endpoint issues
    //audit failure risk: silent delivery failures
    //audit expected invariant: errors are logged and propagated as messages
    //audit handling strategy: log warning and return failure message
    aiLogger.warn('Failed to deliver CLEAR feedback to external service', {
      operation: 'audit:transport',
      errorMessage: error instanceof Error ? error.message : 'Unknown transport error'
    }, error instanceof Error ? error : undefined);
    return {
      delivered: false,
      deliveryMessage: error instanceof Error ? error.message : 'Unknown transport error'
    };
  }
}

/**
 * Process CLEAR feedback by validating input, storing an audit record, and forwarding feedback.
 * Inputs: ClearFeedbackPayload from the audit route.
 * Outputs: AuditResult describing acceptance, delivery, and stored record metadata.
 * Edge cases: throws validation errors for malformed payloads.
 */
export async function processClearFeedback(payload: ClearFeedbackPayload): Promise<AuditResult> {
  const { score, scoreScale, patternId, payload: normalizedPayload } = validateClearPayload(payload);

  const { minimumClearScore } = getReinforcementConfig();
  const normalizedScore = normalizeClearScoreForThreshold(score, scoreScale, minimumClearScore);
  const accepted = normalizedScore >= minimumClearScore;
  //audit assumption: minimumClearScore is configured for either 0-1 or 0-10 scale
  //audit failure risk: acceptance threshold may be misconfigured
  //audit expected invariant: accepted reflects score threshold comparison
  //audit handling strategy: log acceptance decision and continue

  const record = createAuditRecord({
    requestId: payload.requestId,
    clearScore: score,
    normalizedClearScore: normalizedScore,
    scoreScale,
    patternId,
    accepted,
    payload: normalizedPayload
  });
  //audit assumption: audit record creation is deterministic from inputs
  //audit failure risk: record creation could fail silently
  //audit expected invariant: record includes requestId and score
  //audit handling strategy: rely on createAuditRecord to throw on failure

  registerAuditRecord(record);
  //audit assumption: record registration is idempotent per record id
  //audit failure risk: partial state if registration fails
  //audit expected invariant: record stored in reinforcement window
  //audit handling strategy: allow error propagation to caller

  aiLogger.info('CLEAR feedback processed', {
    operation: 'audit:process',
    traceId: record.id,
    requestId: record.requestId,
    patternId: record.patternId,
    score,
    accepted
  });

  const { delivered, deliveryMessage } = await attemptClearFeedbackDelivery(payload, sendClearFeedback);

  return {
    accepted,
    traceId: record.id,
    record,
    delivered,
    deliveryMessage
  };
}
