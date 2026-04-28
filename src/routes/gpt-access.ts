import express from 'express';

import { writePublicHealthResponse } from '@core/diagnostics.js';
import {
  createRateLimitMiddleware,
  getRequestActorKey,
  securityHeaders
} from '@platform/runtime/security.js';
import { asyncHandler } from '@shared/http/index.js';
import { getWorkerControlHealth, getWorkerControlStatus } from '@services/workerControlService.js';
import {
  buildGptAccessHealthPayload,
  buildGptAccessOpenApiDocument,
  explainApprovedQuery,
  getGptAccessJobResult,
  gptAccessAuthMiddleware,
  queryBackendLogs,
  requireGptAccessScope,
  runDeepDiagnostics,
  runGptAccessMcpTool,
  sendGptAccessResult
} from '@services/gptAccessGateway.js';

const router = express.Router();
const gptAccessRateLimit = createRateLimitMiddleware({
  bucketName: 'gpt-access',
  maxRequests: 120,
  windowMs: 5 * 60 * 1000,
  keyGenerator: (req) => `${getRequestActorKey(req)}:gpt-access`
});

router.use('/gpt-access', securityHeaders);
router.use('/gpt-access', gptAccessRateLimit);
router.use(gptAccessAuthMiddleware);

router.get('/gpt-access/health', requireGptAccessScope('diagnostics.read'), (_req, res) => {
  res.json(buildGptAccessHealthPayload());
});

router.get(
  '/gpt-access/status',
  requireGptAccessScope('runtime.read'),
  asyncHandler(async (req, res) => {
    await writePublicHealthResponse(req, res);
  })
);

router.get(
  '/gpt-access/workers/status',
  requireGptAccessScope('workers.read'),
  asyncHandler(async (_req, res) => {
    res.json(await getWorkerControlStatus());
  })
);

router.get(
  '/gpt-access/worker-helper/health',
  requireGptAccessScope('workers.read'),
  asyncHandler(async (_req, res) => {
    res.json(await getWorkerControlHealth());
  })
);

router.post(
  '/gpt-access/jobs/result',
  requireGptAccessScope('jobs.result'),
  asyncHandler(async (req, res) => {
    sendGptAccessResult(res, await getGptAccessJobResult(req.body));
  })
);

router.post(
  '/gpt-access/diagnostics/deep',
  requireGptAccessScope('diagnostics.read'),
  asyncHandler(async (req, res) => {
    sendGptAccessResult(res, await runDeepDiagnostics(req.body));
  })
);

router.post(
  '/gpt-access/db/explain',
  requireGptAccessScope('db.explain_approved'),
  asyncHandler(async (req, res) => {
    sendGptAccessResult(res, await explainApprovedQuery(req.body));
  })
);

router.post(
  '/gpt-access/logs/query',
  requireGptAccessScope('logs.read_sanitized'),
  asyncHandler(async (req, res) => {
    sendGptAccessResult(res, await queryBackendLogs(req.body));
  })
);

router.post(
  '/gpt-access/mcp',
  requireGptAccessScope('mcp.approved_readonly'),
  asyncHandler(async (req, res) => {
    sendGptAccessResult(res, await runGptAccessMcpTool(req.body));
  })
);

router.get('/gpt-access/openapi.json', (_req, res) => {
  res.set('cache-control', 'no-store, max-age=0');
  res.json(buildGptAccessOpenApiDocument());
});

export default router;
