/**
 * Worker helper routes.
 *
 * Purpose:
 * - Provide a lightweight operator surface for CLI and ChatGPT automation to inspect queue state
 *   and send authenticated worker commands without duplicating the main execution workflow.
 *
 * Inputs/outputs:
 * - Input: HTTP requests under `/worker-helper/*`.
 * - Output: JSON responses for status, queue inspection, async job enqueueing, direct dispatch,
 *   and in-process worker healing.
 *
 * Edge case behavior:
 * - Dedicated Railway worker visibility is queue-observed only; there is no cross-process heartbeat here.
 */

import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import {
  asyncHandler,
  sendBadRequestPayload,
  sendInternalErrorPayload,
  sendNotFound,
  noStoreResponse,
  validateBody,
  validateParams,
  validateQuery
} from '@shared/http/index.js';
import {
  projectPublicWorkerHealth,
  selectLatestPublicWorkerTimestamp
} from '@shared/http/workerHealthProjection.js';
import { getWorkerRuntimeStatus } from '@platform/runtime/workerConfig.js';
import { parseWorkerHealRequest } from '@shared/http/workerHealRequest.js';
import { clientContextSchema } from '@shared/types/dto.js';
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
  queueWorkerAsk,
  type WorkerControlHealthResponse,
  type WorkerControlStatusResponse,
  type WorkerControlWorkerSnapshot
} from '@services/workerControlService.js';
import { requireWorkerHelperPrivilegedAuth } from '@transport/http/middleware/workerHelperPrivilegedAuth.js';
import { workerHealMutationRateLimit } from '@transport/http/middleware/workerHealRateLimit.js';
import {
  JOB_READ_AUTH_UNAVAILABLE_CODE,
  JOB_READ_AUTH_UNAVAILABLE_MESSAGE,
  resolveConfiguredJobReadCapabilitySecret,
} from '@shared/jobs/jobReadCapability.js';

const router = express.Router();

const cognitiveDomainSchema = z.enum(['diagnostic', 'code', 'creative', 'natural', 'execution']);
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

type WorkerControlQueueSummary =
  WorkerControlStatusResponse['workerService']['queueSummary'];
type WorkerControlRuntime = WorkerControlStatusResponse['mainApp']['runtime'];

function countWorkersMatching(
  workers: WorkerControlWorkerSnapshot[],
  predicate: (worker: WorkerControlWorkerSnapshot) => boolean
): number {
  return workers.reduce(
    (count, worker) => count + (predicate(worker) ? 1 : 0),
    0
  );
}

function projectWorkerControlPublicHealth(input: {
  timestamp: string;
  overallStatus: WorkerControlHealthResponse['overallStatus'];
  queueSummary: WorkerControlQueueSummary;
  workers: WorkerControlWorkerSnapshot[];
  runtime?: WorkerControlRuntime;
}) {
  const { runtime, workers } = input;
  const runtimeStatus = runtime
    ? runtime.started
      ? 'active'
      : runtime.enabled
        ? 'pending'
        : 'disabled'
    : 'unknown';

  return projectPublicWorkerHealth({
    timestamp: input.timestamp,
    status: input.overallStatus,
    runtime: {
      status: runtimeStatus,
      totalDispatched: runtime?.totalDispatched,
      startedAt: runtime?.startedAt,
      lastDispatchAt: runtime?.lastDispatchAt
    },
    workers: {
      status: input.overallStatus,
      configured: runtime?.configuredCount,
      active: runtime
        ? runtime.workerIds.length
        : countWorkersMatching(
          workers,
          worker =>
            worker.dispatcherStarted
            && worker.activeListeners > 0
            && worker.operationalStatus !== 'offline'
        ),
      observed: workers.length,
      stale: countWorkersMatching(workers, worker => worker.stale),
      degraded: countWorkersMatching(
        workers,
        worker => worker.healthStatus === 'degraded' || worker.operationalStatus === 'degraded'
      ),
      unhealthy: countWorkersMatching(
        workers,
        worker => worker.healthStatus === 'unhealthy' || worker.operationalStatus === 'unhealthy'
      ),
      lastHeartbeatAt: selectLatestPublicWorkerTimestamp(
        ...workers.map(worker => worker.lastHeartbeatAt)
      )
    },
    queue: {
      total: input.queueSummary?.total,
      pending: input.queueSummary?.pending,
      running: input.queueSummary?.running,
      completed: input.queueSummary?.completed,
      retainedFailed: input.queueSummary?.failed,
      delayed: input.queueSummary?.delayed,
      stalledRunning: input.queueSummary?.stalledRunning,
      lastUpdatedAt: input.queueSummary?.lastUpdatedAt
    }
  });
}

function sendWorkerHelperFailure(
  req: Request,
  res: Response,
  event: string,
  error: string,
  message: string
): void {
  req.logger?.error?.(event, {
    requestId: req.requestId,
  });
  sendInternalErrorPayload(res, {
    error,
    message
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
 * - Output: aggregate worker health, normalized states, counts, and timestamps.
 *
 * Edge case behavior:
 * - Unavailable aggregate values become `null`; internal diagnostics are never serialized.
 */
router.get(
  '/worker-helper/status',
  noStoreResponse,
  asyncHandler(async (req, res) => {
    try {
      const status = await getWorkerControlStatus();
      res.json(projectWorkerControlPublicHealth({
        timestamp: status.timestamp,
        overallStatus: status.workerService.health.overallStatus,
        queueSummary: status.workerService.queueSummary,
        workers: status.workerService.health.workers,
        runtime: status.mainApp.runtime
      }));
    } catch {
      sendWorkerHelperFailure(
        req,
        res,
        'worker_helper.status.failed',
        'WORKER_HELPER_STATUS_FAILED',
        'Worker helper status request failed.'
      );
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
 * - Output: aggregate worker health, normalized states, counts, and timestamps.
 *
 * Edge case behavior:
 * - Returns `offline` when no queue-worker snapshot has been persisted yet; raw alerts stay private.
 */
router.get(
  '/worker-helper/health',
  noStoreResponse,
  asyncHandler(async (req, res) => {
    try {
      const health = await getWorkerControlHealth();
      res.json(projectWorkerControlPublicHealth({
        timestamp: health.timestamp,
        overallStatus: health.overallStatus,
        queueSummary: health.queueSummary,
        workers: health.workers
      }));
    } catch {
      sendWorkerHelperFailure(
        req,
        res,
        'worker_helper.health.failed',
        'WORKER_HELPER_HEALTH_FAILED',
        'Worker helper health request failed.'
      );
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
  asyncHandler(async (req, res) => {
    try {
      const latestJob = await getLatestWorkerJobDetail();

      //audit Assumption: latest job lookup should fail explicitly when the queue has no history; failure risk: ambiguous empty 200 response for operator tooling; expected invariant: missing latest job returns 404; handling strategy: use a not-found payload.
      if (!latestJob) {
        sendNotFound(res, 'JOB_NOT_FOUND');
        return;
      }

      res.json(latestJob);
    } catch {
      sendWorkerHelperFailure(
        req,
        res,
        'worker_helper.job_lookup.failed',
        'WORKER_HELPER_JOB_LOOKUP_FAILED',
        'Worker job lookup failed.'
      );
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
  noStoreResponse,
  requireWorkerHelperPrivilegedAuth,
  validateQuery(workerHelperFailedJobsQuerySchema, { errorCode: 'FAILED_JOB_QUERY_INVALID' }),
  asyncHandler(async (req, res) => {
    try {
      const query = req.validated?.query as z.infer<typeof workerHelperFailedJobsQuerySchema> | undefined;
      const limit = query?.limit ?? 10;

      res.json({
        failedCountMode: 'retained_terminal_jobs',
        jobs: await listRecentFailedWorkerJobs(limit)
      });
    } catch {
      sendWorkerHelperFailure(
        req,
        res,
        'worker_helper.failed_jobs_lookup.failed',
        'WORKER_HELPER_FAILED_JOBS_LOOKUP_FAILED',
        'Worker failed-job lookup failed.'
      );
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
    } catch {
      sendWorkerHelperFailure(
        req,
        res,
        'worker_helper.job_lookup.failed',
        'WORKER_HELPER_JOB_LOOKUP_FAILED',
        'Worker job lookup failed.'
      );
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
  noStoreResponse,
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
      if (!resolveConfiguredJobReadCapabilitySecret()) {
        res.status(503).json({
          error: JOB_READ_AUTH_UNAVAILABLE_CODE,
          message: JOB_READ_AUTH_UNAVAILABLE_MESSAGE,
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
    } catch {
      sendWorkerHelperFailure(
        req,
        res,
        'worker_helper.queue.failed',
        'WORKER_HELPER_QUEUE_FAILED',
        'Worker queue request failed.'
      );
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
    } catch {
      sendWorkerHelperFailure(
        req,
        res,
        'worker_helper.dispatch.failed',
        'WORKER_HELPER_DISPATCH_FAILED',
        'Worker dispatch request failed.'
      );
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
  workerHealMutationRateLimit,
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
    } catch {
      sendWorkerHelperFailure(
        req,
        res,
        'worker_helper.heal.failed',
        'WORKER_HELPER_HEAL_FAILED',
        'Worker heal request failed.'
      );
    }
  })
);

export default router;
