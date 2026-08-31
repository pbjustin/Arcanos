import type { GptJobResultLookupPayload } from '@shared/gpt/gptJobResult.js';
import {
  resolveBackstageProtectedFailureCode,
  type BackstageProtectedFailureCode,
} from './backstageProtectedFailure.js';

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
  idempotencyKey?: unknown;
  idempotencySource?: unknown;
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
    idempotencyKey: _idempotencyKey,
    idempotencySource: _idempotencySource,
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
  Omit<GptJobResultLookupPayload, 'stream'> & {
    protected?: true;
    protectedGenerationCompleted?: boolean;
    official?: boolean;
    continuityVerified?: boolean;
    authority?: 'notion' | 'legacy_postgresql' | 'none';
    snapshotStatus?: 'current_complete' | 'not_applicable';
    fallbackUsed?: boolean;
    fallbackPermitted?: false;
  };

/** Build the public no-authority state shared by protected POST and GET errors. */
export function buildBackstageBookerProtectedFailureState(input: {
  code: string;
  message: string;
}): Record<string, unknown> {
  return {
    result: null,
    error: { code: input.code, message: input.message },
    protected: true,
    protectedGenerationCompleted: false,
    official: false,
    continuityVerified: false,
    authority: 'none',
    snapshotStatus: 'not_applicable',
    fallbackUsed: false,
    fallbackPermitted: false,
  };
}

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

/**
 * Dedicated bearer reads deliberately hide every protected terminal failure
 * payload, including the sealed envelope. Generic GPT job reads stay unchanged.
 */
export function projectBackstageBookerManagedProtectedFailurePayload(
  payload: GptJobResultLookupPayload,
  candidateCode: unknown
): BackstageBookerManagedJobResultPayload {
  const code: BackstageProtectedFailureCode =
    resolveBackstageProtectedFailureCode(candidateCode);
  const { stream: _stream, ...projected } = payload;
  return {
    ...projected,
    poll: buildBackstageBookerManagedAsyncResultPath(payload.jobId),
    ...buildBackstageBookerProtectedFailureState({
      code,
      message: 'Protected Backstage generation did not complete.',
    }),
  };
}
