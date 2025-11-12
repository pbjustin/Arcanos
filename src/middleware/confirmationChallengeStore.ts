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

import { randomUUID } from 'crypto';

/**
 * Confirmation challenge structure linking a UUID token to a specific request.
 */
export interface ConfirmationChallenge {
  id: string;
  method: string;
  path: string;
  gptId: string | null;
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
  const raw = process.env.CONFIRMATION_CHALLENGE_TTL_MS;
  if (!raw) {
    return DEFAULT_CHALLENGE_TTL_MS;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `Invalid CONFIRMATION_CHALLENGE_TTL_MS value ("${raw}"). Falling back to ${DEFAULT_CHALLENGE_TTL_MS}ms.`,
    );
    return DEFAULT_CHALLENGE_TTL_MS;
  }

  return parsed;
}

const challengeTtlMs = resolveChallengeTtl();
const pendingChallenges = new Map<string, ConfirmationChallenge>();

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
export function createConfirmationChallenge(method: string, path: string, gptId: string | null): ConfirmationChallenge {
  const now = Date.now();
  purgeExpiredChallenges(now);

  const challenge: ConfirmationChallenge = {
    id: randomUUID(),
    method,
    path,
    gptId,
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
export function verifyConfirmationChallenge(token: string, method: string, path: string): boolean {
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
