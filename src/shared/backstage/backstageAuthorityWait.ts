/** Durable queue-only waiting policy; it never extends protected model execution. */
export const BACKSTAGE_AUTHORITY_WAIT_MAX_MS = 12 * 60 * 1_000;
export const BACKSTAGE_AUTHORITY_WAIT_STATE_KEY = 'backstageAuthorityWait';

export interface BackstageAuthorityWaitState {
  readonly version: 1;
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly pollCount: number;
  /** A model execution is never replayed by a later claim generation. */
  readonly executionClaimGeneration?: string;
}

export type BackstageAuthorityWaitDecision =
  | { readonly status: 'defer'; readonly state: BackstageAuthorityWaitState; readonly delayMs: number }
  | { readonly status: 'expired' | 'invalid' };

export function readBackstageAuthorityWaitState(
  autonomyState: unknown,
): BackstageAuthorityWaitState | null | 'invalid' {
  if (autonomyState !== undefined && autonomyState !== null
    && (typeof autonomyState !== 'object' || Array.isArray(autonomyState))) return 'invalid';
  const raw = (autonomyState as Record<string, unknown> | null | undefined)?.[BACKSTAGE_AUTHORITY_WAIT_STATE_KEY];
  if (raw === undefined) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'invalid';
  const state = raw as Record<string, unknown>;
  if (
    state.version !== 1
    || typeof state.startedAt !== 'number' || !Number.isSafeInteger(state.startedAt)
    || typeof state.deadlineAt !== 'number' || !Number.isSafeInteger(state.deadlineAt)
    || state.startedAt < 0 || state.deadlineAt - state.startedAt !== BACKSTAGE_AUTHORITY_WAIT_MAX_MS
    || typeof state.pollCount !== 'number' || !Number.isSafeInteger(state.pollCount)
    || state.pollCount < 1 || state.pollCount > BACKSTAGE_AUTHORITY_WAIT_MAX_MS / 15_000
    || (state.executionClaimGeneration !== undefined && (
      typeof state.executionClaimGeneration !== 'string'
      || !/^(0|[1-9][0-9]{0,18})$/u.test(state.executionClaimGeneration)
      || BigInt(state.executionClaimGeneration) > 9_223_372_036_854_775_807n
    ))
  ) return 'invalid';
  return state as unknown as BackstageAuthorityWaitState;
}

export function planBackstageAuthorityWait(
  autonomyState: unknown,
  now = Date.now(),
): BackstageAuthorityWaitDecision {
  const previous = readBackstageAuthorityWaitState(autonomyState);
  if (previous === 'invalid' || !Number.isSafeInteger(now) || now < 0) return { status: 'invalid' };
  const startedAt = previous?.startedAt ?? now;
  const deadlineAt = previous?.deadlineAt ?? now + BACKSTAGE_AUTHORITY_WAIT_MAX_MS;
  if (now < startedAt) return { status: 'invalid' };
  if (now >= deadlineAt) return { status: 'expired' };
  const pollCount = (previous?.pollCount ?? 0) + 1;
  return {
    status: 'defer',
    state: { version: 1, startedAt, deadlineAt, pollCount },
    delayMs: Math.min(pollCount === 1 ? 15_000 : 30_000, deadlineAt - now),
  };
}
