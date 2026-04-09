import { z } from 'zod';
import type { JobData } from '@core/db/schema.js';
import { resolveGptJobLifecycleStatus } from './gptJobLifecycle.js';

export const GPT_GET_RESULT_ACTION = 'get_result';

const gptJobResultRequestSchema = z.object({
  action: z.preprocess(
    (value) => typeof value === 'string'
      ? value.trim().toLowerCase()
      : value,
    z.literal(GPT_GET_RESULT_ACTION)
  ),
  payload: z.object({
    jobId: z.string().trim().min(1)
  }).passthrough()
}).passthrough();

export interface GptJobResultLookupPayload {
  jobId: string;
  status: 'pending' | 'complete' | 'failed' | 'not_found';
  jobStatus: string | null;
  lifecycleStatus: string;
  createdAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  poll: string;
  stream: string;
  result: unknown | null;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  } | null;
}

export type ParsedGptJobResultRequest =
  | { ok: true; jobId: string }
  | { ok: false; error: string };

function serializeJobTimestamp(value: string | Date | null | undefined): string | null {
  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return null;
}

function buildJobFailurePayload(
  code: string,
  message: string,
  details?: Record<string, unknown>
): GptJobResultLookupPayload['error'] {
  return {
    code,
    message,
    ...(details ? { details } : {})
  };
}

function buildPendingJobLookupPayload(job: JobData): GptJobResultLookupPayload {
  return {
    jobId: job.id,
    status: 'pending',
    jobStatus: job.status,
    lifecycleStatus: resolveGptJobLifecycleStatus(job.status),
    createdAt: serializeJobTimestamp(job.created_at),
    updatedAt: serializeJobTimestamp(job.updated_at),
    completedAt: serializeJobTimestamp(job.completed_at),
    poll: `/jobs/${job.id}`,
    stream: `/jobs/${job.id}/stream`,
    result: null,
    error: null
  };
}

function buildCompletedJobLookupPayload(job: JobData): GptJobResultLookupPayload {
  return {
    jobId: job.id,
    status: 'complete',
    jobStatus: job.status,
    lifecycleStatus: resolveGptJobLifecycleStatus(job.status),
    createdAt: serializeJobTimestamp(job.created_at),
    updatedAt: serializeJobTimestamp(job.updated_at),
    completedAt: serializeJobTimestamp(job.completed_at),
    poll: `/jobs/${job.id}`,
    stream: `/jobs/${job.id}/stream`,
    result: job.output ?? null,
    error: null
  };
}

function buildFailedJobLookupPayload(
  job: JobData,
  code: string,
  defaultMessage: string
): GptJobResultLookupPayload {
  return {
    jobId: job.id,
    status: 'failed',
    jobStatus: job.status,
    lifecycleStatus: resolveGptJobLifecycleStatus(job.status),
    createdAt: serializeJobTimestamp(job.created_at),
    updatedAt: serializeJobTimestamp(job.updated_at),
    completedAt: serializeJobTimestamp(job.completed_at),
    poll: `/jobs/${job.id}`,
    stream: `/jobs/${job.id}/stream`,
    result: null,
    error: buildJobFailurePayload(
      code,
      job.error_message ?? defaultMessage,
      {
        lifecycleStatus: resolveGptJobLifecycleStatus(job.status),
        jobStatus: job.status
      }
    )
  };
}

export function parseGptJobResultRequest(body: unknown): ParsedGptJobResultRequest {
  const parsedRequest = gptJobResultRequestSchema.safeParse(body);

  if (!parsedRequest.success) {
    return {
      ok: false,
      error: parsedRequest.error.issues
        .map(issue => `${issue.path.join('.') || 'body'}: ${issue.message}`)
        .join('; ')
    };
  }

  return {
    ok: true,
    jobId: parsedRequest.data.payload.jobId
  };
}

export function buildStoredJobStatusPayload(job: JobData) {
  return {
    id: job.id,
    job_type: job.job_type,
    status: job.status,
    lifecycle_status: resolveGptJobLifecycleStatus(job.status),
    created_at: serializeJobTimestamp(job.created_at),
    updated_at: serializeJobTimestamp(job.updated_at),
    completed_at: serializeJobTimestamp(job.completed_at),
    cancel_requested_at: serializeJobTimestamp(job.cancel_requested_at),
    cancel_reason: job.cancel_reason ?? null,
    retention_until: serializeJobTimestamp(job.retention_until),
    idempotency_until: serializeJobTimestamp(job.idempotency_until),
    expires_at: serializeJobTimestamp(job.expires_at),
    error_message: job.error_message ?? null,
    output: job.output ?? null,
    result: job.output ?? null
  };
}

export function buildGptJobResultLookupPayload(
  jobId: string,
  job: JobData | null
): GptJobResultLookupPayload {
  if (!job) {
    return {
      jobId,
      status: 'not_found',
      jobStatus: null,
      lifecycleStatus: 'not_found',
      createdAt: null,
      updatedAt: null,
      completedAt: null,
      poll: `/jobs/${jobId}`,
      stream: `/jobs/${jobId}/stream`,
      result: null,
      error: buildJobFailurePayload('JOB_NOT_FOUND', 'Async GPT job was not found.')
    };
  }

  if (job.status === 'completed') {
    return buildCompletedJobLookupPayload(job);
  }

  if (job.status === 'failed') {
    return buildFailedJobLookupPayload(job, 'JOB_FAILED', 'Async GPT job failed.');
  }

  if (job.status === 'cancelled') {
    return buildFailedJobLookupPayload(job, 'JOB_CANCELLED', 'Async GPT job was cancelled.');
  }

  if (job.status === 'expired') {
    return buildFailedJobLookupPayload(
      job,
      'JOB_EXPIRED',
      'Async GPT job expired after its retention window.'
    );
  }

  return buildPendingJobLookupPayload(job);
}
