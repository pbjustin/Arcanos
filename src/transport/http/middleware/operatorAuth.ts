import type { NextFunction, Request, Response } from 'express';
import { getConfig } from '@platform/runtime/unifiedConfig.js';
import { resolveHeader } from '@transport/http/requestHeaders.js';
import { timingSafeEqual } from 'crypto';

declare module 'express-serve-static-core' {
  interface Request {
    operatorActor?: string;
  }
}

const OPERATOR_DIAGNOSTIC_ENDPOINTS = ['GET /health', 'GET /healthz', 'GET /status/safety', 'GET /status/safety/operator-auth'];

interface OperatorAuthMissingCredentialPayload {
  error: 'UNAUTHORIZED';
  details: string[];
  remediation: string[];
  diagnosticEndpoints: string[];
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
 * Purpose: Build a structured response payload for missing operator credentials.
 * Inputs/Outputs: Express request context; returns remediation + non-auth diagnostic endpoints.
 * Edge cases: Returns static guidance when request metadata is unavailable.
 */
function buildMissingCredentialPayload(_req: Request): OperatorAuthMissingCredentialPayload {
  return {
    error: 'UNAUTHORIZED',
    details: ['Authorization Bearer token or x-api-key is required'],
    remediation: [
      'Provide the ADMIN_KEY value in the Authorization Bearer header.',
      'Or provide the ADMIN_KEY value in the x-api-key header.',
      'Use GET /status/safety/operator-auth to verify operator-auth wiring without credentials.'
    ],
    diagnosticEndpoints: OPERATOR_DIAGNOSTIC_ENDPOINTS
  };
}

/**
 * Purpose: Enforce operator authentication using ADMIN_KEY for safety controls.
 * Inputs/Outputs: Express middleware; sets req.operatorActor on success.
 * Edge cases: Returns 503 when ADMIN_KEY is not configured.
 */
export function operatorAuth(req: Request, res: Response, next: NextFunction): void {
  const adminKey = getConfig().adminKey?.trim();
  //audit Assumption: single-operator deployments may intentionally omit ADMIN_KEY; failure risk: public unauthenticated operator actions if endpoint is internet-exposed; expected invariant: explicit ADMIN_KEY still enforces auth, missing ADMIN_KEY enters local-trust mode; handling strategy: fail-open and annotate actor for auditability.
  if (!adminKey) {
    req.operatorActor = 'operator:admin-key-disabled';
    res.setHeader('x-operator-auth-mode', 'disabled');
    next();
    return;
  }

  const presentedToken = resolvePresentedToken(req);
  //audit Assumption: missing auth token must block operator actions; failure risk: anonymous release attempts; expected invariant: token required; handling strategy: 401 challenge.
  if (!presentedToken) {
    //audit Assumption: failed auth should include explicit remediation hints; failure risk: repeated probe failures with no guidance; expected invariant: response documents accepted credentials and safe diagnostics; handling strategy: return structured 401 payload.
    res.status(401).json(buildMissingCredentialPayload(req));
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
