import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

// Actual coordinator, policy, diagnostics aggregation and process-local commands.
// External provider/queue boundaries are deterministic fixtures; no server,
// Railway, database, Redis or paid provider is started by this suite.
const originalEnvironment = process.env;
const health = jest.fn();
const providerReload = jest.fn();
const queueRecovery = jest.fn();
const escalation = jest.fn();
const prediction = jest.fn();
const events: Array<Record<string, unknown>> = [];
const traces: Array<{ timestamp: string; name: string }> = [];
const forbiddenEffect = jest.fn(async () => { throw new Error('Synthetic fixture forbids external effects.'); });
const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
let predictiveEnabled = false;
let processKind: 'web' | 'worker' | 'unknown' = 'worker';
let enabled = false;

jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
  logger, aiLogger: logger, apiLogger: logger, dbLogger: logger, workerLogger: logger
}));
jest.unstable_mockModule('@platform/runtime/unifiedConfig.js', () => ({
  getConfig: () => ({
    selfImproveEnabled: enabled, selfImproveActuatorMode: 'daemon', selfImproveFrozen: false,
    selfImproveAutonomyLevel: 3, predictiveHealingEnabled: predictiveEnabled,
    trinityFinalModel: 'synthetic-authority-model'
  }),
  getStableWorkerRuntimeMode: () => ({
    requestedRunWorkers: true, resolvedRunWorkers: processKind !== 'web', processKind,
    railwayServiceName: null, reason: 'requested'
  }),
  isWorkerRuntimeSuppressedForServiceRole: () => processKind === 'web'
}));
jest.unstable_mockModule('@platform/runtime/workerConfig.js', () => ({
  getWorkerRuntimeStatus: () => ({ enabled: false, started: false, activeListeners: 0, workerIds: [] }),
  recycleWorker: forbiddenEffect, scaleWorkersUp: forbiddenEffect
}));
jest.unstable_mockModule('@services/workerControlService.js', () => ({
  getWorkerControlHealth: health, healWorkerRuntime: forbiddenEffect
}));
jest.unstable_mockModule('@services/workerAutonomyService.js', () => ({
  getWorkerAutonomySettings: () => ({ staleAfterMs: 60_000, watchdogIdleMs: 120_000, defaultMaxRetries: 2 })
}));
jest.unstable_mockModule('@services/openai/serviceHealth.js', () => ({
  getOpenAIServiceHealth: () => ({ circuitBreaker: { state: 'CLOSED', failureCount: 0 }, providerRuntime: {} }),
  reinitializeOpenAIProvider: providerReload
}));
jest.unstable_mockModule('@core/db/repositories/jobRepository.js', () => ({ recoverStaleJobs: queueRecovery }));
jest.unstable_mockModule('@services/selfImprove/controller.js', () => ({ runSelfImproveCycle: escalation }));
jest.unstable_mockModule('@services/selfImprove/predictiveHealingService.js', () => ({
  runPredictiveHealingFromLoop: prediction
}));
jest.unstable_mockModule('@services/selfImprove/selfHealTelemetry.js', () => ({
  inferSelfHealComponentFromAction: (action: string) => action,
  recordSelfHealEvent: (event: Record<string, unknown>) => { events.push(event); },
  resetSelfHealTelemetryForTests: () => { events.length = 0; }
}));
jest.unstable_mockModule('@platform/logging/telemetry.js', () => ({
  getTelemetrySnapshot: () => ({ traces: { recentEvents: traces, recentLogs: [] } }),
  recordTraceEvent: jest.fn(), recordLogEvent: jest.fn(), markOperation: jest.fn(),
  onTelemetry: jest.fn(), resetTelemetry: jest.fn()
}));
jest.unstable_mockModule('@platform/runtime/redisLifecycle.js', () => ({
  executeRedisOperation: forbiddenEffect,
  getRedisLifecycleSnapshot: () => ({ readyGeneration: 0, state: 'unconfigured' })
}));
jest.unstable_mockModule('@services/moduleRegistry.js', () => ({ initializeModuleRegistry: forbiddenEffect }));
jest.unstable_mockModule('@platform/runtime/gptRouterConfig.js', () => ({ getGptModuleMap: () => ({}) }));
jest.unstable_mockModule('@services/moduleCatalog.js', () => ({ MODULE_CATALOG: [], isPublicGptModule: () => false }));
jest.unstable_mockModule('@services/runtimeRouteTableService.js', () => ({ getActiveRouteTable: () => [] }));
jest.unstable_mockModule('@services/railwayClient.js', () => ({
  deployService: forbiddenEffect, listProjects: forbiddenEffect, isRailwayApiConfigured: () => false
}));


process.env = { NODE_ENV: 'test', DIAGNOSTICS_SHARED_METRICS: 'false', LOG_LEVEL: 'error' };
const coordinator = await import('../src/services/selfImprove/selfHealingLoop.js');
const diagnostics = await import('../src/services/runtimeDiagnosticsService.js');
const workerBootstrap = await import('../src/workers/jobRunnerRuntime.js');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function healthyWorker() {
  return { overallStatus: 'healthy', queueSummary: {
    pending: 0, running: 0, stalledRunning: 0, oldestPendingJobAgeMs: 0,
  }, workers: [], alerts: [] };
}
async function flush() { for (let index = 0; index < 20; index += 1) await Promise.resolve(); }

beforeEach(() => {
  process.env = { NODE_ENV: 'test', DIAGNOSTICS_SHARED_METRICS: 'false', LOG_LEVEL: 'error' };
  jest.useFakeTimers({ doNotFake: ['setImmediate'] }).setSystemTime(new Date('2026-10-14T12:00:00Z'));
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(globalThis, 'fetch').mockImplementation(forbiddenEffect);
  enabled = false;
  processKind = 'worker';
  health.mockResolvedValue(healthyWorker());
  prediction.mockRejectedValue(new Error('Synthetic predictive advisor disabled.'));
  coordinator.resetSelfHealingLoopStateForTests();
  diagnostics.resetRuntimeDiagnosticsState();
});
afterEach(async () => {
  await coordinator.stopSelfHealingLoop();
  coordinator.resetSelfHealingLoopStateForTests();
  expect(forbiddenEffect).not.toHaveBeenCalled();
  jest.restoreAllMocks();
  jest.useRealTimers();
  process.env = originalEnvironment;
});
afterAll(() => { process.env = originalEnvironment; });

describe('canonical coordinator production lifecycle with deterministic boundaries', () => {
  it('reports UNKNOWN before bootstrap and suppresses the explicit web role', async () => {
    expect(coordinator.getSelfHealingLoopStatus().coordinatorState).toBe('UNKNOWN');
    processKind = 'web';
    expect(coordinator.startSelfHealingLoop()).toMatchObject({
      coordinatorState: 'DISABLED', coordinatorReasonCode: 'service_role_suppressed',
      loopRunning: false, processKind: 'web',
    });
    await jest.advanceTimersByTimeAsync(90_000);
    expect(health).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('self_heal.coordinator.disabled', expect.objectContaining({ processKind: 'web' }));
  });

  it('starts after the actual all-slot readiness barrier and remains idempotent', async () => {
    const ready = deferred<void>();
    const consumer = deferred<void>();
    const emitted: string[] = [];
    const bootstrap = workerBootstrap.commitAllWorkerSlotsReadyOrThrow([ready.promise], [consumer.promise], () => {
      expect(coordinator.startSelfHealingLoop(1_000).coordinatorState).toBe('RUNNING');
      workerBootstrap.emitWorkerBootstrapReadySignal({ write: (line: string) => { emitted.push(line); return true; } });
    });
    await flush();
    expect(coordinator.getSelfHealingLoopStatus().coordinatorState).toBe('UNKNOWN');
    ready.resolve();
    await bootstrap;
    coordinator.startSelfHealingLoop(2_000);
    await flush();
    expect(coordinator.getSelfHealingLoopStatus()).toMatchObject({
      coordinatorState: 'RUNNING', intervalMs: 1_000, processKind: 'worker', operatingMode: 'observation_only',
    });
    expect(logger.info.mock.calls.filter(([event]) => event === 'self_heal.coordinator.started')).toHaveLength(1);
    expect(emitted).toEqual([`${workerBootstrap.WORKER_BOOTSTRAP_READY_SENTINEL}\n`]);
    expect(queueRecovery).not.toHaveBeenCalled();
    expect(providerReload).not.toHaveBeenCalled();
  });

  it('fails startup without emitting readiness when the scheduler cannot be installed', async () => {
    const emitted = jest.fn();
    jest.spyOn(globalThis, 'setInterval').mockImplementationOnce(() => { throw new Error('synthetic timer failure'); });
    await expect(workerBootstrap.commitAllWorkerSlotsReadyOrThrow(
      [Promise.resolve()], [new Promise<void>(() => undefined)],
      () => { coordinator.startSelfHealingLoop(); emitted(); },
    )).rejects.toThrow('synthetic timer failure');
    expect(emitted).not.toHaveBeenCalled();
    expect(coordinator.getSelfHealingLoopStatus()).toMatchObject({ coordinatorState: 'FAILED', loopRunning: false, startedAt: null });
    expect(logger.error).toHaveBeenCalledWith('self_heal.coordinator.start_failed', expect.objectContaining({ reasonCode: 'scheduler_start_failed' }));
    expect(health).not.toHaveBeenCalled();
  });

  it('cancels an in-flight observation, drains it and stops every future evaluation', async () => {
    const observation = deferred<ReturnType<typeof healthyWorker>>();
    health.mockReturnValueOnce(observation.promise);
    const shutdown = new AbortController();
    coordinator.startSelfHealingLoop(1_000, { signal: shutdown.signal });
    await flush();
    shutdown.abort();
    expect(coordinator.getSelfHealingLoopStatus()).toMatchObject({ coordinatorState: 'BLOCKED', loopRunning: false });
    observation.resolve(healthyWorker());
    await coordinator.stopSelfHealingLoop();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(health).toHaveBeenCalledTimes(1);
    expect(prediction).not.toHaveBeenCalled();
    expect(logger.info.mock.calls.filter(([event]) => event === 'self_heal.coordinator.stopped')).toHaveLength(1);
  });

  it.each([false, true])('drains an unsignalled manual evaluation before shutdown returns (failure=%s)', async fails => {
    const held = deferred<void>();
    const manual = coordinator.runSelfHealingLoop({ trigger: 'manual', beforeObservation: async () => {
      await held.promise;
      if (fails) throw new Error('Synthetic held manual evaluation failure.');
    } });
    let firstStopped = false;
    let secondStopped = false;
    const firstStop = coordinator.stopSelfHealingLoop().then(() => { firstStopped = true; });
    const secondStop = coordinator.stopSelfHealingLoop().then(() => { secondStopped = true; });
    try {
      await flush();
      expect(coordinator.getSelfHealingLoopStatus().inFlight).toBe(true);
      expect(firstStopped).toBe(false);
      expect(secondStopped).toBe(false);
    } finally {
      held.resolve();
      await Promise.all([manual, firstStop, secondStop]);
    }
    expect(coordinator.getSelfHealingLoopStatus().inFlight).toBe(false);
    expect((await manual).lastError).toBe(fails ? 'Synthetic held manual evaluation failure.' : null);
    expect(health).toHaveBeenCalledTimes(fails ? 0 : 1);
    expect(queueRecovery).not.toHaveBeenCalled();
    expect(providerReload).not.toHaveBeenCalled();
    expect(escalation).not.toHaveBeenCalled();
  });

  it('drains a manual evaluation after its scheduled startup tick has already settled', async () => {
    coordinator.startSelfHealingLoop(1_000);
    await flush();
    const observation = deferred<ReturnType<typeof healthyWorker>>();
    health.mockReturnValueOnce(observation.promise);
    const manual = coordinator.runSelfHealingLoop({ trigger: 'manual' });
    let stopped = false;
    const stop = coordinator.stopSelfHealingLoop().then(() => { stopped = true; });
    try {
      await flush();
      expect(stopped).toBe(false);
      await jest.advanceTimersByTimeAsync(10_000);
      expect(health).toHaveBeenCalledTimes(2);
      expect(coordinator.startSelfHealingLoop(1_000).coordinatorReasonCode).toBe('previous_evaluation_draining');
    } finally {
      observation.resolve(healthyWorker());
      await Promise.all([manual, stop]);
    }
    expect(coordinator.getSelfHealingLoopStatus().inFlight).toBe(false);
    expect(coordinator.startSelfHealingLoop(1_000).coordinatorState).toBe('RUNNING');
    await flush();
    expect(health).toHaveBeenCalledTimes(3);
  });

  it('does not start from an already-cancelled bootstrap', () => {
    const shutdown = new AbortController();
    shutdown.abort();
    expect(coordinator.startSelfHealingLoop(1_000, { signal: shutdown.signal })).toMatchObject({
      coordinatorState: 'BLOCKED', coordinatorReasonCode: 'shutdown_requested', loopRunning: false,
    });
    expect(health).not.toHaveBeenCalled();
  });

  it('does not overlap scheduled evaluations or restart before a cancelled evaluation drains', async () => {
    const observation = deferred<ReturnType<typeof healthyWorker>>();
    health.mockReturnValueOnce(observation.promise);
    coordinator.startSelfHealingLoop(1_000);
    await flush();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(health).toHaveBeenCalledTimes(1);
    const stop = coordinator.stopSelfHealingLoop();
    expect(coordinator.startSelfHealingLoop(1_000).coordinatorReasonCode).toBe('previous_evaluation_draining');
    observation.resolve(healthyWorker());
    await stop;
    expect(coordinator.startSelfHealingLoop(1_000).coordinatorState).toBe('RUNNING');
    await flush();
    expect(health).toHaveBeenCalledTimes(2);
  });

  it('contains an evaluation failure and reports recovery on the next successful tick', async () => {
    jest.spyOn(diagnostics.runtimeDiagnosticsService, 'getRollingRequestWindow')
      .mockImplementationOnce(() => { throw new Error('synthetic collector outage'); });
    coordinator.startSelfHealingLoop(1_000);
    await flush();
    expect(coordinator.getSelfHealingLoopStatus()).toMatchObject({ coordinatorState: 'FAILED', loopRunning: true });
    expect(logger.error).toHaveBeenCalledWith('self_heal.coordinator.tick_failed', expect.objectContaining({ reasonCode: 'evaluation_failed' }));
    await jest.advanceTimersByTimeAsync(1_000);
    expect(coordinator.getSelfHealingLoopStatus()).toMatchObject({ coordinatorState: 'RUNNING', lastError: null, tickCount: 2 });
  });

  it('passes cancellation to predictive diagnosis and prevents later reactive effects', async () => {
    enabled = true;
    const decision = deferred<never>();
    prediction.mockReturnValueOnce(decision.promise);
    coordinator.startSelfHealingLoop(1_000);
    await flush();
    const passedSignal = (prediction.mock.calls[0][0] as { signal: AbortSignal }).signal;
    const stopped = coordinator.stopSelfHealingLoop();
    expect(passedSignal.aborted).toBe(true);
    decision.reject(new Error('Synthetic cancelled diagnosis.'));
    await stopped;
    expect(queueRecovery).not.toHaveBeenCalled();
    expect(providerReload).not.toHaveBeenCalled();
    expect(escalation).not.toHaveBeenCalled();
    expect(coordinator.getSelfHealingLoopStatus().coordinatorState).toBe('BLOCKED');
  });
});
