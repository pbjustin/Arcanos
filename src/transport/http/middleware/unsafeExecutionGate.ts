import type { NextFunction, Request, Response } from 'express';
import {
  buildUnsafeToProceedPayload,
  hasUnsafeBlockingConditions
} from '@services/safety/runtimeState.js';

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

function isPublicGamingRequest(req: Request): boolean {
  return req.method.toUpperCase() === 'POST'
    && (req.path === '/gpt/arcanos-gaming' || req.path === '/gpt/gaming');
}

function resolvePublicGamingMode(body: unknown): 'guide' | 'build' | 'meta' | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }

  const bodyRecord = body as Record<string, unknown>;
  const payload = bodyRecord.payload;
  const modeOwner = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : bodyRecord;
  const mode = typeof modeOwner.mode === 'string' ? modeOwner.mode.trim().toLowerCase() : '';
  return mode === 'guide' || mode === 'build' || mode === 'meta' ? mode : null;
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
  if (isPublicGamingRequest(req)) {
    const gamingRequestId = requestId ?? traceId ?? 'unknown';
    const gamingTraceId = traceId ?? gamingRequestId;
    const gptId = req.path.endsWith('/gaming') ? 'gaming' : 'arcanos-gaming';
    res.status(200).json({
      ok: true,
      requestId: gamingRequestId,
      traceId: gamingTraceId,
      result: {
        ok: false,
        route: 'gaming',
        mode: resolvePublicGamingMode(req.body),
        error: {
          code: 'UNSAFE_TO_PROCEED',
          message: 'ARCANOS Gaming is temporarily unavailable because runtime integrity checks did not pass.'
        }
      },
      _route: {
        requestId: gamingRequestId,
        traceId: gamingTraceId,
        gptId,
        module: 'ARCANOS:GAMING',
        action: 'query',
        route: 'gaming',
        timestamp: new Date().toISOString()
      }
    });
    return;
  }

  res.status(503).json({
    ...buildUnsafeToProceedPayload(),
    ...(requestId ? { requestId } : {}),
    ...(traceId ? { traceId } : {})
  });
}

export default unsafeExecutionGate;
