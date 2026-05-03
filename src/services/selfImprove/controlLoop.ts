import { spawn } from 'node:child_process';
import type { Application } from 'express';
import { invokeTool } from '@arcanos/cli/client';
import { dispatchProtocolRequest } from '@arcanos/cli/transport';
import {
  createProtocolRequest,
  type ExecResumeRequestPayload,
  type ExecResumeResponseData,
  type ExecStartRequestPayload,
  type ExecStartResponseData
} from '@arcanos/protocol';
import type { Tier } from '@core/logic/trinityTier.js';
import { redactString } from '@shared/redaction.js';
import { runtimeDiagnosticsService } from '@services/runtimeDiagnosticsService.js';
import { logger } from '@platform/logging/structuredLogging.js';
import { getEnvNumber } from '@platform/runtime/env.js';
import {
  getConfig,
  getStableWorkerRuntimeMode,
  isWorkerRuntimeSuppressedForServiceRole,
} from '@platform/runtime/unifiedConfig.js';
import type { TrinitySelfHealingAction, TrinitySelfHealingStage } from './selfHealingV2.js';
import { getTrinitySelfHealingStatus } from './selfHealingV2.js';
import {
  getSelfHealingSignalsSince,
  type SelfHealingSignal,
  type SelfHealingSignalCluster
} from './signals.js';
import { evaluateSelfHealOperatorApproval } from './operatorApproval.js';

type LoopAction = TrinitySelfHealingAction | 'restart_service' | 'redeploy_service';
type LoopResult = 'idle' | 'improved' | 'failed' | 'unchanged' | 'blocked';

interface ClusterSummary {
  cluster: SelfHealingSignalCluster;
  count: number;
  impactScore: number;
  stage: TrinitySelfHealingStage | null;
  tiers: Tier[];
  routes: string[];
  sampleErrors: string[];
}

interface ObservationSummary {
  observedAt: string;
  diagnosticsErrorRate: number | null;
  serviceErrorRate: number;
  avgLatencyMs: number;
  operationalRequests: number;
  serviceErrors: number;
  clusters: ClusterSummary[];
  railwayCliLogSummary: string | null;
}

interface RuntimeMitigationState {
  activeAction: TrinitySelfHealingAction | null;
  tiers: Tier[];
  stage: TrinitySelfHealingStage | 'global' | null;
  reason: string | null;
  activeSinceMs: number | null;
  expiresAtMs: number | null;
}

export interface SelfHealingLoopStatus {
  active: boolean;
  loopRunning: boolean;
  internalExecutionAvailable: boolean;
  repoToolingAvailable: boolean | null;
  railwayCliAvailable: boolean | null;
  lastDiagnosis: string | null;
  lastAction: string | null;
  attempts: number;
  lastResult: LoopResult | null;
  errorRate: number;
  avgLatencyMs: number;
  operationalRequests: number;
  lastObservedAt: string | null;
  lastActionAt: string | null;
  lastVerifiedAt: string | null;
  incidentActive: boolean;
  incidentId: string | null;
  executionId: string | null;
  executionStatus: 'queued' | 'running' | 'completed' | 'failed' | null;
  mitigation: RuntimeMitigationState;
  latestObservation: ObservationSummary | null;
  trinity: ReturnType<typeof getTrinitySelfHealingStatus>;
}

const DEFAULT_LOOP_INTERVAL_MS = 10_000;
const DEFAULT_LOOKBACK_MS = 2 * 60_000;
const DEFAULT_ERROR_RATE_TRIGGER = 0.15;
const DEFAULT_SUCCESS_ERROR_RATE = 0.05;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_COOLDOWN_MS = 2 * 60_000;
const DEFAULT_VERIFY_GRACE_MS = 15_000;
const DEFAULT_MITIGATION_TTL_MS = 10 * 60_000;
const DEFAULT_MIN_CLUSTER_SIZE = 2;
const OPERATIONAL_ROUTE_PATTERN =
  /^(?:\/gpt\/|\/api\/arcanos\/|\/modules\/|\/workers\/|\/worker-helper\/|\/arcanos(?:-pipeline)?$|\/query-finetune$)/;

let loopTimer: NodeJS.Timeout | null = null;
let loopApp: Application | null = null;
let loopTickInFlight = false;
let loopTickQueued = false;
let internalExecutionAvailable = false;
let internalExecutionProbed = false;
let repoToolingAvailable: boolean | null = null;
let railwayCliAvailable: boolean | null = null;
let railwayCliAvailabilityCheckedAtMs = 0;

const loopState: {
  incidentId: string | null;
  attempts: number;
  attemptedActions: LoopAction[];
  signalCursorMs: number | null;
  active: boolean;
  loopRunning: boolean;
  lastDiagnosis: string | null;
  lastAction: string | null;
  lastResult: LoopResult | null;
  lastObservedAtMs: number | null;
  lastActionAtMs: number | null;
  lastVerifiedAtMs: number | null;
  cooldownUntilMs: number | null;
  verificationPendingUntilMs: number | null;
  baselineErrorRate: number | null;
  baselineLatencyMs: number | null;
  latestObservation: ObservationSummary | null;
  executionId: string | null;
  executionStatus: 'queued' | 'running' | 'completed' | 'failed' | null;
  mitigation: RuntimeMitigationState;
} = {
  incidentId: null,
  attempts: 0,
  attemptedActions: [],
  signalCursorMs: null,
  active: false,
  loopRunning: false,
  lastDiagnosis: null,
  lastAction: null,
  lastResult: null,
  lastObservedAtMs: null,
  lastActionAtMs: null,
  lastVerifiedAtMs: null,
  cooldownUntilMs: null,
  verificationPendingUntilMs: null,
  baselineErrorRate: null,
  baselineLatencyMs: null,
  latestObservation: null,
  executionId: null,
  executionStatus: null,
  mitigation: {
    activeAction: null,
    tiers: [],
    stage: null,
    reason: null,
    activeSinceMs: null,
    expiresAtMs: null
  }
};

function getLoopConfig() {
  const cfg = getConfig();
  const workerRuntimeMode = getStableWorkerRuntimeMode();
  const disabledForServiceRole = isWorkerRuntimeSuppressedForServiceRole(workerRuntimeMode);
  return {
    workerRuntimeMode,
    disabledForServiceRole,
    enabled:
      cfg.selfImproveEnabled &&
      cfg.selfImproveActuatorMode === 'daemon' &&
      cfg.selfImproveAutonomyLevel >= 3 &&
      !cfg.selfImproveFrozen &&
      !disabledForServiceRole,
    intervalMs: Math.max(5_000, getEnvNumber('SELF_HEAL_LOOP_INTERVAL_MS', DEFAULT_LOOP_INTERVAL_MS)),
    lookbackMs: Math.max(30_000, getEnvNumber('SELF_HEAL_LOOKBACK_MS', DEFAULT_LOOKBACK_MS)),
    errorRateTrigger: clampRate(getEnvNumber('SELF_HEAL_ERROR_RATE_TRIGGER_BPS', DEFAULT_ERROR_RATE_TRIGGER * 10_000) / 10_000),
    successErrorRate: clampRate(getEnvNumber('SELF_HEAL_SUCCESS_ERROR_RATE_BPS', DEFAULT_SUCCESS_ERROR_RATE * 10_000) / 10_000),
    maxAttempts: Math.max(1, Math.min(5, getEnvNumber('SELF_HEAL_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS))),
    cooldownMs: Math.max(10_000, getEnvNumber('SELF_HEAL_COOLDOWN_MS', DEFAULT_COOLDOWN_MS)),
    verifyGraceMs: Math.max(5_000, getEnvNumber('SELF_HEAL_VERIFY_GRACE_MS', DEFAULT_VERIFY_GRACE_MS)),
    mitigationTtlMs: Math.max(60_000, getEnvNumber('SELF_HEAL_MITIGATION_TTL_MS', DEFAULT_MITIGATION_TTL_MS)),
    minClusterSize: Math.max(1, getEnvNumber('SELF_HEAL_MIN_CLUSTER_SIZE', DEFAULT_MIN_CLUSTER_SIZE)),
  };
}

function clampRate(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function isOperationalRoute(route: string): boolean {
  return OPERATIONAL_ROUTE_PATTERN.test(route);
}

function nowIso(): string {
  return new Date().toISOString();
}

function createIncidentId(): string {
  return `incident-${Date.now().toString(36)}`;
}

function createProtocolRequestId(command: string): string {
  return `self-heal-${command}-${Date.now().toString(36)}`;
}

function buildProtocolContext() {
  return {
    environment: 'workspace',
    cwd: process.cwd(),
    caller: {
      id: 'self-heal.loop',
      type: 'automation',
      scopes: ['repo:read', 'tools:invoke', 'exec:start']
    }
  };
}

function buildExecutionLogLine(event: string, details: Record<string, unknown>): string {
  return `${JSON.stringify({
    timestamp: nowIso(),
    event,
    ...details
  })}\n`;
}

function summarizeCluster(cluster: ClusterSummary | null): string | null {
  if (!cluster) {
    return null;
  }

  const routeSummary = cluster.routes.length > 0 ? ` routes=${cluster.routes.join(',')}` : '';
  const stageSummary = cluster.stage ? ` stage=${cluster.stage}` : '';
  const tierSummary = cluster.tiers.length > 0 ? ` tiers=${cluster.tiers.join(',')}` : '';
  return `${cluster.cluster} count=${cluster.count}${stageSummary}${tierSummary}${routeSummary}`;
}

function getImpactWeight(cluster: SelfHealingSignalCluster): number {
  switch (cluster) {
    case 'timeout_cluster':
      return 4;
    case 'provider_failure':
      return 3;
    case 'worker_stall':
      return 3;
    case 'validation_error':
      return 1;
    default:
      return 1;
  }
}

function buildClusterSummaries(signals: SelfHealingSignal[]): ClusterSummary[] {
  const buckets = new Map<string, ClusterSummary>();

  for (const signal of signals) {
    if (signal.kind === 'http') {
      if (signal.expected || !signal.cluster || !isOperationalRoute(signal.route)) {
        continue;
      }

      const bucketKey = `${signal.cluster}|route:${signal.route}`;
      const existing = buckets.get(bucketKey);
      if (existing) {
        existing.count += 1;
        existing.impactScore += getImpactWeight(signal.cluster);
        if (!existing.routes.includes(signal.route)) {
          existing.routes.push(signal.route);
        }
        continue;
      }

      buckets.set(bucketKey, {
        cluster: signal.cluster,
        count: 1,
        impactScore: getImpactWeight(signal.cluster),
        stage: null,
        tiers: [],
        routes: [signal.route],
        sampleErrors: [`http:${signal.statusCode}`]
      });
      continue;
    }

    const bucketKey = `${signal.cluster}|stage:${signal.stage}|tier:${signal.tier}`;
    const existing = buckets.get(bucketKey);
    if (existing) {
      existing.count += 1;
      existing.impactScore += getImpactWeight(signal.cluster);
      if (!existing.tiers.includes(signal.tier)) {
        existing.tiers.push(signal.tier);
      }
      if (signal.sourceEndpoint && !existing.routes.includes(signal.sourceEndpoint)) {
        existing.routes.push(signal.sourceEndpoint);
      }
      if (existing.sampleErrors.length < 3 && !existing.sampleErrors.includes(signal.error)) {
        existing.sampleErrors.push(signal.error);
      }
      continue;
    }

    buckets.set(bucketKey, {
      cluster: signal.cluster,
      count: 1,
      impactScore: getImpactWeight(signal.cluster),
      stage: signal.stage,
      tiers: [signal.tier],
      routes: signal.sourceEndpoint ? [signal.sourceEndpoint] : [],
      sampleErrors: [signal.error]
    });
  }

  return [...buckets.values()].sort((left, right) => {
    if (right.impactScore !== left.impactScore) {
      return right.impactScore - left.impactScore;
    }
    return right.count - left.count;
  });
}

async function dispatchLocalExecutionRequest<TPayload, TData>(
  command: 'exec.start' | 'exec.resume' | 'exec.status',
  payload: TPayload
): Promise<TData> {
  const response = await dispatchProtocolRequest(
    createProtocolRequest({
      requestId: createProtocolRequestId(command),
      command,
      context: buildProtocolContext(),
      payload
    }),
    'local',
    {}
  );

  if (!response.ok) {
    throw new Error(response.error?.message ?? `${command} failed.`);
  }

  return response.data as TData;
}

async function probeLocalExecutionRuntime(): Promise<boolean> {
  const startedState = await dispatchLocalExecutionRequest<ExecStartRequestPayload, ExecStartResponseData>(
    'exec.start',
    {
      task: {
        id: createIncidentId(),
        command: 'tool.invoke',
        payload: { probe: true },
        context: buildProtocolContext()
      }
    }
  );
  const executionId = startedState.state.executionId;
  await dispatchLocalExecutionRequest<ExecResumeRequestPayload, ExecResumeResponseData>(
    'exec.resume',
    {
      executionId,
      status: 'completed',
      exitCode: 0,
      stdoutAppend: buildExecutionLogLine('probe', { ok: true })
    }
  );
  return true;
}

async function startIncidentExecution(observation: ObservationSummary, cluster: ClusterSummary | null): Promise<void> {
  if (
    !loopState.incidentId
    || (loopState.executionId !== null && loopState.executionStatus !== 'completed' && loopState.executionStatus !== 'failed')
  ) {
    return;
  }

  const response = await dispatchLocalExecutionRequest<ExecStartRequestPayload, ExecStartResponseData>(
    'exec.start',
    {
      task: {
        id: loopState.incidentId,
        command: 'tool.invoke',
        payload: {
          incidentId: loopState.incidentId,
          diagnosis: summarizeCluster(cluster),
          observedAt: observation.observedAt
        },
        context: buildProtocolContext()
      }
    }
  );

  loopState.executionId = response.state.executionId;
  loopState.executionStatus = response.state.status;
  internalExecutionAvailable = true;
}

async function resumeIncidentExecution(params: {
  status: 'running' | 'completed' | 'failed';
  event: string;
  details: Record<string, unknown>;
}): Promise<void> {
  if (!loopState.executionId) {
    return;
  }

  const payload: ExecResumeRequestPayload = {
    executionId: loopState.executionId,
    status: params.status,
    stdoutAppend: buildExecutionLogLine(params.event, params.details),
    exitCode: params.status === 'failed' ? 1 : params.status === 'completed' ? 0 : null,
    finishedAt: params.status === 'running' ? undefined : nowIso()
  };
  const response = await dispatchLocalExecutionRequest<ExecResumeRequestPayload, ExecResumeResponseData>(
    'exec.resume',
    payload
  );
  loopState.executionStatus = response.state.status;
  internalExecutionAvailable = true;
}

async function closeIncident(params: {
  result: 'improved' | 'failed' | 'idle';
  detail: string;
}): Promise<void> {
  const closedAtMs = Date.now();
  if (loopState.incidentId) {
    try {
      await resumeIncidentExecution({
        status: params.result === 'failed' ? 'failed' : 'completed',
        event: 'incident.closed',
        details: {
          incidentId: loopState.incidentId,
          result: params.result,
          detail: params.detail,
          attempts: loopState.attempts,
          mitigation: loopState.mitigation.activeAction
        }
      });
    } catch (error) {
      logger.warn('self_heal.loop.execution_close_failed', {
        module: 'self_heal.loop',
        incidentId: loopState.incidentId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  loopState.signalCursorMs = closedAtMs;
  loopState.incidentId = null;
  loopState.attemptedActions = [];
  loopState.verificationPendingUntilMs = null;
  loopState.baselineErrorRate = null;
  loopState.baselineLatencyMs = null;
}

async function safeProbeInternalExecution(): Promise<boolean> {
  if (internalExecutionProbed) {
    return internalExecutionAvailable;
  }

  internalExecutionProbed = true;
  try {
    await probeLocalExecutionRuntime();
    internalExecutionAvailable = true;
  } catch (error) {
    internalExecutionAvailable = false;
    logger.warn('self_heal.loop.local_execution_unavailable', {
      module: 'self_heal.loop',
      error: error instanceof Error ? error.message : String(error)
    });
  }

  try {
    await invokeTool({
      toolId: 'repo.listTree',
      inputs: { path: 'src/services/selfImprove', depth: 1, limit: 25 },
      transport: 'python',
      context: {
        environment: 'workspace',
        cwd: process.cwd()
      }
    });
    repoToolingAvailable = true;
    logger.info('self_heal.loop.protocol_available', {
      module: 'self_heal.loop'
    });
  } catch (error) {
    repoToolingAvailable = false;
    logger.warn('self_heal.loop.protocol_unavailable', {
      module: 'self_heal.loop',
      error: error instanceof Error ? error.message : String(error)
    });
  }

  return internalExecutionAvailable;
}

async function runRailwayCli(args: string[], timeoutMs = 45_000): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null; }> {
  const command = process.platform === 'win32' ? 'railway.cmd' : 'railway';

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    if (typeof timeout.unref === 'function') {
      timeout.unref();
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        railwayCliAvailable = false;
        railwayCliAvailabilityCheckedAtMs = Date.now();
      }
      resolve({
        ok: false,
        stdout,
        stderr: `${stderr}${error.message}`,
        exitCode: null
      });
    });
    child.on('close', (exitCode) => {
      clearTimeout(timeout);
      railwayCliAvailable = !timedOut && exitCode === 0;
      railwayCliAvailabilityCheckedAtMs = Date.now();
      resolve({
        ok: !timedOut && exitCode === 0,
        stdout,
        stderr: timedOut ? `${stderr}Timed out after ${timeoutMs}ms` : stderr,
        exitCode
      });
    });
  });
}

async function readRailwayCliLogSummary(): Promise<string | null> {
  const nowMs = Date.now();
  if (railwayCliAvailable === false && (nowMs - railwayCliAvailabilityCheckedAtMs) < 10 * 60_000) {
    return null;
  }

  const result = await runRailwayCli(['logs', '--since', '2m', '--lines', '120', '--json'], 20_000);
  if (!result.ok || result.stdout.trim().length === 0) {
    return null;
  }

  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const interesting = lines.filter((line) =>
    line.includes('request.completed')
    || line.includes('handler.error')
    || line.includes('intake failed')
    || line.includes('reasoning failed')
    || line.includes('final failed')
    || line.includes('MODULE_TIMEOUT')
  );

  if (interesting.length === 0) {
    return null;
  }

  return redactString(interesting.slice(-5).join(' | '));
}

async function collectObservation(app: Application): Promise<ObservationSummary> {
  const config = getLoopConfig();
  const diagnostics = await runtimeDiagnosticsService.getDiagnosticsSnapshot(app);
  const diagnosticsErrorRate = typeof diagnostics.error_rate === 'number' ? diagnostics.error_rate : null;
  const signalSinceMs = Math.max(
    Date.now() - config.lookbackMs,
    loopState.signalCursorMs ?? 0
  );
  const signals = getSelfHealingSignalsSince(signalSinceMs);
  const httpSignals = signals.filter((signal): signal is Extract<SelfHealingSignal, { kind: 'http' }> =>
    signal.kind === 'http'
      && !signal.expected
      && isOperationalRoute(signal.route)
  );
  const serviceErrors = httpSignals.filter((signal) => signal.cluster === 'timeout_cluster' || signal.cluster === 'provider_failure');
  const serviceErrorRate = httpSignals.length > 0 ? serviceErrors.length / httpSignals.length : 0;
  const avgLatencyMs = httpSignals.length > 0
    ? Math.round(httpSignals.reduce((sum, signal) => sum + signal.latencyMs, 0) / httpSignals.length)
    : 0;

  return {
    observedAt: nowIso(),
    diagnosticsErrorRate,
    serviceErrorRate,
    avgLatencyMs,
    operationalRequests: httpSignals.length,
    serviceErrors: serviceErrors.length,
    clusters: buildClusterSummaries(signals),
    railwayCliLogSummary: await readRailwayCliLogSummary()
  };
}

function expireMitigationIfNeeded(nowMs: number): void {
  const mitigation = loopState.mitigation;
  if (mitigation.expiresAtMs !== null && mitigation.expiresAtMs <= nowMs) {
    logger.info('self_heal.loop.mitigation_expired', {
      module: 'self_heal.loop',
      action: mitigation.activeAction,
      stage: mitigation.stage,
      tiers: mitigation.tiers
    });
    clearLoopMitigation('expired');
  }
}

function getLoopMitigationActionCandidates(cluster: ClusterSummary): LoopAction[] {
  if (cluster.cluster === 'timeout_cluster') {
    if (cluster.stage === 'final') {
      return ['bypass_final_stage', 'enable_degraded_mode', 'restart_service'];
    }
    return ['enable_degraded_mode', 'restart_service'];
  }

  if (cluster.cluster === 'provider_failure') {
    return ['enable_degraded_mode', 'restart_service', 'redeploy_service'];
  }

  if (cluster.cluster === 'worker_stall') {
    return ['restart_service', 'redeploy_service'];
  }

  return [];
}

function chooseAction(cluster: ClusterSummary | null): LoopAction | null {
  if (!cluster) {
    return null;
  }

  const candidates = getLoopMitigationActionCandidates(cluster);
  return candidates.find((candidate) => !loopState.attemptedActions.includes(candidate)) ?? null;
}

function applyLoopMitigation(params: {
  action: TrinitySelfHealingAction;
  cluster: ClusterSummary;
  reason: string;
}): void {
  const config = getLoopConfig();
  const tiers: Tier[] = params.cluster.tiers.length > 0 ? params.cluster.tiers : ['complex'];
  loopState.mitigation = {
    activeAction: params.action,
    tiers,
    stage: params.cluster.stage ?? 'global',
    reason: params.reason,
    activeSinceMs: Date.now(),
    expiresAtMs: Date.now() + config.mitigationTtlMs
  };

  logger.warn('self_heal.loop.action_applied', {
    module: 'self_heal.loop',
    action: params.action,
    diagnosis: params.cluster.cluster,
    stage: params.cluster.stage,
    tiers,
    reason: params.reason
  });
}

function clearLoopMitigation(reason: string): void {
  const mitigation = loopState.mitigation;
  if (!mitigation.activeAction) {
    return;
  }

  logger.warn('self_heal.loop.mitigation_cleared', {
    module: 'self_heal.loop',
    action: mitigation.activeAction,
    stage: mitigation.stage,
    tiers: mitigation.tiers,
    reason
  });

  loopState.mitigation = {
    activeAction: null,
    tiers: [],
    stage: null,
    reason: null,
    activeSinceMs: null,
    expiresAtMs: null
  };
}

async function executeLoopAction(action: LoopAction, cluster: ClusterSummary): Promise<{ ok: boolean; layer: 'internal' | 'railway-cli'; detail: string; }> {
  await safeProbeInternalExecution();

  if (action === 'enable_degraded_mode' || action === 'bypass_final_stage') {
    applyLoopMitigation({
      action,
      cluster,
      reason: `${cluster.cluster} observed ${cluster.count} times`
    });
    return {
      ok: true,
      layer: 'internal',
      detail: `Applied ${action} for ${cluster.cluster}`
    };
  }

  const serviceName = process.env.RAILWAY_SERVICE_NAME?.trim() || 'ARCANOS V2';
  const approval = evaluateSelfHealOperatorApproval({
    action,
    required: true
  });
  if (!approval.satisfied) {
    return {
      ok: false,
      layer: 'railway-cli',
      detail: approval.reason ?? `${action} requires explicit operator approval.`
    };
  }

  const railwayArgs = action === 'restart_service'
    ? ['restart', '--service', serviceName, '-y']
    : ['redeploy', '--service', serviceName, '-y'];
  const result = await runRailwayCli(railwayArgs);

  return {
    ok: result.ok,
    layer: 'railway-cli',
    detail: result.ok
      ? `${action} succeeded for ${serviceName}`
      : `${action} failed: ${result.stderr || result.stdout || 'unknown railway cli error'}`
  };
}

function shouldTreatAsIncident(observation: ObservationSummary, cluster: ClusterSummary | null): boolean {
  const config = getLoopConfig();
  const errorRateTriggered =
    observation.serviceErrorRate >= config.errorRateTrigger
    && observation.serviceErrors >= config.minClusterSize;

  if (!cluster) {
    return errorRateTriggered;
  }

  return cluster.count >= config.minClusterSize || errorRateTriggered;
}

function summarizePostActionSignals(sinceMs: number): {
  successCount: number;
  failureCount: number;
} {
  const signals = getSelfHealingSignalsSince(sinceMs);
  let successCount = 0;
  let failureCount = 0;

  for (const signal of signals) {
    if (signal.kind === 'stage_failure') {
      failureCount += 1;
      continue;
    }

    if (!isOperationalRoute(signal.route)) {
      continue;
    }

    if (signal.statusCode < 400) {
      successCount += 1;
      continue;
    }

    if (!signal.expected && (signal.cluster === 'timeout_cluster' || signal.cluster === 'provider_failure')) {
      failureCount += 1;
    }
  }

  return { successCount, failureCount };
}

function markImproved(observation: ObservationSummary): void {
  loopState.lastResult = 'improved';
  loopState.lastVerifiedAtMs = Date.now();
  loopState.cooldownUntilMs = Date.now() + getLoopConfig().cooldownMs;
  logger.info('self_heal.loop.verify', {
    module: 'self_heal.loop',
    outcome: 'improved',
    errorRate: observation.serviceErrorRate,
    avgLatencyMs: observation.avgLatencyMs,
    lastAction: loopState.lastAction
  });
}

function markUnchanged(observation: ObservationSummary): void {
  loopState.lastResult = 'unchanged';
  loopState.lastVerifiedAtMs = Date.now();
  logger.warn('self_heal.loop.verify', {
    module: 'self_heal.loop',
    outcome: 'unchanged',
    errorRate: observation.serviceErrorRate,
    avgLatencyMs: observation.avgLatencyMs,
    lastAction: loopState.lastAction
  });
}

function markFailed(detail: string): void {
  loopState.lastResult = 'failed';
  loopState.lastVerifiedAtMs = Date.now();
  logger.error('self_heal.loop.verify', {
    module: 'self_heal.loop',
    outcome: 'failed',
    detail,
    lastAction: loopState.lastAction
  });
}

async function runLoopTick(): Promise<void> {
  const config = getLoopConfig();
  loopState.active = config.enabled;
  if (!config.enabled || !loopApp) {
    loopState.loopRunning = false;
    return;
  }

  if (loopTickInFlight) {
    loopTickQueued = true;
    return;
  }

  loopTickInFlight = true;
  loopState.loopRunning = true;

  try {
    expireMitigationIfNeeded(Date.now());

    const observation = await collectObservation(loopApp);
    loopState.latestObservation = observation;
    loopState.lastObservedAtMs = Date.now();
    const topCluster = observation.clusters[0] ?? null;
    loopState.lastDiagnosis = summarizeCluster(topCluster);

    const incidentActive = shouldTreatAsIncident(observation, topCluster);
    if (!incidentActive) {
      if (loopState.mitigation.activeAction) {
        if (observation.serviceErrorRate <= config.successErrorRate) {
          markImproved(observation);
          await closeIncident({
            result: 'improved',
            detail: 'error_rate_below_success_threshold'
          });
        } else {
          markUnchanged(observation);
        }
      } else {
        loopState.lastResult = 'idle';
        if (loopState.incidentId) {
          await closeIncident({
            result: 'idle',
            detail: 'observation_below_incident_threshold'
          });
        }
      }
      return;
    }

    const nowMs = Date.now();
    if (!loopState.incidentId) {
      loopState.incidentId = createIncidentId();
      loopState.attempts = 0;
      loopState.attemptedActions = [];
      loopState.baselineErrorRate = observation.serviceErrorRate;
      loopState.baselineLatencyMs = observation.avgLatencyMs;
      await startIncidentExecution(observation, topCluster);
      await resumeIncidentExecution({
        status: 'running',
        event: 'incident.detected',
        details: {
          incidentId: loopState.incidentId,
          diagnosis: loopState.lastDiagnosis,
          errorRate: observation.serviceErrorRate,
          avgLatencyMs: observation.avgLatencyMs,
          railwayCliLogSummary: observation.railwayCliLogSummary
        }
      });
    }

      if (loopState.cooldownUntilMs !== null && loopState.cooldownUntilMs > nowMs) {
        loopState.lastResult = 'blocked';
      await resumeIncidentExecution({
        status: 'running',
        event: 'incident.cooldown',
        details: {
          incidentId: loopState.incidentId,
          cooldownUntil: new Date(loopState.cooldownUntilMs).toISOString(),
          diagnosis: loopState.lastDiagnosis
        }
      });
      return;
    }

    if (loopState.mitigation.activeAction) {
      if (loopState.verificationPendingUntilMs !== null && loopState.verificationPendingUntilMs > nowMs) {
        loopState.lastResult = 'blocked';
        return;
      }

      const postActionSignals = summarizePostActionSignals(loopState.lastActionAtMs ?? nowMs);
      const improved = postActionSignals.failureCount === 0 && postActionSignals.successCount > 0;
      if (improved) {
        markImproved(observation);
        await closeIncident({
          result: 'improved',
          detail: 'mitigation_reduced_error_rate'
        });
        return;
      }

      if (postActionSignals.failureCount === 0 && postActionSignals.successCount === 0) {
        loopState.lastResult = 'blocked';
        return;
      }

      if (loopState.attempts >= config.maxAttempts) {
        markFailed('max_attempts_reached');
        clearLoopMitigation('max_attempts_reached');
        loopState.cooldownUntilMs = nowMs + config.cooldownMs;
        await closeIncident({
          result: 'failed',
          detail: 'max_attempts_reached'
        });
        return;
      }

      clearLoopMitigation('mitigation_did_not_reduce_error_rate');
    }

    const action = chooseAction(topCluster);
    if (!action || !topCluster) {
      loopState.lastResult = 'blocked';
      await resumeIncidentExecution({
        status: 'running',
        event: 'incident.blocked',
        details: {
          incidentId: loopState.incidentId,
          diagnosis: loopState.lastDiagnosis,
          attemptedActions: loopState.attemptedActions
        }
      });
      return;
    }

    const execution = await executeLoopAction(action, topCluster);
    loopState.attempts += 1;
    loopState.lastAction = action;
    loopState.lastActionAtMs = nowMs;
    loopState.attemptedActions.push(action);

    logger.warn('self_heal.loop.execution', {
      module: 'self_heal.loop',
      incidentId: loopState.incidentId,
      diagnosis: loopState.lastDiagnosis,
      action,
      layer: execution.layer,
      ok: execution.ok,
      detail: execution.detail,
      attempts: loopState.attempts
    });

    await resumeIncidentExecution({
      status: execution.ok ? 'running' : 'failed',
      event: 'incident.action',
      details: {
        incidentId: loopState.incidentId,
        diagnosis: loopState.lastDiagnosis,
        action,
        layer: execution.layer,
        ok: execution.ok,
        detail: execution.detail,
        attempts: loopState.attempts
      }
    });

    if (!execution.ok) {
      loopState.cooldownUntilMs = nowMs + config.cooldownMs;
      markFailed(execution.detail);
      await closeIncident({
        result: 'failed',
        detail: execution.detail
      });
    } else {
      loopState.verificationPendingUntilMs = nowMs + config.verifyGraceMs;
      loopState.lastResult = 'blocked';
    }
  } catch (error) {
    markFailed(error instanceof Error ? error.message : String(error));
    await closeIncident({
      result: 'failed',
      detail: error instanceof Error ? error.message : String(error)
    });
  } finally {
    loopTickInFlight = false;
    if (loopTickQueued) {
      loopTickQueued = false;
      void runLoopTick();
    }
  }
}

export async function requestSelfHealingLoopEvaluation(_reason = 'signal'): Promise<void> {
  if (!loopApp || !getLoopConfig().enabled) {
    return;
  }

  await runLoopTick();
}

export function startSelfHealingControlLoop(app: Application): void {
  loopApp = app;
  const config = getLoopConfig();
  loopState.active = config.enabled;
  if (
    process.env.NODE_ENV === 'test' &&
    process.env.ENABLE_SELF_HEAL_CONTROL_LOOP_IN_TESTS !== 'true'
  ) {
    loopApp = null;
    loopState.active = false;
    loopState.loopRunning = false;
    logger.info('self_heal.loop.disabled_for_test', {
      module: 'self_heal.loop',
      reason: 'test_environment'
    });
    return;
  }

  if (!config.enabled) {
    if (config.disabledForServiceRole) {
      logger.info('self_heal.loop.disabled_for_service_role', {
        module: 'self_heal.loop',
        processKind: config.workerRuntimeMode.processKind,
        serviceName: config.workerRuntimeMode.railwayServiceName,
        reason: config.workerRuntimeMode.reason,
      });
    }
    loopState.loopRunning = false;
    return;
  }

  if (loopTimer) {
    return;
  }

  void safeProbeInternalExecution();
  loopTimer = setInterval(() => {
    void runLoopTick();
  }, config.intervalMs);

  if (typeof loopTimer.unref === 'function') {
    loopTimer.unref();
  }

  loopState.loopRunning = true;
  void runLoopTick();
}

export function stopSelfHealingControlLoopForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    return;
  }

  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }

  loopApp = null;
  loopTickInFlight = false;
  loopTickQueued = false;
  internalExecutionAvailable = false;
  internalExecutionProbed = false;
  repoToolingAvailable = null;
  railwayCliAvailable = null;
  railwayCliAvailabilityCheckedAtMs = 0;
  loopState.incidentId = null;
  loopState.attempts = 0;
  loopState.attemptedActions = [];
  loopState.signalCursorMs = null;
  loopState.active = false;
  loopState.loopRunning = false;
  loopState.lastDiagnosis = null;
  loopState.lastAction = null;
  loopState.lastResult = null;
  loopState.lastObservedAtMs = null;
  loopState.lastActionAtMs = null;
  loopState.lastVerifiedAtMs = null;
  loopState.cooldownUntilMs = null;
  loopState.verificationPendingUntilMs = null;
  loopState.baselineErrorRate = null;
  loopState.baselineLatencyMs = null;
  loopState.latestObservation = null;
  loopState.executionId = null;
  loopState.executionStatus = null;
  clearLoopMitigation('test_reset');
}

export function getSelfHealingLoopMitigation(params: { tier: Tier }): {
  forceDirectAnswer: boolean;
  bypassFinalStage: boolean;
  activeAction: TrinitySelfHealingAction | null;
  stage: TrinitySelfHealingStage | 'global' | null;
} {
  expireMitigationIfNeeded(Date.now());
  const mitigation = loopState.mitigation;
  const appliesToTier = mitigation.tiers.includes(params.tier);
  if (!appliesToTier || !mitigation.activeAction) {
    return {
      forceDirectAnswer: false,
      bypassFinalStage: false,
      activeAction: null,
      stage: null
    };
  }

  return {
    forceDirectAnswer: mitigation.activeAction === 'enable_degraded_mode',
    bypassFinalStage: mitigation.activeAction === 'bypass_final_stage',
    activeAction: mitigation.activeAction,
    stage: mitigation.stage
  };
}

export function getSelfHealingControlLoopStatus(): SelfHealingLoopStatus {
  const latestObservation = loopState.latestObservation;
  return {
    active: loopState.active,
    loopRunning: loopState.loopRunning,
    internalExecutionAvailable,
    repoToolingAvailable,
    railwayCliAvailable,
    lastDiagnosis: loopState.lastDiagnosis,
    lastAction: loopState.lastAction,
    attempts: loopState.attempts,
    lastResult: loopState.lastResult,
    errorRate: latestObservation?.serviceErrorRate ?? 0,
    avgLatencyMs: latestObservation?.avgLatencyMs ?? 0,
    operationalRequests: latestObservation?.operationalRequests ?? 0,
    lastObservedAt: loopState.lastObservedAtMs ? new Date(loopState.lastObservedAtMs).toISOString() : null,
    lastActionAt: loopState.lastActionAtMs ? new Date(loopState.lastActionAtMs).toISOString() : null,
    lastVerifiedAt: loopState.lastVerifiedAtMs ? new Date(loopState.lastVerifiedAtMs).toISOString() : null,
    incidentActive: Boolean(loopState.incidentId),
    incidentId: loopState.incidentId,
    executionId: loopState.executionId,
    executionStatus: loopState.executionStatus,
    mitigation: { ...loopState.mitigation, tiers: [...loopState.mitigation.tiers] },
    latestObservation,
    trinity: getTrinitySelfHealingStatus()
  };
}
