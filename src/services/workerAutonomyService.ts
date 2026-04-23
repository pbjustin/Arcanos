import type { JobData } from '@core/db/schema.js';
import {
  cleanupExpiredGptJobs,
  getJobExecutionStatsSince,
  getJobQueueSummary,
  recordJobHeartbeat,
  recoverStalledJobsForWorkers,
  recoverStaleJobs,
  scheduleJobRetry,
  updateJob,
  type ClaimNextPendingJobOptions,
  type CreateJobOptions,
  type JobExecutionStats,
  type JobQueueSummary,
  type RecoverStaleJobsResult
} from '@core/db/repositories/jobRepository.js';
import { computeGptJobLifecycleDeadlines } from '@shared/gpt/gptJobLifecycle.js';
import {
  listWorkerRuntimeSnapshots,
  upsertWorkerRuntimeSnapshot,
  type WorkerRuntimeSnapshotRecord
} from '@core/db/repositories/workerRuntimeRepository.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import {
  recordDependencyCall,
  recordWorkerRecoveredJobs,
  recordWorkerStaleDetection,
  recordWorkerStalledJobs
} from '@platform/observability/appMetrics.js';
import { logger } from '@platform/logging/structuredLogging.js';

export type WorkerAutonomyHealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'offline';

export interface WorkerAutonomySettings {
  workerId: string;
  statsWorkerId?: string;
  workerType: 'async_queue';
  heartbeatIntervalMs: number;
  leaseMs: number;
  inspectorIntervalMs: number;
  watchdogIntervalMs?: number;
  staleAfterMs: number;
  watchdogIdleMs: number;
  stalledJobAction?: 'requeue' | 'dead_letter';
  defaultMaxRetries: number;
  retryBackoffBaseMs: number;
  retryBackoffMaxMs: number;
  maxJobsPerHour: number;
  maxAiCallsPerHour: number;
  maxRssMb: number;
  queueDepthDeferralThreshold: number;
  queueDepthDeferralMs: number;
  failureWebhookUrl: string | null;
  failureWebhookThreshold: number;
  failureWebhookCooldownMs: number;
}

export interface PlannedWorkerJobOptions extends CreateJobOptions {
  planningReasons: string[];
}

export interface WorkerAutonomyBudgetResult {
  allowed: boolean;
  sleepMs: number;
  reason: string | null;
  stats: JobExecutionStats;
  rssMb: number;
}

export interface WorkerAutonomyHealthReport {
  timestamp: string;
  overallStatus: WorkerAutonomyHealthStatus;
  queueSummary: JobQueueSummary | null;
  workers: WorkerRuntimeSnapshotRecord[];
  alerts: string[];
  settings: Pick<
    WorkerAutonomySettings,
    | 'heartbeatIntervalMs'
    | 'leaseMs'
    | 'inspectorIntervalMs'
    | 'watchdogIntervalMs'
    | 'staleAfterMs'
    | 'watchdogIdleMs'
    | 'defaultMaxRetries'
    | 'maxJobsPerHour'
    | 'maxAiCallsPerHour'
    | 'maxRssMb'
  >;
}

interface WorkerInactivitySignal {
  detected: boolean;
  reason: string | null;
  inactivityMs: number | null;
  lastActivityAt: string | null;
  lastProcessedJobAt: string | null;
}

export interface WorkerBootstrapResult {
  recovered: RecoverStaleJobsResult;
  healthStatus: WorkerAutonomyHealthStatus;
  alerts: string[];
}

export interface WorkerInspectionResult {
  recovered: RecoverStaleJobsResult;
  stalledRecovery: {
    staleWorkers: number;
    stalledJobs: number;
    requeuedJobs: number;
    deadLetterJobs: number;
    cancelledJobs: number;
  };
  cleaned: {
    expiredPending: number;
    expiredTerminal: number;
    deletedExpired: number;
  };
  queueSummary: JobQueueSummary | null;
  stats: JobExecutionStats;
  healthStatus: WorkerAutonomyHealthStatus;
  alerts: string[];
}

interface RuntimeSnapshotState {
  currentJobId: string | null;
  lastError: string | null;
  lastHeartbeatAt: string | null;
  lastInspectorRunAt: string | null;
  lastWatchdogRunAt: string | null;
  lastActivityAt: string | null;
  lastProcessedJobAt: string | null;
  watchdogTriggeredAt: string | null;
  watchdogReason: string | null;
  processedJobs: number;
  scheduledRetries: number;
  terminalFailures: number;
  recoveredJobs: number;
  staleWorkersDetected: number;
  stalledJobsDetected: number;
  deadLetterJobs: number;
  recoveryActions: number;
  maxObservedQueueDepth: number;
  lastBudgetPauseReason: string | null;
  lastRecoveryActionAt: string | null;
}

interface WorkerSnapshotContext {
  queueSummary?: JobQueueSummary | null;
  stats?: JobExecutionStats;
  healthStatus: WorkerAutonomyHealthStatus;
  alerts: string[];
  watchdogState?: WorkerWatchdogState;
}

interface WorkerSnapshotPersistOptions {
  force?: boolean;
  source?: string;
}

interface WorkerWatchdogState {
  triggered: boolean;
  reason: string | null;
  inactivityMs: number | null;
  lastActivityAt: string | null;
  lastProcessedJobAt: string | null;
  lastHeartbeatAt: string | null;
  stale: boolean;
  staleAfterMs: number;
  idleThresholdMs: number;
  restartRecommended: boolean;
}

const WORKER_RUNTIME_SNAPSHOT_MIN_INTERVAL_MS = 30_000;
const WORKER_RUNTIME_SNAPSHOT_SLOW_LOG_MIN_MS = 250;

const DEFAULT_AUTONOMY_SETTINGS: WorkerAutonomySettings = {
  workerId: process.env.JOB_WORKER_ID?.trim() || process.env.WORKER_ID?.trim() || 'async-queue',
  statsWorkerId:
    process.env.JOB_WORKER_STATS_ID?.trim() ||
    process.env.JOB_WORKER_ID?.trim() ||
    process.env.WORKER_ID?.trim() ||
    'async-queue',
  workerType: 'async_queue',
  heartbeatIntervalMs: readNumberEnv('JOB_WORKER_HEARTBEAT_MS', 5_000),
  leaseMs: readNumberEnv('JOB_WORKER_LEASE_MS', 15_000),
  inspectorIntervalMs: readNumberEnv('JOB_WORKER_INSPECTOR_MS', 30_000),
  watchdogIntervalMs: readNumberEnv('JOB_WORKER_WATCHDOG_MS', 5_000),
  staleAfterMs: readNumberEnv('JOB_WORKER_STALE_AFTER_MS', 10_000),
  watchdogIdleMs: readNumberEnv('JOB_WORKER_WATCHDOG_IDLE_MS', 120_000),
  stalledJobAction:
    process.env.JOB_WORKER_STALLED_JOB_ACTION?.trim().toLowerCase() === 'dead_letter'
      ? 'dead_letter'
      : 'requeue',
  defaultMaxRetries: readNumberEnv('JOB_WORKER_MAX_RETRIES', 2),
  retryBackoffBaseMs: readNumberEnv('JOB_WORKER_RETRY_BASE_MS', 2_000),
  retryBackoffMaxMs: readNumberEnv('JOB_WORKER_RETRY_MAX_MS', 60_000),
  maxJobsPerHour: readNumberEnv('JOB_WORKER_MAX_JOBS_PER_HOUR', 120),
  maxAiCallsPerHour: readNumberEnv('JOB_WORKER_MAX_AI_CALLS_PER_HOUR', 120),
  maxRssMb: readNumberEnv('JOB_WORKER_MAX_RSS_MB', 2_048),
  queueDepthDeferralThreshold: readNumberEnv('JOB_WORKER_PLAN_QUEUE_THRESHOLD', 25),
  queueDepthDeferralMs: readNumberEnv('JOB_WORKER_PLAN_DEFER_MS', 5_000),
  failureWebhookUrl: process.env.WORKER_FAILURE_WEBHOOK_URL?.trim() || null,
  failureWebhookThreshold: readNumberEnv('JOB_WORKER_FAILURE_WEBHOOK_THRESHOLD', 3),
  failureWebhookCooldownMs: readNumberEnv('JOB_WORKER_FAILURE_WEBHOOK_COOLDOWN_MS', 300_000)
};

const failureWebhookHistory = new Map<string, number>();

function readNumberEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];
  const parsed = rawValue ? Number(rawValue) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Load the async worker autonomy settings.
 * Purpose: centralize environment-driven autonomy policy for queue planning and worker recovery.
 * Inputs/outputs: optional overrides plus an optional worker id override; returns normalized settings.
 * Edge case behavior: invalid or missing env values fall back to safe defaults.
 */
export function getWorkerAutonomySettings(
  overrides: Partial<WorkerAutonomySettings> = {}
): WorkerAutonomySettings {
  return {
    ...DEFAULT_AUTONOMY_SETTINGS,
    ...overrides
  };
}

/**
 * Plan queue metadata for a newly created worker job.
 * Purpose: let the system defer low-priority work when the queue is saturated and attach default retry limits.
 * Inputs/outputs: accepts a job type, raw payload, and optional overrides; returns create-job options plus planning reasons.
 * Edge case behavior: queue-summary failures degrade to default priority without blocking enqueue.
 */
export async function planAutonomousWorkerJob(
  jobType: string,
  input: unknown,
  overrides: Partial<CreateJobOptions> = {},
  settings: WorkerAutonomySettings = getWorkerAutonomySettings()
): Promise<PlannedWorkerJobOptions> {
  const queueSummary = await getJobQueueSummary();
  const planningReasons: string[] = [];
  const basePriority = overrides.priority ?? determineJobPriority(jobType, input);
  let priority = basePriority;
  let nextRunAt = overrides.nextRunAt;

  //audit Assumption: low-priority work can be deferred briefly when queue pressure is high; failure risk: saturation starves new interactive jobs; expected invariant: deferred jobs remain queued with an explicit reason; handling strategy: schedule a short delay once the queue exceeds the configured threshold.
  if (
    queueSummary &&
    queueSummary.pending >= settings.queueDepthDeferralThreshold &&
    basePriority >= 100 &&
    !nextRunAt
  ) {
    nextRunAt = new Date(Date.now() + settings.queueDepthDeferralMs);
    priority += 10;
    planningReasons.push('queue_depth_deferred');
  }

  const autonomyState = {
    planner: {
      createdAt: new Date().toISOString(),
      reasons: planningReasons,
      queuePendingAtPlanTime: queueSummary?.pending ?? null,
      queueDelayedAtPlanTime: queueSummary?.delayed ?? null,
      assignedPriority: priority,
      scheduledFor: nextRunAt ? new Date(nextRunAt).toISOString() : null
    }
  };

  return {
    status: overrides.status ?? 'pending',
    retryCount: overrides.retryCount ?? 0,
    maxRetries: overrides.maxRetries ?? settings.defaultMaxRetries,
    nextRunAt,
    startedAt: overrides.startedAt ?? null,
    lastHeartbeatAt: overrides.lastHeartbeatAt ?? null,
    leaseExpiresAt: overrides.leaseExpiresAt ?? null,
    priority,
    lastWorkerId: overrides.lastWorkerId ?? null,
    autonomyState,
    planningReasons
  };
}

/**
 * Build a cross-instance worker health report.
 * Purpose: expose queue-worker health, snapshots, and operator alerts through HTTP and AI tools.
 * Inputs/outputs: optional settings override; returns a summarized autonomy health report.
 * Edge case behavior: no persisted workers result in an `offline` status unless queue pressure suggests degraded state instead.
 */
export async function getWorkerAutonomyHealthReport(
  settings: WorkerAutonomySettings = getWorkerAutonomySettings()
): Promise<WorkerAutonomyHealthReport> {
  const [queueSummary, rawWorkers] = await Promise.all([
    getJobQueueSummary(),
    listWorkerRuntimeSnapshots()
  ]);
  const workers = filterLegacyAggregateWorkerSnapshots(rawWorkers);
  const alerts: string[] = [];

  if (queueSummary?.stalledRunning) {
    alerts.push(`Detected ${queueSummary.stalledRunning} stalled running job(s).`);
  }
  if (queueSummary && queueSummary.pending >= settings.queueDepthDeferralThreshold) {
    alerts.push(`Queue pressure is elevated (pending=${queueSummary.pending}).`);
  }
  for (const worker of workers) {
    const watchdog = readWatchdogState(worker);
    if (watchdog?.triggered && watchdog.reason) {
      alerts.push(`Worker ${worker.workerId} watchdog triggered: ${watchdog.reason}`);
    } else if (watchdog?.restartRecommended && watchdog.reason) {
      alerts.push(`Worker ${worker.workerId} inactive: ${watchdog.reason}`);
    }
  }

  const overallStatus = deriveOverallHealthStatus(queueSummary, workers, alerts);

  return {
    timestamp: new Date().toISOString(),
    overallStatus,
    queueSummary,
    workers,
    alerts,
    settings: {
      heartbeatIntervalMs: settings.heartbeatIntervalMs,
      leaseMs: settings.leaseMs,
      inspectorIntervalMs: settings.inspectorIntervalMs,
      watchdogIntervalMs: settings.watchdogIntervalMs,
      staleAfterMs: settings.staleAfterMs,
      watchdogIdleMs: settings.watchdogIdleMs,
      defaultMaxRetries: settings.defaultMaxRetries,
      maxJobsPerHour: settings.maxJobsPerHour,
      maxAiCallsPerHour: settings.maxAiCallsPerHour,
      maxRssMb: settings.maxRssMb
    }
  };
}

/**
 * Runtime coordinator for the async DB-backed worker.
 * Purpose: own bootstrap recovery, heartbeats, retries, queue inspections, and persisted worker snapshots.
 * Inputs/outputs: constructed with normalized autonomy settings; methods return recovery, budget, and retry decisions.
 * Edge case behavior: persistence failures are logged but do not stop the worker loop unless queue DB access itself is unavailable.
 */
export class WorkerAutonomyService {
  private readonly settings: WorkerAutonomySettings;
  private readonly startedAt: string;
  private readonly state: RuntimeSnapshotState;
  private lastSnapshotPersistedAtMs = 0;

  constructor(settings: WorkerAutonomySettings = getWorkerAutonomySettings()) {
    this.settings = settings;
    this.startedAt = new Date().toISOString();
    this.state = {
      currentJobId: null,
      lastError: null,
      lastHeartbeatAt: null,
      lastInspectorRunAt: null,
      lastWatchdogRunAt: null,
      lastActivityAt: this.startedAt,
      lastProcessedJobAt: null,
      watchdogTriggeredAt: null,
      watchdogReason: null,
      processedJobs: 0,
      scheduledRetries: 0,
      terminalFailures: 0,
      recoveredJobs: 0,
      staleWorkersDetected: 0,
      stalledJobsDetected: 0,
      deadLetterJobs: 0,
      recoveryActions: 0,
      maxObservedQueueDepth: 0,
      lastBudgetPauseReason: null,
      lastRecoveryActionAt: null
    };
  }

  /**
   * Return the worker id used for queue claims and persisted snapshots.
   * Purpose: keep worker identity consistent across retries, leases, and health reporting.
   * Inputs/outputs: no inputs, returns the configured queue worker id.
   * Edge case behavior: falls back to a stable default when env overrides are absent.
   */
  getWorkerId(): string {
    return this.settings.workerId;
  }

  /**
   * Return the shared stats identity used for budgets and alert cooldowns.
   * Purpose: let multiple queue-consumer slots share one budget namespace while keeping distinct lease ids.
   * Inputs/outputs: no inputs, returns the configured stats worker id or the slot worker id fallback.
   * Edge case behavior: blank overrides degrade to the slot worker id instead of returning an empty string.
   */
  getStatsWorkerId(): string {
    const normalizedStatsWorkerId = this.settings.statsWorkerId?.trim();
    return normalizedStatsWorkerId && normalizedStatsWorkerId.length > 0
      ? normalizedStatsWorkerId
      : this.settings.workerId;
  }

  /**
   * Return claim options shared by the worker loop and heartbeat calls.
   * Purpose: avoid drift between the lease duration used at claim time and subsequent heartbeats.
   * Inputs/outputs: no inputs, returns normalized claim options.
   * Edge case behavior: always includes a non-empty worker id and positive lease duration.
   */
  getClaimOptions(): ClaimNextPendingJobOptions {
    return {
      workerId: this.settings.workerId,
      leaseMs: this.settings.leaseMs
    };
  }

  getHeartbeatIntervalMs(): number {
    return this.settings.heartbeatIntervalMs;
  }

  getWatchdogIntervalMs(): number {
    return this.settings.watchdogIntervalMs ?? this.settings.heartbeatIntervalMs;
  }

  /**
   * Run startup recovery before the worker starts claiming new jobs.
   * Purpose: heal stale queue rows, persist an initial snapshot, and surface degraded prerequisites early.
   * Inputs/outputs: optional bootstrap notes; returns recovery details and the derived health status.
   * Edge case behavior: recovery errors are logged and reflected in the persisted snapshot before being rethrown.
   */
  async bootstrap(notes: string[] = []): Promise<WorkerBootstrapResult> {
    try {
      const inspection = await this.inspect('bootstrap', notes, { source: 'inspector' });
      return {
        recovered: inspection.recovered,
        healthStatus: inspection.healthStatus,
        alerts: inspection.alerts
      };
    } catch (error: unknown) {
      const message = resolveErrorMessage(error);
      this.state.lastError = message;
      await this.persistSnapshot({
        healthStatus: 'unhealthy',
        alerts: [`Bootstrap failed: ${message}`]
      }, { force: true, source: 'bootstrap' });
      throw error;
    }
  }

  /**
   * Run the periodic inspector loop.
   * Purpose: recover stale jobs, refresh queue health, and emit failure webhooks when the worker drifts unhealthy.
   * Inputs/outputs: accepts an inspector reason and optional notes; returns the full inspection result.
   * Edge case behavior: stale jobs over the retry limit are terminally failed instead of re-queued.
   */
  async inspect(
    reason: string,
    notes: string[] = [],
    options: WorkerSnapshotPersistOptions = {}
  ): Promise<WorkerInspectionResult> {
    const source = options.source ?? 'inspector';
    const stalledRecovery = await this.runWatchdogCycle(reason, {
      persistSnapshot: false,
      source: 'watchdog'
    });
    const queueSummaryBeforeRecovery = await getJobQueueSummary();
    const recovered = await recoverStaleJobs({
      staleAfterMs: this.settings.staleAfterMs,
      maxRetries: this.settings.defaultMaxRetries
    });
    const cleaned = await cleanupExpiredGptJobs();
    const stats = await getJobExecutionStatsSince(
      new Date(Date.now() - 60 * 60 * 1000),
      this.getStatsWorkerId()
    );
    const queueSummary = await getJobQueueSummary();

    this.state.lastInspectorRunAt = new Date().toISOString();
    this.state.recoveredJobs += recovered.recoveredJobs.length;
    this.state.deadLetterJobs += recovered.failedJobs.length;
    this.state.recoveryActions += recovered.recoveredJobs.length + recovered.failedJobs.length;
    if (recovered.recoveredJobs.length > 0 || recovered.failedJobs.length > 0) {
      this.state.lastRecoveryActionAt = new Date().toISOString();
    }
    if (recovered.recoveredJobs.length > 0) {
      recordWorkerRecoveredJobs({
        action: 'lease_requeue',
        count: recovered.recoveredJobs.length
      });
    }
    if (recovered.failedJobs.length > 0) {
      recordWorkerRecoveredJobs({
        action: 'lease_dead_letter',
        count: recovered.failedJobs.length
      });
    }
    this.state.maxObservedQueueDepth = Math.max(
      this.state.maxObservedQueueDepth,
      queueSummary?.pending ?? queueSummaryBeforeRecovery?.pending ?? 0
    );

    const alerts = buildHealthAlerts(queueSummary, notes);
    const watchdogState = this.buildWatchdogState(queueSummary);
    if (watchdogState.triggered && watchdogState.reason) {
      alerts.push(`Worker watchdog triggered: ${watchdogState.reason}`);
      this.state.watchdogTriggeredAt = new Date().toISOString();
      this.state.watchdogReason = watchdogState.reason;
    } else {
      this.state.watchdogTriggeredAt = null;
      this.state.watchdogReason = null;
    }
    if (recovered.recoveredJobs.length > 0) {
      alerts.push(`Recovered ${recovered.recoveredJobs.length} stale job(s).`);
    }
    if (recovered.failedJobs.length > 0) {
      alerts.push(`Marked ${recovered.failedJobs.length} stale job(s) failed after retry exhaustion.`);
    }
    if (stalledRecovery.staleWorkers > 0) {
      alerts.push(
        `Detected ${stalledRecovery.staleWorkers} stale worker(s) and ${stalledRecovery.stalledJobs} stalled job(s).`
      );
    }
    if (stalledRecovery.requeuedJobs > 0) {
      alerts.push(`Requeued ${stalledRecovery.requeuedJobs} stalled job(s).`);
    }
    if (stalledRecovery.deadLetterJobs > 0) {
      alerts.push(`Moved ${stalledRecovery.deadLetterJobs} stalled job(s) to dead-letter.`);
    }
    if (stalledRecovery.cancelledJobs > 0) {
      alerts.push(`Cancelled ${stalledRecovery.cancelledJobs} stalled job(s) during recovery.`);
    }
    if (cleaned.expiredPending > 0 || cleaned.expiredTerminal > 0) {
      logger.info('gpt.job.expired', {
        workerId: this.settings.workerId,
        expiredPending: cleaned.expiredPending,
        expiredTerminal: cleaned.expiredTerminal,
        deletedExpired: cleaned.deletedExpired
      });
      alerts.push(
        `Expired ${cleaned.expiredPending + cleaned.expiredTerminal} GPT job(s) during lifecycle maintenance.`
      );
    }

    const healthStatus = this.deriveHealthStatus(queueSummary, alerts);
    await this.persistSnapshot({
      queueSummary,
      stats,
      healthStatus,
      alerts,
      watchdogState
    }, { force: true, source });
    await this.maybeSendFailureWebhook(healthStatus, alerts, queueSummary, stats, reason);

    return {
      recovered,
      stalledRecovery,
      cleaned,
      queueSummary,
      stats,
      healthStatus,
      alerts
    };
  }

  /**
   * Run the worker watchdog recovery cycle.
   * Purpose: detect stale workers from persisted heartbeats, reclaim stalled jobs, and persist recovery telemetry.
   * Inputs/outputs: accepts a reason string and optional persistence override; returns the detected stale workers and recovery actions.
   * Edge case behavior: empty or heartbeat-fresh worker sets no-op without touching queue state.
   */
  async runWatchdogCycle(
    reason: string,
    options: WorkerSnapshotPersistOptions & { persistSnapshot?: boolean } = {}
  ): Promise<WorkerInspectionResult['stalledRecovery']> {
    const workerSnapshots = filterLegacyAggregateWorkerSnapshots(await listWorkerRuntimeSnapshots());
    const staleWorkerIds = workerSnapshots
      .filter((worker) => isWorkerSnapshotStale(worker, this.settings.staleAfterMs))
      .map((worker) => worker.workerId);
    const recovery =
      staleWorkerIds.length > 0
        ? await recoverStalledJobsForWorkers({
            workerIds: staleWorkerIds,
            staleAfterMs: this.settings.staleAfterMs,
            maxRetries: this.settings.defaultMaxRetries,
            stalledJobAction: this.settings.stalledJobAction
          })
        : {
            staleWorkerIds: [],
            stalledJobIds: [],
            requeuedJobIds: [],
            deadLetterJobIds: [],
            cancelledJobIds: []
          };
    const nowIso = new Date().toISOString();
    const stalledRecovery = {
      staleWorkers: recovery.staleWorkerIds.length,
      stalledJobs: recovery.stalledJobIds.length,
      requeuedJobs: recovery.requeuedJobIds.length,
      deadLetterJobs: recovery.deadLetterJobIds.length,
      cancelledJobs: recovery.cancelledJobIds.length
    };

    this.state.lastWatchdogRunAt = nowIso;
    this.state.staleWorkersDetected += stalledRecovery.staleWorkers;
    this.state.stalledJobsDetected += stalledRecovery.stalledJobs;
    this.state.recoveredJobs += stalledRecovery.requeuedJobs;
    this.state.deadLetterJobs += stalledRecovery.deadLetterJobs;
    this.state.recoveryActions +=
      stalledRecovery.requeuedJobs + stalledRecovery.deadLetterJobs + stalledRecovery.cancelledJobs;
    if (stalledRecovery.staleWorkers > 0) {
      recordWorkerStaleDetection({
        reason,
        count: stalledRecovery.staleWorkers
      });
    }
    if (stalledRecovery.stalledJobs > 0) {
      recordWorkerStalledJobs({
        action:
          stalledRecovery.deadLetterJobs > 0 && stalledRecovery.requeuedJobs === 0
            ? 'dead_letter'
            : stalledRecovery.requeuedJobs > 0
            ? 'requeue'
            : 'cancelled',
        count: stalledRecovery.stalledJobs
      });
    }
    if (stalledRecovery.requeuedJobs > 0) {
      recordWorkerRecoveredJobs({
        action: 'requeue',
        count: stalledRecovery.requeuedJobs
      });
    }
    if (stalledRecovery.deadLetterJobs > 0) {
      recordWorkerRecoveredJobs({
        action: 'dead_letter',
        count: stalledRecovery.deadLetterJobs
      });
    }
    if (stalledRecovery.cancelledJobs > 0) {
      recordWorkerRecoveredJobs({
        action: 'cancelled',
        count: stalledRecovery.cancelledJobs
      });
    }
    if (
      stalledRecovery.requeuedJobs > 0 ||
      stalledRecovery.deadLetterJobs > 0 ||
      stalledRecovery.cancelledJobs > 0
    ) {
      this.state.lastRecoveryActionAt = nowIso;
      logger.warn('worker.watchdog.recovery', {
        workerId: this.settings.workerId,
        reason,
        staleWorkers: stalledRecovery.staleWorkers,
        stalledJobs: stalledRecovery.stalledJobs,
        requeuedJobs: stalledRecovery.requeuedJobs,
        deadLetterJobs: stalledRecovery.deadLetterJobs,
        cancelledJobs: stalledRecovery.cancelledJobs
      });
    }

    if (options.persistSnapshot !== false) {
      const queueSummary = await getJobQueueSummary();
      const alerts = buildWatchdogRecoveryAlerts(stalledRecovery);
      await this.persistSnapshot({
        queueSummary,
        healthStatus:
          alerts.length > 0 || this.state.lastBudgetPauseReason ? 'degraded' : 'healthy',
        alerts,
        watchdogState: this.buildWatchdogState(queueSummary)
      }, { force: true, source: options.source ?? 'watchdog' });
    }

    return stalledRecovery;
  }

  /**
   * Decide whether the worker should pause before claiming more work.
   * Purpose: enforce memory, throughput, and AI-call budgets without interfering with currently running jobs.
   * Inputs/outputs: no inputs, returns an allow/deny decision with sleep duration and recent stats.
   * Edge case behavior: denials persist degraded snapshot state so operators can see why the worker paused.
   */
  async evaluateBudgetsBeforeClaim(): Promise<WorkerAutonomyBudgetResult> {
    const stats = await getJobExecutionStatsSince(
      new Date(Date.now() - 60 * 60 * 1000),
      this.getStatsWorkerId()
    );
    const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);

    let reason: string | null = null;
    let sleepMs = 0;

    //audit Assumption: memory pressure should pause new claims before the process becomes unstable; failure risk: OOM kills during large tasks; expected invariant: existing in-flight work can finish while new claims are delayed; handling strategy: refuse new claims until memory drops below the threshold.
    if (rssMb >= this.settings.maxRssMb) {
      reason = `rss_mb_limit_exceeded:${rssMb}`;
      sleepMs = this.settings.inspectorIntervalMs;
    } else if (stats.totalTerminal >= this.settings.maxJobsPerHour) {
      reason = `jobs_per_hour_exceeded:${stats.totalTerminal}`;
      sleepMs = 60_000;
    } else if (stats.aiCalls >= this.settings.maxAiCallsPerHour) {
      reason = `ai_calls_per_hour_exceeded:${stats.aiCalls}`;
      sleepMs = 60_000;
    }

    if (!reason) {
      this.state.lastBudgetPauseReason = null;
      return {
        allowed: true,
        sleepMs: 0,
        reason: null,
        stats,
        rssMb
      };
    }

    this.state.lastBudgetPauseReason = reason;
    await this.persistSnapshot({
      stats,
      healthStatus: 'degraded',
      alerts: [`Budget pause active: ${reason}`]
    }, { force: true, source: 'budget' });

    return {
      allowed: false,
      sleepMs,
      reason,
      stats,
      rssMb
    };
  }

  /**
   * Persist that the worker has started processing a specific job.
   * Purpose: update the snapshot state used by helper routes and stale-job recovery.
   * Inputs/outputs: accepts the claimed job; returns once the snapshot is persisted.
   * Edge case behavior: existing snapshot state is preserved even if persistence temporarily fails.
   */
  async markJobStarted(job: JobData): Promise<void> {
    this.state.currentJobId = job.id;
    this.state.lastError = null;
    this.state.lastHeartbeatAt = new Date().toISOString();
    this.state.lastActivityAt = this.state.lastHeartbeatAt;
    await this.persistSnapshot({
      healthStatus: 'healthy',
      alerts: []
    }, { force: true, source: 'job-start' });
  }

  /**
   * Persist a worker heartbeat even when no job is currently running.
   * Purpose: distinguish live idle workers from dead workers by emitting a durable liveness pulse.
   * Inputs/outputs: no inputs, returns once the snapshot heartbeat is persisted.
   * Edge case behavior: does not overwrite `lastActivityAt`, which remains reserved for work progress and slot state transitions.
   */
  async recordWorkerHeartbeat(options: WorkerSnapshotPersistOptions = {}): Promise<void> {
    this.state.lastHeartbeatAt = new Date().toISOString();
    await this.persistSnapshot({
      healthStatus: this.state.lastBudgetPauseReason ? 'degraded' : 'healthy',
      alerts: this.state.lastBudgetPauseReason
        ? [`Budget pause active: ${this.state.lastBudgetPauseReason}`]
        : []
    }, { force: true, source: options.source ?? 'worker-heartbeat' });
  }

  /**
   * Record a heartbeat for the active job.
   * Purpose: keep the lease fresh in the queue table and in the persisted worker snapshot.
   * Inputs/outputs: accepts the running job id; returns the refreshed job row or `null`.
   * Edge case behavior: no-ops safely when the job is already terminal and no longer running.
   */
  async recordHeartbeat(
    jobId: string,
    options: WorkerSnapshotPersistOptions = {}
  ): Promise<JobData | null> {
    const updatedJob = await recordJobHeartbeat(jobId, this.getClaimOptions());
    this.state.lastHeartbeatAt = new Date().toISOString();
    this.state.lastActivityAt = this.state.lastHeartbeatAt;
    await this.persistSnapshot({
      healthStatus: 'healthy',
      alerts: []
    }, { force: true, source: options.source ?? 'job-heartbeat' });
    return updatedJob;
  }

  /**
   * Persist successful job completion.
   * Purpose: clear current-job state and keep success counters current for health reporting.
   * Inputs/outputs: accepts the completed job id; returns once the snapshot is persisted.
   * Edge case behavior: preserves prior degraded state only when a budget pause is still active.
   */
  async markJobCompleted(_jobId: string): Promise<void> {
    const completedAt = new Date().toISOString();
    this.state.currentJobId = null;
    this.state.lastError = null;
    this.state.lastActivityAt = completedAt;
    this.state.lastProcessedJobAt = completedAt;
    this.state.processedJobs += 1;
    await this.persistSnapshot({
      healthStatus: this.state.lastBudgetPauseReason ? 'degraded' : 'healthy',
      alerts: this.state.lastBudgetPauseReason ? [`Budget pause active: ${this.state.lastBudgetPauseReason}`] : []
      }, { force: true, source: 'job-completed' });
  }

  /**
   * Persist cancelled job completion without scheduling retries.
   * Purpose: keep worker accounting accurate when cancellation resolves a running GPT job.
   * Inputs/outputs: accepts the cancelled job id; returns once the snapshot is persisted.
   * Edge case behavior: cancellation counts as processed work and clears the current job marker.
   */
  async markJobCancelled(_jobId: string): Promise<void> {
    const cancelledAt = new Date().toISOString();
    this.state.currentJobId = null;
    this.state.lastError = null;
    this.state.lastActivityAt = cancelledAt;
    this.state.lastProcessedJobAt = cancelledAt;
    this.state.processedJobs += 1;
    await this.persistSnapshot({
      healthStatus: this.state.lastBudgetPauseReason ? 'degraded' : 'healthy',
      alerts: this.state.lastBudgetPauseReason ? [`Budget pause active: ${this.state.lastBudgetPauseReason}`] : []
    }, { force: true, source: 'job-cancelled' });
  }

  /**
   * Handle a thrown or structured job failure.
   * Purpose: decide whether to reschedule the job with backoff or mark it terminally failed.
   * Inputs/outputs: accepts the job, failure message, retryability hint, and optional output payload; returns the final action taken.
   * Edge case behavior: exhausted retry budgets become terminal failures with persisted error context.
   */
  async handleJobFailure(
    job: JobData,
    errorMessage: string,
    retryable: boolean,
    output: unknown = null
  ): Promise<{ action: 'retried' | 'failed'; delayMs?: number }> {
    const retryCount = Number(job.retry_count ?? 0);
    const maxRetries = Number(job.max_retries ?? this.settings.defaultMaxRetries);

    //audit Assumption: only transient failures should consume retry budget; failure risk: deterministic schema or business failures loop unnecessarily; expected invariant: non-retryable failures terminate immediately; handling strategy: gate retries on both the classification and remaining budget.
    if (retryable && retryCount < maxRetries) {
      const delayMs = calculateRetryDelayMs(
        retryCount + 1,
        this.settings.retryBackoffBaseMs,
        this.settings.retryBackoffMaxMs
      );
      const failedAt = new Date().toISOString();
      this.state.currentJobId = null;
      this.state.lastError = errorMessage;
      this.state.lastActivityAt = failedAt;
      this.state.lastProcessedJobAt = failedAt;
      this.state.scheduledRetries += 1;
      await scheduleJobRetry(job.id, {
        workerId: this.settings.workerId,
        delayMs,
        errorMessage,
        autonomyState: {
          lastFailure: buildFailureSnapshot(errorMessage, {
            retryable: true,
            retryExhausted: false
          }),
          lastRetryScheduledAt: new Date().toISOString(),
          lastRetryDelayMs: delayMs,
          retryReason: errorMessage
        }
      });
      await this.persistSnapshot({
        healthStatus: 'degraded',
        alerts: [`Scheduled retry for job ${job.id} in ${delayMs}ms.`]
      }, { force: true, source: 'job-retry' });
      // Retry scheduling is a transient slot state. Keep the degraded snapshot above for visibility,
      // then clear the local error so idle health can recover once the retry is handed off.
      this.state.lastError = null;
      return {
        action: 'retried',
        delayMs
      };
    }

    this.state.currentJobId = null;
    this.state.lastError = errorMessage;
    this.state.lastActivityAt = new Date().toISOString();
    this.state.lastProcessedJobAt = this.state.lastActivityAt;
    this.state.terminalFailures += 1;
    const lifecycleDeadlines =
      job.job_type === 'gpt'
        ? computeGptJobLifecycleDeadlines('failed')
        : { idempotencyUntil: null, retentionUntil: null };
    await updateJob(
      job.id,
      'failed',
      output,
      errorMessage,
      {
        lastFailure: buildFailureSnapshot(errorMessage, {
          retryable,
          retryExhausted: retryable && retryCount >= maxRetries
        })
      },
      lifecycleDeadlines
    );
    await this.persistSnapshot({
      healthStatus: this.state.terminalFailures >= this.settings.failureWebhookThreshold ? 'unhealthy' : 'degraded',
      alerts: [`Job ${job.id} failed: ${errorMessage}`]
    }, { force: true, source: 'job-failed' });
    await this.maybeSendFailureWebhook(
      this.state.terminalFailures >= this.settings.failureWebhookThreshold ? 'unhealthy' : 'degraded',
      [`Job ${job.id} failed: ${errorMessage}`],
      await getJobQueueSummary(),
      await getJobExecutionStatsSince(new Date(Date.now() - 60 * 60 * 1000), this.getStatsWorkerId()),
      'job-failure'
    );

    return {
      action: 'failed'
    };
  }

  /**
   * Record an idle snapshot when the worker has no job to process.
   * Purpose: keep heartbeat freshness visible even while the queue is empty.
   * Inputs/outputs: no inputs, returns once the snapshot is persisted.
   * Edge case behavior: preserves degraded state if a budget pause or previous error remains active.
   */
  async markIdle(): Promise<void> {
    const queueSummary = await getJobQueueSummary();
    const watchdogState = this.buildWatchdogState(queueSummary);
    const inactivitySignal = deriveWorkerInactivitySignal(watchdogState);
    const healthStatus: WorkerAutonomyHealthStatus =
      this.state.lastBudgetPauseReason || inactivitySignal.detected
        ? 'degraded'
        : 'healthy';
    const alerts = this.state.lastBudgetPauseReason
      ? [`Budget pause active: ${this.state.lastBudgetPauseReason}`]
      : [];
    if (inactivitySignal.detected && inactivitySignal.reason) {
      alerts.push(inactivitySignal.reason);
    }

    await this.persistSnapshot({
      healthStatus,
      alerts,
      queueSummary,
      watchdogState
    }, {
      force: healthStatus !== 'healthy' || alerts.length > 0,
      source: 'worker-idle'
    });
  }

  private deriveHealthStatus(
    queueSummary: JobQueueSummary | null,
    alerts: string[]
  ): WorkerAutonomyHealthStatus {
    const watchdogState = this.buildWatchdogState(queueSummary);
    const inactivitySignal = deriveWorkerInactivitySignal(watchdogState);
    const queuePressure =
      Boolean(queueSummary?.pending) &&
      (queueSummary?.pending ?? 0) >= this.settings.queueDepthDeferralThreshold;
    const pendingAgeElevated =
      Boolean(queueSummary?.pending) &&
      (queueSummary?.oldestPendingJobAgeMs ?? 0) > 60_000;
    const liveDegradedSignals = alerts.some((alert) =>
      /budget pause active|stale job|watchdog triggered/i.test(alert)
    );
    if (watchdogState.triggered) {
      return 'unhealthy';
    }

    if (queueSummary?.stalledRunning) {
      return 'unhealthy';
    }

    if (
      inactivitySignal.detected ||
      liveDegradedSignals ||
      pendingAgeElevated ||
      queuePressure
    ) {
      return 'degraded';
    }

    return 'healthy';
  }

  private async persistSnapshot(
    context: WorkerSnapshotContext,
    options: WorkerSnapshotPersistOptions = {}
  ): Promise<void> {
    const nowMs = Date.now();
    const source = options.source ?? 'unspecified';
    if (
      !options.force &&
      this.lastSnapshotPersistedAtMs > 0 &&
      nowMs - this.lastSnapshotPersistedAtMs < WORKER_RUNTIME_SNAPSHOT_MIN_INTERVAL_MS
    ) {
      return;
    }

    const watchdogState = context.watchdogState ?? this.buildWatchdogState(context.queueSummary ?? null);
    const snapshotRecord: WorkerRuntimeSnapshotRecord = {
      workerId: this.settings.workerId,
      workerType: this.settings.workerType,
      healthStatus: context.healthStatus,
      currentJobId: this.state.currentJobId,
      lastError: this.state.lastError,
      startedAt: this.startedAt,
      lastHeartbeatAt: this.state.lastHeartbeatAt,
      lastInspectorRunAt: this.state.lastInspectorRunAt,
      updatedAt: new Date().toISOString(),
      snapshot: {
        activeJobs: this.state.currentJobId ? [this.state.currentJobId] : [],
        queueSummary: context.queueSummary ?? null,
        stats: context.stats ?? null,
        processedJobs: this.state.processedJobs,
        scheduledRetries: this.state.scheduledRetries,
        terminalFailures: this.state.terminalFailures,
        recoveredJobs: this.state.recoveredJobs,
        staleWorkersDetected: this.state.staleWorkersDetected,
        stalledJobsDetected: this.state.stalledJobsDetected,
        deadLetterJobs: this.state.deadLetterJobs,
        recoveryActions: this.state.recoveryActions,
        lastRecoveryActionAt: this.state.lastRecoveryActionAt,
        maxObservedQueueDepth: this.state.maxObservedQueueDepth,
        lastBudgetPauseReason: this.state.lastBudgetPauseReason,
        lastActivityAt: this.state.lastActivityAt,
        lastProcessedJobAt: this.state.lastProcessedJobAt,
        lastWatchdogRunAt: this.state.lastWatchdogRunAt,
        watchdog: watchdogState,
        statsWorkerId: this.getStatsWorkerId(),
        lastPersistSource: source,
        alerts: context.alerts
      }
    };

    const persistStartedAtMs = Date.now();
    try {
      await upsertWorkerRuntimeSnapshot(snapshotRecord);
      this.lastSnapshotPersistedAtMs = nowMs;
      const durationMs = Date.now() - persistStartedAtMs;
      const logContext = {
        module: 'worker-autonomy',
        workerId: this.settings.workerId,
        source,
        healthStatus: context.healthStatus,
        durationMs
      };
      if (durationMs >= WORKER_RUNTIME_SNAPSHOT_SLOW_LOG_MIN_MS) {
        logger.warn('worker.runtime_snapshot.persist.slow', logContext);
      } else {
        logger.debug('worker.runtime_snapshot.persist.completed', logContext);
      }
    } catch (error: unknown) {
      //audit Assumption: snapshot persistence is operationally important but must not crash the worker loop; failure risk: observability outage halts queue processing; expected invariant: worker continues after logging persistence failures; handling strategy: log and continue.
      logger.warn('worker.runtime_snapshot.persist.failed', {
        module: 'worker-autonomy',
        workerId: this.settings.workerId,
        source,
        healthStatus: context.healthStatus,
        durationMs: Date.now() - persistStartedAtMs,
        error: resolveErrorMessage(error)
      });
    }
  }

  private buildWatchdogState(queueSummary: JobQueueSummary | null): WorkerWatchdogState {
    const lastActivityAt = this.state.lastActivityAt;
    const lastHeartbeatAt = this.state.lastHeartbeatAt;
    const inactivityMs =
      lastActivityAt && Number.isFinite(Date.parse(lastActivityAt))
        ? Math.max(0, Date.now() - Date.parse(lastActivityAt))
        : null;
    const heartbeatAgeMs =
      lastHeartbeatAt && Number.isFinite(Date.parse(lastHeartbeatAt))
        ? Math.max(0, Date.now() - Date.parse(lastHeartbeatAt))
        : null;
    const queueHasPendingWork =
      (queueSummary?.pending ?? 0) > 0 || (queueSummary?.stalledRunning ?? 0) > 0;
    const stale = heartbeatAgeMs !== null && heartbeatAgeMs > this.settings.staleAfterMs;
    const triggered =
      queueHasPendingWork &&
      this.state.currentJobId === null &&
      (
        stale ||
        (inactivityMs !== null && inactivityMs >= this.settings.watchdogIdleMs)
      );
    const reason = stale
      ? `Worker heartbeat expired after ${heartbeatAgeMs}ms while queue work remained pending.`
      : triggered
      ? `No worker activity for ${inactivityMs}ms while queue work remained pending.`
      : null;

    return {
      triggered,
      reason,
      inactivityMs,
      lastActivityAt,
      lastProcessedJobAt: this.state.lastProcessedJobAt,
      lastHeartbeatAt,
      stale,
      staleAfterMs: this.settings.staleAfterMs,
      idleThresholdMs: this.settings.watchdogIdleMs,
      restartRecommended: triggered
    };
  }

  private async maybeSendFailureWebhook(
    healthStatus: WorkerAutonomyHealthStatus,
    alerts: string[],
    queueSummary: JobQueueSummary | null,
    stats: JobExecutionStats,
    reason: string
  ): Promise<void> {
    if (!this.settings.failureWebhookUrl) {
      return;
    }

    //audit Assumption: failure webhooks should only fire for materially degraded worker states; failure risk: noisy alert floods; expected invariant: healthy workers do not emit alerts; handling strategy: short-circuit unless degraded or unhealthy.
    if (healthStatus === 'healthy') {
      return;
    }

    const nowMs = Date.now();
    const failureWebhookCooldownKey = this.getStatsWorkerId();
    const lastSentAtMs = failureWebhookHistory.get(failureWebhookCooldownKey) ?? 0;
    if (nowMs - lastSentAtMs < this.settings.failureWebhookCooldownMs) {
      return;
    }

    const isInspectionReason = reason === 'scheduled' || reason === 'bootstrap';
    const hasFreshInspectionAlert = shouldAlertOnInspection(reason, alerts, queueSummary);

    //audit Assumption: periodic inspections should only page on newly discovered operational drift; failure risk: alert storms from one historical terminal failure; expected invariant: direct job failures still notify immediately while scheduled checks alert only on fresh inspector findings; handling strategy: suppress inspection-only alerts unless a stalled queue or stale-job recovery is present.
    if (isInspectionReason && !hasFreshInspectionAlert) {
      return;
    }

    const shouldAlert =
      healthStatus === 'unhealthy' ||
      this.state.terminalFailures >= this.settings.failureWebhookThreshold ||
      alerts.some(alert => alert.toLowerCase().includes('stale'));

    if (!shouldAlert) {
      return;
    }

    const webhookStartedAtMs = Date.now();
    try {
      const response = await fetch(this.settings.failureWebhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          workerId: this.settings.workerId,
          statsWorkerId: this.getStatsWorkerId(),
          workerType: this.settings.workerType,
          healthStatus,
          reason,
          alerts,
          queueSummary,
          stats,
          at: new Date().toISOString()
        })
      });

      //audit Assumption: non-2xx webhook responses still count as delivery failures; failure risk: operators assume alerts were sent; expected invariant: failed webhooks are logged and retried after cooldown; handling strategy: throw on non-ok HTTP status.
      if (!response.ok) {
        throw new Error(`Failure webhook returned HTTP ${response.status}`);
      }

      recordDependencyCall({
        dependency: 'worker_failure_webhook',
        operation: 'post',
        outcome: 'ok',
        durationMs: Date.now() - webhookStartedAtMs,
      });
      failureWebhookHistory.set(failureWebhookCooldownKey, nowMs);
    } catch (error: unknown) {
      recordDependencyCall({
        dependency: 'worker_failure_webhook',
        operation: 'post',
        outcome: 'error',
        durationMs: Date.now() - webhookStartedAtMs,
        error,
      });
      console.warn('[Worker Autonomy] Failure webhook send failed:', resolveErrorMessage(error));
    }
  }
}

/**
 * Decide whether an inspection cycle found a fresh alert-worthy condition.
 * Purpose: prevent periodic inspection loops from resending the same historical failure webhook.
 * Inputs/outputs: accepts the inspector reason, current alerts, and queue summary; returns whether the inspection discovered a new operational incident.
 * Edge case behavior: non-inspection reasons always return `true` so direct failure alerts are never suppressed.
 */
function shouldAlertOnInspection(
  reason: string,
  alerts: string[],
  queueSummary: JobQueueSummary | null
): boolean {
  if (reason !== 'scheduled' && reason !== 'bootstrap') {
    return true;
  }

  const normalizedAlerts = alerts.map(alert => alert.toLowerCase());
  return Boolean(
    queueSummary?.stalledRunning ||
    normalizedAlerts.some(alert => alert.includes('stale'))
  );
}

/**
 * Decide whether a worker error is transient enough to retry.
 * Purpose: keep retry policy centralized for queue-worker failures.
 * Inputs/outputs: accepts an unknown error value and returns a retryability decision with a normalized message.
 * Edge case behavior: malformed input falls back to a non-empty error string and conservative retry classification.
 */
type ErrorPattern = string | RegExp;

const WORKER_AUTHENTICATION_PATTERNS: readonly ErrorPattern[] = [
  /\bincorrect api key\b/i,
  /\binvalid api key\b/i,
  /\b(?:missing|required|expired)\b.{0,40}\bapi key\b/i,
  /\bapi key\b.{0,40}\b(?:missing|required|expired)\b/i,
  /\bunauthorized\b/i,
  /\bauthentication (?:failed|error|required)\b/i
] as const;

const WORKER_QUOTA_PATTERNS: readonly ErrorPattern[] = [
  'quota'
] as const;

const WORKER_RUNTIME_BUDGET_PATTERNS: readonly ErrorPattern[] = [
  'aborted_due_to_budget',
  'runtime_budget_exhausted',
  'token budget',
  'budget exceeded',
  'budgetexceeded',
  'runtimebudget',
  'budget exhaustion',
  'session token limit exceeded',
  'ai call budget exceeded',
  'ai prompt-token budget exceeded',
  'ai completion-token budget exceeded',
  'ai total-token budget exceeded',
  'watchdog threshold',
  'execution aborted by watchdog',
  'watchdog aborted execution'
] as const;

const WORKER_PROMPT_BUDGET_PATTERNS: readonly ErrorPattern[] = [
  'context length',
  'max tokens',
  'prompt too long'
] as const;

const WORKER_VALIDATION_PATTERNS: readonly ErrorPattern[] = [
  'invalid job.input',
  'unsupported job_type',
  /\bschema (?:mismatch|validation|invalid|error|failed)\b/i,
  /\bvalidation (?:failed|error|issues?|mismatch)\b/i,
  /\bmissing (?:required )?(?:field|input|parameter|argument|property|api key)\b/i,
  /\b(?:was|were|is) not found\b/i,
  /\bnot found for cancellation\b/i
] as const;

function matchesPattern(normalizedMessage: string, pattern: ErrorPattern): boolean {
  if (typeof pattern === 'string') {
    return normalizedMessage.includes(pattern);
  }

  pattern.lastIndex = 0;
  return pattern.test(normalizedMessage);
}

function matchesAnyPattern(normalizedMessage: string, patterns: readonly ErrorPattern[]): boolean {
  return patterns.some(pattern => matchesPattern(normalizedMessage, pattern));
}

export function classifyWorkerExecutionError(error: unknown): {
  message: string;
  retryable: boolean;
} {
  const message = resolveErrorMessage(error);
  const normalizedMessage = message.toLowerCase();
  const cancellationPatterns = [
    'job cancellation requested',
    'job was cancelled',
    'gpt job was cancelled',
    'cancellation requested while',
    'cancelled by client'
  ];
  const budgetExhaustionPatterns = [
    ...WORKER_QUOTA_PATTERNS,
    ...WORKER_RUNTIME_BUDGET_PATTERNS,
    ...WORKER_PROMPT_BUDGET_PATTERNS
  ];
  const retryablePatterns = [
    'abort',
    'aborted',
    'timeout',
    'timed out',
    'rate limit',
    '429',
    '500',
    '502',
    '503',
    '504',
    'econn',
    'socket hang up',
    'temporary',
    'network',
    'openai',
    'overloaded'
  ];
  const terminalPatterns = [
    ...WORKER_VALIDATION_PATTERNS,
    ...WORKER_AUTHENTICATION_PATTERNS,
    ...budgetExhaustionPatterns,
    ...cancellationPatterns
  ];

  //audit Assumption: explicit validation and unsupported-type failures are deterministic; failure risk: wasting retry budget on poison jobs; expected invariant: terminal patterns override transient ones; handling strategy: check terminal signatures first.
  const matchesTerminalPattern =
    matchesAnyPattern(normalizedMessage, terminalPatterns) ||
    /\b401\b/.test(normalizedMessage);

  if (matchesTerminalPattern) {
    return {
      message,
      retryable: false
    };
  }

  return {
    message,
    retryable: retryablePatterns.some(pattern => normalizedMessage.includes(pattern))
  };
}

function classifyWorkerFailureCategory(errorMessage: string):
  | 'authentication'
  | 'network'
  | 'provider'
  | 'rate_limited'
  | 'timeout'
  | 'validation'
  | 'unknown' {
  const normalizedMessage = errorMessage.toLowerCase();

  if (matchesAnyPattern(normalizedMessage, WORKER_AUTHENTICATION_PATTERNS) || /\b401\b/.test(normalizedMessage)) {
    return 'authentication';
  }

  if (
    matchesAnyPattern(normalizedMessage, WORKER_RUNTIME_BUDGET_PATTERNS) ||
    normalizedMessage.includes('timeout') ||
    normalizedMessage.includes('timed out') ||
    normalizedMessage.includes('abort') ||
    normalizedMessage.includes('aborted')
  ) {
    return 'timeout';
  }

  if (
    normalizedMessage.includes('rate limit') ||
    matchesAnyPattern(normalizedMessage, WORKER_QUOTA_PATTERNS) ||
    normalizedMessage.includes('429')
  ) {
    return 'rate_limited';
  }

  if (
    normalizedMessage.includes('network') ||
    normalizedMessage.includes('socket') ||
    normalizedMessage.includes('econn') ||
    normalizedMessage.includes('fetch failed')
  ) {
    return 'network';
  }

  if (
    matchesAnyPattern(normalizedMessage, WORKER_VALIDATION_PATTERNS) ||
    matchesAnyPattern(normalizedMessage, WORKER_PROMPT_BUDGET_PATTERNS)
  ) {
    return 'validation';
  }

  if (
    normalizedMessage.includes('openai') ||
    normalizedMessage.includes('provider') ||
    normalizedMessage.includes('500') ||
    normalizedMessage.includes('502') ||
    normalizedMessage.includes('503') ||
    normalizedMessage.includes('504')
  ) {
    return 'provider';
  }

  return 'unknown';
}

function calculateRetryDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * Math.max(1, 2 ** Math.max(0, attempt - 1)));
}

function buildFailureSnapshot(
  errorMessage: string,
  options: {
    retryable: boolean;
    retryExhausted: boolean;
  }
): Record<string, unknown> {
  return {
    at: new Date().toISOString(),
    reason: errorMessage,
    category: classifyWorkerFailureCategory(errorMessage),
    retryable: options.retryable,
    retryExhausted: options.retryExhausted
  };
}

function determineJobPriority(jobType: string, input: unknown): number {
  if (jobType === 'dag-node') {
    const nodeType = readStringPath(input, ['node', 'type']);
    if (nodeType === 'decision') {
      return 70;
    }
    if (nodeType === 'agent') {
      return 80;
    }
    return 90;
  }

  if (jobType === 'ask') {
    const endpointName = readStringPath(input, ['endpointName']);
    if (endpointName?.includes('worker-helper')) {
      return 95;
    }
    return 100;
  }

  if (jobType === 'gpt') {
    const gptId = readStringPath(input, ['gptId']);
    if (gptId === 'arcanos-core' || gptId === 'core' || gptId === 'arcanos-daemon') {
      return 85;
    }
    return 95;
  }

  return 110;
}

function readStringPath(value: unknown, path: string[]): string | null {
  let current: unknown = value;
  for (const segment of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return typeof current === 'string' && current.trim().length > 0 ? current : null;
}

function buildHealthAlerts(
  queueSummary: JobQueueSummary | null,
  notes: string[]
): string[] {
  const alerts = [...notes];

  if (queueSummary?.stalledRunning) {
    alerts.push(`Queue has ${queueSummary.stalledRunning} stalled running job(s).`);
  }
  if (queueSummary?.pending && queueSummary.pending > 0 && queueSummary.oldestPendingJobAgeMs > 60_000) {
    alerts.push(`Oldest pending job has waited ${queueSummary.oldestPendingJobAgeMs}ms.`);
  }

  return alerts;
}

function readWatchdogState(worker: WorkerRuntimeSnapshotRecord): WorkerWatchdogState | null {
  const snapshot = worker.snapshot;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return null;
  }

  const watchdog = (snapshot as Record<string, unknown>).watchdog;
  if (!watchdog || typeof watchdog !== 'object' || Array.isArray(watchdog)) {
    return null;
  }

  const record = watchdog as Record<string, unknown>;
  return {
    triggered: Boolean(record.triggered),
    reason: typeof record.reason === 'string' ? record.reason : null,
    inactivityMs: typeof record.inactivityMs === 'number' ? record.inactivityMs : null,
    lastActivityAt: typeof record.lastActivityAt === 'string' ? record.lastActivityAt : null,
    lastProcessedJobAt: typeof record.lastProcessedJobAt === 'string' ? record.lastProcessedJobAt : null,
    lastHeartbeatAt: typeof record.lastHeartbeatAt === 'string' ? record.lastHeartbeatAt : null,
    stale: Boolean(record.stale),
    staleAfterMs: typeof record.staleAfterMs === 'number' ? record.staleAfterMs : 0,
    idleThresholdMs: typeof record.idleThresholdMs === 'number' ? record.idleThresholdMs : 0,
    restartRecommended: Boolean(record.restartRecommended)
  };
}

function deriveWorkerInactivitySignal(watchdog: WorkerWatchdogState | null): WorkerInactivitySignal {
  if (!watchdog?.triggered) {
    return {
      detected: false,
      reason: null,
      inactivityMs: watchdog?.inactivityMs ?? null,
      lastActivityAt: watchdog?.lastActivityAt ?? null,
      lastProcessedJobAt: watchdog?.lastProcessedJobAt ?? null
    };
  }

  return {
    detected: true,
    reason: watchdog.reason,
    inactivityMs: watchdog.inactivityMs,
    lastActivityAt: watchdog.lastActivityAt,
    lastProcessedJobAt: watchdog.lastProcessedJobAt
  };
}

function isWorkerSnapshotStale(
  worker: WorkerRuntimeSnapshotRecord,
  staleAfterMs: number
): boolean {
  const snapshot =
    worker.snapshot && typeof worker.snapshot === 'object' && !Array.isArray(worker.snapshot)
      ? (worker.snapshot as Record<string, unknown>)
      : {};
  const lastActivityAt =
    typeof snapshot.lastActivityAt === 'string' && snapshot.lastActivityAt.trim().length > 0
      ? snapshot.lastActivityAt
      : null;
  const heartbeatCandidate =
    worker.lastHeartbeatAt ??
    lastActivityAt ??
    worker.updatedAt;
  if (!heartbeatCandidate || !Number.isFinite(Date.parse(heartbeatCandidate))) {
    return false;
  }

  return Date.now() - Date.parse(heartbeatCandidate) > staleAfterMs;
}

function buildWatchdogRecoveryAlerts(
  stalledRecovery: WorkerInspectionResult['stalledRecovery']
): string[] {
  const alerts: string[] = [];

  if (stalledRecovery.staleWorkers > 0) {
    alerts.push(
      `Detected ${stalledRecovery.staleWorkers} stale worker(s) and ${stalledRecovery.stalledJobs} stalled job(s).`
    );
  }
  if (stalledRecovery.requeuedJobs > 0) {
    alerts.push(`Requeued ${stalledRecovery.requeuedJobs} stalled job(s).`);
  }
  if (stalledRecovery.deadLetterJobs > 0) {
    alerts.push(`Moved ${stalledRecovery.deadLetterJobs} stalled job(s) to dead-letter.`);
  }
  if (stalledRecovery.cancelledJobs > 0) {
    alerts.push(`Cancelled ${stalledRecovery.cancelledJobs} stalled job(s) during recovery.`);
  }

  return alerts;
}

function filterLegacyAggregateWorkerSnapshots(
  workers: WorkerRuntimeSnapshotRecord[]
): WorkerRuntimeSnapshotRecord[] {
  const slotPrefixes = new Set<string>();

  for (const worker of workers) {
    const match = worker.workerId.match(/^(.*)-slot-\d+$/);
    if (match?.[1]) {
      slotPrefixes.add(match[1]);
    }
  }

  if (slotPrefixes.size === 0) {
    return workers;
  }

  return workers.filter((worker) => !slotPrefixes.has(worker.workerId));
}
function deriveOverallHealthStatus(
  queueSummary: JobQueueSummary | null,
  workers: WorkerRuntimeSnapshotRecord[],
  alerts: string[]
): WorkerAutonomyHealthStatus {
  if (workers.length === 0) {
    return queueSummary && (queueSummary.running > 0 || queueSummary.pending > 0) ? 'degraded' : 'offline';
  }

  if (
    workers.some(worker => worker.healthStatus === 'unhealthy' || readWatchdogState(worker)?.triggered) ||
    queueSummary?.stalledRunning
  ) {
    return 'unhealthy';
  }

  if (
    workers.some(worker => {
      const watchdog = readWatchdogState(worker);
      return worker.healthStatus === 'degraded' || Boolean(watchdog?.restartRecommended);
    }) ||
    alerts.length > 0
  ) {
    return 'degraded';
  }

  return 'healthy';
}
