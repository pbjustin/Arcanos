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

  res.status(503).json(buildUnsafeToProceedPayload());
}

export default unsafeExecutionGate;
