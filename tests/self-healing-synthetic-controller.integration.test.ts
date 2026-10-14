import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

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
let effectsEnabled = true;
let processKind = 'worker';

jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
  logger, aiLogger: logger, apiLogger: logger, dbLogger: logger, workerLogger: logger
}));
jest.unstable_mockModule('@platform/runtime/unifiedConfig.js', () => ({
  getConfig: () => ({
    selfImproveEnabled: effectsEnabled, selfImproveActuatorMode: 'daemon', selfImproveFrozen: false,
    selfImproveAutonomyLevel: 3, predictiveHealingEnabled: predictiveEnabled,
    trinityFinalModel: 'synthetic-authority-model'
  }),
  getStableWorkerRuntimeMode: () => ({
    requestedRunWorkers: false, resolvedRunWorkers: false, processKind,
    railwayServiceName: null, reason: 'requested'
  }),
  isWorkerRuntimeSuppressedForServiceRole: () => false
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

function isolatedEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test', DIAGNOSTICS_SHARED_METRICS: 'false', LOG_LEVEL: 'error',
    DISABLE_EXTERNAL_CALLS: 'true', ALLOW_MOCK_OPENAI: 'true', USE_MOCK_SERVICES: 'true',
    RUN_WORKERS: 'false', OPENAI_API_KEY: 'test-synthetic-controller-provider-key',
    SELF_HEAL_VERIFICATION_DELAY_MS: '30000', SELF_HEAL_ACTION_COOLDOWN_MS: '120000',
    SELF_HEAL_CONTROLLER_COOLDOWN_MS: '300000', SELF_HEAL_MAX_ATTEMPTS_PER_DIAGNOSIS: '3',
    SELF_HEAL_INCIDENT_WINDOW_MS: '600000', SELF_HEAL_DEGRADED_COOLDOWN_OVERRIDE_MS: '600000'
  };
}

process.env = isolatedEnvironment();
const diagnostics = await import('../src/services/runtimeDiagnosticsService.js');
const healing = await import('../src/services/selfImprove/selfHealingV2.js');
const promptMitigation = await import('../src/services/openai/promptRouteMitigation.js');
const coordinator = await import('../src/services/selfImprove/selfHealingLoop.js');

function healthyWorker() {
  return {
    overallStatus: 'healthy',
    queueSummary: { pending: 0, running: 0, stalledRunning: 0, oldestPendingJobAgeMs: 0 },
    workers: [], alerts: []
  };
}

function recordHealthy(count = 12, route = '/api/arcanos/ask') {
  for (let index = 0; index < count; index += 1) {
    diagnostics.runtimeDiagnosticsService.recordRequestCompletion(200, 100, route);
  }
}

function recordFailure(count = 12, route = '/api/arcanos/ask') {
  for (let index = 0; index < count; index += 1) {
    diagnostics.runtimeDiagnosticsService.recordRequestCompletion(503, 8_000, route, { timeoutKind: 'provider' });
  }
}

function advance(ms: number) {
  jest.setSystemTime(Date.now() + ms);
}

function recordSyntheticTrinityConsumerOutcomes(count = 3) {
  const command = healing.getTrinitySelfHealingSnapshot().reasoning;
  for (let index = 0; index < count; index += 1) {
    healing.noteTrinityMitigationOutcome({
      stage: 'reasoning', action: command.activeAction!,
      mitigationId: command.mitigationId, outcome: 'success', requestId: `synthetic-consumer-${index}`
    });
  }
}

beforeEach(() => {
  process.env = isolatedEnvironment();
  jest.useFakeTimers().setSystemTime(new Date('2026-10-12T12:00:00.000Z'));
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(globalThis, 'fetch').mockImplementation(forbiddenEffect);
  traces.length = 0;
  predictiveEnabled = false;
  effectsEnabled = true;
  processKind = 'worker';
  health.mockResolvedValue(healthyWorker());
  prediction.mockRejectedValue(new Error('Synthetic predictive advisor disabled.'));
  providerReload.mockResolvedValue({ ok: false, skipped: false, reloaded: false, reason: 'Synthetic provider unavailable.', runtime: {} });
  queueRecovery.mockResolvedValue({ recoveredJobs: ['synthetic-job'], failedJobs: [] });
  escalation.mockResolvedValue({ id: 'synthetic-escalation', decision: 'ESCALATE' });
  diagnostics.resetRuntimeDiagnosticsState();
  healing.resetTrinitySelfHealingStateForTests();
  coordinator.resetSelfHealingLoopStateForTests();
});

afterEach(() => {
  expect(forbiddenEffect).not.toHaveBeenCalled();
  coordinator.resetSelfHealingLoopStateForTests();
  healing.resetTrinitySelfHealingStateForTests();
  diagnostics.resetRuntimeDiagnosticsState();
  jest.useRealTimers();
  process.env = originalEnvironment;
});

describe('synthetic controller lifecycle with real diagnostics and mitigation state', () => {
  it('S18 preserves evaluated policy until the next real coordinator tick', async () => {
    await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    const observed = coordinator.getSelfHealingLoopStatus();
    expect(observed.operatingMode).toBe('local_mitigation');

    effectsEnabled = false;
    advance(1_000);
    expect(coordinator.getSelfHealingLoopStatus()).toMatchObject({
      operatingMode: 'local_mitigation', policyObservedAt: observed.policyObservedAt
    });
    await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    expect(coordinator.getSelfHealingLoopStatus()).toMatchObject({
      operatingMode: 'observation_only', policyObservedAt: new Date().toISOString()
    });
    expect(queueRecovery).not.toHaveBeenCalled();
  });

  it('S19 rechecks revoked policy after asynchronous diagnosis before queue mutation', async () => {
    health.mockResolvedValue({
      ...healthyWorker(), overallStatus: 'unhealthy',
      queueSummary: { pending: 1, running: 1, stalledRunning: 1, oldestPendingJobAgeMs: 90_000 }
    });
    prediction.mockImplementationOnce(async () => {
      effectsEnabled = false;
      throw new Error('Synthetic advisor failure after policy revocation.');
    });

    expect((await coordinator.runSelfHealingLoop({ trigger: 'interval' })).action).toBeNull();
    expect(coordinator.getSelfHealingLoopStatus().operatingMode).toBe('local_mitigation');
    expect(queueRecovery).not.toHaveBeenCalled();
    expect(escalation).not.toHaveBeenCalled();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'noop', details: expect.objectContaining({ reasonCode: 'self_improve_execution_disabled' }) })
    ]));
  });

  it('S20 retains completed dispatch verification across cancellation and coordinator restart', async () => {
    health.mockResolvedValue({
      ...healthyWorker(), overallStatus: 'unhealthy',
      queueSummary: { pending: 1, running: 1, stalledRunning: 1, oldestPendingJobAgeMs: 90_000 }
    });
    let release!: () => void;
    let dispatched!: () => void;
    const actionStarted = new Promise<void>(resolve => { dispatched = resolve; });
    queueRecovery.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ recoveredJobs: ['synthetic-job'], failedJobs: [] });
      dispatched();
    }));
    coordinator.startSelfHealingLoop(1_000);
    await actionStarted;
    const stopped = coordinator.stopSelfHealingLoop();
    expect(coordinator.startSelfHealingLoop(1_000).coordinatorReasonCode).toBe('previous_evaluation_draining');
    release();
    await stopped;
    expect(coordinator.getSelfHealingLoopStatus()).toMatchObject({
      lastAction: 'recoverStaleJobs:recovered=1:failed=0',
      lastVerificationResult: null,
      coordinatorState: 'BLOCKED'
    });
    expect(escalation).not.toHaveBeenCalled();

    advance(31_000);
    effectsEnabled = false;
    health.mockResolvedValue(healthyWorker());
    coordinator.startSelfHealingLoop(1_000);
    await jest.advanceTimersByTimeAsync(0);
    expect(coordinator.getSelfHealingLoopStatus()).toMatchObject({
      operatingMode: 'observation_only',
      lastVerificationResult: { action: 'recoverStaleJobs', outcome: 'improved' }
    });
    expect(queueRecovery).toHaveBeenCalledTimes(1);
    expect(escalation).not.toHaveBeenCalled();
    await coordinator.stopSelfHealingLoop();
  });

  it('S01/S07 observes healthy and sub-threshold requests without mutating runtime state', async () => {
    recordHealthy();
    expect(await coordinator.runSelfHealingLoop({ trigger: 'interval' })).toMatchObject({ diagnosis: 'healthy', action: null });
    diagnostics.resetRuntimeDiagnosticsState();
    recordFailure(1);
    expect(await coordinator.runSelfHealingLoop({ trigger: 'interval' })).toMatchObject({ diagnosis: 'healthy', action: null });
    expect(healing.getTrinitySelfHealingSnapshot().reasoning.activeAction).toBeNull();
    expect(providerReload).not.toHaveBeenCalled();
    expect(queueRecovery).not.toHaveBeenCalled();
    expect(escalation).not.toHaveBeenCalled();
  });

  it('S09 rejects health-only traffic as proof of Trinity recovery', async () => {
    recordFailure();
    const activation = await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    expect(activation.action).toBe('activateTrinityMitigation:reasoning:enable_degraded_mode');
    advance(31_000);
    recordHealthy(12, '/health');
    const verification = await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    expect(verification.verificationResult).toBeNull();
    expect(events.some(event => event.kind === 'success' && event.trigger === 'verification')).toBe(false);
    expect(healing.getTrinitySelfHealingSnapshot().reasoning.activeAction).toBe('enable_degraded_mode');
  });

  it('S09 fails closed when the failing baseline has no attributed Trinity consumer route', async () => {
    recordFailure(12, '/health');
    expect((await coordinator.runSelfHealingLoop({ trigger: 'interval' })).action).toBe('activateTrinityMitigation:reasoning:enable_degraded_mode');
    advance(31_000);
    recordHealthy();
    const verification = await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    expect(verification.verificationResult).toBeNull();
    expect(events.some(event => event.kind === 'success' && event.trigger === 'verification')).toBe(false);
  });

  it('S09 rejects DAG control-plane requests as Trinity consumer recovery evidence', async () => {
    const route = '/api/arcanos/dag/runs/:runId';
    recordFailure(12, route);
    await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    advance(31_000);
    recordHealthy(3, route);
    const verification = await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    expect(verification.verificationResult).toBeNull();
    expect(events.some(event => event.kind === 'success' && event.trigger === 'verification')).toBe(false);
  });

  it('S09 requires sufficient post-command consumer traffic before verifying recovery', async () => {
    recordFailure();
    await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    advance(31_000);
    recordHealthy(1);
    expect((await coordinator.runSelfHealingLoop({ trigger: 'interval' })).verificationResult).toBeNull();
    advance(1);
    recordHealthy(2);
    // This controller-only fixture substitutes consumer outcome receipts using
    // the real V2 API. The joined Trinity suite supplies actual SDK receipts.
    recordSyntheticTrinityConsumerOutcomes();
    expect((await coordinator.runSelfHealingLoop({ trigger: 'interval' })).verificationResult).toMatchObject({ outcome: 'improved' });
  });

  it('S09/S04 never credits same-route diagnostic completions that did not execute the mitigation consumer', async () => {
    recordFailure();
    await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    advance(31_000);
    recordHealthy(3);
    expect(healing.getTrinitySelfHealingSnapshot().reasoning.verificationSuccesses).toBe(0);
    const verification = await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    expect(verification.verificationResult).toBeNull();
    expect(events.some(event => event.kind === 'success' && event.trigger === 'verification')).toBe(false);
  });

  it('S09 excludes pre-command samples stamped at the same clock value', async () => {
    recordFailure();
    await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    advance(31_000);
    expect((await coordinator.runSelfHealingLoop({ trigger: 'interval' })).verificationResult).toBeNull();
    expect(healing.getTrinitySelfHealingSnapshot().reasoning.activeAction).toBe('enable_degraded_mode');
  });

  it('S15 never rolls back a prompt command replacing the command under verification', async () => {
    // This fixture represents a colocated local runtime; dedicated worker
    // cross-process refusal is covered separately below.
    processKind = 'unknown';
    recordFailure(12, '/api/openai/prompt');
    const activation = await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    expect(activation.action).toBe('activatePromptRouteMitigation:reduced_latency');
    promptMitigation.activatePromptRouteDegradedMode('new independent incident');
    advance(31_000);
    recordFailure(12, '/api/openai/prompt');
    const result = await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    expect(result.verificationResult).toBeNull();
    expect(promptMitigation.getPromptRouteMitigationState()).toMatchObject({ active: true, mode: 'degraded_response', reason: 'new independent incident' });
    expect(events.some(event => event.actionTaken === 'rollbackPromptRouteMitigation')).toBe(false);
  });

  it('blocks dedicated-worker prompt commands without a web consumer or cross-process effect', async () => {
    recordFailure(12, '/api/openai/prompt');
    const result = await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    expect(result.action).toBeNull();
    expect(promptMitigation.getPromptRouteMitigationState()).toMatchObject({ active: false, mitigationId: null });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'noop', reason: expect.stringContaining('cross_process_prompt_route_unavailable') })
    ]));
    expect(events.some(event => event.kind === 'success')).toBe(false);
  });

  it('S03/S10/S18 bounds sustained provider attempts and escalation under deterministic cooldowns', async () => {
    providerReload.mockRejectedValue(new Error('Synthetic actuator throws before recovery.'));
    for (let index = 0; index < 3; index += 1) traces.push({ timestamp: new Date().toISOString(), name: 'openai.call.failure' });
    const first = await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    expect(first.lastError).toBe('Synthetic actuator throws before recovery.');
    expect(providerReload).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 10; index += 1) await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    expect(providerReload).toHaveBeenCalledTimes(1);
    expect(escalation).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 2; index += 1) {
      advance(120_000);
      traces.splice(0, traces.length, ...Array.from({ length: 3 }, () => ({ timestamp: new Date().toISOString(), name: 'openai.call.failure' })));
      await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    }
    expect(providerReload).toHaveBeenCalledTimes(3);
    advance(120_000);
    traces.splice(0, traces.length, ...Array.from({ length: 3 }, () => ({ timestamp: new Date().toISOString(), name: 'openai.call.failure' })));
    for (let index = 0; index < 10; index += 1) await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    expect(providerReload).toHaveBeenCalledTimes(3);
    expect(coordinator.getSelfHealingLoopStatus().attemptsByDiagnosis).toEqual({ provider_failure_cluster: 3 });
    expect(events.filter(event => event.kind === 'ACTION_DISPATCH_RESULT' && (event.details as { outcome?: string })?.outcome === 'failure')).toHaveLength(3);
  });

  it('S03/S09 never verifies recovery for an actuator that explicitly reports provider failure', async () => {
    for (let index = 0; index < 3; index += 1) traces.push({ timestamp: new Date().toISOString(), name: 'openai.call.failure' });
    recordFailure();
    const failed = await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    expect(failed.action).toContain('ok=false');
    advance(31_000);
    diagnostics.resetRuntimeDiagnosticsState();
    const result = await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    expect(result.verificationResult).toBeNull();
    expect(events.some(event => event.kind === 'success' && event.trigger === 'verification')).toBe(false);
    expect(coordinator.getSelfHealingLoopStatus().lastHealthyObservedAt).toBeNull();
    expect(providerReload).toHaveBeenCalledTimes(1);
  });

  it('S18 applies the ineffective provider cooldown to the next dispatched action', async () => {
    providerReload.mockResolvedValue({ ok: true, skipped: false, reloaded: true, reason: null, runtime: {} });
    for (let index = 0; index < 3; index += 1) traces.push({ timestamp: new Date().toISOString(), name: 'openai.call.failure' });
    recordFailure();
    await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    advance(31_000);
    recordFailure();
    expect((await coordinator.runSelfHealingLoop({ trigger: 'interval' })).verificationResult).toMatchObject({ outcome: 'unchanged' });
    advance(120_000);
    await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    expect(providerReload).toHaveBeenCalledTimes(1);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'noop', trigger: 'action', reason: 'provider failure cluster detected (recently ineffective)' })
    ]));
  });

  it('S09 rejects missing post-action traffic after a successful provider reload', async () => {
    providerReload.mockResolvedValue({ ok: true, skipped: false, reloaded: true, reason: null, runtime: {} });
    for (let index = 0; index < 3; index += 1) traces.push({ timestamp: new Date().toISOString(), name: 'openai.call.failure' });
    recordFailure();
    await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    advance(31_000);
    diagnostics.resetRuntimeDiagnosticsState();
    expect((await coordinator.runSelfHealingLoop({ trigger: 'interval' })).verificationResult).toBeNull();
    expect(events.some(event => event.kind === 'success' && event.trigger === 'verification')).toBe(false);
  });

  it('S09 never credits same-route diagnostic completions after a reload without a provider execution receipt', async () => {
    providerReload.mockResolvedValue({ ok: true, skipped: false, reloaded: true, reason: null, runtime: {} });
    for (let index = 0; index < 3; index += 1) traces.push({ timestamp: new Date().toISOString(), name: 'openai.call.failure' });
    recordFailure();
    await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    advance(31_000);
    recordHealthy(3);
    const verification = await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    expect(verification.verificationResult).toBeNull();
    expect(events.some(event => event.kind === 'success' && event.trigger === 'verification')).toBe(false);
  });

  it('S09 requires three fresh provider execution receipts rather than two or cached route successes', async () => {
    providerReload.mockResolvedValue({ ok: true, skipped: false, reloaded: true, reason: null, runtime: {} });
    for (let index = 0; index < 3; index += 1) traces.push({ timestamp: new Date().toISOString(), name: 'openai.call.failure' });
    recordFailure();
    await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    advance(31_000);
    recordHealthy(3);
    // Provider execution receipts are a synthetic boundary here; actual SDK
    // emissions are proved separately by the joined loopback Trinity fixture.
    for (let index = 0; index < 2; index += 1) traces.push({ timestamp: new Date().toISOString(), name: 'openai.resilience.success' });
    expect((await coordinator.runSelfHealingLoop({ trigger: 'interval' })).verificationResult).toBeNull();
    advance(1);
    traces.push({ timestamp: new Date().toISOString(), name: 'openai.resilience.success' });
    expect((await coordinator.runSelfHealingLoop({ trigger: 'interval' })).verificationResult).toMatchObject({ outcome: 'improved' });
    expect(providerReload).toHaveBeenCalledTimes(1);
  });

  it('S09/S18 bounds an evidence-starved provider verification so later incidents remain repairable', async () => {
    providerReload.mockResolvedValue({ ok: true, skipped: false, reloaded: true, reason: null, runtime: {} });
    for (let index = 0; index < 3; index += 1) traces.push({ timestamp: new Date().toISOString(), name: 'openai.call.failure' });
    recordFailure();
    await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    advance(600_001);
    diagnostics.resetRuntimeDiagnosticsState();
    traces.length = 0;
    health.mockResolvedValue({
      ...healthyWorker(), overallStatus: 'unhealthy',
      queueSummary: { pending: 1, running: 1, stalledRunning: 1, oldestPendingJobAgeMs: 90_000 }
    });
    const repair = await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    expect(repair).toMatchObject({ action: 'recoverStaleJobs:recovered=1:failed=0', verificationResult: null });
    expect(queueRecovery).toHaveBeenCalledTimes(1);
    expect(events.some(event => event.kind === 'success' && event.trigger === 'verification')).toBe(false);
  });

  it('S09 does not turn an unchanged stalled queue into verified recovery when HTTP traffic disappears', async () => {
    health.mockResolvedValue({
      ...healthyWorker(), overallStatus: 'unhealthy',
      queueSummary: { pending: 1, running: 1, stalledRunning: 1, oldestPendingJobAgeMs: 90_000 }
    });
    recordFailure();
    expect((await coordinator.runSelfHealingLoop({ trigger: 'interval' })).action).toBe('recoverStaleJobs:recovered=1:failed=0');
    advance(31_000);
    diagnostics.resetRuntimeDiagnosticsState();
    const verification = await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    expect(verification.verificationResult?.outcome).not.toBe('improved');
    expect(events.some(event => event.kind === 'success' && event.trigger === 'verification')).toBe(false);
    expect(coordinator.getSelfHealingLoopStatus().lastHealthyObservedAt).toBeNull();
    expect(queueRecovery).toHaveBeenCalledTimes(1);
  });

  it('S09 does not let unrelated successful user traffic close an unchanged worker incident', async () => {
    health.mockResolvedValue({
      ...healthyWorker(), overallStatus: 'unhealthy',
      queueSummary: { pending: 1, running: 1, stalledRunning: 1, oldestPendingJobAgeMs: 90_000 }
    });
    recordFailure();
    await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    advance(31_000);
    recordHealthy();
    const verification = await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    expect(verification.verificationResult?.outcome).not.toBe('improved');
    expect(coordinator.getSelfHealingLoopStatus().lastHealthyObservedAt).toBeNull();
  });

  it.each(['inspection exception', 'missing queue summary'])(
    'S09 fails closed with %s during worker recovery verification', async (fault) => {
      health.mockResolvedValue({
        ...healthyWorker(), overallStatus: 'unhealthy',
        queueSummary: { pending: 1, running: 1, stalledRunning: 1, oldestPendingJobAgeMs: 90_000 }
      });
      recordFailure();
      await coordinator.runSelfHealingLoop({ trigger: 'interval' });
      advance(31_000);
      if (fault === 'inspection exception') {
        health.mockRejectedValue(new Error('Synthetic worker inspection unavailable.'));
      } else {
        health.mockResolvedValue({ ...healthyWorker(), overallStatus: 'unhealthy', queueSummary: null });
      }
      recordHealthy(3);
      const verification = await coordinator.runSelfHealingLoop({ trigger: 'interval' });
      expect(verification.verificationResult?.outcome).not.toBe('improved');
      expect(events.some(event => event.kind === 'success' && event.trigger === 'verification')).toBe(false);
      expect(coordinator.getSelfHealingLoopStatus().lastHealthyObservedAt).toBeNull();
    }
  );

  it('S11 serializes simultaneous ticks and preserves deterministic incident priority', async () => {
    let release!: (value: ReturnType<typeof healthyWorker>) => void;
    let observed!: () => void;
    const observationStarted = new Promise<void>(resolve => { observed = resolve; });
    health.mockImplementationOnce(() => new Promise(resolve => { release = resolve; observed(); }));
    recordFailure();
    const owner = coordinator.runSelfHealingLoop({ trigger: 'interval' });
    await observationStarted;
    const duplicate = await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    expect(duplicate.tickCount).toBe(1);
    expect(healing.getTrinitySelfHealingSnapshot().reasoning.activeAction).toBeNull();
    release(healthyWorker());
    expect((await owner).action).toBe('activateTrinityMitigation:reasoning:enable_degraded_mode');
    expect(events.filter(event => event.kind === 'ACTION_EXECUTED')).toHaveLength(1);
    expect(healing.getTrinitySelfHealingSnapshot().reasoning.attempts).toBe(1);
  });

  it('S11 verifies queue improvement before admitting an independent Trinity incident', async () => {
    health.mockResolvedValue({
      ...healthyWorker(), overallStatus: 'unhealthy',
      queueSummary: { pending: 1, running: 1, stalledRunning: 1, oldestPendingJobAgeMs: 90_000 }
    });
    queueRecovery.mockImplementationOnce(async () => {
      health.mockResolvedValue(healthyWorker());
      return { recoveredJobs: ['synthetic-job'], failedJobs: [] };
    });
    recordFailure();
    expect(await coordinator.runSelfHealingLoop({ trigger: 'interval' })).toMatchObject({
      diagnosis: 'worker stall detected', action: 'recoverStaleJobs:recovered=1:failed=0'
    });
    expect(healing.getTrinitySelfHealingSnapshot().reasoning.activeAction).toBeNull();
    advance(31_000);
    diagnostics.resetRuntimeDiagnosticsState();
    expect((await coordinator.runSelfHealingLoop({ trigger: 'interval' })).verificationResult).toMatchObject({
      outcome: 'improved', current: { requestCount: 0, workerHealth: 'healthy', stalledRunning: 0 }
    });
    advance(1);
    recordFailure();
    expect((await coordinator.runSelfHealingLoop({ trigger: 'interval' })).action).toBe('activateTrinityMitigation:reasoning:enable_degraded_mode');
    expect(queueRecovery).toHaveBeenCalledTimes(1);
    expect(healing.getTrinitySelfHealingSnapshot().reasoning.attempts).toBe(1);
    expect(coordinator.getSelfHealingLoopStatus().attemptsByDiagnosis).toEqual({ worker_stall: 1, timeout_storm: 1 });
    expect(events.filter(event => event.kind === 'ACTION_EXECUTED').map(event => event.actionTaken)).toEqual([
      'recoverStaleJobs:recovered=1:failed=0', 'activateTrinityMitigation:reasoning:enable_degraded_mode'
    ]);
  });

  it('S13 fails closed when predictive ownership becomes uncertain', async () => {
    predictiveEnabled = true;
    recordFailure();
    expect(await coordinator.runSelfHealingLoop({ trigger: 'interval' })).toMatchObject({ action: null, controllerDecision: null });
    expect(healing.getTrinitySelfHealingSnapshot().reasoning.activeAction).toBeNull();
    expect(events.some(event => event.kind === 'ACTION_DISPATCH_ATTEMPT')).toBe(false);
    expect(providerReload).not.toHaveBeenCalled();
    expect(queueRecovery).not.toHaveBeenCalled();
    expect(escalation).not.toHaveBeenCalled();
  });
});
