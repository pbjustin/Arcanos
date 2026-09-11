import express, { type Request, type Response, type NextFunction } from 'express';
import { gptAccessAuthMiddleware } from './gptAccessGateway.js';
import { gptAccessRateLimit } from './gptAccessRateLimit.js';

export const GPT_ACCESS_DEVICE_BODY_LIMIT_BYTES = 4096;
const applied = new WeakSet<Request>();
const parse = express.json({
  limit: GPT_ACCESS_DEVICE_BODY_LIMIT_BYTES, inflate: false, strict: true,
  verify: (_req, _res, buffer) => { if (buffer.length === 0) throw new Error('Empty device request'); },
});

export function isGptAccessDeviceBoundaryApplied(req: Request): boolean { return applied.has(req); }

/** Apply before application JSON parsing, and reuse at the leaf without a second budget. */
export function gptAccessDeviceHttpBoundary(req: Request, res: Response, next: NextFunction): void {
  if (applied.has(req)) { next(); return; }
  res.set('Cache-Control', 'no-store');
  const reject = (status: number): void => {
    req.logger?.warn?.('gpt_access.device.request_denied', { statusCode: status });
    res.status(status).json({ ok: false, error: { code: 'DEVICE_REQUEST_INVALID', message: 'Invalid device request.' } });
  };
  const parseBody = (): void => {
    if (req.method === 'POST') {
      const encoding = req.header('content-encoding');
      if (encoding && encoding !== 'identity') { reject(415); return; }
      if (req.header('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') { reject(415); return; }
      const length = req.header('content-length');
      if (length === '0' || (length === undefined && !req.header('transfer-encoding'))) { reject(400); return; }
      if (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > GPT_ACCESS_DEVICE_BODY_LIMIT_BYTES)) {
        reject(413); return;
      }
    }
    parse(req, res, (error?: { status?: number }) => {
      if (error) { reject(error.status === 413 ? 413 : error.status === 415 ? 415 : 400); return; }
      // Also bound a leaf mounted by a caller that has already parsed JSON.
      if (req.body !== undefined && Buffer.byteLength(JSON.stringify(req.body)) > GPT_ACCESS_DEVICE_BODY_LIMIT_BYTES) {
        reject(413); return;
      }
      applied.add(req);
      next();
    });
  };
  gptAccessRateLimit(req, res, () => {
    if (req.method === 'POST' && req.path === '/pair') parseBody();
    else gptAccessAuthMiddleware(req, res, parseBody);
  });
}
