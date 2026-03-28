import express, { Request, Response } from 'express';

import {
  getLatestPromptDebugTrace,
  listPromptDebugTraces,
} from '@services/promptDebugTraceService.js';

const router = express.Router();

function resolveLimit(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

router.get('/api/prompt-debug/latest', async (_req: Request, res: Response) => {
  const requestId =
    typeof _req.query.requestId === 'string' && _req.query.requestId.trim().length > 0
      ? _req.query.requestId.trim()
      : undefined;
  const latest = await getLatestPromptDebugTrace(requestId);

  res.json({
    latest,
  });
});

router.get('/api/prompt-debug/events', async (req: Request, res: Response) => {
  const requestId =
    typeof req.query.requestId === 'string' && req.query.requestId.trim().length > 0
      ? req.query.requestId.trim()
      : undefined;
  const limit = resolveLimit(req.query.limit);
  const events = await listPromptDebugTraces(limit, requestId);

  res.json({
    count: events.length,
    events,
  });
});

export default router;
