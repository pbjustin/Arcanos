import { recoverStaleJobs } from '@core/db/repositories/jobRepository.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { getTelemetrySnapshot } from '@platform/logging/telemetry.js';
import { getEnvNumber } from '@platform/runtime/env.js';
import { getConfig } from '@platform/runtime/unifiedConfig.js';
import {
  runSelfImproveCycle,
  type SelfImproveDecision,
  type SelfImproveTrigger
} from '@services/selfImprove/controller.js';
import {
  activateTrinitySelfHealingMitigation,
  getTrinitySelfHealingStatus,
  rollbackTrinitySelfHealingMitigation,
  type TrinitySelfHealingAction,
  type TrinitySelfHealingStage
} from '@services/selfImprove/selfHealingV2.js';
import {
  activatePromptRouteDegradedMode,
  activatePromptRouteReducedLatencyMode,
  getPromptRouteMitigationState,
  resetPromptRouteMitigationStateForTests,
  rollbackPromptRouteMitigation
} from '@services/openai/promptRouteMitigation.js';
import { getOpenAIServiceHealth } from '@services/openai/serviceHealth.js';
import { runtimeDiagnosticsService, type RequestWindowSnapshot } from '@services/runtimeDiagnosticsService.js';
import {
  getWorkerControlHealth,
  healWorkerRuntime,
  type WorkerControlHealthResponse
} from '@services/workerControlService.js';
import { getWorkerAutonomySettings } from '@services/workerAutonomyService.js';
import type { WorkerRuntimeStatus } from '@platform/runtime/workerConfig.js';

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_ACTION_COOLDOWN_MS = 120_000;
const DEFAULT_CONTROLLER_COOLDOWN_MS = 300_000;
const DEFAULT_SIGNAL_WINDOW_MS = 5 * 60_000;
const DEFAULT_VERIFICATION_DELAY_MS = 90_000;
const DEFAULT_INCIDENT_WINDOW_MS = 10 * 60_000;
const DEFAULT_MAX_ATTEMPTS_PER_DIAGNOSIS = 3;
const DEFAULT_MIN_REQUEST_COUNT = 12;
const DEFAULT_ERROR_RATE_THRESHOLD = 0.18;
const DEFAULT_TIMEOUT_RATE_THRESHOLD = 0.15;
const DEFAULT_TIMEOUT_COUNT_THRESHOLD = 3;
const DEFAULT_LATENCY_P95_THRESHOLD_MS = 4_500;
const DEFAULT_AVG_LATENCY_THRESHOLD_MS = 2_000;
const DEFAULT_MAX_LATENCY_THRESHOLD_MS = 5_000;
const DEFAULT_LATENCY_BURST_COUNT_THRESHOLD = 2;
const DEFAULT_PROVIDER_FAILURE_THRESHOLD = 3;
const DEFAULT_VALIDATION_NOISE_THRESHOLD = 6;
const DEFAULT_INEFFECTIVE_COOLDOWN_MS = 10 * 60_000;
const DEFAULT_PROMPT_ROUTE_VERIFICATION_MIN_REQUESTS = 3;
const SELF_HEAL_RUNTIME_KEY = '__ARCANOS_SELF_HEAL_RUNTIME__';
const PROMPT_ROUTE_PATH = '/api/openai/prompt';
const VERIFICATION_SUCCESS_SIGNAL_COUNT = 2;
const VERIFICATION_FAILURE_SIGNAL_COUNT = 2;
const VERIFICATION_TIMEOUT_COUNT_WORSE_DELTA = 1;
const ERROR_RATE_TREND_THRESHOLDS = {
  betterAbsoluteDelta: 0.03,
  worseAbsoluteDelta: 0.02,
  betterRatio: 0.8,
  worseRatio: 1.1
} as const;
const TIMEOUT_RATE_TREND_THRESHOLDS = {
  betterAbsoluteDelta: 0.05,
  worseAbsoluteDelta: 0.05,
  betterRatio: 0.75,
  worseRatio: 1.2
} as const;
const P95_LATENCY_TREND_THRESHOLDS = {
  betterAbsoluteDelta: 500,
  worseAbsoluteDelta: 500,
  betterRatio: 0.85,
  worseRatio: 1.1
} as const;
const MAX_LATENCY_TREND_THRESHOLDS = {
  betterAbsoluteDelta: 1_000,
  worseAbsoluteDelta: 1_000,
  betterRatio: 0.75,
  worseRatio: 1.15
} as const;
const PROMPT_ROUTE_ERROR_TREND_THRESHOLDS = {
  betterAbsoluteDelta: 0.08,
  worseAbsoluteDelta: 0.05,
  betterRatio: 0.7,
  worseRatio: 1.15
} as const;
const PROMPT_ROUTE_TIMEOUT_TREND_THRESHOLDS = {
  betterAbsoluteDelta: 0.08,
  worseAbsoluteDelta: 0.05,
  betterRatio: 0.7,
  worseRatio: 1.15
} as const;
const PROMPT_ROUTE_AVG_LATENCY_TREND_THRESHOLDS = {
  betterAbsoluteDelta: 500,
  worseAbsoluteDelta: 500,
  betterRatio: 0.75,
  worseRatio: 1.15
} as const;

type DiagnosisType =
  | 'healthy'
  | 'prompt_route_stabilized'
  | 'worker_stall'
  | 'pipeline_timeout_cluster'
  | 'timeout_storm'
  | 'latency_spike'
  | 'provider_failure_cluster'
  | 'error_rate_elevated'
  | 'validation_noise'
  | 'worker_degraded'
  | 'trinity_mitigation_active'
  | 'manual'
  | 'unknown';

type VerificationOutcome = 'improved' | 'unchanged' | 'worse';

type DiagnosisAttemptState = {
  count: number;
  windowStartedAtMs: number;
  lastAttemptAtMs: number;
};

type SelfHealingVerificationSnapshot = {
  errorRate: number;
  timeoutRate: number;
  timeoutCount: number;
  p95LatencyMs: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
  stalledRunning: number;
  oldestPendingJobAgeMs: number;
  workerHealth: string | null;
  activeMitigation: string | null;
  promptRoute: {
    route: string;
    requestCount: number;
    errorCount: number;
    errorRate: number;
    timeoutCount: number;
    timeoutRate: number;
    slowRequestCount: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
    maxLatencyMs: number;
  } | null;
};

export interface SelfHealingVerificationResult {
  verifiedAt: string;
  action: string;
  diagnosis: string;
  outcome: VerificationOutcome;
  summary: string;
  baseline: SelfHealingVerificationSnapshot;
  current: SelfHealingVerificationSnapshot;
}

export interface SelfHealingLoopStatus {
  active: boolean;
  loopRunning: boolean;
  startedAt: string | null;
  lastTick: string | null;
  tickCount: number;
  lastError: string | null;
  intervalMs: number;
  lastDiagnosis: string | null;
  lastAction: string | null;
  lastActionAt: string | null;
  lastControllerDecision: SelfImproveDecision['decision'] | 'ERROR' | null;
  lastControllerRunAt: string | null;
  lastWorkerHealth: string | null;
  lastTrinityMitigation: string | null;
  lastEvidence: Record<string, unknown> | null;
  lastVerificationResult: SelfHealingVerificationResult | null;
  activeMitigation: string | null;
  degradedModeReason: string | null;
  lastLatencySnapshot: {
    requestCount: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
    maxLatencyMs: number;
    degradedCount: number;
    pipelineTimeoutCount: number;
    promptRoute: SelfHealingVerificationSnapshot['promptRoute'];
  } | null;
  recentTimeoutCounts: {
    windowMs: number;
    total: number;
    promptRoute: number;
    pipelineTimeouts: number;
    providerTimeouts: number;
    workerTimeouts: number;
    budgetAborts: number;
    coreRoute: number;
  } | null;
  bypassedSubsystems: string[];
  ineffectiveActions: Record<string, string>;
  attemptsByDiagnosis: Record<string, number>;
  cooldowns: Record<string, string>;
  lastHealthyObservedAt: string | null;
}

export interface SelfHealingLoopRunResult {
  trigger: 'startup' | 'interval' | 'manual';
  tickAt: string;
  tickCount: number;
  loopRunning: boolean;
  lastError: string | null;
  diagnosis: string;
  action: string | null;
  controllerDecision: SelfImproveDecision['decision'] | 'ERROR' | null;
  evidence: Record<string, unknown> | null;
  verificationResult: SelfHealingVerificationResult | null;
}

type PendingVerification = {
  diagnosisType: DiagnosisType;
  diagnosisSummary: string;
  action: string;
  startedAt: string;
  verifyAfterMs: number;
  baseline: SelfHealingVerificationSnapshot;
  rollback:
    | {
        kind: 'trinity';
        stage: TrinitySelfHealingStage;
        action: TrinitySelfHealingAction;
        reason: string;
      }
    | {
        kind: 'prompt_route';
        reason: string;
      }
    | null;
};

type SelfHealingLoopRuntime = {
  timer: ReturnType<typeof setInterval> | null;
  inFlight: boolean;
  status: SelfHealingLoopStatus;
  actionCooldowns: Map<string, number>;
  controllerCooldowns: Map<string, number>;
  ineffectiveActionCooldowns: Map<string, number>;
  diagnosisAttempts: Map<string, DiagnosisAttemptState>;
  pendingVerification: PendingVerification | null;
};

type SelfHealingObservation = {
  workerHealth: WorkerControlHealthResponse | null;
  workerHealthError: string | null;
  workerRuntime: WorkerRuntimeStatus;
  trinityStatus: ReturnType<typeof getTrinitySelfHealingStatus>;
  requestWindow: RequestWindowSnapshot;
  telemetry: ReturnType<typeof getTelemetrySnapshot>;
  openaiHealth: ReturnType<typeof getOpenAIServiceHealth>;
};

type TelemetrySignals = {
  openaiFailureCount: number;
  resilienceFailureCount: number;
  fallbackDegradedCount: number;
  fallbackPreemptiveCount: number;
  validationNoiseCount: number;
};

type PromptRouteStabilityAssessment = {
  summary: string;
  confidence: number;
  evidence: Record<string, unknown>;
};

type SelfHealingActionPlan =
  | {
      kind: 'recover_stale_jobs';
      actionKey: 'recover_stale_jobs';
      cooldownKey: string;
      cooldownMs: number;
    }
  | {
      kind: 'heal_worker_runtime';
      actionKey: 'heal_worker_runtime';
      cooldownKey: string;
      cooldownMs: number;
    }
  | {
      kind: 'activate_trinity_degraded_mode';
      actionKey: 'activate_trinity_degraded_mode';
      cooldownKey: string;
      cooldownMs: number;
      stage: TrinitySelfHealingStage;
      trinityAction: TrinitySelfHealingAction;
    }
  | {
      kind: 'activate_prompt_route_reduced_latency_mode';
      actionKey: 'activate_prompt_route_reduced_latency_mode';
      cooldownKey: string;
      cooldownMs: number;
    }
  | {
      kind: 'activate_prompt_route_degraded_mode';
      actionKey: 'activate_prompt_route_degraded_mode';
      cooldownKey: string;
      cooldownMs: number;
    };

type SelfHealingDiagnosis = {
  type: DiagnosisType;
  incidentKey: string | null;
  summary: string;
  confidence: number;
  evidence: Record<string, unknown> | null;
  shouldRunController: boolean;
  controllerInput: SelfImproveTrigger | null;
  trinityMitigation: string | null;
  workerHealthLabel: string | null;
  actionPlan: SelfHealingActionPlan | null;
};

type SelfHealingActionExecution = {
  executed: boolean;
  action: string | null;
  pendingVerification: PendingVerification | null;
};

type SelfHealingLoopGlobal = typeof globalThis & {
  [SELF_HEAL_RUNTIME_KEY]?: SelfHealingLoopRuntime;
};

function resolveLoopIntervalMs(): number {
  return Math.max(1_000, getEnvNumber('SELF_HEAL_LOOP_INTERVAL_MS', DEFAULT_INTERVAL_MS));
}

function resolveActionCooldownMs(): number {
  return Math.max(5_000, getEnvNumber('SELF_HEAL_ACTION_COOLDOWN_MS', DEFAULT_ACTION_COOLDOWN_MS));
}

function resolveControllerCooldownMs(): number {
  return Math.max(30_000, getEnvNumber('SELF_HEAL_CONTROLLER_COOLDOWN_MS', DEFAULT_CONTROLLER_COOLDOWN_MS));
}

function resolveSignalWindowMs(): number {
  return Math.max(30_000, getEnvNumber('SELF_HEAL_SIGNAL_WINDOW_MS', DEFAULT_SIGNAL_WINDOW_MS));
}

function resolveVerificationDelayMs(): number {
  return Math.max(30_000, getEnvNumber('SELF_HEAL_VERIFICATION_DELAY_MS', DEFAULT_VERIFICATION_DELAY_MS));
}

function resolveIncidentWindowMs(): number {
  return Math.max(60_000, getEnvNumber('SELF_HEAL_INCIDENT_WINDOW_MS', DEFAULT_INCIDENT_WINDOW_MS));
}

function resolveMaxAttemptsPerDiagnosis(): number {
  return Math.max(1, getEnvNumber('SELF_HEAL_MAX_ATTEMPTS_PER_DIAGNOSIS', DEFAULT_MAX_ATTEMPTS_PER_DIAGNOSIS));
}

function resolveMinRequestCount(): number {
  return Math.max(4, getEnvNumber('SELF_HEAL_MIN_REQUEST_COUNT', DEFAULT_MIN_REQUEST_COUNT));
}

function resolveErrorRateThreshold(): number {
  return Number(getEnvNumber('SELF_HEAL_ERROR_RATE_THRESHOLD', DEFAULT_ERROR_RATE_THRESHOLD).toFixed(3));
}

function resolveTimeoutRateThreshold(): number {
  return Number(getEnvNumber('SELF_HEAL_TIMEOUT_RATE_THRESHOLD', DEFAULT_TIMEOUT_RATE_THRESHOLD).toFixed(3));
}

function resolveTimeoutCountThreshold(): number {
  return Math.max(1, getEnvNumber('SELF_HEAL_TIMEOUT_COUNT_THRESHOLD', DEFAULT_TIMEOUT_COUNT_THRESHOLD));
}

function resolveLatencyP95ThresholdMs(): number {
  return Math.max(1_500, getEnvNumber('SELF_HEAL_LATENCY_P95_THRESHOLD_MS', DEFAULT_LATENCY_P95_THRESHOLD_MS));
}

function resolveAverageLatencyThresholdMs(): number {
  return Math.max(750, getEnvNumber('SELF_HEAL_AVG_LATENCY_THRESHOLD_MS', DEFAULT_AVG_LATENCY_THRESHOLD_MS));
}

function resolveMaxLatencyThresholdMs(): number {
  return Math.max(3_000, getEnvNumber('SELF_HEAL_MAX_LATENCY_THRESHOLD_MS', DEFAULT_MAX_LATENCY_THRESHOLD_MS));
}

function resolveLatencyBurstCountThreshold(): number {
  return Math.max(1, getEnvNumber('SELF_HEAL_LATENCY_BURST_COUNT_THRESHOLD', DEFAULT_LATENCY_BURST_COUNT_THRESHOLD));
}

function resolveProviderFailureThreshold(): number {
  return Math.max(1, getEnvNumber('SELF_HEAL_PROVIDER_FAILURE_THRESHOLD', DEFAULT_PROVIDER_FAILURE_THRESHOLD));
}

function resolveValidationNoiseThreshold(): number {
  return Math.max(1, getEnvNumber('SELF_HEAL_VALIDATION_NOISE_THRESHOLD', DEFAULT_VALIDATION_NOISE_THRESHOLD));
}

function resolveIneffectiveCooldownMs(): number {
  return Math.max(60_000, getEnvNumber('SELF_HEAL_INEFFECTIVE_COOLDOWN_MS', DEFAULT_INEFFECTIVE_COOLDOWN_MS));
}

function resolvePromptRouteVerificationMinRequests(): number {
  return Math.max(
    1,
    getEnvNumber(
      'SELF_HEAL_PROMPT_ROUTE_VERIFICATION_MIN_REQUESTS',
      DEFAULT_PROMPT_ROUTE_VERIFICATION_MIN_REQUESTS
    )
  );
}

function createInitialStatus(): SelfHealingLoopStatus {
  return {
    active: false,
    loopRunning: false,
    startedAt: null,
    lastTick: null,
    tickCount: 0,
    lastError: null,
    intervalMs: resolveLoopIntervalMs(),
    lastDiagnosis: null,
    lastAction: null,
    lastActionAt: null,
    lastControllerDecision: null,
    lastControllerRunAt: null,
    lastWorkerHealth: null,
    lastTrinityMitigation: null,
    lastEvidence: null,
    lastVerificationResult: null,
    activeMitigation: null,
    degradedModeReason: null,
    lastLatencySnapshot: null,
    recentTimeoutCounts: null,
    bypassedSubsystems: [],
    ineffectiveActions: {},
    attemptsByDiagnosis: {},
    cooldowns: {},
    lastHealthyObservedAt: null
  };
}

function createRuntime(): SelfHealingLoopRuntime {
  return {
    timer: null,
    inFlight: false,
    status: createInitialStatus(),
    actionCooldowns: new Map<string, number>(),
    controllerCooldowns: new Map<string, number>(),
    ineffectiveActionCooldowns: new Map<string, number>(),
    diagnosisAttempts: new Map<string, DiagnosisAttemptState>(),
    pendingVerification: null
  };
}

function getRuntime(): SelfHealingLoopRuntime {
  const globalRuntime = globalThis as SelfHealingLoopGlobal;
  if (!globalRuntime[SELF_HEAL_RUNTIME_KEY]) {
    globalRuntime[SELF_HEAL_RUNTIME_KEY] = createRuntime();
  }

  return globalRuntime[SELF_HEAL_RUNTIME_KEY];
}

function recordLoopError(error: unknown): string {
  const runtime = getRuntime();
  const message = resolveErrorMessage(error);
  runtime.status.lastError = message;
  console.error(`[SELF-HEAL] loop error ${message}`);
  return message;
}

async function observeSelfHealingRuntime(): Promise<SelfHealingObservation> {
  const { getWorkerRuntimeStatus } = await import('@platform/runtime/workerConfig.js');
  const workerRuntime = getWorkerRuntimeStatus();
  let workerHealth: WorkerControlHealthResponse | null = null;
  let workerHealthError: string | null = null;

  try {
    workerHealth = await getWorkerControlHealth();
  } catch (error) {
    workerHealthError = resolveErrorMessage(error);
  }

  return {
    workerHealth,
    workerHealthError,
    workerRuntime,
    trinityStatus: getTrinitySelfHealingStatus(),
    requestWindow: runtimeDiagnosticsService.getRollingRequestWindow(resolveSignalWindowMs()),
    telemetry: getTelemetrySnapshot(),
    openaiHealth: getOpenAIServiceHealth()
  };
}

function getActiveTrinityMitigation(
  trinityStatus: ReturnType<typeof getTrinitySelfHealingStatus>
): string | null {
  const activeActions: string[] = [];
  const snapshot = trinityStatus.snapshot;

  if (snapshot.intake.activeAction) {
    activeActions.push(`intake:${snapshot.intake.activeAction}`);
  }
  if (snapshot.reasoning.activeAction) {
    activeActions.push(`reasoning:${snapshot.reasoning.activeAction}`);
  }
  if (snapshot.final.activeAction) {
    activeActions.push(`final:${snapshot.final.activeAction}`);
  }

  return activeActions.length > 0 ? activeActions.join(', ') : null;
}

function getActivePromptRouteMitigation(): string | null {
  const promptRouteMitigation = getPromptRouteMitigationState();
  if (!promptRouteMitigation.active || !promptRouteMitigation.mode) {
    return null;
  }

  return `prompt:${promptRouteMitigation.route}:${promptRouteMitigation.mode}`;
}

function getActiveAutomatedMitigation(
  trinityStatus: ReturnType<typeof getTrinitySelfHealingStatus>
): string | null {
  const activeMitigations = [getActiveTrinityMitigation(trinityStatus), getActivePromptRouteMitigation()].filter(
    (value): value is string => Boolean(value)
  );
  return activeMitigations.length > 0 ? activeMitigations.join(', ') : null;
}

function getActiveBypassedSubsystems(): string[] {
  const promptRouteMitigation = getPromptRouteMitigationState();
  return promptRouteMitigation.active ? [...promptRouteMitigation.bypassedSubsystems] : [];
}

function combineBypassedSubsystems(requestWindow: RequestWindowSnapshot): string[] {
  return [
    ...new Set([
      ...getActiveBypassedSubsystems(),
      ...(Array.isArray(requestWindow.bypassedSubsystems) ? requestWindow.bypassedSubsystems : [])
    ])
  ].sort();
}

function deriveTelemetrySignals(
  telemetry: ReturnType<typeof getTelemetrySnapshot>,
  windowMs: number
): TelemetrySignals {
  const cutoffMs = Date.now() - windowMs;
  const recentEvents = telemetry.traces.recentEvents.filter((event) => Date.parse(event.timestamp) >= cutoffMs);

  return {
    openaiFailureCount: recentEvents.filter((event) => event.name === 'openai.call.failure').length,
    resilienceFailureCount: recentEvents.filter((event) => event.name === 'openai.resilience.failure').length,
    fallbackDegradedCount: recentEvents.filter((event) => event.name === 'fallback.degraded').length,
    fallbackPreemptiveCount: recentEvents.filter((event) => event.name === 'fallback.preemptive').length,
    validationNoiseCount: recentEvents.filter((event) => event.name.includes('validation')).length
  };
}

function captureVerificationSnapshot(observation: SelfHealingObservation): SelfHealingVerificationSnapshot {
  const promptRoute = buildPromptRouteVerificationSnapshot(observation.requestWindow);
  return {
    errorRate: observation.requestWindow.errorRate,
    timeoutRate: observation.requestWindow.timeoutRate,
    timeoutCount: observation.requestWindow.timeoutCount,
    p95LatencyMs: observation.requestWindow.p95LatencyMs,
    avgLatencyMs: observation.requestWindow.avgLatencyMs,
    maxLatencyMs: observation.requestWindow.maxLatencyMs,
    stalledRunning: observation.workerHealth?.queueSummary?.stalledRunning ?? 0,
    oldestPendingJobAgeMs: observation.workerHealth?.queueSummary?.oldestPendingJobAgeMs ?? 0,
    workerHealth: observation.workerHealth?.overallStatus ?? null,
    activeMitigation: getActiveAutomatedMitigation(observation.trinityStatus),
    promptRoute
  };
}

function buildPromptRouteVerificationSnapshot(
  requestWindow: RequestWindowSnapshot
): SelfHealingVerificationSnapshot['promptRoute'] {
  const promptRoute = requestWindow.routes.find((route) => route.route === PROMPT_ROUTE_PATH) ?? null;
  if (!promptRoute) {
    return null;
  }

  return {
    route: promptRoute.route,
    requestCount: promptRoute.requestCount,
    errorCount: promptRoute.errorCount,
    errorRate: Number((promptRoute.errorCount / Math.max(1, promptRoute.requestCount)).toFixed(3)),
    timeoutCount: promptRoute.timeoutCount,
    timeoutRate: Number((promptRoute.timeoutCount / Math.max(1, promptRoute.requestCount)).toFixed(3)),
    slowRequestCount: promptRoute.slowRequestCount ?? 0,
    avgLatencyMs: promptRoute.avgLatencyMs,
    p95LatencyMs: promptRoute.p95LatencyMs,
    maxLatencyMs: promptRoute.maxLatencyMs ?? promptRoute.p95LatencyMs
  };
}

function buildVerificationSnapshotForPendingAction(
  pending: PendingVerification,
  observation: SelfHealingObservation
): SelfHealingVerificationSnapshot {
  const snapshot = captureVerificationSnapshot(observation);
  if (!isPromptRouteMitigationAction(pending.action)) {
    return snapshot;
  }

  const promptRouteWindow = runtimeDiagnosticsService.getRequestWindowSince(
    pending.startedAt,
    resolveSignalWindowMs(),
    PROMPT_ROUTE_PATH
  );

  return {
    ...snapshot,
    promptRoute: buildPromptRouteVerificationSnapshot(promptRouteWindow)
  };
}

function shouldDeferPromptRouteVerification(
  pending: PendingVerification,
  current: SelfHealingVerificationSnapshot
): boolean {
  if (!isPromptRouteMitigationAction(pending.action)) {
    return false;
  }

  const requiredSamples = resolvePromptRouteVerificationMinRequests();
  const observedSamples = current.promptRoute?.requestCount ?? 0;
  return observedSamples < requiredSamples;
}

function isPromptRouteMitigationAction(action: string): boolean {
  return action.startsWith('activatePromptRouteMitigation:');
}

function buildLatencySnapshot(
  requestWindow: RequestWindowSnapshot
): SelfHealingLoopStatus['lastLatencySnapshot'] {
  return {
    requestCount: requestWindow.requestCount,
    avgLatencyMs: requestWindow.avgLatencyMs,
    p95LatencyMs: requestWindow.p95LatencyMs,
    maxLatencyMs: requestWindow.maxLatencyMs,
    degradedCount: requestWindow.degradedCount ?? 0,
    pipelineTimeoutCount: requestWindow.pipelineTimeoutCount ?? 0,
    promptRoute: buildPromptRouteVerificationSnapshot(requestWindow)
  };
}

function buildRecentTimeoutCounts(
  requestWindow: RequestWindowSnapshot
): SelfHealingLoopStatus['recentTimeoutCounts'] {
  const promptRoute = requestWindow.routes.find((route) => route.route === PROMPT_ROUTE_PATH) ?? null;
  const coreRouteTimeouts = requestWindow.routes
    .filter((route) => route.route === '/gpt/:gptId' || route.route === '/api/arcanos/ask')
    .reduce((total, route) => total + route.timeoutCount, 0);
  return {
    windowMs: requestWindow.windowMs,
    total: requestWindow.timeoutCount,
    promptRoute: promptRoute?.timeoutCount ?? 0,
    pipelineTimeouts: requestWindow.pipelineTimeoutCount ?? 0,
    providerTimeouts: requestWindow.providerTimeoutCount ?? 0,
    workerTimeouts: requestWindow.workerTimeoutCount ?? 0,
    budgetAborts: requestWindow.budgetAbortCount ?? 0,
    coreRoute: coreRouteTimeouts
  };
}

function buildRequestEvidence(window: RequestWindowSnapshot): Record<string, unknown> {
  return {
    requestCount: window.requestCount,
    errorRate: window.errorRate,
    serverErrorCount: window.serverErrorCount,
    clientErrorCount: window.clientErrorCount,
    timeoutCount: window.timeoutCount,
    timeoutRate: window.timeoutRate,
    pipelineTimeoutCount: window.pipelineTimeoutCount ?? 0,
    providerTimeoutCount: window.providerTimeoutCount ?? 0,
    workerTimeoutCount: window.workerTimeoutCount ?? 0,
    budgetAbortCount: window.budgetAbortCount ?? 0,
    degradedCount: window.degradedCount ?? 0,
    degradedReasons: window.degradedReasons ?? [],
    bypassedSubsystems: window.bypassedSubsystems ?? [],
    avgLatencyMs: window.avgLatencyMs,
    p95LatencyMs: window.p95LatencyMs,
    maxLatencyMs: window.maxLatencyMs,
    noisyRoutes: window.routes.map((route) => ({
      route: route.route,
      requestCount: route.requestCount,
      errorCount: route.errorCount,
      timeoutCount: route.timeoutCount,
      pipelineTimeoutCount: route.pipelineTimeoutCount,
      providerTimeoutCount: route.providerTimeoutCount,
      workerTimeoutCount: route.workerTimeoutCount,
      budgetAbortCount: route.budgetAbortCount,
      degradedCount: route.degradedCount,
      slowRequestCount: route.slowRequestCount ?? 0,
      avgLatencyMs: route.avgLatencyMs,
      p95LatencyMs: route.p95LatencyMs,
      maxLatencyMs: route.maxLatencyMs ?? route.p95LatencyMs
    }))
  };
}

function getPromptRouteCandidate(window: RequestWindowSnapshot): RequestWindowSnapshot['routes'][number] | null {
  const promptRoute = window.routes.find((route) => route.route === PROMPT_ROUTE_PATH);
  if (!promptRoute) {
    return null;
  }

  const dominatesWindow = promptRoute.requestCount >= Math.max(4, Math.floor(window.requestCount * 0.35));
  const materiallyDegraded =
    promptRoute.timeoutCount > 0 ||
    (promptRoute.maxLatencyMs ?? promptRoute.p95LatencyMs) >= resolveMaxLatencyThresholdMs() ||
    promptRoute.errorCount >= 2 ||
    promptRoute.p95LatencyMs >= resolveLatencyP95ThresholdMs() ||
    promptRoute.avgLatencyMs >= resolveAverageLatencyThresholdMs();

  if (!dominatesWindow || !materiallyDegraded) {
    return null;
  }

  return promptRoute;
}

function buildLatencyMitigationActionPlan(
  window: RequestWindowSnapshot,
  activeMitigation: string | null
): SelfHealingActionPlan | null {
  const promptRouteCandidate = getPromptRouteCandidate(window);
  const promptRouteMitigation = getPromptRouteMitigationState();
  if (promptRouteCandidate) {
    if (promptRouteMitigation.active && promptRouteMitigation.mode === 'degraded_response') {
      return null;
    }

    if (promptRouteMitigation.active && promptRouteMitigation.mode === 'reduced_latency') {
      return {
        kind: 'activate_prompt_route_degraded_mode',
        actionKey: 'activate_prompt_route_degraded_mode',
        cooldownKey: 'activate_prompt_route_degraded_mode',
        cooldownMs: resolveActionCooldownMs() * 2
      };
    }

    if (activeMitigation && !String(activeMitigation).includes('prompt:/api/openai/prompt')) {
      return null;
    }

    return {
      kind: 'activate_prompt_route_reduced_latency_mode',
      actionKey: 'activate_prompt_route_reduced_latency_mode',
      cooldownKey: 'activate_prompt_route_reduced_latency_mode',
      cooldownMs: resolveActionCooldownMs() * 2
    };
  }

  if (activeMitigation) {
    return null;
  }

  return {
    kind: 'activate_trinity_degraded_mode',
    actionKey: 'activate_trinity_degraded_mode',
    cooldownKey: 'activate_trinity_degraded_mode',
    cooldownMs: resolveActionCooldownMs() * 2,
    stage: 'reasoning',
    trinityAction: 'enable_degraded_mode'
  };
}

function withPromptRouteEvidence(
  evidence: Record<string, unknown>,
  requestWindow: RequestWindowSnapshot
): Record<string, unknown> {
  const promptRouteCandidate = getPromptRouteCandidate(requestWindow);
  if (!promptRouteCandidate) {
    return evidence;
  }

  return {
    ...evidence,
    targetedRoute: {
      route: promptRouteCandidate.route,
      requestCount: promptRouteCandidate.requestCount,
      requestShare: Number((promptRouteCandidate.requestCount / Math.max(1, requestWindow.requestCount)).toFixed(3)),
      errorCount: promptRouteCandidate.errorCount,
      timeoutCount: promptRouteCandidate.timeoutCount,
      slowRequestCount: promptRouteCandidate.slowRequestCount ?? 0,
      avgLatencyMs: promptRouteCandidate.avgLatencyMs,
      p95LatencyMs: promptRouteCandidate.p95LatencyMs,
      maxLatencyMs: promptRouteCandidate.maxLatencyMs ?? promptRouteCandidate.p95LatencyMs
    }
  };
}

function assessPromptRouteMitigationStability(
  requestWindow: RequestWindowSnapshot
): PromptRouteStabilityAssessment | null {
  const promptRouteMitigation = getPromptRouteMitigationState();
  if (!promptRouteMitigation.active || !promptRouteMitigation.mode) {
    return null;
  }

  const mitigationStartedAt = promptRouteMitigation.updatedAt ?? promptRouteMitigation.activatedAt;
  if (!mitigationStartedAt) {
    return null;
  }

  const postMitigationWindow = runtimeDiagnosticsService.getRequestWindowSince(
    mitigationStartedAt,
    resolveSignalWindowMs(),
    PROMPT_ROUTE_PATH
  );
  const postMitigationPromptRoute = buildPromptRouteVerificationSnapshot(postMitigationWindow);
  const requiredSamples = resolvePromptRouteVerificationMinRequests();
  if (!postMitigationPromptRoute || postMitigationPromptRoute.requestCount < requiredSamples) {
    return null;
  }

  const stabilizedLatencyCeilingMs = Math.max(
    750,
    promptRouteMitigation.pipelineTimeoutMs ?? Math.min(resolveLatencyP95ThresholdMs(), 2_500)
  );
  const stabilizedErrorRateThreshold = Math.max(0.05, Number((resolveErrorRateThreshold() * 0.5).toFixed(3)));
  const stabilizedTimeoutRateThreshold = Math.max(0, Number((resolveTimeoutRateThreshold() * 0.5).toFixed(3)));
  const timeoutSampleAllowance = Math.max(
    1,
    Math.floor(postMitigationPromptRoute.requestCount * stabilizedTimeoutRateThreshold)
  );
  const routeLooksHealthy =
    postMitigationPromptRoute.timeoutRate <= stabilizedTimeoutRateThreshold &&
    postMitigationPromptRoute.timeoutCount <= timeoutSampleAllowance &&
    postMitigationPromptRoute.errorRate <= stabilizedErrorRateThreshold &&
    postMitigationPromptRoute.p95LatencyMs <= stabilizedLatencyCeilingMs &&
    postMitigationPromptRoute.maxLatencyMs <= stabilizedLatencyCeilingMs;

  if (!routeLooksHealthy) {
    return null;
  }

  const modeLabel = promptRouteMitigation.mode.replace(/_/g, '-');
  return {
    summary: `prompt route stabilized under ${modeLabel} mitigation`,
    confidence: 0.86,
    evidence: {
      ...buildRequestEvidence(requestWindow),
      mitigationWindow: {
        activeMitigation: `prompt:${promptRouteMitigation.route}:${promptRouteMitigation.mode}`,
        since: mitigationStartedAt,
        requiredSamples,
        observedSamples: postMitigationPromptRoute.requestCount,
        latencyCeilingMs: stabilizedLatencyCeilingMs,
        errorRateThreshold: stabilizedErrorRateThreshold,
        timeoutRateThreshold: stabilizedTimeoutRateThreshold,
        timeoutSampleAllowance,
        bypassedSubsystems: [...promptRouteMitigation.bypassedSubsystems]
      },
      targetedRoute: postMitigationPromptRoute
    }
  };
}

function detectBurstingLatency(requestWindow: RequestWindowSnapshot, minRequestCount: number): boolean {
  const burstRequestThreshold = Math.max(2, resolveLatencyBurstCountThreshold());
  const burstWindowMinRequests = Math.max(6, Math.floor(minRequestCount / 2));
  const severeMaxLatencyDetected = requestWindow.maxLatencyMs >= resolveMaxLatencyThresholdMs();
  const timeoutBurstDetected = requestWindow.timeoutCount >= burstRequestThreshold;
  const slowBurstDetected = requestWindow.slowRequestCount >= Math.max(4, burstRequestThreshold * 2);

  return (
    requestWindow.requestCount >= burstWindowMinRequests &&
    severeMaxLatencyDetected &&
    (timeoutBurstDetected || slowBurstDetected)
  );
}

function buildDiagnosisSummary(
  type: DiagnosisType,
  observation: SelfHealingObservation,
  telemetrySignals: TelemetrySignals,
  activeMitigation: string | null,
  promptRouteStability: PromptRouteStabilityAssessment | null = null
): {
  summary: string;
  confidence: number;
  evidence: Record<string, unknown> | null;
  actionPlan: SelfHealingActionPlan | null;
  shouldRunController: boolean;
} {
  const requestEvidence = buildRequestEvidence(observation.requestWindow);
  const workerAutonomySettings = getWorkerAutonomySettings();
  const queueSummary = observation.workerHealth?.queueSummary;

  if (type === 'worker_stall') {
    const hasStalledJobs = (queueSummary?.stalledRunning ?? 0) > 0;
    return {
      summary: hasStalledJobs ? 'worker stall detected' : 'worker runtime inactive',
      confidence: hasStalledJobs ? 0.98 : 0.96,
      evidence: {
        workerHealth: observation.workerHealth?.overallStatus ?? null,
        queueSummary,
        workerRuntime: {
          enabled: observation.workerRuntime.enabled,
          started: observation.workerRuntime.started,
          activeListeners: observation.workerRuntime.activeListeners,
          workerIds: observation.workerRuntime.workerIds
        }
      },
      actionPlan: hasStalledJobs
        ? {
            kind: 'recover_stale_jobs',
            actionKey: 'recover_stale_jobs',
            cooldownKey: 'recover_stale_jobs',
            cooldownMs: resolveActionCooldownMs()
          }
        : {
            kind: 'heal_worker_runtime',
            actionKey: 'heal_worker_runtime',
            cooldownKey: 'heal_worker_runtime',
            cooldownMs: resolveActionCooldownMs()
          },
      shouldRunController: false
    };
  }

  if (type === 'prompt_route_stabilized' && promptRouteStability) {
    return {
      summary: promptRouteStability.summary,
      confidence: promptRouteStability.confidence,
      evidence: promptRouteStability.evidence,
      actionPlan: null,
      shouldRunController: false
    };
  }

  if (type === 'provider_failure_cluster') {
    const evidence = withPromptRouteEvidence(
      {
        circuitBreakerState: observation.openaiHealth.circuitBreaker.state,
        circuitBreakerFailures: observation.openaiHealth.circuitBreaker.failureCount,
        openaiFailureCount: telemetrySignals.openaiFailureCount,
        resilienceFailureCount: telemetrySignals.resilienceFailureCount,
        fallbackDegradedCount: telemetrySignals.fallbackDegradedCount,
        ...requestEvidence
      },
      observation.requestWindow
    );
    return {
      summary: 'provider failure cluster detected',
      confidence: 0.9,
      evidence,
      actionPlan: buildLatencyMitigationActionPlan(observation.requestWindow, activeMitigation),
      shouldRunController: activeMitigation !== null
    };
  }

  if (type === 'pipeline_timeout_cluster') {
    return {
      summary: 'pipeline timeout cluster detected',
      confidence: 0.93,
      evidence: withPromptRouteEvidence(
        {
          ...requestEvidence,
          degradedModeReason: observation.requestWindow.degradedReasons?.[0] ?? null
        },
        observation.requestWindow
      ),
      actionPlan: buildLatencyMitigationActionPlan(observation.requestWindow, activeMitigation),
      shouldRunController: activeMitigation !== null
    };
  }

  if (type === 'timeout_storm') {
    const evidence = withPromptRouteEvidence(
      {
        timeoutCount: observation.requestWindow.timeoutCount,
        timeoutRate: observation.requestWindow.timeoutRate,
        p95LatencyMs: observation.requestWindow.p95LatencyMs,
        serverErrorCount: observation.requestWindow.serverErrorCount,
        ...requestEvidence
      },
      observation.requestWindow
    );
    return {
      summary: 'timeout storm detected',
      confidence: 0.9,
      evidence,
      actionPlan: buildLatencyMitigationActionPlan(observation.requestWindow, activeMitigation),
      shouldRunController: activeMitigation !== null
    };
  }

  if (type === 'latency_spike') {
    return {
      summary: 'latency spike cluster detected',
      confidence: observation.requestWindow.maxLatencyMs >= resolveMaxLatencyThresholdMs() ? 0.88 : 0.84,
      evidence: withPromptRouteEvidence(
        {
          ...requestEvidence,
          spikeDetector: {
            p95ThresholdMs: resolveLatencyP95ThresholdMs(),
            avgThresholdMs: resolveAverageLatencyThresholdMs(),
            maxThresholdMs: resolveMaxLatencyThresholdMs(),
            burstTimeoutThreshold: resolveLatencyBurstCountThreshold()
          }
        },
        observation.requestWindow
      ),
      actionPlan: buildLatencyMitigationActionPlan(observation.requestWindow, activeMitigation),
      shouldRunController: activeMitigation !== null
    };
  }

  if (type === 'error_rate_elevated') {
    return {
      summary: 'rolling error rate elevated',
      confidence: 0.82,
      evidence: withPromptRouteEvidence(requestEvidence, observation.requestWindow),
      actionPlan: buildLatencyMitigationActionPlan(observation.requestWindow, activeMitigation),
      shouldRunController: activeMitigation !== null
    };
  }

  if (type === 'validation_noise') {
    return {
      summary: 'validation noise elevated',
      confidence: 0.52,
      evidence: {
        validationNoiseCount: telemetrySignals.validationNoiseCount,
        clientErrorCount: observation.requestWindow.clientErrorCount,
        ...requestEvidence
      },
      actionPlan: null,
      shouldRunController: false
    };
  }

  if (type === 'worker_degraded') {
    return {
      summary: observation.workerHealthError
        ? `worker health observation failed: ${observation.workerHealthError}`
        : 'worker health degraded',
      confidence: observation.workerHealthError ? 0.74 : 0.7,
      evidence: {
        workerHealth: observation.workerHealth?.overallStatus ?? null,
        alerts: observation.workerHealth?.alerts ?? [],
        queueSummary,
        staleAfterMs: workerAutonomySettings.staleAfterMs
      },
      actionPlan: null,
      shouldRunController: true
    };
  }

  if (type === 'trinity_mitigation_active') {
    return {
      summary: `trinity mitigation active: ${activeMitigation}`,
      confidence: 0.8,
      evidence: {
        activeMitigation,
        snapshot: observation.trinityStatus.snapshot
      },
      actionPlan: null,
      shouldRunController: true
    };
  }

  if (type === 'manual') {
    return {
      summary: 'manual self-heal evaluation',
      confidence: 1,
      evidence: requestEvidence,
      actionPlan: null,
      shouldRunController: true
    };
  }

  if (type === 'unknown') {
    return {
      summary: 'unknown runtime degradation observed',
      confidence: 0.45,
      evidence: {
        ...requestEvidence,
        circuitBreakerState: observation.openaiHealth.circuitBreaker.state,
        openaiFailureCount: telemetrySignals.openaiFailureCount,
        fallbackDegradedCount: telemetrySignals.fallbackDegradedCount
      },
      actionPlan: null,
      shouldRunController: true
    };
  }

  return {
    summary: 'healthy',
    confidence: 1,
    evidence: requestEvidence,
    actionPlan: null,
    shouldRunController: false
  };
}

function buildControllerInput(
  options: {
    trigger?: 'startup' | 'interval' | 'manual';
    requestedCycle?: SelfImproveTrigger;
  },
  observation: SelfHealingObservation,
  diagnosis: Omit<SelfHealingDiagnosis, 'controllerInput'>
): SelfImproveTrigger | null {
  const context = {
    selfHealLoop: {
      diagnosis: diagnosis.summary,
      diagnosisType: diagnosis.type,
      confidence: diagnosis.confidence,
      evidence: diagnosis.evidence,
      workerHealth: diagnosis.workerHealthLabel,
      workerHealthAlerts: observation.workerHealth?.alerts ?? [],
      workerHealthError: observation.workerHealthError,
      workerRuntime: {
        started: observation.workerRuntime.started,
        activeListeners: observation.workerRuntime.activeListeners,
        workerIds: observation.workerRuntime.workerIds
      },
      trinityMitigation: diagnosis.trinityMitigation
    }
  };

  if (options.trigger === 'manual' && options.requestedCycle) {
    return {
      ...options.requestedCycle,
      context: {
        ...(options.requestedCycle.context ?? {}),
        ...context
      }
    };
  }

  if (!diagnosis.incidentKey) {
    return null;
  }

  return {
    trigger: 'incident',
    component:
      diagnosis.type === 'worker_stall' || diagnosis.type === 'worker_degraded'
        ? 'worker-runtime'
        : diagnosis.trinityMitigation
          ? 'trinity-self-heal'
          : 'runtime-health',
    context
  };
}

function diagnoseSelfHealingRuntime(
  options: {
    trigger?: 'startup' | 'interval' | 'manual';
    requestedCycle?: SelfImproveTrigger;
  },
  observation: SelfHealingObservation
): SelfHealingDiagnosis {
  const activeTrinityMitigation = getActiveTrinityMitigation(observation.trinityStatus);
  const activeMitigation = getActiveAutomatedMitigation(observation.trinityStatus);
  const workerHealthLabel = observation.workerHealth?.overallStatus ?? null;
  const workerAutonomySettings = getWorkerAutonomySettings();
  const queueSummary = observation.workerHealth?.queueSummary;
  const telemetrySignals = deriveTelemetrySignals(observation.telemetry, observation.requestWindow.windowMs);
  const requestWindow = observation.requestWindow;
  const promptRouteStability = assessPromptRouteMitigationStability(requestWindow);
  const runtimeInactive =
    observation.workerRuntime.enabled &&
    (!observation.workerRuntime.started || observation.workerRuntime.activeListeners === 0);
  const minRequestCount = resolveMinRequestCount();
  const latencyBurstDetected = detectBurstingLatency(requestWindow, minRequestCount);
  const providerFailureCount = telemetrySignals.openaiFailureCount + telemetrySignals.resilienceFailureCount;
  const providerClusterDetected =
    String(observation.openaiHealth.circuitBreaker.state).toUpperCase() !== 'CLOSED' ||
    providerFailureCount >= resolveProviderFailureThreshold() ||
    telemetrySignals.fallbackDegradedCount >= 2;
  const pipelineTimeoutClusterDetected =
    requestWindow.requestCount >= Math.max(4, Math.floor(minRequestCount / 3)) &&
    (requestWindow.pipelineTimeoutCount ?? 0) >= Math.max(2, Math.floor(resolveTimeoutCountThreshold() / 2));
  // Timeout storms should capture repeated timeout-class failures plus either long-tail latency or
  // server-side breakage, so a burst of 5-13s requests does not slip through on average latency alone.
  const timeoutStormDetected =
    requestWindow.requestCount >= Math.max(6, Math.floor(minRequestCount / 2)) &&
    (requestWindow.timeoutCount >= resolveTimeoutCountThreshold() ||
      requestWindow.timeoutRate >= resolveTimeoutRateThreshold()) &&
    (
      requestWindow.p95LatencyMs >= resolveLatencyP95ThresholdMs() ||
      requestWindow.maxLatencyMs >= resolveMaxLatencyThresholdMs() ||
      requestWindow.serverErrorCount >= 2
    );
  // Latency spikes should catch both sustained degradation and bursty outliers that keep the rolling
  // average deceptively low while operators still experience multi-second stalls.
  const latencySpikeDetected =
    (
      requestWindow.requestCount >= minRequestCount &&
      requestWindow.p95LatencyMs >= resolveLatencyP95ThresholdMs() &&
      requestWindow.avgLatencyMs >= resolveAverageLatencyThresholdMs() &&
      requestWindow.slowRequestCount >= Math.max(4, Math.floor(minRequestCount / 3))
    ) ||
    latencyBurstDetected;
  // Elevated error rate requires enough traffic and server-side failures to avoid acting on tiny samples
  // or mostly client-driven noise.
  const elevatedErrorRateDetected =
    requestWindow.requestCount >= minRequestCount &&
    requestWindow.errorRate >= resolveErrorRateThreshold() &&
    requestWindow.serverErrorCount >= 2;
  // Validation noise is intentionally separated from server incidents so the loop can surface it without
  // burning mitigation budget on caller mistakes.
  const validationNoiseDetected =
    requestWindow.requestCount >= minRequestCount &&
    requestWindow.clientErrorCount >= resolveValidationNoiseThreshold() &&
    requestWindow.clientErrorCount / Math.max(1, requestWindow.requestCount) >= 0.4 &&
    requestWindow.serverErrorCount <= 1;
  // Pending work only counts as a worker stall when the queue is ageing past autonomy limits and users are
  // already seeing failures, which avoids healing healthy backlog.
  const workerStallDetected =
    runtimeInactive ||
    (queueSummary?.stalledRunning ?? 0) > 0 ||
    ((queueSummary?.pending ?? 0) > 0 &&
      (queueSummary?.oldestPendingJobAgeMs ?? 0) >= workerAutonomySettings.staleAfterMs &&
      requestWindow.errorRate >= 0.1);

  let diagnosisType: DiagnosisType = 'healthy';
  if (workerStallDetected) {
    diagnosisType = 'worker_stall';
  } else if (promptRouteStability) {
    diagnosisType = 'prompt_route_stabilized';
  } else if (providerClusterDetected) {
    diagnosisType = 'provider_failure_cluster';
  } else if (pipelineTimeoutClusterDetected) {
    diagnosisType = 'pipeline_timeout_cluster';
  } else if (timeoutStormDetected) {
    diagnosisType = 'timeout_storm';
  } else if (latencySpikeDetected) {
    diagnosisType = 'latency_spike';
  } else if (elevatedErrorRateDetected) {
    diagnosisType = 'error_rate_elevated';
  } else if (validationNoiseDetected) {
    diagnosisType = 'validation_noise';
  } else if (activeTrinityMitigation) {
    diagnosisType = 'trinity_mitigation_active';
  } else if (observation.workerHealth?.overallStatus === 'degraded' || observation.workerHealthError) {
    diagnosisType = 'worker_degraded';
  } else if (
    requestWindow.requestCount >= minRequestCount &&
    (requestWindow.errorRate >= resolveErrorRateThreshold() * 0.6 ||
      requestWindow.p95LatencyMs >= resolveLatencyP95ThresholdMs() * 0.8)
  ) {
    diagnosisType = 'unknown';
  } else if (options.trigger === 'manual' && options.requestedCycle) {
    diagnosisType = 'manual';
  }

  const summary = buildDiagnosisSummary(
    diagnosisType,
    observation,
    telemetrySignals,
    activeMitigation,
    promptRouteStability
  );
  const baseDiagnosis = {
    type: diagnosisType,
    incidentKey: diagnosisType === 'healthy' || diagnosisType === 'prompt_route_stabilized' ? null : diagnosisType,
    summary: summary.summary,
    confidence: summary.confidence,
    evidence: summary.evidence,
    shouldRunController: summary.shouldRunController,
    trinityMitigation: activeTrinityMitigation,
    workerHealthLabel,
    actionPlan: summary.actionPlan
  };

  return {
    ...baseDiagnosis,
    controllerInput: buildControllerInput(options, observation, baseDiagnosis)
  };
}

function isCooldownActive(cooldowns: Map<string, number>, key: string): boolean {
  const expiresAtMs = cooldowns.get(key);
  return expiresAtMs !== undefined && expiresAtMs > Date.now();
}

function recordCooldown(cooldowns: Map<string, number>, key: string, cooldownMs: number): void {
  cooldowns.set(key, Date.now() + cooldownMs);
}

function shouldAutoInvokeController(): boolean {
  const cfg = getConfig();
  return cfg.selfImproveEnabled && cfg.selfImproveActuatorMode === 'daemon' && !cfg.selfImproveFrozen;
}

function canAttemptDiagnosis(runtime: SelfHealingLoopRuntime, diagnosisType: DiagnosisType): boolean {
  const attemptState = runtime.diagnosisAttempts.get(diagnosisType);
  if (!attemptState) {
    return true;
  }

  if (Date.now() - attemptState.windowStartedAtMs >= resolveIncidentWindowMs()) {
    runtime.diagnosisAttempts.delete(diagnosisType);
    return true;
  }

  return attemptState.count < resolveMaxAttemptsPerDiagnosis();
}

function recordDiagnosisAttempt(runtime: SelfHealingLoopRuntime, diagnosisType: DiagnosisType): void {
  const nowMs = Date.now();
  const existing = runtime.diagnosisAttempts.get(diagnosisType);
  if (!existing || nowMs - existing.windowStartedAtMs >= resolveIncidentWindowMs()) {
    runtime.diagnosisAttempts.set(diagnosisType, {
      count: 1,
      windowStartedAtMs: nowMs,
      lastAttemptAtMs: nowMs
    });
    return;
  }

  runtime.diagnosisAttempts.set(diagnosisType, {
    ...existing,
    count: existing.count + 1,
    lastAttemptAtMs: nowMs
  });
}

function serializeDiagnosisAttempts(runtime: SelfHealingLoopRuntime): Record<string, number> {
  const attempts: Record<string, number> = {};
  const nowMs = Date.now();

  for (const [key, value] of runtime.diagnosisAttempts.entries()) {
    if (nowMs - value.windowStartedAtMs >= resolveIncidentWindowMs()) {
      runtime.diagnosisAttempts.delete(key);
      continue;
    }
    attempts[key] = value.count;
  }

  return attempts;
}

function serializeCooldowns(runtime: SelfHealingLoopRuntime): Record<string, string> {
  const result: Record<string, string> = {};
  const nowMs = Date.now();

  const registerEntries = (prefix: string, cooldowns: Map<string, number>) => {
    for (const [key, expiresAtMs] of cooldowns.entries()) {
      if (expiresAtMs <= nowMs) {
        cooldowns.delete(key);
        continue;
      }
      result[`${prefix}:${key}`] = new Date(expiresAtMs).toISOString();
    }
  };

  registerEntries('action', runtime.actionCooldowns);
  registerEntries('controller', runtime.controllerCooldowns);
  registerEntries('ineffective', runtime.ineffectiveActionCooldowns);

  return result;
}

function serializeIneffectiveActions(runtime: SelfHealingLoopRuntime): Record<string, string> {
  const nowMs = Date.now();
  const result: Record<string, string> = {};
  for (const [key, expiresAtMs] of runtime.ineffectiveActionCooldowns.entries()) {
    if (expiresAtMs <= nowMs) {
      runtime.ineffectiveActionCooldowns.delete(key);
      continue;
    }
    result[key] = new Date(expiresAtMs).toISOString();
  }

  return result;
}

function refreshStatusViews(runtime: SelfHealingLoopRuntime): void {
  runtime.status.attemptsByDiagnosis = serializeDiagnosisAttempts(runtime);
  runtime.status.cooldowns = serializeCooldowns(runtime);
  runtime.status.ineffectiveActions = serializeIneffectiveActions(runtime);
  runtime.status.bypassedSubsystems = [
    ...new Set([...runtime.status.bypassedSubsystems, ...getActiveBypassedSubsystems()])
  ].sort();
}

function beginVerification(
  diagnosis: SelfHealingDiagnosis,
  action: string,
  observation: SelfHealingObservation,
  rollback:
    | {
        kind: 'trinity';
        stage: TrinitySelfHealingStage;
        action: TrinitySelfHealingAction;
        reason: string;
      }
    | {
        kind: 'prompt_route';
        reason: string;
      }
    | null = null
): PendingVerification {
  return {
    diagnosisType: diagnosis.type,
    diagnosisSummary: diagnosis.summary,
    action,
    startedAt: new Date().toISOString(),
    verifyAfterMs: resolveVerificationDelayMs(),
    baseline: captureVerificationSnapshot(observation),
    rollback
  };
}

function compareMetricTrend(
  baseline: number,
  current: number,
  options: {
    betterAbsoluteDelta?: number;
    worseAbsoluteDelta?: number;
    betterRatio?: number;
    worseRatio?: number;
  } = {}
): 'better' | 'worse' | 'neutral' {
  if (baseline <= 0) {
    if (current <= 0) {
      return 'neutral';
    }
    return current > 0 ? 'worse' : 'neutral';
  }

  const betterByAbsolute =
    options.betterAbsoluteDelta !== undefined && current <= baseline - options.betterAbsoluteDelta;
  const betterByRatio = options.betterRatio !== undefined && current <= baseline * options.betterRatio;
  if (betterByAbsolute || betterByRatio) {
    return 'better';
  }

  const worseByAbsolute =
    options.worseAbsoluteDelta !== undefined && current >= baseline + options.worseAbsoluteDelta;
  const worseByRatio = options.worseRatio !== undefined && current >= baseline * options.worseRatio;
  if (worseByAbsolute || worseByRatio) {
    return 'worse';
  }

  return 'neutral';
}

function evaluateVerificationOutcome(
  pending: PendingVerification,
  current: SelfHealingVerificationSnapshot
): SelfHealingVerificationResult {
  const reasons: string[] = [];
  let betterCount = 0;
  let worseCount = 0;

  const errorTrend = compareMetricTrend(pending.baseline.errorRate, current.errorRate, ERROR_RATE_TREND_THRESHOLDS);
  if (errorTrend === 'better') {
    betterCount += 1;
    reasons.push('rolling error rate improved');
  } else if (errorTrend === 'worse') {
    worseCount += 1;
    reasons.push('rolling error rate worsened');
  }

  const timeoutTrend = compareMetricTrend(
    pending.baseline.timeoutRate,
    current.timeoutRate,
    TIMEOUT_RATE_TREND_THRESHOLDS
  );
  if (timeoutTrend === 'better' || current.timeoutCount < pending.baseline.timeoutCount) {
    betterCount += 1;
    reasons.push('timeout frequency improved');
  } else if (
    timeoutTrend === 'worse' ||
    current.timeoutCount > pending.baseline.timeoutCount + VERIFICATION_TIMEOUT_COUNT_WORSE_DELTA
  ) {
    worseCount += 1;
    reasons.push('timeout frequency worsened');
  }

  const latencyTrend = compareMetricTrend(
    pending.baseline.p95LatencyMs,
    current.p95LatencyMs,
    P95_LATENCY_TREND_THRESHOLDS
  );
  if (latencyTrend === 'better') {
    betterCount += 1;
    reasons.push('p95 latency improved');
  } else if (latencyTrend === 'worse') {
    worseCount += 1;
    reasons.push('p95 latency worsened');
  }

  const maxLatencyTrend = compareMetricTrend(
    pending.baseline.maxLatencyMs,
    current.maxLatencyMs,
    MAX_LATENCY_TREND_THRESHOLDS
  );
  if (maxLatencyTrend === 'better') {
    betterCount += 1;
    reasons.push('max latency improved');
  } else if (maxLatencyTrend === 'worse') {
    worseCount += 1;
    reasons.push('max latency worsened');
  }

  if (pending.action === 'recoverStaleJobs' || pending.action === 'healWorkerRuntime') {
    if (
      current.stalledRunning < pending.baseline.stalledRunning ||
      current.workerHealth === 'healthy' ||
      (pending.baseline.workerHealth !== 'healthy' && current.workerHealth === 'degraded')
    ) {
      betterCount += 1;
      reasons.push('worker health improved');
    } else if (
      current.stalledRunning > pending.baseline.stalledRunning ||
      current.workerHealth === 'offline' ||
      current.workerHealth === 'unhealthy'
    ) {
      worseCount += 1;
      reasons.push('worker health worsened');
    }
  }

  if (isPromptRouteMitigationAction(pending.action)) {
    const baselinePromptRoute = pending.baseline.promptRoute;
    const currentPromptRoute = current.promptRoute;

    if (baselinePromptRoute && currentPromptRoute) {
      const promptRouteErrorTrend = compareMetricTrend(
        baselinePromptRoute.errorRate,
        currentPromptRoute.errorRate,
        PROMPT_ROUTE_ERROR_TREND_THRESHOLDS
      );
      if (promptRouteErrorTrend === 'better') {
        betterCount += 1;
        reasons.push('prompt route error rate improved');
      } else if (promptRouteErrorTrend === 'worse') {
        worseCount += 1;
        reasons.push('prompt route error rate worsened');
      }

      const promptRouteTimeoutTrend = compareMetricTrend(
        baselinePromptRoute.timeoutRate,
        currentPromptRoute.timeoutRate,
        PROMPT_ROUTE_TIMEOUT_TREND_THRESHOLDS
      );
      if (promptRouteTimeoutTrend === 'better') {
        betterCount += 1;
        reasons.push('prompt route timeout rate improved');
      } else if (promptRouteTimeoutTrend === 'worse') {
        worseCount += 1;
        reasons.push('prompt route timeout rate worsened');
      }

      const promptRouteLatencyTrend = compareMetricTrend(
        baselinePromptRoute.avgLatencyMs,
        currentPromptRoute.avgLatencyMs,
        PROMPT_ROUTE_AVG_LATENCY_TREND_THRESHOLDS
      );
      if (promptRouteLatencyTrend === 'better') {
        betterCount += 1;
        reasons.push('prompt route average latency improved');
      } else if (promptRouteLatencyTrend === 'worse') {
        worseCount += 1;
        reasons.push('prompt route average latency worsened');
      }

      const promptRouteMaxLatencyTrend = compareMetricTrend(
        baselinePromptRoute.maxLatencyMs,
        currentPromptRoute.maxLatencyMs,
        MAX_LATENCY_TREND_THRESHOLDS
      );
      if (promptRouteMaxLatencyTrend === 'better') {
        betterCount += 1;
        reasons.push('prompt route max latency improved');
      } else if (promptRouteMaxLatencyTrend === 'worse') {
        worseCount += 1;
        reasons.push('prompt route max latency worsened');
      }
    }
  }

  let outcome: VerificationOutcome = 'unchanged';
  if (betterCount >= VERIFICATION_SUCCESS_SIGNAL_COUNT && betterCount > worseCount) {
    outcome = 'improved';
  } else if (worseCount >= VERIFICATION_FAILURE_SIGNAL_COUNT && worseCount >= betterCount) {
    outcome = 'worse';
  }

  return {
    verifiedAt: new Date().toISOString(),
    action: pending.action,
    diagnosis: pending.diagnosisSummary,
    outcome,
    summary: reasons.length > 0 ? reasons.join('; ') : 'verification window produced no material change',
    baseline: pending.baseline,
    current
  };
}

function maybeVerifyPendingAction(
  runtime: SelfHealingLoopRuntime,
  observation: SelfHealingObservation
): { verificationResult: SelfHealingVerificationResult | null; followUpAction: string | null } {
  const pending = runtime.pendingVerification;
  if (!pending) {
    return {
      verificationResult: null,
      followUpAction: null
    };
  }

  if (Date.now() - Date.parse(pending.startedAt) < pending.verifyAfterMs) {
    return {
      verificationResult: null,
      followUpAction: null
    };
  }

  const verificationSnapshot = buildVerificationSnapshotForPendingAction(pending, observation);
  if (shouldDeferPromptRouteVerification(pending, verificationSnapshot)) {
    console.log(
      `[SELF-HEAL] verify deferred action=${pending.action} reason=awaiting_prompt_route_samples observed=${verificationSnapshot.promptRoute?.requestCount ?? 0} required=${resolvePromptRouteVerificationMinRequests()}`
    );
    return {
      verificationResult: null,
      followUpAction: null
    };
  }

  const verificationResult = evaluateVerificationOutcome(pending, verificationSnapshot);
  runtime.pendingVerification = null;
  runtime.status.lastVerificationResult = verificationResult;
  console.log(
    `[SELF-HEAL] verify action=${pending.action} outcome=${verificationResult.outcome} summary=${verificationResult.summary}`
  );

  if (verificationResult.outcome === 'improved') {
    if (pending.action === 'activatePromptRouteMitigation:reduced_latency') {
      recordCooldown(
        runtime.actionCooldowns,
        'activate_prompt_route_degraded_mode',
        Math.max(resolveActionCooldownMs(), pending.verifyAfterMs)
      );
    }
    runtime.status.lastHealthyObservedAt = verificationResult.verifiedAt;
    return {
      verificationResult,
      followUpAction: null
    };
  }

  const ineffectiveKey = `${pending.diagnosisType}:${pending.action}`;
  recordCooldown(runtime.ineffectiveActionCooldowns, ineffectiveKey, resolveIneffectiveCooldownMs());

  if (!pending.rollback) {
    return {
      verificationResult,
      followUpAction: null
    };
  }

  let followUpAction: string | null = null;
  if (pending.rollback.kind === 'trinity') {
    const rollbackResult = rollbackTrinitySelfHealingMitigation({
      stage: pending.rollback.stage,
      action: pending.rollback.action,
      reason: pending.rollback.reason
    });

    if (!rollbackResult.rolledBack) {
      return {
        verificationResult,
        followUpAction: null
      };
    }

    followUpAction = `rollbackTrinityMitigation:${pending.rollback.stage}:${pending.rollback.action}`;
  } else {
    const rollbackResult = rollbackPromptRouteMitigation(pending.rollback.reason);
    if (!rollbackResult.rolledBack) {
      return {
        verificationResult,
        followUpAction: null
      };
    }

    followUpAction = 'rollbackPromptRouteMitigation';
  }

  runtime.status.lastAction = followUpAction;
  runtime.status.lastActionAt = new Date().toISOString();
  runtime.status.lastTrinityMitigation = getActiveTrinityMitigation(getTrinitySelfHealingStatus());
  runtime.status.activeMitigation = getActiveAutomatedMitigation(getTrinitySelfHealingStatus());
  console.log(`[SELF-HEAL] action ${followUpAction}`);

  return {
    verificationResult,
    followUpAction
  };
}

async function executeActionPlan(
  runtime: SelfHealingLoopRuntime,
  diagnosis: SelfHealingDiagnosis,
  observation: SelfHealingObservation
): Promise<SelfHealingActionExecution> {
  if (runtime.pendingVerification) {
    console.log('[SELF-HEAL] action skipped reason=pending-verification');
    return {
      executed: false,
      action: null,
      pendingVerification: null
    };
  }

  if (!diagnosis.actionPlan || !diagnosis.incidentKey) {
    return {
      executed: false,
      action: null,
      pendingVerification: null
    };
  }

  const actionPlan = diagnosis.actionPlan;

  const resolveActionTrackingKey = (): string => {
    if (actionPlan.kind === 'recover_stale_jobs') {
      return actionPlan.actionKey;
    }

    if (actionPlan.kind === 'heal_worker_runtime') {
      return actionPlan.actionKey;
    }

    if (actionPlan.kind === 'activate_prompt_route_reduced_latency_mode') {
      return 'activatePromptRouteMitigation:reduced_latency';
    }

    if (actionPlan.kind === 'activate_prompt_route_degraded_mode') {
      return 'activatePromptRouteMitigation:degraded_response';
    }

    return `activateTrinityMitigation:${actionPlan.stage}:${actionPlan.trinityAction}`;
  };

  const ineffectiveKey = `${diagnosis.type}:${resolveActionTrackingKey()}`;
  if (!canAttemptDiagnosis(runtime, diagnosis.type)) {
    console.log(`[SELF-HEAL] action skipped diagnosis=${diagnosis.type} reason=attempt-budget`);
    return {
      executed: false,
      action: null,
      pendingVerification: null
    };
  }

  if (isCooldownActive(runtime.actionCooldowns, actionPlan.cooldownKey)) {
    console.log(`[SELF-HEAL] action skipped diagnosis=${diagnosis.type} reason=cooldown`);
    return {
      executed: false,
      action: null,
      pendingVerification: null
    };
  }

  if (isCooldownActive(runtime.ineffectiveActionCooldowns, ineffectiveKey)) {
    console.log(`[SELF-HEAL] action skipped diagnosis=${diagnosis.type} reason=recently-ineffective`);
    return {
      executed: false,
      action: null,
      pendingVerification: null
    };
  }

  if (diagnosis.confidence < 0.7) {
    console.log(`[SELF-HEAL] action skipped diagnosis=${diagnosis.type} reason=low-confidence`);
    return {
      executed: false,
      action: null,
      pendingVerification: null
    };
  }

  try {
    if (actionPlan.kind === 'recover_stale_jobs') {
      const settings = getWorkerAutonomySettings();
      const recoverResult = await recoverStaleJobs({
        staleAfterMs: settings.staleAfterMs,
        maxRetries: settings.defaultMaxRetries
      });
      const action = `recoverStaleJobs:recovered=${recoverResult.recoveredJobs.length}:failed=${recoverResult.failedJobs.length}`;
      recordCooldown(runtime.actionCooldowns, actionPlan.cooldownKey, actionPlan.cooldownMs);
      recordDiagnosisAttempt(runtime, diagnosis.type);
      console.log(`[SELF-HEAL] action ${action}`);
      return {
        executed: true,
        action,
        pendingVerification: beginVerification(diagnosis, 'recoverStaleJobs', observation)
      };
    }

    if (actionPlan.kind === 'heal_worker_runtime') {
      const healResult = await healWorkerRuntime(true);
      const action = `healWorkerRuntime:${healResult.runtime.started ? 'started' : 'pending'}`;
      recordCooldown(runtime.actionCooldowns, actionPlan.cooldownKey, actionPlan.cooldownMs);
      recordDiagnosisAttempt(runtime, diagnosis.type);
      console.log(`[SELF-HEAL] action ${action}`);
      return {
        executed: true,
        action,
        pendingVerification: beginVerification(diagnosis, 'healWorkerRuntime', observation)
      };
    }

    if (actionPlan.kind === 'activate_trinity_degraded_mode') {
      const mitigationResult = activateTrinitySelfHealingMitigation({
        stage: actionPlan.stage,
        action: actionPlan.trinityAction,
        reason: diagnosis.summary
      });

      if (!mitigationResult.applied) {
        console.log(
          `[SELF-HEAL] action skipped diagnosis=${diagnosis.type} reason=${mitigationResult.reason}`
        );
        return {
          executed: false,
          action: null,
          pendingVerification: null
        };
      }

      const action = `activateTrinityMitigation:${actionPlan.stage}:${actionPlan.trinityAction}`;
      recordCooldown(runtime.actionCooldowns, actionPlan.cooldownKey, actionPlan.cooldownMs);
      recordDiagnosisAttempt(runtime, diagnosis.type);
      console.log(`[SELF-HEAL] action ${action}`);
      return {
        executed: true,
        action,
        pendingVerification: beginVerification(diagnosis, action, observation, {
          kind: 'trinity',
          stage: actionPlan.stage,
          action: actionPlan.trinityAction,
          reason: 'self_heal_verification_failed'
        })
      };
    }

    if (actionPlan.kind === 'activate_prompt_route_reduced_latency_mode') {
      const defaultTokenLimit = Math.max(64, Math.min(256, observation.openaiHealth.defaults?.maxTokens ?? 256));
      const mitigationResult = activatePromptRouteReducedLatencyMode(diagnosis.summary, defaultTokenLimit);
      if (!mitigationResult.applied) {
        console.log(`[SELF-HEAL] action skipped diagnosis=${diagnosis.type} reason=${mitigationResult.reason}`);
        return {
          executed: false,
          action: null,
          pendingVerification: null
        };
      }

      const action = resolveActionTrackingKey();
      recordCooldown(runtime.actionCooldowns, actionPlan.cooldownKey, actionPlan.cooldownMs);
      recordDiagnosisAttempt(runtime, diagnosis.type);
      console.log(`[SELF-HEAL] action ${action}`);
      return {
        executed: true,
        action,
        pendingVerification: beginVerification(diagnosis, action, observation, {
          kind: 'prompt_route',
          reason: 'self_heal_verification_failed'
        })
      };
    }

    if (actionPlan.kind === 'activate_prompt_route_degraded_mode') {
      const mitigationResult = activatePromptRouteDegradedMode(diagnosis.summary);
      if (!mitigationResult.applied) {
        console.log(`[SELF-HEAL] action skipped diagnosis=${diagnosis.type} reason=${mitigationResult.reason}`);
        return {
          executed: false,
          action: null,
          pendingVerification: null
        };
      }

      const action = resolveActionTrackingKey();
      recordCooldown(runtime.actionCooldowns, actionPlan.cooldownKey, actionPlan.cooldownMs);
      recordDiagnosisAttempt(runtime, diagnosis.type);
      console.log(`[SELF-HEAL] action ${action}`);
      return {
        executed: true,
        action,
        pendingVerification: beginVerification(diagnosis, action, observation, {
          kind: 'prompt_route',
          reason: 'self_heal_verification_failed'
        })
      };
    }
  } catch (error) {
    runtime.status.lastError = resolveErrorMessage(error);
    console.error(`[SELF-HEAL] action error ${runtime.status.lastError}`);
  }

  return {
    executed: false,
    action: null,
    pendingVerification: null
  };
}

export function getSelfHealingLoopStatus(): SelfHealingLoopStatus {
  const runtime = getRuntime();
  if (runtime.timer === null) {
    runtime.status.intervalMs = resolveLoopIntervalMs();
  }
  runtime.status.loopRunning = runtime.timer !== null;
  runtime.status.active = runtime.status.loopRunning;
  runtime.status.lastTrinityMitigation = getActiveTrinityMitigation(getTrinitySelfHealingStatus());
  runtime.status.activeMitigation = getActiveAutomatedMitigation(getTrinitySelfHealingStatus());
  refreshStatusViews(runtime);

  return {
    ...runtime.status,
    bypassedSubsystems: [...runtime.status.bypassedSubsystems],
    ineffectiveActions: { ...runtime.status.ineffectiveActions },
    attemptsByDiagnosis: { ...runtime.status.attemptsByDiagnosis },
    cooldowns: { ...runtime.status.cooldowns },
    lastEvidence: runtime.status.lastEvidence ? { ...runtime.status.lastEvidence } : null,
    lastLatencySnapshot: runtime.status.lastLatencySnapshot
      ? {
          ...runtime.status.lastLatencySnapshot,
          promptRoute: runtime.status.lastLatencySnapshot.promptRoute
            ? { ...runtime.status.lastLatencySnapshot.promptRoute }
            : null
        }
      : null,
    recentTimeoutCounts: runtime.status.recentTimeoutCounts ? { ...runtime.status.recentTimeoutCounts } : null,
    lastVerificationResult: runtime.status.lastVerificationResult
      ? {
          ...runtime.status.lastVerificationResult,
          baseline: { ...runtime.status.lastVerificationResult.baseline },
          current: { ...runtime.status.lastVerificationResult.current }
        }
      : null
  };
}

export async function runSelfHealingLoop(options: {
  trigger?: 'startup' | 'interval' | 'manual';
  requestedCycle?: SelfImproveTrigger;
} = {}): Promise<SelfHealingLoopRunResult> {
  const runtime = getRuntime();
  const trigger = options.trigger ?? 'manual';
  const tickAt = new Date().toISOString();

  if (runtime.inFlight) {
    console.log(`[SELF-HEAL] tick skipped ${tickAt} trigger=${trigger} reason=in-flight`);
    return {
      trigger,
      tickAt,
      tickCount: runtime.status.tickCount,
      loopRunning: getSelfHealingLoopStatus().loopRunning,
      lastError: runtime.status.lastError,
      diagnosis: runtime.status.lastDiagnosis ?? 'in-flight',
      action: runtime.status.lastAction,
      controllerDecision: runtime.status.lastControllerDecision,
      evidence: runtime.status.lastEvidence,
      verificationResult: runtime.status.lastVerificationResult
    };
  }

  runtime.inFlight = true;

  try {
    runtime.status.lastTick = tickAt;
    runtime.status.tickCount += 1;
    runtime.status.lastError = null;

    console.log(`[SELF-HEAL] tick ${tickAt} trigger=${trigger} tickCount=${runtime.status.tickCount}`);

    const observation = await observeSelfHealingRuntime();
    const verification = maybeVerifyPendingAction(runtime, observation);

    const diagnosis = diagnoseSelfHealingRuntime(options, observation);
    runtime.status.lastDiagnosis = diagnosis.summary;
    runtime.status.lastEvidence = diagnosis.evidence;
    runtime.status.lastWorkerHealth = diagnosis.workerHealthLabel;
    runtime.status.lastTrinityMitigation = diagnosis.trinityMitigation;
    runtime.status.activeMitigation = getActiveAutomatedMitigation(observation.trinityStatus);
    runtime.status.degradedModeReason = observation.requestWindow.degradedReasons?.[0] ?? null;
    runtime.status.lastLatencySnapshot = buildLatencySnapshot(observation.requestWindow);
    runtime.status.recentTimeoutCounts = buildRecentTimeoutCounts(observation.requestWindow);
    runtime.status.bypassedSubsystems = combineBypassedSubsystems(observation.requestWindow);

    if (diagnosis.type === 'healthy' || diagnosis.type === 'prompt_route_stabilized') {
      runtime.status.lastHealthyObservedAt = tickAt;
    }

    console.log(`[SELF-HEAL] diagnosis ${diagnosis.summary}`);

    let action: string | null = verification.followUpAction;
    if (!action && verification.verificationResult === null) {
      const actionResult = await executeActionPlan(runtime, diagnosis, observation);
      if (actionResult.executed && actionResult.action) {
        action = actionResult.action;
        runtime.status.lastAction = action;
        runtime.status.lastActionAt = new Date().toISOString();
        runtime.pendingVerification = actionResult.pendingVerification;
      }
    }

    runtime.status.lastTrinityMitigation = getActiveTrinityMitigation(getTrinitySelfHealingStatus());
    runtime.status.activeMitigation = getActiveAutomatedMitigation(getTrinitySelfHealingStatus());

    let controllerDecision: SelfImproveDecision['decision'] | 'ERROR' | null = null;
    const shouldRunController =
      diagnosis.controllerInput !== null &&
      (trigger === 'manual' || shouldAutoInvokeController()) &&
      action === null;
    if (shouldRunController && diagnosis.controllerInput) {
      const controllerKey = diagnosis.incidentKey ?? diagnosis.controllerInput.trigger;
      if (trigger !== 'manual' && isCooldownActive(runtime.controllerCooldowns, controllerKey)) {
        console.log(`[SELF-HEAL] controller skipped key=${controllerKey} reason=cooldown`);
      } else {
        try {
          const decision = await runSelfImproveCycle(diagnosis.controllerInput);
          controllerDecision = decision.decision;
          runtime.status.lastControllerDecision = decision.decision;
          runtime.status.lastControllerRunAt = new Date().toISOString();
          recordCooldown(runtime.controllerCooldowns, controllerKey, resolveControllerCooldownMs());
          console.log(`[SELF-HEAL] controller decision=${decision.decision} id=${decision.id}`);
        } catch (error) {
          controllerDecision = 'ERROR';
          runtime.status.lastControllerDecision = 'ERROR';
          runtime.status.lastControllerRunAt = new Date().toISOString();
          runtime.status.lastError = resolveErrorMessage(error);
          console.error(`[SELF-HEAL] controller error ${runtime.status.lastError}`);
        }
      }
    }

    refreshStatusViews(runtime);

    return {
      trigger,
      tickAt,
      tickCount: runtime.status.tickCount,
      loopRunning: getSelfHealingLoopStatus().loopRunning,
      lastError: runtime.status.lastError,
      diagnosis: diagnosis.summary,
      action,
      controllerDecision,
      evidence: runtime.status.lastEvidence,
      verificationResult: verification.verificationResult
    };
  } catch (error) {
    refreshStatusViews(runtime);
    return {
      trigger,
      tickAt,
      tickCount: runtime.status.tickCount,
      loopRunning: getSelfHealingLoopStatus().loopRunning,
      lastError: recordLoopError(error),
      diagnosis: runtime.status.lastDiagnosis ?? 'error',
      action: runtime.status.lastAction,
      controllerDecision: runtime.status.lastControllerDecision,
      evidence: runtime.status.lastEvidence,
      verificationResult: runtime.status.lastVerificationResult
    };
  } finally {
    runtime.inFlight = false;
  }
}

export function startSelfHealingLoop(intervalMs = resolveLoopIntervalMs()): SelfHealingLoopStatus {
  const runtime = getRuntime();
  runtime.status.intervalMs = intervalMs;

  if (runtime.timer !== null || runtime.status.loopRunning) {
    console.log(
      `[SELF-HEAL] start skipped; already running startedAt=${runtime.status.startedAt ?? 'unknown'} intervalMs=${runtime.status.intervalMs}`
    );
    return getSelfHealingLoopStatus();
  }

  runtime.status.active = true;
  runtime.status.loopRunning = true;
  runtime.status.startedAt = new Date().toISOString();
  runtime.status.lastError = null;

  console.log(`[SELF-HEAL] loop started startedAt=${runtime.status.startedAt} intervalMs=${intervalMs}`);

  void runSelfHealingLoop({ trigger: 'startup' });

  runtime.timer = setInterval(() => {
    void runSelfHealingLoop({ trigger: 'interval' });
  }, intervalMs);

  if (typeof runtime.timer.unref === 'function') {
    runtime.timer.unref();
  }

  return getSelfHealingLoopStatus();
}

export function resetSelfHealingLoopStateForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    return;
  }

  const runtime = getRuntime();
  if (runtime.timer) {
    clearInterval(runtime.timer);
  }

  runtime.timer = null;
  runtime.inFlight = false;
  runtime.actionCooldowns.clear();
  runtime.controllerCooldowns.clear();
  runtime.ineffectiveActionCooldowns.clear();
  runtime.diagnosisAttempts.clear();
  runtime.pendingVerification = null;
  runtime.status = createInitialStatus();
  resetPromptRouteMitigationStateForTests();
}
