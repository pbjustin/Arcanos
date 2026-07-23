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
  getRedisLifecycleSnapshot
} from "@platform/runtime/redisLifecycle.js";
import { DependencyUnavailableError } from "@platform/runtime/dependencyLifecycle.js";

interface KillSwitchOverrideState {
  freeze: boolean | null;
  autonomy: number | null;
}

const KILL_SWITCH_KEY = getEnv('SELF_IMPROVE_KILL_SWITCH_KEY', 'arcanos:self-improve:kill-switch:v1');
const KILL_SWITCH_CONFLICT = '__ARCANOS_KILL_SWITCH_CONFLICT__';
const ATOMIC_KILL_SWITCH_MUTATION_SCRIPT = `
  local raw = redis.call("GET", KEYS[1])
  local current = { freeze = cjson.null, autonomy = cjson.null }
  local freeze_token = "null"
  local autonomy_token = "null"
  if raw then
    local ok, decoded = pcall(cjson.decode, raw)
    if not ok or type(decoded) ~= "table" then
      return "${KILL_SWITCH_CONFLICT}"
    end
    if type(decoded.freeze) == "boolean" then
      current.freeze = decoded.freeze
      freeze_token = decoded.freeze and "true" or "false"
    end
    if type(decoded.autonomy) == "number" then
      current.autonomy = math.max(0, math.min(3, math.floor(decoded.autonomy)))
      autonomy_token = tostring(current.autonomy)
    end
  end

  if ARGV[4] ~= "*" and (
    freeze_token ~= ARGV[4] or autonomy_token ~= ARGV[5]
  ) then
    return "${KILL_SWITCH_CONFLICT}"
  end

  if ARGV[1] == "restrictive" then
    if ARGV[3] == "1" then
      current.freeze = true
    end
    if ARGV[2] ~= "" then
      local requested = tonumber(ARGV[2])
      if type(current.autonomy) == "number" then
        current.autonomy = math.min(current.autonomy, requested)
      else
        current.autonomy = requested
      end
    end
  elseif ARGV[1] == "unfreeze" then
    current.freeze = false
  elseif ARGV[1] == "autonomy_relax" then
    current.autonomy = tonumber(ARGV[2])
  else
    return "${KILL_SWITCH_CONFLICT}"
  end

  local encoded = cjson.encode(current)
  redis.call("SET", KEYS[1], encoded)
  return encoded
`;

let localOverrideState: KillSwitchOverrideState = {
  freeze: null,
  autonomy: null
};
let redisUnavailableLogged = false;
let sharedOverrideDirtyVersion: number | null = null;
let overrideMutationVersion = 0;
let overrideMutationTail: Promise<void> = Promise.resolve();

function enqueueOverrideTask<T>(task: () => Promise<T>): Promise<T> {
  const result = overrideMutationTail.then(task, task);
  overrideMutationTail = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

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

function normalizeOverrideState(value: unknown): KillSwitchOverrideState | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const candidate = value as Partial<KillSwitchOverrideState>;
  return {
    freeze: typeof candidate.freeze === 'boolean' ? candidate.freeze : null,
    autonomy: typeof candidate.autonomy === 'number'
      ? clampAutonomyLevel(candidate.autonomy)
      : null
  };
}

function createKillSwitchDependencyUnavailableError(): DependencyUnavailableError {
  return new DependencyUnavailableError(
    'redis',
    'REDIS_DEPENDENCY_UNAVAILABLE',
    'Redis dependency is unavailable.'
  );
}

function stateToken(value: boolean | number | null): string {
  return value === null ? 'null' : String(value);
}

async function mutateSharedOverrideState(
  mode: 'restrictive' | 'unfreeze' | 'autonomy_relax',
  input: {
    autonomy?: number | null;
    freeze?: boolean | null;
    expected?: KillSwitchOverrideState;
  },
  operation: 'incident.kill_switch.write_restrictive' | 'incident.kill_switch.write_relaxing'
): Promise<KillSwitchOverrideState> {
  const result = await executeRedisOperation(
    (readyClient) => readyClient.eval(ATOMIC_KILL_SWITCH_MUTATION_SCRIPT, {
      keys: [KILL_SWITCH_KEY],
      arguments: [
        mode,
        typeof input.autonomy === 'number' ? String(clampAutonomyLevel(input.autonomy)) : '',
        input.freeze === true ? '1' : '0',
        input.expected ? stateToken(input.expected.freeze) : '*',
        input.expected ? stateToken(input.expected.autonomy) : '*'
      ]
    }),
    { operation }
  );
  if (result === KILL_SWITCH_CONFLICT || typeof result !== 'string') {
    throw createKillSwitchDependencyUnavailableError();
  }
  try {
    const normalized = normalizeOverrideState(JSON.parse(result));
    if (normalized) {
      return normalized;
    }
  } catch {
    // A malformed shared safety response must fail closed.
  }
  throw createKillSwitchDependencyUnavailableError();
}

/**
 * Report configured Redis availability for multi-instance kill-switch consistency.
 *
 * Purpose: reuse the process-wide connection without starting a parallel reconnect loop.
 * Inputs/outputs: none -> whether the configured shared dependency is ready.
 * Edge cases: configured outages log one sanitized warning and remain fail-closed.
 */
function isSharedKillSwitchRedisReady(): boolean {
  const lifecycle = getRedisLifecycleSnapshot();
  if (!lifecycle.configured) {
    return false;
  }
  if (lifecycle.state === 'READY' && lifecycle.connected) {
    redisUnavailableLogged = false;
    return true;
  }

  if (!redisUnavailableLogged) {
    redisUnavailableLogged = true;
    aiLogger.warn('Kill switch Redis unavailable; enforcing restrictive fallback', {
      module: 'killSwitch',
      errorCode: 'REDIS_DEPENDENCY_UNAVAILABLE'
    });
  }

  return false;
}

/**
 * Read the authoritative shared override state.
 *
 * Purpose: prevent a stale replica cache from weakening safety state.
 * Inputs/outputs: none -> shared override state or null.
 * Edge cases: corrupt or unavailable shared state fails closed.
 */
async function readSharedOverrideState(): Promise<KillSwitchOverrideState | null> {
  const lifecycle = getRedisLifecycleSnapshot();
  if (!lifecycle.configured || !isSharedKillSwitchRedisReady()) return null;

  const observedMutationVersion = overrideMutationVersion;
  if (sharedOverrideDirtyVersion !== null) {
    const dirtyVersion = sharedOverrideDirtyVersion;
    const dirtyState = { ...localOverrideState };
    try {
      const persistedState = await mutateSharedOverrideState(
        'restrictive',
        {
          freeze: dirtyState.freeze,
          autonomy: dirtyState.autonomy
        },
        'incident.kill_switch.write_restrictive'
      );
      if (sharedOverrideDirtyVersion === dirtyVersion) {
        sharedOverrideDirtyVersion = null;
        localOverrideState = persistedState;
      }
      if (overrideMutationVersion !== observedMutationVersion) {
        return null;
      }
      return persistedState;
    } catch {
      aiLogger.warn('Failed to reconcile restrictive kill-switch state; restriction retained', {
        module: 'killSwitch',
        errorCode: 'REDIS_DEPENDENCY_UNAVAILABLE'
      });
      return null;
    }
  }

  try {
    const raw = await executeRedisOperation(
      (readyClient) => readyClient.get(KILL_SWITCH_KEY),
      { operation: 'incident.kill_switch.read' }
    );
    if (overrideMutationVersion !== observedMutationVersion) {
      return null;
    }
    if (!raw) {
      return { freeze: null, autonomy: null };
    }
    return normalizeOverrideState(JSON.parse(raw));
  } catch {
    //audit Assumption: shared-state parse/read failures must not relax emergency controls; risk: stale cross-instance visibility; invariant: configured Redis failures resolve to the restrictive state; handling: log a sanitized warning and let the effective-state resolver fail closed.
    aiLogger.warn('Failed to read shared kill-switch state; enforcing restrictive fallback', {
      module: 'killSwitch',
      errorCode: 'REDIS_DEPENDENCY_UNAVAILABLE'
    });
    return null;
  }
}

/**
 * Apply a restrictive state locally first, then reconcile it to Redis.
 *
 * Purpose: keep kill-switch state consistent across instances.
 * Inputs/outputs: override state; returns after one bounded write attempt.
 * Edge cases: write failures retain the restrictive local state for recovery.
 */
function applyRestrictiveOverrideState(
  state: KillSwitchOverrideState,
  mutationVersion: number
): void {
  localOverrideState = state;
  sharedOverrideDirtyVersion = getRedisLifecycleSnapshot().configured
    ? mutationVersion
    : null;
}

async function persistRestrictiveOverrideState(
  state: KillSwitchOverrideState,
  mutationVersion: number
): Promise<void> {
  if (!getRedisLifecycleSnapshot().configured) {
    if (sharedOverrideDirtyVersion === mutationVersion) {
      sharedOverrideDirtyVersion = null;
    }
    return;
  }

  const persistedState = await mutateSharedOverrideState(
    'restrictive',
    {
      freeze: state.freeze,
      autonomy: state.autonomy
    },
    'incident.kill_switch.write_restrictive'
  );
  if (sharedOverrideDirtyVersion === mutationVersion) {
    sharedOverrideDirtyVersion = null;
    if (mutationVersion === overrideMutationVersion) {
      localOverrideState = persistedState;
    }
  }
}

async function persistRestrictiveOverrideStateSafely(
  state: KillSwitchOverrideState,
  mutationVersion: number
): Promise<void> {
  try {
    await persistRestrictiveOverrideState(
      state,
      mutationVersion
    );
  } catch {
    aiLogger.warn('Failed to persist restrictive kill-switch state; local restriction retained', {
      module: 'killSwitch',
      errorCode: 'REDIS_DEPENDENCY_UNAVAILABLE'
    });
  }
}

function writeRestrictiveOverrideState(state: KillSwitchOverrideState): Promise<void> {
  const mutationVersion = ++overrideMutationVersion;
  applyRestrictiveOverrideState(state, mutationVersion);
  return enqueueOverrideTask(async () => {
    if (mutationVersion !== overrideMutationVersion) {
      return;
    }
    await persistRestrictiveOverrideStateSafely(state, mutationVersion);
  });
}

/**
 * Atomically persist a relaxing mutation against one authoritative shared read.
 */
function writeRelaxingOverrideState(
  mode: 'unfreeze' | 'autonomy_relax',
  autonomy?: number
): Promise<boolean> {
  const mutationVersion = ++overrideMutationVersion;
  return enqueueOverrideTask(async () => {
    if (mutationVersion !== overrideMutationVersion) {
      return false;
    }
    const lifecycle = getRedisLifecycleSnapshot();
    const effectiveState = lifecycle.configured
      ? await readSharedOverrideState()
      : localOverrideState;
    if (
      mutationVersion !== overrideMutationVersion
      || (lifecycle.configured && !effectiveState)
    ) {
      if (mutationVersion !== overrideMutationVersion) {
        return false;
      }
      throw createKillSwitchDependencyUnavailableError();
    }
    if (!effectiveState) {
      throw createKillSwitchDependencyUnavailableError();
    }
    const state = lifecycle.configured
      ? await mutateSharedOverrideState(
          mode,
          {
            autonomy,
            expected: effectiveState
          },
          'incident.kill_switch.write_relaxing'
        )
      : {
          ...effectiveState,
          ...(mode === 'unfreeze'
            ? { freeze: false }
            : { autonomy: clampAutonomyLevel(autonomy ?? 0) })
        };
    if (mutationVersion !== overrideMutationVersion) {
      return false;
    }
    localOverrideState = state;
    sharedOverrideDirtyVersion = null;
    return true;
  });
}

async function resolveEffectiveOverridesDirect(): Promise<KillSwitchOverrideState> {
  const lifecycle = getRedisLifecycleSnapshot();
  const shared = await readSharedOverrideState();
  if (shared) return shared;
  if (lifecycle.configured) {
    return { freeze: true, autonomy: 0 };
  }
  return localOverrideState;
}

function resolveEffectiveOverrides(): Promise<KillSwitchOverrideState> {
  return enqueueOverrideTask(resolveEffectiveOverridesDirect);
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
  const persistence = writeRestrictiveOverrideState({ freeze: true, autonomy: 0 });
  aiLogger.error("Self-improve frozen (kill switch)", { module: "killSwitch", reason });
  await persistence;
}

/**
 * Lift kill-switch freeze while preserving explicit autonomy override.
 *
 * Purpose: resume self-improve flow after operator intervention.
 * Inputs/outputs: textual reason -> updates local and shared override state.
 * Edge cases: configured Redis unavailability or a concurrent state change rejects relaxation.
 */
export async function unfreezeSelfImprove(reason: string): Promise<void> {
  const applied = await writeRelaxingOverrideState('unfreeze');
  if (applied) {
    aiLogger.warn("Self-improve unfrozen", { module: "killSwitch", reason });
  }
}

/**
 * Set explicit autonomy override level.
 *
 * Purpose: enable emergency autonomy throttling without changing static env config.
 * Inputs/outputs: requested level + reason -> persisted bounded override.
 * Edge cases: non-finite levels are coerced to 0.
 */
export async function setAutonomyLevel(level: number, reason: string): Promise<void> {
  const nextLevel = clampAutonomyLevel(level);
  const mutationVersion = ++overrideMutationVersion;
  const applied = await enqueueOverrideTask(async () => {
    if (mutationVersion !== overrideMutationVersion) {
      return false;
    }
    const effectiveOverrides = await resolveEffectiveOverridesDirect();
    if (mutationVersion !== overrideMutationVersion) {
      return false;
    }
    const cfg = getConfig();
    const currentLevel = clampAutonomyLevel(
      effectiveOverrides.autonomy ?? cfg.selfImproveAutonomyLevel
    );
    const nextState = {
      ...effectiveOverrides,
      autonomy: nextLevel
    };
    if (nextLevel <= currentLevel) {
      applyRestrictiveOverrideState(nextState, mutationVersion);
      await persistRestrictiveOverrideStateSafely(nextState, mutationVersion);
      return mutationVersion === overrideMutationVersion;
    }
    const persistedState = getRedisLifecycleSnapshot().configured
      ? await mutateSharedOverrideState(
          'autonomy_relax',
          {
            autonomy: nextLevel,
            expected: effectiveOverrides
          },
          'incident.kill_switch.write_relaxing'
        )
      : nextState;
    if (mutationVersion !== overrideMutationVersion) {
      return false;
    }
    localOverrideState = persistedState;
    sharedOverrideDirtyVersion = null;
    return true;
  });
  if (applied) {
    aiLogger.warn("Self-improve autonomy override set", {
      module: "killSwitch",
      level: nextLevel,
      reason
    });
  }
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
