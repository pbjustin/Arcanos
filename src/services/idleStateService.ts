import { createIdleManager, IdleManager } from '../utils/idleManager.js';
import { updateState } from './stateManager.js';
import { logger } from '../utils/structuredLogging.js';

const idleStateLogger = logger.child({ module: 'idle-state-service' });

const DEFAULTS = {
  IDLE_CHECK_INTERVAL_MS: parseInt(process.env.IDLE_CHECK_INTERVAL_MS || '5000', 10)
};

export interface IdleStateService {
  /**
   * Record a user ping to prevent idle transitions and refresh activity.
   * Inputs: optional metadata to include with the traffic note.
   * Outputs: none (side effects: state tracking + audit logging).
   * Edge cases: ignored when service is stopped or idle manager is unavailable.
   */
  noteUserPing: (meta?: Record<string, unknown>) => void;
  /**
   * Start periodic idle checks that update system state when transitions occur.
   * Inputs: none.
   * Outputs: none (side effects: timer creation + state updates).
   * Edge cases: repeated calls are ignored if monitoring is already active.
   */
  startMonitoring: () => void;
  /**
   * Stop idle monitoring and release idle manager resources.
   * Inputs: none.
   * Outputs: none (side effects: timer cleanup + cache cleanup).
   * Edge cases: repeated calls are ignored if monitoring is already stopped.
   */
  stopMonitoring: () => void;
  /**
   * Get the last known idle state snapshot for diagnostics.
   * Inputs: none.
   * Outputs: snapshot with status and timestamps.
   * Edge cases: last user ping may be null before any pings.
   */
  getSnapshot: () => IdleStateSnapshot;
}

export interface IdleStateSnapshot {
  status: 'idle' | 'running';
  lastUserPingAt: string | null;
  lastEvaluatedAt: string | null;
}

interface IdleStateServiceDependencies {
  idleManager?: IdleManager;
  stateUpdater?: typeof updateState;
}

/**
 * Create a service that marks the system idle after the last user ping.
 * Inputs: optional dependency overrides for idle manager and state updates.
 * Outputs: an idle state service with start/stop and ping tracking.
 * Edge cases: missing dependencies fall back to defaults.
 */
export function createIdleStateService({
  idleManager = createIdleManager({
    log: (message: string, metadata?: Record<string, unknown>) => {
      //audit Assumption: structured logger accepts message + metadata; risk: metadata mismatch; invariant: audit logs are captured; handling: forward as info-level log.
      idleStateLogger.info(message, metadata);
    }
  }),
  stateUpdater = updateState
}: IdleStateServiceDependencies = {}): IdleStateService {
  let monitoringInterval: NodeJS.Timeout | null = null;
  let currentStatus: IdleStateSnapshot['status'] = 'running';
  let lastUserPingAt: string | null = null;
  let lastEvaluatedAt: string | null = null;

  function updateStatus(nextStatus: IdleStateSnapshot['status'], reason: string): void {
    //audit Assumption: status updates should only occur on transitions; risk: redundant writes; invariant: state file reflects latest transition; handling: skip unchanged status.
    if (currentStatus === nextStatus) {
      return;
    }

    currentStatus = nextStatus;
    //audit Assumption: state updater may throw; risk: stale status persisted; invariant: errors are logged; handling: log and continue without crashing.
    try {
      stateUpdater({
        status: nextStatus,
        lastUserPingAt,
        idleReason: reason
      });
    } catch (error) {
      idleStateLogger.error('Failed to update idle state', {
        error: (error as Error).message || 'Unknown error',
        status: nextStatus,
        reason
      });
    }
  }

  function noteUserPing(meta: Record<string, unknown> = {}): void {
    lastUserPingAt = new Date().toISOString();
    //audit Assumption: user ping indicates activity; risk: misclassification; invariant: activity should prevent idle; handling: refresh status to running.
    idleManager.noteTraffic({ ...meta, source: 'user_ping' });
    updateStatus('running', 'user_ping');
  }

  function startMonitoring(): void {
    //audit Assumption: single interval is sufficient; risk: duplicate timers; invariant: only one timer runs; handling: skip if already running.
    if (monitoringInterval) {
      return;
    }

    monitoringInterval = setInterval(() => {
      lastEvaluatedAt = new Date().toISOString();
      const idle = idleManager.isIdle();
      //audit Assumption: idle evaluation should not override active user state unless idle is true; risk: premature idle; invariant: idle true implies transition allowed; handling: update based on idle flag.
      if (idle) {
        updateStatus('idle', 'idle_check');
      } else {
        updateStatus('running', 'idle_check');
      }
    }, DEFAULTS.IDLE_CHECK_INTERVAL_MS);
  }

  function stopMonitoring(): void {
    //audit Assumption: clearing interval is safe; risk: double-clear; invariant: interval cleared once; handling: guard on null.
    if (monitoringInterval) {
      clearInterval(monitoringInterval);
      monitoringInterval = null;
    }
    idleManager.destroy();
  }

  function getSnapshot(): IdleStateSnapshot {
    return {
      status: currentStatus,
      lastUserPingAt,
      lastEvaluatedAt
    };
  }

  return {
    noteUserPing,
    startMonitoring,
    stopMonitoring,
    getSnapshot
  };
}
