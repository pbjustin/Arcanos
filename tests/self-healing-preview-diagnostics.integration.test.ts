import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

// Real coordinator, request-window aggregation and mitigation identity/receipts.
// Only unavailable external effects and the disabled predictive boundary are mocked.
const originalEnvironment = process.env;
const forbidden = jest.fn(async () => { throw new Error('External effects forbidden in preview diagnostics regression.'); });
const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const prediction = jest.fn(async () => { throw new Error('Predictive feature disabled for this regression.'); });
const events: Array<Record<string, unknown>> = [];
jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
  logger: log, aiLogger: log, apiLogger: log, dbLogger: log, workerLogger: log,
}));
jest.unstable_mockModule('@platform/runtime/unifiedConfig.js', () => ({
  getConfig: () => ({ selfImproveEnabled: true, selfImproveActuatorMode: 'daemon', selfImproveFrozen: false,
    selfImproveAutonomyLevel: 3, predictiveHealingEnabled: false, trinityFinalModel: 'synthetic-fixture-model' }),
  getStableWorkerRuntimeMode: () => ({ requestedRunWorkers: true, resolvedRunWorkers: true, processKind: 'worker' }),
  isWorkerRuntimeSuppressedForServiceRole: () => false,
}));
jest.unstable_mockModule('@services/incidentResponse/killSwitch.js', () => ({
  getKillSwitchStatus: async () => ({ frozen: false, autonomyLevel: 3 }),
}));
jest.unstable_mockModule('@platform/runtime/workerConfig.js', () => ({
  getWorkerRuntimeStatus: () => ({ enabled: false, started: false, activeListeners: 0, workerIds: [] }),
  recycleWorker: forbidden, scaleWorkersUp: forbidden,
}));
jest.unstable_mockModule('@services/workerControlService.js', () => ({
  getWorkerControlHealth: async () => ({ overallStatus: 'healthy', workers: [], alerts: [],
    queueSummary: { pending: 0, running: 0, stalledRunning: 0, oldestPendingJobAgeMs: 0 } }),
  healWorkerRuntime: forbidden,
}));
jest.unstable_mockModule('@services/workerAutonomyService.js', () => ({
  getWorkerAutonomySettings: () => ({ staleAfterMs: 60_000, watchdogIdleMs: 120_000, defaultMaxRetries: 2 }),
}));
jest.unstable_mockModule('@services/openai/serviceHealth.js', () => ({
  getOpenAIServiceHealth: () => ({ circuitBreaker: { state: 'CLOSED', failureCount: 0 }, providerRuntime: {} }),
  reinitializeOpenAIProvider: forbidden,
}));
jest.unstable_mockModule('@core/db/repositories/jobRepository.js', () => ({ recoverStaleJobs: forbidden }));
jest.unstable_mockModule('@services/selfImprove/controller.js', () => ({ runSelfImproveCycle: async () => ({ decision: 'NOOP', id: 'synthetic-noop' }) }));
jest.unstable_mockModule('@services/selfImprove/predictiveHealingService.js', () => ({ runPredictiveHealingFromLoop: prediction }));
jest.unstable_mockModule('@services/selfImprove/selfHealTelemetry.js', () => ({
  inferSelfHealComponentFromAction: (action: string) => action,
  recordSelfHealEvent: (event: Record<string, unknown>) => { events.push(event); },
  resetSelfHealTelemetryForTests: () => { events.length = 0; },
}));
jest.unstable_mockModule('@platform/logging/telemetry.js', () => ({
  getTelemetrySnapshot: () => ({ traces: { recentEvents: [], recentLogs: [] } }),
  recordTraceEvent: jest.fn(), recordLogEvent: jest.fn(), markOperation: jest.fn(), onTelemetry: jest.fn(), resetTelemetry: jest.fn(),
}));
jest.unstable_mockModule('@platform/runtime/redisLifecycle.js', () => ({
  executeRedisOperation: forbidden, getRedisLifecycleSnapshot: () => ({ state: 'unconfigured', readyGeneration: 0 }),
}));
jest.unstable_mockModule('@services/moduleRegistry.js', () => ({ initializeModuleRegistry: forbidden }));
jest.unstable_mockModule('@platform/runtime/gptRouterConfig.js', () => ({ getGptModuleMap: () => ({}) }));
jest.unstable_mockModule('@services/moduleCatalog.js', () => ({ MODULE_CATALOG: [], isPublicGptModule: () => false }));
jest.unstable_mockModule('@services/runtimeRouteTableService.js', () => ({ getActiveRouteTable: () => [] }));
jest.unstable_mockModule('@services/railwayClient.js', () => ({ deployService: forbidden, listProjects: forbidden, isRailwayApiConfigured: () => false }));

process.env = { NODE_ENV: 'test', DIAGNOSTICS_SHARED_METRICS: 'false', SELF_HEAL_VERIFICATION_DELAY_MS: '30000' };
const coordinator = await import('../src/services/selfImprove/selfHealingLoop.js');
const diagnostics = await import('../src/services/runtimeDiagnosticsService.js');
const mitigation = await import('../src/services/selfImprove/selfHealingV2.js');
const route = coordinator.SELF_HEAL_PREVIEW_CONSUMER_ROUTE;

beforeEach(() => {
  process.env = { NODE_ENV: 'test', DIAGNOSTICS_SHARED_METRICS: 'false', SELF_HEAL_VERIFICATION_DELAY_MS: '30000' };
  jest.useFakeTimers().setSystemTime(new Date('2026-10-15T01:00:00Z'));
  jest.clearAllMocks(); events.length = 0;
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  coordinator.resetSelfHealingLoopStateForTests();
  mitigation.resetTrinitySelfHealingStateForTests();
  diagnostics.resetRuntimeDiagnosticsState();
});
afterEach(async () => {
  await coordinator.stopSelfHealingLoop();
  coordinator.resetSelfHealingLoopStateForTests();
  mitigation.resetTrinitySelfHealingStateForTests();
  expect(forbidden).not.toHaveBeenCalled();
  jest.restoreAllMocks(); jest.useRealTimers(); process.env = originalEnvironment;
});
function completeHealthy(count: number) {
  for (let index = 0; index < count; index += 1) diagnostics.runtimeDiagnosticsService.recordRequestCompletion(200, 80, route);
}
function unhealthyBaseline() {
  completeHealthy(3);
  for (let index = 0; index < 4; index += 1) diagnostics.runtimeDiagnosticsService.recordRequestCompletion(504, 2_000, route, { timeoutKind: 'pipeline_timeout' });
}
async function evaluate(previewConsumerRoute: typeof route | undefined = route) {
  return coordinator.runSelfHealingLoop({ trigger: 'interval', previewConsumerRoute });
}
function actualConsumerReceipts(count: number) {
  const active = mitigation.getTrinitySelfHealingStatus().snapshot.reasoning;
  for (let index = 0; index < count; index += 1) mitigation.noteTrinityMitigationOutcome({
    stage: 'reasoning', outcome: 'success', requestId: `synthetic-consumer-${index}`,
    sourceEndpoint: 'preview-diagnostics-regression', action: active.activeAction, mitigationId: active.mitigationId,
  });
}

describe('canonical recovery verification for the explicitly registered preview consumer', () => {
  it('does not accept pre-action healthy samples or fewer than three fresh consumer samples', async () => {
    unhealthyBaseline();
    await jest.advanceTimersByTimeAsync(1);
    expect((await evaluate()).action).toBe('activateTrinityMitigation:reasoning:enable_degraded_mode');
    await jest.advanceTimersByTimeAsync(31_000);
    expect((await evaluate()).verificationResult).toBeNull();
    actualConsumerReceipts(3);
    completeHealthy(2);
    expect((await evaluate()).verificationResult).toBeNull();
    expect(events.some(event => event.kind === 'success' && event.trigger === 'verification')).toBe(false);
    completeHealthy(1);
    expect((await evaluate()).verificationResult).toMatchObject({ outcome: 'improved', current: { requestCount: 3, timeoutCount: 0 } });
  });

  it('requires identity-matched mitigation consumer receipts in addition to fresh healthy diagnostics', async () => {
    unhealthyBaseline();
    await jest.advanceTimersByTimeAsync(1);
    await evaluate();
    await jest.advanceTimersByTimeAsync(31_000);
    completeHealthy(3);
    expect((await evaluate()).verificationResult).toBeNull();
    actualConsumerReceipts(3);
    expect((await evaluate()).verificationResult).toMatchObject({ outcome: 'improved' });
  });

  it.each([undefined, '/untrusted/fake-route'])(
    'does not expand normal consumer-route trust for unregistered option %s', async value => {
      unhealthyBaseline();
      await jest.advanceTimersByTimeAsync(1);
      const unregistered = () => coordinator.runSelfHealingLoop({ trigger: 'interval', previewConsumerRoute: value as typeof route | undefined });
      await unregistered();
      await jest.advanceTimersByTimeAsync(31_000);
      completeHealthy(3); actualConsumerReceipts(3);
      const result = await unregistered();
      expect(result.verificationResult).toBeNull();
      expect(events.some(event => event.kind === 'success' && event.trigger === 'verification')).toBe(false);
    },
  );
});
