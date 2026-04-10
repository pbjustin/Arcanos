import crypto from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import {
  getJobById,
  requestJobCancellation
} from "@core/db/repositories/jobRepository.js";
import { asyncHandler, validateParams, sendNotFound } from '@shared/http/index.js';
import { confirmGate } from '@transport/http/middleware/confirmGate.js';
import type { JobData } from '@core/db/schema.js';
import { sleep } from '@shared/sleep.js';
import { getRequestActorKey } from '@platform/runtime/security.js';
import {
  isGptJobTerminalStatus
} from '@shared/gpt/gptJobLifecycle.js';
import { buildStoredJobStatusPayload } from '@shared/gpt/gptJobResult.js';

const router = express.Router();
const DEFAULT_JOB_STREAM_POLL_MS = 500;
const DEFAULT_JOB_STREAM_MAX_DURATION_MS = 60_000;

const jobIdSchema = z.object({
  id: z.string().min(1)
});

function isTerminalJobStatus(status: JobData['status']): boolean {
  return isGptJobTerminalStatus(status);
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

function resolveCancellationActorKey(req: express.Request): string | null {
  const actorKey = getRequestActorKey(req);
  return actorKey.startsWith('ip:') ? null : actorKey;
}

function isInternalCancellationActor(actorKey: string): boolean {
  return actorKey.startsWith('daemon:') || actorKey.startsWith('operator:');
}

router.get(
  '/jobs/:id',
  validateParams(jobIdSchema, { errorCode: 'JOB_ID_INVALID' }),
  asyncHandler(async (req, res) => {
    const { id } = req.validated!.params as z.infer<typeof jobIdSchema>;

    const job = await getJobById(id);
    if (!job) {
      sendNotFound(res, 'JOB_NOT_FOUND');
      return;
    }

    res.json(buildStoredJobStatusPayload(job));
  })
);

router.post(
  '/jobs/:id/cancel',
  validateParams(jobIdSchema, { errorCode: 'JOB_ID_INVALID' }),
  confirmGate,
  asyncHandler(async (req, res) => {
    const { id } = req.validated!.params as z.infer<typeof jobIdSchema>;
    const cancellationActorKey = resolveCancellationActorKey(req);
    if (!cancellationActorKey) {
      req.logger?.warn?.('gpt.job.cancel.unauthenticated', {
        endpoint: req.originalUrl,
        jobId: id
      });
      res.status(401).json({
        ok: false,
        error: {
          code: 'JOB_CANCELLATION_AUTH_REQUIRED',
          message: 'Job cancellation requires an authenticated session or internal actor.'
        }
      });
      return;
    }

    const reason =
      typeof req.body?.reason === 'string' && req.body.reason.trim().length > 0
        ? req.body.reason.trim()
        : 'Job cancellation requested by client.';
    const job = await getJobById(id);

    if (!job) {
      sendNotFound(res, 'JOB_NOT_FOUND');
      return;
    }

    const cancellationScopeHash = hashActorKey(cancellationActorKey);
    if (job.idempotency_scope_hash) {
      if (job.idempotency_scope_hash !== cancellationScopeHash) {
        req.logger?.warn?.('gpt.job.cancel.forbidden', {
          endpoint: req.originalUrl,
          jobId: id
        });
        res.status(403).json({
          ok: false,
          error: {
            code: 'JOB_CANCELLATION_FORBIDDEN',
            message: 'The current caller does not own this job.'
          }
        });
        return;
      }
    } else if (!isInternalCancellationActor(cancellationActorKey)) {
      req.logger?.warn?.('gpt.job.cancel.unscoped_forbidden', {
        endpoint: req.originalUrl,
        jobId: id
      });
      res.status(403).json({
        ok: false,
        error: {
          code: 'JOB_CANCELLATION_FORBIDDEN',
          message: 'This job can only be cancelled by an internal actor.'
        }
      });
      return;
    }

    const cancellation = await requestJobCancellation(id, reason);

    if (cancellation.outcome === 'not_found') {
      sendNotFound(res, 'JOB_NOT_FOUND');
      return;
    }

    if (cancellation.outcome === 'already_terminal') {
      res.status(409).json({
        ok: false,
        error: {
          code: 'JOB_ALREADY_TERMINAL',
          message: 'Terminal jobs cannot be cancelled.'
        },
        job: cancellation.job ? buildStoredJobStatusPayload(cancellation.job) : null
      });
      return;
    }

    const statusCode = cancellation.outcome === 'cancelled' ? 200 : 202;
    res.status(statusCode).json({
      ok: true,
      cancellationRequested: cancellation.outcome === 'cancellation_requested',
      ...buildStoredJobStatusPayload(cancellation.job!)
    });
  })
);

router.get(
  '/jobs/:id/stream',
  validateParams(jobIdSchema, { errorCode: 'JOB_ID_INVALID' }),
  asyncHandler(async (req, res) => {
    const { id } = req.validated!.params as z.infer<typeof jobIdSchema>;
    const initialJob = await getJobById(id);

    if (!initialJob) {
      sendNotFound(res, 'JOB_NOT_FOUND');
      return;
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write('retry: 1000\n\n');

    let closed = false;
    const streamStartedAtMs = Date.now();
    let lastObservedStatus: JobData['status'] | null = null;
    let nextObservedJob: JobData | null = initialJob;
    const handleClosedStream = () => {
      closed = true;
    };

    req.on('close', handleClosedStream);

    try {
      while (!closed) {
        const job = nextObservedJob ?? await getJobById(id);
        nextObservedJob = null;

        if (!job) {
          writeSseEvent(res, 'error', {
            code: 'JOB_NOT_FOUND',
            jobId: id
          });
          return;
        }

        const payload = buildStoredJobStatusPayload(job);
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
            poll: `/jobs/${id}`
          });
          return;
        }

        await sleep(DEFAULT_JOB_STREAM_POLL_MS);
      }
    } finally {
      req.off('close', handleClosedStream);
      if (!res.writableEnded) {
        res.end();
      }
    }
  })
);

export default router;
