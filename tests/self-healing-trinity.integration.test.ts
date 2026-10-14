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
const runSelfImproveCycle = jest.fn(async () => ({
  id: 'synthetic-noop-audit', decision: 'NOOP', autonomyLevel: 3,
  frozen: false, drift: { kind: 'none' }, evidencePath: 'synthetic:no-filesystem-write'
}));
const getRollingRequestWindow = jest.fn();
const getRequestWindowSince = jest.fn();
const runPredictiveHealingFromLoop = jest.fn(async () => {
  throw new Error('Offline fixture: predictive advisor unavailable.');
});
const providerReload = jest.fn(async () => ({
  ok: true, skipped: false, reloaded: true, reason: null, runtime: {}
}));
const providerTraceEvents: {
  id: string; timestamp: string; name: string; attributes: Record<string, unknown>
}[] = [];
let captureProviderReceipts = false;
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

function requestWindow(degraded = true, requestCount = 12) {
  return {
    generatedAt: new Date(clockMs).toISOString(), windowMs: 300_000,
    requestCount, errorCount: 0, clientErrorCount: 0, serverErrorCount: 0,
    errorRate: 0, timeoutCount: 0, timeoutRate: 0,
    pipelineTimeoutCount: 0, providerTimeoutCount: 0, workerTimeoutCount: 0,
    budgetAbortCount: 0, degradedCount: 0, degradedReasons: [], bypassedSubsystems: [],
    slowRequestCount: degraded ? requestCount : 0,
    avgLatencyMs: degraded ? 8_000 : 100,
    p95LatencyMs: degraded ? 14_000 : 100,
    maxLatencyMs: degraded ? 20_000 : 100,
    routes: [{
      route: '/api/arcanos/ask', requestCount, errorCount: 0, timeoutCount: 0,
      pipelineTimeoutCount: 0, providerTimeoutCount: 0, workerTimeoutCount: 0,
      budgetAbortCount: 0, degradedCount: 0, slowRequestCount: degraded ? requestCount : 0,
      avgLatencyMs: degraded ? 8_000 : 100, p95LatencyMs: degraded ? 14_000 : 100,
      maxLatencyMs: degraded ? 20_000 : 100
    }]
  };
}

jest.unstable_mockModule('@services/memoryAware.js', () => ({ getMemoryContext: noEffect, storePattern: noEffect }));
jest.unstable_mockModule('@services/judgedResponseFeedback.js', () => ({ processJudgedResponseFeedback: noEffect }));
// The optional proposal controller writes evidence; its no-drift NOOP is a
// deterministic persistence seam. Detection/authorization/actuation stay real.
jest.unstable_mockModule('@services/selfImprove/controller.js', () => ({ runSelfImproveCycle }));
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
  getTelemetrySnapshot: () => ({ traces: { recentEvents: providerTraceEvents, recentLogs: [] } }),
  recordLogEvent: jest.fn(), recordTraceEvent: jest.fn((name: string, attributes: Record<string, unknown> = {}) => {
    if (captureProviderReceipts) {
      providerTraceEvents.push({
        id: `synthetic-trace-${providerTraceEvents.length}`, timestamp: new Date().toISOString(), name, attributes
      });
      if (providerTraceEvents.length > 256) throw new Error('Synthetic provider trace bound exceeded.');
    }
  }), markOperation: jest.fn(),
  onTelemetry: jest.fn(), resetTelemetry: jest.fn()
}));
jest.unstable_mockModule('@services/openai/serviceHealth.js', () => ({
  getOpenAIServiceHealth: () => ({ circuitBreaker: { state: 'CLOSED' }, providerRuntime: {} }),
  // Reload acknowledgement is a synthetic external-runtime seam. Provider
  // success evidence below is emitted by the actual resilience/SDK consumer.
  reinitializeOpenAIProvider: providerReload
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
let killSwitch: typeof import('../src/services/incidentResponse/killSwitch.js');
let coordinator: typeof import('../src/services/selfImprove/selfHealingLoop.js');
let legacy: typeof import('../src/services/selfImprove/controlLoop.js');
let completions: typeof import('../src/services/openai/chatFallbacks.js');
let resilience: typeof import('../src/services/openai/resilience.js');
let requestAbortContext: typeof import('@arcanos/runtime');
let fixture: Awaited<ReturnType<typeof startGenerativeModelPolicyProvider>>;
let interceptResponse: (() => Promise<void>) | null;
let interceptRequest: (() => void) | null;

beforeAll(async () => {
  process.env = isolatedEnvironment();
  const actualAuditSafe = await import('../src/services/auditSafe.js');
  jest.unstable_mockModule('@services/auditSafe.js', () => ({ ...actualAuditSafe, logAITaskLineage: jest.fn() }));
  pipeline = await import('../src/core/logic/trinityWritingPipeline.js');
  budget = await import('../src/platform/resilience/runtimeBudget.js');
  adapter = await import('../src/core/adapters/openai.adapter.js');
  credentials = await import('../src/services/openai/credentialProvider.js');
  healing = await import('../src/services/selfImprove/selfHealingV2.js');
  killSwitch = await import('../src/services/incidentResponse/killSwitch.js');
  coordinator = await import('../src/services/selfImprove/selfHealingLoop.js');
  legacy = await import('../src/services/selfImprove/controlLoop.js');
  completions = await import('../src/services/openai/chatFallbacks.js');
  resilience = await import('../src/services/openai/resilience.js');
  requestAbortContext = await import('@arcanos/runtime');
});

beforeEach(async () => {
  process.env = isolatedEnvironment();
  providerTraceEvents.length = 0;
  captureProviderReceipts = false;
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
  await killSwitch.unfreezeSelfImprove('synthetic reset');
  await killSwitch.setAutonomyLevel(3, 'synthetic reset');
  coordinator.resetSelfHealingLoopStateForTests();
  legacy.stopSelfHealingControlLoopForTests();
  getRollingRequestWindow.mockImplementation(() => requestWindow());
  getRequestWindowSince.mockImplementation(() => requestWindow());
  interceptResponse = null;
  interceptRequest = null;
  adapter.getOpenAIAdapter({
    apiKey: fixture.apiKey, baseURL: fixture.baseURL, defaultModel: authorityModel,
    timeout: 2_000, maxRetries: 0, fetch: async (input, init) => {
      if (init?.method === 'POST' && interceptRequest) interceptRequest();
      const response = await fixture.fetch(input, init);
      if (init?.method === 'POST' && interceptResponse) await interceptResponse();
      return response;
    }
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

async function runTrinity(complex = false, runOptions: TrinityRunOptions = {}, promptSuffix = '') {
  const userPrompt = (complex ? 'Explain the architecture of the supplied launch outline.' : prompt) + promptSuffix;
  return pipeline.runTrinityWritingPipeline({
    input: {
      prompt: userPrompt, moduleId: 'ARCANOS:CORE', sourceEndpoint: '/api/arcanos/ask',
      requestedAction: 'query', body: { prompt: userPrompt }, executionMode: 'request'
    },
    context: {
      client: adapter.getOpenAIAdapter().getClient(), runtimeBudget: budget.createRuntimeBudgetWithLimit(20_000, 0),
      runOptions: { ...runOptions, disableMemoryAccess: true, disableOptionalSideEffects: true, strictUserVisibleOutput: true }
    }
  });
}

describe('canonical self-healing owner through the real Trinity consumer', () => {
  it('does not verify a replacement command with the older consumer request completion', async () => {
    const first = healing.activateTrinitySelfHealingMitigation({
      stage: 'reasoning', action: 'enable_degraded_mode', reason: 'first synthetic incident'
    });
    clockMs = first.expiresAtMs! - 1;
    jest.setSystemTime(clockMs);
    let arrived!: () => void;
    let release!: () => void;
    const responseArrived = new Promise<void>(resolve => { arrived = resolve; });
    const responseRelease = new Promise<void>(resolve => { release = resolve; });
    interceptResponse = async () => {
      interceptResponse = null;
      arrived();
      await responseRelease;
    };
    fixture.enqueue({ kind: 'completion', text: answer });
    const olderRequest = runTrinity();
    await responseArrived;
    clockMs += 1;
    jest.setSystemTime(clockMs);
    const replacement = healing.activateTrinitySelfHealingMitigation({
      stage: 'reasoning', action: 'enable_degraded_mode', reason: 'replacement synthetic incident'
    });
    expect(replacement.applied).toBe(true);
    release();
    const completed = await olderRequest;
    expect(completed.routingStages).toContain('ARCANOS-DIRECT-ANSWER');
    expect(fixture.requests.filter(request => request.method === 'POST')).toHaveLength(1);
    expect(healing.getTrinitySelfHealingSnapshot().reasoning).toMatchObject({
      activeAction: 'enable_degraded_mode', verificationSuccesses: 0, verificationFailures: 0
    });
  });

  it('does not credit a replacement when an older architectural intake times out into fallback', async () => {
    const first = healing.activateTrinitySelfHealingMitigation({
      stage: 'intake', action: 'enable_degraded_mode', reason: 'first synthetic intake incident'
    });
    clockMs = first.expiresAtMs! - 1;
    jest.setSystemTime(clockMs);
    let requestStarted!: () => void;
    const requestSent = new Promise<void>(resolve => { requestStarted = resolve; });
    interceptRequest = () => {
      interceptRequest = null;
      requestStarted();
    };
    // The SDK fetch-entry gate captures the old request before native transport
    // starts. Its promise continuation runs after that synchronous fetch entry,
    // so replacement is acknowledged before the bounded one-second stage abort.
    fixture.enqueue({ kind: 'timeout', holdForMs: 2_000 }, { kind: 'completion', text: answer });
    const olderRequest = runTrinity(false, {
      internalMode: true, resolveModelStageTimeoutMs: stage => stage === 'intake' ? 1_000 : 2_000
    });
    await requestSent;
    clockMs += 1;
    jest.setSystemTime(clockMs);
    const replacement = healing.activateTrinitySelfHealingMitigation({
      stage: 'intake', action: 'enable_degraded_mode', reason: 'replacement synthetic intake incident'
    });
    expect(replacement.applied).toBe(true);
    expect((await olderRequest).routingStages).toContain('ARCANOS-DIRECT-ANSWER');
    expect(fixture.requests.filter(request => request.method === 'POST')).toHaveLength(2);
    expect(healing.getTrinitySelfHealingSnapshot().intake).toMatchObject({
      mitigationId: replacement.mitigationId, verificationSuccesses: 0, verificationFailures: 0
    });
  });

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
    expect(attempts[0]).toMatchObject({ streamClosed: true, timeoutBackstopFired: false });
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

  it.each(['freeze', 'autonomy'] as const)('blocks automatic Trinity activation under effective %s controls', async restriction => {
    for (let index = 0; index < 2; index += 1) {
      healing.recordTrinityStageFailure({ stage: 'intake', error: 'synthetic abort', requestId: `seed-${index}` });
    }
    if (restriction === 'freeze') await killSwitch.freezeSelfImprove('synthetic restriction');
    else await killSwitch.setAutonomyLevel(1, 'synthetic restriction');
    fixture.enqueue({ kind: 'timeout', holdForMs: 1_000 }, { kind: 'completion', text: answer });
    const result = await runTrinity(false, {
      resolveModelStageTimeoutMs: stage => stage === 'intake' ? 100 : 2_000
    });
    expect(result.routingStages).toContain('ARCANOS-DIRECT-ANSWER');
    expect(healing.getTrinitySelfHealingSnapshot().intake).toMatchObject({ attempts: 0, activeAction: null });
    expect(healing.getTrinitySelfHealingSnapshot().intake.observations).toHaveLength(2);
  });

  it('labels a finite timeout backstop separately from client-driven transport cancellation', async () => {
    fixture.enqueue({ kind: 'timeout', holdForMs: 10 });
    await expect(fixture.fetch(`${fixture.baseURL}/responses`, {
      method: 'POST', headers: {
        authorization: `Bearer ${fixture.apiKey}`, 'content-type': 'application/json'
      },
      body: JSON.stringify({ model: authorityModel, input: prompt })
    })).rejects.toThrow();
    expect(fixture.requests).toHaveLength(1);
    await fixture.waitForStreamClose(0);
    expect(fixture.requests[0]).toMatchObject({ streamClosed: true, timeoutBackstopFired: true });
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

  it('completes actual controller activation, three consumer executions, fresh recovery and expiry', async () => {
    getRollingRequestWindow.mockImplementation(() => requestWindow(false));
    getRequestWindowSince.mockImplementation(() => requestWindow(false));
    expect((await coordinator.runSelfHealingLoop({ trigger: 'interval' })).diagnosis).toBe('healthy');
    enqueueNormal();
    expect((await runTrinity()).routingStages).toContain('GPT5-REASONING');

    getRollingRequestWindow.mockImplementation(() => requestWindow());
    const incident = await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    expect(incident).toMatchObject({
      action: 'activateTrinityMitigation:reasoning:enable_degraded_mode'
    });
    const command = healing.getTrinitySelfHealingSnapshot().reasoning;
    const initialRequestCount = fixture.requests.filter(request => request.method === 'POST').length;
    for (let index = 0; index < 3; index += 1) {
      clockMs += 1;
      jest.setSystemTime(clockMs);
      fixture.enqueue({ kind: 'completion', text: answer });
      const result = await runTrinity();
      expect(result.routingStages).toContain('ARCANOS-DIRECT-ANSWER');
      expect(result.routingStages).not.toContain('GPT5-REASONING');
    }
    expect(fixture.requests.filter(request => request.method === 'POST').length - initialRequestCount).toBe(3);
    expect(healing.getTrinitySelfHealingSnapshot().reasoning).toMatchObject({
      verificationSuccesses: 3, verificationFailures: 0, mitigationId: command.mitigationId
    });
    expect(healing.getTrinitySelfHealingSnapshot().reasoning.verifiedAtMs).not.toBeNull();

    clockMs += 90_000;
    jest.setSystemTime(clockMs);
    const recoveredTraffic = requestWindow(false, 3);
    getRollingRequestWindow.mockReturnValue(recoveredTraffic);
    getRequestWindowSince.mockReturnValue(recoveredTraffic);
    await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    expect(coordinator.getSelfHealingLoopStatus().lastVerificationResult).toMatchObject({ outcome: 'improved' });
    expect(healing.getTrinitySelfHealingSnapshot().reasoning.activeAction).toBe('enable_degraded_mode');

    clockMs = command.expiresAtMs!;
    jest.setSystemTime(clockMs);
    enqueueNormal();
    expect((await runTrinity()).routingStages).toContain('GPT5-REASONING');
    expect(healing.getTrinitySelfHealingSnapshot().reasoning.activeAction).toBeNull();
    expect((await coordinator.runSelfHealingLoop({ trigger: 'interval' })).action).toBeNull();
  });

  it('verifies a synthetic provider reload only after actual SDK consumer success receipts and fresh route traffic', async () => {
    captureProviderReceipts = true;
    fixture.enqueue(...Array.from({ length: 3 }, () => ({ kind: 'error' as const, status: 503 as const })));
    for (let failure = 0; failure < 3; failure += 1) {
      await expect(completions.createSingleChatCompletion(adapter.getOpenAIAdapter(), {
        messages: [{ role: 'user', content: `${prompt} Synthetic failure ${failure}.` }],
        max_tokens: 64, maxRetries: 0, timeoutMs: 2_000
      })).rejects.toThrow('Synthetic bounded provider rejection.');
    }
    expect(providerTraceEvents.filter(event => event.name === 'openai.resilience.failure')).toHaveLength(3);
    const failedTraffic = requestWindow();
    failedTraffic.errorCount = failedTraffic.requestCount;
    failedTraffic.serverErrorCount = failedTraffic.requestCount;
    failedTraffic.errorRate = 1;
    failedTraffic.routes[0].errorCount = failedTraffic.requestCount;
    getRollingRequestWindow.mockReturnValue(failedTraffic);
    getRequestWindowSince.mockReturnValue(failedTraffic);
    const dispatched = await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    expect(dispatched.action).toContain('reinitializeOpenAIProvider:reloaded=true:ok=true');
    expect(providerReload).toHaveBeenCalledTimes(1);
    const reloadStartedAt = coordinator.getSelfHealingLoopStatus().lastActionAt!;
    expect(providerTraceEvents.filter(event => event.name === 'openai.resilience.success')).toHaveLength(0);

    const postsBeforeRecovery = fixture.requests.filter(request => request.method === 'POST').length;
    for (let recovery = 0; recovery < 3; recovery += 1) {
      clockMs += 1;
      jest.setSystemTime(clockMs);
      enqueueNormal();
      expect((await runTrinity(false, {}, ` Synthetic recovery ${recovery}.`)).routingStages).toContain('GPT5-REASONING');
    }
    const successReceipts = providerTraceEvents.filter(event => event.name === 'openai.resilience.success');
    expect(successReceipts.length).toBeGreaterThanOrEqual(3);
    expect(successReceipts.every(event => Date.parse(event.timestamp) > Date.parse(reloadStartedAt))).toBe(true);
    expect(fixture.requests.filter(request => request.method === 'POST').length - postsBeforeRecovery).toBe(12);
    expect(resilience.getCircuitBreakerSnapshot()).toMatchObject({ state: 'CLOSED', failureCount: 0 });

    clockMs += 90_000;
    jest.setSystemTime(clockMs);
    getRollingRequestWindow.mockReturnValue(requestWindow(false, 3));
    getRequestWindowSince.mockReturnValue(requestWindow(false, 3));
    const verified = await coordinator.runSelfHealingLoop({ trigger: 'interval' });
    expect(verified.verificationResult).toMatchObject({ action: 'reinitializeOpenAIProvider', outcome: 'improved' });
    expect(providerReload).toHaveBeenCalledTimes(1);
    expect(healing.getTrinitySelfHealingSnapshot().reasoning.activeAction).toBeNull();
  });

  it('isolates simultaneous stage commands and consumes final bypass after intake rollback', async () => {
    const intake = healing.activateTrinitySelfHealingMitigation({
      stage: 'intake', action: 'enable_degraded_mode', reason: 'synthetic intake incident'
    });
    const final = healing.activateTrinitySelfHealingMitigation({
      stage: 'final', action: 'bypass_final_stage', reason: 'synthetic final incident'
    });
    expect(intake.applied && final.applied).toBe(true);
    fixture.enqueue({ kind: 'completion', text: answer });
    expect((await runTrinity()).routingStages).toContain('ARCANOS-DIRECT-ANSWER');
    expect(healing.getTrinitySelfHealingSnapshot().intake.verificationSuccesses).toBe(1);
    expect(healing.getTrinitySelfHealingSnapshot().final.verificationSuccesses).toBe(0);
    expect(healing.rollbackTrinitySelfHealingMitigation({
      stage: 'intake', action: 'enable_degraded_mode', mitigationId: intake.mitigationId,
      reason: 'clear only intake incident'
    }).rolledBack).toBe(true);
    expect(healing.getTrinitySelfHealingSnapshot().final.mitigationId).toBe(final.mitigationId);

    const beforeFinal = fixture.requests.filter(request => request.method === 'POST').length;
    fixture.enqueue(
      { kind: 'completion', text: 'Assess only the supplied launch outline.' },
      { kind: 'completion', text: JSON.stringify({
        response_mode: 'answer', achievable_subtasks: ['Assess the supplied outline'],
        blocked_subtasks: [], user_visible_caveats: [], claim_tags: [], final_answer: answer
      }) },
      { kind: 'completion', text: answer }
    );
    const result = await runTrinity();
    expect(result.auditSafe.auditFlags).toContain('SELF_HEAL_V2_FINAL_BYPASS');
    const posts = fixture.requests.filter(request => request.method === 'POST').slice(beforeFinal);
    expect(posts).toHaveLength(3);
    expect(posts.at(-1)?.model).toBe(authorityModel);
    expect(healing.getTrinitySelfHealingSnapshot().final).toMatchObject({
      activeAction: 'bypass_final_stage', verificationSuccesses: 1, mitigationId: final.mitigationId
    });
    expect(healing.getTrinitySelfHealingSnapshot().intake.activeAction).toBeNull();
    expect(healing.rollbackTrinitySelfHealingMitigation({
      stage: 'final', action: 'bypass_final_stage', mitigationId: final.mitigationId,
      reason: 'clear final incident'
    }).rolledBack).toBe(true);
    enqueueNormal();
    expect((await runTrinity()).auditSafe.auditFlags).not.toContain('SELF_HEAL_V2_FINAL_BYPASS');
  });

  it('attributes final bypass to its own command when architectural mode suppresses intake degradation', async () => {
    healing.activateTrinitySelfHealingMitigation({
      stage: 'intake', action: 'enable_degraded_mode', reason: 'concurrent intake incident'
    });
    const final = healing.activateTrinitySelfHealingMitigation({
      stage: 'final', action: 'bypass_final_stage', reason: 'concurrent final incident'
    });
    fixture.enqueue(
      { kind: 'completion', text: 'Assess only the supplied launch outline.' },
      { kind: 'completion', text: JSON.stringify({
        response_mode: 'answer', achievable_subtasks: ['Assess the supplied outline'],
        blocked_subtasks: [], user_visible_caveats: [], claim_tags: [], final_answer: answer
      }) },
      { kind: 'completion', text: answer }
    );
    const result = await runTrinity(false, { internalMode: true });
    expect(result.auditSafe.auditFlags).toContain('SELF_HEAL_V2_FINAL_BYPASS');
    expect(result.routingStages).not.toContain('ARCANOS-DIRECT-ANSWER');
    expect(fixture.requests.filter(request => request.method === 'POST')).toHaveLength(3);
    expect(healing.getTrinitySelfHealingSnapshot().intake.verificationSuccesses).toBe(0);
    expect(healing.getTrinitySelfHealingSnapshot().final).toMatchObject({
      mitigationId: final.mitigationId, verificationSuccesses: 1
    });
  });

  it.each([
    ['reasoning', 'enable_degraded_mode'], ['final', 'bypass_final_stage']
  ] as const)('rolls back %s mitigation after two failures in its actual consumer', async (stage, action) => {
    healing.activateTrinitySelfHealingMitigation({ stage, action, reason: 'ineffective synthetic mitigation' });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (stage === 'final') {
        fixture.enqueue(
          { kind: 'completion', text: 'Assess only the supplied launch outline.' },
          { kind: 'completion', text: JSON.stringify({
            response_mode: 'answer', achievable_subtasks: ['Assess the supplied outline'],
            blocked_subtasks: [], user_visible_caveats: [], claim_tags: [], final_answer: answer
          }) }
        );
      }
      fixture.enqueue({ kind: 'error', status: 503 });
      await expect(runTrinity()).rejects.toThrow('Synthetic bounded provider rejection.');
      if (attempt === 0) {
        expect(healing.getTrinitySelfHealingSnapshot()[stage]).toMatchObject({
          activeAction: action, verificationFailures: 1
        });
      }
    }
    const failed = healing.getTrinitySelfHealingSnapshot()[stage];
    expect(failed).toMatchObject({ activeAction: null, attempts: 1, failedActions: [action] });
    expect(failed.cooldownUntilMs).toBeGreaterThan(clockMs);
    expect(fixture.requests.filter(request => request.method === 'POST')).toHaveLength(stage === 'final' ? 6 : 2);
    enqueueNormal();
    expect((await runTrinity()).routingStages).toContain('GPT5-REASONING');
    expect(healing.getTrinitySelfHealingSnapshot()[stage].attempts).toBe(1);
  });

  it('does not classify a caller cancellation as an ineffective mitigation', async () => {
    const command = healing.activateTrinitySelfHealingMitigation({
      stage: 'reasoning', action: 'enable_degraded_mode', reason: 'bounded caller cancellation fixture'
    });
    let arrived!: () => void;
    let release!: () => void;
    const responseArrived = new Promise<void>(resolve => { arrived = resolve; });
    const responseRelease = new Promise<void>(resolve => { release = resolve; });
    interceptResponse = async () => {
      interceptResponse = null;
      arrived();
      await responseRelease;
    };
    fixture.enqueue({ kind: 'completion', text: answer });
    const controller = new AbortController();
    const operation = requestAbortContext.runWithRequestAbortContext({
      requestId: 'synthetic-caller-cancellation', controller, signal: controller.signal,
      deadlineAt: clockMs + 20_000, timeoutMs: 20_000
    }, () => runTrinity());
    await responseArrived;
    controller.abort(new Error('synthetic caller cancellation'));
    release();
    await expect(operation).rejects.toThrow();
    expect(fixture.requests.filter(request => request.method === 'POST')).toHaveLength(1);
    expect(healing.getTrinitySelfHealingSnapshot().reasoning).toMatchObject({
      mitigationId: command.mitigationId, activeAction: 'enable_degraded_mode',
      verificationSuccesses: 0, verificationFailures: 0
    });
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
    expect(getRequestWindowSince).toHaveBeenCalledWith(
      new Date(Date.parse(actionStartedAt!) + 1).toISOString(), 300_000, '/api/arcanos/ask'
    );
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
