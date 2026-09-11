import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { gptAccessAuthMiddleware, isGptAccessScopeAllowed } from '@services/gptAccessGateway.js';
import {
  gptAccessDeviceCredentials,
} from '@services/gptAccessDeviceCredentials.js';
import {
  denyDeviceOperation, readDeviceBearer, readDeviceRequestOrigin, sendDeviceAuthError,
} from '@services/gptAccessDeviceAuth.js';
import {
  GPT_ACCESS_DEVICE_ACTIONS, GPT_ACCESS_DEVICE_SCOPES, GptAccessDeviceAuthError,
  GptAccessDeviceOriginSchema, GptAccessPairingCompleteSchema,
} from '@shared/security/gptAccessDevice.js';

const router = Router();
const pairingRequest = z.object({
  scopes: z.array(z.enum(GPT_ACCESS_DEVICE_SCOPES)).min(1).max(4).optional(),
  capabilityActions: z.array(z.enum(GPT_ACCESS_DEVICE_ACTIONS)).max(4).optional(),
}).strict();
const emptyRequest = z.object({}).strict();
const contextId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function operatorContext() {
  const principalId = process.env.ARCANOS_GPT_ACCESS_PRINCIPAL_ID ?? '';
  const workspaceId = process.env.ARCANOS_GPT_ACCESS_WORKSPACE_ID ?? '';
  if (!contextId.test(principalId) || !contextId.test(workspaceId)) {
    throw new GptAccessDeviceAuthError('DEVICE_AUTH_UNAVAILABLE', 503);
  }
  return { principalId, workspaceId };
}

function handle(operation: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response): void => {
    void operation(req, res).catch(error => sendDeviceAuthError(req, res, error));
  };
}
function requireDevice(req: Request, res: Response, next: NextFunction): void {
  if (!req.gptAccessDevicePrincipal) { denyDeviceOperation(req, res); return; }
  next();
}
function validateEmpty(req: Request): void {
  if (!emptyRequest.safeParse(req.body).success) throw new GptAccessDeviceAuthError('DEVICE_AUTH_INVALID', 400);
}

router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// A high-entropy single-use bootstrap is the only unauthenticated route. It is
// already inside the existing Gateway rate limit and global bounded JSON parser.
router.post('/pair', handle(async (req, res) => {
  const parsed = GptAccessPairingCompleteSchema.safeParse(req.body);
  if (!parsed.success) throw new GptAccessDeviceAuthError('PAIRING_INVALID', 400);
  const session = await gptAccessDeviceCredentials.completePairing(
    parsed.data.pairingToken, parsed.data.localIdentity, readDeviceRequestOrigin(req),
  );
  req.logger?.info?.('gpt_access.device.paired', { deviceId: session.deviceId });
  res.status(201).json(session);
}));

router.use(gptAccessAuthMiddleware);
router.post('/pairing', handle(async (req, res) => {
  if (req.gptAccessDevicePrincipal) { denyDeviceOperation(req, res); return; }
  const parsed = pairingRequest.safeParse(req.body);
  if (!parsed.success) throw new GptAccessDeviceAuthError('DEVICE_SCOPE_DENIED', 400);
  const origin = process.env.ARCANOS_GPT_ACCESS_DEVICE_ORIGIN ?? '';
  if (!GptAccessDeviceOriginSchema.safeParse(origin).success) throw new GptAccessDeviceAuthError('DEVICE_AUTH_UNAVAILABLE', 503);
  const scopes = parsed.data.scopes ?? [...GPT_ACCESS_DEVICE_SCOPES];
  if (!scopes.every(isGptAccessScopeAllowed)) { denyDeviceOperation(req, res); return; }
  const pairing = await gptAccessDeviceCredentials.createPairing({
    ...operatorContext(), origin, scopes,
    capabilityActions: parsed.data.capabilityActions ?? ['git.status'],
  });
  req.logger?.info?.('gpt_access.device.pairing_created', { expiresAt: pairing.expiresAt });
  res.status(201).json(pairing);
}));

router.get('/session', requireDevice, handle(async (req, res) => {
  res.json(await gptAccessDeviceCredentials.inspect(readDeviceBearer(req)!, readDeviceRequestOrigin(req)));
}));
router.post('/renew', requireDevice, handle(async (req, res) => {
  validateEmpty(req);
  const session = await gptAccessDeviceCredentials.renew(readDeviceBearer(req)!, readDeviceRequestOrigin(req));
  req.logger?.info?.('gpt_access.device.credential_rotated', { deviceId: session.deviceId, expiresAt: session.expiresAt });
  res.json(session);
}));
router.post('/:deviceId/revoke', handle(async (req, res) => {
  validateEmpty(req);
  const device = req.gptAccessDevicePrincipal;
  if (device && device.deviceId !== req.params.deviceId) { denyDeviceOperation(req, res); return; }
  const owner = device ?? operatorContext();
  const result = await gptAccessDeviceCredentials.revoke(req.params.deviceId, owner.principalId, owner.workspaceId);
  req.logger?.info?.('gpt_access.device.revoked', { deviceId: result.deviceId });
  res.json(result);
}));

export default router;
