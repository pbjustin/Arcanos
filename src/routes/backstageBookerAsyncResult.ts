import express, { type Request, type RequestHandler, type Response } from 'express';

import {
  getJobById,
  JobRepositoryUnavailableError,
} from '@core/db/repositories/jobRepository.js';
import type { JobData } from '@core/db/schema.js';
import { recordGptJobLookup } from '@platform/observability/appMetrics.js';
import { getRequestAuthenticatedActorKey } from '@platform/runtime/security.js';
import {
  isProtectedBackstageQueuedGptJobEnvelope,
  markProtectedBackstageQueuedGptJobResultMaterialized,
  unprotectBackstageQueuedGptJobOutput,
} from '@shared/backstage/backstageQueuedJobResultProtection.js';
import {
  projectBackstageBookerManagedJobResultPayload,
  type BackstageBookerManagedJobResultPayload,
} from '@shared/backstage/backstageBookerAsyncContinuation.js';
import {
  buildGptIdempotencyScopeHash,
  resolvePublicGptJobCreationSurface,
} from '@shared/gpt/gptIdempotency.js';
import { isGptJobTerminalStatus } from '@shared/gpt/gptJobLifecycle.js';
import {
  buildGptJobResultLookupPayload,
} from '@shared/gpt/gptJobResult.js';
import { createClientDisconnectAbortScope } from '@shared/http/clientDisconnectAbort.js';
import { asyncHandler } from '@shared/http/index.js';
import { sendBoundedJsonResponse } from '@shared/http/sendBoundedJsonResponse.js';
import {
  BACKSTAGE_BOOKER_ASYNC_RESULT_PATH_PREFIX,
  backstageBookerHttpBoundary,
  isBackstageBookerAsyncResultReadRequest,
} from '@services/backstageBookerHttpBoundary.js';
import {
  getBackstageBookerAccessLegacyActorKey,
  requireBackstageBookerAccessAuthentication,
} from '@services/backstageBookerAccessAuth.js';
import {
  DEFAULT_ASYNC_GPT_WAIT_POLL_MS,
  MAX_ASYNC_GPT_WAIT_FOR_RESULT_MS,
  waitForQueuedGptJobCompletion,
  type QueuedGptCompletionDependencies,
  type QueuedGptCompletionResult,
  type WaitForQueuedGptJobCompletionOptions,
} from '@services/queuedGptCompletionService.js';

const UUID_JOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const BACKSTAGE_BOOKER_ASYNC_RESULT_OPENAPI_PATH =
  `${BACKSTAGE_BOOKER_ASYNC_RESULT_PATH_PREFIX}/{jobId}/result`;
export const BACKSTAGE_BOOKER_ASYNC_RESULT_WAIT_DEFAULT_MS =
  MAX_ASYNC_GPT_WAIT_FOR_RESULT_MS;

export type BackstageBookerAsyncResultQuery =
  | { ok: true; waitForResultMs: number }
  | { ok: false };

export interface BackstageBookerAsyncResultReadInput {
  jobId: string;
  actorKey: string;
  legacyActorKey?: string | null;
  waitForResultMs: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

export interface BackstageBookerAsyncResultReadDependencies {
  getJobByIdFn?: (jobId: string) => Promise<JobData | null>;
  waitForQueuedGptJobCompletionFn?: (
    jobId: string,
    options?: WaitForQueuedGptJobCompletionOptions,
    dependencies?: QueuedGptCompletionDependencies
  ) => Promise<QueuedGptCompletionResult>;
}

export interface BackstageBookerAsyncResultRouterDependencies
  extends BackstageBookerAsyncResultReadDependencies {
  boundary?: RequestHandler;
  recordJobLookup?: typeof recordGptJobLookup;
}

export class BackstageBookerAsyncResultUnavailableError extends Error {
  readonly code = 'BACKSTAGE_ASYNC_RESULT_UNAVAILABLE';

  constructor() {
    super('Protected Backstage generation result is unavailable.');
    this.name = 'BackstageBookerAsyncResultUnavailableError';
  }
}

function parseCanonicalWaitMs(value: unknown): number | null {
  if (
    typeof value !== 'string'
    || !/^(?:0|[1-9]\d*)$/u.test(value)
  ) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed)
    && parsed <= MAX_ASYNC_GPT_WAIT_FOR_RESULT_MS
    ? parsed
    : null;
}

/** Parse the closed Builder-facing async result query. */
export function parseBackstageBookerAsyncResultQuery(
  query: Record<string, unknown>
): BackstageBookerAsyncResultQuery {
  const keys = Object.keys(query);
  if (
    keys.some(key => key !== 'waitForResultMs')
    || keys.filter(key => key === 'waitForResultMs').length > 1
  ) {
    return { ok: false };
  }

  if (query.waitForResultMs === undefined) {
    return {
      ok: true,
      waitForResultMs: BACKSTAGE_BOOKER_ASYNC_RESULT_WAIT_DEFAULT_MS,
    };
  }

  const waitForResultMs = parseCanonicalWaitMs(query.waitForResultMs);
  return waitForResultMs === null
    ? { ok: false }
    : { ok: true, waitForResultMs };
}

/** Restrict bearer reads to exact, owned protected Booker generation jobs. */
export function isBackstageBookerBearerReadableJob(
  job: JobData | null,
  expectedScopeHashes: ReadonlySet<string>
): job is JobData {
  return job?.job_type === 'gpt'
    && typeof job.idempotency_scope_hash === 'string'
    && expectedScopeHashes.has(job.idempotency_scope_hash)
    && resolvePublicGptJobCreationSurface(job.input) === 'public-gpt'
    && isProtectedBackstageQueuedGptJobEnvelope(job.input);
}

function materializeProtectedBackstageJob(job: JobData): JobData {
  let output: unknown;
  try {
    output = unprotectBackstageQueuedGptJobOutput({
      jobId: job.id,
      rawInput: job.input,
      output: job.output,
    });
  } catch {
    throw new BackstageBookerAsyncResultUnavailableError();
  }

  return markProtectedBackstageQueuedGptJobResultMaterialized(
    output === job.output ? job : { ...job, output }
  );
}

/**
 * Read one protected Booker job through the existing bounded queue waiter.
 * Unowned, malformed, and unrelated jobs share the non-disclosing not-found
 * projection and never enter the wait loop.
 */
export async function readBackstageBookerAsyncResult(
  input: BackstageBookerAsyncResultReadInput,
  dependencies: BackstageBookerAsyncResultReadDependencies = {}
): Promise<BackstageBookerManagedJobResultPayload> {
  const getJobByIdFn = dependencies.getJobByIdFn ?? getJobById;
  const waitForCompletion = dependencies.waitForQueuedGptJobCompletionFn
    ?? waitForQueuedGptJobCompletion;
  const expectedScopeHashes = new Set(
    [input.actorKey, input.legacyActorKey]
      .filter((actorKey): actorKey is string => Boolean(actorKey))
      .map(actorKey => buildGptIdempotencyScopeHash({
        surface: 'public-gpt',
        actorKey,
      }))
  );

  input.signal?.throwIfAborted();
  const initialJob = await getJobByIdFn(input.jobId);
  input.signal?.throwIfAborted();
  if (!isBackstageBookerBearerReadableJob(initialJob, expectedScopeHashes)) {
    return projectBackstageBookerManagedJobResultPayload(
      buildGptJobResultLookupPayload(input.jobId, null)
    );
  }

  let selectedJob: JobData | null = initialJob;
  if (
    input.waitForResultMs > 0
    && !isGptJobTerminalStatus(initialJob.status)
  ) {
    let initialReadAvailable = true;
    const getOwnedJobById = async (jobId: string): Promise<JobData | null> => {
      const candidate = initialReadAvailable
        ? initialJob
        : await getJobByIdFn(jobId);
      initialReadAvailable = false;
      return isBackstageBookerBearerReadableJob(candidate, expectedScopeHashes)
        ? candidate
        : null;
    };

    const observation = await waitForCompletion(
      input.jobId,
      {
        waitForResultMs: input.waitForResultMs,
        pollIntervalMs:
          input.pollIntervalMs ?? DEFAULT_ASYNC_GPT_WAIT_POLL_MS,
        signal: input.signal,
      },
      { getJobByIdFn: getOwnedJobById }
    );
    selectedJob = observation.job;
  }

  input.signal?.throwIfAborted();
  if (!isBackstageBookerBearerReadableJob(selectedJob, expectedScopeHashes)) {
    return projectBackstageBookerManagedJobResultPayload(
      buildGptJobResultLookupPayload(input.jobId, null)
    );
  }

  return projectBackstageBookerManagedJobResultPayload(
    buildGptJobResultLookupPayload(
      input.jobId,
      materializeProtectedBackstageJob(selectedJob)
    )
  );
}

function hasRequestBody(req: Request): boolean {
  const contentLength = req.get('content-length');
  return req.get('transfer-encoding') !== undefined
    || (contentLength !== undefined && contentLength !== '0');
}

function sendBackstageAsyncResultError(
  req: Request,
  res: Response,
  statusCode: 400 | 503,
  code: string,
  message: string
): void {
  sendBoundedJsonResponse(req, res, {
    ok: false,
    ...(statusCode === 503
      ? { status: 'unavailable', service: 'backstage-booker' }
      : {}),
    error: { code, message },
    ...(req.requestId ? { requestId: req.requestId } : {}),
    ...(req.traceId ? { traceId: req.traceId } : {}),
  }, {
    logEvent: 'backstage_booker_async_result.error',
    statusCode,
  });
}

/** Build the dedicated Builder-facing bearer-authenticated result adapter. */
export function createBackstageBookerAsyncResultRouter(
  dependencies: BackstageBookerAsyncResultRouterDependencies = {}
): express.Router {
  const router = express.Router();
  const boundary = dependencies.boundary ?? backstageBookerHttpBoundary;
  const recordLookup = dependencies.recordJobLookup ?? recordGptJobLookup;

  router.use(BACKSTAGE_BOOKER_ASYNC_RESULT_PATH_PREFIX, boundary);
  router.get(
    `${BACKSTAGE_BOOKER_ASYNC_RESULT_PATH_PREFIX}/:jobId/result`,
    requireBackstageBookerAccessAuthentication,
    asyncHandler(async (req, res) => {
      const jobId = req.params.jobId;
      const parsedQuery = parseBackstageBookerAsyncResultQuery(
        req.query as Record<string, unknown>
      );
      if (
        !isBackstageBookerAsyncResultReadRequest(req)
        || typeof jobId !== 'string'
        || !UUID_JOB_ID_PATTERN.test(jobId)
        || !parsedQuery.ok
        || hasRequestBody(req)
      ) {
        sendBackstageAsyncResultError(
          req,
          res,
          400,
          'GPT_ACCESS_VALIDATION_ERROR',
          'The Backstage Booker async result request is invalid.'
        );
        return;
      }

      const abortScope = createClientDisconnectAbortScope(
        req,
        res,
        'Backstage Booker async result client disconnected'
      );
      try {
        const lookup = await abortScope.run(signal =>
          readBackstageBookerAsyncResult(
            {
              jobId,
              actorKey: getRequestAuthenticatedActorKey(req),
              legacyActorKey: getBackstageBookerAccessLegacyActorKey(req),
              waitForResultMs: parsedQuery.waitForResultMs,
              pollIntervalMs: DEFAULT_ASYNC_GPT_WAIT_POLL_MS,
              signal,
            },
            dependencies
          )
        );
        try {
          req.logger?.info('backstage_booker_async_result.completed', {
            jobId,
            lookupStatus: lookup.status,
            jobStatus: lookup.jobStatus,
            lifecycleStatus: lookup.lifecycleStatus,
            waitForResultMs: parsedQuery.waitForResultMs,
          });
        } catch {
          // Diagnostics must not alter the protected result response.
        }
        recordLookup({
          channel: 'backstage_booker_bearer',
          lookup: 'result',
          outcome: lookup.status,
        });
        sendBoundedJsonResponse(req, res, lookup, {
          logEvent: 'backstage_booker_async_result.response',
          statusCode: 200,
        });
      } catch (error: unknown) {
        if (error instanceof JobRepositoryUnavailableError) {
          recordLookup({
            channel: 'backstage_booker_bearer',
            lookup: 'result',
            outcome: 'unavailable',
          });
          sendBackstageAsyncResultError(
            req,
            res,
            503,
            'JOB_REPOSITORY_UNAVAILABLE',
            'Durable Backstage Booker job results are temporarily unavailable.'
          );
          return;
        }
        if (error instanceof BackstageBookerAsyncResultUnavailableError) {
          recordLookup({
            channel: 'backstage_booker_bearer',
            lookup: 'result',
            outcome: 'unavailable',
          });
          sendBackstageAsyncResultError(
            req,
            res,
            503,
            error.code,
            error.message
          );
          return;
        }
        throw error;
      } finally {
        abortScope.cleanup();
      }
    })
  );

  router.all(
    `${BACKSTAGE_BOOKER_ASYNC_RESULT_PATH_PREFIX}/:jobId/result`,
    requireBackstageBookerAccessAuthentication,
    (req, res) => {
      res.setHeader('Allow', 'GET, HEAD');
      sendBoundedJsonResponse(req, res, {
        ok: false,
        error: {
          code: 'METHOD_NOT_ALLOWED',
          message: 'This Backstage Booker async result endpoint supports GET and HEAD only.',
        },
        ...(req.requestId ? { requestId: req.requestId } : {}),
        ...(req.traceId ? { traceId: req.traceId } : {}),
      }, {
        logEvent: 'backstage_booker_async_result.method_not_allowed',
        statusCode: 405,
      });
    }
  );

  return router;
}

const router = createBackstageBookerAsyncResultRouter();

export default router;
