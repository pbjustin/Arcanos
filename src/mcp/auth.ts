import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { getEnv } from '@platform/runtime/env.js';

/**
 * Minimal auth / origin protection for MCP Streamable HTTP.
 * - Bearer token (required)
 * - Origin allowlist (DNS rebinding / browser safety)
 */
function parseAllowedOrigins(raw: string): string[] {
  return raw
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

const mcpBearerToken = getEnv('MCP_BEARER_TOKEN');
const allowedOrigins = parseAllowedOrigins(getEnv('MCP_ALLOWED_ORIGINS', ''));

export function mcpAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!mcpBearerToken) {
    res.status(500).json({ error: 'MCP_BEARER_TOKEN not configured' });
    return;
  }

  const auth = req.header('authorization') ?? '';
  const expectedAuth = `Bearer ${mcpBearerToken}`;
  if (!timingSafeStringEqual(auth, expectedAuth)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const origin = req.header('origin');

  // Allow non-browser clients (no Origin). Reject unexpected browser origins.
  if (origin && allowedOrigins.length && !allowedOrigins.includes(origin)) {
    res.status(403).json({ error: 'Origin not allowed' });
    return;
  }

  next();
}
