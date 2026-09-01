import type { GptJobResultLookupPayload } from '@shared/gpt/gptJobResult.js';
import type {
  BackstageJobPayloadProtectionErrorCode,
} from './backstageJobPayloadProtection.js';
import {
  readProtectedBackstageCompletionProvenance,
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

export interface BackstageBookerProtectedPayloadRejection {
  code: 'BACKSTAGE_ASYNC_PAYLOAD_TOO_LARGE' | 'BAD_REQUEST' | 'BACKSTAGE_ASYNC_UNAVAILABLE';
  message: string;
  statusCode: 400 | 413 | 503;
}

/** Map private payload-protection failures onto the fixed public POST contract. */
export function resolveBackstageBookerProtectedPayloadRejection(
  errorCode: BackstageJobPayloadProtectionErrorCode
): BackstageBookerProtectedPayloadRejection {
  if (errorCode === 'BACKSTAGE_JOB_PAYLOAD_TOO_LARGE') {
    return {
      code: 'BACKSTAGE_ASYNC_PAYLOAD_TOO_LARGE',
      message: 'Protected Backstage generation request exceeds the queue payload size limit.',
      statusCode: 413,
    };
  }
  if (
    errorCode === 'BACKSTAGE_JOB_PAYLOAD_IDENTITY_INVALID'
    || errorCode === 'BACKSTAGE_JOB_PAYLOAD_SERIALIZATION_FAILED'
  ) {
    return {
      code: 'BAD_REQUEST',
      message: 'Protected Backstage generation request identity is invalid.',
      statusCode: 400,
    };
  }
  return {
    code: 'BACKSTAGE_ASYNC_UNAVAILABLE',
    message: 'Protected Backstage generation is temporarily unavailable.',
    statusCode: 503,
  };
}

/** Replace an oversized official result with a bounded no-authority envelope. */
export function buildBackstageBookerProtectedOverflowFailure(
  payload: Record<string, unknown>
): Record<string, unknown> | undefined {
  const route = payload._route;
  if (!route || typeof route !== 'object' || Array.isArray(route)) {
    return undefined;
  }
  const routeRecord = route as Record<string, unknown>;
  const action = routeRecord.action;
  if (
    routeRecord.gptId !== 'backstage-booker'
    || (action !== 'generateBooking' && action !== 'generateBookingWithHRC')
    || !readProtectedBackstageCompletionProvenance(payload, {
      gptId: 'backstage-booker',
      action,
    })
  ) {
    return undefined;
  }

  const jobId = typeof payload.jobId === 'string' ? payload.jobId : null;
  const poll = typeof payload.poll === 'string' ? payload.poll : null;
  return {
    ok: false,
    ...(jobId ? { jobId } : {}),
    status: 'failed',
    ...(poll ? { poll } : {}),
    ...buildBackstageBookerProtectedFailureState({
      code: 'BACKSTAGE_ASYNC_RESULT_UNAVAILABLE',
      message: 'Protected Backstage generation result exceeded the public response limit, so no official result was delivered.',
    }),
    ...(typeof payload.requestId === 'string'
      ? { requestId: payload.requestId }
      : {}),
    ...(typeof payload.traceId === 'string'
      ? { traceId: payload.traceId }
      : {}),
    _route: {
      ...(typeof routeRecord.requestId === 'string'
        ? { requestId: routeRecord.requestId }
        : {}),
      ...(typeof routeRecord.traceId === 'string'
        ? { traceId: routeRecord.traceId }
        : {}),
      gptId: 'backstage-booker',
      action,
      ...(typeof routeRecord.timestamp === 'string'
        ? { timestamp: routeRecord.timestamp }
        : {}),
    },
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
