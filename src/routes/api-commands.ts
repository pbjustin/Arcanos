import express, { Request, Response } from 'express';
import { confirmGate } from '../middleware/confirmGate.js';
import { createRateLimitMiddleware, createValidationMiddleware, securityHeaders } from '../utils/security.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { buildTimestampedPayload } from '../utils/responseHelpers.js';
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
    const availableCommands = listAvailableCommands();
    res.json({
      success: true,
      commands: availableCommands,
      metadata: buildTimestampedPayload({
        count: availableCommands.length
      })
    });
  }
);

router.get(
  '/health',
  (_: Request, res: Response) => {
    const availableCommands = listAvailableCommands();
    res.json(
      buildTimestampedPayload({
        status: 'ok',
        availableCommands: availableCommands.length
      })
    );
  }
);

router.post(
  '/execute',
  confirmGate,
  createValidationMiddleware(commandExecutionSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { command, payload } = req.body as { command: CommandName; payload?: Record<string, any> };

    const result = await executeCommand(command, payload);

    //audit Assumption: success flag maps to HTTP 200/400; risk: incorrect status mapping for partial failures; invariant: failures return non-200; handling: map via ternary.
    res.status(result.success ? 200 : 400).json(result);
  })
);

export default router;
