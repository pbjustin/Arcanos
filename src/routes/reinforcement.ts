import express, { Request, Response } from 'express';
import { auditTrace } from '../middleware/auditTrace.js';
import { registerContextEntry, getReinforcementHealth } from '../services/contextualReinforcement.js';
import { getMemoryDigest } from '../services/memoryDigest.js';
import { processClearFeedback } from '../services/audit.js';
import type { ClearFeedbackPayload } from '../types/reinforcement.js';

const router = express.Router();

router.post('/reinforce', auditTrace, (req: Request, res: Response) => {
  const { context, bias, metadata, requestId } = req.body ?? {};

  if (typeof context !== 'string' || context.trim().length === 0) {
    return res.status(400).json({ error: 'context is required' });
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
      message: error instanceof Error ? error.message : 'Unknown error'
    });
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

export default router;
