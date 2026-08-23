import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { buildAuthenticatedCredentialActorKey } from '@platform/runtime/security.js';
import { timingSafeEqualOpaqueSecret } from '@shared/security/opaqueSecret.js';
import {
  MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH,
  resolveConfiguredPurposeBoundCredential,
} from '@shared/security/purposeBoundCredential.js';

export const BACKSTAGE_BOOKER_ACCESS_TOKEN_ENV_NAME =
  'ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN';

const BACKSTAGE_BOOKER_ACCESS_BEARER_PATTERN = /^[\x21-\x7E]+$/u;
const backstageBookerAccessAuthenticated = Symbol(
  'backstageBookerAccessAuthenticated'
);

type BackstageBookerAccessRequest = Request & {
  [backstageBookerAccessAuthenticated]?: true;
};

export type BackstageBookerAccessAuthenticationResult =
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

/** Parse exactly one dedicated Backstage Booker opaque bearer credential. */
export function extractBackstageBookerAccessBearerToken(
  req: Request
): string | null {
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
  if (
    !match
    || match[1].length === 0
    || match[1].length > MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH
  ) {
    return null;
  }

  return match[1];
}

function readConfiguredBackstageBookerAccessToken(
  env: NodeJS.ProcessEnv
): string | null {
  const credential = resolveConfiguredPurposeBoundCredential({
    ownEnvironmentName: BACKSTAGE_BOOKER_ACCESS_TOKEN_ENV_NAME,
    readEnvironmentValue: environmentName => env[environmentName],
  });

  return credential
    && BACKSTAGE_BOOKER_ACCESS_BEARER_PATTERN.test(credential)
    ? credential
    : null;
}

export function isBackstageBookerAccessAuthenticationConfigured(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return readConfiguredBackstageBookerAccessToken(env) !== null;
}

export function authenticateBackstageBookerAccessRequest(
  req: Request,
  env: NodeJS.ProcessEnv = process.env
): BackstageBookerAccessAuthenticationResult {
  const expectedToken = readConfiguredBackstageBookerAccessToken(env);
  if (!expectedToken) {
    return {
      ok: false,
      reason: 'configuration_unavailable',
    };
  }

  const bearerToken = extractBackstageBookerAccessBearerToken(req);
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

/**
 * Mark a request only after the exact dedicated credential has authenticated.
 * The private symbol cannot be supplied through HTTP input.
 */
export function establishBackstageBookerAccessAuthentication(
  req: Request,
  credential: string
): void {
  (req as BackstageBookerAccessRequest)[
    backstageBookerAccessAuthenticated
  ] = true;
  req.authenticatedActorKey = buildAuthenticatedCredentialActorKey(
    'backstage-booker-access',
    credential
  );
}

export function isBackstageBookerAccessAuthenticated(req: Request): boolean {
  return (req as BackstageBookerAccessRequest)[
    backstageBookerAccessAuthenticated
  ] === true;
}

function sendBackstageBookerAccessError(
  req: Request,
  res: Response,
  statusCode: 401 | 503,
  code: 'BACKSTAGE_BOOKER_AUTH_UNAVAILABLE' | 'UNAUTHORIZED_GPT_ACCESS',
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

/** Authenticate the dedicated bearer without granting generic GPT Access. */
export const backstageBookerAccessAuthMiddleware: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const result = authenticateBackstageBookerAccessRequest(req);
  if (!result.ok) {
    const configurationUnavailable = result.reason === 'configuration_unavailable';
    const statusCode = configurationUnavailable ? 503 : 401;
    try {
      req.logger?.[configurationUnavailable ? 'error' : 'warn']?.(
        'backstage_booker_access.auth.denied',
        {
          reason: result.reason,
          statusCode,
          method: req.method,
        }
      );
    } catch {
      // Authentication diagnostics must not alter the fixed public response.
    }
    sendBackstageBookerAccessError(
      req,
      res,
      statusCode,
      configurationUnavailable
        ? 'BACKSTAGE_BOOKER_AUTH_UNAVAILABLE'
        : 'UNAUTHORIZED_GPT_ACCESS',
      configurationUnavailable
        ? 'Backstage Booker authentication is unavailable.'
        : 'Backstage Booker bearer authentication is required.'
    );
    return;
  }

  establishBackstageBookerAccessAuthentication(req, result.credential);
  try {
    req.logger?.info('backstage_booker_access.authenticated', {
      authMode: 'dedicated',
      capabilityId: 'BACKSTAGE:BOOKER',
      method: req.method,
    });
  } catch {
    // Authentication diagnostics must not alter request handling.
  }
  next();
};

/**
 * Establish the dedicated Backstage actor when the exact configured bearer is
 * present, without authorizing the surrounding route by itself. Callers must
 * retain their own capability, confirmation, and ownership gates.
 */
export const optionalBackstageBookerAccessActorMiddleware: RequestHandler = (
  req: Request,
  _res: Response,
  next: NextFunction
): void => {
  const result = authenticateBackstageBookerAccessRequest(req);
  if (result.ok) {
    establishBackstageBookerAccessAuthentication(req, result.credential);
  }
  next();
};

/** Defense in depth for protected Backstage leaf routes. */
export const requireBackstageBookerAccessAuthentication: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (isBackstageBookerAccessAuthenticated(req)) {
    next();
    return;
  }

  sendBackstageBookerAccessError(
    req,
    res,
    401,
    'UNAUTHORIZED_GPT_ACCESS',
    'Backstage Booker bearer authentication is required.'
  );
};
