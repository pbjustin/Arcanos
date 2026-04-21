import { z } from 'zod';
import type { JobData } from '@core/db/schema.js';
import { resolveGptJobLifecycleStatus } from './gptJobLifecycle.js';
import type { GptBridgeSmokeAction } from './bridgeSmoke.js';

export const GPT_QUERY_ACTION = 'query';
export const GPT_GET_STATUS_ACTION = 'get_status';
export const GPT_GET_RESULT_ACTION = 'get_result';
export const GPT_QUERY_AND_WAIT_ACTION = 'query_and_wait';

export type GptAsyncWriteAction =
  | typeof GPT_QUERY_ACTION
  | typeof GPT_QUERY_AND_WAIT_ACTION
  | GptBridgeSmokeAction;

const normalizeActionValue = (value: unknown) => typeof value === 'string'
  ? value.trim().toLowerCase()
  : value;

const gptJobLookupPayloadSchema = z.object({
  jobId: z.string().trim().min(1)
}).passthrough();

function buildGptJobLookupRequestSchema(expectedAction: string) {
  return z.object({
    action: z.preprocess(
      normalizeActionValue,
      z.literal(expectedAction)
    ),
    payload: gptJobLookupPayloadSchema
  }).passthrough();
}

const gptJobResultRequestSchema = buildGptJobLookupRequestSchema(GPT_GET_RESULT_ACTION);
const gptJobStatusRequestSchema = buildGptJobLookupRequestSchema(GPT_GET_STATUS_ACTION);

export interface GptJobResultLookupPayload {
  jobId: string;
  status: 'pending' | 'completed' | 'failed' | 'expired' | 'not_found';
  jobStatus: string | null;
  lifecycleStatus: string;
  createdAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  retentionUntil: string | null;
  idempotencyUntil: string | null;
  expiresAt: string | null;
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

export type ParsedGptJobStatusRequest = ParsedGptJobResultRequest;

export interface GptJobStatusBridgePayload {
  action: typeof GPT_GET_STATUS_ACTION;
  jobId: string;
  status: string;
  lifecycleStatus: string;
  result: ReturnType<typeof buildStoredJobStatusPayload>;
}

export interface GptJobResultBridgePayload {
  action: typeof GPT_GET_RESULT_ACTION;
  jobId: string;
  status: GptJobResultLookupPayload['status'];
  jobStatus: string | null;
  lifecycleStatus: string;
  createdAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  retentionUntil: string | null;
  idempotencyUntil: string | null;
  expiresAt: string | null;
  poll: string;
  stream: string;
  output: unknown | null;
  error: GptJobResultLookupPayload['error'];
  result: GptJobResultLookupPayload;
}

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
    retentionUntil: serializeJobTimestamp(job.retention_until),
    idempotencyUntil: serializeJobTimestamp(job.idempotency_until),
    expiresAt: serializeJobTimestamp(job.expires_at),
    poll: `/jobs/${job.id}`,
    stream: `/jobs/${job.id}/stream`,
    result: null,
    error: null
  };
}

function buildCompletedJobLookupPayload(job: JobData): GptJobResultLookupPayload {
  return {
    jobId: job.id,
    status: 'completed',
    jobStatus: job.status,
    lifecycleStatus: resolveGptJobLifecycleStatus(job.status),
    createdAt: serializeJobTimestamp(job.created_at),
    updatedAt: serializeJobTimestamp(job.updated_at),
    completedAt: serializeJobTimestamp(job.completed_at),
    retentionUntil: serializeJobTimestamp(job.retention_until),
    idempotencyUntil: serializeJobTimestamp(job.idempotency_until),
    expiresAt: serializeJobTimestamp(job.expires_at),
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
    retentionUntil: serializeJobTimestamp(job.retention_until),
    idempotencyUntil: serializeJobTimestamp(job.idempotency_until),
    expiresAt: serializeJobTimestamp(job.expires_at),
    poll: `/jobs/${job.id}`,
    stream: `/jobs/${job.id}/stream`,
    result: job.output ?? null,
    error: buildJobFailurePayload(
      code,
      job.error_message ?? defaultMessage,
      {
        lifecycleStatus: resolveGptJobLifecycleStatus(job.status),
        jobStatus: job.status,
        resultRetained: job.output != null
      }
    )
  };
}

function buildExpiredJobLookupPayload(job: JobData): GptJobResultLookupPayload {
  return {
    jobId: job.id,
    status: 'expired',
    jobStatus: job.status,
    lifecycleStatus: resolveGptJobLifecycleStatus(job.status),
    createdAt: serializeJobTimestamp(job.created_at),
    updatedAt: serializeJobTimestamp(job.updated_at),
    completedAt: serializeJobTimestamp(job.completed_at),
    retentionUntil: serializeJobTimestamp(job.retention_until),
    idempotencyUntil: serializeJobTimestamp(job.idempotency_until),
    expiresAt: serializeJobTimestamp(job.expires_at),
    poll: `/jobs/${job.id}`,
    stream: `/jobs/${job.id}/stream`,
    result: job.output ?? null,
    error: buildJobFailurePayload(
      'JOB_EXPIRED',
      job.error_message ?? 'Async GPT job expired after its retention window.',
      {
        lifecycleStatus: resolveGptJobLifecycleStatus(job.status),
        jobStatus: job.status,
        resultRetained: job.output != null
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

export function parseGptJobStatusRequest(body: unknown): ParsedGptJobStatusRequest {
  const parsedRequest = gptJobStatusRequestSchema.safeParse(body);

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

export function buildGptJobStatusBridgePayload(job: JobData): GptJobStatusBridgePayload {
  const statusPayload = buildStoredJobStatusPayload(job);
  return {
    action: GPT_GET_STATUS_ACTION,
    jobId: job.id,
    status: statusPayload.status,
    lifecycleStatus: statusPayload.lifecycle_status,
    result: statusPayload
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
      retentionUntil: null,
      idempotencyUntil: null,
      expiresAt: null,
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
    return buildExpiredJobLookupPayload(job);
  }

  return buildPendingJobLookupPayload(job);
}

export function buildGptJobResultBridgePayload(
  jobId: string,
  job: JobData | null
): GptJobResultBridgePayload {
  const lookup = buildGptJobResultLookupPayload(jobId, job);
  return {
    action: GPT_GET_RESULT_ACTION,
    jobId: lookup.jobId,
    status: lookup.status,
    jobStatus: lookup.jobStatus,
    lifecycleStatus: lookup.lifecycleStatus,
    createdAt: lookup.createdAt,
    updatedAt: lookup.updatedAt,
    completedAt: lookup.completedAt,
    retentionUntil: lookup.retentionUntil,
    idempotencyUntil: lookup.idempotencyUntil,
    expiresAt: lookup.expiresAt,
    poll: lookup.poll,
    stream: lookup.stream,
    output: lookup.result,
    error: lookup.error,
    result: lookup
  };
}
