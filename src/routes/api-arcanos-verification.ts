import express from 'express';
import { z } from 'zod';
import { generateRequestId } from '../shared/idGenerator.js';
import {
  asyncHandler,
  sendBadRequest,
  sendInternalErrorPayload,
  sendNotFound,
  validateBody,
  validateParams,
  validateQuery
} from '../shared/http/index.js';
import {
  createRateLimitMiddleware,
  getRequestActorKey
} from '@platform/runtime/security.js';
import type {
  ApiEnvelope,
  CancelDagRunResponseData,
  CapabilitiesData,
  CreateDagRunData,
  CreateDagRunRequest,
  DagLatestRunData,
  DagRunData,
  DagTraceData,
  HealthData,
  NodeDetailData,
  QueueStatusData,
  WorkersStatusData,
  WorkerStatus
} from '../shared/types/arcanos-verification-contract.types.js';
import { getWorkerControlStatus } from '../services/workerControlService.js';
import { arcanosDagRunService } from '../services/arcanosDagRunService.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';

const router = express.Router();
const API_VERSION = '1.0.0';
const DAG_RUN_LONG_POLL_MAX_MS = 30_000;

const dagRunParamsSchema = z.object({
  runId: z.string().trim().min(1)
});

const dagNodeParamsSchema = z.object({
  runId: z.string().trim().min(1),
  nodeId: z.string().trim().min(1)
});

const dagRunRequestSchema = z.object({
  sessionId: z.string().trim().min(1),
  template: z.string().trim().min(1),
  input: z.record(z.unknown()),
  options: z.object({
    maxConcurrency: z.number().int().positive().optional(),
    allowRecursiveSpawning: z.boolean().optional(),
    debug: z.boolean().optional()
  }).optional()
});

const dagRunWaitQuerySchema = z.object({
  updatedAfter: z.string().datetime().optional(),
  waitForUpdateMs: z.coerce.number().int().min(0).max(DAG_RUN_LONG_POLL_MAX_MS).optional()
});

const dagLatestRunQuerySchema = z.object({
  sessionId: z.string().trim().min(1).optional()
});

const dagTraceQuerySchema = z.object({
  maxEvents: z.coerce.number().int().min(1).max(1000).optional()
});

function buildDagRateLimitKey(req: express.Request, scope: string): string {
  //audit Assumption: run-scoped buckets prevent one active DAG monitor from throttling unrelated runs; failure risk: missing run ids collapse traffic into a shared bucket; expected invariant: every request maps to a stable scope key; handling strategy: fall back to `global` when no run id is available.
  const runId = typeof req.params.runId === 'string' && req.params.runId.trim().length > 0
    ? req.params.runId.trim()
    : 'global';
  return `${getRequestActorKey(req)}:scope:${scope}:run:${runId}`;
}

const verificationControlRateLimit = createRateLimitMiddleware({
  bucketName: 'api-arcanos-control',
  maxRequests: 240,
  windowMs: 15 * 60 * 1000,
  keyGenerator: (req) => `${getRequestActorKey(req)}:scope:control`
});

const dagRunWriteRateLimit = createRateLimitMiddleware({
  bucketName: 'api-arcanos-dag-write',
  maxRequests: 60,
  windowMs: 15 * 60 * 1000,
  keyGenerator: (req) => `${getRequestActorKey(req)}:scope:dag-write`
});

const dagRunStatusRateLimit = createRateLimitMiddleware({
  bucketName: 'api-arcanos-dag-status',
  maxRequests: 900,
  windowMs: 15 * 60 * 1000,
  keyGenerator: (req) => buildDagRateLimitKey(req, 'status')
});

const dagRunInspectRateLimit = createRateLimitMiddleware({
  bucketName: 'api-arcanos-dag-inspect',
  maxRequests: 480,
  windowMs: 15 * 60 * 1000,
  keyGenerator: (req) => buildDagRateLimitKey(req, 'inspect')
});

function createEnvelope<T>(
  requestId: string,
  data: T
): ApiEnvelope<T> {
  return {
    ok: true,
    timestamp: new Date().toISOString(),
    version: API_VERSION,
    requestId,
    data
  };
}

function getRequestId(req: express.Request): string {
  return req.requestId ?? generateRequestId('api-arcanos');
}

function setDagRunPollingHeaders(
  res: express.Response,
  options: {
    waitApplied: boolean;
    updated: boolean;
  }
): void {
  res.set({
    'X-Arcanos-Recommended-Poll-Interval-Ms': '5000',
    'X-Arcanos-Long-Poll-Max-Ms': DAG_RUN_LONG_POLL_MAX_MS.toString(),
    'X-Arcanos-Run-Wait-Applied': options.waitApplied ? 'true' : 'false',
    'X-Arcanos-Run-Updated': options.updated ? 'true' : 'false'
  });
}

function mapWorkerHealthStatus(input: {
  connected?: boolean;
  enabled?: boolean;
  started?: boolean;
  queueRunning?: number;
  queueFailed?: number;
}): WorkerStatus {
  //audit Assumption: disconnected worker backends should surface as offline to external callers; failure risk: clients assume work can be dispatched to an unavailable subsystem; expected invariant: disconnected state maps to `offline`; handling strategy: branch on connectivity first.
  if (input.connected === false) {
    return 'offline';
  }

  if (input.enabled === false) {
    return 'offline';
  }

  if (input.queueFailed && input.queueFailed > 0) {
    return 'degraded';
  }

  if (input.started === false && input.enabled) {
    return 'degraded';
  }

  if (input.queueRunning && input.queueRunning > 0) {
    return 'healthy';
  }

  return 'healthy';
}

router.get(
  '/health',
  verificationControlRateLimit,
  asyncHandler(async (req, res) => {
    const requestId = getRequestId(req);
    const data: HealthData = {
      service: 'arcanos-verification-api',
      status: 'healthy'
    };

    res.json(createEnvelope(requestId, data));
  })
);

router.get(
  '/capabilities',
  verificationControlRateLimit,
  asyncHandler(async (req, res) => {
    const requestId = getRequestId(req);
    const data: CapabilitiesData = {
      features: arcanosDagRunService.getFeatureFlags(),
      limits: arcanosDagRunService.getExecutionLimits()
    };

    res.json(createEnvelope(requestId, data));
  })
);

router.get(
  '/workers/status',
  verificationControlRateLimit,
  asyncHandler(async (req, res) => {
    const requestId = getRequestId(req);
    const workerStatus = await getWorkerControlStatus();
    const queueSummary = workerStatus.workerService.queueSummary;
    const now = new Date().toISOString();
    const asyncQueueSnapshot = workerStatus.workerService.health.workers[0];
    const data: WorkersStatusData = {
      workers: [
        {
          workerId: workerStatus.mainApp.workerId,
          type: 'in_process',
          status: mapWorkerHealthStatus({
            enabled: workerStatus.mainApp.runtime.enabled,
            started: workerStatus.mainApp.runtime.started
          }),
          activeJobs: 0,
          lastHeartbeatAt: workerStatus.mainApp.runtime.lastDispatchAt || workerStatus.mainApp.runtime.startedAt || now
        },
        {
          workerId: asyncQueueSnapshot?.workerId || 'async-queue',
          type: 'async_queue',
          status: workerStatus.workerService.database.connected
            ? workerStatus.workerService.health.overallStatus === 'unhealthy'
              ? 'unhealthy'
              : workerStatus.workerService.health.overallStatus === 'degraded'
                ? 'degraded'
                : workerStatus.workerService.health.overallStatus === 'offline'
                  ? 'offline'
                  : 'healthy'
            : 'offline',
          activeJobs: queueSummary?.running ?? 0,
          lastHeartbeatAt: asyncQueueSnapshot?.lastHeartbeatAt || queueSummary?.lastUpdatedAt || now
        }
      ]
    };

    res.json(createEnvelope(requestId, data));
  })
);

router.get(
  '/workers/queue',
  verificationControlRateLimit,
  asyncHandler(async (req, res) => {
    const requestId = getRequestId(req);
    const workerStatus = await getWorkerControlStatus();
    const queueSummary = workerStatus.workerService.queueSummary;
    const data: QueueStatusData = {
      queue: {
        name: 'job_data',
        depth: (queueSummary?.pending ?? 0) + (queueSummary?.running ?? 0),
        running: queueSummary?.running ?? 0,
        waiting: queueSummary?.pending ?? 0,
        failed: queueSummary?.failed ?? 0,
        delayed: queueSummary?.delayed ?? 0,
        oldestWaitingJobAgeMs: queueSummary?.oldestPendingJobAgeMs ?? 0,
        stalledJobs: queueSummary?.stalledRunning ?? 0
      }
    };

    res.json(createEnvelope(requestId, data));
  })
);

router.post(
  '/dag/runs',
  dagRunWriteRateLimit,
  validateBody(dagRunRequestSchema),
  asyncHandler(async (req, res) => {
    try {
      const requestId = getRequestId(req);
      const body = req.validated!.body as CreateDagRunRequest;
      const run = await arcanosDagRunService.createRun(body);
      const data: CreateDagRunData = { run };

      res.status(202).json(createEnvelope(requestId, data));
    } catch (error: unknown) {
      const errorMessage = resolveErrorMessage(error);

      //audit Assumption: unsupported templates and invalid DAG requests are caller errors; failure risk: contract consumers receive opaque 500s for invalid input; expected invariant: template validation failures map to `400`; handling strategy: branch on known validation text.
      if (errorMessage.includes('Unsupported DAG template')) {
        sendBadRequest(res, 'DAG_TEMPLATE_UNSUPPORTED');
        return;
      }

      sendInternalErrorPayload(res, {
        error: 'DAG_RUN_CREATE_FAILED',
        message: errorMessage
      });
    }
  })
);

router.get(
  '/dag/runs/latest',
  dagRunStatusRateLimit,
  validateQuery(dagLatestRunQuerySchema, { errorCode: 'RUN_LATEST_QUERY_INVALID', includeDetails: true }),
  asyncHandler(async (req, res) => {
    const requestId = getRequestId(req);
    const { sessionId } = req.validated!.query as z.infer<typeof dagLatestRunQuerySchema>;
    const run = await arcanosDagRunService.getLatestRun(sessionId);

    if (!run) {
      sendNotFound(res, 'RUN_NOT_FOUND');
      return;
    }

    const data: DagLatestRunData = { run };
    res.json(createEnvelope(requestId, data));
  })
);

router.get(
  '/dag/runs/:runId',
  dagRunStatusRateLimit,
  validateParams(dagRunParamsSchema, { errorCode: 'RUN_ID_INVALID' }),
  validateQuery(dagRunWaitQuerySchema, { errorCode: 'RUN_STATUS_QUERY_INVALID', includeDetails: true }),
  asyncHandler(async (req, res) => {
    const requestId = getRequestId(req);
    const { runId } = req.validated!.params as z.infer<typeof dagRunParamsSchema>;
    const { updatedAfter, waitForUpdateMs } = req.validated!.query as z.infer<typeof dagRunWaitQuerySchema>;
    const waitedRun = await arcanosDagRunService.waitForRunUpdate(runId, {
      updatedAfter,
      waitForUpdateMs
    });

    //audit Assumption: unknown runs should fail fast even when long-poll is requested; failure risk: callers wait on a run that does not exist; expected invariant: missing runs return 404; handling strategy: branch on null service result.
    if (!waitedRun) {
      sendNotFound(res, 'RUN_NOT_FOUND');
      return;
    }

    setDagRunPollingHeaders(res, {
      waitApplied: Boolean(updatedAfter && (waitForUpdateMs ?? 0) > 0),
      updated: waitedRun.updated
    });

    const data: DagRunData = { run: waitedRun.run };
    res.json(createEnvelope(requestId, data));
  })
);

router.get(
  '/dag/runs/:runId/trace',
  dagRunInspectRateLimit,
  validateParams(dagRunParamsSchema, { errorCode: 'RUN_ID_INVALID' }),
  validateQuery(dagTraceQuerySchema, { errorCode: 'RUN_TRACE_QUERY_INVALID', includeDetails: true }),
  asyncHandler(async (req, res) => {
    const requestId = getRequestId(req);
    const { runId } = req.validated!.params as z.infer<typeof dagRunParamsSchema>;
    const { maxEvents } = req.validated!.query as z.infer<typeof dagTraceQuerySchema>;
    const trace = await arcanosDagRunService.getRunTrace(runId, { maxEvents });

    if (!trace) {
      sendNotFound(res, 'RUN_NOT_FOUND');
      return;
    }

    const data: DagTraceData = trace;
    res.json(createEnvelope(requestId, data));
  })
);

router.get(
  '/dag/runs/:runId/tree',
  dagRunInspectRateLimit,
  validateParams(dagRunParamsSchema, { errorCode: 'RUN_ID_INVALID' }),
  asyncHandler(async (req, res) => {
    const requestId = getRequestId(req);
    const { runId } = req.validated!.params as z.infer<typeof dagRunParamsSchema>;
    const tree = await arcanosDagRunService.getRunTree(runId);

    if (!tree) {
      sendNotFound(res, 'RUN_NOT_FOUND');
      return;
    }

    res.json(createEnvelope(requestId, tree));
  })
);

router.get(
  '/dag/runs/:runId/nodes/:nodeId',
  dagRunInspectRateLimit,
  validateParams(dagNodeParamsSchema, { errorCode: 'RUN_NODE_ID_INVALID' }),
  asyncHandler(async (req, res) => {
    const requestId = getRequestId(req);
    const { runId, nodeId } = req.validated!.params as z.infer<typeof dagNodeParamsSchema>;
    const node = await arcanosDagRunService.getNode(runId, nodeId);

    if (!node) {
      sendNotFound(res, 'NODE_NOT_FOUND');
      return;
    }

    const data: NodeDetailData = { node };
    res.json(createEnvelope(requestId, data));
  })
);

router.get(
  '/dag/runs/:runId/events',
  dagRunInspectRateLimit,
  validateParams(dagRunParamsSchema, { errorCode: 'RUN_ID_INVALID' }),
  asyncHandler(async (req, res) => {
    const requestId = getRequestId(req);
    const { runId } = req.validated!.params as z.infer<typeof dagRunParamsSchema>;
    const events = await arcanosDagRunService.getRunEvents(runId);

    if (!events) {
      sendNotFound(res, 'RUN_NOT_FOUND');
      return;
    }

    res.json(createEnvelope(requestId, events));
  })
);

router.get(
  '/dag/runs/:runId/metrics',
  dagRunInspectRateLimit,
  validateParams(dagRunParamsSchema, { errorCode: 'RUN_ID_INVALID' }),
  asyncHandler(async (req, res) => {
    const requestId = getRequestId(req);
    const { runId } = req.validated!.params as z.infer<typeof dagRunParamsSchema>;
    const metrics = await arcanosDagRunService.getRunMetrics(runId);

    if (!metrics) {
      sendNotFound(res, 'RUN_NOT_FOUND');
      return;
    }

    res.json(createEnvelope(requestId, metrics));
  })
);

router.get(
  '/dag/runs/:runId/errors',
  dagRunInspectRateLimit,
  validateParams(dagRunParamsSchema, { errorCode: 'RUN_ID_INVALID' }),
  asyncHandler(async (req, res) => {
    const requestId = getRequestId(req);
    const { runId } = req.validated!.params as z.infer<typeof dagRunParamsSchema>;
    const errors = await arcanosDagRunService.getRunErrors(runId);

    if (!errors) {
      sendNotFound(res, 'RUN_NOT_FOUND');
      return;
    }

    res.json(createEnvelope(requestId, errors));
  })
);

router.get(
  '/dag/runs/:runId/lineage',
  dagRunInspectRateLimit,
  validateParams(dagRunParamsSchema, { errorCode: 'RUN_ID_INVALID' }),
  asyncHandler(async (req, res) => {
    const requestId = getRequestId(req);
    const { runId } = req.validated!.params as z.infer<typeof dagRunParamsSchema>;
    const lineage = await arcanosDagRunService.getRunLineage(runId);

    if (!lineage) {
      sendNotFound(res, 'RUN_NOT_FOUND');
      return;
    }

    res.json(createEnvelope(requestId, lineage));
  })
);

router.post(
  '/dag/runs/:runId/cancel',
  dagRunWriteRateLimit,
  validateParams(dagRunParamsSchema, { errorCode: 'RUN_ID_INVALID' }),
  asyncHandler(async (req, res) => {
    const requestId = getRequestId(req);
    const { runId } = req.validated!.params as z.infer<typeof dagRunParamsSchema>;
    const cancelled = arcanosDagRunService.cancelRun(runId);

    if (!cancelled) {
      sendNotFound(res, 'RUN_NOT_FOUND');
      return;
    }

    const data: CancelDagRunResponseData = cancelled;
    res.json(createEnvelope(requestId, data));
  })
);

router.get(
  '/dag/runs/:runId/verification',
  dagRunInspectRateLimit,
  validateParams(dagRunParamsSchema, { errorCode: 'RUN_ID_INVALID' }),
  asyncHandler(async (req, res) => {
    const requestId = getRequestId(req);
    const { runId } = req.validated!.params as z.infer<typeof dagRunParamsSchema>;
    const verification = await arcanosDagRunService.getRunVerification(runId);

    if (!verification) {
      sendNotFound(res, 'RUN_NOT_FOUND');
      return;
    }

    res.json(createEnvelope(requestId, verification));
  })
);

export default router;
