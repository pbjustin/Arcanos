import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { request as httpRequest } from 'node:http';
import { BACKSTAGE_HEAVY_OPENAI_FIXTURE_SDK_KEY } from '../scripts/railway-backstage-heavy-openai-fixture.mjs';

const originalEnvironment = process.env;
const events: string[] = [];
const status = { coordinatorState: 'UNKNOWN', loopRunning: false, inFlight: false, tickCount: 0 };
const stop = jest.fn(async () => { status.loopRunning = false; });
const start = jest.fn(() => { status.loopRunning = true; return { ...status }; });
const tick = jest.fn(async (_options: unknown) => ({ diagnosis: 'healthy' }));
let sharedOverrides: { freeze: boolean | null; autonomy: number | null } = { freeze: null, autonomy: null };
const freeze = jest.fn(async () => { sharedOverrides = { freeze: true, autonomy: 0 }; });
const unfreeze = jest.fn(async () => { sharedOverrides.freeze = false; });
const autonomy = jest.fn(async (level: number, _reason: string) => { sharedOverrides.autonomy = level; });
const prompt = jest.fn(() => ({ applied: false, reason: 'cross_process_prompt_route_unavailable' }));
const trinity = jest.fn<typeof import('../src/services/selfImprove/selfHealingV2.js').activateTrinitySelfHealingMitigation>();
const remoteRepair = jest.fn(async () => { throw new Error('Dedicated job runner remote repair is unavailable.'); });
const pipeline = jest.fn(async (_input: unknown) => ({
  result: 'A fictional blue kite floats over a meadow.', activeModel: 'synthetic-fixture-model',
  routingStages: ['intake', 'reasoning', 'final'], tierInfo: { tier: 'simple' }, dryRun: false, fallbackFlag: false,
}));
const recordCompletion = jest.fn();
const predictiveAudits: Array<Record<string, unknown>> = [];
const predictiveDecision = jest.fn(async (params: { source: string; allowAutoExecute: boolean; dryRun?: boolean; simulate: unknown; signal?: AbortSignal }) => {
  const auditEntry = {
    id: `predictive_heal_audit_${predictiveAudits.length + 1}`, timestamp: new Date().toISOString(), source: params.source,
    observation: { secret: 'mock-unprojected-sensitive-observation' },
    featureFlags: { enabled: true, dryRun: params.dryRun === true, autoExecute: process.env.PREDICTIVE_AUTO_EXECUTE === 'true' },
    decision: { action: 'activate_trinity_mitigation', safeToExecute: true, advisor: 'rules_v1' },
    execution: { mode: params.dryRun ? 'dry_run' : 'recommend_only', status: params.dryRun ? 'dry_run' : 'skipped', attempted: false },
  };
  predictiveAudits.push(auditEntry);
  return { auditEntry };
});
let sdkClient = { synthetic: 1 };
const getClient = jest.fn(() => sdkClient);
const providerRuntime = { reloadCount: 1, lastReloadAt: null, lastAttemptAt: null, lastSuccessAt: null,
  lastFailureAt: null, lastFailureCategory: null, consecutiveFailures: 0, backoffMs: 0, nextRetryAt: null,
  configVersion: 'unprojected-sensitive-config-fingerprint', lastFailureReason: 'unprojected-sensitive-error' };
const log = { info: jest.fn((_event: string, data: { event: string }) => { events.push(data.event); }), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({ logger: log }));
jest.unstable_mockModule('@platform/runtime/unifiedConfig.js', () => ({
  getStableWorkerRuntimeMode: () => ({ processKind: process.env.ARCANOS_PROCESS_KIND }),
  isWorkerRuntimeSuppressedForServiceRole: () => process.env.ARCANOS_PROCESS_KIND === 'web',
  getConfig: () => ({
    selfImproveEnabled: process.env.SELF_IMPROVE_ENABLED === 'true', selfImproveActuatorMode: process.env.SELF_IMPROVE_ACTUATOR_MODE,
    selfImproveAutonomyLevel: Number(process.env.SELF_IMPROVE_AUTONOMY_LEVEL ?? '0'), selfImproveFrozen: process.env.SELF_IMPROVE_FREEZE === 'true',
    predictiveHealingEnabled: process.env.PREDICTIVE_HEALING_ENABLED === 'true', predictiveHealingDryRun: process.env.PREDICTIVE_HEALING_DRY_RUN === 'true',
    autoExecuteHealing: process.env.PREDICTIVE_AUTO_EXECUTE === 'true',
  }),
}));
jest.unstable_mockModule('@platform/runtime/redisLifecycle.js', () => ({ getRedisLifecycleSnapshot: () => ({ state: 'READY' }) }));
jest.unstable_mockModule('@services/incidentResponse/killSwitch.js', () => ({
  freezeSelfImprove: freeze, unfreezeSelfImprove: unfreeze, setAutonomyLevel: autonomy,
  getKillSwitchStatus: async () => ({
    frozen: sharedOverrides.freeze ?? process.env.SELF_IMPROVE_FREEZE === 'true',
    autonomyLevel: sharedOverrides.autonomy ?? Number(process.env.SELF_IMPROVE_AUTONOMY_LEVEL ?? '0'),
    overrides: { ...sharedOverrides },
  }),
}));
jest.unstable_mockModule('../src/services/selfImprove/selfHealingLoop.js', () => ({
  SELF_HEAL_PREVIEW_CONSUMER_ROUTE: '/preview/self-heal/trinity-consumer',
  getSelfHealingLoopStatus: () => ({ ...status }), startSelfHealingLoop: start,
  stopSelfHealingLoop: stop, runSelfHealingLoop: tick,
}));
// Preserve real mitigation identities, TTL, rollback and consumer evidence.
// The writing pipeline remains a substituted transport boundary in this file;
// the production Trinity/SDK consumer is exercised by its integration suite.
const actualTrinity = await import('../src/services/selfImprove/selfHealingV2.js');
trinity.mockImplementation(actualTrinity.activateTrinitySelfHealingMitigation);
jest.unstable_mockModule('../src/services/selfImprove/selfHealingV2.js', () => ({
  ...actualTrinity, activateTrinitySelfHealingMitigation: trinity,
}));
jest.unstable_mockModule('@services/openai/promptRouteMitigation.js', () => ({
  activatePromptRouteDegradedMode: prompt, getPromptRouteMitigationState: () => ({ active: false }),
}));
jest.unstable_mockModule('../src/services/selfImprove/workerRepairActuator.js', () => ({
  buildWorkerRepairActuatorStatus: () => ({ mode: 'unavailable', available: false }),
  executeWorkerRepairActuator: remoteRepair,
}));
jest.unstable_mockModule('@core/adapters/openai.adapter.js', () => ({ getOpenAIAdapter: () => ({ getClient }) }));
jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({ runTrinityWritingPipeline: pipeline }));
jest.unstable_mockModule('@services/runtimeDiagnosticsService.js', () => ({
  runtimeDiagnosticsService: { recordRequestCompletion: recordCompletion },
}));
jest.unstable_mockModule('../src/services/selfImprove/predictiveHealingService.js', () => ({
  buildPredictiveHealingStatusSnapshot: () => ({ recentAudits: predictiveAudits }),
  runPredictiveHealingDecision: predictiveDecision,
}));
jest.unstable_mockModule('@services/openai/serviceHealth.js', () => ({ getOpenAIServiceHealth: () => ({ providerRuntime }) }));

const controls = await import('../src/services/selfImprove/selfHealingPreviewControl.js');
const { getRequestAbortSignal } = await import('@arcanos/runtime');
type Handle = NonNullable<Awaited<ReturnType<typeof controls.installSelfHealingPreviewControl>>>;
let handle: Handle | null = null;
const token = 'a'.repeat(64);
const runId = 'self-heal-regression-1544';
const uid = (digit: number) => `10${digit}00000-0000-4000-8000-000000000000`;
function validEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production', ARCANOS_PROCESS_KIND: 'worker', ARCANOS_PREVIEW_ISOLATION: 'true',
    FORCE_MOCK: 'true', ALLOW_MOCK_OPENAI: 'true', OPENAI_API_KEY_REQUIRED: 'false',
    ARCANOS_SELF_HEAL_PREVIEW_PROFILE: 'worker-coordinator-v1', ARCANOS_SELF_HEAL_PREVIEW_RUN_ID: runId,
    ARCANOS_SELF_HEAL_PREVIEW_ISSUED_AT: new Date(Date.now() - 1_000).toISOString(),
    ARCANOS_SELF_HEAL_PREVIEW_EXPIRES_AT: new Date(Date.now() + 60_000).toISOString(),
    ARCANOS_SELF_HEAL_PREVIEW_CONTROL_TOKEN: token, ARCANOS_SELF_HEAL_PREVIEW_CONTROL_PORT: '8791',
    ARCANOS_SELF_HEAL_PREVIEW_STARTUP_MODE: 'normal', ARCANOS_SELF_HEAL_PREVIEW_WEB_SERVICE_ID: uid(6),
    ARCANOS_SELF_HEAL_PREVIEW_WORKER_SERVICE_ID: uid(3),
    ARCANOS_BACKSTAGE_HEAVY_PROOF_TARGET: 'dedicated-backstage-heavy-preview-v1',
    ARCANOS_BACKSTAGE_HEAVY_PROOF_RUN_ID: runId, ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA: 'b'.repeat(40),
    ARCANOS_BACKSTAGE_HEAVY_POSTGRES_SERVICE_ID: uid(4), ARCANOS_BACKSTAGE_HEAVY_REDIS_SERVICE_ID: uid(5),
    RAILWAY_PROJECT_ID: uid(0), RAILWAY_ENVIRONMENT_ID: uid(1), RAILWAY_SERVICE_ID: uid(3), RAILWAY_DEPLOYMENT_ID: uid(2),
    RAILWAY_PROJECT_NAME: 'arc-pr1544-heavy-regression', RAILWAY_ENVIRONMENT_NAME: 'backstage-heavy-pr-1544-e2e-test',
    RAILWAY_SERVICE_NAME: 'arcanos-worker-pr1544-heavy', RAILWAY_GIT_COMMIT_SHA: 'b'.repeat(40),
    DATABASE_URL: 'postgres://synthetic:synthetic@postgres.railway.internal:5432/fixture?sslmode=no-verify',
    REDIS_URL: 'redis://synthetic:synthetic@redis.railway.internal:6379',
    OPENAI_API_KEY: BACKSTAGE_HEAVY_OPENAI_FIXTURE_SDK_KEY, OPENAI_BASE_URL: 'http://127.0.0.1:8766/v1',
    SELF_IMPROVE_KILL_SWITCH_KEY: `arcanos:preview:self-heal:${runId}:kill-switch:v1`,
    SELF_IMPROVE_ENABLED: 'false', SELF_IMPROVE_ACTUATOR_MODE: 'daemon', SELF_IMPROVE_AUTONOMY_LEVEL: '0',
    SELF_IMPROVE_FREEZE: 'false', PREDICTIVE_HEALING_ENABLED: 'false', PREDICTIVE_HEALING_DRY_RUN: 'true',
  };
}
async function call(command?: string, options: { auth?: string; raw?: string; method?: string; path?: string } = {}) {
  const body = options.raw ?? (command ? JSON.stringify({ command }) : '');
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port: 8791, method: options.method ?? (command ? 'POST' : 'GET'), path: options.path ?? (command ? '/command' : '/inspect'),
      headers: { authorization: options.auth ?? `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: 3_000,
    }, response => {
      let text = '';
      response.on('data', chunk => { text += String(chunk); });
      response.once('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown> }));
    });
    request.once('error', reject);
    request.once('timeout', () => request.destroy(new Error('Bounded control request timed out.')));
    request.end(body);
  });
}
async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  expect(predicate()).toBe(true);
}
beforeEach(() => {
  process.env = validEnvironment();
  process.env.NODE_ENV = 'test';
  actualTrinity.resetTrinitySelfHealingStateForTests();
  process.env.NODE_ENV = 'production';
  jest.clearAllMocks(); events.length = 0;
  sharedOverrides = { freeze: null, autonomy: null };
  predictiveAudits.length = 0;
  sdkClient = { synthetic: 1 };
  status.loopRunning = false; status.coordinatorState = 'UNKNOWN';
});
afterEach(async () => {
  try { await handle?.close(); }
  finally { handle = null; process.env = originalEnvironment; jest.restoreAllMocks(); }
});

describe('isolated self-healing preview admission and process-local controls', () => {
  it('is inert without opt-in and rejects malformed/expired/canonical/ambiguous identities', async () => {
    expect(controls.resolveSelfHealingPreviewProfile({})).toBeNull();
    delete process.env.ARCANOS_SELF_HEAL_PREVIEW_PROFILE;
    expect(await controls.installSelfHealingPreviewControl()).toBeNull();
    for (const patch of [
      { NODE_ENV: 'test' }, { ARCANOS_SELF_HEAL_PREVIEW_PROFILE: '' },
      { RAILWAY_PROJECT_ID: '7faf44e5-519c-4e73-8d7a-da9f389e6187' },
      { ARCANOS_SELF_HEAL_PREVIEW_EXPIRES_AT: new Date(0).toISOString() },
      { RAILWAY_GIT_COMMIT_SHA: 'c'.repeat(40) }, { REDIS_URL: 'redis://synthetic:synthetic@shared.invalid:6379' },
      { ARCANOS_SELF_HEAL_PREVIEW_CONTROL_PORT: '8080' }, { ARCANOS_SELF_HEAL_PREVIEW_WORKER_SERVICE_ID: uid(6) },
      { SELF_IMPROVE_KILL_SWITCH_KEY: 'arcanos:production:kill-switch' },
      { ARCANOS_SELF_HEAL_PREVIEW_RUN_ID: 'different-run-1544' },
      { ARCANOS_SELF_HEAL_PREVIEW_EXPIRES_AT: new Date(Date.now() + 7_300_000).toISOString() },
    ]) expect(() => controls.resolveSelfHealingPreviewProfile({ ...validEnvironment(), ...patch })).toThrow('SELF_HEAL_PREVIEW_PROFILE_INVALID');
  });

  it('exposes the actual process identity on loopback and inspection never evaluates', async () => {
    handle = await controls.installSelfHealingPreviewControl();
    const result = await call();
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ pid: process.pid, sourceCommit: 'b'.repeat(40), runId, processKind: 'worker', ready: false });
    expect(result.body.processInstanceId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(JSON.stringify(result.body)).not.toContain(token);
    expect(tick).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
    expect(getClient).not.toHaveBeenCalled();
    expect(JSON.stringify(result.body)).not.toContain('unprojected-sensitive');
    handle?.markReady();
    expect((await call()).body.ready).toBe(true);
  });

  it('authenticates before parsing oversized/invalid bodies and accepts only closed commands', async () => {
    handle = await controls.installSelfHealingPreviewControl();
    expect((await call('inspect', { auth: 'Bearer invalid', raw: 'x'.repeat(5_000) })).status).toBe(401);
    expect((await call('inspect', { raw: 'x'.repeat(4_097) })).status).toBe(400);
    expect((await call('inspect', { raw: '{"command":"tick","url":"https://shared.invalid"}' })).status).toBe(400);
    expect((await call('arbitrary_command')).status).toBe(400);
    expect((await call(undefined, { path: '/inspect?token=secret' })).status).toBe(400);
    expect(tick).not.toHaveBeenCalled(); expect(trinity).not.toHaveBeenCalled(); expect(freeze).not.toHaveBeenCalled();
  });

  it('bounds an authenticated partial body independently of the HTTP server timeout sweep', async () => {
    handle = await controls.installSelfHealingPreviewControl();
    const started = Date.now();
    const result = await new Promise<'server_closed' | 'client_deadline'>((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port: 8791, method: 'POST', path: '/command',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': 100 },
      }, response => { response.resume(); reject(new Error(`Unexpected partial-body response ${response.statusCode}.`)); });
      const deadline = setTimeout(() => { request.destroy(); resolve('client_deadline'); }, 3_500);
      request.once('error', () => { clearTimeout(deadline); resolve('server_closed'); });
      request.write('{"command":');
    });
    expect(result).toBe('server_closed');
    expect(Date.now() - started).toBeLessThan(3_000);
    expect((await call()).status).toBe(200);
    expect(tick).not.toHaveBeenCalled(); expect(trinity).not.toHaveBeenCalled(); expect(freeze).not.toHaveBeenCalled();
  });

  it('supports one-shot scheduler/observation faults without altering global timers', async () => {
    handle = await controls.installSelfHealingPreviewControl();
    const ordinary = setInterval;
    await call('scheduler_failure_once');
    expect(() => handle?.coordinatorOptions.installScheduler?.(() => undefined, 1_000)).toThrow('SELF_HEAL_PREVIEW_SCHEDULER_FAILURE');
    const timer = handle?.coordinatorOptions.installScheduler?.(() => undefined, 1_000);
    clearInterval(timer);
    expect(setInterval).toBe(ordinary);
    await call('observation_throw_once');
    await expect(handle?.coordinatorOptions.beforeObservation?.()).rejects.toThrow('SELF_HEAL_PREVIEW_OBSERVATION_FAILURE');
    await expect(handle?.coordinatorOptions.beforeObservation?.()).resolves.toBeUndefined();
    expect(events).toContain('scheduler_installed'); expect(events).toContain('observation_failed');
  });

  it('injects one claim-boundary database failure without inspection consuming or rearming it', async () => {
    handle = await controls.installSelfHealingPreviewControl();
    expect((await call('database_failure_once')).body.claimFailurePending).toBe(true);
    expect((await call()).body.claimFailurePending).toBe(true);
    try { handle?.beforeClaim(); throw new Error('Expected the one-shot synthetic database failure.'); }
    catch (error) { expect(error).toMatchObject({ message: 'SELF_HEAL_PREVIEW_DATABASE_CLAIM_FAILURE', code: 'ECONNREFUSED' }); }
    expect(() => handle?.beforeClaim()).not.toThrow();
    expect((await call()).body.claimFailurePending).toBe(false);
    expect(events.filter(event => event === 'claim_operation_failure')).toHaveLength(1);
  });

  it('releases a bounded held evaluation on abort and restores known policy values on close', async () => {
    const shutdown = new AbortController();
    handle = await controls.installSelfHealingPreviewControl({ signal: shutdown.signal });
    await call('hold_observation_once');
    const active = handle?.coordinatorOptions.beforeObservation?.(handle.coordinatorOptions.signal);
    await call('policy_allowed');
    expect(process.env.SELF_IMPROVE_ENABLED).toBe('true');
    shutdown.abort();
    await active;
    await handle?.close();
    expect(process.env.SELF_IMPROVE_ENABLED).toBe('false');
    expect(process.env.PREDICTIVE_AUTO_EXECUTE).toBeUndefined();
    expect(events).toContain('observation_released'); expect(stop).toHaveBeenCalled();
    await expect(call()).rejects.toThrow();
  });

  it('rejects local actuation under observation policy and invokes the actual kill-switch API', async () => {
    handle = await controls.installSelfHealingPreviewControl();
    expect((await call('trinity_activate')).body).toMatchObject({ rejected: true, reasonCode: 'local_mitigation_policy_blocked' });
    expect(trinity).not.toHaveBeenCalled();
    await call('policy_kill_switch');
    expect(freeze).toHaveBeenCalledWith('bounded-preview-emergency-switch');
    await call('policy_allowed');
    expect(unfreeze).toHaveBeenCalledWith('bounded-preview-next-policy-case');
    expect(autonomy).toHaveBeenCalledWith(3, 'bounded-preview-next-policy-case');
    expect((await call('trinity_activate')).body).toMatchObject({ consumerEvidence: 'policy_projection', result: { applied: true } });
    expect(trinity).toHaveBeenCalledTimes(1);
    await call('prompt_worker_rejection'); expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('expires permanently, closes inspection and prevents later scheduler admission', async () => {
    process.env.ARCANOS_SELF_HEAL_PREVIEW_EXPIRES_AT = new Date(Date.now() + 80).toISOString();
    handle = await controls.installSelfHealingPreviewControl();
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(() => handle?.coordinatorOptions.installScheduler?.(() => undefined, 100)).toThrow('SELF_HEAL_PREVIEW_EXPIRED');
    await expect(call()).rejects.toThrow();
    expect(events).toContain('control_closed');
  });

  it('keeps configured and effective freeze restrictive after a kill-switch case and restores the preview baseline', async () => {
    handle = await controls.installSelfHealingPreviewControl();
    await call('policy_kill_switch');
    expect((await call('policy_freeze')).body.policy).toMatchObject({
      frozen: true, killSwitch: { frozen: true, autonomyLevel: 0 },
    });
    expect(unfreeze).not.toHaveBeenCalled();
    expect((await call('trinity_activate')).body).toMatchObject({ rejected: true });
    expect(trinity).not.toHaveBeenCalled();
    expect((await call('policy_allowed')).body.policy).toMatchObject({
      frozen: false, autonomyLevel: 3, killSwitch: { frozen: false, autonomyLevel: 3 },
    });
    expect((await call('policy_restore')).body.policy).toMatchObject({
      selfImproveEnabled: false, frozen: false, autonomyLevel: 0, predictiveDryRun: true,
      killSwitch: { frozen: false, autonomyLevel: 0 },
    });
    expect((await call('policy_restore')).body.policy).toMatchObject({
      selfImproveEnabled: false, killSwitch: { frozen: false, autonomyLevel: 0 },
    });
  });

  it('does not relax a shared safety override that this control instance did not establish', async () => {
    sharedOverrides = { freeze: true, autonomy: 0 };
    handle = await controls.installSelfHealingPreviewControl();
    expect((await call('policy_allowed')).body.policy).toMatchObject({
      killSwitch: { frozen: true, autonomyLevel: 0 },
    });
    await call('policy_restore');
    expect(unfreeze).not.toHaveBeenCalled();
    expect(autonomy).not.toHaveBeenCalled();
  });

  it('contains unexpected tick rejections and records remote refusal without dispatch', async () => {
    handle = await controls.installSelfHealingPreviewControl();
    tick.mockRejectedValueOnce(new Error('Unexpected preview diagnostic rejection.'));
    expect((await call('tick')).status).toBe(200);
    await new Promise(resolve => setImmediate(resolve));
    expect(events).toContain('unexpected_tick_rejection');
    expect((await call('remote_mitigation_rejection')).body).toMatchObject({ rejected: true, dispatchAttempts: 0, actuatorMode: 'unavailable' });
    expect(remoteRepair).toHaveBeenCalledWith(expect.objectContaining({ approval: { approved: false } }), expect.any(Object));
  });

  it('runs only the fixed stateless consumer and exposes observed receipts rather than success assertions', async () => {
    handle = await controls.installSelfHealingPreviewControl();
    expect((await call('trinity_run')).status).toBe(200);
    for (let index = 0; index < 20 && pipeline.mock.calls.length === 0; index += 1) await new Promise(resolve => setImmediate(resolve));
    const inspection = await call();
    expect(inspection.body.consumerRun).toMatchObject({ status: 'completed', routingStages: ['intake', 'reasoning', 'final'], outputCharacters: 43 });
    expect(pipeline).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({
      runOptions: expect.objectContaining({ disableMemoryAccess: true, disableOptionalSideEffects: true,
        preserveAggregateAbortContext: true, modelStageTimeoutMs: 2_000,
        toolBackedCapabilities: { browse: false, verifyProvidedData: false, verifyLiveData: false, confirmExternalState: false, persistData: false, callBackend: false },
      }),
    }) }));
    expect(JSON.stringify(inspection.body)).not.toContain('A fictional blue kite');
    expect(recordCompletion).toHaveBeenCalledWith(200, expect.any(Number), '/preview/self-heal/trinity-consumer', {
      timeoutKind: undefined, degradedModeReason: undefined, bypassedSubsystems: undefined,
    });
    expect(inspection.body.consumerRun).toMatchObject({ diagnostics: {
      route: '/preview/self-heal/trinity-consumer', statusCode: 200, source: 'actual_preview_facade_invocation',
    } });
  });

  it('records measured facade timeouts and cannot accept caller-authored success diagnostics', async () => {
    handle = await controls.installSelfHealingPreviewControl();
    expect((await call('trinity_run', { raw: '{"command":"trinity_run","diagnostics":{"statusCode":200}}' })).status).toBe(400);
    expect(recordCompletion).not.toHaveBeenCalled();
    pipeline.mockRejectedValueOnce(Object.assign(new Error('Synthetic model stage deadline.'), { name: 'AbortError' }));
    await call('trinity_run');
    for (let index = 0; index < 20 && recordCompletion.mock.calls.length === 0; index += 1) await new Promise(resolve => setImmediate(resolve));
    expect(recordCompletion).toHaveBeenCalledWith(504, expect.any(Number), '/preview/self-heal/trinity-consumer', { timeoutKind: 'pipeline_timeout' });
    expect((await call()).body.consumerRun).toMatchObject({ status: 'failed', diagnostics: { statusCode: 504 } });
    await call('inspect');
    expect(recordCompletion).toHaveBeenCalledTimes(1);
  });

  it('records SDK identity only when a real consumer uses the reference and observes replacement', async () => {
    handle = await controls.installSelfHealingPreviewControl();
    await call();
    expect(getClient).not.toHaveBeenCalled();
    await call('trinity_run');
    for (let index = 0; index < 20 && recordCompletion.mock.calls.length === 0; index += 1) await new Promise(resolve => setImmediate(resolve));
    expect((await call()).body.provider).toMatchObject({ observedConsumerClients: 1, lastConsumerClientId: 'consumer-client-1' });
    sdkClient = { synthetic: 2 };
    await call('trinity_run');
    for (let index = 0; index < 20 && recordCompletion.mock.calls.length < 2; index += 1) await new Promise(resolve => setImmediate(resolve));
    const after = await call();
    expect(after.body.provider).toMatchObject({ observedConsumerClients: 2, lastConsumerClientId: 'consumer-client-2' });
    expect(after.body.consumerRun).toMatchObject({ consumerClientId: 'consumer-client-2' });
    expect(getClient).toHaveBeenCalledTimes(2);
  });

  it('admits predictive evaluation only in fixed dry-run or recommendation modes and projects bounded audits', async () => {
    handle = await controls.installSelfHealingPreviewControl();
    expect((await call('predictive_evaluate')).body).toMatchObject({ rejected: true });
    expect(predictiveDecision).not.toHaveBeenCalled();
    await call('policy_predictive_dry_run');
    await call('predictive_evaluate');
    for (let index = 0; index < 20 && predictiveAudits.length === 0; index += 1) await new Promise(resolve => setImmediate(resolve));
    expect(predictiveDecision).toHaveBeenLastCalledWith(expect.objectContaining({
      source: 'self-heal.preview.predictive-case', allowAutoExecute: true, dryRun: true,
      simulate: expect.objectContaining({ trinity: expect.objectContaining({ enabled: true }) }),
    }));
    expect((await call()).body.predictiveRun).toMatchObject({ status: 'completed', evidence: 'synthetic_fault_observation', audit: { mode: 'dry_run', attempted: false } });
    await call('policy_predictive_no_execute');
    await call('predictive_evaluate');
    for (let index = 0; index < 20 && predictiveAudits.length < 2; index += 1) await new Promise(resolve => setImmediate(resolve));
    expect(predictiveDecision).toHaveBeenLastCalledWith(expect.objectContaining({ allowAutoExecute: false }));
    expect(predictiveDecision.mock.calls[1][0]).not.toHaveProperty('execute');
    expect(predictiveDecision.mock.calls[1][0]).not.toHaveProperty('dryRun');
    const after = await call();
    expect(after.body.predictiveRun).toMatchObject({ status: 'completed', audit: { mode: 'recommend_only', attempted: false } });
    expect(JSON.stringify(after.body)).not.toContain('unprojected-sensitive');
    predictiveAudits.push(...Array.from({ length: 5 }, () => predictiveAudits[0]));
    expect((await call()).body.predictiveAudits).toHaveLength(3);
    process.env.PREDICTIVE_AUTO_EXECUTE = 'true';
    expect((await call('predictive_evaluate')).body).toMatchObject({ rejected: true });
    expect(predictiveDecision).toHaveBeenCalledTimes(2);
  });

  it('rejects overlapping commands while a bounded policy operation is in flight', async () => {
    handle = await controls.installSelfHealingPreviewControl();
    let finish!: () => void;
    freeze.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const pending = call('policy_kill_switch');
    for (let index = 0; index < 20 && freeze.mock.calls.length === 0; index += 1) await new Promise(resolve => setImmediate(resolve));
    expect((await call()).status).toBe(409);
    finish();
    expect((await pending).status).toBe(200);
  });

  it('aborts and drains an active production-consumer invocation before closing controls', async () => {
    handle = await controls.installSelfHealingPreviewControl();
    pipeline.mockImplementationOnce(async () => new Promise<never>((_resolve, reject) => {
      const signal = getRequestAbortSignal();
      if (!signal) throw new Error('Missing bounded consumer cancellation context.');
      signal.addEventListener('abort', () => reject(new Error('Synthetic provider drained after cancellation.')), { once: true });
    }));
    await call('trinity_run');
    for (let index = 0; index < 20 && pipeline.mock.calls.length === 0; index += 1) await new Promise(resolve => setImmediate(resolve));
    await handle?.close();
    expect(events).toContain('consumer_failed');
    expect(events.indexOf('consumer_failed')).toBeLessThan(events.indexOf('control_closed'));
  });

  it.each(['policy_disabled', 'policy_insufficient_autonomy', 'policy_freeze', 'policy_kill_switch'])(
    'denies both activation and replacement after %s without invoking the actuator', async policy => {
      handle = await controls.installSelfHealingPreviewControl();
      await call('policy_allowed');
      await call(policy);
      for (const command of ['trinity_activate', 'trinity_replace']) {
        expect((await call(command)).body).toMatchObject({ rejected: true, reasonCode: 'local_mitigation_policy_blocked' });
      }
      expect(trinity).not.toHaveBeenCalled();
      expect(actualTrinity.getTrinitySelfHealingSnapshot().final).toMatchObject({ attempts: 0, activeAction: null });
      expect(pipeline).not.toHaveBeenCalled();
    },
  );

  it('keeps predictive dry-run and no-execute presets distinct without implicitly running or repairing anything', async () => {
    handle = await controls.installSelfHealingPreviewControl();
    expect((await call('policy_predictive_dry_run')).body.policy).toMatchObject({
      predictiveEnabled: true, predictiveDryRun: true, predictiveAutoExecute: true,
    });
    expect((await call('policy_predictive_no_execute')).body.policy).toMatchObject({
      predictiveEnabled: true, predictiveDryRun: false, predictiveAutoExecute: false,
    });
    expect(tick).not.toHaveBeenCalled();
    expect(trinity).not.toHaveBeenCalled();
    expect(remoteRepair).not.toHaveBeenCalled();
    expect(pipeline).not.toHaveBeenCalled();
  });

  it('rejects Worker-only consumer, mutation and claim faults in a valid web profile', async () => {
    process.env.ARCANOS_PROCESS_KIND = 'web';
    process.env.RAILWAY_SERVICE_ID = uid(6);
    process.env.RAILWAY_SERVICE_NAME = 'arcanos-web-pr1544-heavy';
    process.env.OPENAI_BASE_URL = 'http://127.0.0.1:9/v1';
    handle = await controls.installSelfHealingPreviewControl();
    await call('policy_allowed');
    expect((await call('database_failure_once')).body).toMatchObject({ rejected: true, reasonCode: 'worker_role_required' });
    expect((await call('prompt_worker_rejection')).body).toMatchObject({ rejected: true, reasonCode: 'worker_role_required' });
    expect((await call('trinity_run')).body).toMatchObject({ rejected: true, reasonCode: 'consumer_unavailable_or_busy' });
    for (const command of ['trinity_activate', 'trinity_replace']) {
      expect((await call(command)).body).toMatchObject({ rejected: true, reasonCode: 'local_mitigation_policy_blocked' });
    }
    expect(() => handle?.beforeClaim()).not.toThrow();
    expect((await call()).body).toMatchObject({ processKind: 'web', claimFailurePending: false });
    expect(prompt).not.toHaveBeenCalled();
    expect(trinity).not.toHaveBeenCalled();
    expect(pipeline).not.toHaveBeenCalled();
  });

  it('applies the startup scheduler fault once and never leaves a timer or claim fault admitted after close', async () => {
    process.env.ARCANOS_SELF_HEAL_PREVIEW_STARTUP_MODE = 'scheduler-failure';
    handle = await controls.installSelfHealingPreviewControl();
    expect((await call()).body.ready).toBe(false);
    const callback = jest.fn();
    expect(() => handle?.coordinatorOptions.installScheduler?.(callback, 1_000)).toThrow('SELF_HEAL_PREVIEW_SCHEDULER_FAILURE');
    const timer = handle?.coordinatorOptions.installScheduler?.(callback, 1_000);
    clearInterval(timer);
    expect(callback).not.toHaveBeenCalled();
    expect(events.filter(event => event === 'scheduler_installation_failed')).toHaveLength(1);
    expect(events.filter(event => event === 'scheduler_installed')).toHaveLength(1);
    await call('database_failure_once');
    await handle?.close();
    expect(() => handle?.beforeClaim()).not.toThrow();
    expect(() => handle?.coordinatorOptions.installScheduler?.(callback, 1_000)).toThrow('SELF_HEAL_PREVIEW_EXPIRED');
    expect(events).not.toContain('claim_operation_failure');
    expect(callback).not.toHaveBeenCalled();
  });

  it('serializes held ticks and waits for the admitted evaluation to settle before publishing closed', async () => {
    handle = await controls.installSelfHealingPreviewControl();
    let finishAfterObservation!: () => void;
    let evaluationSettled = false;
    tick.mockImplementationOnce(async options => {
      const admission = options as { signal: AbortSignal; beforeObservation: (signal: AbortSignal) => Promise<void> };
      await admission.beforeObservation(admission.signal);
      await new Promise<void>(resolve => { finishAfterObservation = resolve; });
      evaluationSettled = true;
      return { diagnosis: 'healthy' };
    });
    await call('hold_observation_once');
    await call('tick');
    await waitFor(() => events.includes('observation_held'));
    expect((await call()).body).toMatchObject({ observationHeld: true, tickPending: true });
    await call('tick');
    expect(tick).toHaveBeenCalledTimes(1);
    const closing = handle!.close();
    expect(handle!.close()).toBe(closing);
    try {
      await waitFor(() => typeof finishAfterObservation === 'function');
      expect(events).toContain('observation_released');
      expect(events).not.toContain('control_closed');
      expect(evaluationSettled).toBe(false);
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      finishAfterObservation?.();
      await closing;
    }
    expect(evaluationSettled).toBe(true);
    expect(events.filter(event => event === 'control_closed')).toHaveLength(1);
    expect(events.indexOf('observation_released')).toBeLessThan(events.indexOf('control_closed'));
  });

  it('does not count inspection or policy projection as recovery and fences stale rollback after replacement', async () => {
    handle = await controls.installSelfHealingPreviewControl();
    await call('policy_allowed');
    const activation = await call('trinity_activate');
    const first = actualTrinity.getTrinitySelfHealingSnapshot().final;
    expect(activation.body).toMatchObject({
      consumerEvidence: 'policy_projection', result: { applied: true, mitigationId: first.mitigationId },
      consumer: { bypassFinalStage: true, forceDirectAnswer: false, verified: false },
    });
    await call('trinity_consumer');
    await call();
    expect(actualTrinity.getTrinitySelfHealingSnapshot().final).toMatchObject({ verificationSuccesses: 0, verifiedAtMs: null });
    await call('trinity_replace');
    const replacement = actualTrinity.getTrinitySelfHealingSnapshot().final;
    expect(replacement.mitigationId).not.toBe(first.mitigationId);
    actualTrinity.noteTrinityMitigationOutcome({
      stage: 'final', outcome: 'success', requestId: 'stale-consumer', action: first.activeAction,
      mitigationId: first.mitigationId, sourceEndpoint: 'synthetic-stale-consumer',
    });
    expect((await call('trinity_stale_rollback')).body).toMatchObject({
      result: { rolledBack: false, reason: 'mitigation_id_mismatch', mitigationId: replacement.mitigationId },
    });
    expect((await call('trinity_consumer')).body.consumer).toMatchObject({
      bypassFinalStage: false, forceDirectAnswer: true, mitigationId: replacement.mitigationId, verified: false,
    });
    expect(actualTrinity.getTrinitySelfHealingSnapshot().final).toMatchObject({ verificationSuccesses: 0, verifiedAtMs: null });
    expect((await call('trinity_rollback')).body).toMatchObject({ result: { rolledBack: true } });
    expect((await call('trinity_consumer')).body.consumer).toMatchObject({ bypassFinalStage: false, forceDirectAnswer: false, mitigationId: null });
    expect(pipeline).not.toHaveBeenCalled();
  });

  it('labels injected success separately and expires real mitigation state without old evidence reviving it', async () => {
    let clockMs = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => clockMs);
    process.env.ARCANOS_SELF_HEAL_PREVIEW_EXPIRES_AT = new Date(clockMs + 7_000_000).toISOString();
    handle = await controls.installSelfHealingPreviewControl();
    await call('policy_allowed');
    await call('trinity_activate');
    const active = actualTrinity.getTrinitySelfHealingSnapshot().final;
    for (let count = 0; count < 3; count += 1) {
      clockMs += 1;
      expect((await call('trinity_fresh_success')).body.evidence).toBe('injected_consumer_outcome');
    }
    expect(actualTrinity.getTrinitySelfHealingSnapshot().final).toMatchObject({ verificationSuccesses: 3, verifiedAtMs: clockMs });
    expect(pipeline).not.toHaveBeenCalled();
    clockMs = active.expiresAtMs!;
    expect((await call('trinity_consumer')).body.consumer).toMatchObject({ bypassFinalStage: false, verified: false, mitigationId: null });
    await call('trinity_fresh_success');
    expect(actualTrinity.getTrinitySelfHealingSnapshot().final).toMatchObject({ activeAction: null, verificationSuccesses: 0, verifiedAtMs: null });
  });

  it('rejects overlapping consumers and preserves replacement identity without treating completion as fresh recovery', async () => {
    handle = await controls.installSelfHealingPreviewControl();
    await call('policy_allowed');
    await call('trinity_activate');
    const first = actualTrinity.getTrinitySelfHealingSnapshot().final;
    let finishConsumer!: () => void;
    pipeline.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { finishConsumer = resolve; });
      return { result: 'Only a synthetic response.', activeModel: 'synthetic-fixture-model',
        routingStages: ['intake', 'reasoning'], tierInfo: { tier: 'simple' }, dryRun: false, fallbackFlag: false };
    });
    try {
      await call('trinity_run');
      await waitFor(() => typeof finishConsumer === 'function');
      expect((await call('trinity_run')).body).toMatchObject({ rejected: true, reasonCode: 'consumer_unavailable_or_busy' });
      expect(pipeline).toHaveBeenCalledTimes(1);
      await call('trinity_replace');
      const replacement = actualTrinity.getTrinitySelfHealingSnapshot().final;
      finishConsumer();
      await waitFor(() => events.includes('consumer_completed'));
      expect((await call()).body.consumerRun).toMatchObject({
        status: 'completed', mitigationBefore: { mitigationId: first.mitigationId },
        mitigationAfter: { mitigationId: replacement.mitigationId, verificationSuccesses: 0, verifiedAtMs: null },
      });
      expect(actualTrinity.getTrinitySelfHealingSnapshot().final).toMatchObject({
        mitigationId: replacement.mitigationId, verificationSuccesses: 0, verifiedAtMs: null,
      });
    } finally { finishConsumer?.(); }
  });

  it('sanitizes a rejected consumer and permits a later bounded consumer without exposing raw failure data', async () => {
    handle = await controls.installSelfHealingPreviewControl();
    const sensitiveFailure = 'fixture-private-error-detail-do-not-expose';
    pipeline.mockRejectedValueOnce(new Error(sensitiveFailure));
    await call('trinity_run');
    await waitFor(() => events.includes('consumer_failed'));
    const failed = await call();
    expect(failed.body.consumerRun).toMatchObject({ status: 'failed', reasonCode: 'SELF_HEAL_PREVIEW_CONSUMER_FAILED' });
    expect(JSON.stringify(failed.body)).not.toContain(sensitiveFailure);
    expect(JSON.stringify(failed.body)).not.toContain(token);
    await call('trinity_run');
    await waitFor(() => events.includes('consumer_completed'));
    expect((await call()).body.consumerRun).toMatchObject({ status: 'completed' });
    expect(pipeline).toHaveBeenCalledTimes(2);
  });

  it.each(['policy_restore', 'policy_allowed'])(
    'does not transfer preview freeze ownership to a later external freeze after %s', async releasePolicy => {
      handle = await controls.installSelfHealingPreviewControl();
      await call('policy_kill_switch');
      await call(releasePolicy);
      const previousUnfreezes = unfreeze.mock.calls.length;
      const previousAutonomyWrites = autonomy.mock.calls.length;
      sharedOverrides = { freeze: true, autonomy: 0 };
      expect((await call('policy_allowed')).body.policy).toMatchObject({ killSwitch: { frozen: true, autonomyLevel: 0 } });
      expect(unfreeze).toHaveBeenCalledTimes(previousUnfreezes);
      expect(autonomy).toHaveBeenCalledTimes(previousAutonomyWrites);
      expect((await call('trinity_activate')).body).toMatchObject({ rejected: true });
    },
  );

  it('updates only its retained autonomy value across allowed and insufficient-autonomy policies', async () => {
    handle = await controls.installSelfHealingPreviewControl();
    await call('policy_kill_switch');
    await call('policy_allowed');
    expect((await call('policy_insufficient_autonomy')).body.policy).toMatchObject({
      autonomyLevel: 2, killSwitch: { frozen: false, autonomyLevel: 2 },
    });
    expect(unfreeze).toHaveBeenCalledTimes(1);
    expect((await call('trinity_activate')).body).toMatchObject({ rejected: true });
    expect(trinity).not.toHaveBeenCalled();
    expect((await call('policy_restore')).body.policy).toMatchObject({
      autonomyLevel: 0, killSwitch: { frozen: false, autonomyLevel: 0 },
    });
    expect(unfreeze).toHaveBeenCalledTimes(1);
  });

  it.each(['policy_allowed', 'policy_restore'])(
    'preserves a later external freeze when %s follows an owned allowed policy', async nextPolicy => {
      handle = await controls.installSelfHealingPreviewControl();
      await call('policy_kill_switch');
      await call('policy_allowed');
      const previousUnfreezes = unfreeze.mock.calls.length;
      const previousAutonomyWrites = autonomy.mock.calls.length;
      sharedOverrides = { freeze: true, autonomy: 0 };
      expect((await call(nextPolicy)).body.policy).toMatchObject({ killSwitch: { frozen: true, autonomyLevel: 0 } });
      expect(unfreeze).toHaveBeenCalledTimes(previousUnfreezes);
      // Restoring the zero-authority baseline may repeat a restrictive write,
      // but must never increase the external owner's authority or unfreeze it.
      expect(autonomy.mock.calls.slice(previousAutonomyWrites).every(([level]) => level === 0)).toBe(true);
      expect((await call('trinity_activate')).body).toMatchObject({ rejected: true });
      expect(trinity).not.toHaveBeenCalled();
    },
  );

  it('drains an admitted policy command before restoring the baseline during shutdown', async () => {
    handle = await controls.installSelfHealingPreviewControl();
    let finishFreeze!: () => void;
    freeze.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { finishFreeze = resolve; });
      sharedOverrides = { freeze: true, autonomy: 0 };
    });
    // Shutdown deliberately destroys open HTTP connections; keep that outcome
    // observed while independently checking the admitted operation's drain.
    const requestOutcome = call('policy_kill_switch').catch(() => null);
    await waitFor(() => typeof finishFreeze === 'function');
    const closing = handle!.close();
    let closed = false;
    void closing.then(() => { closed = true; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(closed).toBe(false);
      expect(events).not.toContain('control_closed');
      expect(process.env.SELF_IMPROVE_ENABLED).toBe('true');
    } finally {
      finishFreeze();
      await Promise.all([closing, requestOutcome]);
    }
    expect(process.env.SELF_IMPROVE_ENABLED).toBe('false');
    expect(process.env.SELF_IMPROVE_AUTONOMY_LEVEL).toBe('0');
    expect(events.indexOf('policy_kill_switch')).toBeLessThan(events.indexOf('control_closed'));
    expect(unfreeze).not.toHaveBeenCalled();
  });
});
