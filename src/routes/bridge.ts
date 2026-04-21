import { randomUUID } from 'node:crypto';

import express from 'express';
import { createRateLimitMiddleware, getRequestActorKey, securityHeaders } from "@platform/runtime/security.js";
import { isBridgeEnabled } from "@platform/runtime/bridgeEnv.js";
import { asyncHandler } from '@shared/http/index.js';
import { sendBoundedJsonResponse } from '@shared/http/sendBoundedJsonResponse.js';
import {
  buildCustomGptBridgeHealthPayload,
  executeCustomGptBridgeRequest,
  parseCustomGptBridgeRequest,
  recordCustomGptBridgeFailure,
  validateCustomGptBridgeSecret,
} from '@services/customGptBridgeService.js';

const router = express.Router();

function buildFallbackRequestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${randomUUID()}`;
}

router.use(securityHeaders);
router.use(createRateLimitMiddleware(120, 5 * 60 * 1000));

const BRIDGE_PATHS = [
  '/bridge-status',
  '/bridge',
  '/bridge/handshake',
  '/ipc',
  '/ipc/handshake',
  '/ipc/status'
];

router.all(BRIDGE_PATHS, (_req, res) => {
  const enabled = isBridgeEnabled();
  res.json({
    status: enabled ? 'active' : 'disabled',
    bridgeEnabled: enabled,
    timestamp: new Date().toISOString()
  });
});

router.post(['/api/bridge/gpt', '/api/openai/gpt-action'], asyncHandler(async (req, res) => {
  const requestId = req.requestId ?? req.traceId ?? buildFallbackRequestId('bridge');
  const auth = validateCustomGptBridgeSecret({
    authorization: req.header('authorization'),
    actionSecret: req.header('x-openai-action-secret') ?? req.header('x-action-secret'),
  });

  if (!auth.ok) {
    recordCustomGptBridgeFailure('auth');
    return sendBoundedJsonResponse(req, res, auth.body ?? { ok: false }, {
      logEvent: 'bridge.gpt.auth_failure',
      statusCode: auth.statusCode,
    });
  }

  const parsedRequest = parseCustomGptBridgeRequest(req.body);
  if (!parsedRequest.ok || !parsedRequest.request) {
    recordCustomGptBridgeFailure('routing');
    return sendBoundedJsonResponse(req, res, parsedRequest.body ?? { ok: false }, {
      logEvent: 'bridge.gpt.invalid_request',
      statusCode: parsedRequest.statusCode,
    });
  }

  const result = await executeCustomGptBridgeRequest({
    request: parsedRequest.request,
    requestId,
    actorKey: getRequestActorKey(req),
    explicitIdempotencyKey: req.header('idempotency-key'),
  });

  if (result.errorSource) {
    recordCustomGptBridgeFailure(result.errorSource);
  }

  return sendBoundedJsonResponse(req, res, result.body, {
    logEvent: 'bridge.gpt.response',
    statusCode: result.statusCode,
  });
}));

router.get('/api/bridge/health', asyncHandler(async (req, res) => {
  const requestId = req.requestId ?? req.traceId ?? buildFallbackRequestId('bridge-health');
  const payload = await buildCustomGptBridgeHealthPayload(requestId);
  return sendBoundedJsonResponse(req, res, payload, {
    logEvent: 'bridge.health.response',
    statusCode: payload.ok === true ? 200 : 503,
  });
}));

export default router;
