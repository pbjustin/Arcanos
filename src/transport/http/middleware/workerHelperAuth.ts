import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { getConfig } from '@platform/runtime/unifiedConfig.js';

interface WorkerHelperSecret {
  label: 'admin' | 'register';
  value: string;
}

export interface WorkerHelperAuthContext {
  matchedCredential: WorkerHelperSecret['label'];
  headerSource: 'x-worker-helper-key' | 'x-admin-api-key' | 'x-register-key' | 'authorization';
}

export type WorkerHelperAuthResolution =
  | { status: 'authorized'; context: WorkerHelperAuthContext }
  | { status: 'missing' | 'invalid' | 'disabled' };

declare module 'express-serve-static-core' {
  interface Request {
    workerHelperAuth?: WorkerHelperAuthContext;
  }
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getConfiguredWorkerHelperSecrets(): WorkerHelperSecret[] {
  const config = getConfig();
  const configuredSecrets: WorkerHelperSecret[] = [];

  if (config.adminKey) {
    configuredSecrets.push({ label: 'admin', value: config.adminKey });
  }
  if (config.registerKey) {
    configuredSecrets.push({ label: 'register', value: config.registerKey });
  }

  return configuredSecrets;
}

function getAuthorizationBearerToken(headerValue: string | undefined): string | undefined {
  if (!headerValue) {
    return undefined;
  }

  const [scheme, bearerValue] = headerValue.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== 'bearer' || !bearerValue) {
    return undefined;
  }

  return bearerValue.trim() || undefined;
}

function resolveProvidedHelperSecret(req: Request): {
  headerSource: WorkerHelperAuthContext['headerSource'];
  value: string;
} | null {
  const workerHelperHeader = req.header('x-worker-helper-key')?.trim();
  if (workerHelperHeader) {
    return { headerSource: 'x-worker-helper-key', value: workerHelperHeader };
  }

  const adminHeader = req.header('x-admin-api-key')?.trim();
  if (adminHeader) {
    return { headerSource: 'x-admin-api-key', value: adminHeader };
  }

  const registerHeader = req.header('x-register-key')?.trim();
  if (registerHeader) {
    return { headerSource: 'x-register-key', value: registerHeader };
  }

  const authorizationBearerValue = getAuthorizationBearerToken(req.header('authorization') ?? undefined);
  if (authorizationBearerValue) {
    return { headerSource: 'authorization', value: authorizationBearerValue };
  }

  return null;
}

/**
 * Authenticate CLI or automation requests to the worker helper surface.
 *
 * Purpose:
 * - Provide lightweight operator auth for worker status and command endpoints without the heavier confirm-gate flow.
 *
 * Inputs/outputs:
 * - Input: Express request carrying one of the accepted helper auth headers.
 * - Output: attaches the matched credential metadata to `req.workerHelperAuth` and calls `next()` when authorized.
 *
 * Edge case behavior:
 * - Returns `503` when neither `ADMIN_KEY` nor `REGISTER_KEY` is configured.
 */
export function workerHelperAuth(req: Request, res: Response, next: NextFunction): void {
  const resolution = resolveWorkerHelperAuth(req);

  //audit Assumption: helper commands must stay disabled until an operator secret is configured; failure risk: unauthenticated worker control surface becomes reachable; expected invariant: missing secrets produce a hard failure; handling strategy: return 503 with explicit setup guidance.
  if (resolution.status === 'disabled') {
    res.status(503).json({
      error: 'WORKER_HELPER_DISABLED',
      message: 'Set ADMIN_KEY or REGISTER_KEY before using /worker-helper endpoints.'
    });
    return;
  }

  //audit Assumption: helper auth headers are fully user-controlled and must be validated with timing-safe comparison; failure risk: forged commands or secret probing; expected invariant: only configured secrets authorize helper access; handling strategy: reject missing or mismatched credentials with 403.
  if (resolution.status === 'missing') {
    res.status(403).json({
      error: 'WORKER_HELPER_AUTH_REQUIRED',
      message:
        'Provide x-worker-helper-key, x-admin-api-key, x-register-key, or Authorization: Bearer <key>.'
    });
    return;
  }

  if (resolution.status === 'invalid') {
    res.status(403).json({
      error: 'WORKER_HELPER_AUTH_REQUIRED',
      message: 'Worker helper authentication failed.'
    });
    return;
  }

  if (resolution.status !== 'authorized') {
    res.status(500).json({
      error: 'WORKER_HELPER_AUTH_STATE_INVALID',
      message: 'Unexpected worker helper auth state.'
    });
    return;
  }

  req.workerHelperAuth = resolution.context;

  next();
}

/**
 * Resolve worker-helper authorization without mutating the response.
 *
 * Purpose:
 * - Allow shared auth decisions across middleware, AI tooling, and helper services.
 *
 * Inputs/outputs:
 * - Input: Express request carrying zero or more helper auth headers.
 * - Output: structured authorization resolution with status and matched context.
 *
 * Edge case behavior:
 * - Returns `disabled` when no operator secret is configured.
 */
export function resolveWorkerHelperAuth(req: Request): WorkerHelperAuthResolution {
  const configuredSecrets = getConfiguredWorkerHelperSecrets();

  if (configuredSecrets.length === 0) {
    return { status: 'disabled' };
  }

  const providedSecret = resolveProvidedHelperSecret(req);
  if (!providedSecret) {
    return { status: 'missing' };
  }

  const matchedSecret = configuredSecrets.find(secret =>
    timingSafeStringEqual(providedSecret.value, secret.value)
  );

  if (!matchedSecret) {
    return { status: 'invalid' };
  }

  return {
    status: 'authorized',
    context: {
      matchedCredential: matchedSecret.label,
      headerSource: providedSecret.headerSource
    }
  };
}
