/**
 * Worker helper routes.
 *
 * Purpose:
 * - Provide a lightweight operator surface for CLI and ChatGPT automation to inspect queue state
 *   and send worker commands without the interactive confirmation workflow or helper-token setup.
 *
 * Inputs/outputs:
 * - Input: HTTP requests under `/worker-helper/*`.
 * - Output: JSON responses for status, queue inspection, async job enqueueing, direct dispatch,
 *   and in-process worker healing.
 *
 * Edge case behavior:
 * - Dedicated Railway worker visibility is queue-observed only; there is no cross-process heartbeat here.
 */

import express from 'express';
import { z } from 'zod';
import { asyncHandler, sendInternalErrorPayload, sendNotFound, validateBody, validateParams } from '@shared/http/index.js';
import { clientContextSchema } from '@shared/types/dto.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import {
  dispatchWorkerInput,
  getWorkerControlHealth,
  getLatestWorkerJobDetail,
  getWorkerControlStatus,
  getWorkerJobDetailById,
  healWorkerRuntime,
  queueWorkerAsk
} from '@services/workerControlService.js';

const router = express.Router();

const cognitiveDomainSchema = z.enum(['diagnostic', 'code', 'creative', 'natural', 'execution']);

const workerHelperJobIdSchema = z.object({
  id: z.string().trim().min(1)
});

const queueAskRequestSchema = z.object({
  prompt: z.string().trim().min(1),
  sessionId: z.string().trim().min(1).max(100).optional(),
  overrideAuditSafe: z.string().trim().min(1).max(50).optional(),
  cognitiveDomain: cognitiveDomainSchema.optional(),
  clientContext: clientContextSchema.optional(),
  endpointName: z.string().trim().min(1).max(64).optional()
});

const dispatchRequestSchema = z.object({
  input: z.string().trim().min(1),
  sessionId: z.string().trim().min(1).max(100).optional(),
  overrideAuditSafe: z.string().trim().min(1).max(50).optional(),
  cognitiveDomain: cognitiveDomainSchema.optional(),
  attempts: z.number().int().min(1).max(10).optional(),
  backoffMs: z.number().int().min(0).max(60000).optional(),
  sourceEndpoint: z.string().trim().min(1).max(64).optional()
});

const healRequestSchema = z.object({
  force: z.boolean().optional()
});

/**
 * GET /worker-helper/status
 *
 * Purpose:
 * - Report main-app worker runtime state plus queue-observed dedicated worker activity.
 *
 * Inputs/outputs:
 * - Input: request path only.
 * - Output: combined main-app runtime and DB queue summary JSON.
 *
 * Edge case behavior:
 * - Queue summary and latest job become `null` when the database is unavailable.
 */
router.get(
  '/worker-helper/status',
  asyncHandler(async (_req, res) => {
    try {
      res.json(await getWorkerControlStatus());
    } catch (error: unknown) {
      sendInternalErrorPayload(res, {
        error: 'WORKER_HELPER_STATUS_FAILED',
        message: resolveErrorMessage(error)
      });
    }
  })
);

/**
 * GET /worker-helper/health
 *
 * Purpose:
 * - Return the persisted autonomy health report for queue-backed workers.
 *
 * Inputs/outputs:
 * - Input: request path only.
 * - Output: JSON health report with alerts, budgets, queue summary, and worker snapshots.
 *
 * Edge case behavior:
 * - Returns `offline` when no queue-worker snapshot has been persisted yet.
 */
router.get(
  '/worker-helper/health',
  asyncHandler(async (_req, res) => {
    try {
      res.json(await getWorkerControlHealth());
    } catch (error: unknown) {
      sendInternalErrorPayload(res, {
        error: 'WORKER_HELPER_HEALTH_FAILED',
        message: resolveErrorMessage(error)
      });
    }
  })
);

/**
 * GET /worker-helper/jobs/latest
 *
 * Purpose:
 * - Return the most recent queued job for operator inspection.
 *
 * Inputs/outputs:
 * - Input: request path only.
 * - Output: JSON snapshot of the latest job, including output when present.
 *
 * Edge case behavior:
 * - Returns `404` when no jobs have been created yet.
 */
router.get(
  '/worker-helper/jobs/latest',
  asyncHandler(async (_req, res) => {
    try {
      const latestJob = await getLatestWorkerJobDetail();

      //audit Assumption: latest job lookup should fail explicitly when the queue has no history; failure risk: ambiguous empty 200 response for operator tooling; expected invariant: missing latest job returns 404; handling strategy: use a not-found payload.
      if (!latestJob) {
        sendNotFound(res, 'JOB_NOT_FOUND');
        return;
      }

      res.json(latestJob);
    } catch (error: unknown) {
      sendInternalErrorPayload(res, {
        error: 'WORKER_HELPER_JOB_LOOKUP_FAILED',
        message: resolveErrorMessage(error)
      });
    }
  })
);

/**
 * GET /worker-helper/jobs/:id
 *
 * Purpose:
 * - Return one queued job by identifier.
 *
 * Inputs/outputs:
 * - Input: job identifier path param.
 * - Output: full queued job snapshot including output when present.
 *
 * Edge case behavior:
 * - Returns `404` when the identifier is unknown.
 */
router.get(
  '/worker-helper/jobs/:id',
  validateParams(workerHelperJobIdSchema, { errorCode: 'JOB_ID_INVALID' }),
  asyncHandler(async (req, res) => {
    try {
      const { id } = req.validated!.params as z.infer<typeof workerHelperJobIdSchema>;
      const job = await getWorkerJobDetailById(id);

      if (!job) {
        sendNotFound(res, 'JOB_NOT_FOUND');
        return;
      }

      res.json(job);
    } catch (error: unknown) {
      sendInternalErrorPayload(res, {
        error: 'WORKER_HELPER_JOB_LOOKUP_FAILED',
        message: resolveErrorMessage(error)
      });
    }
  })
);

/**
 * POST /worker-helper/queue/ask
 *
 * Purpose:
 * - Enqueue async `/ask` work for the dedicated DB-backed worker service.
 *
 * Inputs/outputs:
 * - Input: prompt plus optional session/context metadata.
 * - Output: standard pending job payload with the resolved cognitive domain.
 *
 * Edge case behavior:
 * - When no cognitive domain is provided, the helper falls back to heuristic detection only.
 */
router.post(
  '/worker-helper/queue/ask',
  validateBody(queueAskRequestSchema),
  asyncHandler(async (req, res) => {
    try {
      const body = req.validated!.body as z.infer<typeof queueAskRequestSchema>;
      res.status(202).json(await queueWorkerAsk({
        prompt: body.prompt,
        sessionId: body.sessionId,
        overrideAuditSafe: body.overrideAuditSafe,
        cognitiveDomain: body.cognitiveDomain,
        clientContext: body.clientContext ?? null,
        endpointName: body.endpointName || 'worker-helper'
      }));
    } catch (error: unknown) {
      sendInternalErrorPayload(res, {
        error: 'WORKER_HELPER_QUEUE_FAILED',
        message: resolveErrorMessage(error)
      });
    }
  })
);

/**
 * POST /worker-helper/dispatch
 *
 * Purpose:
 * - Dispatch a prompt directly through the main app's in-process worker runtime.
 *
 * Inputs/outputs:
 * - Input: text input plus optional retry settings.
 * - Output: dispatch metadata and worker results.
 *
 * Edge case behavior:
 * - Falls back to direct ARCANOS execution when in-process workers are disabled.
 */
router.post(
  '/worker-helper/dispatch',
  validateBody(dispatchRequestSchema),
  asyncHandler(async (req, res) => {
    try {
      const body = req.validated!.body as z.infer<typeof dispatchRequestSchema>;
      res.json(await dispatchWorkerInput(body));
    } catch (error: unknown) {
      sendInternalErrorPayload(res, {
        error: 'WORKER_HELPER_DISPATCH_FAILED',
        message: resolveErrorMessage(error)
      });
    }
  })
);

/**
 * POST /worker-helper/heal
 *
 * Purpose:
 * - Restart or bootstrap the in-process worker runtime from an operator command.
 *
 * Inputs/outputs:
 * - Input: optional `force` flag.
 * - Output: restart summary plus the latest runtime snapshot.
 *
 * Edge case behavior:
 * - Defaults to `force: true` so heal requests behave like an operator restart.
 */
router.post(
  '/worker-helper/heal',
  validateBody(healRequestSchema),
  asyncHandler(async (req, res) => {
    try {
      const body = req.validated!.body as z.infer<typeof healRequestSchema>;
      res.json(await healWorkerRuntime(body.force));
    } catch (error: unknown) {
      sendInternalErrorPayload(res, {
        error: 'WORKER_HELPER_HEAL_FAILED',
        message: resolveErrorMessage(error)
      });
    }
  })
);

export default router;
