import type { NextFunction, Request, Response } from 'express';
import {
  buildUnsafeToProceedPayload,
  hasUnsafeBlockingConditions
} from '@services/safety/runtimeState.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SAFETY_RELEASE_PATH_PATTERN = /^\/status\/safety\/quarantine\/[^/]+\/release$/;
const GPT_PATH_PATTERN = /^\/gpt\/[^/]+$/;

function tryParseBodyRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  return null;
}

function normalizeRequestBody(body: unknown): Record<string, unknown> | null {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const recordBody = body as Record<string, unknown>;
    const entries = Object.entries(recordBody);
    if (entries.length === 1) {
      const [candidateJson, candidateValue] = entries[0];
      if (candidateValue === '' || candidateValue === null) {
        const reparsedBody = tryParseBodyRecord(candidateJson);
        if (reparsedBody) {
          return reparsedBody;
        }
      }
    }
    return recordBody;
  }

  if (typeof body === 'string' && body.trim().length > 0) {
    return tryParseBodyRecord(body);
  }

  return null;
}

function isDiagnosticsActionRequest(req: Request): boolean {
  if (req.method.toUpperCase() !== 'POST' || !GPT_PATH_PATTERN.test(req.path)) {
    return false;
  }

  const normalizedBody = normalizeRequestBody(req.body);
  const action = normalizedBody?.action;
  return typeof action === 'string' && action.trim().toLowerCase() === 'diagnostics';
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

  if (isDiagnosticsActionRequest(req)) {
    req.logger?.info?.('unsafe_execution_gate.bypass', {
      reason: 'gpt_diagnostics',
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
