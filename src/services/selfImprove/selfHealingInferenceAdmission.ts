import { createHash, randomUUID } from 'node:crypto';
import { getEnv } from '@platform/runtime/env.js';
import { executeRedisOperation } from '@platform/runtime/redisLifecycle.js';

const HOUR_MS = 3_600_000;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const MAX_COOLDOWN_MS = 30 * 24 * HOUR_MS;
const MAX_TRANSACTION_ATTEMPTS = 4;

export interface SelfHealingInferenceReservation {
  token: string;
  attemptedAt: string;
  purpose?: 'diagnosis' | 'provider_probe';
}

export interface SelfHealingInferencePolicy {
  purpose?: 'diagnosis' | 'provider_probe';
  credential: string | null | undefined;
  cooldownMs: number;
  failureCooldownMs: number;
  maxAttemptsPerHour?: number;
}

export type SelfHealingInferenceDenialReason =
  | 'missing_credential' | 'authentication_blocked' | 'in_flight' | 'cooldown'
  | 'budget_exhausted' | 'coordination_unavailable' | 'invalid_state'
  | 'invalid_policy' | 'clock_regression';

export type SelfHealingInferenceAdmission =
  | { allowed: true; reservation: SelfHealingInferenceReservation }
  | {
      allowed: false;
      reason: SelfHealingInferenceDenialReason;
      lastAttemptAt: string | null;
      retryAt: string | null;
      failureCooldownActive?: boolean;
    };

export type SelfHealingInferenceOutcome =
  'success' | 'failure' | 'authentication_failure' | 'uncertain';

interface InferenceState {
  version: 1;
  lastAttemptMs: number | null;
  lastFailureMs: number | null;
  lastCompletedMs: number | null;
  blockedCredentialIdentity: string | null;
  inFlight: { token: string; credentialIdentity: string } | null;
  attemptTimestampsMs: number[];
}

/** The read and CAS must share one durable key across all participating runtimes. */
export interface SelfHealingInferenceStore {
  read(): Promise<{ rawState: string | null; nowMs: number }>;
  compareAndSet(expected: string | null, replacement: string): Promise<boolean>;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= 0 && value <= MAX_TIMESTAMP_MS - MAX_COOLDOWN_MS;
}

function parseState(rawState: string | null): InferenceState | null {
  if (rawState === null) {
    return {
      version: 1, lastAttemptMs: null, lastFailureMs: null, lastCompletedMs: null,
      blockedCredentialIdentity: null, inFlight: null, attemptTimestampsMs: []
    };
  }
  try {
    const state: InferenceState = JSON.parse(rawState);
    if (!state || state.version !== 1
      || ![state.lastAttemptMs, state.lastFailureMs, state.lastCompletedMs]
        .every(value => value === null || isTimestamp(value))
      || !Array.isArray(state.attemptTimestampsMs) || state.attemptTimestampsMs.length > 6
      || !state.attemptTimestampsMs.every((value, index) => isTimestamp(value)
        && (index === 0 || value >= state.attemptTimestampsMs[index - 1]))
      || !(state.blockedCredentialIdentity === null
        || /^[a-f0-9]{64}$/.test(state.blockedCredentialIdentity))
      || !(state.inFlight === null || (typeof state.inFlight?.token === 'string'
        && state.inFlight.token.length > 0
        && /^[a-f0-9]{64}$/.test(state.inFlight.credentialIdentity)))) {
      return null;
    }
    if ((state.lastAttemptMs === null) !== (state.attemptTimestampsMs.length === 0)
      || (state.inFlight !== null && state.lastAttemptMs === null)
      || (state.lastAttemptMs !== null && state.lastAttemptMs !== state.attemptTimestampsMs.at(-1))) return null;
    return state;
  } catch {
    return null;
  }
}

function deny(
  reason: SelfHealingInferenceDenialReason,
  state?: InferenceState | null,
  retryAtMs?: number
): Extract<SelfHealingInferenceAdmission, { allowed: false }> {
  return {
    allowed: false, reason,
    lastAttemptAt: state?.lastAttemptMs == null ? null : new Date(state.lastAttemptMs).toISOString(),
    retryAt: retryAtMs === undefined ? null : new Date(retryAtMs).toISOString()
  };
}

/**
 * Diagnosis state is independent of provider probes. A reservation is durable and
 * has no automatic expiry: crash/timeout ambiguity must not permit another paid
 * call while the previous transport may still be alive. Deterministic healing
 * continues; an operator must reconcile an abandoned reservation before reset.
 */
export function createSelfHealingInferenceCoordinator(store: SelfHealingInferenceStore) {
  return {
    async reserve(policy: SelfHealingInferencePolicy): Promise<SelfHealingInferenceAdmission> {
      if (!policy.credential?.trim()) return deny('missing_credential');
      const maxAttempts = policy.maxAttemptsPerHour ?? 2;
      if (![policy.cooldownMs, policy.failureCooldownMs].every(value =>
        Number.isSafeInteger(value) && value >= 60_000 && value <= MAX_COOLDOWN_MS)
        || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 6) {
        return deny('invalid_policy');
      }
      const credentialIdentity = createHash('sha256').update(policy.credential).digest('hex');
      const token = randomUUID();
      try {
        for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
          const { rawState, nowMs } = await store.read();
          const state = parseState(rawState);
          if (!state || !isTimestamp(nowMs)) return deny('invalid_state');
          const latestRecordedMs = Math.max(
            state.lastAttemptMs ?? 0, state.lastFailureMs ?? 0,
            state.lastCompletedMs ?? 0
          );
          if (nowMs < latestRecordedMs) return deny('clock_regression', state);
          if (state.blockedCredentialIdentity === credentialIdentity) {
            return deny('authentication_blocked', state);
          }
          if (state.inFlight) return deny('in_flight', state);
          const retryAtMs = Math.max(
            state.lastAttemptMs === null ? 0 : state.lastAttemptMs + policy.cooldownMs,
            state.lastFailureMs === null ? 0 : state.lastFailureMs + policy.failureCooldownMs
          );
          if (nowMs < retryAtMs) return {
            ...deny('cooldown', state, retryAtMs),
            failureCooldownActive: state.lastFailureMs !== null
              && nowMs < state.lastFailureMs + policy.failureCooldownMs
          };
          const recentAttempts = state.attemptTimestampsMs.filter(timestamp => timestamp > nowMs - HOUR_MS);
          if (recentAttempts.length >= maxAttempts) {
            return deny('budget_exhausted', state, recentAttempts[recentAttempts.length - maxAttempts] + HOUR_MS);
          }
          const next: InferenceState = {
            ...state, lastAttemptMs: Math.max(nowMs, state.lastAttemptMs ?? 0),
            attemptTimestampsMs: [...recentAttempts, nowMs],
            inFlight: { token, credentialIdentity }
          };
          if (await store.compareAndSet(rawState, JSON.stringify(next))) {
            return { allowed: true, reservation: { token, attemptedAt: new Date(next.lastAttemptMs!).toISOString() } };
          }
        }
      } catch {
        // Do not disclose Redis configuration, credentials, or persisted state.
      }
      return deny('coordination_unavailable');
    },

    async complete(
      reservation: SelfHealingInferenceReservation,
      result: { outcome: SelfHealingInferenceOutcome }
    ): Promise<boolean> {
      if (result.outcome === 'uncertain') return false;
      try {
        for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
          const { rawState, nowMs } = await store.read();
          const state = parseState(rawState);
          if (!state || !isTimestamp(nowMs) || state.inFlight?.token !== reservation.token) return false;
          const completedAtMs = Math.max(nowMs, state.lastAttemptMs ?? 0, state.lastCompletedMs ?? 0);
          const next: InferenceState = {
            ...state, inFlight: null, lastCompletedMs: completedAtMs,
            lastFailureMs: result.outcome === 'success'
              ? null : Math.max(completedAtMs, state.lastFailureMs ?? 0),
            blockedCredentialIdentity: result.outcome === 'authentication_failure'
              ? state.inFlight.credentialIdentity : state.blockedCredentialIdentity
          };
          if (await store.compareAndSet(rawState, JSON.stringify(next))) return true;
        }
      } catch {
        // An uncertain write never unlocks the caller's local admission path.
      }
      return false;
    }
  };
}

const READ_STATE_SCRIPT = `
local now = redis.call('TIME')
return {redis.call('EXISTS', KEYS[1]), redis.call('GET', KEYS[1]) or '', now[1], now[2]}
`;
const COMPARE_AND_SET_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if (ARGV[1] == 'absent' and current) or (ARGV[1] == 'present' and current ~= ARGV[2]) then
  return 0
end
redis.call('SET', KEYS[1], ARGV[3])
return 1
`;

function coordinationKey(purpose: 'diagnosis' | 'provider_probe'): string {
  // Exclude service identity: Worker and web runtimes must coordinate together.
  const scope = JSON.stringify([
    getEnv('RAILWAY_PROJECT_ID') ?? 'local',
    getEnv('RAILWAY_ENVIRONMENT_ID') ?? getEnv('RAILWAY_ENVIRONMENT') ?? getEnv('NODE_ENV') ?? 'unknown'
  ]);
  return `arcanos:self-heal:inference:v1:${createHash('sha256').update(scope).digest('hex')}:${purpose}`;
}

function createRedisCoordinator(purpose: 'diagnosis' | 'provider_probe') {
  return createSelfHealingInferenceCoordinator({
    async read() {
      const result = await executeRedisOperation(
        client => client.eval(READ_STATE_SCRIPT, { keys: [coordinationKey(purpose)], arguments: [] }),
        { operation: 'self_heal.inference.reserve' }
      );
      if (!Array.isArray(result) || result.length !== 4
        || (result[0] !== 0 && result[0] !== 1) || typeof result[1] !== 'string') {
        throw new Error('Invalid inference coordination response.');
      }
      return {
        rawState: result[0] === 0 ? null : result[1],
        nowMs: Number(result[2]) * 1000 + Math.floor(Number(result[3]) / 1000)
      };
    },
    async compareAndSet(expected, replacement) {
      const result = await executeRedisOperation(
        client => client.eval(COMPARE_AND_SET_SCRIPT, {
          keys: [coordinationKey(purpose)], arguments: [expected === null ? 'absent' : 'present', expected ?? '', replacement]
        }),
        { operation: 'self_heal.inference.complete' }
      );
      return result === 1;
    }
  });
}

const coordinators = {
  diagnosis: createRedisCoordinator('diagnosis'),
  provider_probe: createRedisCoordinator('provider_probe')
};

export async function reserveSelfHealingInference(policy: SelfHealingInferencePolicy): Promise<SelfHealingInferenceAdmission> {
  const purpose = policy.purpose ?? 'diagnosis';
  const result = await coordinators[purpose].reserve(policy);
  return result.allowed ? { allowed: true, reservation: { ...result.reservation, purpose } } : result;
}

export async function completeSelfHealingInference(
  reservation: SelfHealingInferenceReservation,
  result: { outcome: SelfHealingInferenceOutcome }
): Promise<boolean> {
  return coordinators[reservation.purpose ?? 'diagnosis'].complete(reservation, result);
}
