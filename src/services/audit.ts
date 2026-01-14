import { aiLogger } from '../utils/structuredLogging.js';
import type { AuditResult, ClearFeedbackPayload } from '../types/reinforcement.js';
import { createAuditRecord, getReinforcementConfig, registerAuditRecord } from './contextualReinforcement.js';
import { sendClearFeedback } from './clearClient.js';

const CLEAR_SYSTEM_IDENTIFIER = 'CLEAR';

interface ClearPayloadValidationResult {
  score: number;
  patternId?: string;
  payload: Record<string, unknown>;
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
  const score = payloadRecord.CLEAR_score;
  if (typeof score !== 'number' || Number.isNaN(score)) {
    //audit assumption: CLEAR_score is a valid number
    //audit failure risk: accepting invalid scoring data
    //audit expected invariant: CLEAR_score is numeric
    //audit handling strategy: throw validation error with context
    throw new ClearAuditValidationError('Audit payload missing numeric CLEAR_score', { score });
  }

  const patternId = typeof payloadRecord.pattern_id === 'string' ? payloadRecord.pattern_id : undefined;

  return {
    score,
    patternId,
    payload: payloadRecord
  };
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
  const { score, patternId, payload: normalizedPayload } = validateClearPayload(payload);

  const { minimumClearScore } = getReinforcementConfig();
  const accepted = score >= minimumClearScore;
  //audit assumption: minimumClearScore is configured within [0,1] range
  //audit failure risk: acceptance threshold may be misconfigured
  //audit expected invariant: accepted reflects score threshold comparison
  //audit handling strategy: log acceptance decision and continue

  const record = createAuditRecord({
    requestId: payload.requestId,
    clearScore: score,
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
