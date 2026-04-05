import { z } from 'zod';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import {
  getWorkerRuntimeStatus,
  recycleWorker,
  scaleWorkersUp,
  type WorkerRecycleResult,
  type WorkerRuntimeStatus,
  type WorkerScaleUpResult
} from '@platform/runtime/workerConfig.js';
import { getConfig } from '@platform/runtime/unifiedConfig.js';
import { logger } from '@platform/logging/structuredLogging.js';
import {
  activatePromptRouteDegradedMode,
  activatePromptRouteReducedLatencyMode,
  getPromptRouteMitigationState,
  type PromptRouteMitigationMode,
  type PromptRouteMitigationState
} from '@services/openai/promptRouteMitigation.js';
import { runtimeDiagnosticsService, type RequestWindowSnapshot } from '@services/runtimeDiagnosticsService.js';
import {
  activateTrinitySelfHealingMitigation,
  getTrinitySelfHealingStatus,
  type TrinitySelfHealingAction,
  type TrinitySelfHealingMitigationCommandResult,
  type TrinitySelfHealingStage
} from '@services/selfImprove/selfHealingV2.js';
import {
  getWorkerControlHealth,
  type WorkerControlHealthResponse
} from '@services/workerControlService.js';
import { getEnvNumber } from '@platform/runtime/env.js';
import { runArcanosCoreQuery } from '@services/arcanos-core.js';
import { getOpenAIClientOrAdapter } from '@services/openai/clientBridge.js';
import { createSingleChatCompletion, getFallbackModel } from '@services/openai.js';
import {
  getOpenAIServiceHealth,
  reinitializeOpenAIProvider
} from '@services/openai/serviceHealth.js';
import { resolvePredictiveHealingLoopIntervalMs } from './runtimeConfig.js';
import { recordSelfHealEvent } from './selfHealTelemetry.js';
import {
  buildWorkerRepairActuatorStatus,
  executeWorkerRepairActuator,
  type WorkerRepairActuatorStatus
} from './workerRepairActuator.js';

export type PredictiveHealingActionType =
  | 'none'
  | 'reinitialize_ai_provider'
  | 'scale_workers_up'
  | 'recycle_worker'
  | 'recycle_worker_runtime'
  | 'heal_worker_runtime'
  | 'activate_trinity_mitigation'
  | 'mark_node_degraded'
  | 'shift_traffic_away';

export type PredictiveHealingExecutionStatus =
  | 'skipped'
  | 'dry_run'
  | 'executed'
  | 'cooldown'
  | 'unsupported'
  | 'refused'
  | 'failed';

export type PredictiveHealingAdvisor = 'rules_v1' | 'arcanos_core_v1' | 'rules_fallback_v1';

export interface PredictiveHealingObservation {
  collectedAt: string;
  source: string;
  windowMs: number;
  requestCount: number;
  errorRate: number;
  timeoutRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  maxLatencyMs: number;
  degradedCount: number;
  memory: {
    rssMb: number;
    heapUsedMb: number;
    heapTotalMb: number;
    externalMb: number;
    arrayBuffersMb: number;
  };
  workerHealth: {
    overallStatus: WorkerControlHealthResponse['overallStatus'] | null;
    alertCount: number;
    alerts: string[];
    pending: number;
    running: number;
    delayed: number;
    stalledRunning: number;
    oldestPendingJobAgeMs: number;
    degradedWorkerIds: string[];
    unhealthyWorkerIds: string[];
    workers: Array<{
      workerId: string;
      healthStatus: string;
      currentJobId: string | null;
      lastActivityAt?: string | null;
      lastProcessedJobAt?: string | null;
      inactivityMs?: number | null;
      watchdog?: {
        triggered: boolean;
        reason: string | null;
        restartRecommended: boolean;
        idleThresholdMs: number | null;
      };
    }>;
  };
  inactivity?: {
    inactiveDegraded: boolean;
    reason: string | null;
    idleThresholdMs: number | null;
    maxInactivityMs: number;
    lastActivityAt: string | null;
    lastProcessedJobAt: string | null;
    workerIds: string[];
  };
  workerRuntime: {
    enabled: boolean;
    started: boolean;
    configuredCount: number;
    activeListeners: number;
    maxActiveWorkers: number;
    surgeWorkerCount: number;
    workerIds: string[];
  };
  promptRoute: {
    active: boolean;
    mode: PromptRouteMitigationMode;
    reason: string | null;
  };
  trinity: {
    enabled: boolean;
    activeStage: TrinitySelfHealingStage | null;
    activeAction: TrinitySelfHealingAction | null;
    verified: boolean;
    config: {
      triggerThreshold: number;
      maxAttempts: number;
    };
    stages: Record<
      TrinitySelfHealingStage,
      {
        observationsInWindow: number;
        attempts: number;
        activeAction: TrinitySelfHealingAction | null;
        verified: boolean;
        cooldownUntil: string | null;
        failedActions: TrinitySelfHealingAction[];
      }
    >;
  };
}

export interface PredictiveHealingSimulationInput {
  requestCount?: number;
  errorRate?: number;
  timeoutRate?: number;
  avgLatencyMs?: number;
  p95LatencyMs?: number;
  maxLatencyMs?: number;
  degradedCount?: number;
  memory?: Partial<PredictiveHealingObservation['memory']>;
  workerHealth?: Partial<{
    overallStatus: WorkerControlHealthResponse['overallStatus'] | null;
    alertCount: number;
    alerts: string[];
    pending: number;
    running: number;
    delayed: number;
    stalledRunning: number;
    oldestPendingJobAgeMs: number;
    degradedWorkerIds: string[];
    unhealthyWorkerIds: string[];
    workers: Array<{
      workerId: string;
      healthStatus: string;
      currentJobId: string | null;
      lastActivityAt?: string | null;
      lastProcessedJobAt?: string | null;
      inactivityMs?: number | null;
      watchdog?: {
        triggered?: boolean;
        reason?: string | null;
        restartRecommended?: boolean;
        idleThresholdMs?: number | null;
      };
    }>;
  }>;
  inactivity?: Partial<NonNullable<PredictiveHealingObservation['inactivity']>>;
  workerRuntime?: Partial<PredictiveHealingObservation['workerRuntime']>;
  promptRoute?: Partial<PredictiveHealingObservation['promptRoute']>;
  trinity?: Partial<{
    enabled: boolean;
    activeStage: TrinitySelfHealingStage | null;
    activeAction: TrinitySelfHealingAction | null;
    verified: boolean;
    config: Partial<PredictiveHealingObservation['trinity']['config']>;
    stages: Partial<
      Record<
        TrinitySelfHealingStage,
        Partial<PredictiveHealingObservation['trinity']['stages'][TrinitySelfHealingStage]>
      >
    >;
  }>;
}

export interface PredictiveHealingTrends {
  observationCount: number;
  sampleAgeMs: number;
  dataFresh: boolean;
  latencySlopeMs: number;
  p95LatencySlopeMs: number;
  latencyRiseIntervals: number;
  errorRateSlope: number;
  memoryGrowthMb: number;
  memoryPressureIntervals: number;
  queueDepthVelocity: number;
  workerHealthDegrading: boolean;
  unhealthyWorkerDelta: number;
}

export interface PredictiveHealingDecision {
  advisor: PredictiveHealingAdvisor;
  decidedAt: string;
  action: PredictiveHealingActionType;
  target: string | null;
  reason: string;
  confidence: number;
  matchedRule: string | null;
  safeToExecute: boolean;
  staleData: boolean;
  suggestedMode: 'recommend_only' | 'dry_run' | 'operator_execute' | 'auto_execute';
  details: Record<string, unknown>;
}

export interface PredictiveHealingRecoveryOutcome {
  status: 'pending_observation' | 'unsupported' | 'not_executed' | 'failed';
  summary: string;
}

export interface PredictiveHealingExecutionResult {
  attempted: boolean;
  status: PredictiveHealingExecutionStatus;
  mode: 'recommend_only' | 'dry_run' | 'operator_execute' | 'auto_execute';
  action: PredictiveHealingActionType;
  target: string | null;
  message: string;
  cooldownRemainingMs: number | null;
  actuatorResult: Record<string, unknown> | null;
  recoveryOutcome: PredictiveHealingRecoveryOutcome;
}

export interface PredictiveHealingAuditEntry {
  id: string;
  timestamp: string;
  source: string;
  featureFlags: {
    enabled: boolean;
    dryRun: boolean;
    autoExecute: boolean;
  };
  observation: PredictiveHealingObservation;
  trends: PredictiveHealingTrends;
  decision: PredictiveHealingDecision;
  execution: PredictiveHealingExecutionResult;
}

export interface PredictiveHealingExecutionLogEntry {
  timestamp: string;
  source: string;
  action: PredictiveHealingActionType;
  target: string | null;
  confidence: number;
  matchedRule: string | null;
  mode: PredictiveHealingExecutionResult['mode'];
  result: PredictiveHealingExecutionStatus;
  reason: string;
  outcome: string;
  recoveryStatus: PredictiveHealingRecoveryOutcome['status'];
}

export interface PredictiveHealingAutomationStatus {
  active: boolean;
  autoExecuteReady: boolean;
  pollIntervalMs: number;
  minConfidence: number;
  cooldownMs: number;
  lastLoopDecisionAt: string | null;
  lastLoopAction: PredictiveHealingActionType | null;
  lastLoopResult: PredictiveHealingExecutionStatus | null;
  lastAutoExecutionAt: string | null;
  lastAutoExecutionAction: PredictiveHealingActionType | null;
  lastAutoExecutionResult: PredictiveHealingExecutionStatus | null;
}

export type PredictiveHealingAIProviderFailureCategory =
  | 'missing_client'
  | 'circuit_open'
  | 'insufficient_quota'
  | 'rate_limited'
  | 'authentication'
  | 'network'
  | 'timeout'
  | 'invalid_request'
  | 'provider_error'
  | 'unknown';

export interface PredictiveHealingAIProviderStatusSnapshot {
  configured: boolean;
  clientInitialized: boolean;
  reachable: boolean | null;
  authenticated: boolean | null;
  completionHealthy: boolean | null;
  model: string;
  baseUrl: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
  lastFailureCategory: PredictiveHealingAIProviderFailureCategory | null;
  lastFailureStatus: number | null;
  circuitBreakerState: string;
  circuitBreakerHealthy: boolean;
  circuitBreakerFailures: number;
  circuitBreakerLastOpenedAt: string | null;
  circuitBreakerLastHalfOpenAt: string | null;
  circuitBreakerLastClosedAt: string | null;
  circuitBreakerNextRetryAt: string | null;
}

export interface PredictiveHealingAIProviderProbeSnapshot {
  performedAt: string;
  configured: boolean;
  clientInitialized: boolean;
  reachable: boolean | null;
  authenticated: boolean | null;
  completionHealthy: boolean | null;
  model: string;
  baseUrl: string | null;
  failureReason: string | null;
  failureCategory: PredictiveHealingAIProviderFailureCategory | null;
  failureStatus: number | null;
  circuitBreakerState: string;
  circuitBreakerHealthy: boolean;
  circuitBreakerFailures: number;
  circuitBreakerLastOpenedAt: string | null;
  circuitBreakerLastHalfOpenAt: string | null;
  circuitBreakerLastClosedAt: string | null;
  circuitBreakerNextRetryAt: string | null;
}

export interface PredictiveHealingStatusSnapshot {
  enabled: boolean;
  dryRun: boolean;
  autoExecute: boolean;
  lastObservedAt: string | null;
  lastDecisionAt: string | null;
  lastAction: PredictiveHealingActionType | null;
  lastResult: PredictiveHealingExecutionStatus | null;
  lastMatchedRule: string | null;
  recentAuditCount: number;
  recentAudits: PredictiveHealingAuditEntry[];
  recentObservations: PredictiveHealingObservation[];
  cooldowns: Record<string, string>;
  automation: PredictiveHealingAutomationStatus;
  recentExecutionLog: PredictiveHealingExecutionLogEntry[];
  detailsPath: '/api/self-heal/decide';
  actuator: WorkerRepairActuatorStatus;
  advisors: string[];
  aiProvider: PredictiveHealingAIProviderStatusSnapshot;
}

export interface PredictiveHealingCompactSummary {
  enabled: boolean;
  dryRun: boolean;
  autoExecute: boolean;
  autoExecuteReady: boolean;
  lastObservedAt: string | null;
  lastDecisionAt: string | null;
  lastAction: PredictiveHealingActionType | null;
  lastResult: PredictiveHealingExecutionStatus | null;
  lastAutoExecutionAt: string | null;
  lastAutoExecutionResult: PredictiveHealingExecutionStatus | null;
  recentAuditCount: number;
  detailsPath: '/api/self-heal/decide';
}

export interface PredictiveHealingRulesConfig {
  minObservations: number;
  staleAfterMs: number;
  minConfidence: number;
  errorRateThreshold: number;
  latencyConsecutiveIntervals: number;
  latencyRiseDeltaMs: number;
  memoryThresholdMb: number;
  memoryGrowthThresholdMb: number;
  memorySustainedIntervals: number;
  queuePendingThreshold: number;
  queueVelocityThreshold: number;
}

export interface PredictiveHealingDecisionResult {
  source: string;
  featureFlags: {
    enabled: boolean;
    dryRun: boolean;
    autoExecute: boolean;
  };
  observation: PredictiveHealingObservation;
  trends: PredictiveHealingTrends;
  decision: PredictiveHealingDecision;
  execution: PredictiveHealingExecutionResult;
  auditEntry: PredictiveHealingAuditEntry;
}

interface PredictiveHealingState {
  nextAuditSequence: number;
  recentObservations: PredictiveHealingObservation[];
  recentAudits: PredictiveHealingAuditEntry[];
  actionCooldowns: Map<string, number>;
  aiProvider: PredictiveHealingAIProviderStatusSnapshot;
}

interface PredictiveHealingCandidate {
  action: Exclude<PredictiveHealingActionType, 'none'>;
  target: string | null;
  reason: string;
  confidence: number;
  matchedRule: string;
  priority: number;
  details: Record<string, unknown>;
}

interface PredictiveHealingExecutionRequest {
  source: string;
  observation: PredictiveHealingObservation;
  decision: PredictiveHealingDecision;
  executeRequested: boolean;
  allowAutoExecute: boolean;
  dryRunOverride?: boolean;
}

const GLOBAL_KEY = '__ARCANOS_PREDICTIVE_SELF_HEAL__';
const DEFAULT_ADVISORS: readonly PredictiveHealingAdvisor[] = [
  'rules_v1',
  'arcanos_core_v1',
  'rules_fallback_v1'
] as const;
const DEFAULT_WINDOW_MS = 5 * 60_000;
const DEFAULT_MIN_OBSERVATIONS = 3;
const DEFAULT_STALE_AFTER_MS = 2 * 60_000;
const DEFAULT_MIN_CONFIDENCE = 0.65;
const DEFAULT_ERROR_RATE_THRESHOLD = 0.18;
const DEFAULT_LATENCY_INTERVALS = 3;
const DEFAULT_LATENCY_RISE_DELTA_MS = 350;
const DEFAULT_MEMORY_THRESHOLD_MB = 1024;
const DEFAULT_MEMORY_GROWTH_THRESHOLD_MB = 192;
const DEFAULT_MEMORY_SUSTAINED_INTERVALS = 3;
const DEFAULT_QUEUE_PENDING_THRESHOLD = 5;
const DEFAULT_QUEUE_VELOCITY_THRESHOLD = 2;
const DEFAULT_ACTION_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_OBSERVATION_HISTORY_LIMIT = 12;
const DEFAULT_AUDIT_HISTORY_LIMIT = 25;
const DEFAULT_LOOP_INTERVAL_MS = 30_000;
const DEFAULT_EXECUTION_LOG_LIMIT = 10;
const DEFAULT_SCALE_UP_STEP = 1;
const DEFAULT_AI_IDLE_COOLDOWN_MS = 6 * 60 * 60_000;
const DEFAULT_AI_ACTIVE_COOLDOWN_MS = 30 * 60_000;
const DEFAULT_AI_FAILURE_COOLDOWN_MS = 6 * 60 * 60_000;
const REDUCED_LATENCY_MODE_TOKEN_LIMIT = 96;
const SINGLE_UNHEALTHY_WORKER_CONFIDENCE = 0.86;
const LATENCY_RISING_BASE_CONFIDENCE = 0.68;
const LATENCY_RISING_CONFIDENCE_FACTOR = 0.06;
const LATENCY_RISING_MAX_CONFIDENCE = 0.92;
const QUEUE_BACKLOG_BASE_CONFIDENCE = 0.7;
const QUEUE_BACKLOG_CONFIDENCE_FACTOR = 0.04;
const QUEUE_BACKLOG_MAX_CONFIDENCE = 0.93;
const MEMORY_GROWTH_RECYCLE_CONFIDENCE = 0.84;
const ERROR_RATE_BASE_CONFIDENCE = 0.72;
const ERROR_RATE_CONFIDENCE_FACTOR = 1.5;
const ERROR_RATE_MAX_CONFIDENCE = 0.95;
const TRINITY_FINAL_STAGE_BASE_CONFIDENCE = 0.82;
const TRINITY_INTERMEDIATE_STAGE_BASE_CONFIDENCE = 0.76;
const TRINITY_PREHEAL_CONFIRMATION_BOOST = 0.06;
const TRINITY_PREHEAL_MAX_CONFIDENCE = 0.91;
const PREEMPTIVE_DEGRADE_CONFIDENCE = 0.69;
const OFFLINE_NODE_SHIFT_TRAFFIC_CONFIDENCE = 0.88;
const PREDICTIVE_LOOP_SOURCE = 'predictive_self_heal_loop';
const PREDICTIVE_AI_SOURCE_ENDPOINT = 'self_heal.predictive.ai_decision';
const PREDICTIVE_AI_MODULE = 'ARCANOS:CORE' as const;
const PREDICTIVE_AI_MAX_WORDS = 180;

const predictiveHealingAiDecisionSchema = z.object({
  selectedCandidateIndex: z.number().int().min(0).nullable(),
  chooseNoAction: z.boolean().optional(),
  reason: z.string().min(1).max(600),
  safeToExecute: z.boolean(),
  confidence: z.number().min(0).max(1).optional()
});

type PredictiveHealingAiDecisionPayload = z.infer<typeof predictiveHealingAiDecisionSchema>;

type PredictiveHealingGlobal = typeof globalThis & {
  [GLOBAL_KEY]?: PredictiveHealingState;
};

type PredictiveHealingAiCooldownReason =
  | 'idle_window_backoff'
  | 'active_incident_backoff'
  | 'provider_failure_backoff';

type PredictiveHealingAiCooldownWindow = {
  reason: PredictiveHealingAiCooldownReason;
  cooldownMs: number;
  remainingMs: number;
  cooldownUntil: string;
  liveLoadSignal: boolean;
};

function toIsoTimestamp(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return new Date(value).toISOString();
}

function resolveCircuitBreakerNextRetryAt(health: ReturnType<typeof getOpenAIServiceHealth>): string | null {
  if (health.circuitBreaker.state !== 'OPEN') {
    return null;
  }

  const lastFailureTime =
    typeof health.circuitBreaker.lastFailureTime === 'number' ? health.circuitBreaker.lastFailureTime : 0;
  const resetTimeoutMs =
    typeof health.circuitBreaker.constants?.CIRCUIT_BREAKER_RESET_TIMEOUT_MS === 'number'
      ? health.circuitBreaker.constants.CIRCUIT_BREAKER_RESET_TIMEOUT_MS
      : 0;

  return toIsoTimestamp(lastFailureTime + resetTimeoutMs);
}

function cloneAiProviderStatus(
  snapshot: PredictiveHealingAIProviderStatusSnapshot
): PredictiveHealingAIProviderStatusSnapshot {
  return {
    ...snapshot
  };
}

function buildAiProviderStatusSnapshot(
  health: ReturnType<typeof getOpenAIServiceHealth>,
  previous?: Partial<PredictiveHealingAIProviderStatusSnapshot>
): PredictiveHealingAIProviderStatusSnapshot {
  const providerRuntime = health.providerRuntime;
  return {
    configured: Boolean(health.apiKey.configured),
    clientInitialized: Boolean(health.client.initialized),
    reachable:
      previous?.reachable ??
      (providerRuntime.lastSuccessAt
        ? true
        : providerRuntime.lastFailureCategory === 'network'
          ? false
          : providerRuntime.lastFailureCategory === 'authentication'
            ? true
            : null),
    authenticated:
      previous?.authenticated ??
      (providerRuntime.lastSuccessAt
        ? true
        : providerRuntime.lastFailureCategory === 'authentication'
          ? false
          : null),
    completionHealthy:
      previous?.completionHealthy ??
      (providerRuntime.lastSuccessAt
        ? true
        : providerRuntime.lastFailureAt
          ? false
          : null),
    model: previous?.model ?? getFallbackModel(),
    baseUrl: health.client.baseURL ?? previous?.baseUrl ?? null,
    lastAttemptAt: providerRuntime.lastAttemptAt ?? previous?.lastAttemptAt ?? null,
    lastSuccessAt: providerRuntime.lastSuccessAt ?? previous?.lastSuccessAt ?? null,
    lastFailureAt: providerRuntime.lastFailureAt ?? previous?.lastFailureAt ?? null,
    lastFailureReason: providerRuntime.lastFailureReason ?? previous?.lastFailureReason ?? null,
    lastFailureCategory:
      (providerRuntime.lastFailureCategory as PredictiveHealingAIProviderFailureCategory | null) ??
      previous?.lastFailureCategory ??
      null,
    lastFailureStatus: providerRuntime.lastFailureStatus ?? previous?.lastFailureStatus ?? null,
    circuitBreakerState: health.circuitBreaker.state,
    circuitBreakerHealthy: Boolean(health.circuitBreaker.healthy),
    circuitBreakerFailures:
      typeof health.circuitBreaker.failureCount === 'number' ? health.circuitBreaker.failureCount : 0,
    circuitBreakerLastOpenedAt: toIsoTimestamp(health.circuitBreaker.lastOpenedAt),
    circuitBreakerLastHalfOpenAt: toIsoTimestamp(health.circuitBreaker.lastHalfOpenAt),
    circuitBreakerLastClosedAt: toIsoTimestamp(health.circuitBreaker.lastClosedAt),
    circuitBreakerNextRetryAt: providerRuntime.nextRetryAt ?? resolveCircuitBreakerNextRetryAt(health)
  };
}

function createInitialAiProviderStatus(): PredictiveHealingAIProviderStatusSnapshot {
  return buildAiProviderStatusSnapshot(getOpenAIServiceHealth());
}

function createInitialState(): PredictiveHealingState {
  return {
    nextAuditSequence: 1,
    recentObservations: [],
    recentAudits: [],
    actionCooldowns: new Map(),
    aiProvider: createInitialAiProviderStatus()
  };
}

function getState(): PredictiveHealingState {
  const runtime = globalThis as PredictiveHealingGlobal;
  if (!runtime[GLOBAL_KEY]) {
    runtime[GLOBAL_KEY] = createInitialState();
  }
  return runtime[GLOBAL_KEY];
}

function extractErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const candidate = error as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  if (typeof candidate.status === 'number') {
    return candidate.status;
  }

  if (typeof candidate.response?.status === 'number') {
    return candidate.response.status;
  }

  return null;
}

function sanitizeProviderFailureReason(reason: string): string {
  const trimmed = reason.trim();
  return trimmed.length > 400 ? `${trimmed.slice(0, 397).trimEnd()}...` : trimmed;
}

function classifyProviderFailure(error: unknown): {
  reason: string;
  status: number | null;
  category: PredictiveHealingAIProviderFailureCategory;
  reachable: boolean | null;
  authenticated: boolean | null;
  completionHealthy: boolean;
} {
  const reason = sanitizeProviderFailureReason(resolveErrorMessage(error));
  const normalizedReason = reason.toLowerCase();
  const status = extractErrorStatus(error);

  if (reason === 'openai_client_unavailable') {
    return {
      reason,
      status,
      category: 'missing_client',
      reachable: null,
      authenticated: null,
      completionHealthy: false
    };
  }

  if (normalizedReason.includes('circuit breaker is open')) {
    return {
      reason,
      status,
      category: 'circuit_open',
      reachable: null,
      authenticated: null,
      completionHealthy: false
    };
  }

  if (
    status === 401 ||
    status === 403 ||
    normalizedReason.includes('invalid api key') ||
    normalizedReason.includes('incorrect api key') ||
    normalizedReason.includes('authentication')
  ) {
    return {
      reason,
      status,
      category: 'authentication',
      reachable: true,
      authenticated: false,
      completionHealthy: false
    };
  }

  if (status === 429 && (normalizedReason.includes('quota') || normalizedReason.includes('billing'))) {
    return {
      reason,
      status,
      category: 'insufficient_quota',
      reachable: true,
      authenticated: true,
      completionHealthy: false
    };
  }

  if (status === 429) {
    return {
      reason,
      status,
      category: 'rate_limited',
      reachable: true,
      authenticated: true,
      completionHealthy: false
    };
  }

  if (status === 400) {
    return {
      reason,
      status,
      category: 'invalid_request',
      reachable: true,
      authenticated: true,
      completionHealthy: false
    };
  }

  if (status !== null && status >= 500) {
    return {
      reason,
      status,
      category: 'provider_error',
      reachable: true,
      authenticated: true,
      completionHealthy: false
    };
  }

  if (
    normalizedReason.includes('timed out') ||
    normalizedReason.includes('timeout') ||
    normalizedReason.includes('request was aborted') ||
    normalizedReason.includes('runtime_budget_exhausted')
  ) {
    return {
      reason,
      status,
      category: 'timeout',
      reachable: false,
      authenticated: null,
      completionHealthy: false
    };
  }

  if (
    normalizedReason.includes('fetch failed') ||
    normalizedReason.includes('econnrefused') ||
    normalizedReason.includes('enotfound') ||
    normalizedReason.includes('dns') ||
    normalizedReason.includes('tls') ||
    normalizedReason.includes('socket')
  ) {
    return {
      reason,
      status,
      category: 'network',
      reachable: false,
      authenticated: null,
      completionHealthy: false
    };
  }

  return {
    reason,
    status,
    category: 'unknown',
    reachable: null,
    authenticated: null,
    completionHealthy: false
  };
}

function updateAiProviderState(
  state: PredictiveHealingState,
  updater: (current: PredictiveHealingAIProviderStatusSnapshot) => PredictiveHealingAIProviderStatusSnapshot
): PredictiveHealingAIProviderStatusSnapshot {
  const nextSnapshot = updater(buildAiProviderStatusSnapshot(getOpenAIServiceHealth(), state.aiProvider));
  state.aiProvider = cloneAiProviderStatus(nextSnapshot);
  return cloneAiProviderStatus(state.aiProvider);
}

function recordCircuitBreakerTransitionEvents(params: {
  source: string;
  eventTimestamp: string;
  previousHealth: ReturnType<typeof getOpenAIServiceHealth>;
  nextHealth: ReturnType<typeof getOpenAIServiceHealth>;
  model: string;
  correlationId?: string | null;
}): void {
  const previousOpenedAt = toIsoTimestamp(params.previousHealth.circuitBreaker.lastOpenedAt);
  const nextOpenedAt = toIsoTimestamp(params.nextHealth.circuitBreaker.lastOpenedAt);
  if (nextOpenedAt && nextOpenedAt !== previousOpenedAt) {
    recordSelfHealEvent({
      kind: 'CIRCUIT_BREAKER_OPENED',
      source: params.source,
      trigger: 'predictive_ai',
      reason: 'OpenAI circuit breaker opened for the self-heal provider path.',
      healedComponent: 'ai_provider',
      correlationId: params.correlationId,
      details: {
        state: params.nextHealth.circuitBreaker.state,
        failures: params.nextHealth.circuitBreaker.failureCount,
        model: params.model,
        nextRetryAt: resolveCircuitBreakerNextRetryAt(params.nextHealth)
      },
      timestamp: params.eventTimestamp
    });
  }

  const previousHalfOpenAt = toIsoTimestamp(params.previousHealth.circuitBreaker.lastHalfOpenAt);
  const nextHalfOpenAt = toIsoTimestamp(params.nextHealth.circuitBreaker.lastHalfOpenAt);
  if (nextHalfOpenAt && nextHalfOpenAt !== previousHalfOpenAt) {
    recordSelfHealEvent({
      kind: 'CIRCUIT_BREAKER_HALF_OPEN',
      source: params.source,
      trigger: 'predictive_ai',
      reason: 'OpenAI circuit breaker entered half-open recovery mode.',
      healedComponent: 'ai_provider',
      correlationId: params.correlationId,
      details: {
        state: params.nextHealth.circuitBreaker.state,
        failures: params.nextHealth.circuitBreaker.failureCount,
        model: params.model
      },
      timestamp: params.eventTimestamp
    });
  }

  const previousClosedAt = toIsoTimestamp(params.previousHealth.circuitBreaker.lastClosedAt);
  const nextClosedAt = toIsoTimestamp(params.nextHealth.circuitBreaker.lastClosedAt);
  if (nextClosedAt && nextClosedAt !== previousClosedAt) {
    recordSelfHealEvent({
      kind: 'CIRCUIT_BREAKER_CLOSED',
      source: params.source,
      trigger: 'predictive_ai',
      reason: 'OpenAI circuit breaker closed after provider recovery.',
      healedComponent: 'ai_provider',
      correlationId: params.correlationId,
      details: {
        state: params.nextHealth.circuitBreaker.state,
        failures: params.nextHealth.circuitBreaker.failureCount,
        model: params.model
      },
      timestamp: params.eventTimestamp
    });
  }
}

function recordAiProviderCallAttempt(params: {
  source: string;
  reason: string;
  model: string;
  actuator: WorkerRepairActuatorStatus;
}): string {
  const timestamp = new Date().toISOString();
  recordSelfHealEvent({
    kind: 'AI_PROVIDER_CALL_ATTEMPT',
    source: params.source,
    trigger: 'predictive_ai',
    reason: params.reason,
    healedComponent: 'ai_provider',
    details: {
      model: params.model,
      sourceEndpoint: PREDICTIVE_AI_SOURCE_ENDPOINT,
      actuatorMode: params.actuator.mode,
      actuatorPath: params.actuator.path,
      actuatorBaseUrl: params.actuator.baseUrl
    },
    timestamp
  });
  return timestamp;
}

function recordAiProviderCallSuccess(params: {
  source: string;
  timestamp: string;
  model: string;
  activeModel: string;
  fallbackFlag: boolean;
  timeoutKind: string | null | undefined;
  degradedModeReason: string | null | undefined;
}): void {
  recordSelfHealEvent({
    kind: 'AI_PROVIDER_CALL_SUCCESS',
    source: params.source,
    trigger: 'predictive_ai',
    reason: 'Self-heal AI provider returned a completion.',
    healedComponent: 'ai_provider',
    details: {
      model: params.model,
      activeModel: params.activeModel,
      sourceEndpoint: PREDICTIVE_AI_SOURCE_ENDPOINT,
      fallbackFlag: params.fallbackFlag,
      timeoutKind: params.timeoutKind ?? null,
      degradedModeReason: params.degradedModeReason ?? null
    },
    timestamp: params.timestamp
  });
}

function recordAiProviderCallFailure(params: {
  source: string;
  timestamp: string;
  model: string;
  classification: ReturnType<typeof classifyProviderFailure>;
}): void {
  recordSelfHealEvent({
    kind: 'AI_PROVIDER_CALL_FAILURE',
    source: params.source,
    trigger: 'predictive_ai',
    reason: params.classification.reason,
    healedComponent: 'ai_provider',
    details: {
      model: params.model,
      sourceEndpoint: PREDICTIVE_AI_SOURCE_ENDPOINT,
      failureCategory: params.classification.category,
      failureStatus: params.classification.status
    },
    timestamp: params.timestamp
  });
}

async function runWithTimeout<T>(
  factory: () => Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });

  try {
    return await Promise.race([factory(), timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function roundMetric(value: number, digits = 3): number {
  return Number(value.toFixed(digits));
}

function toMegabytes(value: number): number {
  return roundMetric(value / (1024 * 1024), 2);
}

function normalizeStringArray(values: string[] | undefined | null): string[] {
  return Array.isArray(values)
    ? [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort()
    : [];
}

function stageCooldownToIso(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return new Date(value).toISOString();
}

function inferActiveTrinityStage(snapshot: ReturnType<typeof getTrinitySelfHealingStatus>['snapshot']): TrinitySelfHealingStage | null {
  if (snapshot.intake.activeAction) {
    return 'intake';
  }
  if (snapshot.reasoning.activeAction) {
    return 'reasoning';
  }
  if (snapshot.final.activeAction) {
    return 'final';
  }

  return null;
}

function inferActiveTrinityAction(
  snapshot: ReturnType<typeof getTrinitySelfHealingStatus>['snapshot']
): TrinitySelfHealingAction | null {
  return snapshot.intake.activeAction ?? snapshot.reasoning.activeAction ?? snapshot.final.activeAction ?? null;
}

function buildTrinityObservation(status: ReturnType<typeof getTrinitySelfHealingStatus>): PredictiveHealingObservation['trinity'] {
  const snapshot = status.snapshot;
  const activeStage = inferActiveTrinityStage(snapshot);

  return {
    enabled: status.enabled,
    activeStage,
    activeAction: inferActiveTrinityAction(snapshot),
    verified: Boolean(
      snapshot.intake.verifiedAtMs !== null ||
        snapshot.reasoning.verifiedAtMs !== null ||
        snapshot.final.verifiedAtMs !== null
    ),
    config: {
      triggerThreshold: status.config.triggerThreshold,
      maxAttempts: status.config.maxAttempts
    },
    stages: {
      intake: {
        observationsInWindow: snapshot.intake.observations.length,
        attempts: snapshot.intake.attempts,
        activeAction: snapshot.intake.activeAction,
        verified: snapshot.intake.verifiedAtMs !== null,
        cooldownUntil: stageCooldownToIso(snapshot.intake.cooldownUntilMs),
        failedActions: [...snapshot.intake.failedActions]
      },
      reasoning: {
        observationsInWindow: snapshot.reasoning.observations.length,
        attempts: snapshot.reasoning.attempts,
        activeAction: snapshot.reasoning.activeAction,
        verified: snapshot.reasoning.verifiedAtMs !== null,
        cooldownUntil: stageCooldownToIso(snapshot.reasoning.cooldownUntilMs),
        failedActions: [...snapshot.reasoning.failedActions]
      },
      final: {
        observationsInWindow: snapshot.final.observations.length,
        attempts: snapshot.final.attempts,
        activeAction: snapshot.final.activeAction,
        verified: snapshot.final.verifiedAtMs !== null,
        cooldownUntil: stageCooldownToIso(snapshot.final.cooldownUntilMs),
        failedActions: [...snapshot.final.failedActions]
      }
    }
  };
}

function buildObservationFromSources(params: {
  source: string;
  requestWindow: RequestWindowSnapshot;
  workerHealth: WorkerControlHealthResponse | null;
  workerRuntime: WorkerRuntimeStatus;
  promptRouteMitigation: PromptRouteMitigationState;
  trinityStatus: ReturnType<typeof getTrinitySelfHealingStatus>;
  memoryUsage: NodeJS.MemoryUsage;
  collectedAt?: string;
  workerHealthError?: string | null;
}): PredictiveHealingObservation {
  const workerHealthAlerts = normalizeStringArray(params.workerHealth?.alerts);
  if (params.workerHealthError) {
    workerHealthAlerts.push(`worker_health_error:${params.workerHealthError}`);
  }

  const workers = Array.isArray(params.workerHealth?.workers)
    ? params.workerHealth!.workers.map((worker) => ({
        workerId: worker.workerId,
        healthStatus: worker.healthStatus,
        currentJobId: worker.currentJobId ?? null,
        lastActivityAt: worker.lastActivityAt ?? null,
        lastProcessedJobAt: worker.lastProcessedJobAt ?? null,
        inactivityMs: worker.inactivityMs ?? null,
        watchdog: worker.watchdog
          ? {
              triggered: Boolean(worker.watchdog.triggered),
              reason: worker.watchdog.reason ?? null,
              restartRecommended: Boolean(worker.watchdog.restartRecommended),
              idleThresholdMs: worker.watchdog.idleThresholdMs ?? null
            }
          : undefined
      }))
    : [];

  const degradedWorkerIds = workers
    .filter((worker) => worker.healthStatus === 'degraded')
    .map((worker) => worker.workerId)
    .sort();
  const unhealthyWorkerIds = workers
    .filter((worker) => worker.healthStatus === 'unhealthy')
    .map((worker) => worker.workerId)
    .sort();
  const inactivity = buildWorkerInactivityObservation({
    workers,
    alerts: workerHealthAlerts,
    requestCount: params.requestWindow.requestCount,
    pending: params.workerHealth?.queueSummary?.pending ?? 0,
    stalledRunning: params.workerHealth?.queueSummary?.stalledRunning ?? 0,
    idleThresholdMs: params.workerHealth?.settings.watchdogIdleMs ?? null
  });

  return {
    collectedAt: params.collectedAt ?? new Date().toISOString(),
    source: params.source,
    windowMs: Math.max(5_000, Math.trunc(params.requestWindow.windowMs)),
    requestCount: params.requestWindow.requestCount,
    errorRate: roundMetric(params.requestWindow.errorRate),
    timeoutRate: roundMetric(params.requestWindow.timeoutRate),
    avgLatencyMs: roundMetric(params.requestWindow.avgLatencyMs, 2),
    p95LatencyMs: roundMetric(params.requestWindow.p95LatencyMs, 2),
    maxLatencyMs: roundMetric(params.requestWindow.maxLatencyMs, 2),
    degradedCount: params.requestWindow.degradedCount,
    memory: {
      rssMb: toMegabytes(params.memoryUsage.rss),
      heapUsedMb: toMegabytes(params.memoryUsage.heapUsed),
      heapTotalMb: toMegabytes(params.memoryUsage.heapTotal),
      externalMb: toMegabytes(params.memoryUsage.external),
      arrayBuffersMb: toMegabytes(params.memoryUsage.arrayBuffers)
    },
    workerHealth: {
      overallStatus: params.workerHealth?.overallStatus ?? null,
      alertCount: workerHealthAlerts.length,
      alerts: workerHealthAlerts,
      pending: params.workerHealth?.queueSummary?.pending ?? 0,
      running: params.workerHealth?.queueSummary?.running ?? 0,
      delayed: params.workerHealth?.queueSummary?.delayed ?? 0,
      stalledRunning: params.workerHealth?.queueSummary?.stalledRunning ?? 0,
      oldestPendingJobAgeMs: params.workerHealth?.queueSummary?.oldestPendingJobAgeMs ?? 0,
      degradedWorkerIds,
      unhealthyWorkerIds,
      workers
    },
    inactivity,
    workerRuntime: {
      enabled: params.workerRuntime.enabled,
      started: params.workerRuntime.started,
      configuredCount: params.workerRuntime.configuredCount,
      activeListeners: params.workerRuntime.activeListeners,
      maxActiveWorkers: params.workerRuntime.maxActiveWorkers,
      surgeWorkerCount: params.workerRuntime.surgeWorkerCount,
      workerIds: [...params.workerRuntime.workerIds]
    },
    promptRoute: {
      active: params.promptRouteMitigation.active,
      mode: params.promptRouteMitigation.mode,
      reason: params.promptRouteMitigation.reason ?? null
    },
    trinity: buildTrinityObservation(params.trinityStatus)
  };
}

function applySimulation(
  base: PredictiveHealingObservation,
  simulate: PredictiveHealingSimulationInput | undefined
): PredictiveHealingObservation {
  if (!simulate) {
    return base;
  }

  return {
    ...base,
    requestCount: simulate.requestCount ?? base.requestCount,
    errorRate: simulate.errorRate ?? base.errorRate,
    timeoutRate: simulate.timeoutRate ?? base.timeoutRate,
    avgLatencyMs: simulate.avgLatencyMs ?? base.avgLatencyMs,
    p95LatencyMs: simulate.p95LatencyMs ?? base.p95LatencyMs,
    maxLatencyMs: simulate.maxLatencyMs ?? base.maxLatencyMs,
    degradedCount: simulate.degradedCount ?? base.degradedCount,
    memory: {
      ...base.memory,
      ...(simulate.memory ?? {})
    },
    workerHealth: {
      ...base.workerHealth,
      ...(simulate.workerHealth ?? {}),
      alerts: simulate.workerHealth?.alerts
        ? normalizeStringArray(simulate.workerHealth.alerts)
        : base.workerHealth.alerts,
      degradedWorkerIds: simulate.workerHealth?.degradedWorkerIds
        ? normalizeStringArray(simulate.workerHealth.degradedWorkerIds)
        : base.workerHealth.degradedWorkerIds,
      unhealthyWorkerIds: simulate.workerHealth?.unhealthyWorkerIds
        ? normalizeStringArray(simulate.workerHealth.unhealthyWorkerIds)
        : base.workerHealth.unhealthyWorkerIds,
      workers: simulate.workerHealth?.workers
        ? simulate.workerHealth.workers.map((worker) => ({
            workerId: worker.workerId,
            healthStatus: worker.healthStatus,
            currentJobId: worker.currentJobId ?? null,
            lastActivityAt: worker.lastActivityAt ?? null,
            lastProcessedJobAt: worker.lastProcessedJobAt ?? null,
            inactivityMs: worker.inactivityMs ?? null,
            watchdog: worker.watchdog
              ? {
                  triggered: Boolean(worker.watchdog.triggered),
                  reason: worker.watchdog.reason ?? null,
                  restartRecommended: Boolean(worker.watchdog.restartRecommended),
                  idleThresholdMs: worker.watchdog.idleThresholdMs ?? null
                }
              : undefined
          }))
        : base.workerHealth.workers
    },
    inactivity: simulate.inactivity
      ? {
          inactiveDegraded: simulate.inactivity.inactiveDegraded ?? base.inactivity?.inactiveDegraded ?? false,
          reason: simulate.inactivity.reason ?? base.inactivity?.reason ?? null,
          idleThresholdMs: simulate.inactivity.idleThresholdMs ?? base.inactivity?.idleThresholdMs ?? null,
          maxInactivityMs: simulate.inactivity.maxInactivityMs ?? base.inactivity?.maxInactivityMs ?? 0,
          lastActivityAt: simulate.inactivity.lastActivityAt ?? base.inactivity?.lastActivityAt ?? null,
          lastProcessedJobAt:
            simulate.inactivity.lastProcessedJobAt ?? base.inactivity?.lastProcessedJobAt ?? null,
          workerIds: simulate.inactivity.workerIds
            ? [...simulate.inactivity.workerIds]
            : [...(base.inactivity?.workerIds ?? [])]
        }
      : base.inactivity,
    workerRuntime: {
      ...base.workerRuntime,
      ...(simulate.workerRuntime ?? {}),
      workerIds: simulate.workerRuntime?.workerIds
        ? [...simulate.workerRuntime.workerIds]
        : base.workerRuntime.workerIds
    },
    promptRoute: {
      ...base.promptRoute,
      ...(simulate.promptRoute ?? {})
    },
    trinity: {
      ...base.trinity,
      ...(simulate.trinity ?? {}),
      config: {
        ...base.trinity.config,
        ...(simulate.trinity?.config ?? {})
      },
      stages: {
        intake: {
          ...base.trinity.stages.intake,
          ...(simulate.trinity?.stages?.intake ?? {}),
          failedActions: simulate.trinity?.stages?.intake?.failedActions
            ? [...simulate.trinity.stages.intake.failedActions]
            : base.trinity.stages.intake.failedActions
        },
        reasoning: {
          ...base.trinity.stages.reasoning,
          ...(simulate.trinity?.stages?.reasoning ?? {}),
          failedActions: simulate.trinity?.stages?.reasoning?.failedActions
            ? [...simulate.trinity.stages.reasoning.failedActions]
            : base.trinity.stages.reasoning.failedActions
        },
        final: {
          ...base.trinity.stages.final,
          ...(simulate.trinity?.stages?.final ?? {}),
          failedActions: simulate.trinity?.stages?.final?.failedActions
            ? [...simulate.trinity.stages.final.failedActions]
            : base.trinity.stages.final.failedActions
        }
      }
    }
  };
}

function cloneObservation(observation: PredictiveHealingObservation): PredictiveHealingObservation {
  return {
    ...observation,
    memory: { ...observation.memory },
    workerHealth: {
      ...observation.workerHealth,
      alerts: [...observation.workerHealth.alerts],
      degradedWorkerIds: [...observation.workerHealth.degradedWorkerIds],
      unhealthyWorkerIds: [...observation.workerHealth.unhealthyWorkerIds],
      workers: observation.workerHealth.workers.map((worker) => ({ ...worker }))
    },
    inactivity: observation.inactivity ? { ...observation.inactivity, workerIds: [...observation.inactivity.workerIds] } : undefined,
    workerRuntime: {
      ...observation.workerRuntime,
      workerIds: [...observation.workerRuntime.workerIds]
    },
    promptRoute: { ...observation.promptRoute },
    trinity: {
      ...observation.trinity,
      config: { ...observation.trinity.config },
      stages: {
        intake: {
          ...observation.trinity.stages.intake,
          failedActions: [...observation.trinity.stages.intake.failedActions]
        },
        reasoning: {
          ...observation.trinity.stages.reasoning,
          failedActions: [...observation.trinity.stages.reasoning.failedActions]
        },
        final: {
          ...observation.trinity.stages.final,
          failedActions: [...observation.trinity.stages.final.failedActions]
        }
      }
    }
  };
}

function collectRecentObservations(
  state: PredictiveHealingState,
  current: PredictiveHealingObservation
): PredictiveHealingObservation[] {
  const config = getConfig();
  const historyLimit = Math.max(3, config.predictiveHealingObservationHistoryLimit ?? DEFAULT_OBSERVATION_HISTORY_LIMIT);
  state.recentObservations.push(current);
  if (state.recentObservations.length > historyLimit) {
    state.recentObservations.splice(0, state.recentObservations.length - historyLimit);
  }

  return state.recentObservations.map((observation) => cloneObservation(observation));
}

function getRulesConfig(overrides: Partial<PredictiveHealingRulesConfig> = {}): PredictiveHealingRulesConfig {
  const config = getConfig();
  return {
    minObservations: Math.max(2, overrides.minObservations ?? config.predictiveHealingMinObservations ?? DEFAULT_MIN_OBSERVATIONS),
    staleAfterMs: Math.max(5_000, overrides.staleAfterMs ?? config.predictiveHealingStaleAfterMs ?? DEFAULT_STALE_AFTER_MS),
    minConfidence: roundMetric(overrides.minConfidence ?? config.predictiveHealingMinConfidence ?? DEFAULT_MIN_CONFIDENCE),
    errorRateThreshold: roundMetric(overrides.errorRateThreshold ?? config.predictiveErrorRateThreshold ?? DEFAULT_ERROR_RATE_THRESHOLD),
    latencyConsecutiveIntervals: Math.max(
      2,
      Math.trunc(overrides.latencyConsecutiveIntervals ?? config.predictiveLatencyConsecutiveIntervals ?? DEFAULT_LATENCY_INTERVALS)
    ),
    latencyRiseDeltaMs: Math.max(50, overrides.latencyRiseDeltaMs ?? config.predictiveLatencyRiseDeltaMs ?? DEFAULT_LATENCY_RISE_DELTA_MS),
    memoryThresholdMb: Math.max(128, overrides.memoryThresholdMb ?? config.predictiveMemoryThresholdMb ?? DEFAULT_MEMORY_THRESHOLD_MB),
    memoryGrowthThresholdMb: Math.max(
      16,
      overrides.memoryGrowthThresholdMb ?? config.predictiveMemoryGrowthThresholdMb ?? DEFAULT_MEMORY_GROWTH_THRESHOLD_MB
    ),
    memorySustainedIntervals: Math.max(
      2,
      Math.trunc(overrides.memorySustainedIntervals ?? config.predictiveMemorySustainedIntervals ?? DEFAULT_MEMORY_SUSTAINED_INTERVALS)
    ),
    queuePendingThreshold: Math.max(
      1,
      Math.trunc(overrides.queuePendingThreshold ?? config.predictiveQueuePendingThreshold ?? DEFAULT_QUEUE_PENDING_THRESHOLD)
    ),
    queueVelocityThreshold: Math.max(
      0.25,
      overrides.queueVelocityThreshold ?? config.predictiveQueueVelocityThreshold ?? DEFAULT_QUEUE_VELOCITY_THRESHOLD
    )
  };
}

function calculateSlope(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }

  return roundMetric((values[values.length - 1] - values[0]) / (values.length - 1), 4);
}

function calculateConsecutiveRises(values: number[], minimumDelta: number): number {
  if (values.length < 2) {
    return 0;
  }

  let rises = 0;
  for (let index = values.length - 1; index > 0; index -= 1) {
    if (values[index] - values[index - 1] >= minimumDelta) {
      rises += 1;
      continue;
    }
    break;
  }

  return rises;
}

function workerHealthRank(status: WorkerControlHealthResponse['overallStatus'] | null): number {
  if (status === 'offline') {
    return 3;
  }
  if (status === 'unhealthy') {
    return 2;
  }
  if (status === 'degraded') {
    return 1;
  }
  return 0;
}

function trinityActionOrder(stage: TrinitySelfHealingStage): TrinitySelfHealingAction[] {
  if (stage === 'final') {
    return ['bypass_final_stage', 'enable_degraded_mode'];
  }

  return ['enable_degraded_mode'];
}

function selectTrinityStageAction(
  stage: TrinitySelfHealingStage,
  failedActions: TrinitySelfHealingAction[]
): TrinitySelfHealingAction | null {
  for (const action of trinityActionOrder(stage)) {
    if (!failedActions.includes(action)) {
      return action;
    }
  }

  return null;
}

function getTrinityCandidatePriority(stage: TrinitySelfHealingStage): number {
  if (stage === 'final') {
    return 35;
  }
  if (stage === 'reasoning') {
    return 36;
  }

  return 37;
}

function getTrinityCandidateConfidence(
  stage: TrinitySelfHealingStage,
  observationsInWindow: number,
  triggerThreshold: number
): number {
  const baseConfidence =
    stage === 'final' ? TRINITY_FINAL_STAGE_BASE_CONFIDENCE : TRINITY_INTERMEDIATE_STAGE_BASE_CONFIDENCE;
  const thresholdReached = observationsInWindow >= triggerThreshold;

  return Math.min(
    TRINITY_PREHEAL_MAX_CONFIDENCE,
    baseConfidence + (thresholdReached ? TRINITY_PREHEAL_CONFIRMATION_BOOST : 0)
  );
}

function buildTrends(
  history: PredictiveHealingObservation[],
  config: PredictiveHealingRulesConfig
): PredictiveHealingTrends {
  const current = history[history.length - 1];
  const first = history[0];

  return {
    observationCount: history.length,
    sampleAgeMs: Math.max(0, Date.now() - Date.parse(current.collectedAt)),
    dataFresh: Date.now() - Date.parse(current.collectedAt) <= config.staleAfterMs,
    latencySlopeMs: calculateSlope(history.map((observation) => observation.avgLatencyMs)),
    p95LatencySlopeMs: calculateSlope(history.map((observation) => observation.p95LatencyMs)),
    latencyRiseIntervals: calculateConsecutiveRises(
      history.map((observation) => observation.avgLatencyMs),
      config.latencyRiseDeltaMs
    ),
    errorRateSlope: calculateSlope(history.map((observation) => observation.errorRate)),
    memoryGrowthMb: roundMetric(current.memory.rssMb - first.memory.rssMb, 2),
    memoryPressureIntervals: history.filter((observation) => observation.memory.rssMb >= config.memoryThresholdMb).length,
    queueDepthVelocity: calculateSlope(history.map((observation) => observation.workerHealth.pending)),
    workerHealthDegrading:
      workerHealthRank(current.workerHealth.overallStatus) > workerHealthRank(first.workerHealth.overallStatus),
    unhealthyWorkerDelta:
      current.workerHealth.unhealthyWorkerIds.length - first.workerHealth.unhealthyWorkerIds.length
  };
}

function buildNoopDecision(
  observation: PredictiveHealingObservation,
  trends: PredictiveHealingTrends,
  reason: string
): PredictiveHealingDecision {
  return {
    advisor: 'rules_v1',
    decidedAt: observation.collectedAt,
    action: 'none',
    target: null,
    reason,
    confidence: 0,
    matchedRule: null,
    safeToExecute: false,
    staleData: !trends.dataFresh,
    suggestedMode: 'recommend_only',
    details: {
      observationCount: trends.observationCount,
      sampleAgeMs: trends.sampleAgeMs
    }
  };
}

function parseJsonObjectFromModelOutput(rawOutput: string): unknown {
  const raw = (rawOutput || '').trim();
  try {
    return JSON.parse(raw);
  } catch {
    // Continue to JSON recovery.
  }

  const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]) {
    try {
      return JSON.parse(fencedMatch[1].trim());
    } catch {
      // Continue to brace extraction.
    }
  }

  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(raw.slice(firstBrace, lastBrace + 1));
    } catch {
      // Continue to progressive trimming.
    }
  }

  for (let end = raw.length - 1; end > 0; end -= 1) {
    if (raw[end] !== '}') {
      continue;
    }
    const start = raw.indexOf('{');
    if (start < 0 || end <= start) {
      continue;
    }
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      // Keep trimming.
    }
  }

  throw new Error('Predictive healing AI response is not valid JSON.');
}

function buildFallbackDecision(
  decision: PredictiveHealingDecision,
  fallbackReason: string,
  metadata: Record<string, unknown> = {}
): PredictiveHealingDecision {
  const failureCategory =
    typeof metadata.aiProviderFailureCategory === 'string' ? metadata.aiProviderFailureCategory : null;
  const canPromoteProviderReinit =
    decision.action === 'none' &&
    failureCategory === 'authentication' &&
    (
      metadata.aiProviderConfigured === true ||
      typeof metadata.aiProviderLastAttemptAt === 'string' ||
      typeof metadata.aiProviderLastFailureAt === 'string'
    );

  if (canPromoteProviderReinit) {
    return {
      ...decision,
      advisor: 'rules_fallback_v1',
      action: 'reinitialize_ai_provider',
      target: 'ai_provider',
      reason: 'AI provider authentication failed during predictive diagnosis; forcing a provider reload so runtime recovery can resume when credentials change.',
      confidence: Math.max(decision.confidence, 0.94),
      matchedRule: 'ai_provider_authentication_reinitialize',
      safeToExecute: true,
      suggestedMode: 'auto_execute',
      details: {
        ...decision.details,
        aiPath: PREDICTIVE_AI_MODULE,
        aiSourceEndpoint: PREDICTIVE_AI_SOURCE_ENDPOINT,
        aiUsed: false,
        aiFallbackReason: fallbackReason,
        aiFallbackPromotedAction: 'reinitialize_ai_provider',
        ...metadata
      }
    };
  }

  return {
    ...decision,
    advisor: 'rules_fallback_v1',
    details: {
      ...decision.details,
      aiPath: PREDICTIVE_AI_MODULE,
      aiSourceEndpoint: PREDICTIVE_AI_SOURCE_ENDPOINT,
      aiUsed: false,
      aiFallbackReason: fallbackReason,
      ...metadata
    }
  };
}

function buildAiDecisionPrompt(params: {
  source: string;
  observation: PredictiveHealingObservation;
  trends: PredictiveHealingTrends;
  rulesDecision: PredictiveHealingDecision;
  candidates: Array<Omit<PredictiveHealingCandidate, 'priority'>>;
  actuator: WorkerRepairActuatorStatus;
}): string {
  const candidatePreview = params.candidates.slice(0, 5).map((candidate, index) => ({
    index,
    action: candidate.action,
    target: candidate.target,
    confidence: candidate.confidence,
    matchedRule: candidate.matchedRule,
    reason: candidate.reason,
    details: candidate.details
  }));

  return [
    'You are ARCANOS:CORE making a bounded production self-healing decision.',
    'Return JSON only with this schema:',
    '{"selectedCandidateIndex":number|null,"chooseNoAction":boolean,"reason":string,"safeToExecute":boolean,"confidence":number}',
    'Rules:',
    '- Only pick a candidate index from the provided list.',
    '- Never invent an action or target.',
    '- Prefer no action over an unsafe or weak action.',
    '- If selectedCandidateIndex is null, set chooseNoAction to true.',
    '- The runtime may execute the selected action automatically.',
    `Actuator=${JSON.stringify({
      mode: params.actuator.mode,
      available: params.actuator.available,
      reason: params.actuator.reason,
      baseUrl: params.actuator.baseUrl,
      path: params.actuator.path
    })}`,
    `Observation=${JSON.stringify({
      source: params.source,
      collectedAt: params.observation.collectedAt,
      requestCount: params.observation.requestCount,
      errorRate: params.observation.errorRate,
      timeoutRate: params.observation.timeoutRate,
      avgLatencyMs: params.observation.avgLatencyMs,
      p95LatencyMs: params.observation.p95LatencyMs,
      maxLatencyMs: params.observation.maxLatencyMs,
      degradedCount: params.observation.degradedCount,
      workerHealth: {
        overallStatus: params.observation.workerHealth.overallStatus,
        alertCount: params.observation.workerHealth.alertCount,
        alerts: params.observation.workerHealth.alerts,
        pending: params.observation.workerHealth.pending,
        running: params.observation.workerHealth.running,
        stalledRunning: params.observation.workerHealth.stalledRunning,
        unhealthyWorkerIds: params.observation.workerHealth.unhealthyWorkerIds,
        degradedWorkerIds: params.observation.workerHealth.degradedWorkerIds
      },
      workerRuntime: params.observation.workerRuntime,
      promptRoute: params.observation.promptRoute,
      trinity: {
        enabled: params.observation.trinity.enabled,
        activeStage: params.observation.trinity.activeStage,
        activeAction: params.observation.trinity.activeAction,
        verified: params.observation.trinity.verified
      }
    })}`,
    `Trends=${JSON.stringify(params.trends)}`,
    `RulesDecision=${JSON.stringify({
      advisor: params.rulesDecision.advisor,
      action: params.rulesDecision.action,
      target: params.rulesDecision.target,
      reason: params.rulesDecision.reason,
      confidence: params.rulesDecision.confidence,
      matchedRule: params.rulesDecision.matchedRule,
      safeToExecute: params.rulesDecision.safeToExecute
    })}`,
    `Candidates=${JSON.stringify(candidatePreview)}`
  ].join('\n');
}

async function resolveAiDecision(params: {
  source: string;
  observation: PredictiveHealingObservation;
  trends: PredictiveHealingTrends;
  rulesDecision: PredictiveHealingDecision;
  candidates: Array<Omit<PredictiveHealingCandidate, 'priority'>>;
  minConfidence: number;
  config: ReturnType<typeof getConfig>;
}): Promise<PredictiveHealingDecision> {
  const state = getState();
  const actuator = buildWorkerRepairActuatorStatus();
  const expectedModel = getFallbackModel();
  const preCallHealth = getOpenAIServiceHealth();
  const providerStatusBeforeAttempt = updateAiProviderState(state, (current) => ({
    ...buildAiProviderStatusSnapshot(preCallHealth, current),
    model: expectedModel
  }));
  const cooldownWindow = resolvePredictiveHealingAiCooldownWindow({
    observation: params.observation,
    providerStatus: providerStatusBeforeAttempt,
    config: params.config
  });
  if (cooldownWindow) {
    const fallbackReason = `AI diagnosis cooldown active (${cooldownWindow.reason}) until ${cooldownWindow.cooldownUntil}.`;
    recordSelfHealEvent({
      kind: 'fallback',
      source: params.source,
      trigger: 'predictive_ai',
      reason: fallbackReason,
      actionTaken: params.rulesDecision.action,
      healedComponent: params.rulesDecision.target,
      details: {
        cooldownReason: cooldownWindow.reason,
        cooldownMs: cooldownWindow.cooldownMs,
        cooldownRemainingMs: cooldownWindow.remainingMs,
        cooldownUntil: cooldownWindow.cooldownUntil,
        liveLoadSignal: cooldownWindow.liveLoadSignal
      }
    });
    logger.info('self_heal.ai_diagnosis.cooldown', {
      module: 'predictive-healing',
      source: params.source,
      aiPath: PREDICTIVE_AI_MODULE,
      sourceEndpoint: PREDICTIVE_AI_SOURCE_ENDPOINT,
      cooldownReason: cooldownWindow.reason,
      cooldownMs: cooldownWindow.cooldownMs,
      cooldownRemainingMs: cooldownWindow.remainingMs,
      cooldownUntil: cooldownWindow.cooldownUntil,
      liveLoadSignal: cooldownWindow.liveLoadSignal
    });
    return buildFallbackDecision(params.rulesDecision, fallbackReason, {
      actuatorMode: actuator.mode,
      actuatorPath: actuator.path,
      actuatorBaseUrl: actuator.baseUrl,
      aiProviderConfigured: providerStatusBeforeAttempt.configured,
      aiProviderReachable: providerStatusBeforeAttempt.reachable,
      aiProviderAuthenticated: providerStatusBeforeAttempt.authenticated,
      aiProviderModel: providerStatusBeforeAttempt.model,
      aiProviderLastAttemptAt: providerStatusBeforeAttempt.lastAttemptAt,
      aiProviderLastFailureAt: providerStatusBeforeAttempt.lastFailureAt,
      aiProviderLastFailureReason: providerStatusBeforeAttempt.lastFailureReason,
      aiProviderFailureCategory: providerStatusBeforeAttempt.lastFailureCategory,
      aiProviderFailureStatus: providerStatusBeforeAttempt.lastFailureStatus,
      aiProviderCircuitBreakerState: providerStatusBeforeAttempt.circuitBreakerState,
      aiProviderCircuitBreakerFailures: providerStatusBeforeAttempt.circuitBreakerFailures,
      aiProviderCircuitBreakerNextRetryAt: providerStatusBeforeAttempt.circuitBreakerNextRetryAt,
      aiCooldownReason: cooldownWindow.reason,
      aiCooldownMs: cooldownWindow.cooldownMs,
      aiCooldownRemainingMs: cooldownWindow.remainingMs,
      aiCooldownUntil: cooldownWindow.cooldownUntil
    });
  }

  const attemptAt = recordAiProviderCallAttempt({
    source: params.source,
    reason: 'Self-heal requested an AI provider completion for predictive diagnosis.',
    model: expectedModel,
    actuator
  });

  updateAiProviderState(state, (current) => ({
    ...buildAiProviderStatusSnapshot(preCallHealth, current),
    model: expectedModel,
    lastAttemptAt: attemptAt
  }));

  logger.info('self_heal.ai_diagnosis.requested', {
    module: 'predictive-healing',
    source: params.source,
    aiPath: PREDICTIVE_AI_MODULE,
    sourceEndpoint: PREDICTIVE_AI_SOURCE_ENDPOINT,
    candidateCount: params.candidates.length,
    rulesAction: params.rulesDecision.action,
    rulesConfidence: params.rulesDecision.confidence,
    actuatorMode: actuator.mode,
    actuatorPath: actuator.path,
    actuatorBaseUrl: actuator.baseUrl
  });

  const { client } = getOpenAIClientOrAdapter();
  if (!client) {
    const fallbackFailure = classifyProviderFailure(new Error('openai_client_unavailable'));
    const providerStatus = updateAiProviderState(state, (current) => ({
      ...buildAiProviderStatusSnapshot(getOpenAIServiceHealth(), current),
      model: expectedModel,
      lastAttemptAt: attemptAt,
      reachable: fallbackFailure.reachable,
      authenticated: fallbackFailure.authenticated,
      completionHealthy: fallbackFailure.completionHealthy,
      lastFailureAt: attemptAt,
      lastFailureReason: fallbackFailure.reason,
      lastFailureCategory: fallbackFailure.category,
      lastFailureStatus: fallbackFailure.status
    }));

    const fallbackReason = fallbackFailure.reason;
    recordAiProviderCallFailure({
      source: params.source,
      timestamp: attemptAt,
      model: expectedModel,
      classification: fallbackFailure
    });
    recordSelfHealEvent({
      kind: 'fallback',
      source: params.source,
      trigger: 'predictive_ai',
      reason: fallbackReason,
      actionTaken: params.rulesDecision.action,
      healedComponent: params.rulesDecision.target
    });
    logger.warn('self_heal.ai_diagnosis.fallback', {
      module: 'predictive-healing',
      source: params.source,
      aiPath: PREDICTIVE_AI_MODULE,
      sourceEndpoint: PREDICTIVE_AI_SOURCE_ENDPOINT,
      fallbackReason,
      fallbackAdvisor: 'rules_fallback_v1',
      aiProviderConfigured: providerStatus.configured,
      aiProviderReachable: providerStatus.reachable,
      aiProviderAuthenticated: providerStatus.authenticated,
      circuitBreakerState: providerStatus.circuitBreakerState
    });
    return buildFallbackDecision(params.rulesDecision, fallbackReason, {
      actuatorMode: actuator.mode,
      actuatorPath: actuator.path,
      actuatorBaseUrl: actuator.baseUrl,
      aiProviderConfigured: providerStatus.configured,
      aiProviderReachable: providerStatus.reachable,
      aiProviderAuthenticated: providerStatus.authenticated,
      aiProviderModel: providerStatus.model,
      aiProviderLastAttemptAt: providerStatus.lastAttemptAt,
      aiProviderLastFailureAt: providerStatus.lastFailureAt,
      aiProviderLastFailureReason: providerStatus.lastFailureReason,
      aiProviderFailureCategory: providerStatus.lastFailureCategory,
      aiProviderFailureStatus: providerStatus.lastFailureStatus,
      aiProviderCircuitBreakerState: providerStatus.circuitBreakerState,
      aiProviderCircuitBreakerFailures: providerStatus.circuitBreakerFailures,
      aiProviderCircuitBreakerNextRetryAt: providerStatus.circuitBreakerNextRetryAt
    });
  }

  try {
    const aiResult = await runArcanosCoreQuery({
      client,
      prompt: buildAiDecisionPrompt({
        source: params.source,
        observation: params.observation,
        trends: params.trends,
        rulesDecision: params.rulesDecision,
        candidates: params.candidates,
        actuator
      }),
      sourceEndpoint: PREDICTIVE_AI_SOURCE_ENDPOINT,
      runOptions: {
        answerMode: 'direct',
        requestedVerbosity: 'minimal',
        maxWords: PREDICTIVE_AI_MAX_WORDS,
        strictUserVisibleOutput: true,
        debugPipeline: false
      }
    });

    const parsed = predictiveHealingAiDecisionSchema.parse(parseJsonObjectFromModelOutput(aiResult.result));
    const chosenCandidate =
      parsed.selectedCandidateIndex === null ? null : params.candidates[parsed.selectedCandidateIndex] ?? null;

    if (parsed.selectedCandidateIndex !== null && !chosenCandidate) {
      throw new Error(`AI selected candidate index ${parsed.selectedCandidateIndex} but no candidate exists there.`);
    }

    const aiMetadata = {
      aiPath: PREDICTIVE_AI_MODULE,
      aiSourceEndpoint: PREDICTIVE_AI_SOURCE_ENDPOINT,
      aiUsed: true,
      aiSelectedCandidateIndex: parsed.selectedCandidateIndex,
      aiModel: aiResult.activeModel,
      aiFallbackFlag: aiResult.fallbackFlag,
      aiFallbackReasons: aiResult.fallbackSummary.fallbackReasons,
      aiRoutingStages: aiResult.routingStages ?? [],
      aiTimeoutKind: aiResult.timeoutKind ?? null,
      aiDegradedModeReason: aiResult.degradedModeReason ?? null,
      aiBypassedSubsystems: aiResult.bypassedSubsystems ?? [],
      actuatorMode: actuator.mode,
      actuatorPath: actuator.path,
      actuatorBaseUrl: actuator.baseUrl
    };

    let decision: PredictiveHealingDecision;
    if (parsed.chooseNoAction || parsed.selectedCandidateIndex === null || !chosenCandidate) {
      decision = {
        ...buildNoopDecision(params.observation, params.trends, parsed.reason),
        advisor: 'arcanos_core_v1',
        confidence: roundMetric(parsed.confidence ?? params.rulesDecision.confidence, 2),
        details: {
          ...params.rulesDecision.details,
          ...aiMetadata,
          aiRecommendedNoAction: true
        }
      };
    } else {
      const boundedConfidence = roundMetric(
        Math.min(
          chosenCandidate.confidence,
          parsed.confidence ?? chosenCandidate.confidence
        ),
        2
      );
      decision = {
        advisor: 'arcanos_core_v1',
        decidedAt: params.observation.collectedAt,
        action: chosenCandidate.action,
        target: chosenCandidate.target,
        reason: parsed.reason,
        confidence: boundedConfidence,
        matchedRule: chosenCandidate.matchedRule,
        safeToExecute: Boolean(parsed.safeToExecute) && boundedConfidence >= params.minConfidence,
        staleData: false,
        suggestedMode: 'recommend_only',
        details: {
          ...chosenCandidate.details,
          ...aiMetadata
        }
      };
    }

    const successAt = new Date().toISOString();
    const postCallHealth = getOpenAIServiceHealth();
    const providerStatus = updateAiProviderState(state, (current) => ({
      ...buildAiProviderStatusSnapshot(postCallHealth, current),
      model: aiResult.activeModel || expectedModel,
      lastAttemptAt: attemptAt,
      lastSuccessAt: successAt,
      reachable: true,
      authenticated: true,
      completionHealthy: true,
      lastFailureReason: null,
      lastFailureCategory: null,
      lastFailureStatus: null
    }));

    recordAiProviderCallSuccess({
      source: params.source,
      timestamp: successAt,
      model: expectedModel,
      activeModel: aiResult.activeModel,
      fallbackFlag: aiResult.fallbackFlag,
      timeoutKind: aiResult.timeoutKind ?? null,
      degradedModeReason: aiResult.degradedModeReason ?? null
    });
    recordCircuitBreakerTransitionEvents({
      source: params.source,
      eventTimestamp: successAt,
      previousHealth: preCallHealth,
      nextHealth: postCallHealth,
      model: providerStatus.model
    });

    logger.info('self_heal.ai_diagnosis.result', {
      module: 'predictive-healing',
      source: params.source,
      advisor: decision.advisor,
      action: decision.action,
      target: decision.target,
      confidence: decision.confidence,
      safeToExecute: decision.safeToExecute,
      aiFallbackFlag: aiResult.fallbackFlag,
      activeModel: aiResult.activeModel,
      timeoutKind: aiResult.timeoutKind ?? null,
      degradedModeReason: aiResult.degradedModeReason ?? null,
      bypassedSubsystems: aiResult.bypassedSubsystems ?? [],
      aiProviderReachable: providerStatus.reachable,
      aiProviderAuthenticated: providerStatus.authenticated,
      circuitBreakerState: providerStatus.circuitBreakerState
    });

    return decision;
  } catch (error) {
    const fallbackFailure = classifyProviderFailure(error);
    const failureAt = new Date().toISOString();
    const postCallHealth = getOpenAIServiceHealth();
    const providerStatus = updateAiProviderState(state, (current) => ({
      ...buildAiProviderStatusSnapshot(postCallHealth, current),
      model: expectedModel,
      lastAttemptAt: attemptAt,
      lastFailureAt: failureAt,
      lastFailureReason: fallbackFailure.reason,
      lastFailureCategory: fallbackFailure.category,
      lastFailureStatus: fallbackFailure.status,
      reachable: fallbackFailure.reachable,
      authenticated: fallbackFailure.authenticated,
      completionHealthy: fallbackFailure.completionHealthy
    }));

    const fallbackReason = fallbackFailure.reason;
    recordAiProviderCallFailure({
      source: params.source,
      timestamp: failureAt,
      model: expectedModel,
      classification: fallbackFailure
    });
    recordCircuitBreakerTransitionEvents({
      source: params.source,
      eventTimestamp: failureAt,
      previousHealth: preCallHealth,
      nextHealth: postCallHealth,
      model: providerStatus.model
    });
    recordSelfHealEvent({
      kind: 'fallback',
      source: params.source,
      trigger: 'predictive_ai',
      reason: fallbackReason,
      actionTaken: params.rulesDecision.action,
      healedComponent: params.rulesDecision.target
    });
    logger.warn('self_heal.ai_diagnosis.fallback', {
      module: 'predictive-healing',
      source: params.source,
      aiPath: PREDICTIVE_AI_MODULE,
      sourceEndpoint: PREDICTIVE_AI_SOURCE_ENDPOINT,
      fallbackReason,
      fallbackAdvisor: 'rules_fallback_v1',
      failureCategory: fallbackFailure.category,
      failureStatus: fallbackFailure.status,
      aiProviderReachable: providerStatus.reachable,
      aiProviderAuthenticated: providerStatus.authenticated,
      circuitBreakerState: providerStatus.circuitBreakerState,
      circuitBreakerFailures: providerStatus.circuitBreakerFailures,
      circuitBreakerNextRetryAt: providerStatus.circuitBreakerNextRetryAt
    });
    return buildFallbackDecision(params.rulesDecision, fallbackReason, {
      actuatorMode: actuator.mode,
      actuatorPath: actuator.path,
      actuatorBaseUrl: actuator.baseUrl,
      aiProviderConfigured: providerStatus.configured,
      aiProviderReachable: providerStatus.reachable,
      aiProviderAuthenticated: providerStatus.authenticated,
      aiProviderModel: providerStatus.model,
      aiProviderLastAttemptAt: providerStatus.lastAttemptAt,
      aiProviderLastSuccessAt: providerStatus.lastSuccessAt,
      aiProviderLastFailureAt: providerStatus.lastFailureAt,
      aiProviderLastFailureReason: providerStatus.lastFailureReason,
      aiProviderFailureCategory: providerStatus.lastFailureCategory,
      aiProviderFailureStatus: providerStatus.lastFailureStatus,
      aiProviderCircuitBreakerState: providerStatus.circuitBreakerState,
      aiProviderCircuitBreakerFailures: providerStatus.circuitBreakerFailures,
      aiProviderCircuitBreakerLastOpenedAt: providerStatus.circuitBreakerLastOpenedAt,
      aiProviderCircuitBreakerNextRetryAt: providerStatus.circuitBreakerNextRetryAt
    });
  }
}

function buildCandidates(
  observation: PredictiveHealingObservation,
  history: PredictiveHealingObservation[],
  trends: PredictiveHealingTrends,
  config: PredictiveHealingRulesConfig
): PredictiveHealingCandidate[] {
  const candidates: PredictiveHealingCandidate[] = [];
  const hasEnoughHistory = history.length >= config.minObservations;
  const hasEnoughTraffic = observation.requestCount >= Math.max(4, config.minObservations);
  const providerStatus = buildPredictiveHealingAIProviderStatusSnapshot();
  const providerFailureActive =
    providerStatus.lastFailureCategory !== null ||
    providerStatus.authenticated === false ||
    providerStatus.reachable === false ||
    providerStatus.completionHealthy === false ||
    String(providerStatus.circuitBreakerState).toUpperCase() === 'OPEN';
  const watchdogTriggered = observation.workerHealth.alerts.some(
    (alert) => alert.toLowerCase().includes('watchdog')
  );

  if (providerFailureActive && (providerStatus.configured || providerStatus.lastAttemptAt !== null)) {
    const authenticationFailure = providerStatus.lastFailureCategory === 'authentication';
    candidates.push({
      action: 'reinitialize_ai_provider',
      target: 'ai_provider',
      reason: authenticationFailure
        ? 'AI provider authentication is unhealthy; force a provider reload so runtime recovery can resume when credentials change.'
        : 'AI provider health is degraded; force a provider reload and probe before routing more AI-dependent recovery.',
      confidence: authenticationFailure ? 0.94 : 0.89,
      matchedRule: authenticationFailure
        ? 'ai_provider_authentication_reinitialize'
        : 'ai_provider_reinitialize',
      priority: 5,
      details: {
        configured: providerStatus.configured,
        reachable: providerStatus.reachable,
        authenticated: providerStatus.authenticated,
        completionHealthy: providerStatus.completionHealthy,
        lastFailureCategory: providerStatus.lastFailureCategory,
        lastFailureReason: providerStatus.lastFailureReason,
        circuitBreakerState: providerStatus.circuitBreakerState,
        circuitBreakerNextRetryAt: providerStatus.circuitBreakerNextRetryAt
      }
    });
  }

  if (
    observation.workerRuntime.enabled &&
    (watchdogTriggered || observation.workerHealth.overallStatus === 'unhealthy') &&
    (observation.workerHealth.pending > 0 || observation.workerHealth.stalledRunning > 0)
  ) {
    candidates.push({
      action: 'heal_worker_runtime',
      target: 'worker_runtime',
      reason: watchdogTriggered
        ? 'Worker watchdog detected idle consumers while queue work remained available.'
        : 'Worker health is unhealthy while queued work remains outstanding.',
      confidence: watchdogTriggered ? 0.92 : 0.85,
      matchedRule: watchdogTriggered
        ? 'worker_watchdog_reheal_runtime'
        : 'worker_unhealthy_reheal_runtime',
      priority: 12,
      details: {
        alerts: observation.workerHealth.alerts,
        pending: observation.workerHealth.pending,
        stalledRunning: observation.workerHealth.stalledRunning
      }
    });
  }

  if (
    observation.workerHealth.unhealthyWorkerIds.length === 1 &&
    observation.workerHealth.pending <= Math.max(1, observation.workerRuntime.activeListeners)
  ) {
    const workerId = observation.workerHealth.unhealthyWorkerIds[0];
    candidates.push({
      action: 'recycle_worker',
      target: workerId,
      reason: `Worker ${workerId} is unhealthy while queue capacity remains available.`,
      confidence: SINGLE_UNHEALTHY_WORKER_CONFIDENCE,
      matchedRule: 'single_worker_unhealthy_recycle',
      priority: 10,
      details: {
        pending: observation.workerHealth.pending,
        activeListeners: observation.workerRuntime.activeListeners
      }
    });
  }

  if (hasEnoughHistory && trends.latencyRiseIntervals >= config.latencyConsecutiveIntervals - 1) {
    candidates.push({
      action: 'scale_workers_up',
      target: 'worker_runtime',
      reason: `Average latency has risen for ${trends.latencyRiseIntervals + 1} consecutive intervals.`,
      confidence: Math.min(
        LATENCY_RISING_MAX_CONFIDENCE,
        LATENCY_RISING_BASE_CONFIDENCE + trends.latencyRiseIntervals * LATENCY_RISING_CONFIDENCE_FACTOR
      ),
      matchedRule: 'latency_rising_scale_up',
      priority: 20,
      details: {
        latencySlopeMs: trends.latencySlopeMs,
        p95LatencySlopeMs: trends.p95LatencySlopeMs,
        currentAvgLatencyMs: observation.avgLatencyMs,
        currentP95LatencyMs: observation.p95LatencyMs
      }
    });
  }

  if (
    observation.inactivity?.inactiveDegraded
  ) {
    candidates.push({
      action: 'heal_worker_runtime',
      target: 'worker_runtime',
      reason:
        observation.inactivity.reason ??
        'No worker activity has been observed beyond the watchdog threshold.',
      confidence:
        observation.workerHealth.pending > 0 || observation.workerHealth.stalledRunning > 0
          ? 0.96
          : 0.84,
      matchedRule: 'inactive_worker_runtime_heal',
      priority: 15,
      details: {
        requestCount: observation.requestCount,
        pending: observation.workerHealth.pending,
        stalledRunning: observation.workerHealth.stalledRunning,
        idleThresholdMs: observation.inactivity.idleThresholdMs,
        maxInactivityMs: observation.inactivity.maxInactivityMs,
        workerIds: observation.inactivity.workerIds,
        lastActivityAt: observation.inactivity.lastActivityAt,
        lastProcessedJobAt: observation.inactivity.lastProcessedJobAt
      }
    });
  }

  if (
    hasEnoughHistory &&
    observation.workerHealth.pending >= config.queuePendingThreshold &&
    trends.queueDepthVelocity >= config.queueVelocityThreshold
  ) {
    candidates.push({
      action: 'scale_workers_up',
      target: 'worker_runtime',
      reason: 'Queue backlog is growing faster than workers are draining it.',
      confidence: Math.min(
        QUEUE_BACKLOG_MAX_CONFIDENCE,
        QUEUE_BACKLOG_BASE_CONFIDENCE + trends.queueDepthVelocity * QUEUE_BACKLOG_CONFIDENCE_FACTOR
      ),
      matchedRule: 'queue_backlog_growth_scale_up',
      priority: 25,
      details: {
        pending: observation.workerHealth.pending,
        queueDepthVelocity: trends.queueDepthVelocity,
        running: observation.workerHealth.running
      }
    });
  }

  if (
    hasEnoughHistory &&
    trends.memoryPressureIntervals >= config.memorySustainedIntervals &&
    trends.memoryGrowthMb >= config.memoryGrowthThresholdMb
  ) {
    candidates.push({
      action: 'recycle_worker_runtime',
      target: 'worker_runtime',
      reason: 'RSS memory has remained high and continues to grow across the rolling window.',
      confidence: MEMORY_GROWTH_RECYCLE_CONFIDENCE,
      matchedRule: 'memory_growth_recycle_runtime',
      priority: 30,
      details: {
        rssMb: observation.memory.rssMb,
        memoryGrowthMb: trends.memoryGrowthMb,
        sustainedIntervals: trends.memoryPressureIntervals
      }
    });
  }

  if (observation.trinity.enabled) {
    for (const stage of ['final', 'reasoning', 'intake'] as const) {
      const stageState = observation.trinity.stages[stage];
      const prehealThreshold = Math.max(1, observation.trinity.config.triggerThreshold - 1);
      const selectedAction = selectTrinityStageAction(stage, stageState.failedActions);
      const cooldownActive =
        typeof stageState.cooldownUntil === 'string' && Date.parse(stageState.cooldownUntil) > Date.now();

      if (
        stageState.activeAction ||
        cooldownActive ||
        stageState.attempts >= observation.trinity.config.maxAttempts ||
        !selectedAction ||
        stageState.observationsInWindow < prehealThreshold
      ) {
        continue;
      }

      const candidateReason =
        stage === 'final'
          ? `Trinity final stage is nearing its self-heal trigger threshold with ${stageState.observationsInWindow} recent aborts.`
          : `Trinity ${stage} stage is degrading toward its self-heal trigger threshold with ${stageState.observationsInWindow} recent aborts.`;

      candidates.push({
        action: 'activate_trinity_mitigation',
        target: `trinity:${stage}`,
        reason: candidateReason,
        confidence: getTrinityCandidateConfidence(
          stage,
          stageState.observationsInWindow,
          observation.trinity.config.triggerThreshold
        ),
        matchedRule: `trinity_${stage}_stage_preheal`,
        priority: getTrinityCandidatePriority(stage),
        details: {
          stage,
          trinityAction: selectedAction,
          observationsInWindow: stageState.observationsInWindow,
          triggerThreshold: observation.trinity.config.triggerThreshold,
          attempts: stageState.attempts,
          failedActions: [...stageState.failedActions]
        }
      });
      break;
    }
  }

  if (hasEnoughTraffic && observation.errorRate >= config.errorRateThreshold) {
    candidates.push({
      action: 'heal_worker_runtime',
      target: 'worker_runtime',
      reason: `Error rate ${observation.errorRate} exceeded the predictive threshold ${config.errorRateThreshold}.`,
      confidence: Math.min(
        ERROR_RATE_MAX_CONFIDENCE,
        ERROR_RATE_BASE_CONFIDENCE + (observation.errorRate - config.errorRateThreshold) * ERROR_RATE_CONFIDENCE_FACTOR
      ),
      matchedRule: 'error_rate_reheal_runtime',
      priority: 40,
      details: {
        requestCount: observation.requestCount,
        errorRate: observation.errorRate,
        timeoutRate: observation.timeoutRate
      }
    });
  }

  if (
    !observation.promptRoute.active &&
    (observation.avgLatencyMs >= config.latencyRiseDeltaMs * 3 || observation.degradedCount > 0)
  ) {
    candidates.push({
      action: 'mark_node_degraded',
      target: 'prompt_route',
      reason: 'Prompt route is trending toward degraded service and should shed load before hard failure.',
      confidence: PREEMPTIVE_DEGRADE_CONFIDENCE,
      matchedRule: 'preemptive_prompt_route_degrade',
      priority: 50,
      details: {
        avgLatencyMs: observation.avgLatencyMs,
        degradedCount: observation.degradedCount
      }
    });
  }

  if (
    observation.workerHealth.overallStatus === 'offline' &&
    observation.promptRoute.active &&
    observation.promptRoute.mode === 'degraded_response'
  ) {
    candidates.push({
      action: 'shift_traffic_away',
      target: 'node',
      reason: 'Local runtime appears offline even after degraded mode is active.',
      confidence: OFFLINE_NODE_SHIFT_TRAFFIC_CONFIDENCE,
      matchedRule: 'offline_node_shift_traffic',
      priority: 60,
      details: {
        workerHealth: observation.workerHealth.overallStatus,
        promptRouteMode: observation.promptRoute.mode
      }
    });
  }

  return candidates.sort((left, right) => {
    if (left.priority !== right.priority) {
      return left.priority - right.priority;
    }

    return right.confidence - left.confidence;
  });
}

export function evaluatePredictiveHealingRules(params: {
  observation: PredictiveHealingObservation;
  history: PredictiveHealingObservation[];
  config?: Partial<PredictiveHealingRulesConfig>;
}): {
  decision: PredictiveHealingDecision;
  trends: PredictiveHealingTrends;
  candidates: Array<Omit<PredictiveHealingCandidate, 'priority'>>;
} {
  const rulesConfig = getRulesConfig(params.config);
  const history = params.history.length > 0 ? params.history : [params.observation];
  const trends = buildTrends(history, rulesConfig);

  if (!trends.dataFresh) {
    return {
      decision: buildNoopDecision(params.observation, trends, 'Predictive healing refused because metrics are stale.'),
      trends,
      candidates: []
    };
  }

  const candidates = buildCandidates(params.observation, history, trends, rulesConfig);
  const chosen = candidates[0];
  if (!chosen) {
    return {
      decision: buildNoopDecision(params.observation, trends, 'No predictive healing rule matched the current rolling window.'),
      trends,
      candidates: []
    };
  }

  if (chosen.confidence < rulesConfig.minConfidence) {
    return {
      decision: {
        advisor: 'rules_v1',
        decidedAt: params.observation.collectedAt,
        action: 'none',
        target: null,
        reason: `${chosen.reason} Confidence ${roundMetric(chosen.confidence, 2)} is below the safe execution floor.`,
        confidence: roundMetric(chosen.confidence, 2),
        matchedRule: chosen.matchedRule,
        safeToExecute: false,
        staleData: false,
        suggestedMode: 'recommend_only',
        details: chosen.details
      },
      trends,
      candidates: candidates.map(({ priority, ...candidate }) => candidate)
    };
  }

  return {
    decision: {
      advisor: 'rules_v1',
      decidedAt: params.observation.collectedAt,
      action: chosen.action,
      target: chosen.target,
      reason: chosen.reason,
      confidence: roundMetric(chosen.confidence, 2),
      matchedRule: chosen.matchedRule,
      safeToExecute: true,
      staleData: false,
      suggestedMode: 'recommend_only',
      details: chosen.details
    },
    trends,
    candidates: candidates.map(({ priority, ...candidate }) => candidate)
  };
}

function resolveExecutionMode(request: PredictiveHealingExecutionRequest): PredictiveHealingExecutionResult['mode'] {
  const config = getConfig();
  const effectiveDryRun = request.dryRunOverride ?? config.predictiveHealingDryRun;
  if (request.executeRequested) {
    return effectiveDryRun ? 'dry_run' : 'operator_execute';
  }

  if (request.allowAutoExecute) {
    return effectiveDryRun ? 'dry_run' : 'auto_execute';
  }

  return 'recommend_only';
}

function getActionCooldownKey(decision: PredictiveHealingDecision): string {
  return `${decision.action}:${decision.target ?? 'global'}`;
}

function getCooldownRemainingMs(key: string): number | null {
  const expiresAt = getState().actionCooldowns.get(key);
  if (!expiresAt) {
    return null;
  }

  const remainingMs = Math.max(0, expiresAt - Date.now());
  return remainingMs > 0 ? remainingMs : null;
}

function setActionCooldown(key: string): void {
  const config = getConfig();
  getState().actionCooldowns.set(
    key,
    Date.now() + Math.max(10_000, config.predictiveHealingActionCooldownMs ?? DEFAULT_ACTION_COOLDOWN_MS)
  );
}

function snapshotCooldowns(): Record<string, string> {
  const entries = [...getState().actionCooldowns.entries()]
    .filter(([, expiresAt]) => expiresAt > Date.now())
    .map(([key, expiresAt]) => [key, new Date(expiresAt).toISOString()] as const)
    .sort((left, right) => left[0].localeCompare(right[0]));
  return Object.fromEntries(entries);
}

function extractTrinityDecisionDetails(
  decision: PredictiveHealingDecision
): {
  stage: TrinitySelfHealingStage;
  action: TrinitySelfHealingAction;
} | null {
  const stage = decision.details.stage;
  const action = decision.details.trinityAction;

  if (
    (stage === 'intake' || stage === 'reasoning' || stage === 'final') &&
    (action === 'enable_degraded_mode' || action === 'bypass_final_stage')
  ) {
    return { stage, action };
  }

  return null;
}

function buildSupportPreview(
  observation: PredictiveHealingObservation,
  decision: PredictiveHealingDecision
): { supported: boolean; message: string } {
  if (decision.action === 'none') {
    return {
      supported: false,
      message: 'No predictive action selected.'
    };
  }

  if (decision.action === 'shift_traffic_away') {
    return {
      supported: false,
      message: 'Traffic shifting is not supported by this backend runtime.'
    };
  }

  if (decision.action === 'reinitialize_ai_provider') {
    const providerStatus = buildPredictiveHealingAIProviderStatusSnapshot();
    if (!providerStatus.configured && providerStatus.lastFailureCategory === null) {
      return {
        supported: false,
        message: 'OpenAI provider reinitialization is unavailable because the provider is not configured.'
      };
    }

    return {
      supported: true,
      message: 'OpenAI provider reinitialization supported.'
    };
  }

  if (decision.action === 'scale_workers_up') {
    if (!observation.workerRuntime.enabled) {
      return {
        supported: false,
        message: 'Worker runtime scaling is unavailable because RUN_WORKERS is disabled.'
      };
    }

    if (observation.workerRuntime.activeListeners >= observation.workerRuntime.maxActiveWorkers) {
      return {
        supported: false,
        message: 'Worker runtime is already at predictive scale-up capacity.'
      };
    }

    return {
      supported: true,
      message: 'Scale-up supported.'
    };
  }

  if (decision.action === 'recycle_worker') {
    if (!decision.target || !observation.workerRuntime.workerIds.includes(decision.target)) {
      return {
        supported: false,
        message: 'Target worker is not managed by the local in-process runtime.'
      };
    }

    return {
      supported: true,
      message: 'Targeted worker recycle supported.'
    };
  }

  if (decision.action === 'activate_trinity_mitigation') {
    if (!observation.trinity.enabled) {
      return {
        supported: false,
        message: 'Trinity self-healing is disabled.'
      };
    }

    const trinityDecision = extractTrinityDecisionDetails(decision);
    if (!trinityDecision) {
      return {
        supported: false,
        message: 'Trinity predictive decision is missing stage/action details.'
      };
    }

    const stageState = observation.trinity.stages[trinityDecision.stage];
    if (stageState.activeAction === trinityDecision.action) {
      return {
        supported: false,
        message: `Trinity ${trinityDecision.stage} stage mitigation is already active.`
      };
    }

    if (stageState.cooldownUntil && Date.parse(stageState.cooldownUntil) > Date.now()) {
      return {
        supported: false,
        message: `Trinity ${trinityDecision.stage} stage mitigation is cooling down.`
      };
    }

    if (stageState.attempts >= observation.trinity.config.maxAttempts) {
      return {
        supported: false,
        message: `Trinity ${trinityDecision.stage} stage mitigation has exhausted its attempt budget.`
      };
    }

    return {
      supported: true,
      message: 'Trinity mitigation supported.'
    };
  }

  return {
    supported: true,
    message: 'Action supported.'
  };
}

function buildPendingOutcome(summary: string): PredictiveHealingRecoveryOutcome {
  return {
    status: 'pending_observation',
    summary
  };
}

async function executeDecision(
  request: PredictiveHealingExecutionRequest
): Promise<PredictiveHealingExecutionResult> {
  const mode = resolveExecutionMode(request);
  const preview = buildSupportPreview(request.observation, request.decision);
  const cooldownKey = getActionCooldownKey(request.decision);
  const cooldownRemainingMs = getCooldownRemainingMs(cooldownKey);

  if (request.decision.action === 'none' || !request.decision.safeToExecute) {
    return {
      attempted: false,
      status: 'refused',
      mode,
      action: request.decision.action,
      target: request.decision.target,
      message: request.decision.reason,
      cooldownRemainingMs: null,
      actuatorResult: null,
      recoveryOutcome: {
        status: 'not_executed',
        summary: 'Predictive healing decision was intentionally not executable.'
      }
    };
  }

  if (!preview.supported) {
    return {
      attempted: false,
      status: 'unsupported',
      mode,
      action: request.decision.action,
      target: request.decision.target,
      message: preview.message,
      cooldownRemainingMs: null,
      actuatorResult: null,
      recoveryOutcome: {
        status: 'unsupported',
        summary: preview.message
      }
    };
  }

  if (cooldownRemainingMs !== null) {
    return {
      attempted: false,
      status: 'cooldown',
      mode,
      action: request.decision.action,
      target: request.decision.target,
      message: `Predictive action ${request.decision.action} is cooling down.`,
      cooldownRemainingMs,
      actuatorResult: null,
      recoveryOutcome: {
        status: 'not_executed',
        summary: 'Action skipped because the cooldown window is still active.'
      }
    };
  }

  if (mode === 'recommend_only') {
    return {
      attempted: false,
      status: 'skipped',
      mode,
      action: request.decision.action,
      target: request.decision.target,
      message: 'Predictive action was recommended only.',
      cooldownRemainingMs: null,
      actuatorResult: null,
      recoveryOutcome: {
        status: 'not_executed',
        summary: 'Recommendation recorded without execution.'
      }
    };
  }

  if (mode === 'dry_run') {
    return {
      attempted: false,
      status: 'dry_run',
      mode,
      action: request.decision.action,
      target: request.decision.target,
      message: 'Predictive action evaluated in dry-run mode.',
      cooldownRemainingMs: null,
      actuatorResult: {
        preview: preview.message
      },
      recoveryOutcome: {
        status: 'not_executed',
        summary: 'Dry-run mode prevented execution.'
      }
    };
  }

  try {
    let actuatorResult:
      | WorkerScaleUpResult
      | WorkerRecycleResult
      | TrinitySelfHealingMitigationCommandResult
      | Record<string, unknown>;
    let message = request.decision.reason;
    let recoveryOutcome = buildPendingOutcome('Action executed; awaiting subsequent rolling-window confirmation.');

    if (request.decision.action === 'reinitialize_ai_provider') {
      const result = await reinitializeOpenAIProvider({
        forceReload: true,
        ignoreBackoff: true,
        source: request.source
      });
      actuatorResult = {
        reloaded: result.reloaded,
        ok: result.ok,
        skipped: result.skipped,
        reason: result.reason,
        runtime: result.runtime
      };
      message = result.reason ?? (result.ok ? 'OpenAI provider reinitialized.' : 'OpenAI provider reload attempted.');
      recoveryOutcome = buildPendingOutcome(message);
    } else if (request.decision.action === 'scale_workers_up') {
      const config = getConfig();
      const result = await scaleWorkersUp(config.predictiveScaleUpStep ?? DEFAULT_SCALE_UP_STEP);
      actuatorResult = result;
      message = result.message;
      recoveryOutcome = buildPendingOutcome(
        result.applied ? `Scaled workers to ${result.activeWorkerCount} active listeners.` : result.message
      );
    } else if (request.decision.action === 'recycle_worker') {
      const result = await recycleWorker(request.decision.target ?? '');
      actuatorResult = result;
      message = result.message;
      recoveryOutcome = buildPendingOutcome(result.message);
    } else if (
      request.decision.action === 'recycle_worker_runtime' ||
      request.decision.action === 'heal_worker_runtime'
    ) {
      const actuator = buildWorkerRepairActuatorStatus();
      logger.info('self_heal.repair.execution', {
        module: 'predictive-healing',
        source: request.source,
        action: request.decision.action,
        target: request.decision.target,
        advisor: request.decision.advisor,
        mode,
        actuatorMode: actuator.mode,
        actuatorPath: actuator.path,
        actuatorBaseUrl: actuator.baseUrl
      });
      const result = await executeWorkerRepairActuator({
        force: true,
        source: request.source
      });
      actuatorResult = {
        actuatorMode: result.mode,
        actuatorPath: result.path,
        actuatorBaseUrl: result.baseUrl,
        statusCode: result.statusCode,
        payload: result.payload
      };
      message = result.message;
      recoveryOutcome = buildPendingOutcome(result.message);
      logger.info('self_heal.repair.result', {
        module: 'predictive-healing',
        source: request.source,
        action: request.decision.action,
        target: request.decision.target,
        advisor: request.decision.advisor,
        executionStatus: 'executed',
        actuatorMode: result.mode,
        actuatorPath: result.path,
        actuatorBaseUrl: result.baseUrl,
        statusCode: result.statusCode,
        message: result.message
      });
    } else if (request.decision.action === 'activate_trinity_mitigation') {
      const trinityDecision = extractTrinityDecisionDetails(request.decision);
      if (!trinityDecision) {
        return {
          attempted: false,
          status: 'unsupported',
          mode,
          action: request.decision.action,
          target: request.decision.target,
          message: 'Trinity predictive decision is missing stage/action details.',
          cooldownRemainingMs: null,
          actuatorResult: null,
          recoveryOutcome: {
            status: 'unsupported',
            summary: 'Trinity predictive action could not be resolved.'
          }
        };
      }

      const result = activateTrinitySelfHealingMitigation({
        stage: trinityDecision.stage,
        action: trinityDecision.action,
        reason: `predictive_healing:${request.decision.matchedRule ?? trinityDecision.stage}`
      });

      actuatorResult = result;
      message = result.reason;
      recoveryOutcome = buildPendingOutcome(
        `Trinity ${trinityDecision.stage} stage mitigation ${trinityDecision.action} activated.`
      );

      if (!result.applied) {
        const status: PredictiveHealingExecutionStatus =
          result.reason === 'cooldown_active' ? 'cooldown' : 'skipped';
        return {
          attempted: false,
          status,
          mode,
          action: request.decision.action,
          target: request.decision.target,
          message,
          cooldownRemainingMs: status === 'cooldown' ? getCooldownRemainingMs(cooldownKey) : null,
          actuatorResult: result as unknown as Record<string, unknown>,
          recoveryOutcome: {
            status: 'not_executed',
            summary: `Trinity mitigation was not applied: ${result.reason}.`
          }
        };
      }
    } else if (request.decision.action === 'mark_node_degraded') {
      const reason = `predictive_healing:${request.decision.matchedRule ?? 'mark_node_degraded'}`;
      if (!request.observation.promptRoute.active) {
        const result = activatePromptRouteReducedLatencyMode(reason, REDUCED_LATENCY_MODE_TOKEN_LIMIT);
        actuatorResult = {
          applied: result.applied,
          rolledBack: result.rolledBack,
          reason: result.reason,
          state: result.state
        };
        message = result.reason;
        recoveryOutcome = buildPendingOutcome('Prompt route reduced-latency mitigation activated.');
      } else {
        const result = activatePromptRouteDegradedMode(reason);
        actuatorResult = {
          applied: result.applied,
          rolledBack: result.rolledBack,
          reason: result.reason,
          state: result.state
        };
        message = result.reason;
        recoveryOutcome = buildPendingOutcome('Prompt route degraded-response mitigation activated.');
      }
    } else {
      actuatorResult = {};
      message = 'Unsupported predictive action.';
      recoveryOutcome = {
        status: 'unsupported',
        summary: message
      };
    }

    setActionCooldown(cooldownKey);
    return {
      attempted: true,
      status: 'executed',
      mode,
      action: request.decision.action,
      target: request.decision.target,
      message,
      cooldownRemainingMs: null,
      actuatorResult: actuatorResult as Record<string, unknown>,
      recoveryOutcome
    };
  } catch (error) {
    return {
      attempted: true,
      status: 'failed',
      mode,
      action: request.decision.action,
      target: request.decision.target,
      message: resolveErrorMessage(error),
      cooldownRemainingMs: null,
      actuatorResult: null,
      recoveryOutcome: {
        status: 'failed',
        summary: 'Execution threw before a stable recovery outcome could be measured.'
      }
    };
  }
}

function recordPredictiveRepairFeedback(
  request: PredictiveHealingExecutionRequest,
  execution: PredictiveHealingExecutionResult
): void {
  if (execution.status !== 'executed' && execution.status !== 'failed') {
    return;
  }

  logger.info('self_heal.repair.feedback', {
    module: 'predictive-healing',
    source: request.source,
    action: request.decision.action,
    target: request.decision.target,
    advisor: request.decision.advisor,
    executionStatus: execution.status,
    recoveryStatus: execution.recoveryOutcome.status,
    feedbackSummary: execution.recoveryOutcome.summary
  });
}

function recordPredictiveTelemetry(
  request: PredictiveHealingExecutionRequest,
  decision: PredictiveHealingDecision,
  execution: PredictiveHealingExecutionResult,
  trends: PredictiveHealingTrends
): void {
  if (decision.action !== 'none') {
    recordSelfHealEvent({
      kind: 'trigger',
      source: request.source,
      trigger: 'predictive',
      reason: decision.reason,
      actionTaken: decision.action,
      healedComponent: decision.target ?? null,
      details: {
        confidence: decision.confidence,
        matchedRule: decision.matchedRule,
        trends
      }
    });
  }

  if (
    execution.status === 'dry_run' ||
    execution.status === 'skipped' ||
    execution.status === 'cooldown' ||
    execution.status === 'unsupported' ||
    execution.status === 'refused'
  ) {
    if (decision.action !== 'none') {
      recordSelfHealEvent({
        kind: 'noop',
        source: request.source,
        trigger: 'predictive',
        reason: execution.message,
        actionTaken: decision.action,
        healedComponent: decision.target ?? null,
        details: {
          confidence: decision.confidence,
          matchedRule: decision.matchedRule,
          executionStatus: execution.status
        }
      });
    }
    return;
  }

  if (execution.status === 'executed') {
    recordSelfHealEvent({
      kind: 'attempt',
      source: request.source,
      trigger: 'predictive',
      reason: decision.reason,
      actionTaken: decision.action,
      healedComponent: decision.target ?? null,
      details: {
        confidence: decision.confidence,
        matchedRule: decision.matchedRule,
        executionMode: execution.mode
      }
    });
    recordSelfHealEvent({
      kind: 'success',
      source: request.source,
      trigger: 'predictive',
      reason: execution.message,
      actionTaken: decision.action,
      healedComponent: decision.target ?? null,
      details: {
        confidence: decision.confidence,
        matchedRule: decision.matchedRule,
        recoveryOutcome: execution.recoveryOutcome
      }
    });
    return;
  }

  if (execution.status === 'failed') {
    recordSelfHealEvent({
      kind: 'attempt',
      source: request.source,
      trigger: 'predictive',
      reason: decision.reason,
      actionTaken: decision.action,
      healedComponent: decision.target ?? null,
      details: {
        confidence: decision.confidence,
        matchedRule: decision.matchedRule,
        executionMode: execution.mode
      }
    });
    recordSelfHealEvent({
      kind: 'failure',
      source: request.source,
      trigger: 'predictive',
      reason: execution.message,
      actionTaken: decision.action,
      healedComponent: decision.target ?? null,
      details: {
        confidence: decision.confidence,
        matchedRule: decision.matchedRule
      }
    });
  }
}

function cloneDecision(decision: PredictiveHealingDecision): PredictiveHealingDecision {
  return {
    ...decision,
    details: { ...decision.details }
  };
}

function cloneTrends(trends: PredictiveHealingTrends): PredictiveHealingTrends {
  return {
    ...trends
  };
}

function cloneExecution(execution: PredictiveHealingExecutionResult): PredictiveHealingExecutionResult {
  return {
    ...execution,
    actuatorResult: execution.actuatorResult ? { ...execution.actuatorResult } : null,
    recoveryOutcome: { ...execution.recoveryOutcome }
  };
}

function cloneAuditEntry(entry: PredictiveHealingAuditEntry): PredictiveHealingAuditEntry {
  return {
    ...entry,
    featureFlags: { ...entry.featureFlags },
    observation: cloneObservation(entry.observation),
    trends: cloneTrends(entry.trends),
    decision: cloneDecision(entry.decision),
    execution: cloneExecution(entry.execution)
  };
}

function buildExecutionLogEntry(entry: PredictiveHealingAuditEntry): PredictiveHealingExecutionLogEntry {
  return {
    timestamp: entry.timestamp,
    source: entry.source,
    action: entry.decision.action,
    target: entry.decision.target,
    confidence: entry.decision.confidence,
    matchedRule: entry.decision.matchedRule,
    mode: entry.execution.mode,
    result: entry.execution.status,
    reason: entry.decision.reason,
    outcome: entry.execution.recoveryOutcome.summary,
    recoveryStatus: entry.execution.recoveryOutcome.status
  };
}

function findLastAudit(
  entries: PredictiveHealingAuditEntry[],
  predicate: (entry: PredictiveHealingAuditEntry) => boolean
): PredictiveHealingAuditEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (predicate(entries[index])) {
      return entries[index];
    }
  }

  return null;
}

function buildAutomationStatus(
  state: PredictiveHealingState,
  config: ReturnType<typeof getConfig>
): PredictiveHealingAutomationStatus {
  const lastLoopAudit = findLastAudit(state.recentAudits, (entry) => entry.source === PREDICTIVE_LOOP_SOURCE);
  const lastAutoExecutionAudit = findLastAudit(
    state.recentAudits,
    (entry) => entry.execution.mode === 'auto_execute' && entry.execution.status === 'executed'
  );

  return {
    active: config.predictiveHealingEnabled ?? false,
    autoExecuteReady: Boolean(
      (config.predictiveHealingEnabled ?? false) &&
      (config.autoExecuteHealing ?? false) &&
      !(config.predictiveHealingDryRun ?? true)
    ),
    pollIntervalMs: resolvePredictiveHealingLoopIntervalMs(DEFAULT_LOOP_INTERVAL_MS),
    minConfidence: config.predictiveHealingMinConfidence ?? DEFAULT_MIN_CONFIDENCE,
    cooldownMs: Math.max(10_000, config.predictiveHealingActionCooldownMs ?? DEFAULT_ACTION_COOLDOWN_MS),
    lastLoopDecisionAt: lastLoopAudit?.timestamp ?? null,
    lastLoopAction: lastLoopAudit?.decision.action ?? null,
    lastLoopResult: lastLoopAudit?.execution.status ?? null,
    lastAutoExecutionAt: lastAutoExecutionAudit?.timestamp ?? null,
    lastAutoExecutionAction: lastAutoExecutionAudit?.decision.action ?? null,
    lastAutoExecutionResult: lastAutoExecutionAudit?.execution.status ?? null
  };
}

function buildPredictiveHealingAuditLogMetadata(entry: PredictiveHealingAuditEntry): Record<string, unknown> {
  return {
    featureFlags: { ...entry.featureFlags },
    observation: {
      collectedAt: entry.observation.collectedAt,
      windowMs: entry.observation.windowMs,
      requestCount: entry.observation.requestCount,
      errorRate: entry.observation.errorRate,
      timeoutRate: entry.observation.timeoutRate,
      avgLatencyMs: entry.observation.avgLatencyMs,
      p95LatencyMs: entry.observation.p95LatencyMs,
      maxLatencyMs: entry.observation.maxLatencyMs,
      degradedCount: entry.observation.degradedCount,
      workerHealth: {
        overallStatus: entry.observation.workerHealth.overallStatus,
        alertCount: entry.observation.workerHealth.alertCount,
        pending: entry.observation.workerHealth.pending,
        running: entry.observation.workerHealth.running,
        stalledRunning: entry.observation.workerHealth.stalledRunning,
        unhealthyWorkerIds: [...entry.observation.workerHealth.unhealthyWorkerIds],
        degradedWorkerIds: [...entry.observation.workerHealth.degradedWorkerIds]
      },
      memory: { ...entry.observation.memory },
      promptRoute: { ...entry.observation.promptRoute },
      trinity: {
        activeStage: entry.observation.trinity.activeStage,
        activeAction: entry.observation.trinity.activeAction,
        verified: entry.observation.trinity.verified
      }
    },
    trends: cloneTrends(entry.trends),
    decision: cloneDecision(entry.decision),
    execution: cloneExecution(entry.execution)
  };
}

function maybeLogPredictiveHealingAudit(entry: PredictiveHealingAuditEntry): void {
  const context = {
    module: 'predictive-healing',
    operation: 'decision',
    source: entry.source
  };
  const metadata = buildPredictiveHealingAuditLogMetadata(entry);

  if (entry.execution.status === 'failed') {
    logger.error('predictive_healing.audit', context, metadata);
    return;
  }

  if (
    entry.decision.action !== 'none' &&
    (entry.execution.status === 'cooldown' ||
      entry.execution.status === 'unsupported' ||
      entry.execution.status === 'refused')
  ) {
    logger.warn('predictive_healing.audit', context, metadata);
    return;
  }

  logger.info('predictive_healing.audit', context, metadata);
}

async function collectLiveObservation(source: string): Promise<PredictiveHealingObservation> {
  const config = getConfig();
  let workerHealth: WorkerControlHealthResponse | null = null;
  let workerHealthError: string | null = null;

  try {
    workerHealth = await getWorkerControlHealth();
  } catch (error) {
    workerHealthError = resolveErrorMessage(error);
  }

  return buildObservationFromSources({
    source,
    requestWindow: runtimeDiagnosticsService.getRollingRequestWindow(
      config.predictiveHealingWindowMs ?? DEFAULT_WINDOW_MS
    ),
    workerHealth,
    workerRuntime: getWorkerRuntimeStatus(),
    promptRouteMitigation: getPromptRouteMitigationState(),
    trinityStatus: getTrinitySelfHealingStatus(),
    memoryUsage: process.memoryUsage(),
    workerHealthError
  });
}

export async function runPredictiveHealingDecision(params: {
  source: string;
  execute?: boolean;
  allowAutoExecute?: boolean;
  dryRun?: boolean;
  simulate?: PredictiveHealingSimulationInput;
  observation?: PredictiveHealingObservation;
}): Promise<PredictiveHealingDecisionResult> {
  const config = getConfig();
  const state = getState();
  const featureFlags = {
    enabled: config.predictiveHealingEnabled ?? false,
    dryRun: params.dryRun ?? config.predictiveHealingDryRun ?? true,
    autoExecute: config.autoExecuteHealing ?? false
  };

  const liveObservation = params.observation ?? (await collectLiveObservation(params.source));
  const observation = applySimulation(liveObservation, params.simulate);
  const history = collectRecentObservations(state, observation);
  const { decision: rulesDecision, trends, candidates } = evaluatePredictiveHealingRules({
    observation,
    history
  });
  const decision = await resolveAiDecision({
    source: params.source,
    observation,
    trends,
    rulesDecision,
    candidates,
    minConfidence: getRulesConfig().minConfidence,
    config
  });

  const executionRequest: PredictiveHealingExecutionRequest = {
    source: params.source,
    observation,
    decision: {
      ...decision,
      suggestedMode: resolveExecutionMode({
        source: params.source,
        observation,
        decision,
        executeRequested: Boolean(params.execute),
        allowAutoExecute: Boolean(
          params.allowAutoExecute && (config.predictiveHealingEnabled ?? false) && (config.autoExecuteHealing ?? false)
        ),
        dryRunOverride: params.dryRun
      })
    },
    executeRequested: Boolean(params.execute),
    allowAutoExecute: Boolean(
      params.allowAutoExecute && (config.predictiveHealingEnabled ?? false) && (config.autoExecuteHealing ?? false)
    ),
    dryRunOverride: params.dryRun
  };
  const execution = await executeDecision(executionRequest);
  recordPredictiveRepairFeedback(executionRequest, execution);
  recordPredictiveTelemetry(executionRequest, executionRequest.decision, execution, trends);

  const auditEntry: PredictiveHealingAuditEntry = {
    id: `predictive_heal_audit_${state.nextAuditSequence}`,
    timestamp: observation.collectedAt,
    source: params.source,
    featureFlags,
    observation: cloneObservation(observation),
    trends: cloneTrends(trends),
    decision: cloneDecision(executionRequest.decision),
    execution: cloneExecution(execution)
  };

  state.nextAuditSequence += 1;
  state.recentAudits.push(auditEntry);
  const auditHistoryLimit = Math.max(5, config.predictiveHealingAuditHistoryLimit ?? DEFAULT_AUDIT_HISTORY_LIMIT);
  if (state.recentAudits.length > auditHistoryLimit) {
    state.recentAudits.splice(0, state.recentAudits.length - auditHistoryLimit);
  }
  maybeLogPredictiveHealingAudit(auditEntry);

  return {
    source: params.source,
    featureFlags,
    observation: cloneObservation(observation),
    trends: cloneTrends(trends),
    decision: cloneDecision(executionRequest.decision),
    execution: cloneExecution(execution),
    auditEntry: cloneAuditEntry(auditEntry)
  };
}

export async function runPredictiveHealingFromLoop(params: {
  source: string;
  observation: {
      requestWindow: RequestWindowSnapshot;
      workerHealth: WorkerControlHealthResponse | null;
      workerRuntime: WorkerRuntimeStatus;
      trinityStatus: ReturnType<typeof getTrinitySelfHealingStatus>;
      collectedAt?: string;
      workerHealthError?: string | null;
  };
}): Promise<PredictiveHealingDecisionResult> {
  const loopObservation = buildObservationFromSources({
    source: params.source,
    requestWindow: params.observation.requestWindow,
    workerHealth: params.observation.workerHealth,
    workerRuntime: params.observation.workerRuntime,
    promptRouteMitigation: getPromptRouteMitigationState(),
    trinityStatus: params.observation.trinityStatus,
    memoryUsage: process.memoryUsage(),
    collectedAt: params.observation.collectedAt,
    workerHealthError: params.observation.workerHealthError ?? null
  });

  return runPredictiveHealingDecision({
    source: params.source,
    observation: loopObservation,
    allowAutoExecute: true
  });
}

export function buildPredictiveHealingAIProviderStatusSnapshot(): PredictiveHealingAIProviderStatusSnapshot {
  const state = getState();
  return cloneAiProviderStatus(buildAiProviderStatusSnapshot(getOpenAIServiceHealth(), state.aiProvider));
}

export async function probePredictiveHealingAIProvider(): Promise<PredictiveHealingAIProviderProbeSnapshot> {
  const performedAt = new Date().toISOString();
  const serviceHealth = getOpenAIServiceHealth();
  const model = getFallbackModel();
  const baseSnapshot = buildAiProviderStatusSnapshot(serviceHealth, {
    model,
    lastAttemptAt: performedAt
  });
  const { client } = getOpenAIClientOrAdapter();

  if (!serviceHealth.apiKey.configured || !client) {
    const failure = classifyProviderFailure(new Error('openai_client_unavailable'));
    return {
      performedAt,
      ...baseSnapshot,
      reachable: failure.reachable,
      authenticated: failure.authenticated,
      completionHealthy: failure.completionHealthy,
      failureReason: failure.reason,
      failureCategory: failure.category,
      failureStatus: failure.status
    };
  }

  try {
    await runWithTimeout(
      () => client.models.list({ page: 1 } as any),
      4_000,
      'OpenAI model-list probe timed out after 4000ms'
    );
  } catch (error) {
    const failure = classifyProviderFailure(error);
    return {
      performedAt,
      ...baseSnapshot,
      reachable: failure.reachable,
      authenticated: failure.authenticated,
      completionHealthy: false,
      failureReason: failure.reason,
      failureCategory: failure.category,
      failureStatus: failure.status
    };
  }

  try {
    await createSingleChatCompletion(client, {
      model,
      messages: [{ role: 'user', content: 'Reply with exactly ok.' }],
      max_completion_tokens: 16,
      timeoutMs: 6_000
    });

    const successHealth = getOpenAIServiceHealth();
    return {
      performedAt,
      ...buildAiProviderStatusSnapshot(successHealth, {
        model,
        lastAttemptAt: performedAt,
        lastSuccessAt: performedAt,
        reachable: true,
        authenticated: true,
        completionHealthy: true
      }),
      failureReason: null,
      failureCategory: null,
      failureStatus: null
    };
  } catch (error) {
    const failure = classifyProviderFailure(error);
    const failureHealth = getOpenAIServiceHealth();
    return {
      performedAt,
      ...buildAiProviderStatusSnapshot(failureHealth, {
        model,
        lastAttemptAt: performedAt,
        reachable: true,
        authenticated: true,
        completionHealthy: false,
        lastFailureAt: performedAt,
        lastFailureReason: failure.reason,
        lastFailureCategory: failure.category,
        lastFailureStatus: failure.status
      }),
      reachable: failure.reachable ?? true,
      authenticated: failure.authenticated ?? true,
      completionHealthy: false,
      failureReason: failure.reason,
      failureCategory: failure.category,
      failureStatus: failure.status
    };
  }
}

export function buildPredictiveHealingStatusSnapshot(): PredictiveHealingStatusSnapshot {
  const config = getConfig();
  const state = getState();
  const lastAudit = state.recentAudits.length > 0 ? state.recentAudits[state.recentAudits.length - 1] : null;
  const lastObservation = state.recentObservations.length > 0
    ? state.recentObservations[state.recentObservations.length - 1]
    : null;
  const automation = buildAutomationStatus(state, config);
  const recentExecutionLog = state.recentAudits
    .slice(-DEFAULT_EXECUTION_LOG_LIMIT)
    .map((entry) => buildExecutionLogEntry(entry));

  return {
    enabled: config.predictiveHealingEnabled ?? false,
    dryRun: config.predictiveHealingDryRun ?? true,
    autoExecute: config.autoExecuteHealing ?? false,
    lastObservedAt: lastObservation?.collectedAt ?? null,
    lastDecisionAt: lastAudit?.timestamp ?? null,
    lastAction: lastAudit?.decision.action ?? null,
    lastResult: lastAudit?.execution.status ?? null,
    lastMatchedRule: lastAudit?.decision.matchedRule ?? null,
    recentAuditCount: state.recentAudits.length,
    recentAudits: state.recentAudits.map((entry) => cloneAuditEntry(entry)),
    recentObservations: state.recentObservations.map((entry) => cloneObservation(entry)),
    cooldowns: snapshotCooldowns(),
    automation,
    recentExecutionLog,
    detailsPath: '/api/self-heal/decide',
    actuator: buildWorkerRepairActuatorStatus(),
    advisors: [...DEFAULT_ADVISORS],
    aiProvider: buildPredictiveHealingAIProviderStatusSnapshot()
  };
}

function hasLivePredictiveHealingLoad(observation: PredictiveHealingObservation): boolean {
  return (
    observation.requestCount > 0 ||
    observation.errorRate > 0 ||
    observation.timeoutRate > 0 ||
    observation.degradedCount > 0 ||
    observation.workerHealth.pending > 0 ||
    observation.workerHealth.running > 0 ||
    observation.workerHealth.alertCount > 0 ||
    observation.workerHealth.stalledRunning > 0 ||
    observation.inactivity?.inactiveDegraded === true ||
    Boolean(observation.trinity.activeAction)
  );
}

function buildWorkerInactivityObservation(params: {
  workers: PredictiveHealingObservation['workerHealth']['workers'];
  alerts: string[];
  requestCount: number;
  pending: number;
  stalledRunning: number;
  idleThresholdMs: number | null;
}): NonNullable<PredictiveHealingObservation['inactivity']> {
  const idleWorkers = params.workers
    .filter((worker) => worker.currentJobId === null)
    .filter((worker) => {
      const inactivityMs = worker.inactivityMs ?? null;
      const thresholdMs = worker.watchdog?.idleThresholdMs ?? params.idleThresholdMs;
      return typeof inactivityMs === 'number' && typeof thresholdMs === 'number' && inactivityMs >= thresholdMs;
    });
  const relevantWorkers = idleWorkers.length > 0
    ? idleWorkers
    : params.workers.filter((worker) => worker.watchdog?.restartRecommended === true);
  const worstWorker = relevantWorkers.reduce<typeof relevantWorkers[number] | null>((selected, worker) => {
    if (!selected) {
      return worker;
    }
    return (worker.inactivityMs ?? 0) > (selected.inactivityMs ?? 0) ? worker : selected;
  }, null);
  const maxInactivityMs = worstWorker?.inactivityMs ?? 0;
  const idleThresholdMs = worstWorker?.watchdog?.idleThresholdMs ?? params.idleThresholdMs;
  const alertReason =
    params.alerts.find((alert) => /no worker activity|no worker receipts|watchdog triggered/i.test(alert)) ?? null;
  const inactiveDegraded =
    relevantWorkers.length > 0 &&
    (params.requestCount === 0 || params.pending > 0 || params.stalledRunning > 0);

  return {
    inactiveDegraded,
    reason: inactiveDegraded
      ? alertReason ??
        (params.pending > 0 || params.stalledRunning > 0
          ? `No worker activity for ${maxInactivityMs}ms while queue work remained pending.`
          : `No worker receipts or processed jobs observed for ${maxInactivityMs}ms.`)
      : null,
    idleThresholdMs: idleThresholdMs ?? null,
    maxInactivityMs,
    lastActivityAt: worstWorker?.lastActivityAt ?? null,
    lastProcessedJobAt: worstWorker?.lastProcessedJobAt ?? null,
    workerIds: relevantWorkers.map((worker) => worker.workerId).sort()
  };
}

function resolvePredictiveHealingAiCooldownWindow(params: {
  observation: PredictiveHealingObservation;
  providerStatus: PredictiveHealingAIProviderStatusSnapshot;
  config: ReturnType<typeof getConfig>;
  nowMs?: number;
}): PredictiveHealingAiCooldownWindow | null {
  const nowMs = params.nowMs ?? Date.now();
  const liveLoadSignal = hasLivePredictiveHealingLoad(params.observation);
  const lastAttemptAtMs = Date.parse(params.providerStatus.lastAttemptAt ?? '');
  if (!Number.isFinite(lastAttemptAtMs)) {
    return null;
  }

  const providerFailureBackoffActive =
    String(params.providerStatus.circuitBreakerState).toUpperCase() === 'OPEN' ||
    params.providerStatus.lastFailureCategory === 'authentication' ||
    params.providerStatus.lastFailureCategory === 'insufficient_quota' ||
    params.providerStatus.lastFailureCategory === 'circuit_open';
  const failureAnchorMs = Date.parse(params.providerStatus.lastFailureAt ?? '');
  const cooldownAnchorMs =
    providerFailureBackoffActive && Number.isFinite(failureAnchorMs) ? failureAnchorMs : lastAttemptAtMs;
  const cooldownMs = providerFailureBackoffActive
    ? Math.max(60_000, params.config.predictiveHealingAiFailureCooldownMs ?? DEFAULT_AI_FAILURE_COOLDOWN_MS)
    : liveLoadSignal
      ? Math.max(60_000, params.config.predictiveHealingAiActiveCooldownMs ?? DEFAULT_AI_ACTIVE_COOLDOWN_MS)
      : Math.max(60_000, params.config.predictiveHealingAiIdleCooldownMs ?? DEFAULT_AI_IDLE_COOLDOWN_MS);
  const cooldownUntilMs = cooldownAnchorMs + cooldownMs;
  if (cooldownUntilMs <= nowMs) {
    return null;
  }

  return {
    reason: providerFailureBackoffActive
      ? 'provider_failure_backoff'
      : liveLoadSignal
        ? 'active_incident_backoff'
        : 'idle_window_backoff',
    cooldownMs,
    remainingMs: cooldownUntilMs - nowMs,
    cooldownUntil: new Date(cooldownUntilMs).toISOString(),
    liveLoadSignal
  };
}

export function buildPredictiveHealingCompactSummary(
  snapshot: PredictiveHealingStatusSnapshot
): PredictiveHealingCompactSummary {
  return {
    enabled: snapshot.enabled,
    dryRun: snapshot.dryRun,
    autoExecute: snapshot.autoExecute,
    autoExecuteReady: snapshot.automation.autoExecuteReady,
    lastObservedAt: snapshot.lastObservedAt,
    lastDecisionAt: snapshot.lastDecisionAt,
    lastAction: snapshot.lastAction,
    lastResult: snapshot.lastResult,
    lastAutoExecutionAt: snapshot.automation.lastAutoExecutionAt,
    lastAutoExecutionResult: snapshot.automation.lastAutoExecutionResult,
    recentAuditCount: snapshot.recentAuditCount,
    detailsPath: snapshot.detailsPath
  };
}

export function resetPredictiveHealingStateForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    return;
  }

  const runtime = globalThis as PredictiveHealingGlobal;
  runtime[GLOBAL_KEY] = createInitialState();
}
