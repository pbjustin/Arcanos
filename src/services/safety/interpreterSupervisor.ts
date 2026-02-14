import { config } from '@platform/runtime/config.js';
import { emitSafetyAuditEvent } from './auditEvents.js';
import {
  activateUnsafeCondition,
  getActiveQuarantines,
  incrementHeartbeatMiss,
  incrementHealthyCycle,
  incrementWorkerFailure,
  registerQuarantine,
  releaseQuarantine,
  resetFailureSignals,
  type QuarantineKind
} from './runtimeState.js';
import { createVersionId, getMonotonicTimestampMs } from './monotonicClock.js';

type SupervisorCategory = 'worker' | 'policy' | 'interpreter';

interface InterpreterCycleRecord {
  cycleId: string;
  entityId: string;
  category: SupervisorCategory;
  startedAtMs: number;
  lastHeartbeatMs: number;
  timer?: NodeJS.Timeout;
}

interface CycleOptions {
  category?: SupervisorCategory;
  metadata?: Record<string, unknown>;
}

interface InterpreterSupervisor {
  beginCycle: (entityId: string, options?: CycleOptions) => string;
  heartbeat: (cycleId: string) => boolean;
  completeCycle: (cycleId: string) => boolean;
  failCycle: (cycleId: string, reason?: string) => boolean;
  runSupervisedCycle: <T>(
    entityId: string,
    work: (heartbeat: () => void) => Promise<T>,
    options?: CycleOptions
  ) => Promise<T>;
}

function toQuarantineKind(category: SupervisorCategory): QuarantineKind {
  return category === 'worker' ? 'worker' : category === 'policy' ? 'policy' : 'generic';
}

/**
 * Purpose: Build interpreter/worker heartbeat supervision service.
 * Inputs/Outputs: Optional dependency overrides via config; returns supervisor API.
 * Edge cases: Missed heartbeat escalates unsafe conditions and quarantine.
 */
export function createInterpreterSupervisor(): InterpreterSupervisor {
  const activeCycles = new Map<string, InterpreterCycleRecord>();

  const heartbeatTimeoutMs = config.safety.heartbeatTimeoutMs;
  const heartbeatMissThreshold = config.safety.heartbeatMissThreshold;
  const healthyCyclesToRecover = config.safety.healthyCyclesToRecover;
  const quarantineCooldownMs = config.safety.quarantineCooldownMs;
  const workerRestartThreshold = config.safety.workerRestartThreshold;
  const workerRestartWindowMs = config.safety.workerRestartWindowMs;

  const clearCycleTimer = (cycle: InterpreterCycleRecord): void => {
    if (cycle.timer) {
      clearTimeout(cycle.timer);
      cycle.timer = undefined;
    }
  };

  const removeCycle = (cycle: InterpreterCycleRecord): void => {
    clearCycleTimer(cycle);
    activeCycles.delete(cycle.cycleId);
  };

  const tryAutoRecover = (entityId: string): void => {
    const healthyCount = incrementHealthyCycle(entityId);
    //audit Assumption: healthy cycles must reach configured threshold before auto recovery; failure risk: premature unquarantine; expected invariant: recovery threshold enforced; handling strategy: no-op until threshold met.
    if (healthyCount < healthyCyclesToRecover) {
      return;
    }

    const nowMs = getMonotonicTimestampMs();
    const candidates = getActiveQuarantines().filter(record => {
      if (record.integrityFailure) {
        return false;
      }
      if (record.autoRecoverable === false) {
        return false;
      }
      const metadataEntity = typeof record.metadata?.entityId === 'string' ? record.metadata.entityId : undefined;
      if (metadataEntity !== entityId) {
        return false;
      }
      //audit Assumption: cooldown window prevents quarantine flapping; failure risk: repeated release/re-quarantine loops; expected invariant: cooldown elapsed before release; handling strategy: require now >= cooldown timestamp.
      if (record.cooldownUntilMs && nowMs < record.cooldownUntilMs) {
        return false;
      }
      return true;
    });

    if (candidates.length === 0) {
      return;
    }

    for (const quarantine of candidates) {
      releaseQuarantine(quarantine.quarantineId, {
        actor: 'interpreter-supervisor:auto-recovery',
        releaseNote: 'Recovered after healthy heartbeat cycles',
        integrityOnly: false
      });
      emitSafetyAuditEvent({
        event: 'interpreter_auto_recovery',
        severity: 'info',
        details: {
          entityId,
          quarantineId: quarantine.quarantineId,
          healthyCount
        }
      });
    }

    resetFailureSignals(entityId);
  };

  const handleMissedHeartbeat = (cycleId: string): void => {
    const cycle = activeCycles.get(cycleId);
    if (!cycle) {
      return;
    }

    const heartbeatResult = incrementHeartbeatMiss(cycle.entityId, heartbeatMissThreshold);
    const failureResult = incrementWorkerFailure(
      cycle.entityId,
      workerRestartThreshold,
      workerRestartWindowMs
    );

    emitSafetyAuditEvent({
      event: 'interpreter_heartbeat_missed',
      severity: 'warn',
      details: {
        cycleId,
        entityId: cycle.entityId,
        category: cycle.category,
        heartbeatMissCount: heartbeatResult.count,
        workerFailureCount: failureResult.count
      }
    });

    const quarantine = registerQuarantine({
      kind: toQuarantineKind(cycle.category),
      reason: `Missed heartbeat for ${cycle.entityId}`,
      integrityFailure: false,
      autoRecoverable: true,
      cooldownMs: quarantineCooldownMs,
      dedupeKey: `heartbeat:${cycle.entityId}:${cycle.category}`,
      metadata: {
        entityId: cycle.entityId,
        category: cycle.category,
        cycleId
      }
    });

    activateUnsafeCondition({
      code: 'INTERPRETER_HEARTBEAT_LOSS',
      message: `Heartbeat lost for ${cycle.entityId}`,
      quarantineId: quarantine.quarantineId,
      metadata: {
        entityId: cycle.entityId,
        category: cycle.category
      }
    });

    //audit Assumption: repeated failures inside restart window should hard-block execution; failure risk: endless restart loop with duplicate workers; expected invariant: threshold breach activates unsafe restart condition; handling strategy: activate explicit WORKER_RESTART_THRESHOLD condition.
    if (failureResult.exceeded) {
      activateUnsafeCondition({
        code: 'WORKER_RESTART_THRESHOLD',
        message: `Restart threshold exceeded for ${cycle.entityId}`,
        quarantineId: quarantine.quarantineId,
        metadata: {
          entityId: cycle.entityId,
          count: failureResult.count,
          threshold: workerRestartThreshold
        }
      });
    }

    removeCycle(cycle);
  };

  const scheduleHeartbeatTimeout = (cycle: InterpreterCycleRecord): void => {
    clearCycleTimer(cycle);
    cycle.timer = setTimeout(() => {
      handleMissedHeartbeat(cycle.cycleId);
    }, heartbeatTimeoutMs);
  };

  const beginCycle = (entityId: string, options: CycleOptions = {}): string => {
    const nowMs = getMonotonicTimestampMs();
    const cycleId = createVersionId('heartbeat-cycle');
    const cycle: InterpreterCycleRecord = {
      cycleId,
      entityId,
      category: options.category || 'interpreter',
      startedAtMs: nowMs,
      lastHeartbeatMs: nowMs
    };

    activeCycles.set(cycleId, cycle);
    scheduleHeartbeatTimeout(cycle);

    emitSafetyAuditEvent({
      event: 'interpreter_cycle_started',
      severity: 'info',
      details: {
        cycleId,
        entityId,
        category: cycle.category,
        metadata: options.metadata
      }
    });

    return cycleId;
  };

  const heartbeat = (cycleId: string): boolean => {
    const cycle = activeCycles.get(cycleId);
    //audit Assumption: heartbeats for completed/missing cycles should be ignored; failure risk: reviving stale cycles; expected invariant: only active cycle receives heartbeat; handling strategy: return false on missing cycle.
    if (!cycle) {
      return false;
    }

    cycle.lastHeartbeatMs = getMonotonicTimestampMs();
    scheduleHeartbeatTimeout(cycle);
    return true;
  };

  const completeCycle = (cycleId: string): boolean => {
    const cycle = activeCycles.get(cycleId);
    if (!cycle) {
      return false;
    }

    removeCycle(cycle);
    tryAutoRecover(cycle.entityId);
    emitSafetyAuditEvent({
      event: 'interpreter_cycle_completed',
      severity: 'info',
      details: {
        cycleId,
        entityId: cycle.entityId,
        category: cycle.category,
        durationMs: Math.max(0, getMonotonicTimestampMs() - cycle.startedAtMs)
      }
    });
    return true;
  };

  const failCycle = (cycleId: string, reason?: string): boolean => {
    const cycle = activeCycles.get(cycleId);
    if (!cycle) {
      return false;
    }

    removeCycle(cycle);
    const failureResult = incrementWorkerFailure(
      cycle.entityId,
      workerRestartThreshold,
      workerRestartWindowMs
    );
    emitSafetyAuditEvent({
      event: 'interpreter_cycle_failed',
      severity: 'warn',
      details: {
        cycleId,
        entityId: cycle.entityId,
        category: cycle.category,
        reason,
        failureCount: failureResult.count
      }
    });
    return true;
  };

  const runSupervisedCycle = async <T>(
    entityId: string,
    work: (heartbeatRunner: () => void) => Promise<T>,
    options: CycleOptions = {}
  ): Promise<T> => {
    const cycleId = beginCycle(entityId, options);
    const heartbeatRunner = (): void => {
      heartbeat(cycleId);
    };

    try {
      heartbeatRunner();
      const result = await work(heartbeatRunner);
      heartbeatRunner();
      completeCycle(cycleId);
      return result;
    } catch (error) {
      failCycle(cycleId, error instanceof Error ? error.message : String(error));
      throw error;
    }
  };

  return {
    beginCycle,
    heartbeat,
    completeCycle,
    failCycle,
    runSupervisedCycle
  };
}

export const interpreterSupervisor = createInterpreterSupervisor();
