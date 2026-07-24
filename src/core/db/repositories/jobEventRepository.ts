import type { PoolClient } from 'pg';

import { isDatabaseConnected } from '@core/db/client.js';
import { query } from '@core/db/query.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { safeJSONStringify } from '@shared/jsonHelpers.js';
import { redactSensitive } from '@shared/redaction.js';
import { dbLogger } from '@platform/logging/structuredLogging.js';
import { recordJobEventInsertFailure } from '@platform/observability/appMetrics.js';

export const JOB_EVENT_TYPES = [
  'job.created',
  'job.queued',
  'job.claimed',
  'job.started',
  'ai.request.started',
  'ai.request.completed',
  'ai.request.failed',
  'job.retry.scheduled',
  'job.completed',
  'job.failed',
  'job.expired',
  'worker.heartbeat',
  'worker.stale_detected',
  'worker.recovered'
] as const;

export type JobEventType = typeof JOB_EVENT_TYPES[number];

export const DEFAULT_JOB_EVENT_RETENTION_DAYS = 30;
export const MAX_JOB_EVENT_RETENTION_DAYS = 365;
export const DEFAULT_JOB_EVENT_CLEANUP_BATCH_SIZE = 1_000;
export const MAX_JOB_EVENT_CLEANUP_BATCH_SIZE = 10_000;
export const DEFAULT_JOB_EVENT_TIMELINE_LIMIT = 100;
export const MAX_JOB_EVENT_TIMELINE_LIMIT = 1_000;
const JOB_EVENT_INSERT_RETRY_COUNT = 1;

export interface RecordJobEventInput {
  jobId: string;
  eventType: JobEventType;
  traceId?: string | null;
  workerId?: string | null;
  durationMs?: number | null;
  metadata?: Record<string, unknown>;
}

export class JobEventPersistenceError extends Error {
  constructor(
    public readonly code: 'JOB_EVENT_SERIALIZATION_FAILED' | 'JOB_EVENT_INSERT_FAILED',
    message: string
  ) {
    super(message);
    this.name = 'JobEventPersistenceError';
  }
}

export type RecordJobEventResult =
  | { inserted: true }
  | { inserted: false; reason: 'database_unavailable' | 'serialization_failed' | 'insert_failed' };

export interface CleanupJobEventsOptions {
  retentionDays?: number;
  batchSize?: number;
  dryRun?: boolean;
}

export interface CleanupJobEventsResult {
  databaseAvailable: boolean;
  failed: boolean;
  dryRun: boolean;
  retentionDays: number;
  batchSize: number;
  cutoffBefore: string;
  matchedRows: number;
  deletedRows: number;
  eventIds: string[];
}

export interface ListJobEventTimelineInput {
  jobId?: string | null;
  traceId?: string | null;
  workerId?: string | null;
  eventType?: string | null;
  occurredAfter?: string | Date | null;
  occurredBefore?: string | Date | null;
  limit?: number | null;
}

export interface JobEventTimelineRow {
  id: string;
  jobId: string;
  traceId: string | null;
  eventType: string;
  workerId: string | null;
  occurredAt: string;
  durationMs: number | null;
  metadata: Record<string, unknown>;
}

export type ListJobEventTimelineResult =
  | { available: true; events: JobEventTimelineRow[] }
  | { available: false; reason: 'database_unavailable' | 'table_unavailable' | 'query_failed'; events: [] };

function normalizeNullableString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeDurationMs(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return Math.max(0, Math.trunc(value));
}

function normalizePositiveInteger(
  value: number | null | undefined,
  fallback: number,
  options: { min: number; max: number }
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(options.max, Math.max(options.min, Math.trunc(value)));
}

function normalizeDateInput(value: string | Date | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizeJsonbInput(value: Record<string, unknown> | undefined): string | null {
  const redactedValue = redactSensitive(value ?? {}) as Record<string, unknown>;
  return safeJSONStringify(redactedValue, 'jobEventRepository.recordJobEvent.metadata', {
    logger: {
      warn: (message, metadata) => {
        dbLogger.warn(
          message,
          { module: 'job-events', operation: 'recordJobEvent' },
          redactSensitive(metadata) as Record<string, unknown>
        );
      }
    }
  });
}

function buildJobEventInsert(input: RecordJobEventInput): {
  sql: string;
  params: unknown[];
} {
  const serializedMetadata = normalizeJsonbInput(input.metadata);
  if (!serializedMetadata) {
    throw new JobEventPersistenceError(
      'JOB_EVENT_SERIALIZATION_FAILED',
      'Job event metadata could not be serialized.'
    );
  }

  return {
    sql: `INSERT INTO job_events (
       job_id,
       trace_id,
       event_type,
       worker_id,
       duration_ms,
       metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    params: [
      input.jobId,
      normalizeNullableString(input.traceId),
      input.eventType,
      normalizeNullableString(input.workerId),
      normalizeDurationMs(input.durationMs),
      serializedMetadata
    ]
  };
}

/**
 * Persist a job event through an existing transaction.
 *
 * Unlike the best-effort public recorder, this helper throws so a caller can
 * keep a canonical job transition and its lifecycle evidence atomic.
 */
export async function recordJobEventWithClient(
  client: PoolClient,
  input: RecordJobEventInput
): Promise<void> {
  const insert = buildJobEventInsert(input);
  try {
    await client.query(insert.sql, insert.params);
  } catch (error) {
    if (error instanceof JobEventPersistenceError) {
      throw error;
    }
    throw new JobEventPersistenceError(
      'JOB_EVENT_INSERT_FAILED',
      'Job event could not be persisted in the current transaction.'
    );
  }
}

export async function recordJobEvent(input: RecordJobEventInput): Promise<RecordJobEventResult> {
  if (!isDatabaseConnected()) {
    recordJobEventInsertFailure('database_unavailable');
    dbLogger.warn('job_events.insert_skipped', {
      module: 'job-events',
      jobId: input.jobId,
      eventType: input.eventType,
      workerId: normalizeNullableString(input.workerId),
      traceId: normalizeNullableString(input.traceId),
      reason: 'database_unavailable'
    });
    return { inserted: false, reason: 'database_unavailable' };
  }

  try {
    const insert = buildJobEventInsert(input);

    await query(
      insert.sql,
      insert.params,
      JOB_EVENT_INSERT_RETRY_COUNT,
      false,
      {
        queryName: 'record_job_event',
        source: 'job-events',
        workerId: normalizeNullableString(input.workerId) ?? undefined
      }
    );
    return { inserted: true };
  } catch (error: unknown) {
    const reason = error instanceof JobEventPersistenceError
      && error.code === 'JOB_EVENT_SERIALIZATION_FAILED'
      ? 'serialization_failed'
      : 'insert_failed';
    recordJobEventInsertFailure(reason);
    const errorMetadata = redactSensitive({
      errorMessage: resolveErrorMessage(error)
    }) as Record<string, unknown>;
    dbLogger.warn(
      'job_events.insert_failed',
      {
        module: 'job-events',
        jobId: input.jobId,
        eventType: input.eventType,
        workerId: normalizeNullableString(input.workerId),
        traceId: normalizeNullableString(input.traceId),
        reason
      },
      errorMetadata
    );
    return { inserted: false, reason };
  }
}

export async function cleanupJobEvents(
  options: CleanupJobEventsOptions = {}
): Promise<CleanupJobEventsResult> {
  const retentionDays = normalizePositiveInteger(
    options.retentionDays,
    DEFAULT_JOB_EVENT_RETENTION_DAYS,
    { min: 1, max: MAX_JOB_EVENT_RETENTION_DAYS }
  );
  const batchSize = normalizePositiveInteger(
    options.batchSize,
    DEFAULT_JOB_EVENT_CLEANUP_BATCH_SIZE,
    { min: 1, max: MAX_JOB_EVENT_CLEANUP_BATCH_SIZE }
  );
  const dryRun = options.dryRun !== false;
  const cutoffBefore = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1_000).toISOString();

  if (!isDatabaseConnected()) {
    return {
      databaseAvailable: false,
      failed: false,
      dryRun,
      retentionDays,
      batchSize,
      cutoffBefore,
      matchedRows: 0,
      deletedRows: 0,
      eventIds: []
    };
  }

  const cleanupSql = dryRun
    ? `WITH candidates AS (
         SELECT id
         FROM job_events
         WHERE occurred_at < NOW() - ($1::int * INTERVAL '1 day')
         ORDER BY occurred_at ASC, id ASC
         LIMIT $2
       )
       SELECT id
       FROM candidates
       ORDER BY id ASC`
    : `WITH candidates AS (
         SELECT id
         FROM job_events
         WHERE occurred_at < NOW() - ($1::int * INTERVAL '1 day')
         ORDER BY occurred_at ASC, id ASC
         LIMIT $2
       ),
       deleted AS (
         DELETE FROM job_events
         WHERE id IN (SELECT id FROM candidates)
         RETURNING id
       )
       SELECT id
       FROM deleted
       ORDER BY id ASC`;

  try {
    const result = await query(
      cleanupSql,
      [retentionDays, batchSize],
      3,
      false,
      {
        queryName: dryRun ? 'cleanup_job_events_dry_run' : 'cleanup_job_events',
        source: 'job-events'
      }
    );
    const eventIds = (result.rows as Array<{ id: string }>).map((row) => row.id);
    return {
      databaseAvailable: true,
      failed: false,
      dryRun,
      retentionDays,
      batchSize,
      cutoffBefore,
      matchedRows: eventIds.length,
      deletedRows: dryRun ? 0 : eventIds.length,
      eventIds
    };
  } catch (error: unknown) {
    dbLogger.warn(
      'job_events.cleanup_failed',
      {
        module: 'job-events',
        dryRun,
        retentionDays,
        batchSize
      },
      redactSensitive({
        errorMessage: resolveErrorMessage(error)
      }) as Record<string, unknown>
    );
    return {
      databaseAvailable: true,
      failed: true,
      dryRun,
      retentionDays,
      batchSize,
      cutoffBefore,
      matchedRows: 0,
      deletedRows: 0,
      eventIds: []
    };
  }
}

export async function listJobEventTimeline(
  input: ListJobEventTimelineInput = {}
): Promise<ListJobEventTimelineResult> {
  if (!isDatabaseConnected()) {
    return { available: false, reason: 'database_unavailable', events: [] };
  }

  const conditions: string[] = [];
  const params: unknown[] = [];
  const addCondition = (sql: string, value: unknown): void => {
    params.push(value);
    conditions.push(sql.replace('?', `$${params.length}`));
  };

  const jobId = normalizeNullableString(input.jobId ?? null);
  if (jobId) {
    addCondition('job_id = ?', jobId);
  }
  const traceId = normalizeNullableString(input.traceId ?? null);
  if (traceId) {
    addCondition('trace_id = ?', traceId);
  }
  const workerId = normalizeNullableString(input.workerId ?? null);
  if (workerId) {
    addCondition('worker_id = ?', workerId);
  }
  const eventType = normalizeNullableString(input.eventType ?? null);
  if (eventType) {
    addCondition('event_type = ?', eventType);
  }
  const occurredAfter = normalizeDateInput(input.occurredAfter);
  if (occurredAfter) {
    addCondition('occurred_at >= ?::timestamptz', occurredAfter);
  }
  const occurredBefore = normalizeDateInput(input.occurredBefore);
  if (occurredBefore) {
    addCondition('occurred_at <= ?::timestamptz', occurredBefore);
  }

  const limit = normalizePositiveInteger(
    input.limit,
    DEFAULT_JOB_EVENT_TIMELINE_LIMIT,
    { min: 1, max: MAX_JOB_EVENT_TIMELINE_LIMIT }
  );
  params.push(limit);

  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await query(
      `SELECT id, job_id, trace_id, event_type, worker_id, occurred_at, duration_ms, metadata
       FROM job_events
       ${whereSql}
       ORDER BY occurred_at ASC, id ASC
       LIMIT $${params.length}`,
      params,
      3,
      false,
      {
        queryName: 'list_job_event_timeline',
        source: 'job-events'
      }
    );
    return {
      available: true,
      events: (result.rows as Array<{
        id: string;
        job_id: string;
        trace_id: string | null;
        event_type: string;
        worker_id: string | null;
        occurred_at: Date | string;
        duration_ms: number | null;
        metadata: Record<string, unknown> | null;
      }>).map((row) => ({
        id: row.id,
        jobId: row.job_id,
        traceId: row.trace_id,
        eventType: row.event_type,
        workerId: row.worker_id,
        occurredAt: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : String(row.occurred_at),
        durationMs: row.duration_ms,
        metadata: redactSensitive(row.metadata ?? {}) as Record<string, unknown>
      }))
    };
  } catch (error: unknown) {
    const code = (error as { code?: unknown }).code;
    const reason = code === '42P01' ? 'table_unavailable' : 'query_failed';
    dbLogger.warn(
      'job_events.timeline_query_failed',
      { module: 'job-events', reason },
      redactSensitive({ errorMessage: resolveErrorMessage(error) }) as Record<string, unknown>
    );
    return { available: false, reason, events: [] };
  }
}
