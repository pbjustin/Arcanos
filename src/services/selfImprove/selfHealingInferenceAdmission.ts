import { createHash, randomUUID } from 'node:crypto';
import { getEnv } from '@platform/runtime/env.js';
import { executeRedisOperation } from '@platform/runtime/redisLifecycle.js';

const HOUR_MS = 3_600_000;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const MAX_COOLDOWN_MS = 30 * 24 * HOUR_MS;
const MAX_TRANSACTION_ATTEMPTS = 4;
const MAX_BLOCKED_CREDENTIAL_IDENTITIES = 32;

export interface SelfHealingInferenceReservation {
  token: string;
  attemptedAt: string;
  purpose?: 'diagnosis' | 'provider_probe';
  coordinationScope?: string;
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
  blockedCredentialIdentities: string[];
  inFlight: { token: string; credentialIdentity: string } | null;
  attemptTimestampsMs: number[];
}

/** Read/CAS bind the purpose ledger and any sibling rejection evidence atomically. */
export interface SelfHealingInferenceStore {
  read(): Promise<{ rawState: string | null; relatedRawState?: string | null; nowMs: number }>;
  compareAndSet(expected: string | null, replacement: string, relatedExpected?: string | null): Promise<boolean>;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= 0 && value <= MAX_TIMESTAMP_MS - MAX_COOLDOWN_MS;
}

function parseState(rawState: string | null): InferenceState | null {
  if (rawState === null) {
    return {
      version: 1, lastAttemptMs: null, lastFailureMs: null, lastCompletedMs: null,
      blockedCredentialIdentity: null, blockedCredentialIdentities: [], inFlight: null, attemptTimestampsMs: []
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
        || (typeof state.blockedCredentialIdentity === 'string' && /^[a-f0-9]{64}$/.test(state.blockedCredentialIdentity)))
      || !(state.inFlight === null || (typeof state.inFlight?.token === 'string'
        && state.inFlight.token.length > 0
        && typeof state.inFlight.credentialIdentity === 'string'
        && /^[a-f0-9]{64}$/.test(state.inFlight.credentialIdentity)))) {
      return null;
    }
    if ((state.lastAttemptMs === null) !== (state.attemptTimestampsMs.length === 0)
      || (state.inFlight !== null && state.lastAttemptMs === null)
      || (state.lastAttemptMs !== null && state.lastAttemptMs !== state.attemptTimestampsMs.at(-1))) return null;
    // Upgrade the legacy single-identity record without forgetting its latch.
    // Saturation closes admission; old rejected identities are never evicted.
    const identities = state.blockedCredentialIdentities === undefined
      ? state.blockedCredentialIdentity === null ? [] : [state.blockedCredentialIdentity]
      : state.blockedCredentialIdentities;
    if (!Array.isArray(identities) || identities.length > MAX_BLOCKED_CREDENTIAL_IDENTITIES
      || !identities.every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))
      || new Set(identities).size !== identities.length
      || (state.blockedCredentialIdentity !== null && !identities.includes(state.blockedCredentialIdentity))) return null;
    state.blockedCredentialIdentities = identities;
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
 * Diagnosis budgets are independent of probes; rejected credentials are shared.
 * A reservation is durable and
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
      const credentialIdentity = createHash('sha256').update(policy.credential.trim()).digest('hex');
      const legacyCredentialIdentity = createHash('sha256').update(policy.credential).digest('hex');
      const token = randomUUID();
      try {
        for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
          const { rawState, relatedRawState, nowMs } = await store.read();
          const state = parseState(rawState);
          const relatedState = relatedRawState === undefined ? null : parseState(relatedRawState);
          if (!state || (relatedRawState !== undefined && !relatedState) || !isTimestamp(nowMs)) return deny('invalid_state');
          const latestRecordedMs = Math.max(
            state.lastAttemptMs ?? 0, state.lastFailureMs ?? 0,
            state.lastCompletedMs ?? 0, relatedState?.lastAttemptMs ?? 0,
            relatedState?.lastFailureMs ?? 0, relatedState?.lastCompletedMs ?? 0
          );
          if (nowMs < latestRecordedMs) return deny('clock_regression', state);
          if ([state, relatedState].some(candidate => candidate && (
            candidate.blockedCredentialIdentities.includes(credentialIdentity)
            || candidate.blockedCredentialIdentities.includes(legacyCredentialIdentity)
            || candidate.blockedCredentialIdentities.length >= MAX_BLOCKED_CREDENTIAL_IDENTITIES))) {
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
          if (await store.compareAndSet(rawState, JSON.stringify(next), relatedRawState)) {
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
          const { rawState, relatedRawState, nowMs } = await store.read();
          const state = parseState(rawState);
          if (!state || !isTimestamp(nowMs) || state.inFlight?.token !== reservation.token) return false;
          const completedAtMs = Math.max(nowMs, state.lastAttemptMs ?? 0, state.lastCompletedMs ?? 0);
          const next: InferenceState = {
            ...state, inFlight: null, lastCompletedMs: completedAtMs,
            lastFailureMs: result.outcome === 'success'
              ? null : Math.max(completedAtMs, state.lastFailureMs ?? 0),
            blockedCredentialIdentity: result.outcome === 'authentication_failure'
              ? state.inFlight.credentialIdentity : state.blockedCredentialIdentity,
            blockedCredentialIdentities: result.outcome === 'authentication_failure'
              ? [...new Set([...state.blockedCredentialIdentities, state.inFlight.credentialIdentity])]
              : state.blockedCredentialIdentities
          };
          if (await store.compareAndSet(rawState, JSON.stringify(next), relatedRawState)) return true;
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
return {redis.call('EXISTS', KEYS[1]), redis.call('GET', KEYS[1]) or '',
  redis.call('EXISTS', KEYS[2]), redis.call('GET', KEYS[2]) or '', now[1], now[2]}
`;
const COMPARE_AND_SET_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if (ARGV[1] == 'absent' and current) or (ARGV[1] == 'present' and current ~= ARGV[2]) then
  return 0
end
local related = redis.call('GET', KEYS[2])
if (ARGV[4] == 'absent' and related) or (ARGV[4] == 'present' and related ~= ARGV[5]) then
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

function createRedisCoordinator(ledgerKey: string, relatedLedgerKey: string) {
  return createSelfHealingInferenceCoordinator({
    async read() {
      const result = await executeRedisOperation(
        client => client.eval(READ_STATE_SCRIPT, { keys: [ledgerKey, relatedLedgerKey], arguments: [] }),
        { operation: 'self_heal.inference.reserve' }
      );
      if (!Array.isArray(result) || result.length !== 6
        || (result[0] !== 0 && result[0] !== 1) || typeof result[1] !== 'string'
        || (result[2] !== 0 && result[2] !== 1) || typeof result[3] !== 'string') {
        throw new Error('Invalid inference coordination response.');
      }
      return {
        rawState: result[0] === 0 ? null : result[1],
        relatedRawState: result[2] === 0 ? null : result[3],
        nowMs: Number(result[4]) * 1000 + Math.floor(Number(result[5]) / 1000)
      };
    },
    async compareAndSet(expected, replacement, relatedExpected) {
      if (relatedExpected === undefined) return false;
      const result = await executeRedisOperation(
        client => client.eval(COMPARE_AND_SET_SCRIPT, {
          keys: [ledgerKey, relatedLedgerKey], arguments: [expected === null ? 'absent' : 'present', expected ?? '', replacement,
            relatedExpected === null ? 'absent' : 'present', relatedExpected ?? '']
        }),
        { operation: 'self_heal.inference.complete' }
      );
      return result === 1;
    }
  });
}

export async function reserveSelfHealingInference(policy: SelfHealingInferencePolicy): Promise<SelfHealingInferenceAdmission> {
  const purpose = policy.purpose ?? 'diagnosis';
  const ledgerKey = coordinationKey(purpose);
  const result = await createRedisCoordinator(ledgerKey, coordinationKey(purpose === 'diagnosis' ? 'provider_probe' : 'diagnosis')).reserve(policy);
  // Scope changes cannot move a read/CAS transaction into a different ledger or
  // authorize a provider call whose reservation belongs to another environment.
  if (coordinationKey(purpose) !== ledgerKey) return deny('coordination_unavailable');
  return result.allowed ? { allowed: true, reservation: { ...result.reservation, purpose, coordinationScope: ledgerKey } } : result;
}

export async function completeSelfHealingInference(
  reservation: SelfHealingInferenceReservation,
  result: { outcome: SelfHealingInferenceOutcome }
): Promise<boolean> {
  const purpose = reservation.purpose ?? 'diagnosis';
  const ledgerKey = coordinationKey(purpose);
  if (reservation.coordinationScope !== ledgerKey) return false;
  return createRedisCoordinator(ledgerKey, coordinationKey(purpose === 'diagnosis' ? 'provider_probe' : 'diagnosis')).complete(reservation, result);
}
