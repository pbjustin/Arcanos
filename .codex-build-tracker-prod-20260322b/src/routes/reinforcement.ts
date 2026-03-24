import express, { Request, Response } from 'express';
import { auditTrace } from "@transport/http/middleware/auditTrace.js";
import { registerContextEntry, getReinforcementHealth } from "@services/contextualReinforcement.js";
import { getMemoryDigest } from "@services/memoryDigest.js";
import { processClearFeedback } from "@services/audit.js";
import {
  getJudgedFeedbackRuntimeTelemetry,
  processJudgedResponseFeedback
} from "@services/judgedResponseFeedback.js";
import type { ClearFeedbackPayload, JudgedResponsePayload } from "@shared/types/reinforcement.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import { sendBadRequest } from '@shared/http/index.js';

const router = express.Router();

router.post('/reinforce', auditTrace, (req: Request, res: Response) => {
  const { context, bias, metadata, requestId } = req.body ?? {};

  if (typeof context !== 'string' || context.trim().length === 0) {
    return sendBadRequest(res, 'context is required');
  }

  const sanitizedMetadata = typeof metadata === 'object' && metadata !== null ? metadata : undefined;
  const normalizedBias = bias === 'negative' ? 'negative' : bias === 'neutral' ? 'neutral' : 'positive';

  const entry = registerContextEntry({
    source: 'reinforce',
    summary: context.trim(),
    metadata: sanitizedMetadata,
    requestId: typeof requestId === 'string' ? requestId : res.locals.auditTraceId,
    bias: normalizedBias
  });

  return res.status(200).json({
    status: 'ok',
    traceId: res.locals.auditTraceId,
    recorded: entry
  });
});

router.post('/audit', auditTrace, async (req: Request, res: Response) => {
  const payload = req.body as ClearFeedbackPayload;

  try {
    const result = await processClearFeedback(payload);
    return res.status(200).json({
      status: 'ok',
      traceId: result.traceId,
      accepted: result.accepted,
      delivered: result.delivered,
      deliveryMessage: result.deliveryMessage,
      record: result.record
    });
  } catch (error) {
    return res.status(400).json({
      status: 'error',
      traceId: res.locals.auditTraceId,
      message: resolveErrorMessage(error)
    });
  }
});

router.post('/reinforcement/judge', auditTrace, async (req: Request, res: Response) => {
  const payload = req.body as JudgedResponsePayload;

  try {
    //audit Assumption: route-level trace id is always available from auditTrace middleware; risk: missing identifier breaks feedback traceability; invariant: every judged record has a trace id; handling: use middleware id fallback.
    const result = await processJudgedResponseFeedback(payload, res.locals.auditTraceId);
    return res.status(200).json({
      status: 'ok',
      traceId: result.traceId,
      accepted: result.accepted,
      score: result.score,
      scoreScale: result.scoreScale,
      normalizedScore: result.normalizedScore,
      persisted: result.persisted
    });
  } catch (error) {
    return sendBadRequest(res, resolveErrorMessage(error));
  }
});

router.get('/memory/digest', (_: Request, res: Response) => {
  res.json(getMemoryDigest());
});

router.get('/memory', (_: Request, res: Response) => {
  res.json(getMemoryDigest());
});

router.get('/health', (_: Request, res: Response) => {
  res.json(getReinforcementHealth());
});

router.get('/reinforcement/metrics', (_: Request, res: Response) => {
  //audit Assumption: runtime telemetry is non-sensitive operational metadata; risk: overexposing internals; invariant: response contains aggregate counters only; handling: expose sanitized aggregate snapshot.
  res.json({
    status: 'ok',
    judgedFeedback: getJudgedFeedbackRuntimeTelemetry(),
    reinforcement: getReinforcementHealth()
  });
});

export default router;
