/**
 * Incident Response Kill Switches for Self-Improve
 *
 * - Freeze patching / improvements immediately
 * - Force autonomy level down to 0
 *
 * Default state can be controlled via env vars:
 * - SELF_IMPROVE_FREEZE=true|false
 * - SELF_IMPROVE_AUTONOMY_LEVEL=0..3
 */
import { aiLogger } from "@platform/logging/structuredLogging.js";
import { getConfig } from "@platform/runtime/unifiedConfig.js";
import { getEnv } from "@platform/runtime/env.js";
import {
  executeRedisOperation,
  getReadyRedisClient,
  getRedisLifecycleSnapshot,
  type RedisLifecycleClient
} from "@platform/runtime/redisLifecycle.js";

type RedisClient = RedisLifecycleClient;

interface KillSwitchOverrideState {
  freeze: boolean | null;
  autonomy: number | null;
}

const KILL_SWITCH_KEY = getEnv('SELF_IMPROVE_KILL_SWITCH_KEY', 'arcanos:self-improve:kill-switch:v1');
const CACHE_TTL_MS = 1000;

let localOverrideState: KillSwitchOverrideState = {
  freeze: null,
  autonomy: null
};
let cacheOverrideState: KillSwitchOverrideState | null = null;
let cacheUpdatedAt = 0;
let redisUnavailableLogged = false;
let sharedOverrideDirty = false;

/**
 * Clamp autonomy to the supported range.
 *
 * Purpose: enforce hard autonomy bounds for all read/write paths.
 * Inputs/outputs: numeric level -> clamped integer [0,3].
 * Edge cases: NaN and +/-Infinity resolve to 0.
 */
function clampAutonomyLevel(level: number): number {
  if (!Number.isFinite(level)) return 0;
  return Math.max(0, Math.min(3, Math.trunc(level)));
}

/**
 * Resolve the lifecycle-owned Redis client for multi-instance kill-switch consistency.
 *
 * Purpose: reuse the process-wide connection without starting a parallel reconnect loop.
 * Inputs/outputs: none -> ready Redis client or null when unavailable.
 * Edge cases: configured outages log one sanitized warning and fall back immediately.
 */
function getSharedKillSwitchRedisClient(): RedisClient | null {
  const client = getReadyRedisClient();
  if (client) {
    redisUnavailableLogged = false;
    return client;
  }

  const lifecycle = getRedisLifecycleSnapshot();
  if (lifecycle.configured && !redisUnavailableLogged) {
    redisUnavailableLogged = true;
    aiLogger.warn('Kill switch Redis unavailable; using local fallback', {
      module: 'killSwitch',
      errorCode: 'REDIS_DEPENDENCY_UNAVAILABLE'
    });
  }

  return null;
}

/**
 * Read shared override state from Redis with short-lived cache.
 *
 * Purpose: provide cross-instance consistency without excessive Redis I/O.
 * Inputs/outputs: none -> shared override state or null.
 * Edge cases: corrupt payloads are ignored with fallback to local overrides.
 */
async function readSharedOverrideState(): Promise<KillSwitchOverrideState | null> {
  const redis = getSharedKillSwitchRedisClient();
  if (!redis) return null;

  const now = Date.now();
  if (sharedOverrideDirty) {
    await persistSharedOverrideState(localOverrideState, redis);
    cacheOverrideState = localOverrideState;
    cacheUpdatedAt = now;
    return localOverrideState;
  }

  if (cacheOverrideState && (now - cacheUpdatedAt) < CACHE_TTL_MS) {
    return cacheOverrideState;
  }

  try {
    const raw = await executeRedisOperation(
      (readyClient) => readyClient.get(KILL_SWITCH_KEY),
      { client: redis }
    );
    if (!raw) {
      cacheOverrideState = { freeze: null, autonomy: null };
      cacheUpdatedAt = now;
      return cacheOverrideState;
    }
    const parsed = JSON.parse(raw) as Partial<KillSwitchOverrideState>;
    const normalized: KillSwitchOverrideState = {
      freeze: typeof parsed.freeze === 'boolean' ? parsed.freeze : null,
      autonomy: typeof parsed.autonomy === 'number' ? clampAutonomyLevel(parsed.autonomy) : null
    };
    cacheOverrideState = normalized;
    cacheUpdatedAt = now;
    return normalized;
  } catch {
    //audit Assumption: shared-state parse/read failures should not block emergency controls; risk: stale cross-instance visibility; invariant: local override remains usable; handling: log warning and continue with local state.
    aiLogger.warn('Failed to read shared kill-switch state; using local fallback', {
      module: 'killSwitch',
      errorCode: 'REDIS_DEPENDENCY_UNAVAILABLE'
    });
    return null;
  }
}

async function persistSharedOverrideState(
  state: KillSwitchOverrideState,
  redis: RedisClient
): Promise<void> {
  try {
    await executeRedisOperation(
      (readyClient) => readyClient.set(KILL_SWITCH_KEY, JSON.stringify(state)),
      { client: redis }
    );
    if (localOverrideState === state) {
      sharedOverrideDirty = false;
    }
  } catch {
    //audit Assumption: Redis write failures are possible in degraded conditions; risk: inter-instance drift in kill-switch status; invariant: local process still enforces override; handling: warn and keep local override active for lazy reconciliation.
    aiLogger.warn('Failed to persist kill-switch state to Redis; local override retained', {
      module: 'killSwitch',
      errorCode: 'REDIS_DEPENDENCY_UNAVAILABLE'
    });
  }
}

/**
 * Persist override state to Redis and update local cache.
 *
 * Purpose: keep kill-switch state consistent across instances.
 * Inputs/outputs: override state; returns when write attempt completes.
 * Edge cases: write failures degrade to local-only override with warning logs.
 */
async function writeSharedOverrideState(state: KillSwitchOverrideState): Promise<void> {
  cacheOverrideState = state;
  cacheUpdatedAt = Date.now();
  sharedOverrideDirty = true;

  const redis = getSharedKillSwitchRedisClient();
  if (!redis) return;

  await persistSharedOverrideState(state, redis);
}

async function resolveEffectiveOverrides(): Promise<KillSwitchOverrideState> {
  const shared = await readSharedOverrideState();
  if (shared) return shared;
  return localOverrideState;
}

/**
 * Resolve whether self-improve is currently frozen.
 *
 * Purpose: gate autonomous actions using shared kill-switch state.
 * Inputs/outputs: none -> boolean frozen status.
 * Edge cases: shared-state read failures fall back to local override/config.
 */
export async function isSelfImproveFrozen(): Promise<boolean> {
  const overrides = await resolveEffectiveOverrides();
  const cfg = getConfig();
  return overrides.freeze ?? cfg.selfImproveFrozen;
}

/**
 * Resolve effective autonomy from shared override state and config defaults.
 *
 * Purpose: provide a cluster-consistent autonomy level for policy decisions.
 * Inputs/outputs: none -> bounded autonomy level in [0,3].
 * Edge cases: invalid override values are clamped.
 */
export async function getEffectiveAutonomyLevel(): Promise<number> {
  const overrides = await resolveEffectiveOverrides();
  const cfg = getConfig();
  const lvl = overrides.autonomy ?? cfg.selfImproveAutonomyLevel;
  return clampAutonomyLevel(lvl);
}

/**
 * Activate kill switch and force autonomy to 0.
 *
 * Purpose: immediately stop autonomous improvement actions across instances.
 * Inputs/outputs: textual reason -> updates local and shared override state.
 * Edge cases: shared-store failures retain local freeze override.
 */
export async function freezeSelfImprove(reason: string): Promise<void> {
  localOverrideState = { freeze: true, autonomy: 0 };
  await writeSharedOverrideState(localOverrideState);
  aiLogger.error("Self-improve frozen (kill switch)", { module: "killSwitch", reason });
}

/**
 * Lift kill-switch freeze while preserving explicit autonomy override.
 *
 * Purpose: resume self-improve flow after operator intervention.
 * Inputs/outputs: textual reason -> updates local and shared override state.
 * Edge cases: Redis unavailability degrades to local-only state.
 */
export async function unfreezeSelfImprove(reason: string): Promise<void> {
  localOverrideState = { ...localOverrideState, freeze: false };
  await writeSharedOverrideState(localOverrideState);
  aiLogger.warn("Self-improve unfrozen", { module: "killSwitch", reason });
}

/**
 * Set explicit autonomy override level.
 *
 * Purpose: enable emergency autonomy throttling without changing static env config.
 * Inputs/outputs: requested level + reason -> persisted bounded override.
 * Edge cases: non-finite levels are coerced to 0.
 */
export async function setAutonomyLevel(level: number, reason: string): Promise<void> {
  localOverrideState = {
    ...localOverrideState,
    autonomy: clampAutonomyLevel(level)
  };
  await writeSharedOverrideState(localOverrideState);
  aiLogger.warn("Self-improve autonomy override set", { module: "killSwitch", level: localOverrideState.autonomy, reason });
}

/**
 * Return current kill-switch status snapshot.
 *
 * Purpose: expose effective state and active overrides to operators.
 * Inputs/outputs: none -> status object with effective and override fields.
 * Edge cases: falls back to local state when shared store is unavailable.
 */
export async function getKillSwitchStatus() {
  const effective = await resolveEffectiveOverrides();
  const cfg = getConfig();
  const frozen = effective.freeze ?? cfg.selfImproveFrozen;
  const autonomyLevel = clampAutonomyLevel(
    effective.autonomy ?? cfg.selfImproveAutonomyLevel
  );
  return {
    frozen,
    autonomyLevel,
    overrides: {
      freeze: effective.freeze,
      autonomy: effective.autonomy
    }
  };
}
