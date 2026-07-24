import express from 'express';

import {
  claimLocalAgentJob,
  getLocalAgentJobForDevice,
  heartbeatLocalAgentJob,
  LocalAgentJobRepositoryError,
  readLocalAgentJobEnvelope,
  submitLocalAgentJobResult
} from '@core/db/repositories/localAgentJobRepository.js';
import {
  localAgentExecutorAuthenticationMiddleware,
  requireLocalAgentExecutorScopes
} from '@services/actionPlanExecution/auth.js';
import {
  LocalAgentDevicePolicyError,
  resolveAuthorizedLocalAgentDevice
} from '@services/localAgent/devicePolicy.js';
import {
  buildLocalAgentClaimPayload,
  buildLocalAgentResultReceipt,
  fingerprintLocalAgentResult,
  hashLocalAgentClaimKey,
  hashLocalAgentResultKey,
  localAgentClaimInputSchema,
  localAgentJobParamsSchema,
  localAgentResultInputSchema
} from '@services/localAgent/protocol.js';
import { updateHeartbeat } from '@stores/agentRegistry.js';
import {
  LOCAL_AGENT_ACTIONS,
  LocalAgentContractValidationError,
  validateLocalAgentActionOutput,
  type LocalAgentAction
} from '@services/localAgent/contracts.js';

const router = express.Router();

function resolveLeaseMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.ARCANOS_LOCAL_AGENT_LEASE_MS);
  if (!Number.isFinite(configured)) {
    return 30_000;
  }
  return Math.min(60_000, Math.max(10_000, Math.trunc(configured)));
}

function sendNoStore(res: express.Response): void {
  res.setHeader('Cache-Control', 'no-store');
}

function isEmptyJsonBody(value: unknown): boolean {
  return value === undefined || (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === 0
  );
}

function sendProtocolError(
  req: express.Request,
  res: express.Response,
  error: unknown
): void {
  sendNoStore(res);

  if (error instanceof LocalAgentDevicePolicyError) {
    const statusCode = error.code === 'LOCAL_AGENT_DEVICE_NOT_CONFIGURED'
      || error.code === 'LOCAL_AGENT_DEVICE_OFFLINE'
      ? 503
      : 403;
    res.status(statusCode).json({
      ok: false,
      error: { code: error.code, message: error.message },
      ...(req.requestId ? { requestId: req.requestId } : {}),
      ...(req.traceId ? { traceId: req.traceId } : {})
    });
    return;
  }
  if (error instanceof LocalAgentJobRepositoryError) {
    const statusCode = error.code === 'LOCAL_AGENT_JOBS_UNAVAILABLE'
      ? 503
      : error.code === 'LOCAL_AGENT_JOB_NOT_FOUND'
        ? 404
        : 409;
    res.status(statusCode).json({
      ok: false,
      error: { code: error.code, message: error.message },
      ...(req.requestId ? { requestId: req.requestId } : {}),
      ...(req.traceId ? { traceId: req.traceId } : {})
    });
    return;
  }

  req.logger?.error?.('local_agent.protocol.failed', {
    errorType: error instanceof Error ? error.name : 'unknown',
    requestId: req.requestId ?? null,
    traceId: req.traceId ?? null
  });
  res.status(500).json({
    ok: false,
    error: {
      code: 'LOCAL_AGENT_PROTOCOL_ERROR',
      message: 'The local-agent protocol operation failed.'
    },
    ...(req.requestId ? { requestId: req.requestId } : {}),
    ...(req.traceId ? { traceId: req.traceId } : {})
  });
}

router.use((_req, res, next) => {
  sendNoStore(res);
  next();
});
router.use(localAgentExecutorAuthenticationMiddleware);

router.post(
  '/heartbeat',
  requireLocalAgentExecutorScopes('local-agent.heartbeat'),
  async (req, res) => {
  try {
    if (!isEmptyJsonBody(req.body)) {
      res.status(400).json({
        ok: false,
        error: {
          code: 'LOCAL_AGENT_REQUEST_INVALID',
          message: 'Heartbeat body must be an empty JSON object.'
        }
      });
      return;
    }
    const device = await resolveAuthorizedLocalAgentDevice([], {
      principal: req.localAgentExecutorPrincipal,
      requireFreshHeartbeat: false
    });
    const record = await updateHeartbeat(device.agentId);
    if (!record) {
      throw new LocalAgentDevicePolicyError(
        'LOCAL_AGENT_DEVICE_NOT_REGISTERED',
        'The registered local-agent device heartbeat could not be persisted.'
      );
    }
    res.json({
      ok: true,
      code: 'LOCAL_AGENT_HEARTBEAT_ACCEPTED',
      deviceId: device.deviceId,
      status: record.status,
      lastHeartbeatAt: record.lastHeartbeat?.toISOString() ?? null
    });
  } catch (error) {
    sendProtocolError(req, res, error);
  }
});

router.post(
  '/jobs/claim',
  requireLocalAgentExecutorScopes('local-agent.jobs.claim'),
  async (req, res) => {
  const parsed = localAgentClaimInputSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      error: {
        code: 'LOCAL_AGENT_REQUEST_INVALID',
        message: 'Claim request must include one bounded claimKey.'
      }
    });
    return;
  }

  try {
    const device = await resolveAuthorizedLocalAgentDevice([], {
      principal: req.localAgentExecutorPrincipal
    });
    const claim = await claimLocalAgentJob({
      deviceId: device.deviceId,
      claimKeyHash: hashLocalAgentClaimKey(parsed.data.claimKey),
      leaseMs: resolveLeaseMs(),
      deviceScopes: device.capabilities
    });
    if (!claim) {
      res.status(204).end();
      return;
    }
    res.json(buildLocalAgentClaimPayload(claim));
  } catch (error) {
    sendProtocolError(req, res, error);
  }
});

router.post(
  '/jobs/:jobId/heartbeat',
  requireLocalAgentExecutorScopes('local-agent.jobs.heartbeat'),
  async (req, res) => {
  const params = localAgentJobParamsSchema.safeParse(req.params);
  if (!params.success || !isEmptyJsonBody(req.body)) {
    res.status(400).json({
      ok: false,
      error: {
        code: 'LOCAL_AGENT_REQUEST_INVALID',
        message: 'Job heartbeat requires a valid job id and an empty JSON body.'
      }
    });
    return;
  }

  try {
    const device = await resolveAuthorizedLocalAgentDevice([], {
      principal: req.localAgentExecutorPrincipal
    });
    const job = await heartbeatLocalAgentJob({
      jobId: params.data.jobId,
      deviceId: device.deviceId,
      leaseMs: resolveLeaseMs()
    });
    if (!job) {
      res.status(409).json({
        ok: false,
        error: {
          code: 'LOCAL_AGENT_JOB_LEASE_UNAVAILABLE',
          message: 'The job is not actively leased to this device.'
        }
      });
      return;
    }
    res.json({
      ok: true,
      code: 'LOCAL_AGENT_JOB_HEARTBEAT_ACCEPTED',
      jobId: job.id,
      state: job.status.toUpperCase(),
      leaseExpiresAt: job.lease_expires_at instanceof Date
        ? job.lease_expires_at.toISOString()
        : job.lease_expires_at ?? null
    });
  } catch (error) {
    sendProtocolError(req, res, error);
  }
});

router.post(
  '/jobs/:jobId/result',
  requireLocalAgentExecutorScopes('local-agent.jobs.result'),
  async (req, res) => {
  const params = localAgentJobParamsSchema.safeParse(req.params);
  const body = localAgentResultInputSchema.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({
      ok: false,
      error: {
        code: 'LOCAL_AGENT_REQUEST_INVALID',
        message: 'The local-agent result does not match the bounded result contract.'
      }
    });
    return;
  }

  try {
    const device = await resolveAuthorizedLocalAgentDevice([], {
      principal: req.localAgentExecutorPrincipal
    });
    const job = await getLocalAgentJobForDevice(
      params.data.jobId,
      device.deviceId
    );
    const envelope = job ? readLocalAgentJobEnvelope(job) : null;
    if (
      !job
      || !envelope
      || !LOCAL_AGENT_ACTIONS.includes(envelope.job.action as LocalAgentAction)
    ) {
      throw new LocalAgentJobRepositoryError(
        'LOCAL_AGENT_JOB_NOT_FOUND',
        'The local-agent job was not found for this device.'
      );
    }
    if (body.data.outcome === 'succeeded') {
      try {
        validateLocalAgentActionOutput(
          envelope.job.action as LocalAgentAction,
          body.data.output
        );
      } catch (error) {
        if (error instanceof LocalAgentContractValidationError) {
          res.status(400).json({
            ok: false,
            error: {
              code: 'LOCAL_AGENT_OUTPUT_INVALID',
              message: 'The local-agent output does not match the authoritative action schema.'
            }
          });
          return;
        }
        throw error;
      }
    }
    const result = await submitLocalAgentJobResult({
      jobId: params.data.jobId,
      deviceId: device.deviceId,
      resultKeyHash: hashLocalAgentResultKey(body.data.resultKey),
      resultFingerprintHash: fingerprintLocalAgentResult(body.data),
      outcome: body.data.outcome,
      ...(body.data.output === undefined ? {} : { output: body.data.output }),
      ...(body.data.error === undefined ? {} : { error: body.data.error }),
      metrics: body.data.metrics,
      correlation: body.data.correlation
    });
    res.json(buildLocalAgentResultReceipt(result.job, result.replayed));
  } catch (error) {
    sendProtocolError(req, res, error);
  }
});

export default router;
