import crypto from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { asyncHandler } from '@transport/http/asyncHandler.js';
import { sendNotFound } from '@shared/http/errors.js';
import { validateParams } from '@shared/http/validation.js';
import {
  isGptJobTerminalStatus
} from '@shared/gpt/gptJobLifecycle.js';
import { buildGptIdempotencyScopeHash } from '@shared/gpt/gptIdempotency.js';
import {
  buildGptJobResultLookupPayload,
  buildStoredJobStatusPayload
} from '@shared/gpt/gptJobResult.js';
import {
  PROTECTED_BACKSTAGE_JOB_CANCELLATION_MESSAGE,
  hasProtectedBackstageQueuedGptJobMarker,
  isProtectedBackstageQueuedGptJobEnvelope,
  markProtectedBackstageQueuedGptJobResultMaterialized,
  unprotectBackstageQueuedGptJobOutput,
} from '@shared/backstage/backstageQueuedJobResultProtection.js';
import { buildJobResultPollPath } from '@shared/jobs/jobLinks.js';
import { sendBoundedJsonResponse } from '@shared/http/sendBoundedJsonResponse.js';
import {
  BACKSTAGE_STORYLINE_PUBLIC_RESPONSE_MAX_BYTES
} from '@shared/backstage/backstageStoryline.js';
import { BACKSTAGE_MODULE_NAME } from '@shared/backstage/backstageActionPolicy.js';
import {
  JOB_READ_AUTH_UNAVAILABLE_CODE,
  JOB_READ_AUTH_UNAVAILABLE_MESSAGE,
  JOB_READ_CAPABILITY_HEADER_NAME,
  isGenericJobCapabilityEligible,
  resolveGenericJobCapabilitySurface,
  type JobReadCapabilityVerification,
} from '@shared/jobs/jobReadCapability.js';
import type {
  CustomGptBridgeCredentialInput,
  CustomGptBridgeCredentialResult,
} from '@shared/security/customGptBridgeCredential.js';

export type GenericJobData =
  Parameters<typeof buildStoredJobStatusPayload>[0];

export interface GenericJobCancellationResult {
  outcome: 'cancelled' | 'cancellation_requested' | 'already_terminal' | 'not_found';
  job: GenericJobData | null;
}

export interface GenericJobsRouterDependencies {
  getJobById: (jobId: string) => Promise<GenericJobData | null>;
  isJobRepositoryUnavailable: (error: unknown) => boolean;
  requestJobCancellation: (
    jobId: string,
    reason?: string
  ) => Promise<GenericJobCancellationResult>;
  confirmCancellation: express.RequestHandler;
  getRequestActorKey: (request: express.Request) => string;
  getRequestEstablishedActorKey: (request: express.Request) => string | null;
  recordJobLookup: (input: {
    channel: string;
    lookup: 'status' | 'result';
    outcome: string;
  }) => void;
  sleep: (durationMs: number) => Promise<void>;
  validateBridgeCredential: (
    input: CustomGptBridgeCredentialInput
  ) => CustomGptBridgeCredentialResult;
  verifyJobReadCapability: (
    jobId: string,
    presentedCapability: unknown
  ) => JobReadCapabilityVerification;
}

function noStoreResponse(
  _request: express.Request,
  response: express.Response,
  next: express.NextFunction
): void {
  response.setHeader('Cache-Control', 'no-store');
  next();
}

export function createGenericJobsRouter(
  dependencies: GenericJobsRouterDependencies
): express.Router {
const {
  confirmCancellation,
  getJobById,
  getRequestActorKey,
  getRequestEstablishedActorKey,
  isJobRepositoryUnavailable,
  recordJobLookup,
  requestJobCancellation,
  sleep,
  validateBridgeCredential,
  verifyJobReadCapability,
} = dependencies;
const router = express.Router();
router.use('/jobs', noStoreResponse);

const DEFAULT_JOB_STREAM_POLL_MS = 500;
const DEFAULT_JOB_STREAM_MAX_DURATION_MS = 60_000;
const UUID_JOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const jobIdSchema = z.object({
  id: z.string().trim().regex(UUID_JOB_ID_PATTERN)
});

function isTerminalJobStatus(status: GenericJobData['status']): boolean {
  return isGptJobTerminalStatus(status);
}

function isPublicReadableJob(
  job: GenericJobData | null
): job is GenericJobData {
  return isGenericJobCapabilityEligible(job);
}

function writeSseEvent(
  res: express.Response,
  event: string,
  payload: Record<string, unknown>
): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function hashActorKey(actorKey: string): string {
  return crypto.createHash('sha256').update(actorKey.trim()).digest('hex');
}

function countRawHeaders(req: express.Request, headerName: string): number {
  let count = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === headerName) {
      count += 1;
    }
  }
  return count;
}

function readJobReadCapability(req: express.Request): string | null {
  if (countRawHeaders(req, JOB_READ_CAPABILITY_HEADER_NAME) !== 1) {
    return null;
  }

  const value = req.headers[JOB_READ_CAPABILITY_HEADER_NAME];
  return typeof value === 'string' ? value : null;
}

function resolveCancellationActorKey(
  req: express.Request,
  capabilitySurface: ReturnType<typeof resolveGenericJobCapabilitySurface>
): string | null {
  const actorKey = capabilitySurface === 'public-gpt'
    ? getRequestEstablishedActorKey(req)
    : getRequestActorKey(req);
  if (!actorKey) {
    return null;
  }
  return actorKey.startsWith('ip:') ? null : actorKey;
}

function isInternalCancellationActor(actorKey: string): boolean {
  return actorKey.startsWith('daemon:') || actorKey.startsWith('operator:');
}

function sendJobsJsonResponse(
  req: express.Request,
  res: express.Response,
  payload: object,
  logEvent: string,
  statusCode = 200,
  maxBytes?: number
) {
  return sendBoundedJsonResponse(req, res, payload, {
    logEvent,
    statusCode,
    ...(maxBytes === undefined
      ? {}
      : { maxBytes, maxBytesCeiling: maxBytes }),
  });
}

function isBackstageStorylineJob(job: GenericJobData | null): boolean {
  if (!job || typeof job.input !== 'object' || job.input === null || Array.isArray(job.input)) {
    return false;
  }

  const admission = (job.input as Record<string, unknown>).backstageMutationAdmission;
  if (typeof admission !== 'object' || admission === null || Array.isArray(admission)) {
    return false;
  }

  const record = admission as Record<string, unknown>;
  return record.module === BACKSTAGE_MODULE_NAME && record.action === 'trackStoryline';
}

function isCompletedBackstageStorylineJob(job: GenericJobData | null): job is GenericJobData {
  return job?.status === 'completed' && isBackstageStorylineJob(job);
}

function buildPublicJobStatusPayload(job: GenericJobData) {
  const payload = buildStoredJobStatusPayload(job);
  if (!isCompletedBackstageStorylineJob(job)) {
    return payload;
  }

  return {
    ...payload,
    // The canonical result already contains the completed module envelope. Avoid
    // serializing the same potentially large storyline beat array a second time.
    output: null,
  };
}

function sendJobRepositoryUnavailable(
  req: express.Request,
  res: express.Response,
  jobId: string,
  logEvent: string
): void {
  req.logger?.error?.('gpt.job.repository_unavailable', {
    endpoint: req.originalUrl,
    jobId,
    requestId: (req as any).requestId
  });
  sendJobsJsonResponse(
    req,
    res,
    { error: 'JOB_REPOSITORY_UNAVAILABLE' },
    logEvent,
    503
  );
}

function materializeProtectedJobOutput(job: GenericJobData): GenericJobData {
  if (!hasProtectedBackstageQueuedGptJobMarker(job.input)) {
    return job;
  }
  const output = unprotectBackstageQueuedGptJobOutput({
    jobId: job.id,
    rawInput: job.input,
    output: job.output,
  });
  return markProtectedBackstageQueuedGptJobResultMaterialized(
    output === job.output ? job : { ...job, output }
  );
}

function sendProtectedJobResultUnavailable(
  req: express.Request,
  res: express.Response,
  jobId: string,
  logEvent: string
): void {
  req.logger?.error?.('gpt.job.protected_result_unavailable', {
    endpoint: req.originalUrl,
    jobId,
    requestId: (req as any).requestId,
  });
  sendJobsJsonResponse(req, res, {
    error: 'BACKSTAGE_ASYNC_RESULT_UNAVAILABLE',
    message: 'Protected Backstage generation result is unavailable.',
  }, logEvent, 503);
}

type JobLookupResult =
  | { available: true; job: GenericJobData | null }
  | { available: false };

type JobReadAccessResult =
  | { available: false; authorized: false }
  | { available: true; authorized: boolean };

function checkJobReadAccess(
  req: express.Request,
  res: express.Response,
  jobId: string,
  logEvent: string
): JobReadAccessResult {
  const verification = verifyJobReadCapability(
    jobId,
    readJobReadCapability(req)
  );
  if (verification.available) {
    return verification;
  }

  sendJobsJsonResponse(
    req,
    res,
    {
      error: JOB_READ_AUTH_UNAVAILABLE_CODE,
      message: JOB_READ_AUTH_UNAVAILABLE_MESSAGE,
    },
    logEvent,
    503
  );
  return { available: false, authorized: false };
}

function sendJobResultNotFound(
  req: express.Request,
  res: express.Response,
  jobId: string
): void {
  sendJobsJsonResponse(
    req,
    res,
    buildGptJobResultLookupPayload(jobId, null),
    'jobs.result.response'
  );
}

async function lookupJobForRoute(
  req: express.Request,
  res: express.Response,
  jobId: string,
  logEvent: string
): Promise<JobLookupResult> {
  try {
    return {
      available: true,
      job: await getJobById(jobId)
    };
  } catch (error) {
    if (!isJobRepositoryUnavailable(error)) {
      throw error;
    }

    sendJobRepositoryUnavailable(req, res, jobId, logEvent);
    return { available: false };
  }
}

function validateJobsJsonRouteParams(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const parsed = jobIdSchema.safeParse(req.params);
  if (!parsed.success) {
    sendJobsJsonResponse(req, res, { error: 'JOB_ID_INVALID' }, 'jobs.validation.invalid', 400);
    return;
  }

  if (!req.validated) {
    req.validated = {};
  }
  req.validated.params = parsed.data;
  next();
}

function requireJobReadCapabilityBeforeConfirmation(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  const { id } = req.validated!.params as z.infer<typeof jobIdSchema>;
  const readAccess = checkJobReadAccess(
    req,
    res,
    id,
    'jobs.cancel.auth_unavailable'
  );
  if (!readAccess.available) {
    return;
  }
  if (!readAccess.authorized) {
    sendJobsJsonResponse(
      req,
      res,
      { error: 'JOB_NOT_FOUND' },
      'jobs.cancel.not_found',
      404
    );
    return;
  }

  next();
}

router.get(
  '/jobs/:id',
  validateJobsJsonRouteParams,
  asyncHandler(async (req, res) => {
    const { id } = req.validated!.params as z.infer<typeof jobIdSchema>;
    const requestId = (req as any).requestId;
    const readAccess = checkJobReadAccess(
      req,
      res,
      id,
      'jobs.status.auth_unavailable'
    );
    if (!readAccess.available) {
      return;
    }
    if (!readAccess.authorized) {
      sendJobsJsonResponse(req, res, { error: 'JOB_NOT_FOUND' }, 'jobs.status.not_found', 404);
      return;
    }

    const lookup = await lookupJobForRoute(req, res, id, 'jobs.status.repository_unavailable');
    if (!lookup.available) {
      recordJobLookup({
        channel: 'jobs_status',
        lookup: 'status',
        outcome: 'unavailable'
      });
      return;
    }

    let job = lookup.job;
    if (!isPublicReadableJob(job)) {
      req.logger?.warn?.('gpt.job.status_lookup.not_found', {
        endpoint: req.originalUrl,
        jobId: id,
        requestId
      });
      recordJobLookup({
        channel: 'jobs_status',
        lookup: 'status',
        outcome: 'not_found'
      });
      sendJobsJsonResponse(req, res, { error: 'JOB_NOT_FOUND' }, 'jobs.status.not_found', 404);
      return;
    }
    try {
      job = materializeProtectedJobOutput(job);
    } catch {
      sendProtectedJobResultUnavailable(req, res, id, 'jobs.status.protected_result_unavailable');
      return;
    }

    req.logger?.info?.('gpt.job.status_lookup', {
      endpoint: req.originalUrl,
      jobId: id,
      requestId,
      jobStatus: job.status,
      lifecycleStatus: isGptJobTerminalStatus(job.status) ? 'terminal' : 'active'
    });
    recordJobLookup({
      channel: 'jobs_status',
      lookup: 'status',
      outcome: job.status
    });

    sendJobsJsonResponse(
      req,
      res,
      buildPublicJobStatusPayload(job),
      'jobs.status.response',
      200,
      isCompletedBackstageStorylineJob(job)
        ? BACKSTAGE_STORYLINE_PUBLIC_RESPONSE_MAX_BYTES
        : undefined
    );
  })
);

router.get(
  '/jobs/:id/result',
  validateJobsJsonRouteParams,
  asyncHandler(async (req, res) => {
    const { id } = req.validated!.params as z.infer<typeof jobIdSchema>;
    const requestId = (req as any).requestId;
    const readAccess = checkJobReadAccess(
      req,
      res,
      id,
      'jobs.result.auth_unavailable'
    );
    if (!readAccess.available) {
      return;
    }
    if (!readAccess.authorized) {
      sendJobResultNotFound(req, res, id);
      return;
    }
    const lookup = await lookupJobForRoute(req, res, id, 'jobs.result.repository_unavailable');
    if (!lookup.available) {
      recordJobLookup({
        channel: 'jobs_result',
        lookup: 'result',
        outcome: 'unavailable'
      });
      return;
    }

    const job = lookup.job;
    let publicJob = isPublicReadableJob(job) ? job : null;
    if (publicJob) {
      try {
        publicJob = materializeProtectedJobOutput(publicJob);
      } catch {
        sendProtectedJobResultUnavailable(req, res, id, 'jobs.result.protected_result_unavailable');
        return;
      }
    }
    const jobLookup = buildGptJobResultLookupPayload(id, publicJob);

    req.logger?.info?.(
      jobLookup.status === 'not_found'
        ? 'gpt.job.result_lookup.not_found'
        : 'gpt.job.result_lookup',
      {
        endpoint: req.originalUrl,
        jobId: id,
        requestId,
        lookupStatus: jobLookup.status,
        jobStatus: jobLookup.jobStatus,
        lifecycleStatus: jobLookup.lifecycleStatus
      }
    );
    recordJobLookup({
      channel: 'jobs_result',
      lookup: 'result',
      outcome: jobLookup.status
    });

    sendJobsJsonResponse(
      req,
      res,
      jobLookup,
      'jobs.result.response',
      200,
      isBackstageStorylineJob(publicJob)
        ? BACKSTAGE_STORYLINE_PUBLIC_RESPONSE_MAX_BYTES
        : undefined
    );
  })
);

router.post(
  '/jobs/:id/cancel',
  validateJobsJsonRouteParams,
  requireJobReadCapabilityBeforeConfirmation,
  confirmCancellation,
  asyncHandler(async (req, res) => {
    const { id } = req.validated!.params as z.infer<typeof jobIdSchema>;
    let reason =
      typeof req.body?.reason === 'string' && req.body.reason.trim().length > 0
        ? req.body.reason.trim()
        : 'Job cancellation requested by client.';
    const lookup = await lookupJobForRoute(req, res, id, 'jobs.cancel.repository_unavailable');
    if (!lookup.available) {
      return;
    }

    let job = lookup.job;

    if (!isPublicReadableJob(job)) {
      sendJobsJsonResponse(req, res, { error: 'JOB_NOT_FOUND' }, 'jobs.cancel.not_found', 404);
      return;
    }
    if (isProtectedBackstageQueuedGptJobEnvelope(job.input)) {
      reason = PROTECTED_BACKSTAGE_JOB_CANCELLATION_MESSAGE;
    }
    try {
      job = materializeProtectedJobOutput(job);
    } catch {
      sendProtectedJobResultUnavailable(req, res, id, 'jobs.cancel.protected_result_unavailable');
      return;
    }

    const capabilitySurface = resolveGenericJobCapabilitySurface(job);
    let cancellationActorKey: string | null = null;
    if (capabilitySurface === 'custom-gpt-bridge') {
      const bridgeAuth = validateBridgeCredential({
        authorization: req.header('authorization'),
        actionSecret:
          req.header('x-openai-action-secret')
          ?? req.header('x-action-secret'),
      });
      if (!bridgeAuth.ok) {
        const statusCode = bridgeAuth.statusCode;
        req.logger?.warn?.('gpt.job.cancel.bridge_auth_failed', {
          endpoint: req.originalUrl,
          jobId: id,
          statusCode,
        });
        sendJobsJsonResponse(req, res, {
          ok: false,
          error: {
            code: statusCode === 503
              ? 'JOB_CANCELLATION_AUTH_UNAVAILABLE'
              : 'JOB_CANCELLATION_AUTH_REQUIRED',
            message: statusCode === 503
              ? 'Job cancellation authentication is temporarily unavailable.'
              : 'Bridge job cancellation requires the authenticated bridge credential.',
          },
        }, 'jobs.cancel.bridge_auth_failed', statusCode);
        return;
      }
      cancellationActorKey = bridgeAuth.actorKey;
    } else {
      cancellationActorKey = resolveCancellationActorKey(req, capabilitySurface);
      if (!cancellationActorKey) {
        req.logger?.warn?.('gpt.job.cancel.unauthenticated', {
          endpoint: req.originalUrl,
          jobId: id
        });
        sendJobsJsonResponse(req, res, {
          ok: false,
          error: {
            code: 'JOB_CANCELLATION_AUTH_REQUIRED',
            message: 'Job cancellation requires an established authenticated principal or internal actor.'
          }
        }, 'jobs.cancel.auth_required', 401);
        return;
      }
    }

    const cancellationScopeHash =
      cancellationActorKey
      && (capabilitySurface === 'public-gpt'
        || capabilitySurface === 'custom-gpt-bridge')
        ? buildGptIdempotencyScopeHash({
            surface: capabilitySurface,
            actorKey: cancellationActorKey,
          })
        : cancellationActorKey
          ? hashActorKey(cancellationActorKey)
          : null;
    if (job.idempotency_scope_hash) {
      if (job.idempotency_scope_hash !== cancellationScopeHash) {
        req.logger?.warn?.('gpt.job.cancel.forbidden', {
          endpoint: req.originalUrl,
          jobId: id
        });
        sendJobsJsonResponse(req, res, {
          ok: false,
          error: {
            code: 'JOB_CANCELLATION_FORBIDDEN',
            message: 'The current caller does not own this job.'
          }
        }, 'jobs.cancel.forbidden', 403);
        return;
      }
    } else if (!cancellationActorKey || !isInternalCancellationActor(cancellationActorKey)) {
      req.logger?.warn?.('gpt.job.cancel.unscoped_forbidden', {
        endpoint: req.originalUrl,
        jobId: id
      });
      sendJobsJsonResponse(req, res, {
        ok: false,
        error: {
          code: 'JOB_CANCELLATION_FORBIDDEN',
          message: 'This job can only be cancelled by an internal actor.'
        }
      }, 'jobs.cancel.unscoped_forbidden', 403);
      return;
    }

    let cancellation;
    try {
      cancellation = await requestJobCancellation(id, reason);
    } catch (error) {
      if (!isJobRepositoryUnavailable(error)) {
        throw error;
      }

      sendJobRepositoryUnavailable(req, res, id, 'jobs.cancel.repository_unavailable');
      return;
    }

    if (cancellation.outcome === 'not_found') {
      sendJobsJsonResponse(req, res, { error: 'JOB_NOT_FOUND' }, 'jobs.cancel.not_found', 404);
      return;
    }

    if (cancellation.job) {
      try {
        cancellation = {
          ...cancellation,
          job: materializeProtectedJobOutput(cancellation.job),
        };
      } catch {
        sendProtectedJobResultUnavailable(req, res, id, 'jobs.cancel.protected_result_unavailable');
        return;
      }
    }

    if (cancellation.outcome === 'already_terminal') {
      sendJobsJsonResponse(req, res, {
        ok: false,
        error: {
          code: 'JOB_ALREADY_TERMINAL',
          message: 'Terminal jobs cannot be cancelled.'
        },
        job: cancellation.job ? buildStoredJobStatusPayload(cancellation.job) : null
      }, 'jobs.cancel.already_terminal', 409);
      return;
    }

    const statusCode = cancellation.outcome === 'cancelled' ? 200 : 202;
    sendJobsJsonResponse(req, res, {
      ok: true,
      cancellationRequested: cancellation.outcome === 'cancellation_requested',
      ...buildStoredJobStatusPayload(cancellation.job!)
    }, 'jobs.cancel.response', statusCode);
  })
);

router.get(
  '/jobs/:id/stream',
  noStoreResponse,
  validateParams(jobIdSchema, { errorCode: 'JOB_ID_INVALID' }),
  asyncHandler(async (req, res) => {
    const { id } = req.validated!.params as z.infer<typeof jobIdSchema>;
    const readAccess = checkJobReadAccess(
      req,
      res,
      id,
      'jobs.stream.auth_unavailable'
    );
    if (!readAccess.available) {
      return;
    }
    if (!readAccess.authorized) {
      sendNotFound(res, 'JOB_NOT_FOUND');
      return;
    }
    const initialLookup = await lookupJobForRoute(
      req,
      res,
      id,
      'jobs.stream.repository_unavailable'
    );
    if (!initialLookup.available) {
      return;
    }

    const initialJob = initialLookup.job;

    if (!isPublicReadableJob(initialJob)) {
      sendNotFound(res, 'JOB_NOT_FOUND');
      return;
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write('retry: 1000\n\n');

    let closed = false;
    const streamStartedAtMs = Date.now();
    let lastObservedStatus: GenericJobData['status'] | null = null;
    let nextObservedJob: GenericJobData | null = initialJob;
    const handleClosedStream = () => {
      closed = true;
    };

    req.on('close', handleClosedStream);

    try {
      while (!closed) {
        let job = nextObservedJob ?? await getJobById(id);
        nextObservedJob = null;

        if (!isPublicReadableJob(job)) {
          writeSseEvent(res, 'error', {
            code: 'JOB_NOT_FOUND',
            jobId: id
          });
          return;
        }
        try {
          job = materializeProtectedJobOutput(job);
        } catch {
          writeSseEvent(res, 'error', {
            code: 'BACKSTAGE_ASYNC_RESULT_UNAVAILABLE',
            jobId: id,
          });
          return;
        }

        const payload = buildPublicJobStatusPayload(job);
        if (job.status !== lastObservedStatus) {
          writeSseEvent(
            res,
            isTerminalJobStatus(job.status) ? 'terminal' : 'status',
            payload
          );
          lastObservedStatus = job.status;
        } else {
          res.write(': keep-alive\n\n');
        }

        if (isTerminalJobStatus(job.status)) {
          return;
        }

        if (Date.now() - streamStartedAtMs >= DEFAULT_JOB_STREAM_MAX_DURATION_MS) {
          writeSseEvent(res, 'timeout', {
            jobId: id,
            status: job.status,
            poll: buildJobResultPollPath(id)
          });
          return;
        }

        await sleep(DEFAULT_JOB_STREAM_POLL_MS);
      }
    } catch (error) {
      if (!isJobRepositoryUnavailable(error)) {
        throw error;
      }

      req.logger?.error?.('gpt.job.stream.repository_unavailable', {
        endpoint: req.originalUrl,
        jobId: id,
        requestId: (req as any).requestId
      });
      writeSseEvent(res, 'error', {
        code: 'JOB_REPOSITORY_UNAVAILABLE',
        jobId: id
      });
    } finally {
      req.off('close', handleClosedStream);
      if (!res.writableEnded) {
        res.end();
      }
    }
  })
);

return router;
}
