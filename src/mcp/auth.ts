import type { Request, Response, NextFunction } from 'express';
import { getEnv } from '@platform/runtime/env.js';

/**
 * Minimal auth / origin protection for MCP Streamable HTTP.
 * - Bearer token (recommended for public deployments)
 * - Origin allowlist (DNS rebinding / browser safety)
 */
export function mcpAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const token = getEnv('MCP_BEARER_TOKEN');
  if (token) {
    const auth = req.header('authorization') ?? '';
    if (auth !== `Bearer ${token}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }

  const origin = req.header('origin');
  const allowRaw = getEnv('MCP_ALLOWED_ORIGINS', '');
  const allow = allowRaw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  // Allow non-browser clients (no Origin). Reject unexpected browser origins.
  if (origin && allow.length && !allow.includes(origin)) {
    res.status(403).json({ error: 'Origin not allowed' });
    return;
  }

  next();
}
