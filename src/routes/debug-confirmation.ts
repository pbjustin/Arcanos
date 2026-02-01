import { Router, Request, Response, NextFunction } from 'express';
import { createOneTimeToken, consumeOneTimeToken, getOneTimeTokenTtlMs } from '../lib/tokenStore.js';

const router = Router();

function resolveAutomationHeaderName(): string {
  return (process.env.ARCANOS_AUTOMATION_HEADER || 'x-arcanos-automation').toLowerCase();
}

function requireAutomationSecret(req: Request, res: Response, next: NextFunction): void {
  const secret = (process.env.ARCANOS_AUTOMATION_SECRET || '').trim();
  const headerName = resolveAutomationHeaderName();
  const provided = req.headers[headerName];
  const providedValue = Array.isArray(provided) ? provided[0] : provided;

  // //audit Assumption: issuance requires operator secret; risk: token issuance without operator approval; invariant: secret must match; handling: reject 403 if missing/invalid.
  if (!secret) {
    res.status(403).json({
      ok: false,
      error: 'Automation secret not configured'
    });
    return;
  }

  if (!providedValue || providedValue !== secret) {
    res.status(403).json({
      ok: false,
      error: 'Forbidden'
    });
    return;
  }

  next();
}

router.post('/debug/create-confirmation-token', requireAutomationSecret, (_req: Request, res: Response) => {
  const record = createOneTimeToken();

  res.status(200).json({
    ok: true,
    token: record.token,
    issuedAt: new Date(record.issuedAt).toISOString(),
    expiresAt: new Date(record.expiresAt).toISOString(),
    ttlMs: record.ttlMs,
    ttlConfiguredMs: getOneTimeTokenTtlMs()
  });
});

router.post('/debug/consume-confirm-token', (req: Request, res: Response) => {
  const tokenFromHeader = req.headers['x-arcanos-confirm-token'];
  const tokenHeaderValue = Array.isArray(tokenFromHeader) ? tokenFromHeader[0] : tokenFromHeader;
  const tokenFromBody = typeof req.body?.token === 'string' ? req.body.token : undefined;
  const token = tokenHeaderValue || tokenFromBody;

  // //audit Assumption: token itself is the capability; risk: leaked token grants access; invariant: token must be valid and unexpired; handling: consume on success, 403 on failure.
  if (!token) {
    res.status(400).json({ ok: false, error: 'Missing token' });
    return;
  }

  const result = consumeOneTimeToken(token);
  if (!result.ok) {
    res.status(403).json({ ok: false, error: 'Invalid or expired token', reason: result.reason });
    return;
  }

  res.status(200).json({
    ok: true,
    consumed: true,
    issuedAt: result.record ? new Date(result.record.issuedAt).toISOString() : undefined,
    expiresAt: result.record ? new Date(result.record.expiresAt).toISOString() : undefined
  });
});

export default router;
