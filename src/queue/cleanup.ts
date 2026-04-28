import {
  cleanupRetainedFailedJobs,
  DEFAULT_FAILED_JOB_CLEANUP_MIN_AGE_MS,
  DEFAULT_FAILED_JOB_RETENTION_COUNT,
  type CleanupRetainedFailedJobsResult
} from '@core/db/repositories/jobRepository.js';
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

export function resolveFailedJobCleanupPolicy(
  env: NodeJS.ProcessEnv = process.env
): FailedJobCleanupPolicy {
  return {
    enabled: parseBooleanEnv(env.QUEUE_FAILED_JOB_CLEANUP_ENABLED, true),
    keep: parsePositiveIntegerEnv(
      env.QUEUE_FAILED_JOB_RETENTION_COUNT,
      DEFAULT_FAILED_JOB_RETENTION_COUNT,
      { min: 1, max: 500 }
    ),
    minAgeMs: parsePositiveIntegerEnv(
      env.QUEUE_FAILED_JOB_CLEANUP_MIN_AGE_MS,
      DEFAULT_FAILED_JOB_CLEANUP_MIN_AGE_MS,
      { min: 0, max: 30 * 24 * 60 * 60 * 1000 }
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
