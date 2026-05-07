import {
  cleanupRetainedFailedJobs,
  DEFAULT_FAILED_JOB_CLEANUP_MIN_AGE_MS,
  DEFAULT_FAILED_JOB_RETENTION_COUNT,
  MAX_FAILED_JOB_CLEANUP_MIN_AGE_MS,
  MAX_FAILED_JOB_RETENTION_COUNT,
  type CleanupRetainedFailedJobsResult
} from '@core/db/repositories/jobRepository.js';
import {
  cleanupJobEvents,
  DEFAULT_JOB_EVENT_CLEANUP_BATCH_SIZE,
  DEFAULT_JOB_EVENT_RETENTION_DAYS,
  MAX_JOB_EVENT_CLEANUP_BATCH_SIZE,
  MAX_JOB_EVENT_RETENTION_DAYS,
  type CleanupJobEventsResult
} from '@core/db/repositories/jobEventRepository.js';
import { recordJobEventCleanup } from '@platform/observability/appMetrics.js';
import { logger } from '@platform/logging/structuredLogging.js';

export interface FailedJobCleanupPolicy {
  enabled: boolean;
  keep: number;
  minAgeMs: number;
}

export interface FailedJobCleanupRunResult extends CleanupRetainedFailedJobsResult {
  enabled: boolean;
  skipped: boolean;
}

export interface JobEventCleanupPolicy {
  enabled: boolean;
  dryRun: boolean;
  retentionDays: number;
  batchSize: number;
}

export interface JobEventCleanupRunResult extends CleanupJobEventsResult {
  enabled: boolean;
  skipped: boolean;
  failed: boolean;
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value || value.trim().length === 0) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

function parsePositiveIntegerEnv(
  value: string | undefined,
  fallback: number,
  options: { min: number; max: number }
): number {
  const parsed = value ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(options.max, Math.max(options.min, Math.trunc(parsed)));
}

function readEnvAlias(
  env: NodeJS.ProcessEnv,
  primary: string,
  fallback: string
): string | undefined {
  return env[primary] ?? env[fallback];
}

export function resolveFailedJobCleanupPolicy(
  env: NodeJS.ProcessEnv = process.env
): FailedJobCleanupPolicy {
  return {
    enabled: parseBooleanEnv(env.QUEUE_FAILED_JOB_CLEANUP_ENABLED, true),
    keep: parsePositiveIntegerEnv(
      env.QUEUE_FAILED_JOB_RETENTION_COUNT,
      DEFAULT_FAILED_JOB_RETENTION_COUNT,
      { min: 1, max: MAX_FAILED_JOB_RETENTION_COUNT }
    ),
    minAgeMs: parsePositiveIntegerEnv(
      env.QUEUE_FAILED_JOB_CLEANUP_MIN_AGE_MS,
      DEFAULT_FAILED_JOB_CLEANUP_MIN_AGE_MS,
      { min: 0, max: MAX_FAILED_JOB_CLEANUP_MIN_AGE_MS }
    )
  };
}

export function resolveJobEventCleanupPolicy(
  env: NodeJS.ProcessEnv = process.env
): JobEventCleanupPolicy {
  return {
    enabled: parseBooleanEnv(
      readEnvAlias(env, 'JOB_EVENTS_CLEANUP_ENABLED', 'JOB_EVENT_CLEANUP_ENABLED'),
      true
    ),
    dryRun: parseBooleanEnv(
      readEnvAlias(env, 'JOB_EVENTS_CLEANUP_DRY_RUN', 'JOB_EVENT_CLEANUP_DRY_RUN'),
      true
    ),
    retentionDays: parsePositiveIntegerEnv(
      readEnvAlias(env, 'JOB_EVENTS_RETENTION_DAYS', 'JOB_EVENT_RETENTION_DAYS'),
      DEFAULT_JOB_EVENT_RETENTION_DAYS,
      { min: 1, max: MAX_JOB_EVENT_RETENTION_DAYS }
    ),
    batchSize: parsePositiveIntegerEnv(
      readEnvAlias(env, 'JOB_EVENTS_CLEANUP_BATCH_SIZE', 'JOB_EVENT_CLEANUP_BATCH_SIZE'),
      DEFAULT_JOB_EVENT_CLEANUP_BATCH_SIZE,
      { min: 1, max: MAX_JOB_EVENT_CLEANUP_BATCH_SIZE }
    )
  };
}

export async function runFailedJobCleanup(
  reason = 'scheduled',
  policy: FailedJobCleanupPolicy = resolveFailedJobCleanupPolicy()
): Promise<FailedJobCleanupRunResult> {
  if (!policy.enabled) {
    logger.debug('queue.failed_jobs.cleanup.skipped', {
      module: 'queue-cleanup',
      reason,
      keep: policy.keep,
      minAgeMs: policy.minAgeMs
    });
    return {
      enabled: false,
      skipped: true,
      keep: policy.keep,
      minAgeMs: policy.minAgeMs,
      deletedFailed: 0,
      retainedFailed: 0,
      deletedJobIds: []
    };
  }

  const result = await cleanupRetainedFailedJobs({
    keep: policy.keep,
    minAgeMs: policy.minAgeMs
  });
  const logPayload = {
    module: 'queue-cleanup',
    reason,
    keep: result.keep,
    minAgeMs: result.minAgeMs,
    deletedFailed: result.deletedFailed,
    retainedFailed: result.retainedFailed,
    deletedJobIdSample: result.deletedJobIds.slice(0, 20)
  };

  if (result.deletedFailed > 0) {
    logger.info('queue.failed_jobs.cleanup.completed', logPayload);
  } else {
    logger.debug('queue.failed_jobs.cleanup.completed', logPayload);
  }

  return {
    enabled: true,
    skipped: false,
    ...result
  };
}

export async function runJobEventCleanup(
  reason = 'scheduled',
  policy: JobEventCleanupPolicy = resolveJobEventCleanupPolicy()
): Promise<JobEventCleanupRunResult> {
  if (!policy.enabled) {
    logger.debug('queue.job_events.cleanup.skipped', {
      module: 'queue-cleanup',
      reason,
      retentionDays: policy.retentionDays,
      batchSize: policy.batchSize,
      dryRun: policy.dryRun
    });
    return {
      enabled: false,
      skipped: true,
      failed: false,
      databaseAvailable: true,
      dryRun: policy.dryRun,
      retentionDays: policy.retentionDays,
      batchSize: policy.batchSize,
      cutoffBefore: new Date(Date.now() - policy.retentionDays * 24 * 60 * 60 * 1_000).toISOString(),
      matchedRows: 0,
      deletedRows: 0,
      eventIds: []
    };
  }

  const startedAt = Date.now();
  try {
    const result = await cleanupJobEvents({
      dryRun: policy.dryRun,
      retentionDays: policy.retentionDays,
      batchSize: policy.batchSize
    });
    const durationMs = Date.now() - startedAt;
    const outcome = result.failed
      ? 'failed'
      : result.databaseAvailable
      ? 'completed'
      : 'database_unavailable';
    recordJobEventCleanup({
      outcome,
      dryRun: result.dryRun,
      matchedRows: result.matchedRows,
      deletedRows: result.deletedRows,
      durationMs
    });

    const logPayload = {
      module: 'queue-cleanup',
      reason,
      dryRun: result.dryRun,
      retentionDays: result.retentionDays,
      batchSize: result.batchSize,
      cutoffBefore: result.cutoffBefore,
      matchedRows: result.matchedRows,
      deletedRows: result.deletedRows,
      deletedEventIdSample: result.eventIds.slice(0, 20)
    };
    if (result.failed) {
      logger.warn('queue.job_events.cleanup.failed', logPayload);
    } else if (result.matchedRows > 0 || result.deletedRows > 0) {
      logger.info('queue.job_events.cleanup.completed', logPayload);
    } else {
      logger.debug('queue.job_events.cleanup.completed', logPayload);
    }

    return {
      enabled: true,
      skipped: false,
      ...result
    };
  } catch {
    const durationMs = Date.now() - startedAt;
    recordJobEventCleanup({
      outcome: 'failed',
      dryRun: policy.dryRun,
      durationMs
    });
    logger.warn('queue.job_events.cleanup.failed', {
      module: 'queue-cleanup',
      reason,
      dryRun: policy.dryRun,
      retentionDays: policy.retentionDays,
      batchSize: policy.batchSize
    });
    return {
      enabled: true,
      skipped: false,
      failed: true,
      databaseAvailable: true,
      dryRun: policy.dryRun,
      retentionDays: policy.retentionDays,
      batchSize: policy.batchSize,
      cutoffBefore: new Date(Date.now() - policy.retentionDays * 24 * 60 * 60 * 1_000).toISOString(),
      matchedRows: 0,
      deletedRows: 0,
      eventIds: []
    };
  }
}
