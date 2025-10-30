import express, { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { confirmGate } from '../middleware/confirmGate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  createRateLimitMiddleware,
  createValidationMiddleware,
  securityHeaders
} from '../utils/security.js';
import {
  buildTunnelContext,
  closeSession,
  createTunnelSession,
  getActiveSessionCount,
  getSessionSnapshot,
  heartbeatSession,
  publishAck,
  publishResult,
  subscribeToSession
} from '../services/commandTunnel.js';
import { executeCommand, listAvailableCommands } from '../services/commandCenter.js';

const router = express.Router();

router.use(securityHeaders);
router.use(createRateLimitMiddleware(100, 15 * 60 * 1000));

const sessionSchema = {
  clientId: {
    required: false,
    type: 'string' as const,
    maxLength: 120,
    sanitize: true
  },
  requestedTtlMs: {
    required: false,
    type: 'number' as const
  }
};

const executeSchema = {
  clientId: {
    required: true,
    type: 'string' as const,
    maxLength: 200,
    sanitize: true
  },
  token: {
    required: true,
    type: 'string' as const,
    maxLength: 256,
    sanitize: true
  },
  command: {
    required: true,
    type: 'string' as const,
    minLength: 3,
    maxLength: 100,
    sanitize: true
  },
  payload: {
    required: false,
    type: 'object' as const
  }
};

const heartbeatSchema = {
  clientId: {
    required: true,
    type: 'string' as const,
    sanitize: true
  },
  token: {
    required: true,
    type: 'string' as const,
    sanitize: true
  }
};

router.post(
  '/session',
  confirmGate,
  createValidationMiddleware(sessionSchema),
  (req: Request, res: Response) => {
    const summary = createTunnelSession(req.body);

    res.json({
      success: true,
      session: summary,
      metadata: {
        availableCommands: listAvailableCommands(),
        activeSessions: getActiveSessionCount(),
        createdAt: new Date().toISOString()
      }
    });
  }
);

router.get(
  '/stream/:clientId',
  createRateLimitMiddleware(200, 15 * 60 * 1000),
  asyncHandler(async (req: Request, res: Response) => {
    const { clientId } = req.params;
    const token = (req.query.token as string) || '';
    const subscription = subscribeToSession(clientId, token, (event) => {
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event.data)}\n\n`);
    });

    if (!subscription) {
      res.status(401).json({
        success: false,
        error: 'Invalid or expired session token',
        code: 'INVALID_SESSION'
      });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    const snapshot = getSessionSnapshot(clientId, token);
    const readyEvent = {
      type: 'ready' as const,
      data: {
        clientId,
        streamId: randomUUID(),
        connectedAt: new Date().toISOString(),
        expiresAt: snapshot?.expiresAt,
        availableCommands: listAvailableCommands()
      }
    };

    res.write(`event: ${readyEvent.type}\n`);
    res.write(`data: ${JSON.stringify(readyEvent.data)}\n\n`);

    const keepAlive = setInterval(() => {
      res.write(`event: heartbeat\n`);
      res.write(`data: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`);
    }, 25_000);

    req.on('close', () => {
      clearInterval(keepAlive);
      subscription.unsubscribe();
    });
  })
);

router.post(
  '/execute',
  confirmGate,
  createValidationMiddleware(executeSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { clientId, token, command, payload } = req.body as {
      clientId: string;
      token: string;
      command: string;
      payload?: Record<string, unknown>;
    };

    const context = buildTunnelContext(clientId, token);

    if (!context) {
      res.status(401).json({
        success: false,
        error: 'Invalid or expired session token',
        code: 'INVALID_SESSION'
      });
      return;
    }

    const commandId = randomUUID();
    publishAck(clientId, token, {
      clientId,
      commandId,
      command,
      receivedAt: new Date().toISOString()
    });

    const result = await executeCommand(command, payload as Record<string, any>, {
      ...context,
      commandId
    });

    const delivered = publishResult(clientId, token, result);

    res.status(result.success ? 202 : 400).json({
      success: result.success,
      commandId,
      queued: true,
      message: result.message,
      metadata: result.metadata,
      delivered
    });
  })
);

router.post(
  '/heartbeat',
  createValidationMiddleware(heartbeatSchema),
  (req: Request, res: Response) => {
    const { clientId, token } = req.body as { clientId: string; token: string };
    const summary = heartbeatSession(clientId, token);

    if (!summary) {
      res.status(401).json({
        success: false,
        error: 'Invalid or expired session token',
        code: 'INVALID_SESSION'
      });
      return;
    }

    res.json({
      success: true,
      session: summary
    });
  }
);

router.delete(
  '/session',
  createValidationMiddleware(heartbeatSchema),
  (req: Request, res: Response) => {
    const { clientId, token } = req.body as { clientId: string; token: string };
    const success = closeSession(clientId, token);

    if (!success) {
      res.status(401).json({
        success: false,
        error: 'Invalid or expired session token',
        code: 'INVALID_SESSION'
      });
      return;
    }

    res.json({
      success: true,
      message: 'Session closed'
    });
  }
);

router.use((_: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: 'Not found',
    code: 'NOT_FOUND'
  });
});

export default router;
