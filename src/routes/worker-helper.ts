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
import type { NextFunction, Request, Response } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import {
  asyncHandler,
  sendBadRequestPayload,
  sendInternalErrorPayload,
  sendNotFound,
  validateBody,
  validateParams,
  validateQuery
} from '@shared/http/index.js';
import { getWorkerRuntimeStatus } from '@platform/runtime/workerConfig.js';
import { parseWorkerHealRequest } from '@shared/http/workerHealRequest.js';
import { clientContextSchema } from '@shared/types/dto.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import {
  isRailwayPreviewEnvironment,
  previewAskChaosHookSchema
} from '@shared/ask/previewChaos.js';
import { recordSelfHealEvent } from '@services/selfImprove/selfHealTelemetry.js';
import {
  dispatchWorkerInput,
  getWorkerControlHealth,
  getLatestWorkerJobDetail,
  getWorkerControlStatus,
  getWorkerJobDetailById,
  healWorkerRuntime,
  listRecentFailedWorkerJobs,
  queueWorkerAsk
} from '@services/workerControlService.js';
import { getEnv } from '@platform/runtime/env.js';
import { resolveHeader } from '@transport/http/requestHeaders.js';

const router = express.Router();

const cognitiveDomainSchema = z.enum(['diagnostic', 'code', 'creative', 'natural', 'execution']);
const workerHelperTokenHeader = 'x-arcanos-worker-helper-token';
const allowedOperatorRoles = new Set(['admin', 'operator', 'owner']);

const workerHelperJobIdSchema = z.object({
  id: z.string().trim().min(1)
});

const workerHelperFailedJobsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional()
});

const queueAskRequestSchema = z.object({
  prompt: z.string().trim().min(1),
  sessionId: z.string().trim().min(1).max(100).optional(),
  overrideAuditSafe: z.string().trim().min(1).max(50).optional(),
  cognitiveDomain: cognitiveDomainSchema.optional(),
  clientContext: clientContextSchema.optional(),
  endpointName: z.string().trim().min(1).max(64).optional(),
  previewChaosHook: previewAskChaosHookSchema.optional()
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

function timingSafeEqualString(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function extractBearerToken(req: Request): string | null {
  const authHeader = resolveHeader(req.headers, 'authorization')?.trim();
  if (!authHeader) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  return match?.[1]?.trim() || null;
}

function hasTrustedWorkerHelperToken(req: Request): boolean {
  const configuredToken = getEnv('ARCANOS_WORKER_HELPER_TOKEN')?.trim();
  if (!configuredToken) {
    return false;
  }

  const providedToken =
    resolveHeader(req.headers, workerHelperTokenHeader)?.trim()
    ?? extractBearerToken(req);

  return Boolean(providedToken && timingSafeEqualString(providedToken, configuredToken));
}

function isOperatorLightRole(role: string | undefined): boolean {
  return role?.trim().toLowerCase() === 'operator-light';
}

function requireWorkerHelperPrivilegedAuth(req: Request, res: Response, next: NextFunction): void {
  const authUserRole = typeof req.authUser?.role === 'string' ? req.authUser.role.trim().toLowerCase() : undefined;

  if (isOperatorLightRole(authUserRole)) {
    res.status(403).json({
      error: 'WORKER_HELPER_OPERATOR_FORBIDDEN',
      message: 'Worker helper privileged routes require full operator privileges.'
    });
    return;
  }

  if (
    req.daemonToken
    || hasTrustedWorkerHelperToken(req)
    || (authUserRole && allowedOperatorRoles.has(authUserRole))
    || (typeof req.operatorActor === 'string' && req.operatorActor.trim().length > 0)
  ) {
    next();
    return;
  }

  res.status(401).json({
    error: 'WORKER_HELPER_AUTH_REQUIRED',
    message: 'Worker helper privileged routes require authenticated operator or trusted internal access.'
  });
}

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
  requireWorkerHelperPrivilegedAuth,
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
 * GET /worker-helper/jobs/failed
 *
 * Purpose:
 * - Return recently retained terminal failures so operators can inspect the failed queue backlog directly.
 *
 * Inputs/outputs:
 * - Input: optional `limit` query param.
 * - Output: JSON list of failed-job snapshots plus semantics describing the retained failure count.
 *
 * Edge case behavior:
 * - Returns an empty list when the queue has no retained failed rows.
 */
router.get(
  '/worker-helper/jobs/failed',
  validateQuery(workerHelperFailedJobsQuerySchema, { errorCode: 'FAILED_JOB_QUERY_INVALID' }),
  asyncHandler(async (req, res) => {
    try {
      const query = req.validated?.query as z.infer<typeof workerHelperFailedJobsQuerySchema> | undefined;
      const limit = query?.limit ?? 10;

      res.json({
        failedCountMode: 'retained_terminal_jobs',
        jobs: await listRecentFailedWorkerJobs(limit)
      });
    } catch (error: unknown) {
      sendInternalErrorPayload(res, {
        error: 'WORKER_HELPER_FAILED_JOBS_LOOKUP_FAILED',
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
  requireWorkerHelperPrivilegedAuth,
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
  requireWorkerHelperPrivilegedAuth,
  validateBody(queueAskRequestSchema),
  asyncHandler(async (req, res) => {
    try {
      const body = req.validated!.body as z.infer<typeof queueAskRequestSchema>;
      if (body.previewChaosHook && !isRailwayPreviewEnvironment()) {
        sendBadRequestPayload(res, {
          error: 'PREVIEW_CHAOS_HOOK_UNAVAILABLE',
          message: 'previewChaosHook is only allowed in Railway PR preview environments.'
        });
        return;
      }

      res.status(202).json(await queueWorkerAsk({
        prompt: body.prompt,
        sessionId: body.sessionId,
        overrideAuditSafe: body.overrideAuditSafe,
        cognitiveDomain: body.cognitiveDomain,
        clientContext: body.clientContext ?? null,
        endpointName: body.endpointName || 'worker-helper',
        previewChaosHook: body.previewChaosHook
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
  requireWorkerHelperPrivilegedAuth,
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
 * - Restart or plan a restart of the in-process worker runtime from an operator command.
 *
 * Inputs/outputs:
 * - Input: optional `force`, `execute`, `mode`, or `dryRun` flags via JSON body or query string.
 * - Output: restart summary plus the latest runtime snapshot, or a bounded noop plan response.
 *
 * Edge case behavior:
 * - Defaults to `force: true` so execute requests behave like an operator restart.
 */
router.post(
  '/worker-helper/heal',
  requireWorkerHelperPrivilegedAuth,
  asyncHandler(async (req, res) => {
    try {
      const healRequest = parseWorkerHealRequest(req.body, req.query);
      if (!healRequest.success) {
        sendBadRequestPayload(res, {
          error: 'INVALID_WORKER_HEAL_REQUEST',
          details: healRequest.issues
        });
        return;
      }

      if (healRequest.data.planOnlyRequested) {
        recordSelfHealEvent({
          kind: 'noop',
          source: 'worker-helper',
          trigger: 'manual',
          reason: 'worker runtime heal plan requested without execution',
          actionTaken: 'worker-helper/heal',
          healedComponent: 'worker_runtime',
          details: {
            requestedForce: healRequest.data.force ?? true
          }
        });

        res.json({
          timestamp: new Date().toISOString(),
          mode: 'plan',
          execution: null,
          requestedForce: healRequest.data.force ?? true,
          runtime: getWorkerRuntimeStatus()
        });
        return;
      }

      res.json(await healWorkerRuntime(healRequest.data.force, 'worker-helper'));
    } catch (error: unknown) {
      sendInternalErrorPayload(res, {
        error: 'WORKER_HELPER_HEAL_FAILED',
        message: resolveErrorMessage(error)
      });
    }
  })
);

export default router;
