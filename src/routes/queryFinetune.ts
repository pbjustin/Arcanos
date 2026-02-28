import { Request, Response, Router } from 'express';

import { DEFAULT_FINE_TUNE } from '../config/openai.js';
import { runTrinity } from '../trinity/trinity.js';
import { createRateLimitMiddleware, securityHeaders } from '@platform/runtime/security.js';

const router = Router();

router.use(securityHeaders);
router.use(createRateLimitMiddleware(30, 15 * 60 * 1000));

function getPrompt(body: { prompt?: unknown }): string | null {
  return typeof body.prompt === 'string' && body.prompt.trim().length > 0
    ? body.prompt.trim()
    : null;
}

export async function queryFinetuneHandler(req: Request, res: Response) {
  try {
    const prompt = getPrompt(req.body as { prompt?: unknown });

    if (!prompt) {
      return res.status(400).json({
        success: false,
        error: 'prompt is required'
      });
    }

    const result = await runTrinity({
      prompt,
      model: DEFAULT_FINE_TUNE,
      temperature: 0.5,
      structured: true
    });

    return res.json({
      success: true,
      ...result
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

router.post('/query-finetune', queryFinetuneHandler);

export default router;

