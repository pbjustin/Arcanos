import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { asyncHandler } from '@shared/http/index.js';
import { agentExecutionService } from '@services/agentExecutionService.js';
import type {
  AgentExecutionPlan,
  AgentGoalExecutionRequest,
} from '@services/agentExecutionTypes.js';
import {
  buildAgentPlanConfirmationIntent,
  issueAgentPlanExecutionPermits,
  prepareAgentExecutionPlan,
} from '@services/agentExecutionConfirmation.js';
import { isAgentPlanningValidationError } from '@services/agentPlanningErrors.js';
import {
  AgentExecutionResponseSchema,
  validateAgentExecutionPayload
} from '@services/agentExecutionSchemas.js';
import { cefBodyParser } from '@services/controlPlane/cefBodyParser.js';
import { cefHttpBoundary } from '@services/controlPlane/cefHttpBoundary.js';
import {
  buildCefConfirmationBinding,
  buildCefDispatchConfirmationState,
} from '@services/controlPlane/cefConfirmation.js';
import { auditTrace } from '@transport/http/middleware/auditTrace.js';
import { confirmGate } from '@transport/http/middleware/confirmGate.js';

const router = express.Router();
const preparedAgentRequest = Symbol('preparedAgentRequest');
const preparedAgentPlan = Symbol('preparedAgentPlan');

type PreparedAgentExecutionRequest = Request & {
  [preparedAgentRequest]?: AgentGoalExecutionRequest;
  [preparedAgentPlan]?: AgentExecutionPlan;
};

const executeAgentGoalSchema = z.object({
  goal: z.string().trim().min(1).max(10_000),
  executionMode: z.enum(['auto', 'serial', 'dag']).optional(),
  preferredCapabilities: z.array(z.string().trim().min(1)).max(20).optional(),
  payload: z.record(z.unknown()).optional(),
  sharedState: z.record(z.unknown()).optional(),
  sessionId: z.string().trim().min(1).max(200).optional()
});

router.use('/api/agent', cefHttpBoundary);
router.use('/api/agent', cefBodyParser);
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

  const executionRequest: AgentGoalExecutionRequest = {
    goal: parsedBody.data.goal,
    executionMode: parsedBody.data.executionMode,
    preferredCapabilities: parsedBody.data.preferredCapabilities,
    payload: parsedBody.data.payload,
    sharedState: parsedBody.data.sharedState,
    sessionId: parsedBody.data.sessionId,
    traceId: resolveAuditTraceId(res) ?? undefined,
  };

  try {
    const plan = prepareAgentExecutionPlan(executionRequest);
    const principalId = req.controlPlanePrincipal?.principalId;
    if (!principalId) {
      res.status(403).json({
        ok: false,
        error: {
          code: 'CONTROL_PLANE_FORBIDDEN',
          message: 'Control-plane operation is not permitted.',
        },
      });
      return;
    }

    const preparedRequest = req as PreparedAgentExecutionRequest;
    preparedRequest[preparedAgentRequest] = executionRequest;
    preparedRequest[preparedAgentPlan] = plan;

    let confirmationAccepted = false;
    confirmGate(req, res, () => {
      confirmationAccepted = true;
    }, {
      challengeBinding: buildCefConfirmationBinding(req, principalId),
      requestFingerprintBody: {
        ...buildAgentPlanConfirmationIntent(plan),
        executionContext: {
          sessionId: executionRequest.sessionId ?? null,
          sharedState: executionRequest.sharedState ?? {},
        },
        dispatch: buildCefDispatchConfirmationState(req),
      },
      requireChallengeToken: true,
    });
    if (!confirmationAccepted) {
      return;
    }
    if (req.confirmationContext?.usedChallengeToken !== true) {
      res.status(403).json({
        error: 'Confirmation required',
        code: 'CONFIRMATION_REQUIRED',
      });
      return;
    }

    const frozenRequest = preparedRequest[preparedAgentRequest];
    const frozenPlan = preparedRequest[preparedAgentPlan];
    if (!frozenRequest || !frozenPlan) {
      throw new Error('Prepared agent execution state is unavailable.');
    }
    const responsePayload = await agentExecutionService.executeGoal(
      frozenRequest,
      {
        plan: frozenPlan,
        executionPermitsByStepId: issueAgentPlanExecutionPermits(frozenPlan),
      }
    );

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
