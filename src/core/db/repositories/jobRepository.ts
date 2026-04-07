/**
 * Job Repository for ARCANOS
 *
 * Handles queue persistence, retry scheduling, and lease-based worker claims.
 */

import { getPool, isDatabaseConnected } from '@core/db/client.js';
import type { JobData } from '@core/db/schema.js';
import { query } from '@core/db/query.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { safeJSONStringify } from '@shared/jsonHelpers.js';
import {
  computeGptJobLifecycleDeadlines,
  isGptJobReusableStatus,
  resolveGptExpiredCompactionMs,
  resolveGptPendingMaxAgeMs
} from '@shared/gpt/gptJobLifecycle.js';

export type JobFailureCategory =
  | 'authentication'
  | 'network'
  | 'provider'
  | 'rate_limited'
  | 'timeout'
  | 'validation'
  | 'unknown';

export interface JobFailureBreakdown {
  retryable: number;
  permanent: number;
  retryScheduled: number;
  retryExhausted: number;
  authentication: number;
  network: number;
  provider: number;
  rateLimited: number;
  timeout: number;
  validation: number;
  unknown: number;
}

export interface JobFailureReasonSummary {
  reason: string;
  category: JobFailureCategory;
  retryable: boolean | null;
  count: number;
  lastSeenAt: string;
}

export interface JobQueueSummary {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  total: number;
  delayed: number;
  stalledRunning: number;
  oldestPendingJobAgeMs: number;
  failureBreakdown: JobFailureBreakdown;
  recentFailureReasons: JobFailureReasonSummary[];
  recentTerminalWindowMs?: number;
  recentCompleted?: number;
  recentFailed?: number;
  recentTotalTerminal?: number;
  lastUpdatedAt?: string;
}

export interface CreateJobOptions {
  status?: string;
  retryCount?: number;
  maxRetries?: number;
  nextRunAt?: Date | string;
  startedAt?: Date | string | null;
  lastHeartbeatAt?: Date | string | null;
  leaseExpiresAt?: Date | string | null;
  priority?: number;
  lastWorkerId?: string | null;
  autonomyState?: Record<string, unknown>;
  requestFingerprintHash?: string | null;
  idempotencyKeyHash?: string | null;
  idempotencyScopeHash?: string | null;
  idempotencyOrigin?: 'explicit' | 'derived' | null;
  idempotencyUntil?: Date | string | null;
  retentionUntil?: Date | string | null;
  expiresAt?: Date | string | null;
  cancelRequestedAt?: Date | string | null;
  cancelReason?: string | null;
}

export interface UpdateJobMetadata {
  idempotencyUntil?: Date | string | null;
  retentionUntil?: Date | string | null;
  expiresAt?: Date | string | null;
  cancelRequestedAt?: Date | string | null;
  cancelReason?: string | null;
}

export interface ClaimNextPendingJobOptions {
  workerId?: string;
  leaseMs?: number;
}

export interface ScheduleJobRetryOptions {
  workerId?: string;
  delayMs: number;
  errorMessage: string;
  autonomyState?: Record<string, unknown>;
}

export interface RecoverStaleJobsOptions {
  staleAfterMs: number;
  maxRetries?: number;
}

export interface RecoverStaleJobsResult {
  recoveredJobs: string[];
  failedJobs: string[];
}

export interface JobExecutionStats {
  completed: number;
  failed: number;
  running: number;
  totalTerminal: number;
  aiCalls: number;
}

export interface FailedJobSnapshot {
  id: string;
  worker_id: string;
  last_worker_id: string | null;
  job_type: string;
  status: 'failed';
  error_message: string | null;
  retry_count: number;
  max_retries: number;
  created_at: string | Date;
  updated_at: string | Date;
  completed_at: string | Date | null;
}

export interface FindOrCreateGptJobOptions {
  workerId: string;
  input: unknown;
  requestFingerprintHash: string;
  idempotencyScopeHash: string;
  idempotencyKeyHash?: string | null;
  idempotencyOrigin: 'explicit' | 'derived';
  createOptions: CreateJobOptions;
}

export interface FindOrCreateGptJobResult {
  job: JobData;
  created: boolean;
  deduped: boolean;
  dedupeReason:
    | 'new_job'
    | 'reused_inflight_job'
    | 'reused_completed_result'
    | 'reused_terminal_result';
}

export interface CancelJobResult {
  outcome: 'cancelled' | 'cancellation_requested' | 'already_terminal' | 'not_found';
  job: JobData | null;
}

export interface CleanupGptJobsResult {
  expiredPending: number;
  expiredTerminal: number;
  deletedExpired: number;
}

export class JobRepositoryUnavailableError extends Error {
  readonly code = 'JOB_REPOSITORY_UNAVAILABLE';

  constructor(message = 'Job repository unavailable.') {
    super(message);
    this.name = 'JobRepositoryUnavailableError';
    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace?.(this, JobRepositoryUnavailableError);
  }
}

export class IdempotencyKeyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_KEY_CONFLICT';

  constructor(
    message = 'Explicit idempotency key mapped to a different GPT request fingerprint.'
  ) {
    super(message);
    this.name = 'IdempotencyKeyConflictError';
    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace?.(this, IdempotencyKeyConflictError);
  }
}

function assertDatabaseReady(): void {
  if (!isDatabaseConnected()) {
    throw new JobRepositoryUnavailableError('Database not configured');
  }
}

function normalizeCreateJobOptions(statusOrOptions: string | CreateJobOptions = 'pending'): CreateJobOptions {
  return typeof statusOrOptions === 'string'
    ? { status: statusOrOptions }
    : statusOrOptions;
}

function normalizeJsonbInput(value: unknown, context: string): string {
  const serialized = safeJSONStringify(value, context);

  //audit Assumption: job repository writes must remain JSON-serializable for JSONB columns; failure risk: partial queue writes or invalid JSONB values; expected invariant: inputs serialize before insert/update; handling strategy: throw explicit serialization errors.
  if (!serialized) {
    throw new Error(`Failed to serialize JSON payload for ${context}`);
  }

  return serialized;
}

function normalizeAutonomyState(state?: Record<string, unknown>): Record<string, unknown> {
  return state ?? {};
}

function normalizeNullableString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : null;
}

function applyGptLifecycleDefaults(jobType: string, status: string, options: CreateJobOptions): {
  idempotencyUntil: string | null;
  retentionUntil: string | null;
} {
  if (jobType !== 'gpt') {
    return {
      idempotencyUntil: normalizeNullableDate(options.idempotencyUntil),
      retentionUntil: normalizeNullableDate(options.retentionUntil)
    };
  }

  const computedDeadlines = computeGptJobLifecycleDeadlines(status);

  return {
    idempotencyUntil:
      normalizeNullableDate(options.idempotencyUntil) ?? computedDeadlines.idempotencyUntil,
    retentionUntil:
      normalizeNullableDate(options.retentionUntil) ?? computedDeadlines.retentionUntil
  };
}

async function acquireAdvisoryLock(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  namespace: string,
  key: string | null | undefined
): Promise<void> {
  const normalizedKey = normalizeNullableString(key);
  if (!normalizedKey) {
    return;
  }

  await client.query(
    'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
    [namespace, normalizedKey]
  );
}

function resolveReusableFingerprintStatuses(idempotencyOrigin: 'explicit' | 'derived'): string[] {
  const allStatuses = ['pending', 'running', 'completed', 'failed', 'cancelled'] as const;
  return allStatuses.filter((status) => isGptJobReusableStatus(status, idempotencyOrigin));
}

export const DEFAULT_QUEUE_DIAGNOSTICS_FAILURE_WINDOW_MS = 60 * 60 * 1000;

export function resolveQueueDiagnosticsFailureWindowMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  const rawValue = env.QUEUE_DIAGNOSTICS_FAILURE_WINDOW_MS;
  const parsedValue = rawValue ? Number(rawValue) : Number.NaN;

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return DEFAULT_QUEUE_DIAGNOSTICS_FAILURE_WINDOW_MS;
  }

  return Math.min(7 * 24 * 60 * 60 * 1000, Math.max(60 * 1000, Math.trunc(parsedValue)));
}

function buildEmptyFailureBreakdown(): JobFailureBreakdown {
  return {
    retryable: 0,
    permanent: 0,
    retryScheduled: 0,
    retryExhausted: 0,
    authentication: 0,
    network: 0,
    provider: 0,
    rateLimited: 0,
    timeout: 0,
    validation: 0,
    unknown: 0
  };
}

const VALID_FAILURE_CATEGORIES: readonly JobFailureCategory[] = [
  'authentication',
  'network',
  'provider',
  'rate_limited',
  'timeout',
  'validation',
  'unknown'
] as const;

function normalizeFailureCategory(value: unknown): JobFailureCategory {
  if (typeof value === 'string' && VALID_FAILURE_CATEGORIES.includes(value as JobFailureCategory)) {
    return value as JobFailureCategory;
  }

  return 'unknown';
}

function normalizeRecentFailureReasons(value: unknown): JobFailureReasonSummary[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return [];
    }

    const record = entry as Record<string, unknown>;
    const reason = typeof record.reason === 'string' && record.reason.trim().length > 0
      ? record.reason.trim()
      : 'unknown failure';
    const count = Number(record.count ?? 0);
    const lastSeenAt = record.lastSeenAt instanceof Date
      ? record.lastSeenAt.toISOString()
      : typeof record.lastSeenAt === 'string' && record.lastSeenAt.trim().length > 0
        ? new Date(record.lastSeenAt).toISOString()
        : new Date(0).toISOString();
    const retryable = typeof record.retryable === 'boolean' ? record.retryable : null;

    return [{
      reason,
      category: normalizeFailureCategory(record.category),
      retryable,
      count: Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0,
      lastSeenAt
    }];
  });
}

/**
 * Create a new queue job.
 * Purpose: persist queue work with scheduling, retry, and autonomy metadata in one write.
 * Inputs/outputs: accepts worker/job identity, raw input, and optional scheduling metadata; returns the created job row.
 * Edge case behavior: string legacy `status` input remains supported for existing call sites.
 */
export async function createJob(
  workerId: string,
  jobType: string,
  input: unknown,
  statusOrOptions: string | CreateJobOptions = 'pending'
): Promise<JobData> {
  assertDatabaseReady();

  const options = normalizeCreateJobOptions(statusOrOptions);
  const lifecycleDefaults = applyGptLifecycleDefaults(
    jobType,
    options.status ?? 'pending',
    options
  );
  const result = await query(
    `INSERT INTO job_data (
       worker_id,
       job_type,
       status,
       input,
       retry_count,
       max_retries,
       next_run_at,
       started_at,
       last_heartbeat_at,
       lease_expires_at,
       priority,
       last_worker_id,
       autonomy_state,
       request_fingerprint_hash,
       idempotency_key_hash,
       idempotency_scope_hash,
       idempotency_origin,
       idempotency_until,
       retention_until,
       expires_at,
       cancel_requested_at,
       cancel_reason
     )
     VALUES (
       $1,
       $2,
       $3,
       $4::jsonb,
       $5,
       $6,
       COALESCE($7::timestamptz, NOW()),
       $8::timestamptz,
       $9::timestamptz,
       $10::timestamptz,
       $11,
       $12,
       $13::jsonb,
       $14,
       $15,
       $16,
       $17,
       $18::timestamptz,
       $19::timestamptz,
       $20::timestamptz,
       $21::timestamptz,
       $22
     )
     RETURNING *`,
    [
      workerId,
      jobType,
      options.status ?? 'pending',
      normalizeJsonbInput(input, 'jobRepository.createJob.input'),
      options.retryCount ?? 0,
      options.maxRetries ?? 2,
      normalizeNullableDate(options.nextRunAt),
      normalizeNullableDate(options.startedAt),
      normalizeNullableDate(options.lastHeartbeatAt),
      normalizeNullableDate(options.leaseExpiresAt),
      options.priority ?? 100,
      options.lastWorkerId ?? null,
      normalizeJsonbInput(
        normalizeAutonomyState(options.autonomyState),
        'jobRepository.createJob.autonomyState'
      ),
      normalizeNullableString(options.requestFingerprintHash ?? null),
      normalizeNullableString(options.idempotencyKeyHash ?? null),
      normalizeNullableString(options.idempotencyScopeHash ?? null),
      normalizeNullableString(options.idempotencyOrigin ?? null),
      lifecycleDefaults.idempotencyUntil,
      lifecycleDefaults.retentionUntil,
      normalizeNullableDate(options.expiresAt),
      normalizeNullableDate(options.cancelRequestedAt),
      normalizeNullableString(options.cancelReason ?? null)
    ]
  );

  return result.rows[0] as JobData;
}

/**
 * Update job status and terminal output.
 * Purpose: persist job completion or failure while clearing lease metadata for non-running states.
 * Inputs/outputs: accepts job id, status, output payload, and optional error string; returns the updated job row.
 * Edge case behavior: running jobs retain their lease fields while terminal states clear them and stamp completion time.
 */
export async function updateJob(
  jobId: string,
  status: string,
  output: unknown = null,
  errorMessage: string | null = null,
  autonomyState?: Record<string, unknown>,
  metadata: UpdateJobMetadata = {}
): Promise<JobData> {
  assertDatabaseReady();

  const terminalStatus =
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'expired';
  const runningStatus = status === 'running';
  const result = await query(
    `UPDATE job_data
     SET
      status = $1::varchar(50),
       output = $2::jsonb,
       error_message = $3,
       updated_at = NOW(),
       completed_at = CASE
         WHEN $4 THEN COALESCE(completed_at, NOW())
         ELSE completed_at
       END,
       started_at = CASE
         WHEN $5 THEN COALESCE(started_at, NOW())
         ELSE started_at
       END,
       last_heartbeat_at = CASE
         WHEN $5 THEN COALESCE(last_heartbeat_at, NOW())
         ELSE NULL
       END,
       lease_expires_at = CASE
         WHEN $5 THEN lease_expires_at
         ELSE NULL
       END,
       autonomy_state = COALESCE(autonomy_state, '{}'::jsonb) || $6::jsonb,
       idempotency_until = COALESCE($7::timestamptz, idempotency_until),
       retention_until = COALESCE($8::timestamptz, retention_until),
       expires_at = CASE
         WHEN $9::timestamptz IS NOT NULL THEN $9::timestamptz
        WHEN $1::varchar(50) = 'expired'::varchar(50) THEN COALESCE(expires_at, NOW())
         ELSE expires_at
       END,
       cancel_requested_at = CASE
         WHEN $10::timestamptz IS NOT NULL THEN $10::timestamptz
        WHEN $1::varchar(50) = 'cancelled'::varchar(50) THEN COALESCE(cancel_requested_at, NOW())
         ELSE cancel_requested_at
       END,
       cancel_reason = COALESCE($11, cancel_reason)
     WHERE id = $12
     RETURNING *`,
    [
      status,
      normalizeJsonbInput(output, 'jobRepository.updateJob.output'),
      errorMessage,
      terminalStatus,
      runningStatus,
      normalizeJsonbInput(
        normalizeAutonomyState(autonomyState),
        'jobRepository.updateJob.autonomyState'
      ),
      normalizeNullableDate(metadata.idempotencyUntil),
      normalizeNullableDate(metadata.retentionUntil),
      normalizeNullableDate(metadata.expiresAt),
      normalizeNullableDate(metadata.cancelRequestedAt),
      normalizeNullableString(metadata.cancelReason ?? null),
      jobId
    ]
  );

  return result.rows[0] as JobData;
}

/**
 * Get one job by identifier.
 * Purpose: support queue polling and operator inspection of DB-backed jobs.
 * Inputs/outputs: accepts a job id and returns the matching job row or `null`.
 * Edge case behavior: returns `null` when the database is unavailable or the row does not exist.
 */
export async function getJobById(jobId: string): Promise<JobData | null> {
  if (!isDatabaseConnected()) {
    return null;
  }

  const result = await query('SELECT * FROM job_data WHERE id = $1 LIMIT 1', [jobId]);
  return (result.rows[0] as JobData | undefined) ?? null;
}

async function findReusableGptJobByIdempotencyKey(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  options: {
    idempotencyScopeHash: string;
    idempotencyKeyHash: string;
  }
): Promise<JobData | null> {
  const result = await client.query(
    `SELECT *
     FROM job_data
     WHERE job_type = 'gpt'
       AND idempotency_scope_hash = $1
       AND idempotency_key_hash = $2
       AND status <> 'expired'
       AND (
         status IN ('pending', 'running')
         OR (idempotency_until IS NOT NULL AND idempotency_until > NOW())
       )
     ORDER BY
       CASE status
         WHEN 'running' THEN 0
         WHEN 'pending' THEN 1
         WHEN 'completed' THEN 2
         WHEN 'failed' THEN 3
         WHEN 'cancelled' THEN 4
         ELSE 5
       END ASC,
       created_at DESC
     LIMIT 1`,
    [options.idempotencyScopeHash, options.idempotencyKeyHash]
  );

  return (result.rows[0] as JobData | undefined) ?? null;
}

async function findReusableGptJobByFingerprint(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  options: {
    idempotencyScopeHash: string;
    requestFingerprintHash: string;
    idempotencyOrigin: 'explicit' | 'derived';
  }
): Promise<JobData | null> {
  const reusableStatuses = resolveReusableFingerprintStatuses(options.idempotencyOrigin);
  const result = await client.query(
    `SELECT *
     FROM job_data
     WHERE job_type = 'gpt'
       AND idempotency_scope_hash = $1
       AND request_fingerprint_hash = $2
       AND status = ANY($3::text[])
       AND status <> 'expired'
       AND (
         status IN ('pending', 'running')
         OR (idempotency_until IS NOT NULL AND idempotency_until > NOW())
       )
     ORDER BY
       CASE status
         WHEN 'running' THEN 0
         WHEN 'pending' THEN 1
         WHEN 'completed' THEN 2
         WHEN 'failed' THEN 3
         WHEN 'cancelled' THEN 4
         ELSE 5
       END ASC,
       created_at DESC
     LIMIT 1`,
    [options.idempotencyScopeHash, options.requestFingerprintHash, reusableStatuses]
  );

  return (result.rows[0] as JobData | undefined) ?? null;
}

function classifyGptJobReuse(job: JobData): FindOrCreateGptJobResult['dedupeReason'] {
  if (job.status === 'completed') {
    return 'reused_completed_result';
  }

  if (job.status === 'failed' || job.status === 'cancelled') {
    return 'reused_terminal_result';
  }

  return 'reused_inflight_job';
}

/**
 * Find an existing reusable GPT job or create a new canonical row under transaction-scoped advisory locks.
 * Purpose: collapse duplicate async GPT submissions safely across concurrent web instances.
 * Inputs/outputs: accepts hashed scope/idempotency identifiers plus create options; returns either the new row or the canonical reusable row.
 * Edge case behavior: explicit idempotency key reuse with a different semantic fingerprint throws a conflict instead of silently aliasing the wrong job.
 */
export async function findOrCreateGptJob(
  options: FindOrCreateGptJobOptions
): Promise<FindOrCreateGptJobResult> {
  assertDatabaseReady();

  const pool = getPool();
  if (!pool) {
    throw new JobRepositoryUnavailableError('Database pool unavailable');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await acquireAdvisoryLock(
      client,
      'job_data.gpt.idempotency_scope',
      options.idempotencyScopeHash
    );
    await acquireAdvisoryLock(
      client,
      'job_data.gpt.idempotency_key',
      options.idempotencyKeyHash ?? null
    );
    await acquireAdvisoryLock(
      client,
      'job_data.gpt.request_fingerprint',
      `${options.idempotencyScopeHash}:${options.requestFingerprintHash}`
    );

    if (options.idempotencyKeyHash) {
      const existingJobByKey = await findReusableGptJobByIdempotencyKey(client, {
        idempotencyScopeHash: options.idempotencyScopeHash,
        idempotencyKeyHash: options.idempotencyKeyHash
      });

      if (existingJobByKey) {
        const existingFingerprintHash = normalizeNullableString(
          existingJobByKey.request_fingerprint_hash ?? null
        );

        if (
          existingFingerprintHash &&
          existingFingerprintHash !== options.requestFingerprintHash
        ) {
          throw new IdempotencyKeyConflictError(
            'Explicit idempotency key mapped to a different GPT request fingerprint.'
          );
        }

        await client.query('COMMIT');
        return {
          job: existingJobByKey,
          created: false,
          deduped: true,
          dedupeReason: classifyGptJobReuse(existingJobByKey)
        };
      }
    }

    const existingJobByFingerprint = await findReusableGptJobByFingerprint(client, {
      idempotencyScopeHash: options.idempotencyScopeHash,
      requestFingerprintHash: options.requestFingerprintHash,
      idempotencyOrigin: options.idempotencyOrigin
    });

    if (existingJobByFingerprint) {
      await client.query('COMMIT');
      return {
        job: existingJobByFingerprint,
        created: false,
        deduped: true,
        dedupeReason: classifyGptJobReuse(existingJobByFingerprint)
      };
    }

    const createOptions: CreateJobOptions = {
      ...options.createOptions,
      requestFingerprintHash: options.requestFingerprintHash,
      idempotencyKeyHash: options.idempotencyKeyHash ?? null,
      idempotencyScopeHash: options.idempotencyScopeHash,
      idempotencyOrigin: options.idempotencyOrigin
    };
    const lifecycleDefaults = applyGptLifecycleDefaults(
      'gpt',
      createOptions.status ?? 'pending',
      createOptions
    );
    const result = await client.query(
      `INSERT INTO job_data (
         worker_id,
         job_type,
         status,
         input,
         retry_count,
         max_retries,
         next_run_at,
         started_at,
         last_heartbeat_at,
         lease_expires_at,
         priority,
         last_worker_id,
         autonomy_state,
         request_fingerprint_hash,
         idempotency_key_hash,
         idempotency_scope_hash,
         idempotency_origin,
         idempotency_until,
         retention_until,
         expires_at,
         cancel_requested_at,
         cancel_reason
       )
       VALUES (
         $1,
         'gpt',
         $2,
         $3::jsonb,
         $4,
         $5,
         COALESCE($6::timestamptz, NOW()),
         $7::timestamptz,
         $8::timestamptz,
         $9::timestamptz,
         $10,
         $11,
         $12::jsonb,
         $13,
         $14,
         $15,
         $16,
         $17::timestamptz,
         $18::timestamptz,
         $19::timestamptz,
         $20::timestamptz,
         $21
       )
       RETURNING *`,
      [
        options.workerId,
        createOptions.status ?? 'pending',
        normalizeJsonbInput(options.input, 'jobRepository.findOrCreateGptJob.input'),
        createOptions.retryCount ?? 0,
        createOptions.maxRetries ?? 2,
        normalizeNullableDate(createOptions.nextRunAt),
        normalizeNullableDate(createOptions.startedAt),
        normalizeNullableDate(createOptions.lastHeartbeatAt),
        normalizeNullableDate(createOptions.leaseExpiresAt),
        createOptions.priority ?? 100,
        createOptions.lastWorkerId ?? null,
        normalizeJsonbInput(
          normalizeAutonomyState(createOptions.autonomyState),
          'jobRepository.findOrCreateGptJob.autonomyState'
        ),
        options.requestFingerprintHash,
        normalizeNullableString(options.idempotencyKeyHash ?? null),
        options.idempotencyScopeHash,
        options.idempotencyOrigin,
        lifecycleDefaults.idempotencyUntil,
        lifecycleDefaults.retentionUntil,
        normalizeNullableDate(createOptions.expiresAt),
        normalizeNullableDate(createOptions.cancelRequestedAt),
        normalizeNullableString(createOptions.cancelReason ?? null)
      ]
    );

    await client.query('COMMIT');
    return {
      job: result.rows[0] as JobData,
      created: true,
      deduped: false,
      dedupeReason: 'new_job'
    };
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Request cancellation for a queued job.
 * Purpose: stop pending GPT work immediately and signal best-effort abortion for currently running GPT jobs.
 * Inputs/outputs: accepts a job id plus optional reason; returns the current cancellation outcome and row snapshot.
 * Edge case behavior: terminal jobs are left unchanged and reported explicitly so API callers do not assume cancellation succeeded.
 */
export async function requestJobCancellation(
  jobId: string,
  reason = 'Job cancellation requested by client.'
): Promise<CancelJobResult> {
  assertDatabaseReady();

  const pool = getPool();
  if (!pool) {
    throw new Error('Database pool unavailable');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const jobResult = await client.query(
      'SELECT * FROM job_data WHERE id = $1 FOR UPDATE',
      [jobId]
    );
    const job = (jobResult.rows[0] as JobData | undefined) ?? null;
    if (!job) {
      await client.query('COMMIT');
      return {
        outcome: 'not_found',
        job: null
      };
    }

    if (
      job.status === 'completed' ||
      job.status === 'failed' ||
      job.status === 'cancelled' ||
      job.status === 'expired'
    ) {
      await client.query('COMMIT');
      return {
        outcome: 'already_terminal',
        job
      };
    }

    const normalizedReason = normalizeNullableString(reason) ?? 'Job cancellation requested by client.';
    const lifecycleDeadlines =
      job.job_type === 'gpt'
        ? computeGptJobLifecycleDeadlines('cancelled')
        : { idempotencyUntil: null, retentionUntil: null };

    if (job.status === 'pending') {
      const cancelledJobResult = await client.query(
        `UPDATE job_data
         SET
           status = 'cancelled',
           error_message = COALESCE(error_message, $1),
           updated_at = NOW(),
           completed_at = COALESCE(completed_at, NOW()),
           last_heartbeat_at = NULL,
           lease_expires_at = NULL,
           cancel_requested_at = NOW(),
           cancel_reason = $2,
           idempotency_until = COALESCE($3::timestamptz, idempotency_until),
           retention_until = COALESCE($4::timestamptz, retention_until)
         WHERE id = $5
         RETURNING *`,
        [
          normalizedReason,
          normalizedReason,
          lifecycleDeadlines.idempotencyUntil,
          lifecycleDeadlines.retentionUntil,
          jobId
        ]
      );

      await client.query('COMMIT');
      return {
        outcome: 'cancelled',
        job: (cancelledJobResult.rows[0] as JobData | undefined) ?? job
      };
    }

    const requestedCancellationResult = await client.query(
      `UPDATE job_data
       SET
         updated_at = NOW(),
         cancel_requested_at = COALESCE(cancel_requested_at, NOW()),
         cancel_reason = COALESCE($1, cancel_reason),
         autonomy_state = COALESCE(autonomy_state, '{}'::jsonb) || $2::jsonb
       WHERE id = $3
       RETURNING *`,
      [
        normalizedReason,
        normalizeJsonbInput(
          {
            cancellation: {
              requestedAt: new Date().toISOString(),
              reason: normalizedReason
            }
          },
          'jobRepository.requestJobCancellation.autonomyState'
        ),
        jobId
      ]
    );

    await client.query('COMMIT');
    return {
      outcome: 'cancellation_requested',
      job: (requestedCancellationResult.rows[0] as JobData | undefined) ?? job
    };
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Atomically claim the next runnable pending job using SKIP LOCKED.
 * Purpose: lease due queue work to one worker while respecting scheduling and priority.
 * Inputs/outputs: optional worker id and lease duration; returns the claimed job or `null`.
 * Edge case behavior: ignores pending jobs scheduled for the future and returns `null` when none are due.
 */
export async function claimNextPendingJob(
  options: ClaimNextPendingJobOptions = {}
): Promise<JobData | null> {
  assertDatabaseReady();

  const pool = getPool();
  if (!pool) {
    throw new Error('Database pool unavailable');
  }

  const leaseMs = Math.max(1_000, options.leaseMs ?? 30_000);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `UPDATE job_data
       SET
         status = 'running',
         updated_at = NOW(),
         started_at = COALESCE(started_at, NOW()),
         last_heartbeat_at = NOW(),
         lease_expires_at = NOW() + ($1::bigint * INTERVAL '1 millisecond'),
         last_worker_id = COALESCE($2, last_worker_id)
       WHERE id = (
         SELECT id
         FROM job_data
         WHERE status = 'pending'
           AND next_run_at <= NOW()
         ORDER BY priority ASC, next_run_at ASC, created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING *`,
      [leaseMs, options.workerId ?? null]
    );

    await client.query('COMMIT');
    return (result.rows[0] as JobData | undefined) ?? null;
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    console.error('Error claiming pending job:', resolveErrorMessage(error));
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Extend the lease and heartbeat for one running job.
 * Purpose: prevent active work from being mistaken for a stalled job by the inspector.
 * Inputs/outputs: accepts a job id plus optional worker id and lease duration; returns the updated job or `null`.
 * Edge case behavior: returns `null` when the job is no longer running.
 */
export async function recordJobHeartbeat(
  jobId: string,
  options: ClaimNextPendingJobOptions = {}
): Promise<JobData | null> {
  assertDatabaseReady();

  const leaseMs = Math.max(1_000, options.leaseMs ?? 30_000);
  const result = await query(
    `UPDATE job_data
     SET
       updated_at = NOW(),
       last_heartbeat_at = NOW(),
       lease_expires_at = NOW() + ($1::bigint * INTERVAL '1 millisecond'),
       last_worker_id = COALESCE($2, last_worker_id)
     WHERE id = $3
       AND status = 'running'
     RETURNING *`,
    [leaseMs, options.workerId ?? null, jobId]
  );

  return (result.rows[0] as JobData | undefined) ?? null;
}

/**
 * Reschedule a failed job for retry.
 * Purpose: implement exponential backoff without dropping queue state or losing prior attempts.
 * Inputs/outputs: accepts a job id, retry delay, and failure context; returns the rescheduled job.
 * Edge case behavior: preserves existing job input/output while clearing running lease metadata.
 */
export async function scheduleJobRetry(
  jobId: string,
  options: ScheduleJobRetryOptions
): Promise<JobData> {
  assertDatabaseReady();

  const result = await query(
    `UPDATE job_data
     SET
       status = 'pending',
       error_message = $1,
       retry_count = retry_count + 1,
       next_run_at = NOW() + ($2::bigint * INTERVAL '1 millisecond'),
       updated_at = NOW(),
       completed_at = NULL,
       last_heartbeat_at = NULL,
       lease_expires_at = NULL,
       idempotency_until = NULL,
       retention_until = NULL,
       expires_at = NULL,
       cancel_requested_at = NULL,
       cancel_reason = NULL,
       last_worker_id = COALESCE($3, last_worker_id),
       autonomy_state = COALESCE(autonomy_state, '{}'::jsonb) || $4::jsonb
     WHERE id = $5
     RETURNING *`,
    [
      options.errorMessage,
      Math.max(0, options.delayMs),
      options.workerId ?? null,
      normalizeJsonbInput(
        normalizeAutonomyState(options.autonomyState),
        'jobRepository.scheduleJobRetry.autonomyState'
      ),
      jobId
    ]
  );

  return result.rows[0] as JobData;
}

/**
 * Recover stale running jobs whose leases expired or heartbeats disappeared.
 * Purpose: self-heal queue state after worker crashes or hung executions.
 * Inputs/outputs: accepts stale timing and retry limits; returns recovered and terminally failed job ids.
 * Edge case behavior: jobs that already exceeded retry caps are marked failed instead of re-queued.
 */
export async function recoverStaleJobs(
  options: RecoverStaleJobsOptions
): Promise<RecoverStaleJobsResult> {
  assertDatabaseReady();

  const pool = getPool();
  if (!pool) {
    throw new Error('Database pool unavailable');
  }

  const staleAfterMs = Math.max(1_000, options.staleAfterMs);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const staleResult = await client.query(
      `SELECT id, job_type, retry_count, max_retries, autonomy_state, cancel_requested_at, cancel_reason
       FROM job_data
       WHERE status = 'running'
         AND (
           (lease_expires_at IS NOT NULL AND lease_expires_at < NOW())
           OR (last_heartbeat_at IS NULL AND started_at < NOW() - ($1::bigint * INTERVAL '1 millisecond'))
           OR (last_heartbeat_at IS NOT NULL AND last_heartbeat_at < NOW() - ($1::bigint * INTERVAL '1 millisecond'))
         )
       FOR UPDATE`,
      [staleAfterMs]
    );

    const recoveredJobs: string[] = [];
    const failedJobs: string[] = [];

    for (const row of staleResult.rows as Array<{
      id: string;
      job_type: string;
      retry_count: number;
      max_retries: number;
      autonomy_state: Record<string, unknown> | string | null;
      cancel_requested_at: Date | string | null;
      cancel_reason: string | null;
    }>) {
      const retryCount = Number(row.retry_count ?? 0);
      const maxRetries = Number(options.maxRetries ?? row.max_retries ?? 2);
      const normalizedAutonomyState = buildRecoveredAutonomyState(row.autonomy_state, retryCount);

      if (row.cancel_requested_at) {
        const lifecycleDeadlines =
          row.job_type === 'gpt'
            ? computeGptJobLifecycleDeadlines('cancelled')
            : { idempotencyUntil: null, retentionUntil: null };
        await client.query(
          `UPDATE job_data
           SET
             status = 'cancelled',
             error_message = COALESCE(error_message, $1),
             updated_at = NOW(),
             completed_at = COALESCE(completed_at, NOW()),
             last_heartbeat_at = NULL,
             lease_expires_at = NULL,
             cancel_reason = COALESCE(cancel_reason, $2),
             autonomy_state = $3::jsonb,
             idempotency_until = COALESCE($4::timestamptz, idempotency_until),
             retention_until = COALESCE($5::timestamptz, retention_until)
           WHERE id = $6`,
          [
            row.cancel_reason ?? 'Job cancellation was requested before stale recovery.',
            row.cancel_reason ?? 'Job cancellation was requested before stale recovery.',
            normalizeJsonbInput(
              normalizedAutonomyState,
              'jobRepository.recoverStaleJobs.cancelledAutonomyState'
            ),
            lifecycleDeadlines.idempotencyUntil,
            lifecycleDeadlines.retentionUntil,
            row.id
          ]
        );
        failedJobs.push(row.id);
        continue;
      }

      //audit Assumption: stale running jobs should be retried only while within retry budget; failure risk: infinite stale-recovery loops; expected invariant: exhausted jobs become terminal failures; handling strategy: branch on retry budget before resetting state.
      if (retryCount >= maxRetries) {
        const lifecycleDeadlines =
          row.job_type === 'gpt'
            ? computeGptJobLifecycleDeadlines('failed')
            : { idempotencyUntil: null, retentionUntil: null };
        await client.query(
          `UPDATE job_data
           SET
             status = 'failed',
             error_message = 'Job lease expired and retry budget was exhausted during recovery.',
             updated_at = NOW(),
             completed_at = NOW(),
             last_heartbeat_at = NULL,
             lease_expires_at = NULL,
             autonomy_state = $1::jsonb,
             idempotency_until = COALESCE($2::timestamptz, idempotency_until),
             retention_until = COALESCE($3::timestamptz, retention_until)
           WHERE id = $4`,
          [
            normalizeJsonbInput(
              normalizedAutonomyState,
              'jobRepository.recoverStaleJobs.failedAutonomyState'
            ),
            lifecycleDeadlines.idempotencyUntil,
            lifecycleDeadlines.retentionUntil,
            row.id
          ]
        );
        failedJobs.push(row.id);
        continue;
      }

      await client.query(
        `UPDATE job_data
         SET
           status = 'pending',
           error_message = 'Job recovered after stale worker lease.',
           retry_count = retry_count + 1,
           next_run_at = NOW(),
           updated_at = NOW(),
           last_heartbeat_at = NULL,
           lease_expires_at = NULL,
           idempotency_until = NULL,
           retention_until = NULL,
           expires_at = NULL,
           cancel_requested_at = NULL,
           cancel_reason = NULL,
           autonomy_state = $1::jsonb
         WHERE id = $2`,
        [
          normalizeJsonbInput(
            normalizedAutonomyState,
            'jobRepository.recoverStaleJobs.recoveredAutonomyState'
          ),
          row.id
        ]
      );
      recoveredJobs.push(row.id);
    }

    await client.query('COMMIT');
    return { recoveredJobs, failedJobs };
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    console.error('Error recovering stale jobs:', resolveErrorMessage(error));
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get the latest queue job.
 * Purpose: support operator tooling that needs one recent queue sample.
 * Inputs/outputs: no inputs, returns the most recently created job or `null`.
 * Edge case behavior: returns `null` when the database is unavailable or no jobs exist.
 */
export async function getLatestJob(): Promise<JobData | null> {
  if (!isDatabaseConnected()) {
    return null;
  }

  try {
    const result = await query('SELECT * FROM job_data ORDER BY created_at DESC LIMIT 1', []);
    return (result.rows[0] as JobData | undefined) ?? null;
  } catch (error: unknown) {
    //audit Assumption: latest job lookup failure should degrade observability rather than crash helper routes; failure risk: status endpoints fail on transient query issues; expected invariant: lookup errors are logged and return `null`; handling strategy: fail closed.
    console.error('Error fetching latest job:', resolveErrorMessage(error));
    return null;
  }
}

/**
 * Get aggregate counts for the async worker queue.
 * Purpose: expose one stable queue summary for helper routes, health checks, and planning logic.
 * Inputs/outputs: no inputs, returns normalized queue counters plus freshness metadata.
 * Edge case behavior: returns `null` when the database is unavailable or the summary query fails.
 */
export async function getJobQueueSummary(): Promise<JobQueueSummary | null> {
  //audit Assumption: queue summaries are only trustworthy when the database connection is active; failure risk: helper surfaces fabricated worker state; expected invariant: disconnected DB returns no summary; handling strategy: fail closed with `null`.
  if (!isDatabaseConnected()) {
    return null;
  }

  try {
    const recentTerminalWindowMs = resolveQueueDiagnosticsFailureWindowMs();
    const result = await query(
      `WITH failure_rows AS (
         SELECT
           status,
           retry_count,
           max_retries,
           updated_at,
           COALESCE(autonomy_state->'lastFailure'->>'reason', error_message, 'unknown failure') AS reason,
           CASE
             WHEN COALESCE(autonomy_state->'lastFailure'->>'category', '') <> ''
               THEN autonomy_state->'lastFailure'->>'category'
             WHEN LOWER(COALESCE(error_message, '')) LIKE '%incorrect api key%'
               OR LOWER(COALESCE(error_message, '')) LIKE '%invalid api key%'
               OR LOWER(COALESCE(error_message, '')) LIKE '%authentication%'
               THEN 'authentication'
             WHEN LOWER(COALESCE(error_message, '')) LIKE '%timeout%'
               OR LOWER(COALESCE(error_message, '')) LIKE '%timed out%'
               OR LOWER(COALESCE(error_message, '')) LIKE '%aborted%'
               THEN 'timeout'
             WHEN LOWER(COALESCE(error_message, '')) LIKE '%rate limit%'
               OR LOWER(COALESCE(error_message, '')) LIKE '%quota%'
               OR LOWER(COALESCE(error_message, '')) LIKE '%429%'
               THEN 'rate_limited'
             WHEN LOWER(COALESCE(error_message, '')) LIKE '%network%'
               OR LOWER(COALESCE(error_message, '')) LIKE '%socket%'
               OR LOWER(COALESCE(error_message, '')) LIKE '%econn%'
               OR LOWER(COALESCE(error_message, '')) LIKE '%fetch failed%'
               THEN 'network'
             WHEN LOWER(COALESCE(error_message, '')) LIKE '%validation%'
               OR LOWER(COALESCE(error_message, '')) LIKE '%schema%'
               OR LOWER(COALESCE(error_message, '')) LIKE '%unsupported job_type%'
               OR LOWER(COALESCE(error_message, '')) LIKE '%invalid job.input%'
               THEN 'validation'
             WHEN LOWER(COALESCE(error_message, '')) LIKE '%openai%'
               OR LOWER(COALESCE(error_message, '')) LIKE '%provider%'
               OR LOWER(COALESCE(error_message, '')) LIKE '%500%'
               OR LOWER(COALESCE(error_message, '')) LIKE '%502%'
               OR LOWER(COALESCE(error_message, '')) LIKE '%503%'
               OR LOWER(COALESCE(error_message, '')) LIKE '%504%'
               THEN 'provider'
             ELSE 'unknown'
           END AS category,
           CASE
             WHEN autonomy_state->'lastFailure'->>'retryable' IN ('true', 'false')
               THEN (autonomy_state->'lastFailure'->>'retryable')::boolean
             ELSE retry_count < max_retries
           END AS retryable,
           CASE
             WHEN autonomy_state->'lastFailure'->>'retryExhausted' IN ('true', 'false')
               THEN (autonomy_state->'lastFailure'->>'retryExhausted')::boolean
             ELSE status = 'failed' AND retry_count >= max_retries
           END AS retry_exhausted
         FROM job_data
         WHERE status = 'failed'
       ),
       summary AS (
         SELECT
           COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
           COUNT(*) FILTER (WHERE status = 'running')::int AS running_count,
           COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_count,
           COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
           COUNT(*)::int AS total_count,
           COUNT(*) FILTER (WHERE status = 'pending' AND next_run_at > NOW())::int AS delayed_count,
           COUNT(*) FILTER (
             WHERE status = 'running'
               AND (
                 (lease_expires_at IS NOT NULL AND lease_expires_at < NOW())
                 OR (last_heartbeat_at IS NOT NULL AND last_heartbeat_at < NOW() - INTERVAL '60 seconds')
               )
           )::int AS stalled_running_count,
           COALESCE(
             MAX(
               CASE
                 WHEN status = 'pending' AND next_run_at <= NOW()
                 THEN EXTRACT(EPOCH FROM (NOW() - created_at)) * 1000
                 ELSE 0
               END
             ),
             0
           )::bigint AS oldest_pending_age_ms,
           MAX(updated_at) AS last_updated_at,
           COUNT(*) FILTER (
             WHERE status = 'completed'
               AND updated_at >= NOW() - ($1::bigint * INTERVAL '1 millisecond')
           )::int AS recent_completed_count,
           COUNT(*) FILTER (
             WHERE status = 'failed'
               AND updated_at >= NOW() - ($1::bigint * INTERVAL '1 millisecond')
           )::int AS recent_failed_count,
           COUNT(*) FILTER (
             WHERE status IN ('completed', 'failed')
               AND updated_at >= NOW() - ($1::bigint * INTERVAL '1 millisecond')
           )::int AS recent_terminal_count,
           COUNT(*) FILTER (WHERE status = 'pending' AND retry_count > 0)::int AS retry_scheduled_count
         FROM job_data
       ),
       failure_breakdown AS (
         SELECT
           COUNT(*) FILTER (WHERE status = 'failed' AND retryable)::int AS retryable_count,
           COUNT(*) FILTER (WHERE status = 'failed' AND NOT retryable)::int AS permanent_count,
           COUNT(*) FILTER (WHERE status = 'failed' AND retry_exhausted)::int AS retry_exhausted_count,
           COUNT(*) FILTER (WHERE status = 'failed' AND category = 'authentication')::int AS authentication_count,
           COUNT(*) FILTER (WHERE status = 'failed' AND category = 'network')::int AS network_count,
           COUNT(*) FILTER (WHERE status = 'failed' AND category = 'provider')::int AS provider_count,
           COUNT(*) FILTER (WHERE status = 'failed' AND category = 'rate_limited')::int AS rate_limited_count,
           COUNT(*) FILTER (WHERE status = 'failed' AND category = 'timeout')::int AS timeout_count,
           COUNT(*) FILTER (WHERE status = 'failed' AND category = 'validation')::int AS validation_count,
           COUNT(*) FILTER (WHERE status = 'failed' AND category = 'unknown')::int AS unknown_count
         FROM failure_rows
       ),
       recent_failure_reasons AS (
         SELECT
           reason,
           category,
           retryable,
           COUNT(*)::int AS count,
           MAX(updated_at) AS last_seen_at
         FROM failure_rows
         WHERE status = 'failed'
         GROUP BY reason, category, retryable
         ORDER BY MAX(updated_at) DESC
         LIMIT 5
       )
       SELECT
         summary.pending_count,
         summary.running_count,
         summary.completed_count,
         summary.failed_count,
         summary.total_count,
         summary.delayed_count,
         summary.stalled_running_count,
         summary.oldest_pending_age_ms,
         summary.last_updated_at,
         summary.recent_completed_count,
         summary.recent_failed_count,
         summary.recent_terminal_count,
         summary.retry_scheduled_count,
         failure_breakdown.retryable_count,
         failure_breakdown.permanent_count,
         failure_breakdown.retry_exhausted_count,
         failure_breakdown.authentication_count,
         failure_breakdown.network_count,
         failure_breakdown.provider_count,
         failure_breakdown.rate_limited_count,
         failure_breakdown.timeout_count,
         failure_breakdown.validation_count,
         failure_breakdown.unknown_count,
         COALESCE(
           (
             SELECT jsonb_agg(
               jsonb_build_object(
                 'reason', reason,
                 'category', category,
                 'retryable', retryable,
                 'count', count,
                 'lastSeenAt', last_seen_at
               )
               ORDER BY last_seen_at DESC
             )
             FROM recent_failure_reasons
           ),
           '[]'::jsonb
         ) AS recent_failure_reasons
       FROM summary
       CROSS JOIN failure_breakdown`,
      [recentTerminalWindowMs]
    );

    const summaryRow = result.rows[0] as {
      pending_count: number;
      running_count: number;
      completed_count: number;
      failed_count: number;
      total_count: number;
      delayed_count: number;
      stalled_running_count: number;
      oldest_pending_age_ms: number;
      recent_completed_count: number;
      recent_failed_count: number;
      recent_terminal_count: number;
      retry_scheduled_count: number;
      retryable_count: number;
      permanent_count: number;
      retry_exhausted_count: number;
      authentication_count: number;
      network_count: number;
      provider_count: number;
      rate_limited_count: number;
      timeout_count: number;
      validation_count: number;
      unknown_count: number;
      recent_failure_reasons?: unknown;
      last_updated_at?: string | Date | null;
    } | undefined;

    if (!summaryRow) {
      return {
        pending: 0,
        running: 0,
        completed: 0,
        failed: 0,
        total: 0,
        delayed: 0,
        stalledRunning: 0,
        oldestPendingJobAgeMs: 0,
        failureBreakdown: buildEmptyFailureBreakdown(),
        recentFailureReasons: [],
        recentTerminalWindowMs,
        recentCompleted: 0,
        recentFailed: 0,
        recentTotalTerminal: 0
      };
    }

    const summary: JobQueueSummary = {
      pending: summaryRow.pending_count,
      running: summaryRow.running_count,
      completed: summaryRow.completed_count,
      failed: summaryRow.failed_count,
      total: summaryRow.total_count,
      delayed: summaryRow.delayed_count,
      stalledRunning: summaryRow.stalled_running_count,
      oldestPendingJobAgeMs: Number(summaryRow.oldest_pending_age_ms ?? 0),
      failureBreakdown: {
        retryable: Number(summaryRow.retryable_count ?? 0),
        permanent: Number(summaryRow.permanent_count ?? 0),
        retryScheduled: Number(summaryRow.retry_scheduled_count ?? 0),
        retryExhausted: Number(summaryRow.retry_exhausted_count ?? 0),
        authentication: Number(summaryRow.authentication_count ?? 0),
        network: Number(summaryRow.network_count ?? 0),
        provider: Number(summaryRow.provider_count ?? 0),
        rateLimited: Number(summaryRow.rate_limited_count ?? 0),
        timeout: Number(summaryRow.timeout_count ?? 0),
        validation: Number(summaryRow.validation_count ?? 0),
        unknown: Number(summaryRow.unknown_count ?? 0)
      },
      recentFailureReasons: normalizeRecentFailureReasons(summaryRow.recent_failure_reasons),
      recentTerminalWindowMs,
      recentCompleted: Number(summaryRow.recent_completed_count ?? 0),
      recentFailed: Number(summaryRow.recent_failed_count ?? 0),
      recentTotalTerminal: Number(summaryRow.recent_terminal_count ?? 0)
    };

    if (summaryRow.last_updated_at) {
      summary.lastUpdatedAt = new Date(summaryRow.last_updated_at).toISOString();
    }

    return summary;
  } catch (error: unknown) {
    //audit Assumption: queue summary failures should degrade observability, not crash request handling; failure risk: operator status endpoints return 500 on transient query issues; expected invariant: errors are logged and summary becomes unavailable; handling strategy: return `null`.
    console.error('Error fetching job queue summary:', resolveErrorMessage(error));
    return null;
  }
}

/**
 * Aggregate recent queue execution stats for autonomy budgets.
 * Purpose: let the worker decide whether to pause new claims when throughput or AI-call budgets are exhausted.
 * Inputs/outputs: accepts a lower-bound timestamp and optional worker id; returns normalized execution counters.
 * Edge case behavior: returns zeroed counters when the database is unavailable.
 */
export async function getJobExecutionStatsSince(
  since: Date | string,
  workerId?: string
): Promise<JobExecutionStats> {
  if (!isDatabaseConnected()) {
    return {
      completed: 0,
      failed: 0,
      running: 0,
      totalTerminal: 0,
      aiCalls: 0
    };
  }

  const result = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_count,
       COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
       COUNT(*) FILTER (WHERE status = 'running')::int AS running_count,
       COUNT(*) FILTER (WHERE status IN ('completed', 'failed', 'cancelled', 'expired'))::int AS total_terminal_count,
       COUNT(*) FILTER (
         WHERE status IN ('completed', 'failed', 'cancelled', 'expired')
           AND job_type IN ('ask', 'dag-node', 'gpt')
       )::int AS ai_call_count
     FROM job_data
     WHERE updated_at >= $1::timestamptz
       AND ($2::text IS NULL OR last_worker_id = $2 OR worker_id = $2)`,
    [normalizeNullableDate(since), workerId ?? null]
  );

  const row = result.rows[0] as {
    completed_count: number;
    failed_count: number;
    running_count: number;
    total_terminal_count: number;
    ai_call_count: number;
  } | undefined;

  return {
    completed: row?.completed_count ?? 0,
    failed: row?.failed_count ?? 0,
    running: row?.running_count ?? 0,
    totalTerminal: row?.total_terminal_count ?? 0,
    aiCalls: row?.ai_call_count ?? 0
  };
}

/**
 * Expire retained GPT jobs and compact expired rows after a grace period.
 * Purpose: keep the GPT job table bounded while preserving explicit lifecycle visibility for recent terminal rows.
 * Inputs/outputs: no inputs, returns the number of pending/terminal expirations plus deleted expired rows.
 * Edge case behavior: expired rows remain visible until the configurable compaction grace elapses.
 */
export async function cleanupExpiredGptJobs(): Promise<CleanupGptJobsResult> {
  assertDatabaseReady();

  const pendingMaxAgeMs = resolveGptPendingMaxAgeMs();
  const expiredCompactionMs = resolveGptExpiredCompactionMs();

  const expiredPendingResult = await query(
    `UPDATE job_data
     SET
       status = 'expired',
       error_message = COALESCE(error_message, 'GPT job expired before the worker claimed it.'),
       updated_at = NOW(),
       completed_at = COALESCE(completed_at, NOW()),
       expires_at = COALESCE(expires_at, NOW())
     WHERE job_type = 'gpt'
       AND status = 'pending'
       AND created_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
     RETURNING id`,
    [pendingMaxAgeMs]
  );

  const expiredTerminalResult = await query(
    `UPDATE job_data
     SET
       status = 'expired',
       updated_at = NOW(),
       expires_at = COALESCE(expires_at, NOW())
     WHERE job_type = 'gpt'
       AND status IN ('completed', 'failed', 'cancelled')
       AND retention_until IS NOT NULL
       AND retention_until <= NOW()
     RETURNING id`,
    []
  );

  const deletedExpiredResult = await query(
    `DELETE FROM job_data
     WHERE job_type = 'gpt'
       AND status = 'expired'
       AND expires_at IS NOT NULL
       AND expires_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
     RETURNING id`,
    [expiredCompactionMs]
  );

  return {
    expiredPending: expiredPendingResult.rowCount ?? expiredPendingResult.rows.length,
    expiredTerminal: expiredTerminalResult.rowCount ?? expiredTerminalResult.rows.length,
    deletedExpired: deletedExpiredResult.rowCount ?? deletedExpiredResult.rows.length
  };
}

function normalizeNullableDate(value: Date | string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return value;
}

function buildRecoveredAutonomyState(
  autonomyState: Record<string, unknown> | string | null,
  retryCount: number
): Record<string, unknown> {
  let baseState: Record<string, unknown> = {};

  if (typeof autonomyState === 'object' && autonomyState !== null && !Array.isArray(autonomyState)) {
    baseState = autonomyState;
  }

  return {
    ...baseState,
    recoveredFromStaleLeaseAt: new Date().toISOString(),
    staleRecoveryCount: Number(baseState.staleRecoveryCount ?? 0) + 1,
    previousRetryCount: retryCount
  };
}

function normalizeInspectionLimit(limit: number | undefined, fallback: number): number {
  const normalizedLimit = Number(limit ?? fallback);

  //audit Assumption: failed-job inspection should remain cheap enough for status routes; failure risk: unbounded operator queries pressure the primary queue table; expected invariant: inspection limits stay within a small capped range; handling strategy: clamp to 1-100 before issuing SQL.
  if (!Number.isFinite(normalizedLimit)) {
    return fallback;
  }

  return Math.min(100, Math.max(1, Math.trunc(normalizedLimit)));
}

/**
 * List recently failed queue jobs for operator inspection.
 * Purpose: expose retained terminal failures without requiring raw database access.
 * Inputs/outputs: accepts an optional limit and returns the most recently updated failed rows.
 * Edge case behavior: returns an empty list when the database is unavailable or the query fails.
 */
export async function listFailedJobs(limit = 10): Promise<FailedJobSnapshot[]> {
  if (!isDatabaseConnected()) {
    return [];
  }

  try {
    const normalizedLimit = normalizeInspectionLimit(limit, 10);
    const result = await query(
      `SELECT
         id,
         worker_id,
         last_worker_id,
         job_type,
         status,
         error_message,
         retry_count,
         max_retries,
         created_at,
         updated_at,
         completed_at
       FROM job_data
       WHERE status = 'failed'
       ORDER BY updated_at DESC, created_at DESC
       LIMIT $1`,
      [normalizedLimit]
    );

    return result.rows as FailedJobSnapshot[];
  } catch (error: unknown) {
    //audit Assumption: failed-job inspection should degrade observability rather than break helper and health endpoints; failure risk: one query failure cascades into probe failures; expected invariant: inspection errors are logged and return an empty list; handling strategy: fail closed.
    console.error('Error listing failed jobs:', resolveErrorMessage(error));
    return [];
  }
}
