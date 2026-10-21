/** Durable queue-only waiting policy; it never extends protected model execution. */
export const BACKSTAGE_AUTHORITY_WAIT_MAX_MS = 12 * 60 * 1_000;
export const BACKSTAGE_AUTHORITY_WAIT_STATE_KEY = 'backstageAuthorityWait';
const AUTHORITY_POLL_MAX_MS = 120_000;

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
  pollKey = '',
): BackstageAuthorityWaitDecision {
  const previous = readBackstageAuthorityWaitState(autonomyState);
  if (previous === 'invalid' || !Number.isSafeInteger(now) || now < 0) return { status: 'invalid' };
  const startedAt = previous?.startedAt ?? now;
  const deadlineAt = previous?.deadlineAt ?? now + BACKSTAGE_AUTHORITY_WAIT_MAX_MS;
  if (now < startedAt) return { status: 'invalid' };
  if (now >= deadlineAt) return { status: 'expired' };
  const pollCount = (previous?.pollCount ?? 0) + 1;
  // Every poll consumes the shared ordinary claim budget. Back off to two
  // minutes instead of spending a claim every thirty seconds for a full crawl.
  const baseDelayMs = Math.min(15_000 * 2 ** Math.min(pollCount - 1, 3), AUTHORITY_POLL_MAX_MS);
  // Stable per-job offsets spread the early polls and survive worker restarts.
  // Additive jitter never increases polling frequency or exceeds the cap.
  let hash = 0;
  if (pollKey) {
    for (const character of `${pollKey}:${pollCount}`) {
      hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
    }
  }
  const jitterMs = pollKey ? hash % (Math.floor(baseDelayMs / 10) + 1) : 0;
  return {
    status: 'defer',
    state: { version: 1, startedAt, deadlineAt, pollCount },
    delayMs: Math.min(baseDelayMs + jitterMs, AUTHORITY_POLL_MAX_MS, deadlineAt - now),
  };
}
