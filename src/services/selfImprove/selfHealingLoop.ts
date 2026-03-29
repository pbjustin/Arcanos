import { recoverStaleJobs } from '@core/db/repositories/jobRepository.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { logger } from '@platform/logging/structuredLogging.js';
import { getTelemetrySnapshot, recordTraceEvent } from '@platform/logging/telemetry.js';
import { getEnvBoolean, getEnvNumber } from '@platform/runtime/env.js';
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
import { resolveGptRouteHardTimeoutMs } from '@shared/http/gptRouteTimeout.js';
import {
  getWorkerControlHealth,
  type WorkerControlHealthResponse
} from '@services/workerControlService.js';
import { getWorkerAutonomySettings } from '@services/workerAutonomyService.js';
import {
  inferSelfHealComponentFromAction,
  recordSelfHealEvent,
  resetSelfHealTelemetryForTests
} from '@services/selfImprove/selfHealTelemetry.js';
import { runPredictiveHealingFromLoop } from '@services/selfImprove/predictiveHealingService.js';
import { resolvePredictiveHealingLoopIntervalMs } from '@services/selfImprove/runtimeConfig.js';
import {
  buildWorkerRepairActuatorStatus,
  executeWorkerRepairActuator
} from '@services/selfImprove/workerRepairActuator.js';
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
const PROMPT_ROUTE_SIGNIFICANT_SHARE = 0.15;
const VERIFICATION_SUCCESS_SIGNAL_COUNT = 2;
const VERIFICATION_FAILURE_SIGNAL_COUNT = 2;
const VERIFICATION_TIMEOUT_COUNT_WORSE_DELTA = 1;
const LOOP_TICK_EVENT = 'LOOP_TICK';
const METRICS_COLLECTED_EVENT = 'METRICS_COLLECTED';
const AI_DIAGNOSIS_REQUEST_EVENT = 'AI_DIAGNOSIS_REQUEST';
const AI_DIAGNOSIS_RESULT_EVENT = 'AI_DIAGNOSIS_RESULT';
const CONTROLLER_DECISION_EVENT = 'CONTROLLER_DECISION';
const ACTION_EXECUTED_EVENT = 'ACTION_EXECUTED';
const ACTION_DISPATCH_ATTEMPT_EVENT = 'ACTION_DISPATCH_ATTEMPT';
const ACTION_DISPATCH_RESULT_EVENT = 'ACTION_DISPATCH_RESULT';
const WORKER_RECEIPT_EVENT = 'WORKER_RECEIPT';
const HEAL_RESULT_EVENT = 'HEAL_RESULT';
const AI_FAILED_EVENT = 'AI_FAILED';
const FALLBACK_USED_EVENT = 'FALLBACK_USED';
const SELF_HEAL_DEBUG_FORCE_AI_HEAL_ONCE_ENV = 'SELF_HEAL_DEBUG_FORCE_AI_HEAL_ONCE';
const PROMPT_ROUTE_ABORT_PROPAGATION_COVERAGE = [
  'request_abort_context',
  'prompt_route_call_openai_signal',
  'request_abort_timeout_on_abort_hook'
] as const;
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
  inFlight: boolean;
  startedAt: string | null;
  lastTick: string | null;
  tickCount: number;
  lastError: string | null;
  intervalMs: number;
  lastDiagnosis: string | null;
  lastAIDiagnosis: {
    requestedAt: string;
    completedAt: string;
    advisor: string;
    decision: 'heal' | 'observe';
    reason: string;
    confidence: number;
    action: string | null;
    target: string | null;
    safeToExecute: boolean;
    executionStatus: string | null;
    fallbackUsed: boolean;
    aiUsedInRuntime: boolean;
  } | null;
  lastDecision: 'heal' | 'observe' | null;
  lastAction: string | null;
  lastActionAt: string | null;
  lastResult: string | null;
  lastControllerDecision: SelfImproveDecision['decision'] | 'ERROR' | null;
  lastControllerRunAt: string | null;
  lastWorkerHealth: string | null;
  lastTrinityMitigation: string | null;
  lastEvidence: Record<string, unknown> | null;
  lastVerificationResult: SelfHealingVerificationResult | null;
  activeMitigation: string | null;
  activePromptMitigation: string | null;
  lastPromptMitigationReason: string | null;
  degradedModeReason: string | null;
  aiUsedInRuntime: boolean | null;
  lastDispatchAttempt: {
    at: string;
    action: string;
    target: string | null;
    actuatorMode: string | null;
    baseUrl: string | null;
    path: string | null;
    correlationId: string | null;
  } | null;
  lastDispatchTarget: {
    target: string | null;
    actuatorMode: string | null;
    baseUrl: string | null;
    path: string | null;
  } | null;
  lastWorkerReceipt: {
    at: string;
    action: string;
    target: string | null;
    actuatorMode: string | null;
    statusCode: number | null;
    message: string | null;
  } | null;
  lastHealResult: {
    at: string;
    outcome: 'success' | 'failure' | 'noop' | 'fallback';
    action: string | null;
    target: string | null;
    message: string | null;
  } | null;
  timeline: {
    lastLoopTickAt: string | null;
    lastMetricsCollectedAt: string | null;
    lastAIRequestAt: string | null;
    lastAIResultAt: string | null;
    lastDecisionAt: string | null;
    lastActionDispatchAttemptAt: string | null;
    lastActionDispatchResultAt: string | null;
    lastWorkerReceiptAt: string | null;
    lastHealResultAt: string | null;
  };
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
  recentPipelineTimeoutCounts: {
    total: number;
    promptRoute: number;
    coreRoute: number;
  } | null;
  recentPromptRouteTimeouts: number | null;
  recentPromptRouteLatencyP95: number | null;
  recentPromptRouteMaxLatency: number | null;
  outerRouteTimeoutMs: number;
  abortPropagationCoverage: string[];
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
  debugForcedHealConsumed: boolean;
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

type SelfHealingAIDiagnosis = NonNullable<SelfHealingLoopStatus['lastAIDiagnosis']>;

type SelfHealingAIDiagnosisResult = {
  diagnosis: SelfHealingAIDiagnosis;
  predictiveResult: Awaited<ReturnType<typeof runPredictiveHealingFromLoop>> | null;
};

function getSelfHealingActionTarget(actionPlan: SelfHealingActionPlan): string {
  if (actionPlan.kind === 'recover_stale_jobs') {
    return 'worker_queue';
  }

  if (actionPlan.kind === 'heal_worker_runtime') {
    return 'worker_runtime';
  }

  if (
    actionPlan.kind === 'activate_prompt_route_reduced_latency_mode' ||
    actionPlan.kind === 'activate_prompt_route_degraded_mode'
  ) {
    return 'prompt_route';
  }

  return `trinity.${actionPlan.stage}`;
}

function resolveActionTrackingKey(actionPlan: SelfHealingActionPlan): string {
  if (
    actionPlan.kind === 'recover_stale_jobs' ||
    actionPlan.kind === 'heal_worker_runtime'
  ) {
    return actionPlan.actionKey;
  }

  if (actionPlan.kind === 'activate_prompt_route_reduced_latency_mode') {
    return 'activatePromptRouteMitigation:reduced_latency';
  }

  if (actionPlan.kind === 'activate_prompt_route_degraded_mode') {
    return 'activatePromptRouteMitigation:degraded_response';
  }

  return `activateTrinityMitigation:${actionPlan.stage}:${actionPlan.trinityAction}`;
}

function getSelfHealingActionRecommendation(actionPlan: SelfHealingActionPlan | null): string | null {
  return actionPlan ? resolveActionTrackingKey(actionPlan) : null;
}

function isPredictiveAIFallback(
  predictiveResult: Awaited<ReturnType<typeof runPredictiveHealingFromLoop>>
): boolean {
  return (
    typeof predictiveResult.decision.advisor !== 'string' ||
    predictiveResult.decision.advisor.trim().length === 0 ||
    predictiveResult.decision.advisor === 'rules_fallback_v1' ||
    predictiveResult.decision.details?.aiUsed === false
  );
}

function buildDeterministicAIDiagnosis(
  diagnosis: SelfHealingDiagnosis,
  requestedAt: string,
  fallbackReason: string
): SelfHealingAIDiagnosis {
  const recommendedAction = getSelfHealingActionRecommendation(diagnosis.actionPlan);
  return {
    requestedAt,
    completedAt: new Date().toISOString(),
    advisor: 'deterministic_fallback_v1',
    decision: diagnosis.actionPlan ? 'heal' : 'observe',
    reason: fallbackReason,
    confidence: diagnosis.confidence,
    action: recommendedAction,
    target: diagnosis.actionPlan ? getSelfHealingActionTarget(diagnosis.actionPlan) : null,
    safeToExecute: Boolean(diagnosis.actionPlan && diagnosis.confidence >= 0.7),
    executionStatus: null,
    fallbackUsed: true,
    aiUsedInRuntime: false
  };
}

function buildAIDiagnosisFromPredictiveResult(
  diagnosis: SelfHealingDiagnosis,
  predictiveResult: Awaited<ReturnType<typeof runPredictiveHealingFromLoop>>,
  requestedAt: string
): SelfHealingAIDiagnosis {
  if (isPredictiveAIFallback(predictiveResult)) {
    const aiFallbackReason =
      typeof predictiveResult.decision.details?.aiFallbackReason === 'string' &&
      predictiveResult.decision.details.aiFallbackReason.trim().length > 0
        ? predictiveResult.decision.details.aiFallbackReason.trim()
        : predictiveResult.decision.reason;

    return buildDeterministicAIDiagnosis(
      diagnosis,
      requestedAt,
      `AI unavailable; deterministic fallback selected. ${aiFallbackReason}`
    );
  }

  return {
    requestedAt,
    completedAt: new Date().toISOString(),
    advisor: predictiveResult.decision.advisor,
    decision: predictiveResult.decision.action === 'none' ? 'observe' : 'heal',
    reason: predictiveResult.decision.reason,
    confidence: predictiveResult.decision.confidence,
    action: predictiveResult.decision.action === 'none' ? null : predictiveResult.decision.action,
    target: predictiveResult.decision.target,
    safeToExecute: predictiveResult.decision.safeToExecute,
    executionStatus: predictiveResult.execution.status,
    fallbackUsed: false,
    aiUsedInRuntime: predictiveResult.decision.details?.aiUsed !== false
  };
}

function shouldForceAIDebugHealOnce(runtime: SelfHealingLoopRuntime, diagnosis: SelfHealingDiagnosis): boolean {
  return (
    getEnvBoolean(SELF_HEAL_DEBUG_FORCE_AI_HEAL_ONCE_ENV, false) &&
    !runtime.debugForcedHealConsumed &&
    diagnosis.actionPlan !== null
  );
}

function applyForcedAIDebugHealOnce(params: {
  runtime: SelfHealingLoopRuntime;
  diagnosis: SelfHealingDiagnosis;
  aiDiagnosis: SelfHealingAIDiagnosis;
}): SelfHealingAIDiagnosis {
  const actionPlan = params.diagnosis.actionPlan;
  if (!actionPlan || !shouldForceAIDebugHealOnce(params.runtime, params.diagnosis)) {
    return params.aiDiagnosis;
  }

  params.runtime.debugForcedHealConsumed = true;
  if (params.aiDiagnosis.decision === 'heal') {
    return params.aiDiagnosis;
  }

  return {
    ...params.aiDiagnosis,
    completedAt: new Date().toISOString(),
    decision: 'heal',
    reason: `${params.aiDiagnosis.reason} Debug override forced a heal decision for validation.`,
    confidence: Math.max(params.aiDiagnosis.confidence, params.diagnosis.confidence),
    action: getSelfHealingActionRecommendation(actionPlan),
    target: getSelfHealingActionTarget(actionPlan),
    safeToExecute: params.diagnosis.confidence >= 0.7,
    executionStatus: params.aiDiagnosis.executionStatus ?? 'skipped'
  };
}

function recordAIDiagnosisStatus(
  runtime: SelfHealingLoopRuntime,
  diagnosis: SelfHealingAIDiagnosis
): void {
  runtime.status.lastAIDiagnosis = { ...diagnosis };
  runtime.status.lastDecision = diagnosis.decision;
  runtime.status.aiUsedInRuntime = diagnosis.aiUsedInRuntime;
  runtime.status.timeline.lastAIResultAt = diagnosis.completedAt;
  runtime.status.lastEvidence = {
    ...(runtime.status.lastEvidence ?? {}),
    aiDiagnosis: { ...diagnosis }
  };
}

function buildAIDiagnosisResultDetails(diagnosis: SelfHealingAIDiagnosis): Record<string, unknown> {
  return {
    advisor: diagnosis.advisor,
    decision: diagnosis.decision,
    action: diagnosis.action,
    target: diagnosis.target,
    reason: diagnosis.reason,
    confidence: diagnosis.confidence,
    safeToExecute: diagnosis.safeToExecute,
    executionStatus: diagnosis.executionStatus,
    fallbackUsed: diagnosis.fallbackUsed,
    aiUsedInRuntime: diagnosis.aiUsedInRuntime
  };
}

function recordLoopTick(params: {
  runtime: SelfHealingLoopRuntime;
  trigger: 'startup' | 'interval' | 'manual';
  tickAt: string;
}): void {
  params.runtime.status.timeline.lastLoopTickAt = params.tickAt;
  recordSelfHealEvent({
    kind: LOOP_TICK_EVENT,
    source: 'self_heal_loop',
    trigger: params.trigger,
    reason: `self-heal loop tick ${params.runtime.status.tickCount}`,
    actionTaken: params.runtime.status.lastAction,
    healedComponent: inferSelfHealComponentFromAction(params.runtime.status.lastAction),
    details: {
      trigger: params.trigger,
      tickCount: params.runtime.status.tickCount,
      inFlight: params.runtime.inFlight
    },
    timestamp: params.tickAt
  });
}

function recordFallbackUsed(params: {
  runtime: SelfHealingLoopRuntime;
  trigger: 'startup' | 'interval' | 'manual';
  diagnosis: SelfHealingDiagnosis;
  aiDiagnosis: SelfHealingAIDiagnosis;
  reason: string;
}): void {
  recordSelfHealEvent({
    kind: FALLBACK_USED_EVENT,
    source: 'self_heal_loop',
    trigger: 'ai_diagnosis',
    reason: params.reason,
    actionTaken: params.aiDiagnosis.action,
    healedComponent: params.aiDiagnosis.target,
    correlationId: params.diagnosis.incidentKey,
    details: {
      trigger: params.trigger,
      advisor: params.aiDiagnosis.advisor,
      decision: params.aiDiagnosis.decision,
      diagnosisType: params.diagnosis.type,
      incidentKey: params.diagnosis.incidentKey
    },
    timestamp: params.aiDiagnosis.completedAt
  });
}

function recordAIFailed(params: {
  trigger: 'startup' | 'interval' | 'manual';
  diagnosis: SelfHealingDiagnosis;
  requestedAt: string;
  errorMessage: string;
}): void {
  recordSelfHealEvent({
    kind: AI_FAILED_EVENT,
    source: 'self_heal_loop',
    trigger: 'ai_diagnosis',
    reason: params.errorMessage,
    actionTaken: getSelfHealingActionRecommendation(params.diagnosis.actionPlan),
    healedComponent: params.diagnosis.actionPlan ? getSelfHealingActionTarget(params.diagnosis.actionPlan) : null,
    correlationId: params.diagnosis.incidentKey,
    details: {
      trigger: params.trigger,
      diagnosisType: params.diagnosis.type,
      incidentKey: params.diagnosis.incidentKey
    },
    timestamp: params.requestedAt
  });
}

function recordActionDispatchAttempt(params: {
  runtime: SelfHealingLoopRuntime;
  trigger: 'startup' | 'interval' | 'manual';
  diagnosis: SelfHealingDiagnosis;
  action: string;
  target: string | null;
  actuatorMode?: string | null;
  baseUrl?: string | null;
  path?: string | null;
}): void {
  const timestamp = new Date().toISOString();
  const dispatchAttempt = {
    at: timestamp,
    action: params.action,
    target: params.target,
    actuatorMode: params.actuatorMode ?? null,
    baseUrl: params.baseUrl ?? null,
    path: params.path ?? null,
    correlationId: params.diagnosis.incidentKey
  };

  params.runtime.status.lastDispatchAttempt = dispatchAttempt;
  params.runtime.status.lastDispatchTarget = {
    target: params.target,
    actuatorMode: dispatchAttempt.actuatorMode,
    baseUrl: dispatchAttempt.baseUrl,
    path: dispatchAttempt.path
  };
  params.runtime.status.timeline.lastActionDispatchAttemptAt = timestamp;

  recordSelfHealEvent({
    kind: ACTION_DISPATCH_ATTEMPT_EVENT,
    source: 'self_heal_loop',
    trigger: 'action',
    reason: params.diagnosis.summary,
    actionTaken: params.action,
    healedComponent: params.target,
    correlationId: params.diagnosis.incidentKey,
    details: {
      trigger: params.trigger,
      diagnosisType: params.diagnosis.type,
      incidentKey: params.diagnosis.incidentKey,
      actuatorMode: dispatchAttempt.actuatorMode,
      baseUrl: dispatchAttempt.baseUrl,
      path: dispatchAttempt.path
    },
    timestamp
  });
}

function recordActionDispatchResult(params: {
  runtime: SelfHealingLoopRuntime;
  diagnosis: SelfHealingDiagnosis;
  action: string;
  target: string | null;
  outcome: 'success' | 'failure' | 'skipped';
  actuatorMode?: string | null;
  baseUrl?: string | null;
  path?: string | null;
  statusCode?: number | null;
  message?: string | null;
  timestamp?: string;
}): void {
  const timestamp = params.timestamp ?? new Date().toISOString();
  params.runtime.status.timeline.lastActionDispatchResultAt = timestamp;
  if (params.outcome === 'success') {
    params.runtime.status.lastResult = 'success';
  } else if (params.outcome === 'failure') {
    params.runtime.status.lastResult = 'failure';
  }

  recordSelfHealEvent({
    kind: ACTION_DISPATCH_RESULT_EVENT,
    source: 'self_heal_loop',
    trigger: 'action',
    reason: params.message ?? params.diagnosis.summary,
    actionTaken: params.action,
    healedComponent: params.target,
    correlationId: params.diagnosis.incidentKey,
    details: {
      diagnosisType: params.diagnosis.type,
      incidentKey: params.diagnosis.incidentKey,
      outcome: params.outcome,
      actuatorMode: params.actuatorMode ?? null,
      baseUrl: params.baseUrl ?? null,
      path: params.path ?? null,
      statusCode: params.statusCode ?? null,
      message: params.message ?? null
    },
    timestamp
  });
}

function recordWorkerReceipt(params: {
  runtime: SelfHealingLoopRuntime;
  diagnosis: SelfHealingDiagnosis;
  action: string;
  target: string | null;
  actuatorMode: string;
  statusCode: number | null;
  message: string;
  timestamp?: string;
}): void {
  const timestamp = params.timestamp ?? new Date().toISOString();
  params.runtime.status.lastWorkerReceipt = {
    at: timestamp,
    action: params.action,
    target: params.target,
    actuatorMode: params.actuatorMode,
    statusCode: params.statusCode,
    message: params.message
  };
  params.runtime.status.timeline.lastWorkerReceiptAt = timestamp;

  recordSelfHealEvent({
    kind: WORKER_RECEIPT_EVENT,
    source: 'self_heal_loop',
    trigger: 'action',
    reason: params.message,
    actionTaken: params.action,
    healedComponent: params.target,
    correlationId: params.diagnosis.incidentKey,
    details: {
      diagnosisType: params.diagnosis.type,
      incidentKey: params.diagnosis.incidentKey,
      actuatorMode: params.actuatorMode,
      statusCode: params.statusCode,
      message: params.message
    },
    timestamp
  });
}

function recordHealResult(params: {
  runtime: SelfHealingLoopRuntime;
  diagnosis: SelfHealingDiagnosis;
  action: string | null;
  target: string | null;
  outcome: 'success' | 'failure' | 'noop' | 'fallback';
  message: string | null;
  timestamp?: string;
}): void {
  const timestamp = params.timestamp ?? new Date().toISOString();
  params.runtime.status.lastHealResult = {
    at: timestamp,
    outcome: params.outcome,
    action: params.action,
    target: params.target,
    message: params.message
  };
  params.runtime.status.lastResult = params.outcome;
  params.runtime.status.timeline.lastHealResultAt = timestamp;

  recordSelfHealEvent({
    kind: HEAL_RESULT_EVENT,
    source: 'self_heal_loop',
    trigger: 'action',
    reason: params.message,
    actionTaken: params.action,
    healedComponent: params.target,
    correlationId: params.diagnosis.incidentKey,
    details: {
      diagnosisType: params.diagnosis.type,
      incidentKey: params.diagnosis.incidentKey,
      outcome: params.outcome,
      message: params.message
    },
    timestamp
  });
}

function recordMetricsCollected(params: {
  runtime: SelfHealingLoopRuntime;
  trigger: 'startup' | 'interval' | 'manual';
  diagnosis: SelfHealingDiagnosis;
  observation: SelfHealingObservation;
}): void {
  params.runtime.status.timeline.lastMetricsCollectedAt = params.observation.requestWindow.generatedAt;
  const details = {
    diagnosisType: params.diagnosis.type,
    requestCount: params.observation.requestWindow.requestCount,
    serverErrorCount: params.observation.requestWindow.serverErrorCount,
    errorRate: params.observation.requestWindow.errorRate,
    timeoutCount: params.observation.requestWindow.timeoutCount,
    timeoutRate: params.observation.requestWindow.timeoutRate,
    avgLatencyMs: params.observation.requestWindow.avgLatencyMs,
    p95LatencyMs: params.observation.requestWindow.p95LatencyMs,
    maxLatencyMs: params.observation.requestWindow.maxLatencyMs
  };

  logger.info(METRICS_COLLECTED_EVENT, {
    module: 'self_heal.loop',
    source: 'self_heal_loop',
    trigger: params.trigger,
    ...details
  });
  recordTraceEvent(METRICS_COLLECTED_EVENT, {
    trigger: params.trigger,
    ...details
  });
  recordSelfHealEvent({
    kind: METRICS_COLLECTED_EVENT,
    source: 'self_heal_loop',
    trigger: params.trigger,
    reason: params.diagnosis.summary,
    healedComponent: params.diagnosis.actionPlan ? getSelfHealingActionTarget(params.diagnosis.actionPlan) : null,
    correlationId: params.diagnosis.incidentKey,
    details,
    timestamp: params.observation.requestWindow.generatedAt
  });
}

function recordControllerDecision(params: {
  runtime: SelfHealingLoopRuntime;
  trigger: 'startup' | 'interval' | 'manual';
  diagnosis: SelfHealingDiagnosis;
  aiDiagnosis: SelfHealingAIDiagnosis;
}): void {
  const details = buildAIDiagnosisResultDetails(params.aiDiagnosis);
  params.runtime.status.timeline.lastDecisionAt = params.aiDiagnosis.completedAt;

  logger.info(CONTROLLER_DECISION_EVENT, {
    module: 'self_heal.loop',
    source: 'self_heal_loop',
    trigger: params.trigger,
    diagnosisType: params.diagnosis.type,
    incidentKey: params.diagnosis.incidentKey,
    ...details
  });
  recordTraceEvent(CONTROLLER_DECISION_EVENT, {
    trigger: params.trigger,
    diagnosisType: params.diagnosis.type,
    incidentKey: params.diagnosis.incidentKey,
    ...details
  });
  recordSelfHealEvent({
    kind: CONTROLLER_DECISION_EVENT,
    source: 'self_heal_loop',
    trigger: 'controller',
    reason: params.aiDiagnosis.reason,
    actionTaken: params.aiDiagnosis.action,
    healedComponent: params.aiDiagnosis.target,
    correlationId: params.diagnosis.incidentKey,
    details: {
      trigger: params.trigger,
      incidentKey: params.diagnosis.incidentKey,
      diagnosisType: params.diagnosis.type,
      ...details
    },
    timestamp: params.aiDiagnosis.completedAt
  });
  logger.info('self_heal.controller.ai_decision', {
    module: 'self_heal.loop',
    source: 'self_heal_loop',
    trigger: params.trigger,
    incidentKey: params.diagnosis.incidentKey,
    diagnosisType: params.diagnosis.type,
    advisor: params.aiDiagnosis.advisor,
    decision: params.aiDiagnosis.decision,
    action: params.aiDiagnosis.action,
    target: params.aiDiagnosis.target
  });
}

function recordActionExecuted(params: {
  trigger: 'startup' | 'interval' | 'manual';
  diagnosis: SelfHealingDiagnosis;
  action: string;
  target: string | null;
  executionSource: 'predictive_auto_execute' | 'self_heal_execute_action';
  details?: Record<string, unknown>;
}): void {
  const details = {
    diagnosisType: params.diagnosis.type,
    executionSource: params.executionSource,
    ...(params.details ?? {})
  };

  logger.info(ACTION_EXECUTED_EVENT, {
    module: 'self_heal.loop',
    source: 'self_heal_loop',
    trigger: params.trigger,
    action: params.action,
    target: params.target,
    ...details
  });
  recordTraceEvent(ACTION_EXECUTED_EVENT, {
    trigger: params.trigger,
    action: params.action,
    target: params.target,
    ...details
  });
  recordSelfHealEvent({
    kind: ACTION_EXECUTED_EVENT,
    source: 'self_heal_loop',
    trigger: 'action',
    reason: params.diagnosis.summary,
    actionTaken: params.action,
    healedComponent: params.target,
    correlationId: params.diagnosis.incidentKey,
    details,
    timestamp: new Date().toISOString()
  });
  logger.info('self_heal.action.executed', {
    module: 'self_heal.loop',
    source: 'self_heal_loop',
    trigger: params.trigger,
    diagnosisType: params.diagnosis.type,
    action: params.action,
    target: params.target,
    executionSource: params.executionSource
  });
}

function recordAndLogAIDiagnosisResult(params: {
  runtime: SelfHealingLoopRuntime;
  trigger: 'startup' | 'interval' | 'manual';
  diagnosisContext?: SelfHealingDiagnosis | null;
  diagnosis: SelfHealingAIDiagnosis;
  isFallback?: boolean;
}): void {
  const details = buildAIDiagnosisResultDetails(params.diagnosis);
  recordAIDiagnosisStatus(params.runtime, params.diagnosis);

  const logPayload = {
    module: 'self_heal.loop',
    source: 'self_heal_loop',
    trigger: params.trigger,
    advisor: params.diagnosis.advisor,
    decision: params.diagnosis.decision,
    action: params.diagnosis.action,
    target: params.diagnosis.target,
    confidence: params.diagnosis.confidence,
    safeToExecute: params.diagnosis.safeToExecute,
    executionStatus: params.diagnosis.executionStatus,
    fallbackUsed: params.diagnosis.fallbackUsed
  };

  if (params.isFallback) {
    logger.warn(AI_DIAGNOSIS_RESULT_EVENT, logPayload);
  } else {
    logger.info(AI_DIAGNOSIS_RESULT_EVENT, logPayload);
  }

  recordTraceEvent(AI_DIAGNOSIS_RESULT_EVENT, {
    trigger: params.trigger,
    advisor: params.diagnosis.advisor,
    decision: params.diagnosis.decision,
    action: params.diagnosis.action,
    target: params.diagnosis.target,
    confidence: params.diagnosis.confidence,
    safeToExecute: params.diagnosis.safeToExecute,
    executionStatus: params.diagnosis.executionStatus,
    fallbackUsed: params.diagnosis.fallbackUsed
  });

  recordSelfHealEvent({
    kind: AI_DIAGNOSIS_RESULT_EVENT,
    source: 'self_heal_loop',
    trigger: 'ai_diagnosis',
    reason: params.diagnosis.reason,
    actionTaken: params.diagnosis.action,
    healedComponent: params.diagnosis.target,
    correlationId: params.diagnosisContext?.incidentKey ?? null,
    details,
    timestamp: params.diagnosis.completedAt
  });
  logger.info('self_heal.ai_diagnosis.summary', {
    module: 'self_heal.loop',
    source: 'self_heal_loop',
    trigger: params.trigger,
    advisor: params.diagnosis.advisor,
    decision: params.diagnosis.decision,
    action: params.diagnosis.action,
    target: params.diagnosis.target,
    fallbackUsed: params.diagnosis.fallbackUsed,
    isFallback: Boolean(params.isFallback)
  });
}

async function aiDiagnoseAndDecide(params: {
  runtime: SelfHealingLoopRuntime;
  trigger: 'startup' | 'interval' | 'manual';
  diagnosis: SelfHealingDiagnosis;
  observation: SelfHealingObservation;
}): Promise<SelfHealingAIDiagnosisResult> {
  logger.info('self_heal.ai_path.executed', {
    module: 'self_heal.loop',
    source: 'self_heal_loop',
    marker: '[SELF-HEAL] AI PATH EXECUTED v2',
    trigger: params.trigger,
    diagnosisType: params.diagnosis.type,
    incidentKey: params.diagnosis.incidentKey
  });
  recordTraceEvent('self_heal.ai_path.executed', {
    marker: '[SELF-HEAL] AI PATH EXECUTED v2',
    trigger: params.trigger,
    diagnosisType: params.diagnosis.type,
    incidentKey: params.diagnosis.incidentKey
  });
  const requestedAt = new Date().toISOString();
  params.runtime.status.timeline.lastAIRequestAt = requestedAt;
  const recommendedAction = getSelfHealingActionRecommendation(params.diagnosis.actionPlan);
  const recommendedTarget = params.diagnosis.actionPlan
    ? getSelfHealingActionTarget(params.diagnosis.actionPlan)
    : null;

  logger.info(AI_DIAGNOSIS_REQUEST_EVENT, {
    module: 'self_heal.loop',
    source: 'self_heal_loop',
    trigger: params.trigger,
    diagnosisType: params.diagnosis.type,
    incidentKey: params.diagnosis.incidentKey,
    recommendedAction,
    recommendedTarget,
    requestCount: params.observation.requestWindow.requestCount
  });
  recordTraceEvent(AI_DIAGNOSIS_REQUEST_EVENT, {
    trigger: params.trigger,
    diagnosisType: params.diagnosis.type,
    incidentKey: params.diagnosis.incidentKey,
    recommendedAction,
    recommendedTarget,
    requestCount: params.observation.requestWindow.requestCount
  });
  recordSelfHealEvent({
    kind: AI_DIAGNOSIS_REQUEST_EVENT,
    source: 'self_heal_loop',
    trigger: 'ai_diagnosis',
    reason: params.diagnosis.summary,
    actionTaken: recommendedAction,
    healedComponent: recommendedTarget,
    correlationId: params.diagnosis.incidentKey,
    details: {
      trigger: params.trigger,
      diagnosisType: params.diagnosis.type,
      incidentKey: params.diagnosis.incidentKey,
      confidence: params.diagnosis.confidence
    },
    timestamp: requestedAt
  });

  try {
    const predictiveResult = await runPredictiveHealingFromLoop({
      source: 'predictive_self_heal_loop',
      observation: {
        requestWindow: params.observation.requestWindow,
        workerHealth: params.observation.workerHealth,
        workerRuntime: params.observation.workerRuntime,
        trinityStatus: params.observation.trinityStatus,
        workerHealthError: params.observation.workerHealthError
      }
    });
    const aiDiagnosis = applyForcedAIDebugHealOnce({
      runtime: params.runtime,
      diagnosis: params.diagnosis,
      aiDiagnosis: buildAIDiagnosisFromPredictiveResult(params.diagnosis, predictiveResult, requestedAt)
    });
    recordAndLogAIDiagnosisResult({
      runtime: params.runtime,
      trigger: params.trigger,
      diagnosisContext: params.diagnosis,
      diagnosis: aiDiagnosis
    });
    if (aiDiagnosis.fallbackUsed) {
      recordFallbackUsed({
        runtime: params.runtime,
        trigger: params.trigger,
        diagnosis: params.diagnosis,
        aiDiagnosis,
        reason: aiDiagnosis.reason
      });
    }
    return {
      diagnosis: aiDiagnosis,
      predictiveResult
    };
  } catch (error) {
    const errorMessage = resolveErrorMessage(error);
    recordAIFailed({
      trigger: params.trigger,
      diagnosis: params.diagnosis,
      requestedAt,
      errorMessage
    });
    const aiDiagnosis = buildDeterministicAIDiagnosis(
      params.diagnosis,
      requestedAt,
      `AI diagnosis failed; deterministic fallback selected. ${errorMessage}`
    );
    recordAndLogAIDiagnosisResult({
      runtime: params.runtime,
      trigger: params.trigger,
      diagnosisContext: params.diagnosis,
      diagnosis: aiDiagnosis,
      isFallback: true
    });
    recordFallbackUsed({
      runtime: params.runtime,
      trigger: params.trigger,
      diagnosis: params.diagnosis,
      aiDiagnosis,
      reason: aiDiagnosis.reason
    });
    return {
      diagnosis: aiDiagnosis,
      predictiveResult: null
    };
  }
}

type SelfHealingLoopGlobal = typeof globalThis & {
  [SELF_HEAL_RUNTIME_KEY]?: SelfHealingLoopRuntime;
};

function resolveLoopIntervalMs(): number {
  return resolvePredictiveHealingLoopIntervalMs(DEFAULT_INTERVAL_MS);
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
    inFlight: false,
    startedAt: null,
    lastTick: null,
    tickCount: 0,
    lastError: null,
    intervalMs: resolveLoopIntervalMs(),
    lastDiagnosis: null,
    lastAIDiagnosis: null,
    lastDecision: null,
    lastAction: null,
    lastActionAt: null,
    lastResult: null,
    lastControllerDecision: null,
    lastControllerRunAt: null,
    lastWorkerHealth: null,
    lastTrinityMitigation: null,
    lastEvidence: null,
    lastVerificationResult: null,
    activeMitigation: null,
    activePromptMitigation: null,
    lastPromptMitigationReason: null,
    degradedModeReason: null,
    aiUsedInRuntime: null,
    lastDispatchAttempt: null,
    lastDispatchTarget: null,
    lastWorkerReceipt: null,
    lastHealResult: null,
    timeline: {
      lastLoopTickAt: null,
      lastMetricsCollectedAt: null,
      lastAIRequestAt: null,
      lastAIResultAt: null,
      lastDecisionAt: null,
      lastActionDispatchAttemptAt: null,
      lastActionDispatchResultAt: null,
      lastWorkerReceiptAt: null,
      lastHealResultAt: null
    },
    lastLatencySnapshot: null,
    recentTimeoutCounts: null,
    recentPipelineTimeoutCounts: null,
    recentPromptRouteTimeouts: null,
    recentPromptRouteLatencyP95: null,
    recentPromptRouteMaxLatency: null,
    outerRouteTimeoutMs: resolveGptRouteHardTimeoutMs(),
    abortPropagationCoverage: [...PROMPT_ROUTE_ABORT_PROPAGATION_COVERAGE],
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
    pendingVerification: null,
    debugForcedHealConsumed: false
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
  recordSelfHealEvent({
    kind: 'failure',
    source: 'self_heal_loop',
    trigger: 'loop_error',
    reason: message,
    actionTaken: runtime.status.lastAction,
    healedComponent: inferSelfHealComponentFromAction(runtime.status.lastAction)
  });
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

function getPromptRouteWindowSnapshot(
  requestWindow: RequestWindowSnapshot
): RequestWindowSnapshot['routes'][number] | null {
  return requestWindow.routes.find((route) => route.route === PROMPT_ROUTE_PATH) ?? null;
}

function buildPromptRouteVerificationSnapshot(
  requestWindow: RequestWindowSnapshot
): SelfHealingVerificationSnapshot['promptRoute'] {
  const promptRoute = getPromptRouteWindowSnapshot(requestWindow);
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

function buildRecentPipelineTimeoutCounts(
  requestWindow: RequestWindowSnapshot
): SelfHealingLoopStatus['recentPipelineTimeoutCounts'] {
  const promptRoute = getPromptRouteWindowSnapshot(requestWindow);
  const coreRoutePipelineTimeouts = requestWindow.routes
    .filter((route) => route.route === '/gpt/:gptId' || route.route === '/api/arcanos/ask')
    .reduce((total, route) => total + route.pipelineTimeoutCount, 0);

  return {
    total: requestWindow.pipelineTimeoutCount ?? 0,
    promptRoute: promptRoute?.pipelineTimeoutCount ?? 0,
    coreRoute: coreRoutePipelineTimeouts
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
  const promptRoute = getPromptRouteWindowSnapshot(requestWindow);
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
  const promptRoute = getPromptRouteWindowSnapshot(window);
  if (!promptRoute) {
    return null;
  }

  const requestShare = promptRoute.requestCount / Math.max(1, window.requestCount);
  const promptRouteMaxLatencyMs = promptRoute.maxLatencyMs ?? promptRoute.p95LatencyMs;
  const promptTimeoutClusterDetected =
    promptRoute.timeoutCount >= Math.max(1, Math.min(2, resolveTimeoutCountThreshold())) ||
    promptRoute.pipelineTimeoutCount > 0 ||
    promptRoute.providerTimeoutCount > 0;
  const promptLatencyClusterDetected =
    promptRoute.requestCount >= 2 &&
    (
      promptRouteMaxLatencyMs >= resolveMaxLatencyThresholdMs() ||
      promptRoute.p95LatencyMs >= resolveLatencyP95ThresholdMs() ||
      ((promptRoute.slowRequestCount ?? 0) >= 2 && promptRoute.avgLatencyMs >= resolveAverageLatencyThresholdMs())
    );
  const promptErrorClusterDetected = promptRoute.errorCount >= 2;
  const meaningfulPromptTraffic = promptRoute.requestCount >= 3 && requestShare >= PROMPT_ROUTE_SIGNIFICANT_SHARE;
  const severePromptMinorityIncident =
    promptRoute.requestCount >= 2 && (promptTimeoutClusterDetected || promptRouteMaxLatencyMs >= resolveMaxLatencyThresholdMs());

  if (!meaningfulPromptTraffic && !severePromptMinorityIncident) {
    return null;
  }

  if (!promptTimeoutClusterDetected && !promptLatencyClusterDetected && !promptErrorClusterDetected) {
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
      const promptMitigationUpdatedAt =
        promptRouteMitigation.updatedAt ?? promptRouteMitigation.activatedAt;
      if (promptMitigationUpdatedAt) {
        const promptMitigationAgeMs = Date.now() - Date.parse(promptMitigationUpdatedAt);
        const promptMitigationHoldoffMs = Math.max(30_000, resolveVerificationDelayMs());
        if (promptMitigationAgeMs < promptMitigationHoldoffMs) {
          return null;
        }
      }

      return {
        kind: 'activate_prompt_route_degraded_mode',
        actionKey: 'activate_prompt_route_degraded_mode',
        cooldownKey: 'activate_prompt_route_degraded_mode',
        cooldownMs: resolveActionCooldownMs() * 2
      };
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
      pipelineTimeoutCount: promptRouteCandidate.pipelineTimeoutCount,
      providerTimeoutCount: promptRouteCandidate.providerTimeoutCount,
      budgetAbortCount: promptRouteCandidate.budgetAbortCount,
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
  const promptRouteCandidate = getPromptRouteCandidate(requestWindow);
  const promptRouteStability = assessPromptRouteMitigationStability(requestWindow);
  const runtimeInactive =
    observation.workerRuntime.enabled &&
    (!observation.workerRuntime.started || observation.workerRuntime.activeListeners === 0);
  const minRequestCount = resolveMinRequestCount();
  const latencyBurstDetected = detectBurstingLatency(requestWindow, minRequestCount);
  const promptRouteTimeoutClusterDetected =
    promptRouteCandidate !== null &&
    (
      promptRouteCandidate.timeoutCount >= Math.max(1, Math.min(2, resolveTimeoutCountThreshold())) ||
      promptRouteCandidate.pipelineTimeoutCount > 0 ||
      promptRouteCandidate.providerTimeoutCount > 0
    );
  const promptRouteLatencySpikeDetected =
    promptRouteCandidate !== null &&
    (
      (promptRouteCandidate.maxLatencyMs ?? promptRouteCandidate.p95LatencyMs) >= resolveMaxLatencyThresholdMs() ||
      promptRouteCandidate.p95LatencyMs >= resolveLatencyP95ThresholdMs() ||
      (
        (promptRouteCandidate.slowRequestCount ?? 0) >= 2 &&
        promptRouteCandidate.avgLatencyMs >= resolveAverageLatencyThresholdMs()
      )
    );
  const providerFailureCount = telemetrySignals.openaiFailureCount + telemetrySignals.resilienceFailureCount;
  const providerClusterDetected =
    String(observation.openaiHealth.circuitBreaker.state).toUpperCase() !== 'CLOSED' ||
    providerFailureCount >= resolveProviderFailureThreshold() ||
    telemetrySignals.fallbackDegradedCount >= 2;
  const pipelineTimeoutClusterDetected =
    (
      requestWindow.requestCount >= Math.max(4, Math.floor(minRequestCount / 3)) &&
      (requestWindow.pipelineTimeoutCount ?? 0) >= Math.max(2, Math.floor(resolveTimeoutCountThreshold() / 2))
    ) ||
    (promptRouteCandidate !== null && promptRouteCandidate.pipelineTimeoutCount > 0);
  // Timeout storms should capture repeated timeout-class failures plus either long-tail latency or
  // server-side breakage, so a burst of 5-13s requests does not slip through on average latency alone.
  const timeoutStormDetected =
    (
      requestWindow.requestCount >= Math.max(6, Math.floor(minRequestCount / 2)) &&
      (requestWindow.timeoutCount >= resolveTimeoutCountThreshold() ||
        requestWindow.timeoutRate >= resolveTimeoutRateThreshold()) &&
      (
        requestWindow.p95LatencyMs >= resolveLatencyP95ThresholdMs() ||
        requestWindow.maxLatencyMs >= resolveMaxLatencyThresholdMs() ||
        requestWindow.serverErrorCount >= 2
      )
    ) ||
    promptRouteTimeoutClusterDetected;
  // Latency spikes should catch both sustained degradation and bursty outliers that keep the rolling
  // average deceptively low while operators still experience multi-second stalls.
  const latencySpikeDetected =
    (
      requestWindow.requestCount >= minRequestCount &&
      requestWindow.p95LatencyMs >= resolveLatencyP95ThresholdMs() &&
      requestWindow.avgLatencyMs >= resolveAverageLatencyThresholdMs() &&
      requestWindow.slowRequestCount >= Math.max(4, Math.floor(minRequestCount / 3))
    ) ||
    latencyBurstDetected ||
    promptRouteLatencySpikeDetected;
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

function snapshotDiagnosisAttempts(runtime: SelfHealingLoopRuntime): Record<string, number> {
  const attempts: Record<string, number> = {};
  const nowMs = Date.now();

  for (const [key, value] of runtime.diagnosisAttempts.entries()) {
    if (nowMs - value.windowStartedAtMs >= resolveIncidentWindowMs()) {
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

function snapshotCooldowns(runtime: SelfHealingLoopRuntime): Record<string, string> {
  const result: Record<string, string> = {};
  const nowMs = Date.now();

  const registerEntries = (prefix: string, cooldowns: Map<string, number>) => {
    for (const [key, expiresAtMs] of cooldowns.entries()) {
      if (expiresAtMs <= nowMs) {
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

function snapshotIneffectiveActions(runtime: SelfHealingLoopRuntime): Record<string, string> {
  const nowMs = Date.now();
  const result: Record<string, string> = {};
  for (const [key, expiresAtMs] of runtime.ineffectiveActionCooldowns.entries()) {
    if (expiresAtMs <= nowMs) {
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
    recordSelfHealEvent({
      kind: 'noop',
      source: 'self_heal_loop',
      trigger: 'verification',
      reason: 'awaiting prompt-route samples before verification',
      actionTaken: pending.action,
      healedComponent: inferSelfHealComponentFromAction(pending.action),
      details: {
        observedSamples: verificationSnapshot.promptRoute?.requestCount ?? 0,
        requiredSamples: resolvePromptRouteVerificationMinRequests()
      }
    });
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
    recordSelfHealEvent({
      kind: 'success',
      source: 'self_heal_loop',
      trigger: 'verification',
      reason: verificationResult.summary,
      actionTaken: pending.action,
      healedComponent: inferSelfHealComponentFromAction(pending.action),
      details: {
        diagnosis: pending.diagnosisSummary,
        verifiedAt: verificationResult.verifiedAt
      }
    });
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
  runtime.status.activePromptMitigation = getActivePromptRouteMitigation();
  runtime.status.lastPromptMitigationReason = getPromptRouteMitigationState().reason;
  runtime.status.activeMitigation = getActiveAutomatedMitigation(getTrinitySelfHealingStatus());
  recordSelfHealEvent({
    kind: 'failure',
    source: 'self_heal_loop',
    trigger: 'verification',
    reason: verificationResult.summary,
    actionTaken: pending.action,
    healedComponent: inferSelfHealComponentFromAction(pending.action),
    details: {
      diagnosis: pending.diagnosisSummary,
      followUpAction,
      outcome: verificationResult.outcome
    }
  });
  console.log(`[SELF-HEAL] action ${followUpAction}`);

  return {
    verificationResult,
    followUpAction
  };
}

async function executeActionPlan(
  runtime: SelfHealingLoopRuntime,
  diagnosis: SelfHealingDiagnosis,
  observation: SelfHealingObservation,
  trigger: 'startup' | 'interval' | 'manual'
): Promise<SelfHealingActionExecution> {
  if (runtime.pendingVerification) {
    console.log('[SELF-HEAL] action skipped reason=pending-verification');
    recordSelfHealEvent({
      kind: 'noop',
      source: 'self_heal_loop',
      trigger: 'action',
      reason: 'pending verification for a previous self-heal action',
      actionTaken: runtime.status.lastAction,
      healedComponent: inferSelfHealComponentFromAction(runtime.status.lastAction)
    });
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
  const actionTarget = getSelfHealingActionTarget(actionPlan);

  const actionTrackingKey = resolveActionTrackingKey(actionPlan);
  const ineffectiveKey = `${diagnosis.type}:${actionTrackingKey}`;
  if (!canAttemptDiagnosis(runtime, diagnosis.type)) {
    console.log(`[SELF-HEAL] action skipped diagnosis=${diagnosis.type} reason=attempt-budget`);
    recordSelfHealEvent({
      kind: 'noop',
      source: 'self_heal_loop',
      trigger: 'action',
      reason: `${diagnosis.summary} (attempt budget exhausted)`,
      actionTaken: actionTrackingKey,
      healedComponent: actionTarget
    });
    return {
      executed: false,
      action: null,
      pendingVerification: null
    };
  }

  if (isCooldownActive(runtime.actionCooldowns, actionPlan.cooldownKey)) {
    console.log(`[SELF-HEAL] action skipped diagnosis=${diagnosis.type} reason=cooldown`);
    recordSelfHealEvent({
      kind: 'noop',
      source: 'self_heal_loop',
      trigger: 'action',
      reason: `${diagnosis.summary} (action cooldown active)`,
      actionTaken: actionTrackingKey,
      healedComponent: actionTarget
    });
    return {
      executed: false,
      action: null,
      pendingVerification: null
    };
  }

  if (isCooldownActive(runtime.ineffectiveActionCooldowns, ineffectiveKey)) {
    console.log(`[SELF-HEAL] action skipped diagnosis=${diagnosis.type} reason=recently-ineffective`);
    recordSelfHealEvent({
      kind: 'noop',
      source: 'self_heal_loop',
      trigger: 'action',
      reason: `${diagnosis.summary} (recently ineffective)`,
      actionTaken: actionTrackingKey,
      healedComponent: actionTarget
    });
    return {
      executed: false,
      action: null,
      pendingVerification: null
    };
  }

  if (diagnosis.confidence < 0.7) {
    console.log(`[SELF-HEAL] action skipped diagnosis=${diagnosis.type} reason=low-confidence`);
    recordSelfHealEvent({
      kind: 'noop',
      source: 'self_heal_loop',
      trigger: 'action',
      reason: `${diagnosis.summary} (confidence below execution threshold)`,
      actionTaken: actionTrackingKey,
      healedComponent: actionTarget,
      details: {
        confidence: diagnosis.confidence
      }
    });
    return {
      executed: false,
      action: null,
      pendingVerification: null
    };
  }

  try {
    recordSelfHealEvent({
      kind: 'attempt',
      source: 'self_heal_loop',
      trigger: 'action',
      reason: diagnosis.summary,
      actionTaken: actionTrackingKey,
      healedComponent: actionTarget,
      details: diagnosis.evidence
    });

    if (actionPlan.kind === 'recover_stale_jobs') {
      recordActionDispatchAttempt({
        runtime,
        trigger,
        diagnosis,
        action: actionTrackingKey,
        target: actionTarget
      });
      const settings = getWorkerAutonomySettings();
      const recoverResult = await recoverStaleJobs({
        staleAfterMs: settings.staleAfterMs,
        maxRetries: settings.defaultMaxRetries
      });
      const action = `recoverStaleJobs:recovered=${recoverResult.recoveredJobs.length}:failed=${recoverResult.failedJobs.length}`;
      recordActionDispatchResult({
        runtime,
        diagnosis,
        action,
        target: actionTarget,
        outcome: 'success',
        message: `Recovered ${recoverResult.recoveredJobs.length} stale jobs; failed ${recoverResult.failedJobs.length}.`
      });
      recordCooldown(runtime.actionCooldowns, actionPlan.cooldownKey, actionPlan.cooldownMs);
      recordDiagnosisAttempt(runtime, diagnosis.type);
      recordActionExecuted({
        trigger,
        diagnosis,
        action,
        target: actionTarget,
        executionSource: 'self_heal_execute_action',
        details: {
          recoveredJobs: recoverResult.recoveredJobs.length,
          failedJobs: recoverResult.failedJobs.length
        }
      });
      recordSelfHealEvent({
        kind: 'success',
        source: 'self_heal_loop',
        trigger: 'action',
        reason: diagnosis.summary,
        actionTaken: action,
        healedComponent: actionTarget,
        details: {
          failedJobs: recoverResult.failedJobs.length,
          recoveredJobs: recoverResult.recoveredJobs.length
        }
      });
      recordHealResult({
        runtime,
        diagnosis,
        action,
        target: actionTarget,
        outcome: 'success',
        message: `Recovered ${recoverResult.recoveredJobs.length} stale jobs; failed ${recoverResult.failedJobs.length}.`
      });
      console.log(`[SELF-HEAL] action ${action}`);
      return {
        executed: true,
        action,
        pendingVerification: beginVerification(diagnosis, 'recoverStaleJobs', observation)
      };
    }

    if (actionPlan.kind === 'heal_worker_runtime') {
      const actuator = buildWorkerRepairActuatorStatus();
      recordActionDispatchAttempt({
        runtime,
        trigger,
        diagnosis,
        action: actionTrackingKey,
        target: actionTarget,
        actuatorMode: actuator.mode,
        baseUrl: actuator.baseUrl,
        path: actuator.path
      });
      logger.info('self_heal.repair.execution', {
        module: 'self_heal.loop',
        source: 'self_heal_loop',
        action: actionTrackingKey,
        diagnosis: diagnosis.type,
        actuatorMode: actuator.mode,
        actuatorPath: actuator.path,
        actuatorBaseUrl: actuator.baseUrl
      });
      const healResult = await executeWorkerRepairActuator({
        force: true,
        source: 'self_heal_loop'
      });
      const action = `healWorkerRuntime:${healResult.mode}`;
      recordWorkerReceipt({
        runtime,
        diagnosis,
        action,
        target: actionTarget,
        actuatorMode: healResult.mode,
        statusCode: healResult.statusCode,
        message: healResult.message
      });
      recordActionDispatchResult({
        runtime,
        diagnosis,
        action,
        target: actionTarget,
        outcome: 'success',
        actuatorMode: healResult.mode,
        baseUrl: healResult.baseUrl,
        path: healResult.path,
        statusCode: healResult.statusCode,
        message: healResult.message
      });
      recordCooldown(runtime.actionCooldowns, actionPlan.cooldownKey, actionPlan.cooldownMs);
      recordDiagnosisAttempt(runtime, diagnosis.type);
      recordActionExecuted({
        trigger,
        diagnosis,
        action,
        target: actionTarget,
        executionSource: 'self_heal_execute_action',
        details: {
          actuatorMode: healResult.mode,
          actuatorPath: healResult.path,
          actuatorBaseUrl: healResult.baseUrl,
          statusCode: healResult.statusCode
        }
      });
      recordSelfHealEvent({
        kind: 'success',
        source: 'self_heal_loop',
        trigger: 'action',
        reason: diagnosis.summary,
        actionTaken: action,
        healedComponent: actionTarget,
        details: {
          actuatorMode: healResult.mode,
          actuatorPath: healResult.path,
          actuatorBaseUrl: healResult.baseUrl,
          statusCode: healResult.statusCode,
          message: healResult.message,
          payload: healResult.payload
        }
      });
      recordHealResult({
        runtime,
        diagnosis,
        action,
        target: actionTarget,
        outcome: 'success',
        message: healResult.message
      });
      logger.info('self_heal.repair.result', {
        module: 'self_heal.loop',
        source: 'self_heal_loop',
        action,
        diagnosis: diagnosis.type,
        actuatorMode: healResult.mode,
        actuatorPath: healResult.path,
        actuatorBaseUrl: healResult.baseUrl,
        statusCode: healResult.statusCode,
        message: healResult.message
      });
      console.log(`[SELF-HEAL] action ${action}`);
      return {
        executed: true,
        action,
        pendingVerification: beginVerification(diagnosis, 'healWorkerRuntime', observation)
      };
    }

    if (actionPlan.kind === 'activate_trinity_degraded_mode') {
      recordActionDispatchAttempt({
        runtime,
        trigger,
        diagnosis,
        action: actionTrackingKey,
        target: actionTarget
      });
      const mitigationResult = activateTrinitySelfHealingMitigation({
        stage: actionPlan.stage,
        action: actionPlan.trinityAction,
        reason: diagnosis.summary
      });

      if (!mitigationResult.applied) {
        console.log(
          `[SELF-HEAL] action skipped diagnosis=${diagnosis.type} reason=${mitigationResult.reason}`
        );
        recordSelfHealEvent({
          kind: 'noop',
          source: 'self_heal_loop',
          trigger: 'action',
          reason: `${diagnosis.summary} (${mitigationResult.reason})`,
          actionTaken: actionTrackingKey,
          healedComponent: actionTarget
        });
        recordActionDispatchResult({
          runtime,
          diagnosis,
          action: actionTrackingKey,
          target: actionTarget,
          outcome: 'skipped',
          message: mitigationResult.reason
        });
        recordHealResult({
          runtime,
          diagnosis,
          action: actionTrackingKey,
          target: actionTarget,
          outcome: 'noop',
          message: mitigationResult.reason
        });
        return {
          executed: false,
          action: null,
          pendingVerification: null
        };
      }

      const action = `activateTrinityMitigation:${actionPlan.stage}:${actionPlan.trinityAction}`;
      recordActionDispatchResult({
        runtime,
        diagnosis,
        action,
        target: actionTarget,
        outcome: 'success',
        message: mitigationResult.reason
      });
      recordCooldown(runtime.actionCooldowns, actionPlan.cooldownKey, actionPlan.cooldownMs);
      recordDiagnosisAttempt(runtime, diagnosis.type);
      recordActionExecuted({
        trigger,
        diagnosis,
        action,
        target: actionTarget,
        executionSource: 'self_heal_execute_action',
        details: {
          mitigationReason: mitigationResult.reason
        }
      });
      recordSelfHealEvent({
        kind: 'success',
        source: 'self_heal_loop',
        trigger: 'action',
        reason: diagnosis.summary,
        actionTaken: action,
        healedComponent: actionTarget,
        details: {
          mitigationReason: mitigationResult.reason
        }
      });
      recordHealResult({
        runtime,
        diagnosis,
        action,
        target: actionTarget,
        outcome: 'success',
        message: mitigationResult.reason
      });
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
      recordActionDispatchAttempt({
        runtime,
        trigger,
        diagnosis,
        action: actionTrackingKey,
        target: actionTarget
      });
      const defaultTokenLimit = Math.max(64, Math.min(256, observation.openaiHealth.defaults?.maxTokens ?? 256));
      const mitigationResult = activatePromptRouteReducedLatencyMode(diagnosis.summary, defaultTokenLimit);
      if (!mitigationResult.applied) {
        console.log(`[SELF-HEAL] action skipped diagnosis=${diagnosis.type} reason=${mitigationResult.reason}`);
        recordSelfHealEvent({
          kind: 'noop',
          source: 'self_heal_loop',
          trigger: 'action',
          reason: `${diagnosis.summary} (${mitigationResult.reason})`,
          actionTaken: actionTrackingKey,
          healedComponent: actionTarget
        });
        recordActionDispatchResult({
          runtime,
          diagnosis,
          action: actionTrackingKey,
          target: actionTarget,
          outcome: 'skipped',
          message: mitigationResult.reason
        });
        recordHealResult({
          runtime,
          diagnosis,
          action: actionTrackingKey,
          target: actionTarget,
          outcome: 'noop',
          message: mitigationResult.reason
        });
        return {
          executed: false,
          action: null,
          pendingVerification: null
        };
      }

      const action = actionTrackingKey;
      recordActionDispatchResult({
        runtime,
        diagnosis,
        action,
        target: actionTarget,
        outcome: 'success',
        message: mitigationResult.reason
      });
      recordCooldown(runtime.actionCooldowns, actionPlan.cooldownKey, actionPlan.cooldownMs);
      recordDiagnosisAttempt(runtime, diagnosis.type);
      recordActionExecuted({
        trigger,
        diagnosis,
        action,
        target: actionTarget,
        executionSource: 'self_heal_execute_action',
        details: {
          mitigationReason: mitigationResult.reason
        }
      });
      recordSelfHealEvent({
        kind: 'success',
        source: 'self_heal_loop',
        trigger: 'action',
        reason: diagnosis.summary,
        actionTaken: action,
        healedComponent: actionTarget,
        details: {
          mitigationReason: mitigationResult.reason
        }
      });
      recordHealResult({
        runtime,
        diagnosis,
        action,
        target: actionTarget,
        outcome: 'success',
        message: mitigationResult.reason
      });
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
      recordActionDispatchAttempt({
        runtime,
        trigger,
        diagnosis,
        action: actionTrackingKey,
        target: actionTarget
      });
      const mitigationResult = activatePromptRouteDegradedMode(diagnosis.summary);
      if (!mitigationResult.applied) {
        console.log(`[SELF-HEAL] action skipped diagnosis=${diagnosis.type} reason=${mitigationResult.reason}`);
        recordSelfHealEvent({
          kind: 'noop',
          source: 'self_heal_loop',
          trigger: 'action',
          reason: `${diagnosis.summary} (${mitigationResult.reason})`,
          actionTaken: actionTrackingKey,
          healedComponent: actionTarget
        });
        recordActionDispatchResult({
          runtime,
          diagnosis,
          action: actionTrackingKey,
          target: actionTarget,
          outcome: 'skipped',
          message: mitigationResult.reason
        });
        recordHealResult({
          runtime,
          diagnosis,
          action: actionTrackingKey,
          target: actionTarget,
          outcome: 'noop',
          message: mitigationResult.reason
        });
        return {
          executed: false,
          action: null,
          pendingVerification: null
        };
      }

      const action = actionTrackingKey;
      recordActionDispatchResult({
        runtime,
        diagnosis,
        action,
        target: actionTarget,
        outcome: 'success',
        message: mitigationResult.reason
      });
      recordCooldown(runtime.actionCooldowns, actionPlan.cooldownKey, actionPlan.cooldownMs);
      recordDiagnosisAttempt(runtime, diagnosis.type);
      recordActionExecuted({
        trigger,
        diagnosis,
        action,
        target: actionTarget,
        executionSource: 'self_heal_execute_action',
        details: {
          mitigationReason: mitigationResult.reason
        }
      });
      recordSelfHealEvent({
        kind: 'success',
        source: 'self_heal_loop',
        trigger: 'action',
        reason: diagnosis.summary,
        actionTaken: action,
        healedComponent: actionTarget,
        details: {
          mitigationReason: mitigationResult.reason
        }
      });
      recordHealResult({
        runtime,
        diagnosis,
        action,
        target: actionTarget,
        outcome: 'success',
        message: mitigationResult.reason
      });
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
    recordActionDispatchResult({
      runtime,
      diagnosis,
      action: actionTrackingKey,
      target: actionTarget,
      outcome: 'failure',
      message: runtime.status.lastError
    });
    recordSelfHealEvent({
      kind: 'failure',
      source: 'self_heal_loop',
      trigger: 'action',
      reason: runtime.status.lastError,
      actionTaken: actionTrackingKey,
      healedComponent: actionTarget
    });
    recordHealResult({
      runtime,
      diagnosis,
      action: actionTrackingKey,
      target: actionTarget,
      outcome: 'failure',
      message: runtime.status.lastError
    });
    console.error(`[SELF-HEAL] action error ${runtime.status.lastError}`);
  }

  return {
    executed: false,
    action: null,
    pendingVerification: null
  };
}

async function executeAction(
  runtime: SelfHealingLoopRuntime,
  diagnosis: SelfHealingDiagnosis,
  observation: SelfHealingObservation,
  trigger: 'startup' | 'interval' | 'manual'
): Promise<SelfHealingActionExecution> {
  return executeActionPlan(runtime, diagnosis, observation, trigger);
}

export function getSelfHealingLoopStatus(): SelfHealingLoopStatus {
  const runtime = getRuntime();
  const trinityStatus = getTrinitySelfHealingStatus();
  const promptRouteMitigationState = getPromptRouteMitigationState();
  const snapshot: SelfHealingLoopStatus = {
    ...runtime.status,
    active: runtime.timer !== null,
    loopRunning: runtime.timer !== null,
    inFlight: runtime.inFlight,
    intervalMs: runtime.timer === null ? resolveLoopIntervalMs() : runtime.status.intervalMs,
    lastTrinityMitigation: getActiveTrinityMitigation(trinityStatus),
    activePromptMitigation: getActivePromptRouteMitigation(),
    lastPromptMitigationReason: promptRouteMitigationState.reason,
    activeMitigation: getActiveAutomatedMitigation(trinityStatus),
    outerRouteTimeoutMs: resolveGptRouteHardTimeoutMs(),
    abortPropagationCoverage: [...PROMPT_ROUTE_ABORT_PROPAGATION_COVERAGE],
    attemptsByDiagnosis: snapshotDiagnosisAttempts(runtime),
    cooldowns: snapshotCooldowns(runtime),
    ineffectiveActions: snapshotIneffectiveActions(runtime),
    bypassedSubsystems: [...new Set([...runtime.status.bypassedSubsystems, ...getActiveBypassedSubsystems()])].sort()
  };

  return {
    ...snapshot,
    abortPropagationCoverage: [...snapshot.abortPropagationCoverage],
    bypassedSubsystems: [...snapshot.bypassedSubsystems],
    ineffectiveActions: { ...snapshot.ineffectiveActions },
    attemptsByDiagnosis: { ...snapshot.attemptsByDiagnosis },
    cooldowns: { ...snapshot.cooldowns },
    lastAIDiagnosis: snapshot.lastAIDiagnosis ? { ...snapshot.lastAIDiagnosis } : null,
    lastEvidence: snapshot.lastEvidence ? { ...snapshot.lastEvidence } : null,
    lastDispatchAttempt: snapshot.lastDispatchAttempt ? { ...snapshot.lastDispatchAttempt } : null,
    lastDispatchTarget: snapshot.lastDispatchTarget ? { ...snapshot.lastDispatchTarget } : null,
    lastWorkerReceipt: snapshot.lastWorkerReceipt ? { ...snapshot.lastWorkerReceipt } : null,
    lastHealResult: snapshot.lastHealResult ? { ...snapshot.lastHealResult } : null,
    timeline: { ...snapshot.timeline },
    lastLatencySnapshot: snapshot.lastLatencySnapshot
      ? {
          ...snapshot.lastLatencySnapshot,
          promptRoute: snapshot.lastLatencySnapshot.promptRoute
            ? { ...snapshot.lastLatencySnapshot.promptRoute }
            : null
        }
      : null,
    recentTimeoutCounts: snapshot.recentTimeoutCounts ? { ...snapshot.recentTimeoutCounts } : null,
    recentPipelineTimeoutCounts: snapshot.recentPipelineTimeoutCounts
      ? { ...snapshot.recentPipelineTimeoutCounts }
      : null,
    lastVerificationResult: snapshot.lastVerificationResult
      ? {
          ...snapshot.lastVerificationResult,
          baseline: { ...snapshot.lastVerificationResult.baseline },
          current: { ...snapshot.lastVerificationResult.current }
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
    if (trigger === 'manual') {
      recordSelfHealEvent({
        kind: 'noop',
        source: 'self_heal_loop',
        trigger,
        reason: 'manual self-heal tick skipped because another loop iteration is still running',
        actionTaken: runtime.status.lastAction,
        healedComponent: inferSelfHealComponentFromAction(runtime.status.lastAction)
      });
    }
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
    recordLoopTick({
      runtime,
      trigger,
      tickAt
    });

    console.log(`[SELF-HEAL] tick ${tickAt} trigger=${trigger} tickCount=${runtime.status.tickCount}`);

    const observation = await observeSelfHealingRuntime();
    const verification = maybeVerifyPendingAction(runtime, observation);

    const diagnosis = diagnoseSelfHealingRuntime(options, observation);
    runtime.status.lastDiagnosis = diagnosis.summary;
    runtime.status.lastEvidence = diagnosis.evidence;
    runtime.status.lastWorkerHealth = diagnosis.workerHealthLabel;
    runtime.status.lastTrinityMitigation = diagnosis.trinityMitigation;
    runtime.status.activePromptMitigation = getActivePromptRouteMitigation();
    runtime.status.lastPromptMitigationReason = getPromptRouteMitigationState().reason;
    runtime.status.activeMitigation = getActiveAutomatedMitigation(observation.trinityStatus);
    runtime.status.degradedModeReason = observation.requestWindow.degradedReasons?.[0] ?? null;
    runtime.status.lastLatencySnapshot = buildLatencySnapshot(observation.requestWindow);
    runtime.status.recentTimeoutCounts = buildRecentTimeoutCounts(observation.requestWindow);
    runtime.status.recentPipelineTimeoutCounts = buildRecentPipelineTimeoutCounts(observation.requestWindow);
    runtime.status.recentPromptRouteTimeouts = getPromptRouteWindowSnapshot(observation.requestWindow)?.timeoutCount ?? null;
    runtime.status.recentPromptRouteLatencyP95 = getPromptRouteWindowSnapshot(observation.requestWindow)?.p95LatencyMs ?? null;
    runtime.status.recentPromptRouteMaxLatency =
      getPromptRouteWindowSnapshot(observation.requestWindow)?.maxLatencyMs ??
      getPromptRouteWindowSnapshot(observation.requestWindow)?.p95LatencyMs ??
      null;
    runtime.status.outerRouteTimeoutMs = resolveGptRouteHardTimeoutMs();
    runtime.status.abortPropagationCoverage = [...PROMPT_ROUTE_ABORT_PROPAGATION_COVERAGE];
    runtime.status.bypassedSubsystems = combineBypassedSubsystems(observation.requestWindow);
    recordMetricsCollected({
      runtime,
      trigger,
      diagnosis,
      observation
    });
    const aiDiagnosisResult = await aiDiagnoseAndDecide({
      runtime,
      trigger,
      diagnosis,
      observation
    });
    recordControllerDecision({
      runtime,
      trigger,
      diagnosis,
      aiDiagnosis: aiDiagnosisResult.diagnosis
    });
    const predictiveResult = aiDiagnosisResult.predictiveResult;
    if (predictiveResult && predictiveResult.decision.action !== 'none') {
      runtime.status.lastEvidence = {
        ...(runtime.status.lastEvidence ?? {}),
        predictive: {
          action: predictiveResult.decision.action,
          confidence: predictiveResult.decision.confidence,
          matchedRule: predictiveResult.decision.matchedRule,
          executionStatus: predictiveResult.execution.status
        }
      };
    }
    if (predictiveResult?.execution.status === 'failed' && !runtime.status.lastError) {
      runtime.status.lastError = predictiveResult.execution.message;
    }

    if (diagnosis.type === 'healthy' || diagnosis.type === 'prompt_route_stabilized') {
      runtime.status.lastHealthyObservedAt = tickAt;
    }

    if (trigger === 'manual' || diagnosis.actionPlan !== null || diagnosis.controllerInput !== null) {
      recordSelfHealEvent({
        kind: 'trigger',
        source: 'self_heal_loop',
        trigger,
        reason: diagnosis.summary,
        healedComponent: diagnosis.actionPlan ? getSelfHealingActionTarget(diagnosis.actionPlan) : null,
        details: diagnosis.evidence
      });
    }

    console.log(`[SELF-HEAL] diagnosis ${diagnosis.summary}`);

    let action: string | null = verification.followUpAction;
    if (!action && predictiveResult?.execution.status === 'executed') {
      action = predictiveResult.decision.action;
      recordActionDispatchResult({
        runtime,
        diagnosis,
        action,
        target: predictiveResult.decision.target,
        outcome: 'success',
        message: predictiveResult.execution.message
      });
      runtime.status.lastAction = action;
      runtime.status.lastActionAt = new Date().toISOString();
      recordActionExecuted({
        trigger,
        diagnosis,
        action,
        target: predictiveResult.decision.target,
        executionSource: 'predictive_auto_execute',
        details: {
          advisor: aiDiagnosisResult.diagnosis.advisor,
          executionStatus: predictiveResult.execution.status,
          message: predictiveResult.execution.message
        }
      });
      recordHealResult({
        runtime,
        diagnosis,
        action,
        target: predictiveResult.decision.target,
        outcome: 'success',
        message: predictiveResult.execution.message
      });
    }
    if (
      !action &&
      verification.verificationResult === null &&
      aiDiagnosisResult.diagnosis.decision === 'heal'
    ) {
      // AI approval is the final execution gate; deterministic fallback sets this to heal when AI is unavailable.
      const actionResult = await executeAction(runtime, diagnosis, observation, trigger);
      if (actionResult.executed && actionResult.action) {
        action = actionResult.action;
        runtime.status.lastAction = action;
        runtime.status.lastActionAt = new Date().toISOString();
        runtime.pendingVerification = actionResult.pendingVerification;
      }
    }

    runtime.status.lastTrinityMitigation = getActiveTrinityMitigation(getTrinitySelfHealingStatus());
    runtime.status.activePromptMitigation = getActivePromptRouteMitigation();
    runtime.status.lastPromptMitigationReason = getPromptRouteMitigationState().reason;
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
        recordSelfHealEvent({
          kind: 'noop',
          source: 'self_heal_loop',
          trigger: 'controller',
          reason: `${diagnosis.summary} (controller cooldown active)`,
          actionTaken: 'runSelfImproveCycle',
          healedComponent: diagnosis.controllerInput.component ?? null
        });
      } else {
        try {
          const decision = await runSelfImproveCycle(diagnosis.controllerInput);
          controllerDecision = decision.decision;
          runtime.status.lastControllerDecision = decision.decision;
          runtime.status.lastControllerRunAt = new Date().toISOString();
          recordCooldown(runtime.controllerCooldowns, controllerKey, resolveControllerCooldownMs());
          logger.info('self_heal.controller.decision', {
            module: 'self_heal.loop',
            source: 'self_heal_loop',
            incidentKey: controllerKey,
            decision: decision.decision,
            decisionId: decision.id,
            component: diagnosis.controllerInput.component ?? null
          });
          console.log(`[SELF-HEAL] controller decision=${decision.decision} id=${decision.id}`);
        } catch (error) {
          controllerDecision = 'ERROR';
          runtime.status.lastControllerDecision = 'ERROR';
          runtime.status.lastControllerRunAt = new Date().toISOString();
          runtime.status.lastError = resolveErrorMessage(error);
          logger.error('self_heal.controller.decision', {
            module: 'self_heal.loop',
            source: 'self_heal_loop',
            incidentKey: controllerKey,
            decision: 'ERROR',
            component: diagnosis.controllerInput.component ?? null,
            error: runtime.status.lastError
          });
          recordSelfHealEvent({
            kind: 'failure',
            source: 'self_heal_loop',
            trigger: 'controller',
            reason: runtime.status.lastError,
            actionTaken: 'runSelfImproveCycle',
            healedComponent: diagnosis.controllerInput.component ?? null
          });
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
  runtime.debugForcedHealConsumed = false;
  runtime.status = createInitialStatus();
  resetPromptRouteMitigationStateForTests();
  resetSelfHealTelemetryForTests();
}
