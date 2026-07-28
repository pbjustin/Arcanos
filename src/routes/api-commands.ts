import express, { Request, Response } from 'express';
import { confirmGate } from "@transport/http/middleware/confirmGate.js";
import { createValidationMiddleware } from "@platform/runtime/security.js";
import { asyncHandler } from "@shared/http/index.js";
import { buildTimestampedPayload } from "@transport/http/responseHelpers.js";
import {
  executeCommand,
  listAvailableCommands,
  validateCommandForExecution,
} from "@services/commandCenter.js";
import type { CommandName } from "@services/commandCenter.js";
import { issueCefExecutionPermit } from '@services/cef/executionPermit.js';
import { cefHttpBoundary } from '@services/controlPlane/cefHttpBoundary.js';
import { cefBodyParser } from '@services/controlPlane/cefBodyParser.js';
import {
  buildCefConfirmationBinding,
  buildCefDispatchConfirmationState,
} from '@services/controlPlane/cefConfirmation.js';

const router = express.Router();

router.use(cefHttpBoundary);
router.use(cefBodyParser);

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
  createValidationMiddleware(commandExecutionSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const {
      command: requestedCommand,
      payload: requestedPayload,
    } = req.body as {
      command: string;
      payload?: Record<string, unknown>;
    };
    const rerouted = req.dispatchRerouted && req.dispatchDecision === 'reroute';
    const effectiveCommand = rerouted ? 'ai:prompt' : requestedCommand;
    const effectivePayload = rerouted
      ? {
          prompt: resolveReroutePrompt(requestedPayload, req.body),
        }
      : requestedPayload ?? {};
    const validation = validateCommandForExecution(
      effectiveCommand,
      effectivePayload
    );
    const baseExecutionContext = {
      traceId: res.locals.auditTraceId,
      source: '/api/commands/execute',
    } as const;

    // Unsupported commands and schema-invalid payloads retain their deterministic
    // 400 response and never receive a confirmation challenge.
    if (!validation.ok) {
      const rejectedResult = await executeCommand(
        effectiveCommand as CommandName,
        effectivePayload,
        baseExecutionContext
      );
      res
        .status(resolveCommandResponseStatusCode(rejectedResult))
        .json(rejectedResult);
      return;
    }

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

    let confirmationAccepted = false;
    confirmGate(req, res, () => {
      confirmationAccepted = true;
    }, {
      challengeBinding: buildCefConfirmationBinding(req, principalId),
      requestFingerprintBody: {
        protocol: 'cef-command-confirmation-v1',
        requestedCommand,
        command: validation.command,
        payload: validation.payload,
        dispatch: buildCefDispatchConfirmationState(req),
      },
      requireChallengeToken: true,
    });
    if (!confirmationAccepted) {
      return;
    }
    if (req.confirmationContext?.usedChallengeToken !== true) {
      res.status(403).json({
        success: false,
        command: validation.command,
        message: 'Command execution requires a consumed confirmation challenge.',
        output: null,
        error: {
          code: 'CONFIRMATION_REQUIRED',
          message: 'Command execution requires a consumed confirmation challenge.',
          httpStatusCode: 403,
        },
      });
      return;
    }

    const executionPermit = issueCefExecutionPermit(
      validation.command,
      validation.payload,
      baseExecutionContext
    );
    const result = await executeCommand(
      validation.command,
      validation.payload,
      {
        ...baseExecutionContext,
        executionPermit,
      }
    );

    //audit Assumption: typed CEF errors carry the correct HTTP class for deterministic API failures; risk: callers receive a misleading success-like 400 for authorization or internal errors; invariant: route status mirrors `error.httpStatusCode` when present; handling: resolve the response status from the structured command result.
    res.status(resolveCommandResponseStatusCode(result)).json(
      rerouted
        ? {
            ...result,
            metadata: {
              ...result.metadata,
              dispatchRerouted: true,
              dispatchConflictCode: req.dispatchConflictCode,
            },
          }
        : result
    );
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
