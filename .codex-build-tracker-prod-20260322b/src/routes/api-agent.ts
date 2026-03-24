import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { asyncHandler } from '@shared/http/index.js';
import { agentExecutionService } from '@services/agentExecutionService.js';
import { isAgentPlanningValidationError } from '@services/agentPlanningErrors.js';
import {
  AgentExecutionResponseSchema,
  validateAgentExecutionPayload
} from '@services/agentExecutionSchemas.js';
import { auditTrace } from '@transport/http/middleware/auditTrace.js';

const router = express.Router();

const executeAgentGoalSchema = z.object({
  goal: z.string().trim().min(1).max(10_000),
  executionMode: z.enum(['auto', 'serial', 'dag']).optional(),
  preferredCapabilities: z.array(z.string().trim().min(1)).max(20).optional(),
  payload: z.record(z.unknown()).optional(),
  sharedState: z.record(z.unknown()).optional(),
  sessionId: z.string().trim().min(1).max(200).optional()
});

router.use('/api/agent', auditTrace);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function resolveAuditTraceId(res: Response): string | null {
  const localsRecord = asRecord(res.locals);
  const traceId = localsRecord?.auditTraceId;
  return typeof traceId === 'string' && traceId.trim().length > 0 ? traceId.trim() : null;
}

function sendStructuredError(
  res: Response,
  statusCode: number,
  errorMessage: string,
  details?: string[]
): void {
  const payload: Record<string, unknown> = {
    error: errorMessage,
    code: statusCode
  };

  if (details && details.length > 0) {
    payload.details = details;
  }

  res.status(statusCode).json(payload);
}

/**
 * Execute one human goal through planner -> capability registry -> CEF.
 *
 * Purpose:
 * - Expose the structured agent execution surface above the existing CEF command layer.
 *
 * Inputs/outputs:
 * - Input: goal, optional preferred capabilities, execution mode, and payload context.
 * - Output: structured execution plan, step results, DAG summary, and persisted trace events.
 *
 * Edge case behavior:
 * - Returns explicit 400 JSON for invalid planner inputs and structured 500 JSON for unexpected failures.
 */
router.post('/api/agent/execute', asyncHandler(async (req: Request, res: Response) => {
  const parsedBody = executeAgentGoalSchema.safeParse(req.body ?? {});
  if (!parsedBody.success) {
    sendStructuredError(
      res,
      400,
      'Invalid Agent Execution Payload',
      parsedBody.error.issues.map(issue => issue.message)
    );
    return;
  }

  try {
    const responsePayload = await agentExecutionService.executeGoal({
      goal: parsedBody.data.goal,
      executionMode: parsedBody.data.executionMode,
      preferredCapabilities: parsedBody.data.preferredCapabilities,
      payload: parsedBody.data.payload,
      sharedState: parsedBody.data.sharedState,
      sessionId: parsedBody.data.sessionId,
      traceId: resolveAuditTraceId(res) ?? undefined
    });

    res.status(200).json(
      validateAgentExecutionPayload(
        AgentExecutionResponseSchema,
        responsePayload,
        'AgentExecutionResponse'
      )
    );
  } catch (error: unknown) {
    //audit Assumption: planner validation failures should surface as client errors while unexpected execution faults remain server errors; failure risk: callers cannot distinguish bad capability input from backend failure; expected invariant: known planning errors return 400 and all other failures return 500; handling strategy: classify by explicit planner error messages and return structured JSON in both branches.
    if (isAgentPlanningValidationError(error)) {
      sendStructuredError(res, 400, 'Agent Planning Failed', [resolveErrorMessage(error)]);
      return;
    }

    sendStructuredError(res, 500, 'Agent Execution Failed', [resolveErrorMessage(error)]);
  }
}));

export default router;
