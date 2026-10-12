import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { TrinityRunOptions } from '../src/core/logic/trinityTypes.js';
import { startGenerativeModelPolicyProvider } from './fixtures/generative-model-policy-provider.js';

// Local ownership/delivery proof: real coordinator, mitigation state, Trinity
// facade, SDK and loopback transport; no provider, database or worker effects.
const originalEnvironment = process.env;
const authorityModel = 'ft:gpt-4.1:synthetic:healing-consumer';
const prompt = 'Assess the supplied launch outline and its stated limitations.';
const answer = 'The supplied outline describes a staged release.';
const scores = { clarity: 5, leverage: 5, efficiency: 5, alignment: 5, resilience: 5, overall: 5 };
const noEffect = jest.fn(async () => { throw new Error('Offline fixture forbids persistence and runtime effects.'); });
const getRollingRequestWindow = jest.fn();
const getRequestWindowSince = jest.fn();
const runPredictiveHealingFromLoop = jest.fn(async () => {
  throw new Error('Offline fixture: predictive advisor unavailable.');
});
let clockMs: number;

function isolatedEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...originalEnvironment };
  for (const name of [
    'FINETUNED_MODEL_ID', 'RAILWAY_FINETUNED_MODEL_ID', 'FINE_TUNED_MODEL_ID',
    'RAILWAY_FINE_TUNED_MODEL_ID', 'AI_MODEL', 'RAILWAY_AI_MODEL',
    'OPENAI_MODEL', 'RAILWAY_OPENAI_MODEL', 'RAILWAY_RAILWAY_OPENAI_MODEL',
    'OPENAI_API_KEY', 'RAILWAY_OPENAI_API_KEY', 'OPENAI_KEY', 'API_KEY',
    'OPENAI_BASE_URL', 'RAILWAY_OPENAI_BASE_URL',
    'DATABASE_URL', 'RAILWAY_DATABASE_URL', 'DATABASE_PRIVATE_URL', 'DATABASE_PUBLIC_URL',
    'REDIS_URL', 'REDIS_HOST', 'REDISHOST', 'RAILWAY_API_TOKEN', 'RAILWAY_TOKEN',
    'RAILWAY_PROJECT_ID', 'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_SERVICE_ID', 'RAILWAY_DEPLOYMENT_ID',
    'RAILWAY_SERVICE_NAME', 'SELF_HEAL_DEBUG_FORCE_AI_HEAL_ONCE'
  ]) environment[name] = '';
  return {
    ...environment, NODE_ENV: 'test', FINETUNED_MODEL_ID: authorityModel,
    ARCANOS_PROCESS_KIND: 'worker', RUN_WORKERS: 'false',
    SELF_IMPROVE_ENABLED: 'true', SELF_IMPROVE_ACTUATOR_MODE: 'daemon',
    SELF_IMPROVE_AUTONOMY_LEVEL: '3', SELF_IMPROVE_FREEZE: 'false',
    PREDICTIVE_HEALING_ENABLED: 'false', PREDICTIVE_AUTO_EXECUTE: 'false',
    PREDICTIVE_HEALING_DRY_RUN: 'true', TRINITY_JUDGED_FEEDBACK_ENABLED: 'false',
    ENABLE_SELF_HEAL_CONTROL_LOOP_IN_TESTS: 'true',
    ARCANOS_CONTEXT_MODE: 'disabled', AI_TRACE_LOGGING: 'false', LOG_LEVEL: 'error'
  };
}

function requestWindow(degraded = true) {
  return {
    generatedAt: new Date(clockMs).toISOString(), windowMs: 300_000,
    requestCount: 12, errorCount: 0, clientErrorCount: 0, serverErrorCount: 0,
    errorRate: 0, timeoutCount: 0, timeoutRate: 0,
    pipelineTimeoutCount: 0, providerTimeoutCount: 0, workerTimeoutCount: 0,
    budgetAbortCount: 0, degradedCount: 0, degradedReasons: [], bypassedSubsystems: [],
    slowRequestCount: degraded ? 12 : 0,
    avgLatencyMs: degraded ? 8_000 : 100,
    p95LatencyMs: degraded ? 14_000 : 100,
    maxLatencyMs: degraded ? 20_000 : 100, routes: []
  };
}

jest.unstable_mockModule('@services/memoryAware.js', () => ({ getMemoryContext: noEffect, storePattern: noEffect }));
jest.unstable_mockModule('@services/judgedResponseFeedback.js', () => ({ processJudgedResponseFeedback: noEffect }));
jest.unstable_mockModule('@services/selfImprove/controller.js', () => ({ runSelfImproveCycle: noEffect }));
jest.unstable_mockModule('@core/db/repositories/jobEventRepository.js', () => ({ recordJobEvent: noEffect }));
jest.unstable_mockModule('@core/db/repositories/workerBudgetRepository.js', () => ({
  reserveWorkerAiProviderAttempt: noEffect, WORKER_BUDGET_NON_JOB_SUBJECT_ID: 'synthetic-non-job'
}));
jest.unstable_mockModule('@core/db/repositories/jobRepository.js', () => ({ recoverStaleJobs: noEffect }));
jest.unstable_mockModule('@platform/runtime/workerConfig.js', () => ({
  getWorkerRuntimeStatus: () => ({
    enabled: false, model: authorityModel, configuredCount: 0, started: false,
    activeListeners: 0, workerIds: [], totalDispatched: 0
  }), recycleWorker: noEffect, scaleWorkersUp: noEffect, healWorkerRuntime: noEffect
}));
jest.unstable_mockModule('@services/workerControlService.js', () => ({
  getWorkerControlHealth: async () => ({
    overallStatus: 'healthy', queueSummary: { pending: 0, running: 0, stalledRunning: 0, oldestPendingJobAgeMs: 0 },
    workers: [], alerts: []
  }), healWorkerRuntime: noEffect
}));
jest.unstable_mockModule('@services/workerAutonomyService.js', () => ({
  getWorkerAutonomySettings: () => ({ staleAfterMs: 60_000, watchdogIdleMs: 120_000, defaultMaxRetries: 2 })
}));
jest.unstable_mockModule('@services/runtimeDiagnosticsService.js', () => ({
  runtimeDiagnosticsService: { getRollingRequestWindow, getRequestWindowSince }
}));
jest.unstable_mockModule('@platform/logging/telemetry.js', () => ({
  getTelemetrySnapshot: () => ({ traces: { recentEvents: [], recentLogs: [] } }),
  recordLogEvent: jest.fn(), recordTraceEvent: jest.fn(), markOperation: jest.fn(),
  onTelemetry: jest.fn(), resetTelemetry: jest.fn()
}));
jest.unstable_mockModule('@services/openai/serviceHealth.js', () => ({
  getOpenAIServiceHealth: () => ({ circuitBreaker: { state: 'CLOSED' }, providerRuntime: {} }),
  reinitializeOpenAIProvider: noEffect
}));
jest.unstable_mockModule('@services/selfImprove/predictiveHealingService.js', () => ({ runPredictiveHealingFromLoop }));
jest.unstable_mockModule('@services/selfImprove/selfHealTelemetry.js', () => ({
  inferSelfHealComponentFromAction: () => null,
  recordSelfHealEvent: jest.fn(),
  resetSelfHealTelemetryForTests: jest.fn()
}));

let pipeline: typeof import('../src/core/logic/trinityWritingPipeline.js');
let budget: typeof import('../src/platform/resilience/runtimeBudget.js');
let adapter: typeof import('../src/core/adapters/openai.adapter.js');
let credentials: typeof import('../src/services/openai/credentialProvider.js');
let healing: typeof import('../src/services/selfImprove/selfHealingV2.js');
let coordinator: typeof import('../src/services/selfImprove/selfHealingLoop.js');
let legacy: typeof import('../src/services/selfImprove/controlLoop.js');
let completions: typeof import('../src/services/openai/chatFallbacks.js');
let resilience: typeof import('../src/services/openai/resilience.js');
let fixture: Awaited<ReturnType<typeof startGenerativeModelPolicyProvider>>;

beforeAll(async () => {
  process.env = isolatedEnvironment();
  const actualAuditSafe = await import('../src/services/auditSafe.js');
  jest.unstable_mockModule('@services/auditSafe.js', () => ({ ...actualAuditSafe, logAITaskLineage: jest.fn() }));
  pipeline = await import('../src/core/logic/trinityWritingPipeline.js');
  budget = await import('../src/platform/resilience/runtimeBudget.js');
  adapter = await import('../src/core/adapters/openai.adapter.js');
  credentials = await import('../src/services/openai/credentialProvider.js');
  healing = await import('../src/services/selfImprove/selfHealingV2.js');
  coordinator = await import('../src/services/selfImprove/selfHealingLoop.js');
  legacy = await import('../src/services/selfImprove/controlLoop.js');
  completions = await import('../src/services/openai/chatFallbacks.js');
  resilience = await import('../src/services/openai/resilience.js');
});

beforeEach(async () => {
  process.env = isolatedEnvironment();
  clockMs = Date.parse('2026-10-12T09:00:00.000Z');
  // Keep native socket/timer behavior while fixing both Date.now and new Date.
  jest.useFakeTimers({ doNotFake: [
    'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate',
    'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'
  ] }).setSystemTime(clockMs);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  fixture = await startGenerativeModelPolicyProvider({ authorityModel, maxRequests: 24 });
  process.env.OPENAI_API_KEY = fixture.apiKey;
  process.env.OPENAI_BASE_URL = fixture.baseURL;
  credentials.resetCredentialCache();
  adapter.resetOpenAIAdapter();
  healing.resetTrinitySelfHealingStateForTests();
  coordinator.resetSelfHealingLoopStateForTests();
  legacy.stopSelfHealingControlLoopForTests();
  getRollingRequestWindow.mockImplementation(() => requestWindow());
  getRequestWindowSince.mockImplementation(() => requestWindow());
  adapter.getOpenAIAdapter({
    apiKey: fixture.apiKey, baseURL: fixture.baseURL, defaultModel: authorityModel,
    timeout: 2_000, maxRetries: 0, fetch: fixture.fetch
  });
});

afterEach(async () => {
  coordinator.resetSelfHealingLoopStateForTests();
  legacy.stopSelfHealingControlLoopForTests();
  healing.resetTrinitySelfHealingStateForTests();
  adapter.resetOpenAIAdapter();
  credentials.resetCredentialCache();
  await fixture.close();
  jest.useRealTimers();
  expect(noEffect).not.toHaveBeenCalled();
});

afterAll(() => { process.env = originalEnvironment; });

function enqueueNormal(tier: 'simple' | 'complex' = 'simple') {
  fixture.enqueue(
    { kind: 'completion', text: 'Assess only the supplied launch outline.' },
    { kind: 'completion', text: JSON.stringify({
      response_mode: 'answer', achievable_subtasks: ['Assess the supplied outline'],
      blocked_subtasks: [], user_visible_caveats: [], claim_tags: [], final_answer: 'Synthetic internal draft.',
      ...(tier === 'simple' ? {} : {
        reasoning_steps: ['Consider only the supplied outline.'], assumptions: [], constraints: [],
        tradeoffs: [], alternatives_considered: [], chosen_path_justification: 'A bounded assessment.'
      })
    }) },
    { kind: 'completion', text: JSON.stringify(scores) },
    { kind: 'completion', text: answer }
  );
}

async function runTrinity(complex = false, runOptions: TrinityRunOptions = {}) {
  const userPrompt = complex ? 'Explain the architecture of the supplied launch outline.' : prompt;
  return pipeline.runTrinityWritingPipeline({
    input: {
      prompt: userPrompt, moduleId: 'ARCANOS:CORE', sourceEndpoint: 'self-healing.local-fixture',
      requestedAction: 'query', body: { prompt: userPrompt }, executionMode: 'request'
    },
    context: {
      client: adapter.getOpenAIAdapter().getClient(), runtimeBudget: budget.createRuntimeBudgetWithLimit(20_000, 0),
      runOptions: { ...runOptions, disableMemoryAccess: true, disableOptionalSideEffects: true, strictUserVisibleOutput: true }
    }
  });
}

describe('canonical self-healing owner through the real Trinity consumer', () => {
  it('keeps a healthy real consumer on its normal path without an unnecessary mitigation', async () => {
    getRollingRequestWindow.mockImplementation(() => requestWindow(false));
    getRequestWindowSince.mockImplementation(() => requestWindow(false));
    const tick = await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    expect(tick).toMatchObject({ diagnosis: 'healthy', action: null, controllerDecision: null });

    enqueueNormal();
    const normal = await runTrinity();
    expect(normal.routingStages).toEqual(['ARCANOS-INTAKE:gpt-6-luna', 'GPT5-REASONING', 'ARCANOS-FINAL']);
    expect(fixture.requests.filter(request => request.method === 'POST')).toHaveLength(4);
    for (const stage of Object.values(healing.getTrinitySelfHealingSnapshot())) {
      expect(stage).toMatchObject({ activeAction: null, attempts: 0, verificationSuccesses: 0 });
    }
  });

  it('detects one real transport timeout, bounds recovery and leaves the incident threshold unmet', async () => {
    getRollingRequestWindow.mockImplementation(() => requestWindow(false));
    getRequestWindowSince.mockImplementation(() => requestWindow(false));
    const stages: Parameters<NonNullable<TrinityRunOptions['onStage']>>[0][] = [];
    fixture.enqueue({ kind: 'timeout', holdForMs: 1_000 }, { kind: 'completion', text: answer });
    const recovered = await runTrinity(false, {
      resolveModelStageTimeoutMs: stage => stage === 'intake' ? 100 : 2_000,
      onStage: stage => { stages.push(stage); }
    });
    expect(stages).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'intake', phase: 'failed', timedOut: true })
    ]));
    expect(recovered.routingStages).toContain('ARCANOS-DIRECT-ANSWER');
    const attempts = fixture.requests.filter(request => request.method === 'POST');
    expect(attempts.map(request => request.model)).toEqual(['gpt-6-luna', authorityModel]);
    await fixture.waitForStreamClose(fixture.requests.indexOf(attempts[0]));
    expect(attempts[0].streamClosed).toBe(true);
    expect(healing.getTrinitySelfHealingSnapshot().intake).toMatchObject({
      observations: [clockMs], attempts: 0, activeAction: null
    });
    expect((await coordinator.runSelfHealingLoop({ trigger: 'interval' })).action).toBeNull();

    enqueueNormal();
    expect((await runTrinity()).routingStages).toContain('GPT5-REASONING');
    expect(fixture.requests.filter(request => request.method === 'POST')).toHaveLength(6);
    expect(healing.getTrinitySelfHealingSnapshot().intake.attempts).toBe(0);
    expect(resilience.getCircuitBreakerSnapshot()).toMatchObject({ state: 'CLOSED', failureCount: 0 });
  });

  it('bounds sustained real provider failures at the authorized model and fails closed before recovery', async () => {
    getRollingRequestWindow.mockImplementation(() => requestWindow(false));
    getRequestWindowSince.mockImplementation(() => requestWindow(false));
    fixture.enqueue(...Array.from({ length: 5 }, () => ({ kind: 'error' as const, status: 503 as const })));
    await expect(runTrinity()).rejects.toThrow('Synthetic bounded provider rejection.');
    await expect(completions.createChatCompletionWithFallback(adapter.getOpenAIAdapter(), {
      messages: [{ role: 'user', content: prompt }], max_tokens: 64, maxRetries: 0, timeoutMs: 2_000
    })).rejects.toThrow('COMPLETE FAILURE');
    const attempts = fixture.requests.filter(request => request.method === 'POST');
    expect(attempts.map(request => request.model)).toEqual([
      'gpt-6-luna', authorityModel, authorityModel, authorityModel, authorityModel
    ]);
    expect(attempts.every(request => request.authorizationAccepted)).toBe(true);
    const opened = resilience.getCircuitBreakerSnapshot();
    expect(opened).toMatchObject({ state: 'OPEN', failureCount: 5 });
    await expect(completions.createSingleChatCompletion(adapter.getOpenAIAdapter(), {
      messages: [{ role: 'user', content: prompt }], max_tokens: 64, maxRetries: 0
    })).rejects.toThrow('Circuit breaker is OPEN');
    expect(fixture.requests.filter(request => request.method === 'POST')).toHaveLength(5);
    for (const stage of Object.values(healing.getTrinitySelfHealingSnapshot())) {
      expect(stage).toMatchObject({ activeAction: null, attempts: 0 });
    }

    // Reset is measured with two successful local transport probes, never a live provider.
    clockMs = opened.lastFailureTime + opened.constants.CIRCUIT_BREAKER_RESET_TIMEOUT_MS + 1;
    jest.setSystemTime(clockMs);
    fixture.enqueue({ kind: 'completion', text: answer }, { kind: 'completion', text: answer });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await completions.createSingleChatCompletion(adapter.getOpenAIAdapter(), {
        messages: [{ role: 'user', content: prompt }], max_tokens: 64, maxRetries: 0
      });
    }
    expect(resilience.getCircuitBreakerSnapshot()).toMatchObject({ state: 'CLOSED', failureCount: 0 });
    expect((await coordinator.runSelfHealingLoop({ trigger: 'interval' })).action).toBeNull();
    enqueueNormal();
    expect((await runTrinity()).routingStages).toContain('GPT5-REASONING');
  });

  it('changes only simple Trinity decisions, avoids competing actuation and expires at the TTL', async () => {
    enqueueNormal();
    const normal = await runTrinity();
    expect(normal.routingStages).toEqual(['ARCANOS-INTAKE:gpt-6-luna', 'GPT5-REASONING', 'ARCANOS-FINAL']);

    const firstTick = coordinator.runSelfHealingLoop({ trigger: 'interval' });
    const duplicateTick = coordinator.runSelfHealingLoop({ trigger: 'interval' });
    const [produced, duplicate] = await Promise.all([firstTick, duplicateTick]);
    expect(produced.action).toBe('activateTrinityMitigation:reasoning:enable_degraded_mode');
    expect(duplicate.action).toBeNull();
    expect(healing.getTrinitySelfHealingSnapshot().reasoning).toMatchObject({
      activeAction: 'enable_degraded_mode', attempts: 1
    });

    legacy.startSelfHealingControlLoop({} as never);
    await legacy.requestSelfHealingLoopEvaluation('competing_owner');
    expect(legacy.getSelfHealingControlLoopStatus()).toMatchObject({ loopRunning: false, incidentActive: false });
    expect(healing.getTrinitySelfHealingSnapshot().reasoning).toMatchObject({
      activeAction: 'enable_degraded_mode', attempts: 1
    });

    const beforeDirect = fixture.requests.length;
    fixture.enqueue({ kind: 'completion', text: answer });
    const mitigated = await runTrinity();
    expect(mitigated.routingStages).toContain('ARCANOS-DIRECT-ANSWER');
    expect(fixture.requests.slice(beforeDirect).filter(request => request.method === 'POST')).toHaveLength(1);
    expect(healing.getTrinitySelfHealingSnapshot().reasoning.verificationSuccesses).toBe(1);

    enqueueNormal('complex');
    expect((await runTrinity(true)).routingStages).toContain('GPT5-REASONING');
    const expiresAt = healing.getTrinitySelfHealingSnapshot().reasoning.expiresAtMs!;
    clockMs = expiresAt;
    jest.setSystemTime(clockMs);
    enqueueNormal();
    expect((await runTrinity()).routingStages).toContain('GPT5-REASONING');
    expect(healing.getTrinitySelfHealingSnapshot().reasoning.activeAction).toBeNull();
  });

  it('rolls back ineffective mitigation before another advisor call and restores the normal decision', async () => {
    expect((await coordinator.runSelfHealingLoop({ trigger: 'interval' })).action).toContain('activateTrinityMitigation:');
    const advisorCalls = runPredictiveHealingFromLoop.mock.calls.length;
    const actionStartedAt = coordinator.getSelfHealingLoopStatus().lastActionAt;
    clockMs += 90_000;
    jest.setSystemTime(clockMs);
    // This supplies new post-action traffic; a quiet runtime cannot prove failure or recovery.
    getRequestWindowSince.mockReturnValue(requestWindow());
    const rollback = await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    expect(rollback.action).toBe('rollbackTrinityMitigation:reasoning:enable_degraded_mode');
    expect(runPredictiveHealingFromLoop).toHaveBeenCalledTimes(advisorCalls);
    expect(healing.getTrinitySelfHealingSnapshot().reasoning.activeAction).toBeNull();
    expect(getRequestWindowSince).toHaveBeenCalledWith(actionStartedAt, 300_000);
    enqueueNormal();
    expect((await runTrinity()).routingStages).toContain('GPT5-REASONING');
  });

  it('fails closed on an unavailable predictive advisor when prediction owns the tick', async () => {
    process.env.PREDICTIVE_HEALING_ENABLED = 'true';
    expect((await coordinator.runSelfHealingLoop({ trigger: 'interval' })).action).toBeNull();
    expect(healing.getTrinitySelfHealingSnapshot().reasoning.attempts).toBe(0);
    enqueueNormal();
    expect((await runTrinity()).routingStages).toContain('GPT5-REASONING');
  });

  it('suppresses automatic startup and interval entrypoints for a web-only service role', async () => {
    process.env.ARCANOS_PROCESS_KIND = 'web';
    expect(coordinator.startSelfHealingLoop().loopRunning).toBe(false);
    await coordinator.runSelfHealingLoop({ trigger: 'startup' });
    await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    expect(runPredictiveHealingFromLoop).not.toHaveBeenCalled();
    expect(getRollingRequestWindow).not.toHaveBeenCalled();
    expect(healing.getTrinitySelfHealingSnapshot().reasoning.attempts).toBe(0);
  });

  it('preserves explicitly requested manual mitigation and its web Trinity consumer', async () => {
    process.env.ARCANOS_PROCESS_KIND = 'web';
    expect((await coordinator.runSelfHealingLoop({ trigger: 'manual' })).action).toBe(
      'activateTrinityMitigation:reasoning:enable_degraded_mode'
    );
    fixture.enqueue({ kind: 'completion', text: answer });
    expect((await runTrinity()).routingStages).toContain('ARCANOS-DIRECT-ANSWER');
    expect(healing.getTrinitySelfHealingSnapshot().reasoning.verificationSuccesses).toBe(1);
  });
});
