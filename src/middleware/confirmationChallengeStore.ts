import { randomUUID } from 'crypto';

export interface ConfirmationChallenge {
  id: string;
  method: string;
  path: string;
  gptId: string | null;
  issuedAt: number;
  expiresAt: number;
}

const DEFAULT_CHALLENGE_TTL_MS = 2 * 60 * 1000; // 2 minutes

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

function purgeExpiredChallenges(now: number = Date.now()): void {
  for (const [id, challenge] of pendingChallenges.entries()) {
    if (challenge.expiresAt <= now) {
      pendingChallenges.delete(id);
    }
  }
}

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

export function getChallengeTtlMs(): number {
  return challengeTtlMs;
}

export function getPendingChallengeCount(): number {
  purgeExpiredChallenges();
  return pendingChallenges.size;
}
