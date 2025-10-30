import express, { Request, Response } from 'express';
import { confirmGate } from '../middleware/confirmGate.js';
import { createRateLimitMiddleware, createValidationMiddleware, securityHeaders } from '../utils/security.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { executeCommand, listAvailableCommands } from '../services/commandCenter.js';
import type { CommandName } from '../services/commandCenter.js';

const router = express.Router();

router.use(securityHeaders);
router.use(createRateLimitMiddleware(50, 15 * 60 * 1000));

const commandExecutionSchema = {
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

router.get(
  '/',
  (_: Request, res: Response) => {
    res.json({
      success: true,
      commands: listAvailableCommands(),
      metadata: {
        count: listAvailableCommands().length,
        timestamp: new Date().toISOString()
      }
    });
  }
);

router.get(
  '/health',
  (_: Request, res: Response) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      availableCommands: listAvailableCommands().length
    });
  }
);

router.post(
  '/execute',
  confirmGate,
  createValidationMiddleware(commandExecutionSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { command, payload } = req.body as { command: CommandName; payload?: Record<string, any> };

    const result = await executeCommand(command, payload);

    res.status(result.success ? 200 : 400).json(result);
  })
);

export default router;
