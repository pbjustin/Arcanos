import type { JobData } from '@core/db/schema.js';

const GPT_RESULT_REUSE_AUTONOMY_KEY = 'gptResultReuse';

export const QUEUED_GPT_JOB_PRODUCER_CONTRACT_VERSION = 1;
export const QUEUED_GPT_JOB_PRODUCER_CONTRACT_SOURCE = 'queued-gpt-runtime';

/**
 * Fail closed when cancellation handling cannot prove that a GPT row came
 * from the current server-owned queue producer.
 */
export function isQueuedGptJobCancellationPrivacySensitive(rawInput: unknown): boolean {
  try {
    if (
      typeof rawInput !== 'object'
      || rawInput === null
      || Array.isArray(rawInput)
    ) {
      return true;
    }

    if (Object.prototype.hasOwnProperty.call(rawInput, 'protectedBackstage')) {
      return true;
    }
    if (!Object.prototype.hasOwnProperty.call(rawInput, 'producerContract')) {
      return true;
    }

    const producerContract = (rawInput as Record<string, unknown>).producerContract;
    if (
      typeof producerContract !== 'object'
      || producerContract === null
      || Array.isArray(producerContract)
      || Object.keys(producerContract).length !== 2
      || !Object.prototype.hasOwnProperty.call(producerContract, 'version')
      || !Object.prototype.hasOwnProperty.call(producerContract, 'source')
    ) {
      return true;
    }

    const producerContractRecord = producerContract as Record<string, unknown>;
    return producerContractRecord.version !== QUEUED_GPT_JOB_PRODUCER_CONTRACT_VERSION
      || producerContractRecord.source !== QUEUED_GPT_JOB_PRODUCER_CONTRACT_SOURCE;
  } catch {
    return true;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Persist why a completed GPT result must not satisfy a later identical request. */
export function buildNonReusableGptResultAutonomyState(
  reason: string
): Record<string, unknown> {
  return {
    [GPT_RESULT_REUSE_AUTONOMY_KEY]: {
      reusable: false,
      reason
    }
  };
}

/**
 * Decide whether a terminal GPT result may be returned by request-level
 * idempotency. The key binding itself remains active so a changed fingerprint
 * still conflicts while an exact retry can create a reconciliation job.
 */
export function isGptJobResultReusable(
  job: Pick<JobData, 'status' | 'autonomy_state'>
): boolean {
  if (job.status !== 'completed') {
    return true;
  }

  const autonomyState = asRecord(job.autonomy_state);
  const reusePolicy = asRecord(autonomyState?.[GPT_RESULT_REUSE_AUTONOMY_KEY]);
  return reusePolicy?.reusable !== false;
}

export type GptJobStorageStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired';

export type GptJobLifecycleStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired';

const DEFAULT_GPT_JOB_COMPLETED_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_GPT_JOB_FAILED_RETENTION_MS = 6 * 60 * 60 * 1000;
const DEFAULT_GPT_JOB_CANCELLED_RETENTION_MS = 60 * 60 * 1000;
const DEFAULT_GPT_IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_GPT_JOB_PENDING_MAX_AGE_MS = 30 * 60 * 1000;
const DEFAULT_GPT_JOB_EXPIRED_COMPACTION_MS = 24 * 60 * 60 * 1000;

function readPositiveDurationMs(
  rawValue: string | undefined,
  fallbackValue: number,
  minimumValue = 1_000,
  maximumValue = 7 * 24 * 60 * 60 * 1000
): number {
  const parsedValue = rawValue ? Number(rawValue) : Number.NaN;
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return fallbackValue;
  }

  return Math.max(minimumValue, Math.min(maximumValue, Math.trunc(parsedValue)));
}

export function resolveGptJobRetentionWindowMs(
  status: string,
  env: NodeJS.ProcessEnv = process.env
): number {
  switch (status) {
    case 'completed':
      return readPositiveDurationMs(
        env.GPT_JOB_COMPLETED_RETENTION_MS,
        DEFAULT_GPT_JOB_COMPLETED_RETENTION_MS
      );
    case 'failed':
      return readPositiveDurationMs(
        env.GPT_JOB_FAILED_RETENTION_MS,
        DEFAULT_GPT_JOB_FAILED_RETENTION_MS
      );
    case 'cancelled':
      return readPositiveDurationMs(
        env.GPT_JOB_CANCELLED_RETENTION_MS,
        DEFAULT_GPT_JOB_CANCELLED_RETENTION_MS
      );
    default:
      return 0;
  }
}

export function resolveGptIdempotencyRetentionMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  return readPositiveDurationMs(
    env.GPT_IDEMPOTENCY_RETENTION_MS,
    DEFAULT_GPT_IDEMPOTENCY_RETENTION_MS
  );
}

export function resolveGptPendingMaxAgeMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  return readPositiveDurationMs(
    env.GPT_JOB_PENDING_MAX_AGE_MS,
    DEFAULT_GPT_JOB_PENDING_MAX_AGE_MS
  );
}

export function resolveGptExpiredCompactionMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  return readPositiveDurationMs(
    env.GPT_JOB_EXPIRED_COMPACTION_MS,
    DEFAULT_GPT_JOB_EXPIRED_COMPACTION_MS
  );
}

export function computeGptJobLifecycleDeadlines(
  status: string,
  now = new Date(),
  env: NodeJS.ProcessEnv = process.env
): {
  retentionUntil: string | null;
  idempotencyUntil: string | null;
} {
  const retentionWindowMs = resolveGptJobRetentionWindowMs(status, env);
  if (retentionWindowMs <= 0) {
    return {
      retentionUntil: null,
      idempotencyUntil: null
    };
  }

  const retentionUntilMs = now.getTime() + retentionWindowMs;
  const idempotencyWindowMs = Math.min(
    retentionWindowMs,
    resolveGptIdempotencyRetentionMs(env)
  );

  return {
    retentionUntil: new Date(retentionUntilMs).toISOString(),
    idempotencyUntil: new Date(now.getTime() + idempotencyWindowMs).toISOString()
  };
}

export function resolveGptJobLifecycleStatus(status: string): GptJobLifecycleStatus {
  switch (status) {
    case 'pending':
      return 'queued';
    case 'running':
    case 'completed':
    case 'failed':
    case 'cancelled':
    case 'expired':
      return status;
    default:
      return 'queued';
  }
}

export function isGptJobTerminalStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'expired';
}

export function isGptJobReusableStatus(
  status: string,
  source: 'explicit' | 'derived'
): boolean {
  if (status === 'pending' || status === 'running' || status === 'completed') {
    return true;
  }

  return source === 'explicit' && (status === 'failed' || status === 'cancelled');
}

function parseTimestampMs(value: Date | string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  const parsedValue = Date.parse(value);
  return Number.isFinite(parsedValue) ? parsedValue : null;
}

export function shouldExpireGptJobRecord(
  job: Pick<JobData, 'status' | 'retention_until'>,
  nowMs = Date.now()
): boolean {
  if (job.status === 'expired') {
    return false;
  }

  if (!isGptJobTerminalStatus(job.status)) {
    return false;
  }

  const retentionUntilMs = parseTimestampMs(job.retention_until);
  return retentionUntilMs !== null && retentionUntilMs <= nowMs;
}

export function shouldExpirePendingGptJob(
  job: Pick<JobData, 'status' | 'created_at'>,
  nowMs = Date.now(),
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (job.status !== 'pending') {
    return false;
  }

  const createdAtMs = parseTimestampMs(job.created_at);
  if (createdAtMs === null) {
    return false;
  }

  return createdAtMs + resolveGptPendingMaxAgeMs(env) <= nowMs;
}

export function summarizeGptJobTimings(
  job: Pick<JobData, 'created_at' | 'started_at' | 'completed_at'>,
  nowMs = Date.now()
): {
  queueWaitMs: number | null;
  executionMs: number | null;
  endToEndMs: number | null;
} {
  const createdAtMs = parseTimestampMs(job.created_at);
  const startedAtMs = parseTimestampMs(job.started_at);
  const completedAtMs = parseTimestampMs(job.completed_at) ?? nowMs;

  return {
    queueWaitMs:
      createdAtMs !== null && startedAtMs !== null
        ? Math.max(0, startedAtMs - createdAtMs)
        : null,
    executionMs:
      startedAtMs !== null
        ? Math.max(0, completedAtMs - startedAtMs)
        : null,
    endToEndMs:
      createdAtMs !== null
        ? Math.max(0, completedAtMs - createdAtMs)
        : null
  };
}
