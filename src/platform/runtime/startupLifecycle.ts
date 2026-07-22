/**
 * Process-local web startup lifecycle state.
 *
 * The lifecycle is intentionally independent from dependency clients. Redis and
 * the server bootstrap project their state here so health handlers can answer
 * synchronously without opening new network connections.
 */

export type StartupLifecyclePhase = 'STARTING' | 'DEGRADED' | 'READY';

export type StartupRedisStatus =
  | 'not_started'
  | 'connecting'
  | 'ready'
  | 'unavailable'
  | 'stopped';

export interface StartupRedisSnapshot {
  configured: boolean;
  status: StartupRedisStatus;
  attempt: number;
  lastErrorCode: string | null;
}

export interface StartupLifecycleSnapshot {
  phase: StartupLifecyclePhase;
  ready: boolean;
  listenerBound: boolean;
  runtimeInitialized: boolean;
  runtimeErrorCode: string | null;
  shuttingDown: boolean;
  redis: StartupRedisSnapshot;
  changedAt: string;
}

export interface StartupRedisLifecycleUpdate {
  configured: boolean;
  status: StartupRedisStatus;
  attempt?: number;
  lastErrorCode?: string | null;
}

type StartupLifecycleListener = (snapshot: StartupLifecycleSnapshot) => void;

interface MutableStartupLifecycleState {
  listenerBound: boolean;
  runtimeInitialized: boolean;
  runtimeErrorCode: string | null;
  shuttingDown: boolean;
  redis: StartupRedisSnapshot;
  changedAt: string;
}

function createInitialState(): MutableStartupLifecycleState {
  return {
    listenerBound: false,
    runtimeInitialized: false,
    runtimeErrorCode: null,
    shuttingDown: false,
    redis: {
      configured: false,
      status: 'not_started',
      attempt: 0,
      lastErrorCode: null,
    },
    changedAt: new Date().toISOString(),
  };
}

let state = createInitialState();
const listeners = new Set<StartupLifecycleListener>();

function derivePhase(current: MutableStartupLifecycleState): StartupLifecyclePhase {
  if (
    current.shuttingDown
    || current.runtimeErrorCode !== null
    || (
      current.redis.status === 'unavailable'
      || current.redis.status === 'stopped'
    )
  ) {
    return 'DEGRADED';
  }

  if (
    !current.listenerBound
    || !current.runtimeInitialized
    || current.redis.status !== 'ready'
  ) {
    return 'STARTING';
  }

  return 'READY';
}

function snapshotState(): StartupLifecycleSnapshot {
  const phase = derivePhase(state);
  return {
    phase,
    ready: phase === 'READY',
    listenerBound: state.listenerBound,
    runtimeInitialized: state.runtimeInitialized,
    runtimeErrorCode: state.runtimeErrorCode,
    shuttingDown: state.shuttingDown,
    redis: { ...state.redis },
    changedAt: state.changedAt,
  };
}

function publish(): StartupLifecycleSnapshot {
  state.changedAt = new Date().toISOString();
  const snapshot = snapshotState();
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch {
      // Observers must never alter process startup.
    }
  }
  return snapshot;
}

export function getStartupLifecycleSnapshot(): StartupLifecycleSnapshot {
  return snapshotState();
}

export function subscribeStartupLifecycle(listener: StartupLifecycleListener): () => void {
  listeners.add(listener);
  listener(snapshotState());
  return () => {
    listeners.delete(listener);
  };
}

export function markStartupListenerBound(): StartupLifecycleSnapshot {
  if (!state.shuttingDown) {
    state.listenerBound = true;
  }
  return publish();
}

export function markStartupRuntimeInitializing(): StartupLifecycleSnapshot {
  if (!state.shuttingDown) {
    state.runtimeInitialized = false;
    state.runtimeErrorCode = null;
  }
  return publish();
}

export function markStartupRuntimeInitialized(): StartupLifecycleSnapshot {
  if (!state.shuttingDown) {
    state.runtimeInitialized = true;
    state.runtimeErrorCode = null;
  }
  return publish();
}

export function markStartupRuntimeFailed(
  errorCode = 'RUNTIME_INITIALIZATION_FAILED'
): StartupLifecycleSnapshot {
  if (!state.shuttingDown) {
    state.runtimeInitialized = false;
    state.runtimeErrorCode = errorCode;
  }
  return publish();
}

export function updateStartupRedisLifecycle(
  redis: StartupRedisLifecycleUpdate
): StartupLifecycleSnapshot {
  if (state.shuttingDown) {
    return snapshotState();
  }

  state.redis = {
    configured: redis.configured,
    status: redis.status,
    attempt: Math.max(0, Math.trunc(redis.attempt ?? state.redis.attempt)),
    lastErrorCode: redis.lastErrorCode ?? null,
  };
  return publish();
}

export function markStartupShutdown(): StartupLifecycleSnapshot {
  if (!state.shuttingDown) {
    state.shuttingDown = true;
    if (state.redis.configured) {
      state.redis.status = 'stopped';
    }
  }
  return publish();
}

export function resetStartupLifecycleForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    return;
  }
  state = createInitialState();
  listeners.clear();
}
