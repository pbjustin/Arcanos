import { randomUUID } from 'crypto';
import { getEnvNumber } from '../config/env.js';

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
  if (ttlMs > 0) {
    return ttlMs;
  }

  const ttlMinutes = getEnvNumber('ARCANOS_CONFIRM_TOKEN_TTL_MINUTES', 0);
  if (ttlMinutes > 0) {
    return ttlMinutes * 60 * 1000;
  }

  return DEFAULT_TOKEN_TTL_MS;
}

const tokenTtlMs = resolveTokenTtlMs();
const pendingTokens = new Map<string, OneTimeTokenRecord>();

function purgeExpiredTokens(now: number = Date.now()): void {
  for (const [token, record] of pendingTokens.entries()) {
    if (record.expiresAt <= now) {
      pendingTokens.delete(token);
    }
  }
}

export function createOneTimeToken(): OneTimeTokenRecord {
  const now = Date.now();
  purgeExpiredTokens(now);

  const record: OneTimeTokenRecord = {
    token: randomUUID(),
    issuedAt: now,
    expiresAt: now + tokenTtlMs,
    ttlMs: tokenTtlMs
  };

  pendingTokens.set(record.token, record);
  return record;
}

export function consumeOneTimeToken(token: string | undefined): ConsumeResult {
  if (!token || !token.trim()) {
    return { ok: false, reason: 'missing' };
  }

  const now = Date.now();
  purgeExpiredTokens(now);

  const record = pendingTokens.get(token);
  if (!record) {
    return { ok: false, reason: 'invalid' };
  }

  if (record.expiresAt <= now) {
    pendingTokens.delete(token);
    return { ok: false, reason: 'expired' };
  }

  pendingTokens.delete(token);
  return { ok: true, record };
}

export function getOneTimeTokenTtlMs(): number {
  return tokenTtlMs;
}
