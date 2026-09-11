import type { NextFunction, Request, Response } from 'express';
import {
  GptAccessDeviceAuthError,
  gptAccessDeviceCredentials,
} from './gptAccessDeviceCredentials.js';
import { GptAccessDeviceOriginSchema } from '@shared/security/gptAccessDevice.js';
import { isModuleActionAllowed } from '../mcp/modulesAllowlist.js';

export const DEVICE_ORIGIN_HEADER = 'x-arcanos-device-origin';

export function readDeviceRequestOrigin(req: Request): string {
  const configured = process.env.ARCANOS_GPT_ACCESS_DEVICE_ORIGIN ?? '';
  if (!GptAccessDeviceOriginSchema.safeParse(configured).success) throw new GptAccessDeviceAuthError('DEVICE_AUTH_UNAVAILABLE', 503);
  if (req.header(DEVICE_ORIGIN_HEADER) !== configured) throw new GptAccessDeviceAuthError('DEVICE_ORIGIN_DENIED', 403);
  return configured;
}

/** Device credentials never enter the operator or executor authentication lane. */
export function isDeviceCredentialRequest(req: Request): boolean {
  return /^Bearer\s+agd1\./i.test(req.header('authorization') ?? '');
}

export function readDeviceBearer(req: Request): string | null {
  const count = (req.rawHeaders ?? []).filter((value, index) =>
    index % 2 === 0 && value.toLowerCase() === 'authorization').length;
  if (count > 1) return null;
  return /^Bearer (agd1\.[A-Za-z0-9_-]{43})$/.exec(req.header('authorization') ?? '')?.[1] ?? null;
}

function isDeviceRouteAllowed(req: Request): boolean {
  let path: string;
  try { path = decodeURIComponent(req.originalUrl.split('?')[0]); } catch { return false; }
  if (req.method === 'POST') {
    return ['/gpt-access/jobs/create', '/gpt-access/jobs/result', '/gpt-access/devices/renew'].includes(path)
      || path === '/gpt-access/capabilities/v1/ARCANOS:LOCAL_AGENT/run'
      || /^\/gpt-access\/devices\/[0-9a-f-]{36}\/revoke$/i.test(path);
  }
  return req.method === 'GET' && [
    '/gpt-access/capabilities/v1',
    '/gpt-access/capabilities/v1/ARCANOS:LOCAL_AGENT',
    '/gpt-access/devices/session',
  ].includes(path);
}

export function sendDeviceAuthError(req: Request, res: Response, error: unknown): void {
  const known = error instanceof GptAccessDeviceAuthError;
  const code = known ? error.code : 'DEVICE_AUTH_UNAVAILABLE';
  const status = known ? error.statusCode : 503;
  // Never pass exceptions, headers, request bodies or opaque material to the logger.
  req.logger?.warn?.('gpt_access.device.authorization_denied', { code, statusCode: status });
  res.set('Cache-Control', 'no-store');
  if (status === 401) res.set('WWW-Authenticate', 'Bearer realm="gpt-access-device"');
  res.status(status).json({ ok: false, error: { code, message: 'Device authentication or authorization could not be completed.' } });
}

export function denyDeviceOperation(req: Request, res: Response): void {
  req.logger?.warn?.('gpt_access.device.authorization_denied', {
    code: 'DEVICE_SCOPE_DENIED', deviceId: req.gptAccessDevicePrincipal?.deviceId,
  });
  res.set('Cache-Control', 'no-store');
  res.status(403).json({ ok: false, error: { code: 'DEVICE_SCOPE_DENIED', message: 'Device operation is not permitted.' } });
}

export async function authenticateGptAccessDevice(req: Request, res: Response, next: NextFunction): Promise<void> {
  res.set('Cache-Control', 'no-store');
  const credential = readDeviceBearer(req);
  if (!credential) {
    res.status(401).json({ ok: false, error: { code: 'DEVICE_AUTH_INVALID', message: 'Invalid device credential.' } });
    return;
  }
  try {
    const principal = await gptAccessDeviceCredentials.authenticate(credential, readDeviceRequestOrigin(req));
    req.gptAccessDevicePrincipal = principal;
    // Stable through rotation, isolated between devices sharing an operator/workspace.
    req.authenticatedActorKey = `gpt-access-device:${principal.deviceId}`;
    if (!isDeviceRouteAllowed(req)) {
      denyDeviceOperation(req, res);
      return;
    }
    next();
  } catch (error) {
    sendDeviceAuthError(req, res, error);
  }
}

export function authorizeDeviceCapability(req: Request, res: Response, next: NextFunction): void {
  const principal = req.gptAccessDevicePrincipal;
  if (!principal) { next(); return; }
  const action: unknown = req.body?.action;
  if (req.params.id !== 'ARCANOS:LOCAL_AGENT' || typeof action !== 'string'
    || !principal.capabilityActions.some(allowed => allowed === action)
    || !isModuleActionAllowed('ARCANOS:LOCAL_AGENT', action)) {
    denyDeviceOperation(req, res);
    return;
  }
  req.logger?.info?.('gpt_access.device.capability_requested', { deviceId: principal.deviceId, action });
  next();
}
