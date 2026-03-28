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
import { resolvePredictiveHealingLoopIntervalMs } from './runtimeConfig.js';
import { recordSelfHealEvent } from './selfHealTelemetry.js';
import {
  buildWorkerRepairActuatorStatus,
  executeWorkerRepairActuator,
  type WorkerRepairActuatorStatus
} from './workerRepairActuator.js';

export type PredictiveHealingActionType =
  | 'none'
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
    }>;
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
    }>;
  }>;
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

function createInitialState(): PredictiveHealingState {
  return {
    nextAuditSequence: 1,
    recentObservations: [],
    recentAudits: [],
    actionCooldowns: new Map()
  };
}

function getState(): PredictiveHealingState {
  const runtime = globalThis as PredictiveHealingGlobal;
  if (!runtime[GLOBAL_KEY]) {
    runtime[GLOBAL_KEY] = createInitialState();
  }
  return runtime[GLOBAL_KEY];
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
        currentJobId: worker.currentJobId ?? null
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
            currentJobId: worker.currentJobId ?? null
          }))
        : base.workerHealth.workers
    },
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
}): Promise<PredictiveHealingDecision> {
  const actuator = buildWorkerRepairActuatorStatus();
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
    const fallbackReason = 'openai_client_unavailable';
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
      fallbackAdvisor: 'rules_fallback_v1'
    });
    return buildFallbackDecision(params.rulesDecision, fallbackReason, {
      actuatorMode: actuator.mode,
      actuatorPath: actuator.path,
      actuatorBaseUrl: actuator.baseUrl
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
      bypassedSubsystems: aiResult.bypassedSubsystems ?? []
    });

    return decision;
  } catch (error) {
    const fallbackReason = resolveErrorMessage(error);
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
      fallbackAdvisor: 'rules_fallback_v1'
    });
    return buildFallbackDecision(params.rulesDecision, fallbackReason, {
      actuatorMode: actuator.mode,
      actuatorPath: actuator.path,
      actuatorBaseUrl: actuator.baseUrl
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

    if (request.decision.action === 'scale_workers_up') {
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
    minConfidence: getRulesConfig().minConfidence
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
    advisors: [...DEFAULT_ADVISORS]
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
