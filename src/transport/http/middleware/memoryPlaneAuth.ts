import type { NextFunction, Request, Response } from 'express';

import { getEnv } from '@platform/runtime/env.js';
import {
  MEMORY_ACCESS_TOKEN_HEADER_NAME,
  resolveConfiguredMemoryAccessToken,
} from '@shared/security/memoryAccessCredential.js';
import { timingSafeEqualOpaqueSecret } from '@shared/security/opaqueSecret.js';
import {
  MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH,
  MIN_PURPOSE_BOUND_CREDENTIAL_LENGTH,
  type PurposeBoundCredentialEnvironmentReader,
} from '@shared/security/purposeBoundCredential.js';

export type MemoryPlaneAuthenticationResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'configuration_unavailable' | 'missing_auth' | 'invalid_auth';
    };

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

function readPresentedMemoryAccessToken(req: Request): unknown {
  const headerValue = req.headers?.[MEMORY_ACCESS_TOKEN_HEADER_NAME];
  if (headerValue !== undefined) {
    return headerValue;
  }

  return typeof req.header === 'function'
    ? req.header(MEMORY_ACCESS_TOKEN_HEADER_NAME)
    : undefined;
}

function isValidPresentedMemoryAccessToken(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.length >= MIN_PURPOSE_BOUND_CREDENTIAL_LENGTH
    && value.length <= MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH
    && !/\s/u.test(value)
  );
}

/** Parse exactly one dedicated memory-plane credential header. */
export function extractMemoryAccessToken(req: Request): string | null {
  if (countRawHeaders(req, MEMORY_ACCESS_TOKEN_HEADER_NAME) > 1) {
    return null;
  }

  const presentedToken = readPresentedMemoryAccessToken(req);
  return isValidPresentedMemoryAccessToken(presentedToken)
    ? presentedToken
    : null;
}

export function authenticateMemoryPlaneRequest(
  req: Request,
  readEnvironmentValue: PurposeBoundCredentialEnvironmentReader = (environmentName) =>
    getEnv(environmentName)
): MemoryPlaneAuthenticationResult {
  const configuredToken = resolveConfiguredMemoryAccessToken(readEnvironmentValue);
  if (!configuredToken) {
    return {
      ok: false,
      reason: 'configuration_unavailable',
    };
  }

  const presentedToken = extractMemoryAccessToken(req);
  if (!presentedToken) {
    return {
      ok: false,
      reason: readPresentedMemoryAccessToken(req) === undefined
        ? 'missing_auth'
        : 'invalid_auth',
    };
  }

  if (!timingSafeEqualOpaqueSecret(presentedToken, configuredToken)) {
    return {
      ok: false,
      reason: 'invalid_auth',
    };
  }

  return { ok: true };
}

export function sendMemoryPlaneAuthError(
  req: Request,
  res: Response,
  result: Exclude<MemoryPlaneAuthenticationResult, { ok: true }>
): void {
  const configurationUnavailable = result.reason === 'configuration_unavailable';
  const statusCode = configurationUnavailable ? 503 : 401;
  const code = configurationUnavailable
    ? 'MEMORY_AUTH_UNAVAILABLE'
    : 'MEMORY_AUTH_REQUIRED';

  req.logger?.[configurationUnavailable ? 'error' : 'warn']?.('memory_plane.http_auth.denied', {
    reason: result.reason,
    statusCode,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.status(statusCode).json({
    ok: false,
    ...(req.requestId ? { requestId: req.requestId } : {}),
    error: {
      code,
      message: configurationUnavailable
        ? 'Memory-plane authentication is unavailable.'
        : 'A valid memory-plane access token is required.',
    },
  });
}

export function requireMemoryPlaneAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const result = authenticateMemoryPlaneRequest(req);
  if (!result.ok) {
    sendMemoryPlaneAuthError(req, res, result);
    return;
  }

  next();
}
