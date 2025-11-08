import { aiLogger } from '../utils/structuredLogging.js';
import type { AuditResult, ClearFeedbackPayload } from '../types/reinforcement.js';
import { createAuditRecord, getReinforcementConfig, registerAuditRecord } from './contextualReinforcement.js';
import { sendClearFeedback } from './clearClient.js';

const CLEAR_SYSTEM_IDENTIFIER = 'CLEAR';

function validateClearPayload(payload: ClearFeedbackPayload): void {
  if (payload.system !== CLEAR_SYSTEM_IDENTIFIER) {
    throw new Error(`Unsupported audit system: ${payload.system}`);
  }

  if (typeof payload.requestId !== 'string' || payload.requestId.length === 0) {
    throw new Error('Audit payload is missing a requestId');
  }

  if (payload.payload == null || typeof payload.payload !== 'object') {
    throw new Error('Audit payload payload must be an object');
  }

  const score = (payload.payload as Record<string, unknown>).CLEAR_score;
  if (typeof score !== 'number' || Number.isNaN(score)) {
    throw new Error('Audit payload missing numeric CLEAR_score');
  }
}

export async function processClearFeedback(payload: ClearFeedbackPayload): Promise<AuditResult> {
  validateClearPayload(payload);

  const { minimumClearScore } = getReinforcementConfig();
  const score = payload.payload.CLEAR_score;
  const patternId = typeof payload.payload.pattern_id === 'string' ? payload.payload.pattern_id : undefined;
  const accepted = score >= minimumClearScore;

  const record = createAuditRecord({
    requestId: payload.requestId,
    clearScore: score,
    patternId,
    accepted,
    payload: payload.payload
  });

  registerAuditRecord(record);

  aiLogger.info('CLEAR feedback processed', {
    operation: 'audit:process',
    traceId: record.id,
    requestId: record.requestId,
    patternId: record.patternId,
    score,
    accepted
  });

  let delivered = false;
  let deliveryMessage: string | undefined;

  try {
    const delivery = await sendClearFeedback(payload);
    delivered = delivery.delivered;
    deliveryMessage = delivery.message;
  } catch (error) {
    delivered = false;
    deliveryMessage = error instanceof Error ? error.message : 'Unknown transport error';
    aiLogger.warn('Failed to deliver CLEAR feedback to external service', {
      operation: 'audit:transport',
      traceId: record.id
    }, error instanceof Error ? error : undefined);
  }

  return {
    accepted,
    traceId: record.id,
    record,
    delivered,
    deliveryMessage
  };
}
