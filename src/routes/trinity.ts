import express, { NextFunction, Request, Response } from 'express';
import {
  asyncHandler,
  noStoreResponse,
  sendInternalErrorPayload
} from '@shared/http/index.js';
import { getTrinityStatus } from '@services/trinityStatusService.js';
import {
  projectPublicWorkerHealth,
  type PublicWorkerHealthProjection
} from '@shared/http/workerHealthProjection.js';

const router = express.Router();

/**
 * GET /trinity/status - Expose aggregate Trinity worker health.
 *
 * Purpose:
 * - Give anonymous probes normalized worker, queue, and memory states without internal bindings or job locators.
 *
 * Inputs/outputs:
 * - Input: none.
 * - Output: `PublicWorkerHealthProjection`.
 *
 * Edge case behavior:
 * - Returns `503` only when the Trinity pipeline is effectively offline; degraded states still return `200` with explicit status detail.
 */
router.get(
  '/trinity/status',
  noStoreResponse,
  asyncHandler(async (_req: Request, res: Response<PublicWorkerHealthProjection>) => {
    const payload = await getTrinityStatus();
    const statusCode = payload.status === 'offline' ? 503 : 200;
    const totalJobs = payload.queue.pendingJobs
      + payload.queue.runningJobs
      + payload.queue.completedJobs
      + payload.queue.retainedFailedJobs;

    res.status(statusCode).json(projectPublicWorkerHealth({
      timestamp: payload.timestamp,
      status: payload.status,
      runtime: {
        status: payload.workersConnected
          ? 'active'
          : payload.status === 'offline'
            ? 'offline'
            : 'pending',
        lastDispatchAt: payload.lastDispatch
      },
      workers: {
        status: payload.workerHealth.overallStatus,
        observed: payload.workerHealth.observedWorkerIds.length,
        lastHeartbeatAt: payload.lastWorkerHeartbeat
      },
      queue: {
        total: totalJobs,
        pending: payload.queue.pendingJobs,
        running: payload.queue.runningJobs,
        completed: payload.queue.completedJobs,
        retainedFailed: payload.queue.retainedFailedJobs,
        delayed: payload.queue.delayedJobs,
        stalledRunning: payload.queue.stalledRunningJobs,
        lastUpdatedAt: payload.queue.lastUpdatedAt
      },
      memory: {
        status: payload.memorySync.status,
        routes: payload.memorySync.routeCount,
        lastUpdatedAt: payload.memorySync.lastUpdatedAt
      }
    }));
  })
);

router.use((
  _error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
) => {
  req.logger?.error?.('trinity.status.failed', {
    requestId: req.requestId
  });
  //audit Assumption: public Trinity failures need a stable JSON envelope without arbitrary dependency text; failure risk: exception messages disclose runtime configuration or diagnostics; expected invariant: failures remain no-store and use fixed client-visible text; handling strategy: log stable correlation metadata and return a closed message.
  sendInternalErrorPayload(res, {
    error: 'TRINITY_STATUS_FAILED',
    message: 'Trinity status request failed.'
  });
});

export default router;
