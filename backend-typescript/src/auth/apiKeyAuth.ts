/**
 * API Key Authentication Module
 * Middleware for API key-based authentication.
 */

import { timingSafeEqual } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { LoggerLike } from '../ipc/ipcRegistry';

export interface ApiKeyAuthConfig {
  apiKey: string;
  headerName: string;
  headerPrefix: string | null;
  userId: string;
}

export interface ApiKeyAuthDependencies {
  getEnvValue: (key: string) => string | undefined;
}

function normalizeHeaderName(rawHeaderName: string | undefined): string {
  //audit assumption: header name optional; risk: empty header; invariant: fallback to Authorization; strategy: trim and default.
  const trimmed = (rawHeaderName || '').trim();
  return trimmed ? trimmed : 'Authorization';
}

function normalizeHeaderPrefix(rawPrefix: string | undefined): string | null {
  if (rawPrefix === undefined) {
    //audit assumption: prefix omitted uses Bearer; risk: mismatched header; invariant: default prefix; strategy: use Bearer.
    return 'Bearer';
  }
  const trimmed = rawPrefix.trim();
  if (!trimmed) {
    //audit assumption: empty prefix disables prefix check; risk: raw token usage; invariant: null prefix; strategy: return null.
    return null;
  }
  return trimmed;
}

function resolveApiKeyUserId(getEnvValue: (key: string) => string | undefined): string {
  const rawUserId = (getEnvValue('AUTH_API_KEY_USER_ID') || '').trim();
  if (rawUserId) {
    //audit assumption: explicit user id should be used; risk: misconfigured user id; invariant: non-empty id; strategy: use trimmed.
    return rawUserId;
  }
  const fallbackUserId = (getEnvValue('AUTH_ANONYMOUS_USER_ID') || '').trim();
  if (fallbackUserId) {
    //audit assumption: fallback user id optional; risk: missing id; invariant: use fallback when set; strategy: use trimmed.
    return fallbackUserId;
  }
  //audit assumption: default anonymous id acceptable; risk: mixed user data; invariant: default id used; strategy: return anonymous.
  return 'anonymous';
}

function extractHeaderValue(req: Request, headerName: string): string | null {
  const headerKey = headerName.toLowerCase();
  const rawValue = req.headers[headerKey];
  if (typeof rawValue === 'string') {
    //audit assumption: header is string; risk: empty value; invariant: return raw; strategy: return string.
    return rawValue;
  }
  if (Array.isArray(rawValue) && rawValue.length > 0) {
    //audit assumption: header array may exist; risk: multiple values; invariant: first value used; strategy: return first.
    return rawValue[0];
  }
  //audit assumption: header missing; risk: unauthorized access; invariant: null returned; strategy: return null.
  return null;
}

function parseApiKeyFromHeader(rawHeader: string | null, config: ApiKeyAuthConfig): string | null {
  if (!rawHeader) {
    //audit assumption: header required; risk: missing credential; invariant: null returned; strategy: return null.
    return null;
  }
  const trimmedHeader = rawHeader.trim();
  if (!config.headerPrefix) {
    //audit assumption: prefix disabled; risk: raw token mismatch; invariant: raw header used; strategy: return trimmed header.
    return trimmedHeader;
  }
  const expectedPrefix = `${config.headerPrefix} `;
  if (!trimmedHeader.startsWith(expectedPrefix)) {
    //audit assumption: prefix mismatch invalid; risk: invalid auth; invariant: null returned; strategy: return null.
    return null;
  }
  return trimmedHeader.slice(expectedPrefix.length).trim();
}

function isApiKeyMatch(candidate: string, expected: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const candidateBuffer = Buffer.from(candidate);
  if (expectedBuffer.length !== candidateBuffer.length) {
    //audit assumption: length mismatch invalid; risk: timing leak; invariant: mismatch returns false; strategy: return false.
    return false;
  }
  //audit assumption: timingSafeEqual reduces timing leaks; risk: side-channel; invariant: compare buffers; strategy: timingSafeEqual.
  return timingSafeEqual(expectedBuffer, candidateBuffer);
}

/**
 * Load API key authentication configuration from environment.
 * Inputs/Outputs: dependency with env getter; returns ApiKeyAuthConfig.
 * Edge cases: missing API key returns empty string for validation by caller.
 */
export function loadApiKeyAuthConfig(deps: ApiKeyAuthDependencies): ApiKeyAuthConfig {
  const apiKey = (deps.getEnvValue('AUTH_API_KEY') || '').trim();
  return {
    apiKey,
    headerName: normalizeHeaderName(deps.getEnvValue('AUTH_API_KEY_HEADER')),
    headerPrefix: normalizeHeaderPrefix(deps.getEnvValue('AUTH_API_KEY_PREFIX')),
    userId: resolveApiKeyUserId(deps.getEnvValue)
  };
}

/**
 * Create API key auth middleware with injected config and logger.
 * Inputs/Outputs: config and logger; returns Express middleware.
 * Edge cases: missing/invalid API key returns 401/403 responses.
 */
export function createApiKeyAuthMiddleware(
  config: ApiKeyAuthConfig,
  logger: LoggerLike
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!config.apiKey) {
      //audit assumption: API key configured at startup; risk: insecure access or false negatives; invariant: key present; strategy: return 500.
      logger.error('API key auth is enabled but AUTH_API_KEY is missing');
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'API key authentication is not configured'
      });
      return;
    }

    const rawHeader = extractHeaderValue(req, config.headerName);
    if (!rawHeader) {
      //audit assumption: header required; risk: unauthorized access; invariant: 401 returned; strategy: reject request.
      res.status(401).json({
        error: 'Unauthorized',
        message: `Missing ${config.headerName} header`
      });
      return;
    }

    const apiKey = parseApiKeyFromHeader(rawHeader, config);
    if (!apiKey) {
      //audit assumption: header format must match prefix; risk: invalid auth; invariant: 401 returned; strategy: reject request.
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid API key header format'
      });
      return;
    }

    if (!isApiKeyMatch(apiKey, config.apiKey)) {
      //audit assumption: API key must match; risk: unauthorized access; invariant: 403 returned; strategy: reject request.
      logger.warn('API key authentication failed');
      res.status(403).json({
        error: 'Forbidden',
        message: 'Invalid API key'
      });
      return;
    }

    req.user = { userId: config.userId };
    logger.info('API key authentication successful', { userId: config.userId });
    next();
  };
}
