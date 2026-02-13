import express, { Request, Response } from 'express';
import { confirmGate } from "@transport/http/middleware/confirmGate.js";
import { createRateLimitMiddleware, createValidationMiddleware, securityHeaders } from "@platform/runtime/security.js";
import { asyncHandler } from "@transport/http/asyncHandler.js";
import { buildTimestampedPayload } from "@transport/http/responseHelpers.js";
import { executeCommand, listAvailableCommands } from "@services/commandCenter.js";
import type { CommandName } from "@services/commandCenter.js";

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

    //audit Assumption: rerouted command dispatch should avoid sensitive command path; risk: conflicting execution; invariant: safe prompt command used; handling: force ai:prompt.
    if (req.dispatchRerouted && req.dispatchDecision === 'reroute') {
      const reroutePrompt = resolveReroutePrompt(payload, req.body);
      const reroutedResult = await executeCommand('ai:prompt', { prompt: reroutePrompt });
      return res.status(reroutedResult.success ? 200 : 400).json({
        ...reroutedResult,
        metadata: {
          ...reroutedResult.metadata,
          dispatchRerouted: true,
          dispatchConflictCode: req.dispatchConflictCode
        }
      });
    }

    const result = await executeCommand(command, payload);

    //audit Assumption: success flag maps to HTTP 200/400; risk: incorrect status mapping for partial failures; invariant: failures return non-200; handling: map via ternary.
    res.status(result.success ? 200 : 400).json(result);
  })
);

function resolveReroutePrompt(
  payload: Record<string, unknown> | undefined,
  body: Record<string, unknown>
): string {
  const payloadPrompt = payload && typeof payload.prompt === 'string' ? payload.prompt : undefined;
  if (payloadPrompt && payloadPrompt.trim()) {
    return payloadPrompt.trim();
  }

  const bodyPromptCandidate = typeof body.message === 'string'
    ? body.message
    : typeof body.prompt === 'string'
      ? body.prompt
      : undefined;
  if (bodyPromptCandidate && bodyPromptCandidate.trim()) {
    return bodyPromptCandidate.trim();
  }

  return 'Dispatch reroute fallback for /api/commands/execute.';
}

export default router;
