import express from 'express';

import { writePublicHealthResponse } from '@core/diagnostics.js';
import {
  createRateLimitMiddleware,
  getRequestActorKey,
  securityHeaders
} from '@platform/runtime/security.js';
import { isModuleActionAllowed } from '../mcp/modulesAllowlist.js';
import {
  dispatchModuleAction,
  getModuleMetadata,
  getModulesForRegistry,
  ModuleActionNotFoundError,
  ModuleNotFoundError
} from './modules.js';
import {
  asyncHandler,
  sendBadRequestPayload,
  sendInternalErrorPayload,
  sendNotFoundPayload
} from '@shared/http/index.js';
import { getWorkerControlHealth, getWorkerControlStatus } from '@services/workerControlService.js';
import {
  buildGptAccessHealthPayload,
  buildGptAccessOpenApiDocument,
  createGptAccessAiJob,
  explainApprovedQuery,
  getGptAccessJobResult,
  gptAccessAuthMiddleware,
  queryBackendLogs,
  requireGptAccessScope,
  runDeepDiagnostics,
  runGptAccessMcpTool,
  sanitizeGptAccessPayload,
  sendGptAccessResult
} from '@services/gptAccessGateway.js';

const router = express.Router();

type CapabilityRegistryEntry = ReturnType<typeof getModulesForRegistry>[number];
type CapabilityMetadata = NonNullable<ReturnType<typeof getModuleMetadata>>;

function getGptAccessRateLimitActorKey(req: express.Request): string {
  const expressClientIp = typeof req.ip === 'string' && req.ip.trim().length > 0
    ? req.ip.trim()
    : null;

  return expressClientIp ? `ip:${expressClientIp}` : getRequestActorKey(req);
}

const gptAccessRateLimit = createRateLimitMiddleware({
  bucketName: 'gpt-access',
  maxRequests: 120,
  windowMs: 5 * 60 * 1000,
  keyGenerator: (req) => `${getGptAccessRateLimitActorKey(req)}:gpt-access`
});

function sortStrings(values: string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function toCapabilitySummary(entry: CapabilityRegistryEntry) {
  return {
    id: entry.id,
    description: entry.description ?? null,
    route: entry.route ?? null,
    actions: sortStrings(entry.actions)
  };
}

function toCapabilityDetail(metadata: CapabilityMetadata) {
  return {
    id: metadata.name,
    name: metadata.name,
    description: metadata.description ?? null,
    route: metadata.route ?? null,
    actions: sortStrings(metadata.actions),
    defaultAction: metadata.defaultAction ?? null,
    defaultTimeoutMs: metadata.defaultTimeoutMs ?? null
  };
}

function readCapabilityRunBody(body: unknown): { action: unknown; payload: unknown } {
  const record = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};

  return {
    action: record.action,
    payload: Object.prototype.hasOwnProperty.call(record, 'payload') ? record.payload : {}
  };
}

function sendGptAccessBadRequest(res: express.Response, message: string): void {
  sendBadRequestPayload(res, {
    ok: false,
    error: {
      code: 'GPT_ACCESS_VALIDATION_ERROR',
      message
    }
  });
}

function sendGptAccessNotFound(res: express.Response, code: string, message: string): void {
  sendNotFoundPayload(res, {
    ok: false,
    error: {
      code,
      message
    }
  });
}

function sendGptAccessForbidden(res: express.Response, code: string, message: string): void {
  sendGptAccessResult(res, {
    statusCode: 403,
    payload: {
      ok: false,
      error: {
        code,
        message
      }
    }
  });
}

function sendGptAccessInternalError(res: express.Response, message: string): void {
  sendInternalErrorPayload(res, {
    ok: false,
    error: {
      code: 'GPT_ACCESS_INTERNAL_ERROR',
      message
    }
  });
}

function isModuleDispatchNotFoundError(error: unknown): boolean {
  return error instanceof ModuleNotFoundError || error instanceof ModuleActionNotFoundError;
}

const listGptAccessCapabilities = asyncHandler(async (_req, res) => {
  const capabilities = getModulesForRegistry()
    .map(toCapabilitySummary)
    .sort((left, right) => left.id.localeCompare(right.id));

  res.json({
    ok: true,
    capabilities
  });
});

const getGptAccessCapability = asyncHandler(async (req, res) => {
  const metadata = getModuleMetadata(req.params.id);

  if (!metadata) {
    res.json({
      ok: true,
      exists: false,
      capability: null
    });
    return;
  }

  res.json({
    ok: true,
    exists: true,
    capability: toCapabilityDetail(metadata)
  });
});

const runGptAccessCapability = asyncHandler(async (req, res) => {
  const { action, payload } = readCapabilityRunBody(req.body);

  if (typeof action !== 'string' || action.trim().length === 0) {
    sendGptAccessBadRequest(res, 'action must be a non-empty string.');
    return;
  }

  const normalizedAction = action.trim();
  const metadata = getModuleMetadata(req.params.id);

  if (!metadata) {
    sendGptAccessNotFound(res, 'GPT_ACCESS_CAPABILITY_NOT_FOUND', 'Capability not found.');
    return;
  }

  if (!metadata.actions.includes(normalizedAction)) {
    sendGptAccessNotFound(res, 'GPT_ACCESS_ACTION_NOT_FOUND', 'Capability action not found.');
    return;
  }

  if (!isModuleActionAllowed(metadata.name, normalizedAction)) {
    sendGptAccessForbidden(
      res,
      'GPT_ACCESS_CAPABILITY_ACTION_DENIED',
      'Capability action is not allowlisted for GPT Access execution.'
    );
    return;
  }

  try {
    const result = await dispatchModuleAction(metadata.name, normalizedAction, payload);
    res.json({
      ok: true,
      result: sanitizeGptAccessPayload(result)
    });
  } catch (error) {
    if (isModuleDispatchNotFoundError(error)) {
      sendGptAccessNotFound(res, 'GPT_ACCESS_CAPABILITY_NOT_FOUND', 'Capability or action not found.');
      return;
    }

    sendGptAccessInternalError(res, 'Capability execution failed.');
  }
});

router.use('/gpt-access', securityHeaders);
router.use('/gpt-access', gptAccessRateLimit);
router.use('/gpt-access', gptAccessAuthMiddleware);

router.get(
  '/gpt-access/capabilities/v1',
  requireGptAccessScope('capabilities.read'),
  listGptAccessCapabilities
);

router.get(
  '/gpt-access/capabilities/v1/:id',
  requireGptAccessScope('capabilities.read'),
  getGptAccessCapability
);

router.post(
  '/gpt-access/capabilities/v1/:id/run',
  requireGptAccessScope('capabilities.run'),
  runGptAccessCapability
);

router.get(
  '/gpt-access/modules',
  requireGptAccessScope('capabilities.read'),
  listGptAccessCapabilities
);

router.get(
  '/gpt-access/modules/:id',
  requireGptAccessScope('capabilities.read'),
  getGptAccessCapability
);

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
    res.json(sanitizeGptAccessPayload(await getWorkerControlStatus()));
  })
);

router.get(
  '/gpt-access/worker-helper/health',
  requireGptAccessScope('workers.read'),
  asyncHandler(async (_req, res) => {
    res.json(sanitizeGptAccessPayload(await getWorkerControlHealth()));
  })
);

router.post(
  '/gpt-access/jobs/create',
  requireGptAccessScope('jobs.create'),
  asyncHandler(async (req, res) => {
    sendGptAccessResult(
      res,
      await createGptAccessAiJob(req.body, {
        actorKey: getRequestActorKey(req),
        requestId: req.requestId,
        traceId: req.traceId,
        idempotencyKey: req.header('idempotency-key') ?? null,
        logger: req.logger
      })
    );
  })
);

router.post(
  '/gpt-access/jobs/result',
  requireGptAccessScope('jobs.result'),
  asyncHandler(async (req, res) => {
    sendGptAccessResult(
      res,
      await getGptAccessJobResult(req.body, {
        actorKey: getRequestActorKey(req),
        requestId: req.requestId,
        traceId: req.traceId,
        logger: req.logger
      })
    );
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
