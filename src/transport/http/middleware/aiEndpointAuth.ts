import { timingSafeEqual } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { getConfig } from '@platform/runtime/unifiedConfig.js';
import { getEnv } from '@platform/runtime/env.js';
import { resolveHeader } from '@transport/http/requestHeaders.js';

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

function hasMatchingToken(presentedToken: string, expectedTokens: string[]): boolean {
  const presented = Buffer.from(presentedToken, 'utf8');
  for (const expectedToken of expectedTokens) {
    const expected = Buffer.from(expectedToken, 'utf8');
    if (presented.length !== expected.length) {
      continue;
    }
    if (timingSafeEqual(presented, expected)) {
      return true;
    }
  }
  return false;
}

/**
 * Purpose: Protect high-cost AI endpoints from unauthenticated quota abuse.
 * Inputs/Outputs: Express middleware; authorizes via Bearer or x-api-key token.
 * Edge cases: In test mode, auth can be bypassed for deterministic local tests.
 */
export function requireAiEndpointAuth(req: Request, res: Response, next: NextFunction): void {
  const config = getConfig();
  const allowTestBypass =
    config.isTest && getEnv('ENABLE_TEST_AUTH_BYPASS', '1') === '1';
  if (allowTestBypass) {
    next();
    return;
  }

  const expectedTokens = [
    getEnv('ARCANOS_API_KEY'),
    config.adminKey,
    config.openaiApiKey
  ]
    .map(value => value?.trim() || '')
    .filter(Boolean);

  //audit Assumption: protected endpoints should fail closed when no auth secret is configured; failure risk: public quota drain; expected invariant: missing auth config blocks expensive routes; handling strategy: return 503 with operator guidance.
  if (expectedTokens.length === 0) {
    res.status(503).json({
      error: 'AI_AUTH_UNAVAILABLE',
      details: ['Configure ARCANOS_API_KEY or ADMIN_KEY to protect AI endpoints']
    });
    return;
  }

  const presentedToken = resolvePresentedToken(req);
  if (!presentedToken) {
    res.status(401).json({
      error: 'UNAUTHORIZED',
      details: ['Authorization Bearer token or x-api-key is required']
    });
    return;
  }

  if (!hasMatchingToken(presentedToken, expectedTokens)) {
    res.status(403).json({
      error: 'FORBIDDEN',
      details: ['Invalid API credentials']
    });
    return;
  }

  next();
}

export default requireAiEndpointAuth;
