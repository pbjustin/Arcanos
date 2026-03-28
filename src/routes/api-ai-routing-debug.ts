import express, { Request, Response } from 'express';

import { getLatestAiRoutingDebugSnapshot } from '@services/aiRoutingDebugService.js';

const router = express.Router();

router.get('/api/ai-routing/debug/latest', (req: Request, res: Response) => {
  const requestId =
    typeof req.query.requestId === 'string' && req.query.requestId.trim().length > 0
      ? req.query.requestId.trim()
      : undefined;

  res.json({
    latest: getLatestAiRoutingDebugSnapshot(requestId),
  });
});

export default router;
