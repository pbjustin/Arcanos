import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const queryMock = jest.fn();
const isDatabaseConnectedMock = jest.fn(() => true);
const recordJobEventMock = jest.fn(async () => undefined);
const claimNextMock = jest.fn();
const runWorkerTrinityPromptMock = jest.fn();
const runDagNodeJobMock = jest.fn();
const classifyWorkerAiBudgetErrorMock = jest.fn((_error: unknown): unknown => null);
const routeGptRequestMock = jest.fn();
const getOpenAIAdapterMock = jest.fn(() => ({
  getClient: () => fakeOpenAIClient
}));
const probeOpenAIProviderHealthMock = jest.fn(async () => ({
  ok: true,
  runtime: providerRuntime
}));
const syncOpenAIProviderRuntimeMock = jest.fn(() => ({
  runtime: providerRuntime
}));
const getGptModuleMapMock = jest.fn(async () => ({
  'arcanos-core': { route: 'arcanos-core', module: 'ARCANOS:CORE' },
  'backstage-booker': { route: 'backstage-booker', module: 'BACKSTAGE:BOOKER' },
}));
const fakeOpenAIClient = {};
const sleepMock = jest.fn((delayMs: number, options?: { signal?: AbortSignal }) => new Promise<void>(resolve => {
  const timer = setTimeout(resolve, delayMs);
  options?.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
}));
const providerRuntime = {
  configVersion: 'provider-config-v1',
  nextRetryAt: null,
  lastFailureAt: null,
  lastFailureCategory: null,
  consecutiveFailures: 0
};

const originalEnvironment = process.env;
const initializeDatabaseMock = jest.fn(async () => true);
const initializeModuleRegistryMock = jest.fn(async () => ({ listRegisteredModules: () => [] }));
process.env = { NODE_ENV: 'test', ARCANOS_PROCESS_KIND: 'worker', RUN_WORKERS: 'true', DIAGNOSTICS_SHARED_METRICS: 'false', DATABASE_URL: 'postgres://synthetic.invalid/fixture', SELF_HEAL_LOOP_INTERVAL_MS: '1000', JOB_WORKER_POLL_MS: '50', JOB_WORKER_IDLE_BACKOFF_MS: '50', JOB_WORKER_CONCURRENCY: '2' };

jest.unstable_mockModule('@core/db/client.js', () => ({
  getPool: jest.fn(),
  initializeDatabase: jest.fn(),
  isDatabaseConnected: isDatabaseConnectedMock
}));

jest.unstable_mockModule('@platform/runtime/gptRouterConfig.js', () => ({
  getGptModuleMap: getGptModuleMapMock,
}));

jest.unstable_mockModule('@core/db/query.js', () => ({
  query: queryMock
}));

jest.unstable_mockModule('@core/db/repositories/jobEventRepository.js', () => ({
  recordJobEvent: recordJobEventMock,
  recordJobEventWithClient: jest.fn()
}));

jest.unstable_mockModule('@core/db/index.js', () => ({
  getBackstageNotionPartitionCutoverEvidenceRepository: jest.fn(),
  getBackstageNotionPartitionRepository: jest.fn(),
  getBackstageNotionRagRepository: jest.fn(),
  getBackstageNotionSyncStatusRepository: jest.fn(),
  getStatus: () => ({ connected: true }),
  initializeDatabaseWithSchema: initializeDatabaseMock
}));

jest.unstable_mockModule('@core/scheduler/postgresAdapter.js', () => ({
  postgresQueueSchedulerAdapter: {
    claimNext: claimNextMock
  }
}));

jest.unstable_mockModule('@core/adapters/openai.adapter.js', () => ({
  assertValidResponsesCreateParams: jest.fn(),
  classifyWorkerAiBudgetError: classifyWorkerAiBudgetErrorMock,
  createOpenAIAdapter: getOpenAIAdapterMock,
  normalizeWorkerAiBudgetError: jest.fn((error: unknown) => error),
  normalizeResponsesCreateParams: jest.fn((value: unknown) => value),
  getOpenAIAdapter: getOpenAIAdapterMock,
  isOpenAIAdapterInitialized: jest.fn(() => true),
  resetOpenAIAdapter: jest.fn()
}));

jest.unstable_mockModule('@services/openai/serviceHealth.js', () => ({
  getOpenAIServiceHealth: jest.fn(() => ({ circuitBreaker: { state: 'CLOSED', failureCount: 0 }, providerRuntime })),
  reinitializeOpenAIProvider: jest.fn(),
  getOpenAIProviderRuntimeStatus: jest.fn(() => providerRuntime),
  probeOpenAIProviderHealth: probeOpenAIProviderHealthMock,
  syncOpenAIProviderRuntime: syncOpenAIProviderRuntimeMock
}));

jest.unstable_mockModule('@services/backstageBookerRouteShortcut.js', () => ({
  detectBackstageBookerIntent: jest.fn(() => null)
}));
jest.unstable_mockModule('@services/gamingSourceIngestion.js', () => ({
  executeQueuedGamingSourceIngestion: jest.fn(),
  GAMING_SOURCE_INGESTION_GPT_ID: 'arcanos-gaming',
  GAMING_SOURCE_INGESTION_REASON: 'gaming_source_ingestion',
  GAMING_SOURCE_INGESTION_REQUEST_PATH: '/gpt-access/gaming/sources/ingestions',
  GAMING_SOURCE_REFRESH_REQUEST_PATH: '/gpt-access/gaming/sources/refreshes',
  parseQueuedGamingSourceIngestionBody: jest.fn()
}));

jest.unstable_mockModule('../src/workers/taskRunners.js', () => ({
  runDagNodeJob: runDagNodeJobMock
}));

jest.unstable_mockModule('../src/workers/trinityWorkerPipeline.js', () => ({
  runWorkerTrinityPrompt: runWorkerTrinityPromptMock
}));

jest.unstable_mockModule('@services/trinity/adapter.js', () => ({
  isTrinityDagGptAccessEnabled: jest.fn(() => false),
  routeDagNodeToGptAccess: jest.fn()
}));

jest.unstable_mockModule('@services/arcanosCoreRuntimeProviders.js', () => ({
  configureDefaultArcanosCoreRuntimeProviders: jest.fn()
}));

jest.unstable_mockModule('@routes/_core/gptDispatch.js', () => ({
  routeGptRequest: routeGptRequestMock
}));

jest.unstable_mockModule('@services/moduleRegistry.js', () => ({
  initializeModuleRegistry: initializeModuleRegistryMock
}));

jest.unstable_mockModule('@shared/sleep.js', () => ({
  sleep: sleepMock
}));
jest.unstable_mockModule('../src/queue/cleanup.js', () => ({
  runFailedJobCleanup: jest.fn(),
  runJobEventCleanup: jest.fn(),
  runNonGptTerminalCleanup: jest.fn()
}));


const lifecycleLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const forbidden = jest.fn(async () => { throw new Error('External effects forbidden in synthetic bootstrap.'); });
const workerHealth = jest.fn(async () => ({ overallStatus: 'healthy', queueSummary: {
  pending: 0, running: 0, stalledRunning: 0, oldestPendingJobAgeMs: 0,
}, workers: [], alerts: [] }));
const flushSnapshots = jest.fn(async () => undefined);
const dispatcherStarted = jest.fn(async () => undefined);
const workerHeartbeat = jest.fn(async () => undefined);
const markIdle = jest.fn(async () => undefined);
const prediction = jest.fn(async () => { throw new Error('Synthetic prediction disabled.'); });
const stopNotion = jest.fn(async () => undefined);
let redisStarted = false;
const startRedis = jest.fn(() => { redisStarted = true; });
const stopRedis = jest.fn(async () => { redisStarted = false; });
const primeTelemetry = jest.fn(async () => undefined);
const stopTelemetry = jest.fn(async () => undefined);

jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
  logger: lifecycleLog, aiLogger: lifecycleLog, dbLogger: lifecycleLog, apiLogger: lifecycleLog, workerLogger: lifecycleLog,
}));
jest.unstable_mockModule('@services/workerAutonomyService.js', () => ({
  getWorkerAutonomySettings: (settings: Record<string, unknown> = {}) => ({ ...settings, staleAfterMs: 60_000, defaultMaxRetries: 2 }),
  classifyWorkerExecutionError: forbidden,
  WorkerAutonomyService: class {
    constructor(private settings: { workerId: string }) {}
    getWorkerId() { return this.settings.workerId; }
    getWorkerAiCallBudget() { return { statsWorkerId: 'synthetic', workerId: this.settings.workerId, maxCallsPerHour: 120 }; }
    async bootstrap() { return { healthStatus: 'healthy', recovered: { recoveredJobs: [], failedJobs: [], cancelledJobs: [] } }; }
    getWatchdogIntervalMs() { return 30_000; }
    getHeartbeatIntervalMs() { return 1_000; }
    getRecommendedWorkerHeartbeatDelayMs() { return 1_000; }
    getClaimOptions() { return { workerId: this.settings.workerId, leaseMs: 30_000 }; }
    async evaluateBudgetsBeforeClaim() { return { allowed: true }; }
    recordClaimAttempt() {}
    recordClaimResult() {}
    markDispatcherStarted = dispatcherStarted;
    recordWorkerHeartbeat = workerHeartbeat;
    markIdle = markIdle;
    flushSnapshotPipeline = flushSnapshots;
  },
}));
jest.unstable_mockModule('@core/init-openai.js', () => ({ configureBackendUnifiedOpenAIClient: jest.fn() }));
jest.unstable_mockModule('@services/workerControlService.js', () => ({ getWorkerControlHealth: workerHealth, healWorkerRuntime: forbidden }));
jest.unstable_mockModule('@platform/runtime/workerConfig.js', () => ({
  getWorkerRuntimeStatus: () => ({ enabled: false, started: false, activeListeners: 0, workerIds: [] }),
  recycleWorker: forbidden, scaleWorkersUp: forbidden,
}));
jest.unstable_mockModule('@services/selfImprove/controller.js', () => ({ runSelfImproveCycle: forbidden }));
jest.unstable_mockModule('@services/selfImprove/predictiveHealingService.js', () => ({ runPredictiveHealingFromLoop: prediction }));
jest.unstable_mockModule('@services/selfImprove/selfHealTelemetry.js', () => ({
  inferSelfHealComponentFromAction: () => null, recordSelfHealEvent: jest.fn(), resetSelfHealTelemetryForTests: jest.fn(),
  primeSelfHealTelemetryPersistence: primeTelemetry, stopSelfHealTelemetryPersistence: stopTelemetry,
}));
jest.unstable_mockModule('@platform/logging/telemetry.js', () => ({
  getTelemetrySnapshot: () => ({ traces: { recentEvents: [], recentLogs: [] } }),
  recordTraceEvent: jest.fn(), recordLogEvent: jest.fn(), markOperation: jest.fn(), onTelemetry: jest.fn(),
}));
jest.unstable_mockModule('@platform/runtime/redisLifecycle.js', () => ({
  executeRedisOperation: forbidden,
  getRedisLifecycleSnapshot: () => ({ configured: redisStarted, connected: false, readyGeneration: 0, state: redisStarted ? 'DEGRADED' : 'IDLE' }),
  startRedisLifecycle: startRedis, stopRedisLifecycle: stopRedis,
}));
jest.unstable_mockModule('@services/moduleCatalog.js', () => ({ MODULE_CATALOG: [], isPublicGptModule: () => false }));
jest.unstable_mockModule('@services/runtimeRouteTableService.js', () => ({ getActiveRouteTable: () => [] }));
jest.unstable_mockModule('@services/railwayClient.js', () => ({ deployService: forbidden, listProjects: forbidden, isRailwayApiConfigured: () => false }));
jest.unstable_mockModule('../src/workers/backstageNotionSyncLoop.js', () => ({
  createBackstageNotionSynchronizationCoordinator: () => ({}),
  startBackstageNotionSyncLoop: () => ({ stopAndDrain: stopNotion }),
}));
jest.unstable_mockModule('../src/workers/backstageNotionPartitionShadowLoop.js', () => ({
  resolveBackstageNotionPartitionShadowPolicy: () => ({ partitionSyncEnabled: false }),
  startBackstageNotionPartitionShadowLoop: () => ({ stopAndDrain: stopNotion }),
}));
jest.unstable_mockModule('../src/workers/backstageNotionPartitionSyncJob.js', () => ({ createBackstageNotionPartitionSyncJobExecutor: () => ({}) }));
jest.unstable_mockModule('@services/backstageNotionSync.js', () => ({
  BACKSTAGE_NOTION_SYNC_MAX_COLD_EMBEDDING_REQUESTS: 114,
  validateBackstageNotionSynchronizationConfiguration: () => ({ authorityConfigured: false, configuredUniverses: 0 }),
}));

// Actual exported production entry body, consumer polling and canonical loop.
// Storage, provider, Notion and telemetry transports remain deterministic mocks.
let worker: typeof import('../src/workers/jobRunner.js');
let coordinator: typeof import('../src/services/selfImprove/selfHealingLoop.js');
let diagnostics: typeof import('../src/services/runtimeDiagnosticsService.js');
let stdout: string[];
let originalListeners: { SIGTERM: Function[]; SIGINT: Function[] };

beforeEach(async () => {
  jest.resetModules();
  jest.clearAllMocks();
  redisStarted = false;
  jest.useFakeTimers({ doNotFake: ['setImmediate'] }).setSystemTime(new Date('2026-10-14T12:00:00Z'));
  originalListeners = { SIGTERM: process.listeners('SIGTERM'), SIGINT: process.listeners('SIGINT') };
  stdout = [];
  jest.spyOn(process.stdout, 'write').mockImplementation(((line: string) => { stdout.push(String(line)); return true; }) as typeof process.stdout.write);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(globalThis, 'fetch').mockImplementation(forbidden);
  worker = await import('../src/workers/jobRunner.js');
  coordinator = await import('../src/services/selfImprove/selfHealingLoop.js');
  diagnostics = await import('../src/services/runtimeDiagnosticsService.js');
  coordinator.resetSelfHealingLoopStateForTests();
  claimNextMock.mockResolvedValue({ job: null });
});
afterEach(async () => {
  signalShutdown();
  await coordinator.stopSelfHealingLoop();
  coordinator.resetSelfHealingLoopStateForTests();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    for (const listener of process.listeners(signal)) {
      if (!originalListeners[signal].includes(listener)) process.removeListener(signal, listener);
    }
  }
  expect(forbidden).not.toHaveBeenCalled();
  jest.restoreAllMocks();
  jest.useRealTimers();
});
afterAll(() => { process.env = originalEnvironment; });

function signalShutdown() {
  for (const listener of process.listeners('SIGTERM')) {
    if (!originalListeners.SIGTERM.includes(listener)) listener('SIGTERM');
  }
}
async function flushUntil(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i += 1) await new Promise<void>(resolve => setImmediate(resolve));
  expect(predicate()).toBe(true);
}

describe('actual production worker bootstrap with external boundaries replaced', () => {
  it('starts one coordinator after dependencies and slots, contains collector failure, and drains on SIGTERM', async () => {
    jest.spyOn(diagnostics.runtimeDiagnosticsService, 'getRollingRequestWindow')
      .mockImplementationOnce(() => { throw new Error('synthetic collector unavailable'); });
    const running = worker.runJobWorker();
    await flushUntil(() => stdout.some(line => line.includes('ARCANOS_WORKER_BOOTSTRAP_READY_V1')));
    await flushUntil(() => coordinator.getSelfHealingLoopStatus().coordinatorState === 'FAILED');
    expect(initializeDatabaseMock).toHaveBeenCalledTimes(1);
    expect(initializeModuleRegistryMock).toHaveBeenCalledTimes(1);
    expect(dispatcherStarted).toHaveBeenCalledTimes(2);
    expect(startRedis).toHaveBeenCalledTimes(1);
    expect(primeTelemetry).toHaveBeenCalledTimes(1);
    expect(startRedis.mock.invocationCallOrder[0]).toBeLessThan(dispatcherStarted.mock.invocationCallOrder[0]);
    const { getKillSwitchStatus } = await import('../src/services/incidentResponse/killSwitch.js');
    expect(await getKillSwitchStatus()).toMatchObject({ frozen: true, autonomyLevel: 0 });
    expect(initializeDatabaseMock.mock.invocationCallOrder[0]).toBeLessThan(initializeModuleRegistryMock.mock.invocationCallOrder[0]);
    const started = lifecycleLog.info.mock.calls.findIndex(([event]) => event === 'self_heal.coordinator.started');
    const slots = lifecycleLog.info.mock.calls.map(([event], index) => event === 'worker.slot.started' ? index : -1).filter(index => index >= 0);
    expect(slots).toHaveLength(2);
    expect(slots.every(index => index < started)).toBe(true);
    coordinator.startSelfHealingLoop();
    expect(lifecycleLog.info.mock.calls.filter(([event]) => event === 'self_heal.coordinator.started')).toHaveLength(1);
    const claimsBefore = claimNextMock.mock.calls.length;
    await jest.advanceTimersByTimeAsync(2_000);
    expect(coordinator.getSelfHealingLoopStatus().coordinatorState).toBe('RUNNING');
    expect(claimNextMock.mock.calls.length).toBeGreaterThan(claimsBefore);
    expect(workerHeartbeat).toHaveBeenCalled();
    signalShutdown();
    await running;
    const tickCount = coordinator.getSelfHealingLoopStatus().tickCount;
    await jest.advanceTimersByTimeAsync(5_000);
    expect(coordinator.getSelfHealingLoopStatus()).toMatchObject({ coordinatorState: 'BLOCKED', loopRunning: false, tickCount });
    expect(stopNotion).toHaveBeenCalledTimes(2);
    expect(flushSnapshots).toHaveBeenCalledTimes(3);
    expect(stopTelemetry).toHaveBeenCalledTimes(1);
    expect(stopRedis).toHaveBeenCalledTimes(1);
  });

  it('rejects coordinator installation failure before the production readiness sentinel', async () => {
    const realSetInterval = globalThis.setInterval;
    jest.spyOn(globalThis, 'setInterval').mockImplementation(((callback: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => {
      if (ms === 1_000) throw new Error('synthetic scheduler unavailable');
      return realSetInterval(callback, ms, ...args);
    }) as typeof setInterval);
    await expect(worker.runJobWorker()).rejects.toThrow('synthetic scheduler unavailable');
    expect(stdout.some(line => line.includes('ARCANOS_WORKER_BOOTSTRAP_READY_V1'))).toBe(false);
    expect(coordinator.getSelfHealingLoopStatus()).toMatchObject({ coordinatorState: 'FAILED', loopRunning: false });
    expect(lifecycleLog.error).toHaveBeenCalledWith('self_heal.coordinator.start_failed', expect.objectContaining({ reasonCode: 'scheduler_start_failed' }));
    signalShutdown();
    await jest.advanceTimersByTimeAsync(1);
  });
});
