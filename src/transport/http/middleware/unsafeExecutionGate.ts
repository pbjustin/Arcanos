import type { NextFunction, Request, Response } from 'express';
import {
  buildUnsafeToProceedPayload,
  hasUnsafeBlockingConditions
} from '@services/safety/runtimeState.js';
import { validateGamingEvidenceRetryRequest } from '@services/gamingModes.js';
import { dispatchPublicGamingRequest } from '@services/gamingPublicDispatcher.js';
import {
  buildPublicGamingCanaryFailure,
  prepareGuardedPublicGamingCanaryResponse,
  PUBLIC_GAMING_CANARY_MAX_RESPONSE_BYTES
} from '@services/publicGamingCanary.js';
import { resolvePublicGamingPath } from '@shared/http/publicGamingPath.js';
import { sendBoundedJsonResponse } from '@shared/http/sendBoundedJsonResponse.js';
import { isGptDagAction } from '@shared/gpt/gptDagBridgeActions.js';
import { GPT_QUERY_AND_WAIT_ACTION } from '@shared/gpt/gptJobResult.js';
import { resolveRequestedGptActionFromRequest } from '@shared/gpt/gptRequestAction.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SAFETY_RELEASE_PATH_PATTERN = /^\/status\/safety\/quarantine\/[^/]+\/release$/;
const GPT_ACCESS_READONLY_POST_PATHS = new Set([
  '/gpt-access/jobs/result',
  '/gpt-access/diagnostics/deep',
  '/gpt-access/db/explain',
  '/gpt-access/logs/query',
  '/gpt-access/mcp'
]);
const LOCAL_AGENT_LIFECYCLE_PATH_PATTERN =
  /^\/gpt-access\/local-agent\/(?:heartbeat|jobs\/[0-9a-f-]{36}\/(?:heartbeat|result))$/iu;

function isGptAccessSafetyExemptRequest(req: Request): boolean {
  return req.method.toUpperCase() === 'POST'
    && (
      GPT_ACCESS_READONLY_POST_PATHS.has(req.path)
      || LOCAL_AGENT_LIFECYCLE_PATH_PATTERN.test(req.path)
    );
}

/**
 * Purpose: Block mutating requests when unsafe safety conditions are active.
 * Inputs/Outputs: Express middleware; returns 503 unsafe contract on block.
 * Edge cases: Allows operator quarantine release endpoint for recovery workflows.
 */
export function unsafeExecutionGate(req: Request, res: Response, next: NextFunction): void {
  const method = req.method.toUpperCase();
  //audit Assumption: non-mutating methods should remain available in degraded mode; failure risk: blocking observability endpoints; expected invariant: GET/HEAD/OPTIONS pass through; handling strategy: early return for non-mutating methods.
  if (!MUTATING_METHODS.has(method)) {
    next();
    return;
  }

  //audit Assumption: operator release endpoint must remain reachable during unsafe state; failure risk: deadlocked recovery; expected invariant: release path bypasses global mutating block; handling strategy: regex-based allowlist.
  if (SAFETY_RELEASE_PATH_PATTERN.test(req.path)) {
    next();
    return;
  }

  if (isGptAccessSafetyExemptRequest(req)) {
    req.logger?.info?.('unsafe_execution_gate.bypass', {
      reason: 'gpt_access_read_or_reconciliation',
      path: req.path
    });
    next();
    return;
  }

  const publicGamingPath = method === 'POST'
    ? resolvePublicGamingPath(req.path)
    : null;

  if (!hasUnsafeBlockingConditions()) {
    next();
    return;
  }

  const requestId = typeof req.requestId === 'string' && req.requestId.trim().length > 0
    ? req.requestId.trim()
    : undefined;
  const traceId = typeof req.traceId === 'string' && req.traceId.trim().length > 0
    ? req.traceId.trim()
    : requestId;
  if (publicGamingPath) {
    const gamingRequestId = requestId ?? traceId ?? 'unknown';
    const gamingTraceId = traceId ?? gamingRequestId;
    if (publicGamingPath.operation === 'canary') {
      const decision = dispatchPublicGamingRequest(req.body, 'canary');
      const response = buildPublicGamingCanaryFailure({
        code: decision.ok ? 'PUBLIC_CANARY_UNAVAILABLE' : 'BAD_REQUEST',
        requestId: gamingRequestId,
        traceId: gamingTraceId
      });
      const guarded = prepareGuardedPublicGamingCanaryResponse({
        response,
        statusCode: decision.ok ? 503 : 400,
        requestId: gamingRequestId,
        traceId: gamingTraceId
      });
      sendBoundedJsonResponse(req, res, guarded.response, {
        logEvent: 'gpt.response.public_canary_unsafe',
        statusCode: guarded.statusCode,
        maxBytes: PUBLIC_GAMING_CANARY_MAX_RESPONSE_BYTES
      });
      return;
    }

    const evidenceRetry = publicGamingPath.operation === 'evidence_retry';
    const requestedAction = evidenceRetry ? null : resolveRequestedGptActionFromRequest(req);
    const genericGatewayAction = requestedAction === GPT_QUERY_AND_WAIT_ACTION
      || isGptDagAction(requestedAction);
    const retryValidation = evidenceRetry ? validateGamingEvidenceRetryRequest(req.body) : null;
    const queryDecision = evidenceRetry || genericGatewayAction
      ? null
      : dispatchPublicGamingRequest(req.body, 'query');
    const validationError = retryValidation && !retryValidation.ok
      ? { code: retryValidation.code, message: retryValidation.message }
      : queryDecision && !queryDecision.ok
        ? queryDecision.error
        : null;
    if (validationError) {
      const action = queryDecision?.action ?? 'query';
      res.status(400).json({
        ok: false,
        requestId: gamingRequestId,
        traceId: gamingTraceId,
        gptId: publicGamingPath.gptId,
        action,
        route: '/gpt/:gptId',
        error: validationError,
        _route: {
          requestId: gamingRequestId,
          traceId: gamingTraceId,
          gptId: publicGamingPath.gptId,
          action,
          route: 'gaming_validation',
          timestamp: new Date().toISOString()
        }
      });
      return;
    }
    if (retryValidation?.ok || queryDecision?.ok) {
      const mode = retryValidation?.ok ? retryValidation.value.mode : queryDecision!.mode;
      res.status(200).json({
        ok: true,
        requestId: gamingRequestId,
        traceId: gamingTraceId,
        result: {
          ok: false,
          route: 'gaming',
          mode,
          error: {
            code: 'UNSAFE_TO_PROCEED',
            message: 'ARCANOS Gaming is temporarily unavailable because runtime integrity checks did not pass.'
          }
        },
        _route: {
          requestId: gamingRequestId,
          traceId: gamingTraceId,
          gptId: publicGamingPath.gptId,
          module: 'ARCANOS:GAMING',
          action: 'query',
          route: 'gaming',
          timestamp: new Date().toISOString()
        }
      });
      return;
    }
  }

  res.status(503).json({
    ...buildUnsafeToProceedPayload(),
    ...(requestId ? { requestId } : {}),
    ...(traceId ? { traceId } : {})
  });
}

export default unsafeExecutionGate;
