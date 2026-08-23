import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { timingSafeEqualOpaqueSecret } from '@shared/security/opaqueSecret.js';
import {
  MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH,
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
  resolveConfiguredPurposeBoundCredential,
} from '@shared/security/purposeBoundCredential.js';

import type { ControlPlaneHttpPrincipal } from './types.js';

const MAX_BEARER_TOKEN_LENGTH = MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH;
const MAX_CONFIGURED_SCOPES_LENGTH = 4_096;
const MAX_CONFIGURED_SCOPES = 64;
const PRINCIPAL_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const SCOPE_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,119})$/u;
const CONTROL_PLANE_BEARER_CREDENTIAL_PATTERN = /^[\x21-\x7E]+$/;

const CONTROL_PLANE_TOKEN_ENV_NAME = 'ARCANOS_CONTROL_PLANE_ACCESS_TOKEN';
const CONTROL_PLANE_PRINCIPAL_ENV_NAME = 'ARCANOS_CONTROL_PLANE_PRINCIPAL_ID';
const CONTROL_PLANE_SCOPES_ENV_NAME = 'ARCANOS_CONTROL_PLANE_SCOPES';

export const CONTROL_PLANE_PURPOSE_BOUND_CREDENTIAL_ENV_NAMES = Object.freeze(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.filter(
    (environmentName) => environmentName !== CONTROL_PLANE_TOKEN_ENV_NAME
  )
);

interface ConfiguredControlPlanePrincipal extends ControlPlaneHttpPrincipal {
  credential: string;
}

export type ControlPlaneHttpAuthenticationResult =
  | {
      ok: true;
      principal: ControlPlaneHttpPrincipal;
    }
  | {
      ok: false;
      reason: 'configuration_unavailable' | 'missing_auth' | 'invalid_auth';
    };

function readExactBoundedValue(value: string | undefined, maxLength: number): string | null {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || value !== value.trim()
  ) {
    return null;
  }

  return value;
}

function readConfiguredPrincipalId(value: string | undefined): string | null {
  const principalId = readExactBoundedValue(value, 128);
  return principalId && PRINCIPAL_ID_PATTERN.test(principalId) ? principalId : null;
}

function readConfiguredScopes(value: string | undefined): string[] | null {
  if (value === undefined || value.length === 0) {
    return [];
  }

  if (value.length > MAX_CONFIGURED_SCOPES_LENGTH) {
    return null;
  }

  const rawScopes = value.split(',');
  if (rawScopes.length > MAX_CONFIGURED_SCOPES) {
    return null;
  }

  const scopes: string[] = [];
  for (const rawScope of rawScopes) {
    const scope = rawScope.trim();
    if (!SCOPE_PATTERN.test(scope)) {
      return null;
    }
    scopes.push(scope);
  }

  return [...new Set(scopes)];
}

function resolveConfiguredControlPlanePrincipal(
  env: NodeJS.ProcessEnv
): ConfiguredControlPlanePrincipal | null {
  const credential = resolveConfiguredPurposeBoundCredential({
    ownEnvironmentName: CONTROL_PLANE_TOKEN_ENV_NAME,
    readEnvironmentValue: (environmentName) => env[environmentName],
  });
  const principalId = readConfiguredPrincipalId(env[CONTROL_PLANE_PRINCIPAL_ENV_NAME]);
  const scopes = readConfiguredScopes(env[CONTROL_PLANE_SCOPES_ENV_NAME]);

  if (
    !credential
    || !CONTROL_PLANE_BEARER_CREDENTIAL_PATTERN.test(credential)
    || !principalId
    || scopes === null
  ) {
    return null;
  }

  return {
    audience: 'control-plane-http',
    role: 'operator',
    principalId,
    scopes,
    credential,
  };
}

export function isControlPlaneHttpAuthenticationConfigured(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return resolveConfiguredControlPlanePrincipal(env) !== null;
}

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

/** Parse exactly one purpose-bound `Bearer <opaque-value>` credential. */
export function extractControlPlaneBearerToken(req: Request): string | null {
  if (countRawAuthorizationHeaders(req) > 1) {
    return null;
  }

  const authorization = req.header('authorization');
  if (
    typeof authorization !== 'string'
    || authorization.length > MAX_BEARER_TOKEN_LENGTH + 7
  ) {
    return null;
  }

  const match = /^Bearer ([\x21-\x7E]+)$/.exec(authorization);
  if (!match || match[1].length === 0 || match[1].length > MAX_BEARER_TOKEN_LENGTH) {
    return null;
  }

  return match[1];
}

export function authenticateControlPlaneHttpRequest(
  req: Request,
  env: NodeJS.ProcessEnv = process.env
): ControlPlaneHttpAuthenticationResult {
  const configuredPrincipal = resolveConfiguredControlPlanePrincipal(env);
  if (!configuredPrincipal) {
    return {
      ok: false,
      reason: 'configuration_unavailable',
    };
  }

  const credential = extractControlPlaneBearerToken(req);
  if (!credential) {
    return {
      ok: false,
      reason: req.header('authorization') ? 'invalid_auth' : 'missing_auth',
    };
  }

  if (!timingSafeEqualOpaqueSecret(credential, configuredPrincipal.credential)) {
    return {
      ok: false,
      reason: 'invalid_auth',
    };
  }

  return {
    ok: true,
    principal: {
      audience: configuredPrincipal.audience,
      role: configuredPrincipal.role,
      principalId: configuredPrincipal.principalId,
      scopes: [...configuredPrincipal.scopes],
    },
  };
}

function sendControlPlaneAuthError(
  req: Request,
  res: Response,
  statusCode: 401 | 403 | 503,
  code: string,
  message: string
): void {
  res.setHeader('Cache-Control', 'no-store');
  if (statusCode === 401) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="control-plane"');
  }
  res.status(statusCode).json({
    ok: false,
    ...(req.requestId ? { requestId: req.requestId } : {}),
    error: {
      code,
      message,
    },
  });
}

function applyControlPlaneHttpAuthentication(
  req: Request,
  res: Response,
  next: NextFunction,
  env: NodeJS.ProcessEnv
): void {
  const result = authenticateControlPlaneHttpRequest(req, env);
  if (!result.ok) {
    const configurationUnavailable = result.reason === 'configuration_unavailable';
    const statusCode = configurationUnavailable ? 503 : 401;
    req.logger?.[configurationUnavailable ? 'error' : 'warn']?.('control_plane.http_auth.denied', {
      reason: result.reason,
      statusCode,
    });
    sendControlPlaneAuthError(
      req,
      res,
      statusCode,
      configurationUnavailable
        ? 'CONTROL_PLANE_AUTH_UNAVAILABLE'
        : 'CONTROL_PLANE_AUTH_REQUIRED',
      configurationUnavailable
        ? 'Control-plane authentication is unavailable.'
        : 'Control-plane bearer authentication is required.'
    );
    return;
  }

  req.controlPlanePrincipal = result.principal;
  next();
}

export function createControlPlaneHttpAuthenticationMiddleware(
  env: NodeJS.ProcessEnv
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    applyControlPlaneHttpAuthentication(req, res, next, env);
  };
}

export function controlPlaneHttpAuthenticationMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  applyControlPlaneHttpAuthentication(req, res, next, process.env);
}

export function requireControlPlaneOperator(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (req.controlPlanePrincipal?.role !== 'operator') {
    sendControlPlaneAuthError(
      req,
      res,
      403,
      'CONTROL_PLANE_FORBIDDEN',
      'Control-plane operation is not permitted.'
    );
    return;
  }

  next();
}

/**
 * Authorize a request against server-owned control-plane scopes.
 *
 * The public denial intentionally omits both required and granted scope names.
 * Audit metadata is limited to the HTTP method so query values cannot enter logs.
 */
export function authorizeControlPlaneHttpScopes(
  req: Request,
  res: Response,
  next: NextFunction,
  requiredScopes: readonly string[],
  auditEvent = 'control_plane.http_scope.denied'
): void {
  const grantedScopes = new Set(req.controlPlanePrincipal?.scopes ?? []);
  if (requiredScopes.every((scope) => grantedScopes.has(scope))) {
    next();
    return;
  }

  req.logger?.warn?.(auditEvent, {
    reason: 'missing_scope',
    statusCode: 403,
    method: req.method,
  });
  sendControlPlaneAuthError(
    req,
    res,
    403,
    'CONTROL_PLANE_SCOPE_DENIED',
    'Control-plane operation is not permitted.'
  );
}

export function requireControlPlaneHttpScopes(
  requiredScopes: readonly string[],
  auditEvent?: string
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    authorizeControlPlaneHttpScopes(
      req,
      res,
      next,
      requiredScopes,
      auditEvent
    );
  };
}
