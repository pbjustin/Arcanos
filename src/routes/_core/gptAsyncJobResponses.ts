import type { QueuedGptPendingResponse } from '@shared/gpt/asyncGptJob.js';
import { resolveGptJobLifecycleStatus } from '@shared/gpt/gptJobLifecycle.js';
import {
  GPT_QUERY_ACTION,
  GPT_QUERY_AND_WAIT_ACTION,
} from '@shared/gpt/gptJobResult.js';
import { mapGptJobStatusToClientStatus } from '@shared/gpt/priorityGpt.js';

export interface CompletedAsyncGptResponse {
  ok: true;
  result: unknown;
  _route: {
    requestId?: string;
    gptId: string;
    module?: string;
    action?: string;
    matchMethod?: string;
    route?: string;
    availableActions?: string[];
    moduleVersion?: string | null;
    timestamp: string;
  };
}

/**
 * Convert a pending async-job response into the existing direct-wait timeout shape.
 */
export function buildDirectReturnTimeoutResponse(params: {
  pendingResponse: QueuedGptPendingResponse;
  jobId: string;
  waitForResultMs: number;
  pollIntervalMs: number;
}) {
  return {
    ...params.pendingResponse,
    status: 'timeout' as const,
    result: {},
    poll: `/jobs/${params.jobId}/result`,
    timedOut: true,
    instruction: `Direct wait timed out after ${params.waitForResultMs}ms. Use GET /jobs/${params.jobId}/result to retrieve the final result.`,
    directReturn: {
      requested: true,
      timedOut: true,
      waitForResultMs: params.waitForResultMs,
      pollIntervalMs: params.pollIntervalMs,
      poll: `/jobs/${params.jobId}/result`,
      result: `/jobs/${params.jobId}/result`,
    },
  };
}

/**
 * Recognize the minimal completed envelope accepted from durable GPT job output.
 */
export function normalizeCompletedAsyncGptResponse(
  output: unknown
): CompletedAsyncGptResponse | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return null;
  }

  const candidate = output as Record<string, unknown>;
  if (candidate.ok !== true) {
    return null;
  }

  if (!candidate._route || typeof candidate._route !== 'object' || Array.isArray(candidate._route)) {
    return null;
  }

  return candidate as unknown as CompletedAsyncGptResponse;
}

/**
 * Build the stable job metadata shared by queued, completed, and terminal responses.
 */
export function buildAsyncJobResponseMetadata(input: {
  action: typeof GPT_QUERY_ACTION | typeof GPT_QUERY_AND_WAIT_ACTION;
  jobId: string;
  jobStatus: string;
  deduped: boolean;
  idempotencyKey: string;
  idempotencySource: 'explicit' | 'derived';
}) {
  return {
    action: input.action,
    jobId: input.jobId,
    status: mapGptJobStatusToClientStatus(input.jobStatus),
    jobStatus: input.jobStatus,
    lifecycleStatus: resolveGptJobLifecycleStatus(input.jobStatus),
    poll: `/jobs/${input.jobId}/result`,
    stream: `/jobs/${input.jobId}/stream`,
    timedOut: false,
    ...(input.deduped ? { deduped: true } : {}),
    idempotencyKey: input.idempotencyKey,
    idempotencySource: input.idempotencySource,
  };
}
