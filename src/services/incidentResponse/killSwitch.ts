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
import { createClient } from "redis";
import { aiLogger } from "@platform/logging/structuredLogging.js";
import { getConfig } from "@platform/runtime/unifiedConfig.js";
import { getEnv } from "@platform/runtime/env.js";

type RedisClient = ReturnType<typeof createClient>;

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
let redisClientPromise: Promise<RedisClient | null> | null = null;
let redisUnavailableLogged = false;

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
 * Build Redis connection URL from env.
 *
 * Purpose: support both REDIS_URL and discrete Railway-style vars.
 * Inputs/outputs: none -> usable redis URL or null.
 * Edge cases: returns null when host/url is missing or malformed.
 */
function resolveRedisUrl(): string | null {
  const direct = getEnv('REDIS_URL');
  if (direct) {
    try {
      const parsed = new URL(direct);
      if (parsed.protocol === 'redis:' && parsed.hostname) return direct;
    } catch {
      //audit Assumption: malformed REDIS_URL should not crash kill-switch resolution; risk: boot-time failure path; invariant: fallback chain remains available; handling: ignore and continue to discrete env vars.
    }
  }

  const host = getEnv('REDISHOST') || getEnv('REDIS_HOST');
  if (!host) return null;
  const port = getEnv('REDISPORT') || getEnv('REDIS_PORT') || '6379';
  const user = getEnv('REDISUSER') || getEnv('REDIS_USER') || '';
  const pass = getEnv('REDISPASSWORD') || getEnv('REDIS_PASSWORD') || '';
  const auth = user
    ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`
    : pass
      ? `:${encodeURIComponent(pass)}@`
      : '';
  return `redis://${auth}${host}:${port}`;
}

/**
 * Resolve a shared Redis client for multi-instance kill-switch consistency.
 *
 * Purpose: centralize override state in a cluster-safe backend store.
 * Inputs/outputs: none -> connected Redis client or null when unavailable.
 * Edge cases: logs once on connection failure and falls back to local state.
 */
async function getSharedKillSwitchRedisClient(): Promise<RedisClient | null> {
  if (redisClientPromise) return redisClientPromise;

  const redisUrl = resolveRedisUrl();
  if (!redisUrl) return null;

  redisClientPromise = (async () => {
    try {
      const client = createClient({
        url: redisUrl,
        socket: {
          reconnectStrategy: (retries: number) => Math.min(retries * 100, 2000),
          connectTimeout: 3000
        }
      });
      client.on('error', (error) => {
        if (!redisUnavailableLogged) {
          redisUnavailableLogged = true;
          aiLogger.warn('Kill switch Redis client error; using local fallback', {
            module: 'killSwitch',
            error: String(error)
          });
        }
      });
      await client.connect();
      return client;
    } catch (error) {
      if (!redisUnavailableLogged) {
        redisUnavailableLogged = true;
        aiLogger.warn('Kill switch Redis unavailable; using local fallback', {
          module: 'killSwitch',
          error: String(error)
        });
      }
      return null;
    }
  })();

  return redisClientPromise;
}

/**
 * Read shared override state from Redis with short-lived cache.
 *
 * Purpose: provide cross-instance consistency without excessive Redis I/O.
 * Inputs/outputs: none -> shared override state or null.
 * Edge cases: corrupt payloads are ignored with fallback to local overrides.
 */
async function readSharedOverrideState(): Promise<KillSwitchOverrideState | null> {
  const now = Date.now();
  if (cacheOverrideState && (now - cacheUpdatedAt) < CACHE_TTL_MS) {
    return cacheOverrideState;
  }

  const redis = await getSharedKillSwitchRedisClient();
  if (!redis) return null;

  try {
    const raw = await redis.get(KILL_SWITCH_KEY);
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
  } catch (error) {
    //audit Assumption: shared-state parse/read failures should not block emergency controls; risk: stale cross-instance visibility; invariant: local override remains usable; handling: log warning and continue with local state.
    aiLogger.warn('Failed to read shared kill-switch state; using local fallback', {
      module: 'killSwitch',
      error: String(error)
    });
    return null;
  }
}

/**
 * Persist override state to Redis and update local cache.
 *
 * Purpose: keep kill-switch state consistent across instances.
 * Inputs/outputs: override state + reason string; returns when write attempt completes.
 * Edge cases: write failures degrade to local-only override with warning logs.
 */
async function writeSharedOverrideState(state: KillSwitchOverrideState, reason: string): Promise<void> {
  cacheOverrideState = state;
  cacheUpdatedAt = Date.now();

  const redis = await getSharedKillSwitchRedisClient();
  if (!redis) return;

  try {
    await redis.set(KILL_SWITCH_KEY, JSON.stringify(state));
  } catch (error) {
    //audit Assumption: Redis write failures are possible in degraded conditions; risk: inter-instance drift in kill-switch status; invariant: local process still enforces override; handling: warn and keep local override active.
    aiLogger.warn('Failed to persist kill-switch state to Redis; local override retained', {
      module: 'killSwitch',
      error: String(error),
      reason
    });
  }
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
  await writeSharedOverrideState(localOverrideState, reason);
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
  await writeSharedOverrideState(localOverrideState, reason);
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
  await writeSharedOverrideState(localOverrideState, reason);
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
  const frozen = await isSelfImproveFrozen();
  const autonomyLevel = await getEffectiveAutonomyLevel();
  return {
    frozen,
    autonomyLevel,
    overrides: {
      freeze: effective.freeze,
      autonomy: effective.autonomy
    }
  };
}
