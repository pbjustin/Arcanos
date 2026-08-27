import type { NextFunction, Request, RequestHandler, Response } from 'express';

import {
  authenticateBackstageBookerAccessCore,
  buildBackstageBookerAccessActorIdentity,
  extractBackstageBookerAccessBearerTokenCore,
  isBackstageBookerAccessAuthenticationConfiguredCore,
  BACKSTAGE_BOOKER_ACCESS_PRINCIPAL_ACTOR_KEY,
  BACKSTAGE_BOOKER_ACCESS_TOKEN_ENV_NAME,
  type BackstageBookerAccessAuthenticationResult,
} from '@shared/backstage/backstageBookerAccessAuthCore.js';
import {
  buildGptClientIdentityTelemetry,
  gptClientRegistry,
  type AuthenticatedGptClientIdentity,
} from '@shared/gpt/gptClientRegistry.js';

export {
  BACKSTAGE_BOOKER_ACCESS_PRINCIPAL_ACTOR_KEY,
  BACKSTAGE_BOOKER_ACCESS_TOKEN_ENV_NAME,
  type BackstageBookerAccessAuthenticationResult,
};
const backstageBookerAccessAuthenticated = Symbol(
  'backstageBookerAccessAuthenticated'
);
const backstageBookerAccessLegacyActorKey = Symbol(
  'backstageBookerAccessLegacyActorKey'
);
const authenticatedGptClientIdentity = Symbol(
  'authenticatedGptClientIdentity'
);

function resolveBackstageBookerManagedGptClientIdentity(
): AuthenticatedGptClientIdentity {
  const identity = gptClientRegistry.resolveAuthenticatedClient({
    clientId: 'backstage-booker',
    authentication: { authenticationType: 'managed-api-key' },
  });
  if (!identity) {
    throw new Error('Backstage Booker GPT client registration is unavailable.');
  }
  return identity;
}

const backstageBookerManagedGptClientIdentity =
  resolveBackstageBookerManagedGptClientIdentity();

type BackstageBookerAccessRequest = Request & {
  [backstageBookerAccessAuthenticated]?: true;
  [backstageBookerAccessLegacyActorKey]?: string;
  [authenticatedGptClientIdentity]?: AuthenticatedGptClientIdentity;
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

/** Distinguish a truly absent credential from any presented header shape. */
export function hasPresentedAuthorizationHeader(req: Request): boolean {
  return countRawAuthorizationHeaders(req) > 0
    || req.headers?.authorization !== undefined;
}

/** Parse exactly one dedicated Backstage Booker opaque bearer credential. */
export function extractBackstageBookerAccessBearerToken(
  req: Request
): string | null {
  return extractBackstageBookerAccessBearerTokenCore({
    authorizationHeader: req.header('authorization'),
    authorizationHeaderCount: countRawAuthorizationHeaders(req),
  });
}

export function isBackstageBookerAccessAuthenticationConfigured(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return isBackstageBookerAccessAuthenticationConfiguredCore(
    environmentName => env[environmentName]
  );
}

export function authenticateBackstageBookerAccessRequest(
  req: Request,
  env: NodeJS.ProcessEnv = process.env
): BackstageBookerAccessAuthenticationResult {
  return authenticateBackstageBookerAccessCore({
    authorizationHeader: req.header('authorization'),
    authorizationHeaderCount: countRawAuthorizationHeaders(req),
    authorizationHeaderPresented: hasPresentedAuthorizationHeader(req),
    readEnvironmentValue: environmentName => env[environmentName],
  });
}

/**
 * Mark a request only after the exact dedicated credential has authenticated.
 * The private symbol cannot be supplied through HTTP input.
 */
export function establishBackstageBookerAccessAuthentication(
  req: Request,
  credential: string
): void {
  const authenticatedRequest = req as BackstageBookerAccessRequest;
  const actorIdentity = buildBackstageBookerAccessActorIdentity(credential);
  authenticatedRequest[
    backstageBookerAccessAuthenticated
  ] = true;
  authenticatedRequest[backstageBookerAccessLegacyActorKey] =
    actorIdentity.legacyActorKey;
  authenticatedRequest[authenticatedGptClientIdentity] =
    backstageBookerManagedGptClientIdentity;
  req.authenticatedActorKey = actorIdentity.principalActorKey;
}

/** Read only identity established from the server-owned registry after auth. */
export function getAuthenticatedGptClientIdentity(
  req: Request
): AuthenticatedGptClientIdentity | null {
  if (!isBackstageBookerAccessAuthenticated(req)) {
    return null;
  }
  return (req as BackstageBookerAccessRequest)[
    authenticatedGptClientIdentity
  ] ?? null;
}

/** Emit one bounded allowlisted success event without credential material. */
export function logBackstageBookerAccessAuthenticationSuccess(
  req: Request
): void {
  const identity = getAuthenticatedGptClientIdentity(req);
  if (!identity) {
    return;
  }

  try {
    req.logger?.info('backstage_booker_access.authenticated', {
      authMode: 'dedicated',
      capabilityId: 'BACKSTAGE:BOOKER',
      method: req.method,
      ...buildGptClientIdentityTelemetry(identity),
    });
  } catch {
    // Authentication diagnostics must not alter request handling.
  }
}

/**
 * Return only the pre-principal credential actor after exact authentication.
 * This compatibility alias contains no bearer material and must not authorize
 * a request independently of the private authenticated marker.
 */
export function getBackstageBookerAccessLegacyActorKey(
  req: Request
): string | null {
  const authenticatedRequest = req as BackstageBookerAccessRequest;
  if (!isBackstageBookerAccessAuthenticated(req)) {
    return null;
  }
  return authenticatedRequest[backstageBookerAccessLegacyActorKey] ?? null;
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
  logBackstageBookerAccessAuthenticationSuccess(req);
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
