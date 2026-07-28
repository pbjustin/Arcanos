import type { NextFunction, Request, Response } from 'express';

import { getEnv } from '@platform/runtime/env.js';
import { timingSafeEqualOpaqueSecret } from '@shared/security/opaqueSecret.js';
import {
  MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH,
  MIN_PURPOSE_BOUND_CREDENTIAL_LENGTH,
} from '@shared/security/purposeBoundCredential.js';
import {
  resolveConfiguredWorkerHelperToken,
  WORKER_HELPER_TOKEN_HEADER_NAME,
} from '@shared/security/workerHelperCredential.js';
import { resolveHeader } from '@transport/http/requestHeaders.js';

const allowedOperatorRoles = new Set(['admin', 'operator', 'owner']);

function countRawHeaders(req: Request, headerName: string): number {
  const rawHeaders = Array.isArray(req.rawHeaders) ? req.rawHeaders : [];
  let count = 0;

  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (
      typeof rawHeaders[index] === 'string'
      && rawHeaders[index].toLowerCase() === headerName
    ) {
      count += 1;
    }
  }

  return count;
}

function isValidPresentedWorkerHelperToken(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.length >= MIN_PURPOSE_BOUND_CREDENTIAL_LENGTH
    && value.length <= MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH
    && !/\s/u.test(value)
  );
}

/**
 * Parse exactly one purpose-bound worker-helper credential carrier.
 *
 * An empty custom header is treated as absent for compatibility. Any non-empty
 * custom header suppresses Bearer fallback, and presenting both carriers fails
 * closed.
 */
export function extractWorkerHelperCredential(req: Request): string | null {
  if (
    countRawHeaders(req, WORKER_HELPER_TOKEN_HEADER_NAME) > 1
    || countRawHeaders(req, 'authorization') > 1
  ) {
    return null;
  }

  const rawCustomHeader = req.headers?.[WORKER_HELPER_TOKEN_HEADER_NAME];
  const rawAuthorizationHeader = req.headers?.authorization;
  if (
    (rawCustomHeader !== undefined && typeof rawCustomHeader !== 'string')
    || (rawAuthorizationHeader !== undefined && typeof rawAuthorizationHeader !== 'string')
  ) {
    return null;
  }

  const customCredential = resolveHeader(req.headers, WORKER_HELPER_TOKEN_HEADER_NAME);
  const authorization = resolveHeader(req.headers, 'authorization');
  const hasCustomCredential = typeof customCredential === 'string'
    && customCredential.length > 0;
  const hasAuthorization = typeof authorization === 'string'
    && authorization.length > 0;

  if (hasCustomCredential && hasAuthorization) {
    return null;
  }

  if (hasCustomCredential) {
    return isValidPresentedWorkerHelperToken(customCredential)
      ? customCredential
      : null;
  }

  if (
    !hasAuthorization
    || authorization.length > MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH + 7
  ) {
    return null;
  }

  const match = /^Bearer ([^\s]+)$/iu.exec(authorization);
  return match && isValidPresentedWorkerHelperToken(match[1])
    ? match[1]
    : null;
}

function hasTrustedWorkerHelperToken(req: Request): boolean {
  const configuredToken = resolveConfiguredWorkerHelperToken((environmentName) =>
    getEnv(environmentName)
  );
  if (!configuredToken) {
    return false;
  }

  return timingSafeEqualOpaqueSecret(
    extractWorkerHelperCredential(req),
    configuredToken
  );
}

function isOperatorLightRole(role: string | undefined): boolean {
  return role?.trim().toLowerCase() === 'operator-light';
}

function resolveAuthUserRole(req: Request): string | undefined {
  return typeof req.authUser?.role === 'string'
    ? req.authUser.role.trim().toLowerCase()
    : undefined;
}

function denyOperatorLight(res: Response, authUserRole: string | undefined): boolean {
  if (!isOperatorLightRole(authUserRole)) {
    return false;
  }

  res.status(403).json({
    error: 'WORKER_HELPER_OPERATOR_FORBIDDEN',
    message: 'Worker helper privileged routes require full operator privileges.'
  });
  return true;
}

function sendWorkerAuthRequired(res: Response): void {
  res.status(401).json({
    error: 'WORKER_HELPER_AUTH_REQUIRED',
    message: 'Worker helper privileged routes require authenticated operator or trusted internal access.'
  });
}

/**
 * Require an authenticated full operator or trusted internal worker context.
 * This establishes access authority; action confirmation remains a separate gate.
 */
export function requireWorkerHelperPrivilegedAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const authUserRole = resolveAuthUserRole(req);

  if (denyOperatorLight(res, authUserRole)) {
    return;
  }

  if (
    req.daemonToken
    || hasTrustedWorkerHelperToken(req)
    || (authUserRole && allowedOperatorRoles.has(authUserRole))
    || (typeof req.operatorActor === 'string' && req.operatorActor.trim().length > 0)
  ) {
    next();
    return;
  }

  sendWorkerAuthRequired(res);
}

/**
 * Protect direct HTTP worker execution with verifiable credentials only.
 * Audit labels and the legacy daemon marker are intentionally not authority.
 */
export function requireWorkerRunPrivilegedAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const authUserRole = resolveAuthUserRole(req);

  if (denyOperatorLight(res, authUserRole)) {
    return;
  }

  if (
    hasTrustedWorkerHelperToken(req)
    || (authUserRole && allowedOperatorRoles.has(authUserRole))
  ) {
    next();
    return;
  }

  sendWorkerAuthRequired(res);
}
