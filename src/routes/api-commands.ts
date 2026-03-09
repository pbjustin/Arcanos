import express, { Request, Response } from 'express';
import { confirmGate } from "@transport/http/middleware/confirmGate.js";
import { createRateLimitMiddleware, createValidationMiddleware, securityHeaders } from "@platform/runtime/security.js";
import { asyncHandler } from "@shared/http/index.js";
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

function resolveCommandResponseStatusCode(result: {
  success: boolean;
  error?: {
    httpStatusCode?: number;
  } | null;
}): number {
  if (result.success) {
    return 200;
  }

  const statusCode = result.error?.httpStatusCode;
  return typeof statusCode === 'number' ? statusCode : 400;
}

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
      const reroutedResult = await executeCommand('ai:prompt', { prompt: reroutePrompt }, {
        traceId: res.locals.auditTraceId,
        source: '/api/commands/execute'
      });
      return res.status(resolveCommandResponseStatusCode(reroutedResult)).json({
        ...reroutedResult,
        metadata: {
          ...reroutedResult.metadata,
          dispatchRerouted: true,
          dispatchConflictCode: req.dispatchConflictCode
        }
      });
    }

    const result = await executeCommand(command, payload, {
      traceId: res.locals.auditTraceId,
      source: '/api/commands/execute'
    });

    //audit Assumption: typed CEF errors carry the correct HTTP class for deterministic API failures; risk: callers receive a misleading success-like 400 for authorization or internal errors; invariant: route status mirrors `error.httpStatusCode` when present; handling: resolve the response status from the structured command result.
    res.status(resolveCommandResponseStatusCode(result)).json(result);
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
