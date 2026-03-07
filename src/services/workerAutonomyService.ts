import type { JobData } from '@core/db/schema.js';
import {
  getJobExecutionStatsSince,
  getJobQueueSummary,
  recordJobHeartbeat,
  recoverStaleJobs,
  scheduleJobRetry,
  updateJob,
  type ClaimNextPendingJobOptions,
  type CreateJobOptions,
  type JobExecutionStats,
  type JobQueueSummary,
  type RecoverStaleJobsResult
} from '@core/db/repositories/jobRepository.js';
import {
  listWorkerRuntimeSnapshots,
  upsertWorkerRuntimeSnapshot,
  type WorkerRuntimeSnapshotRecord
} from '@core/db/repositories/workerRuntimeRepository.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';

export type WorkerAutonomyHealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'offline';

export interface WorkerAutonomySettings {
  workerId: string;
  workerType: 'async_queue';
  heartbeatIntervalMs: number;
  leaseMs: number;
  inspectorIntervalMs: number;
  staleAfterMs: number;
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
    | 'staleAfterMs'
    | 'defaultMaxRetries'
    | 'maxJobsPerHour'
    | 'maxAiCallsPerHour'
    | 'maxRssMb'
  >;
}

export interface WorkerBootstrapResult {
  recovered: RecoverStaleJobsResult;
  healthStatus: WorkerAutonomyHealthStatus;
  alerts: string[];
}

export interface WorkerInspectionResult {
  recovered: RecoverStaleJobsResult;
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
  processedJobs: number;
  scheduledRetries: number;
  terminalFailures: number;
  recoveredJobs: number;
  maxObservedQueueDepth: number;
  lastBudgetPauseReason: string | null;
}

interface WorkerSnapshotContext {
  queueSummary?: JobQueueSummary | null;
  stats?: JobExecutionStats;
  healthStatus: WorkerAutonomyHealthStatus;
  alerts: string[];
}

const DEFAULT_AUTONOMY_SETTINGS: WorkerAutonomySettings = {
  workerId: process.env.JOB_WORKER_ID?.trim() || process.env.WORKER_ID?.trim() || 'async-queue',
  workerType: 'async_queue',
  heartbeatIntervalMs: readNumberEnv('JOB_WORKER_HEARTBEAT_MS', 10_000),
  leaseMs: readNumberEnv('JOB_WORKER_LEASE_MS', 30_000),
  inspectorIntervalMs: readNumberEnv('JOB_WORKER_INSPECTOR_MS', 30_000),
  staleAfterMs: readNumberEnv('JOB_WORKER_STALE_AFTER_MS', 60_000),
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
  const [queueSummary, workers] = await Promise.all([
    getJobQueueSummary(),
    listWorkerRuntimeSnapshots()
  ]);
  const alerts: string[] = [];

  if (queueSummary?.stalledRunning) {
    alerts.push(`Detected ${queueSummary.stalledRunning} stalled running job(s).`);
  }
  if (queueSummary && queueSummary.pending >= settings.queueDepthDeferralThreshold) {
    alerts.push(`Queue pressure is elevated (pending=${queueSummary.pending}).`);
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
      staleAfterMs: settings.staleAfterMs,
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

  constructor(settings: WorkerAutonomySettings = getWorkerAutonomySettings()) {
    this.settings = settings;
    this.startedAt = new Date().toISOString();
    this.state = {
      currentJobId: null,
      lastError: null,
      lastHeartbeatAt: null,
      lastInspectorRunAt: null,
      processedJobs: 0,
      scheduledRetries: 0,
      terminalFailures: 0,
      recoveredJobs: 0,
      maxObservedQueueDepth: 0,
      lastBudgetPauseReason: null
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

  /**
   * Run startup recovery before the worker starts claiming new jobs.
   * Purpose: heal stale queue rows, persist an initial snapshot, and surface degraded prerequisites early.
   * Inputs/outputs: optional bootstrap notes; returns recovery details and the derived health status.
   * Edge case behavior: recovery errors are logged and reflected in the persisted snapshot before being rethrown.
   */
  async bootstrap(notes: string[] = []): Promise<WorkerBootstrapResult> {
    try {
      const inspection = await this.inspect('bootstrap', notes);
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
      });
      throw error;
    }
  }

  /**
   * Run the periodic inspector loop.
   * Purpose: recover stale jobs, refresh queue health, and emit failure webhooks when the worker drifts unhealthy.
   * Inputs/outputs: accepts an inspector reason and optional notes; returns the full inspection result.
   * Edge case behavior: stale jobs over the retry limit are terminally failed instead of re-queued.
   */
  async inspect(reason: string, notes: string[] = []): Promise<WorkerInspectionResult> {
    const queueSummaryBeforeRecovery = await getJobQueueSummary();
    const recovered = await recoverStaleJobs({
      staleAfterMs: this.settings.staleAfterMs,
      maxRetries: this.settings.defaultMaxRetries
    });
    const stats = await getJobExecutionStatsSince(
      new Date(Date.now() - 60 * 60 * 1000),
      this.settings.workerId
    );
    const queueSummary = await getJobQueueSummary();

    this.state.lastInspectorRunAt = new Date().toISOString();
    this.state.recoveredJobs += recovered.recoveredJobs.length;
    this.state.maxObservedQueueDepth = Math.max(
      this.state.maxObservedQueueDepth,
      queueSummary?.pending ?? queueSummaryBeforeRecovery?.pending ?? 0
    );

    const alerts = buildHealthAlerts(queueSummary, stats, notes);
    if (recovered.recoveredJobs.length > 0) {
      alerts.push(`Recovered ${recovered.recoveredJobs.length} stale job(s).`);
    }
    if (recovered.failedJobs.length > 0) {
      alerts.push(`Marked ${recovered.failedJobs.length} stale job(s) failed after retry exhaustion.`);
    }

    const healthStatus = this.deriveHealthStatus(queueSummary, stats, alerts);
    await this.persistSnapshot({
      queueSummary,
      stats,
      healthStatus,
      alerts
    });
    await this.maybeSendFailureWebhook(healthStatus, alerts, queueSummary, stats, reason);

    return {
      recovered,
      queueSummary,
      stats,
      healthStatus,
      alerts
    };
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
      this.settings.workerId
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
    });

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
    await this.persistSnapshot({
      healthStatus: 'healthy',
      alerts: []
    });
  }

  /**
   * Record a heartbeat for the active job.
   * Purpose: keep the lease fresh in the queue table and in the persisted worker snapshot.
   * Inputs/outputs: accepts the running job id; returns the refreshed job row or `null`.
   * Edge case behavior: no-ops safely when the job is already terminal and no longer running.
   */
  async recordHeartbeat(jobId: string): Promise<JobData | null> {
    const updatedJob = await recordJobHeartbeat(jobId, this.getClaimOptions());
    this.state.lastHeartbeatAt = new Date().toISOString();
    await this.persistSnapshot({
      healthStatus: 'healthy',
      alerts: []
    });
    return updatedJob;
  }

  /**
   * Persist successful job completion.
   * Purpose: clear current-job state and keep success counters current for health reporting.
   * Inputs/outputs: accepts the completed job id; returns once the snapshot is persisted.
   * Edge case behavior: preserves prior degraded state only when a budget pause is still active.
   */
  async markJobCompleted(_jobId: string): Promise<void> {
    this.state.currentJobId = null;
    this.state.lastError = null;
    this.state.processedJobs += 1;
    await this.persistSnapshot({
      healthStatus: this.state.lastBudgetPauseReason ? 'degraded' : 'healthy',
      alerts: this.state.lastBudgetPauseReason ? [`Budget pause active: ${this.state.lastBudgetPauseReason}`] : []
    });
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
      this.state.currentJobId = null;
      this.state.lastError = errorMessage;
      this.state.scheduledRetries += 1;
      await scheduleJobRetry(job.id, {
        workerId: this.settings.workerId,
        delayMs,
        errorMessage,
        autonomyState: {
          lastRetryScheduledAt: new Date().toISOString(),
          lastRetryDelayMs: delayMs,
          retryReason: errorMessage
        }
      });
      await this.persistSnapshot({
        healthStatus: 'degraded',
        alerts: [`Scheduled retry for job ${job.id} in ${delayMs}ms.`]
      });
      return {
        action: 'retried',
        delayMs
      };
    }

    this.state.currentJobId = null;
    this.state.lastError = errorMessage;
    this.state.terminalFailures += 1;
    await updateJob(job.id, 'failed', output, errorMessage);
    await this.persistSnapshot({
      healthStatus: this.state.terminalFailures >= this.settings.failureWebhookThreshold ? 'unhealthy' : 'degraded',
      alerts: [`Job ${job.id} failed: ${errorMessage}`]
    });
    await this.maybeSendFailureWebhook(
      this.state.terminalFailures >= this.settings.failureWebhookThreshold ? 'unhealthy' : 'degraded',
      [`Job ${job.id} failed: ${errorMessage}`],
      await getJobQueueSummary(),
      await getJobExecutionStatsSince(new Date(Date.now() - 60 * 60 * 1000), this.settings.workerId),
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
    const healthStatus: WorkerAutonomyHealthStatus =
      this.state.lastBudgetPauseReason || this.state.lastError ? 'degraded' : 'healthy';
    const alerts = this.state.lastBudgetPauseReason
      ? [`Budget pause active: ${this.state.lastBudgetPauseReason}`]
      : [];

    await this.persistSnapshot({
      healthStatus,
      alerts
    });
  }

  private deriveHealthStatus(
    queueSummary: JobQueueSummary | null,
    stats: JobExecutionStats,
    alerts: string[]
  ): WorkerAutonomyHealthStatus {
    if (queueSummary?.stalledRunning || stats.failed >= this.settings.failureWebhookThreshold) {
      return 'unhealthy';
    }

    if (
      alerts.length > 0 ||
      queueSummary?.pending &&
      queueSummary.pending >= this.settings.queueDepthDeferralThreshold
    ) {
      return 'degraded';
    }

    return 'healthy';
  }

  private async persistSnapshot(context: WorkerSnapshotContext): Promise<void> {
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
        queueSummary: context.queueSummary ?? null,
        stats: context.stats ?? null,
        processedJobs: this.state.processedJobs,
        scheduledRetries: this.state.scheduledRetries,
        terminalFailures: this.state.terminalFailures,
        recoveredJobs: this.state.recoveredJobs,
        maxObservedQueueDepth: this.state.maxObservedQueueDepth,
        lastBudgetPauseReason: this.state.lastBudgetPauseReason,
        alerts: context.alerts
      }
    };

    try {
      await upsertWorkerRuntimeSnapshot(snapshotRecord);
    } catch (error: unknown) {
      //audit Assumption: snapshot persistence is operationally important but must not crash the worker loop; failure risk: observability outage halts queue processing; expected invariant: worker continues after logging persistence failures; handling strategy: log and continue.
      console.warn('[Worker Autonomy] Failed to persist runtime snapshot:', resolveErrorMessage(error));
    }
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
    const lastSentAtMs = failureWebhookHistory.get(this.settings.workerId) ?? 0;
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

    try {
      const response = await fetch(this.settings.failureWebhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          workerId: this.settings.workerId,
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

      failureWebhookHistory.set(this.settings.workerId, nowMs);
    } catch (error: unknown) {
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
export function classifyWorkerExecutionError(error: unknown): {
  message: string;
  retryable: boolean;
} {
  const message = resolveErrorMessage(error);
  const normalizedMessage = message.toLowerCase();
  const retryablePatterns = [
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
    'invalid job.input',
    'unsupported job_type',
    'schema',
    'validation',
    'missing',
    'not found'
  ];

  //audit Assumption: explicit validation and unsupported-type failures are deterministic; failure risk: wasting retry budget on poison jobs; expected invariant: terminal patterns override transient ones; handling strategy: check terminal signatures first.
  if (terminalPatterns.some(pattern => normalizedMessage.includes(pattern))) {
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

function calculateRetryDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * Math.max(1, 2 ** Math.max(0, attempt - 1)));
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
  stats: JobExecutionStats,
  notes: string[]
): string[] {
  const alerts = [...notes];

  if (queueSummary?.stalledRunning) {
    alerts.push(`Queue has ${queueSummary.stalledRunning} stalled running job(s).`);
  }
  if (queueSummary?.pending && queueSummary.pending > 0 && queueSummary.oldestPendingJobAgeMs > 60_000) {
    alerts.push(`Oldest pending job has waited ${queueSummary.oldestPendingJobAgeMs}ms.`);
  }
  if (stats.failed > 0) {
    alerts.push(`Observed ${stats.failed} failed job(s) in the last hour.`);
  }

  return alerts;
}

function deriveOverallHealthStatus(
  queueSummary: JobQueueSummary | null,
  workers: WorkerRuntimeSnapshotRecord[],
  alerts: string[]
): WorkerAutonomyHealthStatus {
  if (workers.length === 0) {
    return queueSummary && (queueSummary.running > 0 || queueSummary.pending > 0) ? 'degraded' : 'offline';
  }

  if (workers.some(worker => worker.healthStatus === 'unhealthy') || queueSummary?.stalledRunning) {
    return 'unhealthy';
  }

  if (workers.some(worker => worker.healthStatus === 'degraded') || alerts.length > 0) {
    return 'degraded';
  }

  return 'healthy';
}
