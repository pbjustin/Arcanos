/**
 * Confirmation Challenge Store
 * 
 * Manages temporary confirmation challenges for the confirmGate middleware.
 * When an endpoint requires confirmation but doesn't receive it immediately,
 * a challenge token is generated and returned. The caller can retry with this
 * token to complete the action after human approval.
 * 
 * Challenges expire after a configurable TTL (default 2 minutes) to prevent
 * unauthorized access via stale tokens.
 * 
 * @module confirmationChallengeStore
 */

import { createHash, randomUUID } from 'crypto';
import { getEnvNumber } from "@platform/runtime/env.js";

/**
 * Confirmation challenge structure linking a UUID token to a specific request.
 */
export interface ConfirmationChallenge {
  id: string;
  method: string;
  path: string;
  gptId: string | null;
  requestFingerprintHash: string | null;
  issuedAt: number;
  expiresAt: number;
}

/**
 * Default challenge time-to-live: 2 minutes.
 */
const DEFAULT_CHALLENGE_TTL_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Resolves the challenge TTL from environment variable or uses default.
 * Validates that the configured value is a positive number.
 * 
 * @returns Challenge TTL in milliseconds
 */
function resolveChallengeTtl(): number {
  // Use config layer for env access (adapter boundary pattern)
  const ttl = getEnvNumber('CONFIRMATION_CHALLENGE_TTL_MS', DEFAULT_CHALLENGE_TTL_MS);
  if (ttl <= 0) {
    console.warn(
      `Invalid CONFIRMATION_CHALLENGE_TTL_MS value. Falling back to ${DEFAULT_CHALLENGE_TTL_MS}ms.`,
    );
    return DEFAULT_CHALLENGE_TTL_MS;
  }
  return ttl;
}

const challengeTtlMs = resolveChallengeTtl();
const pendingChallenges = new Map<string, ConfirmationChallenge>();

function compareStringKeys(leftKey: string, rightKey: string): number {
  if (leftKey < rightKey) {
    return -1;
  }

  if (leftKey > rightKey) {
    return 1;
  }

  return 0;
}

function stableStringify(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }

  if (value === null) {
    return 'null';
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  }

  if (typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }

  const normalizedEntries = Object.entries(value as Record<string, unknown>)
    .sort(([leftKey], [rightKey]) => compareStringKeys(leftKey, rightKey))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);

  return `{${normalizedEntries.join(',')}}`;
}

export function buildConfirmationRequestFingerprintHash(body: unknown): string {
  return createHash('sha256').update(stableStringify(body)).digest('hex');
}

/**
 * Removes expired challenges from the pending challenge map.
 * Called automatically before creating or verifying challenges.
 * 
 * @param now - Current timestamp in milliseconds (defaults to Date.now())
 */
function purgeExpiredChallenges(now: number = Date.now()): void {
  for (const [id, challenge] of pendingChallenges.entries()) {
    if (challenge.expiresAt <= now) {
      pendingChallenges.delete(id);
    }
  }
}

/**
 * Creates a new confirmation challenge for a specific request.
 * The challenge expires after the configured TTL and is stored for later verification.
 * 
 * @param method - HTTP method of the request requiring confirmation
 * @param path - Path of the endpoint requiring confirmation
 * @param gptId - Optional GPT identifier making the request
 * @returns The newly created challenge with UUID token
 */
export function createConfirmationChallenge(
  method: string,
  path: string,
  gptId: string | null,
  requestFingerprintHash: string | null = null
): ConfirmationChallenge {
  const now = Date.now();
  purgeExpiredChallenges(now);

  const challenge: ConfirmationChallenge = {
    id: randomUUID(),
    method,
    path,
    gptId,
    requestFingerprintHash,
    issuedAt: now,
    expiresAt: now + challengeTtlMs,
  };

  pendingChallenges.set(challenge.id, challenge);
  return challenge;
}

/**
 * Verifies a confirmation challenge token against the current request.
 * Ensures the token exists, hasn't expired, and matches the request method and path.
 * The challenge is consumed (deleted) upon successful verification.
 * 
 * @param token - Challenge token to verify
 * @param method - HTTP method of the current request
 * @param path - Path of the current request
 * @returns True if the challenge is valid and matches, false otherwise
 */
export function verifyConfirmationChallenge(
  token: string,
  method: string,
  path: string,
  requestFingerprintHash: string | null = null
): boolean {
  const now = Date.now();
  purgeExpiredChallenges(now);

  const challenge = pendingChallenges.get(token);
  if (!challenge) {
    return false;
  }

  if (challenge.expiresAt <= now) {
    pendingChallenges.delete(token);
    return false;
  }

  if (challenge.method !== method || challenge.path !== path) {
    pendingChallenges.delete(token);
    return false;
  }

  if (challenge.requestFingerprintHash && challenge.requestFingerprintHash !== requestFingerprintHash) {
    pendingChallenges.delete(token);
    return false;
  }

  pendingChallenges.delete(token);
  return true;
}

/**
 * Returns the configured challenge TTL in milliseconds.
 * 
 * @returns Challenge time-to-live in milliseconds
 */
export function getChallengeTtlMs(): number {
  return challengeTtlMs;
}

/**
 * Returns the count of pending (non-expired) challenges.
 * Automatically purges expired challenges before counting.
 * 
 * @returns Number of active pending challenges
 */
export function getPendingChallengeCount(): number {
  purgeExpiredChallenges();
  return pendingChallenges.size;
}
