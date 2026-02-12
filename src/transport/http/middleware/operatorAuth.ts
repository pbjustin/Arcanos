import type { NextFunction, Request, Response } from 'express';
import { getConfig } from '../config/unifiedConfig.js';
import { resolveHeader } from '../utils/requestHeaders.js';
import { timingSafeEqual } from 'crypto';

declare module 'express-serve-static-core' {
  interface Request {
    operatorActor?: string;
  }
}

function resolvePresentedToken(req: Request): string | null {
  const authHeaderValue = resolveHeader(req.headers, 'authorization');
  if (authHeaderValue) {
    const match = authHeaderValue.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) {
      return match[1].trim();
    }
    return authHeaderValue.trim();
  }

  const apiKeyHeaderValue = resolveHeader(req.headers, 'x-api-key');
  if (apiKeyHeaderValue) {
    return apiKeyHeaderValue.trim();
  }

  return null;
}

/**
 * Purpose: Enforce operator authentication using ADMIN_KEY for safety controls.
 * Inputs/Outputs: Express middleware; sets req.operatorActor on success.
 * Edge cases: Returns 503 when ADMIN_KEY is not configured.
 */
export function operatorAuth(req: Request, res: Response, next: NextFunction): void {
  const adminKey = getConfig().adminKey?.trim();
  //audit Assumption: recovery controls require explicit operator secret; failure risk: unauthenticated quarantine release; expected invariant: ADMIN_KEY must be configured; handling strategy: fail closed with 503.
  if (!adminKey) {
    res.status(503).json({
      error: 'OPERATOR_AUTH_UNAVAILABLE',
      details: ['ADMIN_KEY is not configured for operator safety controls']
    });
    return;
  }

  const presentedToken = resolvePresentedToken(req);
  //audit Assumption: missing auth token must block operator actions; failure risk: anonymous release attempts; expected invariant: token required; handling strategy: 401 challenge.
  if (!presentedToken) {
    res.status(401).json({
      error: 'UNAUTHORIZED',
      details: ['Authorization Bearer token or x-api-key is required']
    });
    return;
  }

  //audit Assumption: operator token must match ADMIN_KEY exactly; failure risk: privilege escalation; expected invariant: strict equality check; handling strategy: reject with 403.
  try {
    const presented = Buffer.from(presentedToken, 'utf8');
    const expected = Buffer.from(adminKey, 'utf8');
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      res.status(403).json({
        error: 'FORBIDDEN',
        details: ['Operator credentials are invalid']
      });
      return;
    }
  } catch {
    res.status(403).json({
      error: 'FORBIDDEN',
      details: ['Operator credentials are invalid']
    });
    return;
  }

  const actorHeader = resolveHeader(req.headers, 'x-operator-id');
  req.operatorActor = actorHeader?.trim() || 'operator:admin-key';
  next();
}

export default operatorAuth;
