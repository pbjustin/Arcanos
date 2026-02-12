import { randomUUID } from 'crypto';
import { getEnvNumber } from '@platform/runtime/env.js';

export interface OneTimeTokenRecord {
  token: string;
  issuedAt: number;
  expiresAt: number;
  ttlMs: number;
}

type ConsumeResult =
  | { ok: true; record: OneTimeTokenRecord }
  | { ok: false; reason: 'missing' | 'invalid' | 'expired' };

const DEFAULT_TOKEN_TTL_MS = 10 * 60 * 1000;

function resolveTokenTtlMs(): number {
  const ttlMs = getEnvNumber('ARCANOS_CONFIRM_TOKEN_TTL_MS', 0);
  //audit Assumption: positive TTL overrides default; risk: zero/negative disables override; invariant: ttlMs > 0; handling: return override when valid.
  if (ttlMs > 0) {
    return ttlMs;
  }

  const ttlMinutes = getEnvNumber('ARCANOS_CONFIRM_TOKEN_TTL_MINUTES', 0);
  //audit Assumption: minutes override when provided; risk: misconfigured minutes; invariant: ttlMinutes > 0; handling: convert to ms.
  if (ttlMinutes > 0) {
    return ttlMinutes * 60 * 1000;
  }

  //audit Assumption: default TTL is safe fallback; risk: too long/short; invariant: positive ms; handling: return constant.
  return DEFAULT_TOKEN_TTL_MS;
}

const tokenTtlMs = resolveTokenTtlMs();
const pendingTokens = new Map<string, OneTimeTokenRecord>();

function purgeExpiredTokens(now: number = Date.now()): void {
  for (const [token, record] of pendingTokens.entries()) {
    //audit Assumption: expired tokens should be removed; risk: memory growth; invariant: expiresAt <= now; handling: delete.
    if (record.expiresAt <= now) {
      pendingTokens.delete(token);
    }
  }
}

/**
 * Purpose: Create a single-use confirmation token.
 * Inputs/Outputs: none; returns token record with expiry metadata.
 * Edge cases: Purges expired tokens before issuance.
 */
export function createOneTimeToken(): OneTimeTokenRecord {
  const now = Date.now();
  purgeExpiredTokens(now);
  const tokenId = randomUUID();

  const record: OneTimeTokenRecord = {
    token: tokenId,
    issuedAt: now,
    expiresAt: now + tokenTtlMs,
    ttlMs: tokenTtlMs
  };

  pendingTokens.set(record.token, record);
  return record;
}

/**
 * Purpose: Consume a one-time confirmation token.
 * Inputs/Outputs: token string; returns ok result with record or failure reason.
 * Edge cases: Returns missing/invalid/expired without throwing.
 */
export function consumeOneTimeToken(token: string | undefined): ConsumeResult {
  //audit Assumption: empty token is invalid; risk: false positives; invariant: non-empty token required; handling: return missing.
  if (!token || !token.trim()) {
    return { ok: false, reason: 'missing' };
  }

  const now = Date.now();
  purgeExpiredTokens(now);

  const record = pendingTokens.get(token);
  //audit Assumption: unknown token is invalid; risk: replay attempt; invariant: record must exist; handling: return invalid.
  if (!record) {
    return { ok: false, reason: 'invalid' };
  }

  //audit Assumption: expired tokens must be rejected; risk: late execution; invariant: expiresAt > now; handling: delete and return expired.
  if (record.expiresAt <= now) {
    pendingTokens.delete(token);
    return { ok: false, reason: 'expired' };
  }

  pendingTokens.delete(token);
  return { ok: true, record };
}

/**
 * Purpose: Return configured one-time token TTL (ms).
 * Inputs/Outputs: none; returns TTL in milliseconds.
 * Edge cases: Uses default when env overrides are missing.
 */
export function getOneTimeTokenTtlMs(): number {
  return tokenTtlMs;
}
