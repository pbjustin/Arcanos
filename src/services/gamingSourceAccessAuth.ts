import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { buildAuthenticatedCredentialActorKey } from '@platform/runtime/security.js';
import { timingSafeEqualOpaqueSecret } from '@shared/security/opaqueSecret.js';
import {
  MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH,
  resolveConfiguredPurposeBoundCredential,
} from '@shared/security/purposeBoundCredential.js';

export const GAMING_SOURCE_ACCESS_TOKEN_ENV_NAME =
  'ARCANOS_GAMING_SOURCE_ACCESS_TOKEN';

const GAMING_SOURCE_ACCESS_BEARER_PATTERN = /^[\x21-\x7E]+$/u;
const gamingSourceAccessAuthenticated = Symbol('gamingSourceAccessAuthenticated');

type GamingSourceAccessRequest = Request & {
  [gamingSourceAccessAuthenticated]?: true;
};

export type GamingSourceAccessAuthenticationResult =
  | {
      ok: true;
      credential: string;
    }
  | {
      ok: false;
      reason: 'configuration_unavailable' | 'missing_auth' | 'invalid_auth';
    };

function countRawAuthorizationHeaders(req: Request): number {
  const rawHeaders = Array.isArray(req.rawHeaders) ? req.rawHeaders : [];
  let count = 0;

  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (
      typeof rawHeaders[index] === 'string'
      && rawHeaders[index].toLowerCase() === 'authorization'
    ) {
      count += 1;
    }
  }

  return count;
}

/** Parse exactly one dedicated source-lifecycle opaque bearer credential. */
export function extractGamingSourceAccessBearerToken(req: Request): string | null {
  if (countRawAuthorizationHeaders(req) > 1) {
    return null;
  }

  const authorization = req.header('authorization');
  if (
    typeof authorization !== 'string'
    || authorization.length > MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH + 7
  ) {
    return null;
  }

  const match = /^Bearer ([\x21-\x7E]+)$/u.exec(authorization);
  if (!match || match[1].length === 0 || match[1].length > MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH) {
    return null;
  }

  return match[1];
}

function readConfiguredGamingSourceAccessToken(
  env: NodeJS.ProcessEnv
): string | null {
  const credential = resolveConfiguredPurposeBoundCredential({
    ownEnvironmentName: GAMING_SOURCE_ACCESS_TOKEN_ENV_NAME,
    readEnvironmentValue: environmentName => env[environmentName],
  });

  return credential && GAMING_SOURCE_ACCESS_BEARER_PATTERN.test(credential)
    ? credential
    : null;
}

export function isGamingSourceAccessAuthenticationConfigured(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return readConfiguredGamingSourceAccessToken(env) !== null;
}

export function authenticateGamingSourceAccessRequest(
  req: Request,
  env: NodeJS.ProcessEnv = process.env
): GamingSourceAccessAuthenticationResult {
  const expectedToken = readConfiguredGamingSourceAccessToken(env);
  if (!expectedToken) {
    return {
      ok: false,
      reason: 'configuration_unavailable',
    };
  }

  const bearerToken = extractGamingSourceAccessBearerToken(req);
  if (!bearerToken) {
    return {
      ok: false,
      reason: req.header('authorization') ? 'invalid_auth' : 'missing_auth',
    };
  }

  if (!timingSafeEqualOpaqueSecret(bearerToken, expectedToken)) {
    return {
      ok: false,
      reason: 'invalid_auth',
    };
  }

  return {
    ok: true,
    credential: bearerToken,
  };
}

function sendGamingSourceAccessError(
  req: Request,
  res: Response,
  statusCode: 401 | 503,
  code: 'GAMING_SOURCE_AUTH_UNAVAILABLE' | 'UNAUTHORIZED_GPT_ACCESS',
  message: string
): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.status(statusCode).json({
    ok: false,
    error: {
      code,
      message,
    },
    ...(req.requestId ? { requestId: req.requestId } : {}),
    ...(req.traceId ? { traceId: req.traceId } : {}),
  });
}

/**
 * Authenticate the dedicated Gaming source credential before the broad parser
 * or generic GPT Access gateway can inspect this narrow lifecycle namespace.
 */
export const gamingSourceAccessAuthMiddleware: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const result = authenticateGamingSourceAccessRequest(req);
  if (!result.ok) {
    const configurationUnavailable = result.reason === 'configuration_unavailable';
    const statusCode = configurationUnavailable ? 503 : 401;
    try {
      req.logger?.[configurationUnavailable ? 'error' : 'warn']?.(
        'gaming_source_access.auth.denied',
        {
          reason: result.reason,
          statusCode,
          method: req.method,
        }
      );
    } catch {
      // Authentication diagnostics must not alter the fixed public response.
    }
    sendGamingSourceAccessError(
      req,
      res,
      statusCode,
      configurationUnavailable
        ? 'GAMING_SOURCE_AUTH_UNAVAILABLE'
        : 'UNAUTHORIZED_GPT_ACCESS',
      configurationUnavailable
        ? 'Gaming source authentication is unavailable.'
        : 'Gaming source bearer authentication is required.'
    );
    return;
  }

  const boundaryRequest = req as GamingSourceAccessRequest;
  boundaryRequest[gamingSourceAccessAuthenticated] = true;
  req.authenticatedActorKey = buildAuthenticatedCredentialActorKey(
    'gaming-source-access',
    result.credential
  );
  next();
};

/** Defense in depth for the leaf routes if their boundary mount changes. */
export const requireGamingSourceAccessAuthentication: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if ((req as GamingSourceAccessRequest)[gamingSourceAccessAuthenticated]) {
    next();
    return;
  }

  sendGamingSourceAccessError(
    req,
    res,
    401,
    'UNAUTHORIZED_GPT_ACCESS',
    'Gaming source bearer authentication is required.'
  );
};
