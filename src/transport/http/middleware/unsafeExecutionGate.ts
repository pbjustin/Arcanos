import type { NextFunction, Request, Response } from 'express';
import {
  buildUnsafeToProceedPayload,
  hasUnsafeBlockingConditions
} from '@services/safety/runtimeState.js';
import {
  resolveGamingMode,
  validateGamingEvidenceRetryRequest,
  validatePublicGamingQueryRequest
} from '@services/gamingModes.js';
import { resolveRequestedGptActionFromRequest } from '@shared/gpt/gptRequestAction.js';
import { resolvePublicGamingGptIdFromPath } from '@shared/http/publicGamingPath.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SAFETY_RELEASE_PATH_PATTERN = /^\/status\/safety\/quarantine\/[^/]+\/release$/;
const GPT_ACCESS_READONLY_POST_PATHS = new Set([
  '/gpt-access/jobs/result',
  '/gpt-access/diagnostics/deep',
  '/gpt-access/db/explain',
  '/gpt-access/logs/query',
  '/gpt-access/mcp'
]);

function isGptAccessReadOnlyRequest(req: Request): boolean {
  return req.method.toUpperCase() === 'POST' && GPT_ACCESS_READONLY_POST_PATHS.has(req.path);
}

function resolvePublicGamingMode(body: unknown) {
  const bodyRecord = body as Record<string, unknown>;
  const payload = bodyRecord.payload as Record<string, unknown>;
  return resolveGamingMode(payload) ?? resolveGamingMode(bodyRecord);
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

  if (isGptAccessReadOnlyRequest(req)) {
    req.logger?.info?.('unsafe_execution_gate.bypass', {
      reason: 'gpt_access_readonly',
      path: req.path
    });
    next();
    return;
  }

  const publicGamingGptId = method === 'POST'
    ? resolvePublicGamingGptIdFromPath(req.path)
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
  if (publicGamingGptId) {
    const gamingRequestId = requestId ?? traceId ?? 'unknown';
    const gamingTraceId = traceId ?? gamingRequestId;
    const normalizedPath = req.path.toLowerCase().replace(/\/$/, '');
    const evidenceRetry = normalizedPath === '/gpt/arcanos-gaming/evidence-retry';
    const retryValidation = evidenceRetry ? validateGamingEvidenceRetryRequest(req.body) : null;
    const requestedAction = evidenceRetry ? 'query' : resolveRequestedGptActionFromRequest(req);
    const validationError = retryValidation && !retryValidation.ok
      ? { code: retryValidation.code, message: retryValidation.message }
      : evidenceRetry
        ? null
        : validatePublicGamingQueryRequest(req.body, requestedAction);
    if (validationError) {
      const action = requestedAction ?? 'query';
      res.status(400).json({
        ok: false,
        requestId: gamingRequestId,
        traceId: gamingTraceId,
        gptId: publicGamingGptId,
        action,
        route: '/gpt/:gptId',
        error: validationError,
        _route: {
          requestId: gamingRequestId,
          traceId: gamingTraceId,
          gptId: publicGamingGptId,
          action,
          route: 'gaming_validation',
          timestamp: new Date().toISOString()
        }
      });
      return;
    }
    if (requestedAction === 'query') {
      const mode = retryValidation?.ok ? retryValidation.value.mode : resolvePublicGamingMode(req.body);
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
          gptId: publicGamingGptId,
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
