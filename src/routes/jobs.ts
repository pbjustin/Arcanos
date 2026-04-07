import express from 'express';
import { z } from 'zod';
import {
  getJobById,
  requestJobCancellation
} from "@core/db/repositories/jobRepository.js";
import { asyncHandler, validateParams, sendNotFound } from '@shared/http/index.js';
import type { JobData } from '@core/db/schema.js';
import { sleep } from '@shared/sleep.js';
import {
  isGptJobTerminalStatus,
  resolveGptJobLifecycleStatus
} from '@shared/gpt/gptJobLifecycle.js';

const router = express.Router();
const DEFAULT_JOB_STREAM_POLL_MS = 500;
const DEFAULT_JOB_STREAM_MAX_DURATION_MS = 60_000;

const jobIdSchema = z.object({
  id: z.string().min(1)
});

function isTerminalJobStatus(status: JobData['status']): boolean {
  return isGptJobTerminalStatus(status);
}

function buildJobStatusPayload(job: JobData) {
  return {
    id: job.id,
    job_type: job.job_type,
    status: job.status,
    lifecycle_status: resolveGptJobLifecycleStatus(job.status),
    created_at: job.created_at,
    updated_at: job.updated_at,
    completed_at: job.completed_at ?? null,
    cancel_requested_at: job.cancel_requested_at ?? null,
    cancel_reason: job.cancel_reason ?? null,
    retention_until: job.retention_until ?? null,
    idempotency_until: job.idempotency_until ?? null,
    expires_at: job.expires_at ?? null,
    error_message: job.error_message ?? null,
    output: job.output ?? null,
    result: job.output ?? null
  };
}

function writeSseEvent(
  res: express.Response,
  event: string,
  payload: Record<string, unknown>
): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
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

    res.json(buildJobStatusPayload(job));
  })
);

router.post(
  '/jobs/:id/cancel',
  validateParams(jobIdSchema, { errorCode: 'JOB_ID_INVALID' }),
  asyncHandler(async (req, res) => {
    const { id } = req.validated!.params as z.infer<typeof jobIdSchema>;
    const reason =
      typeof req.body?.reason === 'string' && req.body.reason.trim().length > 0
        ? req.body.reason.trim()
        : 'Job cancellation requested by client.';

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
        job: cancellation.job ? buildJobStatusPayload(cancellation.job) : null
      });
      return;
    }

    const statusCode = cancellation.outcome === 'cancelled' ? 200 : 202;
    res.status(statusCode).json({
      ok: true,
      cancellationRequested: cancellation.outcome === 'cancellation_requested',
      ...buildJobStatusPayload(cancellation.job!)
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
    const handleClosedStream = () => {
      closed = true;
    };

    req.on('close', handleClosedStream);

    try {
      while (!closed) {
        const job = await getJobById(id);

        if (!job) {
          writeSseEvent(res, 'error', {
            code: 'JOB_NOT_FOUND',
            jobId: id
          });
          return;
        }

        const payload = buildJobStatusPayload(job);
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
