import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import config from '../src/config/index.js';
import { createInterpreterSupervisor } from '../src/services/safety/interpreterSupervisor.js';
import {
  getActiveQuarantines,
  getActiveUnsafeConditions,
  resetSafetyRuntimeStateForTests
} from '../src/services/safety/runtimeState.js';

describe('interpreter supervisor safety escalation', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    resetSafetyRuntimeStateForTests();
  });

  afterEach(() => {
    jest.useRealTimers();
    resetSafetyRuntimeStateForTests();
  });

  it('increments failure signals when heartbeat is missed', async () => {
    const supervisor = createInterpreterSupervisor();
    supervisor.beginCycle('worker:test-heartbeat', { category: 'worker' });

    jest.advanceTimersByTime(config.safety.heartbeatTimeoutMs + 1);
    await Promise.resolve();

    const activeLossConditions = getActiveUnsafeConditions('INTERPRETER_HEARTBEAT_LOSS');
    expect(activeLossConditions.length).toBeGreaterThan(0);
    expect(activeLossConditions[0]?.metadata?.entityId).toBe('worker:test-heartbeat');
  });

  it('activates restart-threshold unsafe condition after repeated heartbeat loss', async () => {
    const supervisor = createInterpreterSupervisor();
    const entityId = 'worker:test-threshold';

    for (let attemptIndex = 0; attemptIndex < config.safety.workerRestartThreshold; attemptIndex += 1) {
      supervisor.beginCycle(entityId, { category: 'worker' });
      jest.advanceTimersByTime(config.safety.heartbeatTimeoutMs + 1);
      await Promise.resolve();
    }

    const thresholdConditions = getActiveUnsafeConditions('WORKER_RESTART_THRESHOLD');
    expect(thresholdConditions.length).toBeGreaterThan(0);
    expect(thresholdConditions[0]?.metadata?.entityId).toBe(entityId);
  });

  it('auto-recovers non-integrity quarantine after cooldown and healthy cycles', async () => {
    const originalCooldownMs = config.safety.quarantineCooldownMs;
    config.safety.quarantineCooldownMs = 0;

    try {
      const supervisor = createInterpreterSupervisor();
      const entityId = 'worker:test-recovery';

      supervisor.beginCycle(entityId, { category: 'worker' });
      jest.advanceTimersByTime(config.safety.heartbeatTimeoutMs + 1);
      await Promise.resolve();

      const activeBeforeRecovery = getActiveQuarantines('worker');
      expect(activeBeforeRecovery.length).toBeGreaterThan(0);

      for (let cycleIndex = 0; cycleIndex < config.safety.healthyCyclesToRecover; cycleIndex += 1) {
        const cycleId = supervisor.beginCycle(entityId, { category: 'worker' });
        supervisor.heartbeat(cycleId);
        supervisor.completeCycle(cycleId);
      }

      const remainingQuarantines = getActiveQuarantines('worker').filter(record => {
        return record.metadata?.entityId === entityId;
      });
      expect(remainingQuarantines).toHaveLength(0);
    } finally {
      config.safety.quarantineCooldownMs = originalCooldownMs;
    }
  });
});
