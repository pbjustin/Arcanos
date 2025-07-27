import { Router } from 'express';
import { modelControlHooks, memoryControl } from '../services/model-control-hooks';
import { sendErrorResponse, sendSuccessResponse, handleCatchError } from '../utils/response';

const router = Router();

// POST /codex/dispatch - route requests through AI dispatcher
router.post('/dispatch', async (req, res) => {
  const { prompt, context } = req.body || {};

  if (!prompt) {
    return sendErrorResponse(res, 400, 'prompt is required');
  }

  const userId = (req.headers['x-user-id'] as string) || 'codex';
  const sessionId = (req.headers['x-session-id'] as string) || 'dispatch';

  try {
    // Store dispatch request via memory interface
    const memKey = `dispatch_${Date.now()}`;
    await memoryControl('store', { key: memKey, value: { prompt, context }, userId, sessionId }, {
      userId,
      sessionId,
      source: 'api',
      metadata: { headers: req.headers }
    });

    // Route request through ARCANOS model
    const result = await modelControlHooks.handleApiRequest(
      '/codex/dispatch',
      'POST',
      { prompt, context, memKey },
      {
        userId,
        sessionId,
        source: 'api',
        metadata: { headers: req.headers }
      }
    );

    if (result.success) {
      sendSuccessResponse(res, 'Dispatch processed', {
        response: result.response,
        results: result.results,
        memory_key: memKey,
        timestamp: new Date().toISOString()
      });
    } else {
      sendErrorResponse(res, 500, result.error || 'Dispatch failed');
    }
  } catch (error: any) {
    handleCatchError(res, error, 'Codex dispatch');
  }
});

export default router;
