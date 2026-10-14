import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { logger } from '@platform/logging/structuredLogging.js';
import { getEnv, writeRuntimeEnv, unsetRuntimeEnv } from '@platform/runtime/env.js';
import { getConfig } from '@platform/runtime/unifiedConfig.js';
import { getRedisLifecycleSnapshot } from '@platform/runtime/redisLifecycle.js';
import {
  freezeSelfImprove, unfreezeSelfImprove, setAutonomyLevel, getKillSwitchStatus,
} from '@services/incidentResponse/killSwitch.js';
import {
  getSelfHealingLoopStatus, runSelfHealingLoop, startSelfHealingLoop, stopSelfHealingLoop,
  SELF_HEAL_PREVIEW_CONSUMER_ROUTE,
  type SelfHealingCoordinatorOptions,
} from './selfHealingLoop.js';
import {
  activateTrinitySelfHealingMitigation, getTrinitySelfHealingStatus,
  getTrinitySelfHealingMitigation, rollbackTrinitySelfHealingMitigation, noteTrinityMitigationOutcome,
} from './selfHealingV2.js';
import { activatePromptRouteDegradedMode, getPromptRouteMitigationState } from '@services/openai/promptRouteMitigation.js';
import { runtimeDiagnosticsService } from '@services/runtimeDiagnosticsService.js';
import { getOpenAIServiceHealth } from '@services/openai/serviceHealth.js';
import { buildPredictiveHealingStatusSnapshot, runPredictiveHealingDecision,
  type PredictiveHealingAuditEntry, type PredictiveHealingSimulationInput,
} from './predictiveHealingService.js';

export const SELF_HEAL_PREVIEW_PROFILE = 'worker-coordinator-v1';
export const SELF_HEAL_PREVIEW_CONTROL_PORT = 8791;
const PREFIX = 'ARCANOS_SELF_HEAL_PREVIEW_';
const MAX_BODY_BYTES = 4_096;
const BODY_READ_TIMEOUT_MS = 2_000;
const MAX_RESPONSE_BYTES = 65_536;
const MAX_REQUESTS = 2_000;
const MAX_REQUESTS_PER_MINUTE = 120;
const HOLD_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_IDS = new Set([
  '7faf44e5-519c-4e73-8d7a-da9f389e6187', 'fb583147-6c39-4343-9267-500f357d25ab',
  '1765befb-b805-4051-9af9-28634e986886', 'c4ade025-3f13-4fca-9309-5d0dd81396fe',
  '6647b5b1-d796-4783-b5f0-b8e356019ca6', '81e4a1cf-7ae4-48bf-8321-23641bb23c0e',
]);
const POLICY_NAMES = [
  'SELF_IMPROVE_ENABLED', 'SELF_IMPROVE_ACTUATOR_MODE', 'SELF_IMPROVE_AUTONOMY_LEVEL',
  'SELF_IMPROVE_FREEZE', 'PREDICTIVE_HEALING_ENABLED', 'PREDICTIVE_HEALING_DRY_RUN',
  'PREDICTIVE_AUTO_EXECUTE',
] as const;
const PROFILE_NAMES = [
  `${PREFIX}PROFILE`, `${PREFIX}ISSUED_AT`, `${PREFIX}EXPIRES_AT`, `${PREFIX}CONTROL_TOKEN`,
  `${PREFIX}CONTROL_PORT`, `${PREFIX}STARTUP_MODE`,
  `${PREFIX}RUN_ID`,
  'ARCANOS_BACKSTAGE_HEAVY_PROOF_TARGET', 'ARCANOS_BACKSTAGE_HEAVY_PROOF_RUN_ID',
  'ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA', 'ARCANOS_BACKSTAGE_HEAVY_POSTGRES_SERVICE_ID',
  'ARCANOS_BACKSTAGE_HEAVY_REDIS_SERVICE_ID', `${PREFIX}WEB_SERVICE_ID`, `${PREFIX}WORKER_SERVICE_ID`,
  'ARCANOS_PROCESS_KIND', 'NODE_ENV', 'ARCANOS_PREVIEW_ISOLATION', 'FORCE_MOCK', 'ALLOW_MOCK_OPENAI',
  'OPENAI_API_KEY_REQUIRED', 'RAILWAY_PROJECT_NAME', 'RAILWAY_PROJECT_ID', 'RAILWAY_ENVIRONMENT_NAME',
  'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_SERVICE_ID', 'RAILWAY_SERVICE_NAME', 'RAILWAY_DEPLOYMENT_ID',
  'RAILWAY_GIT_COMMIT_SHA', 'DATABASE_URL', 'REDIS_URL', 'OPENAI_BASE_URL', 'OPENAI_API_KEY',
  'SELF_IMPROVE_KILL_SWITCH_KEY',
] as const;

export interface SelfHealingPreviewProfile {
  role: 'web' | 'worker';
  runId: string;
  sourceCommit: string;
  projectId: string;
  environmentId: string;
  serviceId: string;
  deploymentId: string;
  postgresServiceId: string;
  redisServiceId: string;
  expiresAtMs: number;
  controlToken: string;
  startupMode: 'normal' | 'scheduler-failure';
}

function failProfile(): never { throw new Error('SELF_HEAL_PREVIEW_PROFILE_INVALID'); }

/** Pure admission check. Absence is inert; any malformed opt-in fails closed. */
export function resolveSelfHealingPreviewProfile(
  env: Readonly<Record<string, string | undefined>>,
  nowMs = Date.now(),
): SelfHealingPreviewProfile | null {
  if (env[`${PREFIX}PROFILE`] === undefined) return null;
  if (env[`${PREFIX}PROFILE`] !== SELF_HEAL_PREVIEW_PROFILE || env.NODE_ENV !== 'production'
      || env.ARCANOS_BACKSTAGE_HEAVY_PROOF_TARGET !== 'dedicated-backstage-heavy-preview-v1'
      || env.ARCANOS_PREVIEW_ISOLATION !== 'true' || env.FORCE_MOCK !== 'true'
      || env.ALLOW_MOCK_OPENAI !== 'true' || env.OPENAI_API_KEY_REQUIRED !== 'false') failProfile();
  const role = env.ARCANOS_PROCESS_KIND;
  const match = /^backstage-heavy-pr-([1-9]\d*)-e2e(?:-[a-z0-9]{1,16})?$/u.exec(env.RAILWAY_ENVIRONMENT_NAME ?? '');
  const projectMatch = /^arc-pr([1-9]\d*)-heavy-[a-z0-9][a-z0-9-]{0,13}$/u.exec(env.RAILWAY_PROJECT_NAME ?? '');
  if ((role !== 'web' && role !== 'worker') || !match || !projectMatch || match[1] !== projectMatch[1]
      || env.RAILWAY_SERVICE_NAME !== `arcanos-${role}-pr${match[1]}-heavy`) failProfile();
  const ids = [
    'RAILWAY_PROJECT_ID', 'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_SERVICE_ID', 'RAILWAY_DEPLOYMENT_ID',
    'ARCANOS_BACKSTAGE_HEAVY_POSTGRES_SERVICE_ID', 'ARCANOS_BACKSTAGE_HEAVY_REDIS_SERVICE_ID',
    `${PREFIX}WEB_SERVICE_ID`, `${PREFIX}WORKER_SERVICE_ID`,
  ].map(name => env[name] ?? '');
  if (ids.some(id => !UUID.test(id) || CANONICAL_IDS.has(id))
      || new Set(ids).size !== 7
      || env.RAILWAY_SERVICE_ID !== env[`${PREFIX}${role.toUpperCase()}_SERVICE_ID`]) failProfile();
  // The current role appears once as RAILWAY_SERVICE_ID and once in its role pin.
  const runId = env.ARCANOS_BACKSTAGE_HEAVY_PROOF_RUN_ID ?? '';
  const sourceCommit = env.ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA ?? '';
  const issued = env[`${PREFIX}ISSUED_AT`] ?? '';
  const expires = env[`${PREFIX}EXPIRES_AT`] ?? '';
  const issuedAtMs = Date.parse(issued);
  const expiresAtMs = Date.parse(expires);
  const controlToken = env[`${PREFIX}CONTROL_TOKEN`] ?? '';
  const startupMode = env[`${PREFIX}STARTUP_MODE`] ?? '';
  if (!/^[a-z0-9][a-z0-9-]{7,63}$/u.test(runId) || !/^[0-9a-f]{40}$/u.test(sourceCommit)
      || env[`${PREFIX}RUN_ID`] !== runId
      || (env.RAILWAY_GIT_COMMIT_SHA !== undefined && env.RAILWAY_GIT_COMMIT_SHA !== sourceCommit)
      || !Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs)
      || new Date(issuedAtMs).toISOString() !== issued || new Date(expiresAtMs).toISOString() !== expires
      || issuedAtMs > nowMs || expiresAtMs <= nowMs || expiresAtMs - issuedAtMs > 7_200_000
      || expiresAtMs <= issuedAtMs || !/^[0-9a-f]{64}$/u.test(controlToken)
      || env[`${PREFIX}CONTROL_PORT`] !== String(SELF_HEAL_PREVIEW_CONTROL_PORT)
      || (startupMode !== 'normal' && startupMode !== 'scheduler-failure')
      || (role === 'web' && startupMode !== 'normal')
      || env.OPENAI_API_KEY !== 'arcanos-preview-fixture-protocol-v1'
      || env.OPENAI_BASE_URL !== (role === 'worker' ? 'http://127.0.0.1:8766/v1' : 'http://127.0.0.1:9/v1')
      || env.SELF_IMPROVE_KILL_SWITCH_KEY !== `arcanos:preview:self-heal:${runId}:kill-switch:v1`) failProfile();
  for (const [name, host, protocol, port] of [
    ['DATABASE_URL', 'postgres.railway.internal', 'postgres:', '5432'],
    ['REDIS_URL', 'redis.railway.internal', 'redis:', '6379'],
  ]) {
    let parsed: URL;
    try { parsed = new URL(env[name] ?? ''); } catch { failProfile(); }
    if (parsed.hostname !== host || (parsed.protocol !== protocol && !(name === 'DATABASE_URL' && parsed.protocol === 'postgresql:'))
        || parsed.port !== port || !parsed.username || !parsed.password || parsed.hash
        || (name === 'DATABASE_URL' ? parsed.search !== '?sslmode=no-verify' || parsed.pathname.length <= 1 : parsed.search !== '')) failProfile();
  }
  return {
    role, runId, sourceCommit, projectId: ids[0], environmentId: ids[1], serviceId: ids[2], deploymentId: ids[3],
    postgresServiceId: ids[4], redisServiceId: ids[5], expiresAtMs, controlToken, startupMode,
  };
}

const COMMANDS = new Set([
  'inspect', 'duplicate_start', 'coordinator_stop', 'coordinator_start', 'tick',
  'observation_throw_once', 'hold_observation_once', 'release_observation', 'scheduler_failure_once',
  'policy_disabled', 'policy_insufficient_autonomy', 'policy_freeze', 'policy_kill_switch',
  'policy_predictive_dry_run', 'policy_predictive_no_execute', 'policy_allowed', 'policy_restore',
  'prompt_worker_rejection', 'trinity_activate', 'trinity_replace', 'trinity_stale_rollback',
  'trinity_rollback', 'trinity_consumer', 'trinity_fresh_success',
  'remote_mitigation_rejection', 'trinity_run',
  'database_failure_once',
  'predictive_evaluate',
]);

type Receipt = { sequence: number; at: string; event: string };
function projectPredictiveAudit(entry: PredictiveHealingAuditEntry) {
  return {
    auditId: /^predictive_heal_audit_\d+$/u.test(entry.id) ? entry.id : 'unavailable',
    timestamp: entry.timestamp.slice(0, 32),
    source: entry.source === 'self-heal.preview.predictive-case' || entry.source === 'predictive_self_heal_loop' ? entry.source : 'other',
    selectedAction: entry.decision.action, safeToExecute: entry.decision.safeToExecute,
    advisor: entry.decision.advisor,
    mode: entry.execution.mode, status: entry.execution.status, attempted: entry.execution.attempted,
    featureFlags: { enabled: entry.featureFlags.enabled, dryRun: entry.featureFlags.dryRun, autoExecute: entry.featureFlags.autoExecute },
  };
}
export interface SelfHealingPreviewControl {
  coordinatorOptions: SelfHealingCoordinatorOptions;
  beforeClaim: () => void;
  markReady: () => void;
  close: () => Promise<void>;
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const serialized = JSON.stringify(body);
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-type', 'application/json');
  if (Buffer.byteLength(serialized) > MAX_RESPONSE_BYTES) {
    response.writeHead(500).end('{"error":"SELF_HEAL_PREVIEW_RESPONSE_LIMIT"}');
  } else response.writeHead(status).end(serialized);
}

async function readCommand(request: IncomingMessage): Promise<string | null> {
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > MAX_BODY_BYTES)) return null;
  if (request.headers['content-type'] !== 'application/json') return null;
  // HTTP server timeout sweeps are coarse. Enforce a per-body deadline even
  // when an authenticated caller advertises a body and stops sending bytes.
  const deadline = setTimeout(() => request.destroy(), BODY_READ_TIMEOUT_MS);
  deadline.unref();
  try {
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const raw of request) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) return null;
      chunks.push(chunk);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1
        || !('command' in body) || typeof body.command !== 'string' || !COMMANDS.has(body.command)) return null;
    return body.command;
  } catch { return null; }
  finally { clearTimeout(deadline); }
}

/**
 * Preview-only loopback inspection in the real application heap. It opens no
 * public route and cannot be admitted without the supervisor's exact target.
 */
export async function installSelfHealingPreviewControl(
  options: { signal?: AbortSignal } = {},
): Promise<SelfHealingPreviewControl | null> {
  const profile = resolveSelfHealingPreviewProfile(Object.fromEntries(PROFILE_NAMES.map(name => [name, getEnv(name)])));
  if (!profile) return null;
  const processInstanceId = randomUUID();
  const originalPolicy = new Map(POLICY_NAMES.map(name => [name, getEnv(name)]));
  const receipts: Receipt[] = [];
  let sequence = 0;
  let ready = false;
  let closed = false;
  let requestCount = 0;
  let minuteStartedAt = Date.now();
  let minuteRequests = 0;
  let commandInFlight = false;
  let activeCommand: Promise<unknown> | null = null;
  let failObservation = false;
  let failClaim = false;
  let failScheduler = profile.startupMode === 'scheduler-failure';
  let holdNext = false;
  let releaseHold: (() => void) | null = null;
  let priorMitigationId: number | null = null;
  let lastTick: Promise<unknown> | null = null;
  let consumerRun: Record<string, unknown> | null = null;
  let consumerRunPromise: Promise<void> | null = null;
  let predictiveRun: Record<string, unknown> | null = null;
  let predictiveRunPromise: Promise<void> | null = null;
  const consumerClients = new WeakMap<object, string>();
  let consumerClientCount = 0;
  let lastConsumerClientId: string | null = null;
  let closePromise: Promise<void> | null = null;
  let emergencyOverrideOwned = false;
  let ownedAutonomy: number | null = null;
  const controller = new AbortController();

  const record = (event: string) => {
    receipts.push({ sequence: ++sequence, at: new Date().toISOString(), event });
    if (receipts.length > 80) receipts.shift();
    logger.info('self_heal.preview.control', {
      module: 'self_heal.preview', event, processInstanceId, runId: profile.runId,
      processKind: profile.role, sequence,
    });
  };
  const restorePolicy = () => {
    for (const [name, value] of originalPolicy) {
      if (value === undefined) unsetRuntimeEnv(name); else writeRuntimeEnv(name, value);
    }
  };
  const coordinatorOptions: SelfHealingCoordinatorOptions = {
    signal: controller.signal,
    previewConsumerRoute: SELF_HEAL_PREVIEW_CONSUMER_ROUTE,
    installScheduler: (callback, intervalMs) => {
      if (closed || Date.now() >= profile.expiresAtMs) throw new Error('SELF_HEAL_PREVIEW_EXPIRED');
      if (failScheduler) {
        failScheduler = false;
        record('scheduler_installation_failed');
        throw new Error('SELF_HEAL_PREVIEW_SCHEDULER_FAILURE');
      }
      record('scheduler_installed');
      return setInterval(callback, intervalMs);
    },
    beforeObservation: async signal => {
      if (failObservation) {
        failObservation = false;
        record('observation_failed');
        throw new Error('SELF_HEAL_PREVIEW_OBSERVATION_FAILURE');
      }
      if (!holdNext) return;
      holdNext = false;
      record('observation_held');
      await new Promise<void>(resolve => {
        let timer: ReturnType<typeof setTimeout>;
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', finish);
          releaseHold = null;
          record('observation_released');
          resolve();
        };
        releaseHold = finish;
        timer = setTimeout(finish, HOLD_MS);
        if (signal?.aborted) finish(); else signal?.addEventListener('abort', finish, { once: true });
      });
    },
  };

  const inspect = async () => {
    const config = getConfig();
    const provider = getOpenAIServiceHealth().providerRuntime;
    return {
      version: 'self-heal-preview-control/v1', processInstanceId, pid: process.pid,
      runId: profile.runId, sourceCommit: profile.sourceCommit, processKind: profile.role,
      projectId: profile.projectId, environmentId: profile.environmentId,
      serviceId: profile.serviceId, deploymentId: profile.deploymentId,
      postgresServiceId: profile.postgresServiceId, redisServiceId: profile.redisServiceId,
      expiresAt: new Date(profile.expiresAtMs).toISOString(), ready, closed,
      coordinator: getSelfHealingLoopStatus(), redis: getRedisLifecycleSnapshot(),
      policy: {
        selfImproveEnabled: config.selfImproveEnabled, actuatorMode: config.selfImproveActuatorMode,
        autonomyLevel: config.selfImproveAutonomyLevel, frozen: config.selfImproveFrozen,
        predictiveEnabled: config.predictiveHealingEnabled, predictiveDryRun: config.predictiveHealingDryRun,
        predictiveAutoExecute: config.autoExecuteHealing, killSwitch: await getKillSwitchStatus(),
      },
      trinity: getTrinitySelfHealingStatus(), promptRoute: getPromptRouteMitigationState(),
      observationHeld: releaseHold !== null, tickPending: lastTick !== null,
      claimFailurePending: failClaim,
      consumerRun,
      predictiveRun,
      predictiveAudits: buildPredictiveHealingStatusSnapshot().recentAudits.slice(-3).map(projectPredictiveAudit),
      provider: {
        reloadCount: provider.reloadCount, lastReloadAt: provider.lastReloadAt,
        lastAttemptAt: provider.lastAttemptAt, lastSuccessAt: provider.lastSuccessAt,
        lastFailureAt: provider.lastFailureAt, lastFailureCategory: provider.lastFailureCategory,
        consecutiveFailures: provider.consecutiveFailures, backoffMs: provider.backoffMs, nextRetryAt: provider.nextRetryAt,
        observedConsumerClients: consumerClientCount, lastConsumerClientId,
      },
      receipts: [...receipts],
    };
  };
  const setPolicy = async (command: string) => {
    // This closed profile changes only seven known values in this process. It
    // does not accept names/values and cannot enable remote repair credentials.
    writeRuntimeEnv('SELF_IMPROVE_ENABLED', command === 'policy_disabled' ? 'false' : 'true');
    writeRuntimeEnv('SELF_IMPROVE_ACTUATOR_MODE', 'daemon');
    writeRuntimeEnv('SELF_IMPROVE_AUTONOMY_LEVEL', command === 'policy_insufficient_autonomy' ? '2' : '3');
    writeRuntimeEnv('SELF_IMPROVE_FREEZE', command === 'policy_freeze' ? 'true' : 'false');
    const predictive = command === 'policy_predictive_dry_run' || command === 'policy_predictive_no_execute';
    writeRuntimeEnv('PREDICTIVE_HEALING_ENABLED', predictive ? 'true' : 'false');
    writeRuntimeEnv('PREDICTIVE_HEALING_DRY_RUN', command === 'policy_predictive_dry_run' ? 'true' : 'false');
    writeRuntimeEnv('PREDICTIVE_AUTO_EXECUTE', command === 'policy_predictive_dry_run' ? 'true' : 'false');
    const restrictive = command === 'policy_kill_switch' || command === 'policy_freeze';
    if (emergencyOverrideOwned && !restrictive) {
      // Consume this authority once; a later shared freeze belongs to its caller.
      emergencyOverrideOwned = false;
      await unfreezeSelfImprove('bounded-preview-next-policy-case');
      ownedAutonomy = 0;
    }
    if (ownedAutonomy !== null && !restrictive) {
      const current = await getKillSwitchStatus();
      if (!current.frozen && current.autonomyLevel === ownedAutonomy) {
        ownedAutonomy = command === 'policy_insufficient_autonomy' ? 2 : 3;
        await setAutonomyLevel(ownedAutonomy, 'bounded-preview-next-policy-case');
      } else ownedAutonomy = null;
    }
    if (restrictive) {
      emergencyOverrideOwned = true;
      await freezeSelfImprove(command === 'policy_freeze' ? 'bounded-preview-freeze-policy' : 'bounded-preview-emergency-switch');
      ownedAutonomy = 0;
    }
    record(command);
  };
  const execute = async (command: string): Promise<unknown> => {
    record(`command:${command}`);
    if (command === 'inspect') return inspect();
    if (command === 'policy_restore') {
      restorePolicy();
      // Remove only this preview's emergency override through its production API.
      if (emergencyOverrideOwned) {
        emergencyOverrideOwned = false;
        await unfreezeSelfImprove('bounded-preview-policy-restore');
      }
      if (ownedAutonomy !== null) {
        ownedAutonomy = null;
        await setAutonomyLevel(Number(originalPolicy.get('SELF_IMPROVE_AUTONOMY_LEVEL') ?? '0'), 'bounded-preview-policy-restore');
      }
    } else if (command.startsWith('policy_')) await setPolicy(command);
    else if (command === 'duplicate_start' || command === 'coordinator_start') startSelfHealingLoop(undefined, coordinatorOptions);
    else if (command === 'coordinator_stop') await stopSelfHealingLoop();
    else if (command === 'observation_throw_once') failObservation = true;
    else if (command === 'database_failure_once') {
      if (profile.role !== 'worker') return { rejected: true, reasonCode: 'worker_role_required', inspection: await inspect() };
      failClaim = true;
    }
    else if (command === 'hold_observation_once') holdNext = true;
    else if (command === 'release_observation') releaseHold?.();
    else if (command === 'scheduler_failure_once') failScheduler = true;
    else if (command === 'tick') {
      if (!lastTick) {
        const pending = runSelfHealingLoop({ trigger: 'interval', signal: controller.signal, beforeObservation: coordinatorOptions.beforeObservation,
          previewConsumerRoute: coordinatorOptions.previewConsumerRoute });
        lastTick = pending;
        void pending.catch(() => record('unexpected_tick_rejection')).finally(() => { if (lastTick === pending) lastTick = null; });
      }
    } else if (command === 'prompt_worker_rejection') {
      if (profile.role !== 'worker') return { rejected: true, reasonCode: 'worker_role_required', inspection: await inspect() };
      return { result: activatePromptRouteDegradedMode('bounded-preview-cross-process-check'), inspection: await inspect() };
    } else if (command === 'trinity_activate' || command === 'trinity_replace') {
      const config = getConfig();
      const controls = await getKillSwitchStatus();
      if (closed || profile.role !== 'worker' || !config.selfImproveEnabled || config.selfImproveFrozen
          || config.selfImproveAutonomyLevel < 3 || config.selfImproveActuatorMode !== 'daemon'
          || controls.frozen || controls.autonomyLevel < 3) {
        return { rejected: true, reasonCode: 'local_mitigation_policy_blocked', inspection: await inspect() };
      }
      priorMitigationId = getTrinitySelfHealingStatus().snapshot.final.mitigationId;
      const result = activateTrinitySelfHealingMitigation({
        stage: 'final', action: command === 'trinity_activate' ? 'bypass_final_stage' : 'enable_degraded_mode',
        reason: 'bounded-preview-local-mitigation',
      });
      return { result, consumerEvidence: 'policy_projection', consumer: getTrinitySelfHealingMitigation({ tier: 'simple', answerMode: 'explained' }), inspection: await inspect() };
    } else if (command === 'trinity_stale_rollback' || command === 'trinity_rollback') {
      const state = getTrinitySelfHealingStatus().snapshot.final;
      const result = rollbackTrinitySelfHealingMitigation({
        stage: 'final', action: state.activeAction ?? 'bypass_final_stage', reason: 'bounded-preview-rollback',
        mitigationId: command === 'trinity_stale_rollback' ? priorMitigationId : state.mitigationId,
      });
      return { result, inspection: await inspect() };
    } else if (command === 'trinity_consumer') {
      return { consumerEvidence: 'policy_projection', consumer: getTrinitySelfHealingMitigation({ tier: 'simple', answerMode: 'explained' }), inspection: await inspect() };
    } else if (command === 'trinity_fresh_success') {
      const state = getTrinitySelfHealingStatus().snapshot.final;
      noteTrinityMitigationOutcome({ stage: 'final', outcome: 'success', requestId: `preview-${processInstanceId}-${sequence}`,
        action: state.activeAction, mitigationId: state.mitigationId, sourceEndpoint: 'preview-injected-consumer-outcome' });
      return { evidence: 'injected_consumer_outcome', inspection: await inspect() };
    } else if (command === 'remote_mitigation_rejection') {
      const { executeWorkerRepairActuator, buildWorkerRepairActuatorStatus } = await import('./workerRepairActuator.js');
      let dispatchAttempts = 0;
      const dependencies = {
        onDispatch: () => { dispatchAttempts += 1; },
        fetchFn: (async () => { throw new Error('SELF_HEAL_PREVIEW_REMOTE_EFFECT_FORBIDDEN'); }) as typeof fetch,
      };
      const actuator = buildWorkerRepairActuatorStatus(dependencies);
      if (actuator.available) return { rejected: true, reasonCode: 'unexpected_actuator_configuration',
        dispatchAttempts, actuatorMode: actuator.mode, inspection: await inspect() };
      try {
        await executeWorkerRepairActuator({ source: 'bounded-preview-no-operator-approval', approval: { approved: false } }, dependencies);
        return { rejected: false, dispatchAttempts, actuatorMode: actuator.mode, inspection: await inspect() };
      } catch {
        return { rejected: true, dispatchAttempts, actuatorMode: actuator.mode, inspection: await inspect() };
      }
    } else if (command === 'predictive_evaluate') {
      const config = getConfig();
      if (closed || profile.role !== 'worker' || predictiveRunPromise !== null
          || config.predictiveHealingEnabled !== true
          || (!config.predictiveHealingDryRun && config.autoExecuteHealing)) {
        return { rejected: true, reasonCode: 'predictive_observation_policy_required', inspection: await inspect() };
      }
      // The existing production simulation contract supplies one closed, supported
      // candidate. No caller can choose observations, targets, actions or execution.
      const cleanStage = { observationsInWindow: 0, attempts: 0, activeAction: null, verified: false, cooldownUntil: null, failedActions: [] };
      const simulate: PredictiveHealingSimulationInput = {
        requestCount: 0, errorRate: 0, timeoutRate: 0, avgLatencyMs: 0, p95LatencyMs: 0, maxLatencyMs: 0, degradedCount: 0,
        workerHealth: { overallStatus: 'healthy', pending: 0, running: 0, delayed: 0, stalledRunning: 0,
          oldestPendingJobAgeMs: 0, alertCount: 0, alerts: [], degradedWorkerIds: [], unhealthyWorkerIds: [], workers: [] },
        inactivity: { inactiveDegraded: false, workerIds: [] },
        workerRuntime: { enabled: false, started: false, activeListeners: 0, workerIds: [] },
        promptRoute: { active: false, mode: null },
        trinity: { enabled: true, activeStage: null, activeAction: null, verified: false,
          config: { triggerThreshold: 3, maxAttempts: 3 },
          stages: { intake: { ...cleanStage }, reasoning: { ...cleanStage }, final: { ...cleanStage, observationsInWindow: 2 } } },
      };
      const fixedDryRun = config.predictiveHealingDryRun === true;
      predictiveRun = { evidence: 'synthetic_fault_observation', status: 'running', startedAt: new Date().toISOString(),
        source: 'self-heal.preview.predictive-case', processInstanceId };
      const pending = (async () => {
        const { createLinkedAbortController, runWithRequestAbortContext } = await import('@arcanos/runtime');
        const linked = createLinkedAbortController({ timeoutMs: 8_000, parentSignal: controller.signal });
        try {
          linked.signal.throwIfAborted();
          const result = await runWithRequestAbortContext({ controller: linked.controller, signal: linked.signal,
            deadlineAt: linked.deadlineAt, timeoutMs: 8_000 }, () => runPredictiveHealingDecision({
            source: 'self-heal.preview.predictive-case', simulate, signal: linked.signal,
            // Recommend-only admission is fixed at entry; a later config change
            // cannot grant execution. Dry-run admission remains explicitly dry.
            allowAutoExecute: fixedDryRun, ...(fixedDryRun ? { dryRun: true } : {}),
          }));
          predictiveRun = { ...predictiveRun, status: 'completed', completedAt: new Date().toISOString(),
            audit: projectPredictiveAudit(result.auditEntry) };
          record('predictive_case_completed');
        } finally { linked.cleanup(); }
      })();
      predictiveRunPromise = pending;
      void pending.catch(() => {
        predictiveRun = { ...predictiveRun, status: 'failed', reasonCode: 'SELF_HEAL_PREVIEW_PREDICTIVE_CASE_FAILED' };
        record('predictive_case_failed');
      }).finally(() => { if (predictiveRunPromise === pending) predictiveRunPromise = null; });
    } else if (command === 'trinity_run') {
      if (profile.role !== 'worker' || consumerRunPromise !== null) {
        return { rejected: true, reasonCode: 'consumer_unavailable_or_busy', inspection: await inspect() };
      }
      const requestId = `preview-consumer-${processInstanceId}-${sequence}`;
      const sourceEndpoint = 'self_heal.preview.synthetic_consumer';
      consumerRun = { requestId, sourceEndpoint, status: 'running', startedAt: new Date().toISOString(),
        processInstanceId, pid: process.pid, mitigationBefore: getTrinitySelfHealingMitigation({ tier: 'simple', answerMode: 'explained' }) };
      const pending = (async () => {
        const { getOpenAIAdapter } = await import('@core/adapters/openai.adapter.js');
        const { runTrinityWritingPipeline } = await import('@core/logic/trinityWritingPipeline.js');
        const { createRuntimeBudgetWithLimit, createLinkedAbortController, runWithRequestAbortContext, isAbortError } = await import('@arcanos/runtime');
        const linked = createLinkedAbortController({ timeoutMs: 8_000, parentSignal: controller.signal });
        const measuredStartedAt = Date.now();
        let consumerEntered = false;
        try {
          linked.signal.throwIfAborted();
          // Run and await the real production consumer. Cancellation drains it;
          // no Promise.race leaves provider work running after this receipt.
          record('consumer_started');
          consumerEntered = true;
          const client = getOpenAIAdapter().getClient();
          let clientId = consumerClients.get(client);
          if (!clientId) { clientId = `consumer-client-${++consumerClientCount}`; consumerClients.set(client, clientId); }
          lastConsumerClientId = clientId;
          consumerRun = { ...consumerRun, consumerClientId: clientId };
          const result = await runWithRequestAbortContext({
            requestId, controller: linked.controller, signal: linked.signal, deadlineAt: linked.deadlineAt, timeoutMs: 8_000,
          }, () => runTrinityWritingPipeline({
            input: { prompt: 'Write a short fictional description of a blue paper kite above a quiet meadow.', sourceEndpoint },
            context: { client, requestId, runtimeBudget: createRuntimeBudgetWithLimit(8_000),
              runOptions: { disableMemoryAccess: true, disableOptionalSideEffects: true, redactAuditContent: true,
                preserveAggregateAbortContext: true, watchdogModelTimeoutMs: 8_000, modelStageTimeoutMs: 2_000,
                cooperativeModelStageTimeout: true, requestedVerbosity: 'minimal', answerMode: 'explained', maxWords: 80,
                toolBackedCapabilities: { browse: false, verifyProvidedData: false, verifyLiveData: false,
                  confirmExternalState: false, persistData: false, callBackend: false },
              },
            },
          }));
          const latencyMs = Math.max(0, Date.now() - measuredStartedAt);
          const statusCode = result.dryRun ? 503 : result.timeoutKind ? 504 : 200;
          runtimeDiagnosticsService.recordRequestCompletion(statusCode, latencyMs, SELF_HEAL_PREVIEW_CONSUMER_ROUTE, {
            timeoutKind: result.timeoutKind, degradedModeReason: result.degradedModeReason, bypassedSubsystems: result.bypassedSubsystems,
          });
          consumerRun = { ...consumerRun, status: 'completed', completedAt: new Date().toISOString(),
            routingStages: result.routingStages, tierInfo: result.tierInfo, dryRun: result.dryRun, fallbackFlag: result.fallbackFlag,
            activeModel: result.activeModel, outputSha256: createHash('sha256').update(result.result).digest('hex'),
            outputCharacters: result.result.length, mitigationAfter: getTrinitySelfHealingStatus().snapshot.final,
            mitigationsAfter: getTrinitySelfHealingStatus().snapshot,
            diagnostics: { route: SELF_HEAL_PREVIEW_CONSUMER_ROUTE, statusCode, latencyMs, source: 'actual_preview_facade_invocation' } };
          record('consumer_completed');
        } catch (error) {
          if (consumerEntered) {
            const latencyMs = Math.max(0, Date.now() - measuredStartedAt);
            const timeoutKind = !controller.signal.aborted && (linked.signal.aborted || isAbortError(error)) ? 'pipeline_timeout' as const : undefined;
            const statusCode = controller.signal.aborted ? 499 : timeoutKind ? 504 : 502;
            runtimeDiagnosticsService.recordRequestCompletion(statusCode, latencyMs, SELF_HEAL_PREVIEW_CONSUMER_ROUTE, { timeoutKind });
            consumerRun = { ...consumerRun, diagnostics: { route: SELF_HEAL_PREVIEW_CONSUMER_ROUTE, statusCode, latencyMs,
              source: 'actual_preview_facade_invocation' } };
          }
          throw error;
        } finally { linked.cleanup(); }
      })();
      consumerRunPromise = pending;
      void pending.catch(() => {
        consumerRun = { ...consumerRun, status: 'failed', completedAt: new Date().toISOString(), reasonCode: 'SELF_HEAL_PREVIEW_CONSUMER_FAILED' };
        record('consumer_failed');
      }).finally(() => { if (consumerRunPromise === pending) consumerRunPromise = null; });
    }
    return inspect();
  };

  const server = createServer((request, response) => {
    void (async () => {
      // Reject before iterating or attaching a data listener to an unauthenticated body.
      const authorization = request.headers.authorization;
      const expected = `Bearer ${profile.controlToken}`;
      if (typeof authorization !== 'string' || Buffer.byteLength(authorization) !== Buffer.byteLength(expected)
          || !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))) {
        request.pause(); response.setHeader('connection', 'close');
        writeJson(response, 401, { error: 'SELF_HEAL_PREVIEW_UNAUTHORIZED' }); return;
      }
      if (closed || Date.now() >= profile.expiresAtMs) { writeJson(response, 410, { error: 'SELF_HEAL_PREVIEW_EXPIRED' }); return; }
      const now = Date.now();
      if (now - minuteStartedAt >= 60_000) { minuteStartedAt = now; minuteRequests = 0; }
      if (++requestCount > MAX_REQUESTS || ++minuteRequests > MAX_REQUESTS_PER_MINUTE) {
        writeJson(response, 429, { error: 'SELF_HEAL_PREVIEW_RATE_LIMIT' }); return;
      }
      if (commandInFlight) { writeJson(response, 409, { error: 'SELF_HEAL_PREVIEW_BUSY' }); return; }
      commandInFlight = true;
      try {
        let command: string | null = null;
        if (request.method === 'GET' && request.url === '/inspect') command = 'inspect';
        else if (request.method === 'POST' && request.url === '/command') command = await readCommand(request);
        if (!command) { writeJson(response, 400, { error: 'SELF_HEAL_PREVIEW_COMMAND_INVALID' }); return; }
        if (closed || Date.now() >= profile.expiresAtMs) { writeJson(response, 410, { error: 'SELF_HEAL_PREVIEW_EXPIRED' }); return; }
        const pending = execute(command);
        activeCommand = pending;
        try { writeJson(response, 200, await pending); }
        finally { if (activeCommand === pending) activeCommand = null; }
      } finally { commandInFlight = false; }
    })().catch(() => { if (!response.headersSent) writeJson(response, 500, { error: 'SELF_HEAL_PREVIEW_COMMAND_FAILED' }); else response.destroy(); });
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  server.maxConnections = 4;
  let expiryTimer: ReturnType<typeof setTimeout>;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      closed = true;
      ready = false;
      failClaim = false;
      clearTimeout(expiryTimer);
      options.signal?.removeEventListener('abort', onAbort);
      controller.abort();
      releaseHold?.();
      const drain = stopSelfHealingLoop();
      server.closeAllConnections();
      await Promise.all([drain, lastTick?.catch(() => undefined), consumerRunPromise?.catch(() => undefined), predictiveRunPromise?.catch(() => undefined), activeCommand?.catch(() => undefined), new Promise<void>((resolve, reject) => {
        server.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
      })]);
      restorePolicy();
      record('control_closed');
    })();
    return closePromise;
  };
  const onAbort = () => { void close().catch(() => record('control_close_failed')); };
  try {
    if (options.signal?.aborted) throw new Error('SELF_HEAL_PREVIEW_SHUTDOWN');
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(SELF_HEAL_PREVIEW_CONTROL_PORT, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    expiryTimer = setTimeout(onAbort, Math.max(1, profile.expiresAtMs - Date.now()));
    expiryTimer.unref();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) { await close(); throw new Error('SELF_HEAL_PREVIEW_SHUTDOWN'); }
    record('control_listening');
    return {
      coordinatorOptions,
      beforeClaim: () => {
        if (!failClaim || closed || Date.now() >= profile.expiresAtMs) return;
        failClaim = false;
        record('claim_operation_failure');
        throw Object.assign(new Error('SELF_HEAL_PREVIEW_DATABASE_CLAIM_FAILURE'), { code: 'ECONNREFUSED' });
      },
      markReady: () => { if (!closed) { ready = true; record('readiness_committed'); } }, close,
    };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}
