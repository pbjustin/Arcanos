import type { GptJobResultLookupPayload } from '@shared/gpt/gptJobResult.js';

export const BACKSTAGE_BOOKER_MANAGED_ASYNC_RESULT_PATH_PREFIX =
  '/gpt-access/capabilities/v1/backstage-booker/jobs';

export const BACKSTAGE_BOOKER_MANAGED_ASYNC_RESULT_OPENAPI_PATH =
  `${BACKSTAGE_BOOKER_MANAGED_ASYNC_RESULT_PATH_PREFIX}/{jobId}/result`;

export function buildBackstageBookerManagedAsyncResultPath(jobId: string): string {
  return `${BACKSTAGE_BOOKER_MANAGED_ASYNC_RESULT_PATH_PREFIX}/${encodeURIComponent(jobId)}/result`;
}

interface PendingResponseRecord {
  jobId: string;
  jobReadToken?: unknown;
  jobReadTokenHeader?: unknown;
  stream?: unknown;
  instruction?: unknown;
  directReturn?: unknown;
}

/**
 * Project a generic queued response into the managed-bearer Builder contract.
 * Generic callers retain their job capability fields and stream link; the
 * dedicated Builder receives only the continuation operation it can invoke.
 */
export function projectBackstageBookerManagedPendingResponse(
  payload: PendingResponseRecord
): Record<string, unknown> {
  const {
    jobReadToken: _jobReadToken,
    jobReadTokenHeader: _jobReadTokenHeader,
    stream: _stream,
    ...projected
  } = payload;
  const poll = buildBackstageBookerManagedAsyncResultPath(payload.jobId);
  const directReturn = payload.directReturn;

  return {
    ...(projected as Record<string, unknown>),
    poll,
    ...(typeof payload.instruction === 'string'
      ? {
          instruction:
            `Call getBackstageBookerJobResult with jobId ${payload.jobId}; `
            + 'the configured Backstage Booker Bearer credential authenticates continuation.',
        }
      : {}),
    ...(directReturn && typeof directReturn === 'object' && !Array.isArray(directReturn)
      ? {
          directReturn: {
            ...(directReturn as Record<string, unknown>),
            poll,
            result: poll,
          },
        }
      : {}),
  };
}

export type BackstageBookerManagedJobResultPayload =
  Omit<GptJobResultLookupPayload, 'stream'>;

/** Keep every managed-bearer result state on the same authenticated poll lane. */
export function projectBackstageBookerManagedJobResultPayload(
  payload: GptJobResultLookupPayload
): BackstageBookerManagedJobResultPayload {
  const { stream: _stream, ...projected } = payload;
  return {
    ...projected,
    poll: buildBackstageBookerManagedAsyncResultPath(payload.jobId),
  };
}
