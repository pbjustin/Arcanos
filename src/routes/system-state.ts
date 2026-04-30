import express, { type Request, type Response } from 'express';
import {
  executeSystemStateRequest,
  SystemStateConflictError
} from '@services/systemState.js';
import { asyncHandler } from '@shared/http/index.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';

const router = express.Router();

function buildSystemStateReadPayload(query: Request['query']): Record<string, unknown> {
  const sessionId = query.sessionId;
  return typeof sessionId === 'string' && sessionId.trim().length > 0
    ? { sessionId: sessionId.trim() }
    : {};
}

function sendSystemStateError(res: Response, error: unknown): void {
  if (error instanceof SystemStateConflictError) {
    res.status(409).json({
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.conflict
      }
    });
    return;
  }

  res.status(400).json({
    ok: false,
    error: {
      code: 'BAD_REQUEST',
      message: resolveErrorMessage(error)
    }
  });
}

router.get('/system-state', asyncHandler(async (req, res) => {
  try {
    res.json(executeSystemStateRequest(buildSystemStateReadPayload(req.query)));
  } catch (error) {
    sendSystemStateError(res, error);
  }
}));

router.post('/system-state', asyncHandler(async (req, res) => {
  try {
    res.json(executeSystemStateRequest(req.body));
  } catch (error) {
    sendSystemStateError(res, error);
  }
}));

export default router;
