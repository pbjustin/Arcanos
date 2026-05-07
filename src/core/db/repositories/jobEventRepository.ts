import { isDatabaseConnected } from '@core/db/client.js';
import { query } from '@core/db/query.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { safeJSONStringify } from '@shared/jsonHelpers.js';
import { redactSensitive } from '@shared/redaction.js';
import { dbLogger } from '@platform/logging/structuredLogging.js';

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
  'worker.heartbeat',
  'worker.stale_detected',
  'worker.recovered'
] as const;

export type JobEventType = typeof JOB_EVENT_TYPES[number];

export interface RecordJobEventInput {
  jobId: string;
  eventType: JobEventType;
  traceId?: string | null;
  workerId?: string | null;
  durationMs?: number | null;
  metadata?: Record<string, unknown>;
}

export type RecordJobEventResult =
  | { inserted: true }
  | { inserted: false; reason: 'database_unavailable' | 'serialization_failed' | 'insert_failed' };

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

export async function recordJobEvent(input: RecordJobEventInput): Promise<RecordJobEventResult> {
  if (!isDatabaseConnected()) {
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
    const serializedMetadata = normalizeJsonbInput(input.metadata);
    if (!serializedMetadata) {
      dbLogger.warn('job_events.insert_skipped', {
        module: 'job-events',
        jobId: input.jobId,
        eventType: input.eventType,
        workerId: normalizeNullableString(input.workerId),
        traceId: normalizeNullableString(input.traceId),
        reason: 'serialization_failed'
      });
      return { inserted: false, reason: 'serialization_failed' };
    }

    await query(
      `INSERT INTO job_events (
         job_id,
         trace_id,
         event_type,
         worker_id,
         duration_ms,
         metadata
       )
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        input.jobId,
        normalizeNullableString(input.traceId),
        input.eventType,
        normalizeNullableString(input.workerId),
        normalizeDurationMs(input.durationMs),
        serializedMetadata
      ],
      1,
      false,
      {
        queryName: 'record_job_event',
        source: 'job-events',
        workerId: normalizeNullableString(input.workerId) ?? undefined
      }
    );
    return { inserted: true };
  } catch (error: unknown) {
    dbLogger.warn(
      'job_events.insert_failed',
      {
        module: 'job-events',
        jobId: input.jobId,
        eventType: input.eventType,
        workerId: normalizeNullableString(input.workerId),
        traceId: normalizeNullableString(input.traceId)
      },
      { errorMessage: resolveErrorMessage(error) },
      error instanceof Error ? error : undefined
    );
    return { inserted: false, reason: 'insert_failed' };
  }
}
