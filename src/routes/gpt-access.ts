import express from 'express';

import { writePublicHealthResponse } from '@core/diagnostics.js';
import {
  createRateLimitMiddleware,
  getRequestActorKey,
  securityHeaders
} from '@platform/runtime/security.js';
import { confirmGate } from '@transport/http/middleware/confirmGate.js';
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
  getGptAccessQueueInspection,
  getGptAccessSelfHealStatus,
  explainApprovedQuery,
  getGptAccessJobResult,
  gptAccessAuthMiddleware,
  queryBackendLogs,
  requireGptAccessScope,
  resolveGptAccessOpenApiServerUrl,
  runDeepDiagnostics,
  runGptAccessMcpTool,
  sanitizeGptAccessPayload,
  sendGptAccessResult
} from '@services/gptAccessGateway.js';

const router = express.Router();

type CapabilityRegistryEntry = ReturnType<typeof getModulesForRegistry>[number];
type CapabilityMetadata = NonNullable<ReturnType<typeof getModuleMetadata>>;
type CapabilityRunBody =
  | { ok: true; action: unknown; payload: unknown }
  | { ok: false; message: string };

const CAPABILITY_CONFIRMATION_TOKEN_BODY_KEY = 'confirmation_token';
const CAPABILITY_CONFIRMATION_HEADER_TOKEN_PREFIX = 'token:';
const CAPABILITY_RUN_BODY_KEYS = new Set(['action', 'payload']);
const CAPABILITY_PAYLOAD_MAX_DEPTH = 32;
const UNSAFE_CAPABILITY_PAYLOAD_FIELDS = new Set([
  '__arcanosExecutionMode',
  '__arcanosExecutionReason',
  '__arcanosGptId',
  '__arcanosRequestedAction',
  '__arcanosSourceEndpoint',
  '__arcanosSuppressPromptDebugTrace',
  '__proto__',
  'admin_key',
  'api-key',
  'api_key',
  'apikey',
  'auth',
  'authorization',
  'bearer',
  'command',
  'constructor',
  'cookie',
  'cookies',
  'endpoint',
  'exec',
  'headers',
  'maxOutputTokens',
  'maxWords',
  'openai_api_key',
  'overrideAuditSafe',
  'password',
  'prototype',
  'proxy',
  'railway_token',
  'secret',
  'shell',
  'sql',
  'suppressTimeoutFallback',
  'target',
  'timeout_ms',
  'timeoutMs',
  'token',
  'url'
].map((field) => field.toLowerCase()));

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

function findUnsafeCapabilityPayloadIssue(value: unknown, depth = 0): 'unsafe_field' | 'depth_exceeded' | null {
  if (depth > CAPABILITY_PAYLOAD_MAX_DEPTH) {
    return 'depth_exceeded';
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const issue = findUnsafeCapabilityPayloadIssue(item, depth + 1);
      if (issue) return issue;
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (UNSAFE_CAPABILITY_PAYLOAD_FIELDS.has(key.toLowerCase())) {
      return 'unsafe_field';
    }

    const issue = findUnsafeCapabilityPayloadIssue(record[key], depth + 1);
    if (issue) return issue;
  }

  return null;
}

function readCapabilityRunBody(body: unknown): CapabilityRunBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'request body must be a JSON object.' };
  }

  const record = body as Record<string, unknown>;
  const unsupportedKey = Object.keys(record).find((key) => !CAPABILITY_RUN_BODY_KEYS.has(key));
  if (unsupportedKey) {
    return { ok: false, message: 'request body may only include action and payload.' };
  }

  const payload = Object.prototype.hasOwnProperty.call(record, 'payload') ? record.payload : {};
  const payloadIssue = findUnsafeCapabilityPayloadIssue(payload);
  if (payloadIssue === 'unsafe_field') {
    return { ok: false, message: 'payload contains fields that are not allowed for capability execution.' };
  }
  if (payloadIssue === 'depth_exceeded') {
    return { ok: false, message: 'payload exceeds maximum nesting depth for capability execution.' };
  }

  return {
    ok: true,
    action: record.action,
    payload
  };
}

function readCapabilityConfirmationTokenField(value: unknown):
  | { ok: true; confirmationChallengeId: string }
  | { ok: false; message: string } {
  if (typeof value !== 'string') {
    return { ok: false, message: 'confirmation_token must be a non-empty string when provided.' };
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: 'confirmation_token must be a non-empty string when provided.' };
  }

  if (/\s/u.test(trimmed)) {
    return { ok: false, message: 'confirmation_token must be a single non-empty token value.' };
  }

  const confirmationChallengeId = trimmed.toLowerCase().startsWith(CAPABILITY_CONFIRMATION_HEADER_TOKEN_PREFIX)
    ? trimmed.slice(CAPABILITY_CONFIRMATION_HEADER_TOKEN_PREFIX.length).trim()
    : trimmed;

  if (confirmationChallengeId.length === 0 || /\s/u.test(confirmationChallengeId)) {
    return { ok: false, message: 'confirmation_token must be a single non-empty token value.' };
  }

  return { ok: true, confirmationChallengeId };
}

function normalizeCapabilityRunBodyForConfirmation(record: Record<string, unknown>): Record<string, unknown> {
  const bodyKeys = Object.keys(record);
  const onlySupportedRunKeys = bodyKeys.every((key) => CAPABILITY_RUN_BODY_KEYS.has(key));
  if (
    onlySupportedRunKeys
    && Object.prototype.hasOwnProperty.call(record, 'action')
    && !Object.prototype.hasOwnProperty.call(record, 'payload')
  ) {
    return {
      ...record,
      payload: {}
    };
  }

  return record;
}

function mapCapabilityRunConfirmationToken(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    next();
    return;
  }

  const record = req.body as Record<string, unknown>;
  const hasConfirmationToken = Object.prototype.hasOwnProperty.call(
    record,
    CAPABILITY_CONFIRMATION_TOKEN_BODY_KEY
  );
  const sanitizedBody = hasConfirmationToken ? { ...record } : record;
  if (hasConfirmationToken) {
    delete sanitizedBody[CAPABILITY_CONFIRMATION_TOKEN_BODY_KEY];
  }

  req.body = normalizeCapabilityRunBodyForConfirmation(sanitizedBody);

  if (!hasConfirmationToken) {
    next();
    return;
  }

  const tokenResult = readCapabilityConfirmationTokenField(record[CAPABILITY_CONFIRMATION_TOKEN_BODY_KEY]);

  if (!tokenResult.ok) {
    sendGptAccessBadRequest(res, tokenResult.message);
    return;
  }

  if (!req.header('x-confirmed')) {
    req.headers['x-confirmed'] = `token:${tokenResult.confirmationChallengeId}`;
  }

  next();
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

function sendGptAccessUnavailable(
  res: express.Response,
  code: string,
  message: string
): void {
  sendGptAccessResult(res, {
    statusCode: 503,
    payload: {
      ok: false,
      status: 'unavailable',
      service: 'gpt-access',
      error: {
        code,
        message
      }
    }
  });
}

function isModuleDispatchNotFoundError(error: unknown): boolean {
  return error instanceof ModuleNotFoundError || error instanceof ModuleActionNotFoundError;
}

const listGptAccessCapabilities = asyncHandler(async (_req, res) => {
  let capabilities;
  try {
    capabilities = getModulesForRegistry()
      .map(toCapabilitySummary)
      .sort((left, right) => left.id.localeCompare(right.id));
  } catch {
    sendGptAccessUnavailable(
      res,
      'GPT_ACCESS_MCP_TOOL_UNAVAILABLE',
      'Capability registry is unavailable.'
    );
    return;
  }

  res.json({
    ok: true,
    capabilities
  });
});

const getGptAccessCapability = asyncHandler(async (req, res) => {
  let metadata;
  try {
    metadata = getModuleMetadata(req.params.id);
  } catch {
    sendGptAccessUnavailable(
      res,
      'GPT_ACCESS_MCP_TOOL_UNAVAILABLE',
      'Capability registry is unavailable.'
    );
    return;
  }

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
  const body = readCapabilityRunBody(req.body);
  if (!body.ok) {
    sendGptAccessBadRequest(res, body.message);
    return;
  }

  const { action, payload } = body;

  if (typeof action !== 'string' || action.trim().length === 0) {
    sendGptAccessBadRequest(res, 'action must be a non-empty string.');
    return;
  }

  const normalizedAction = action.trim();
  let metadata;
  try {
    metadata = getModuleMetadata(req.params.id);
  } catch {
    sendGptAccessUnavailable(
      res,
      'GPT_ACCESS_MCP_TOOL_UNAVAILABLE',
      'Capability registry is unavailable.'
    );
    return;
  }

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

router.get('/gpt-access/openapi.json', (req, res) => {
  res.set('cache-control', 'no-store, max-age=0');
  res.json(buildGptAccessOpenApiDocument({
    serverUrl: resolveGptAccessOpenApiServerUrl(req)
  }));
});

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
  mapCapabilityRunConfirmationToken,
  confirmGate,
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
    try {
      await writePublicHealthResponse(req, res);
    } catch {
      sendGptAccessUnavailable(
        res,
        'GPT_ACCESS_RUNTIME_UNAVAILABLE',
        'Runtime status is unavailable.'
      );
    }
  })
);

router.get(
  '/gpt-access/workers/status',
  requireGptAccessScope('workers.read'),
  asyncHandler(async (_req, res) => {
    try {
      res.json(sanitizeGptAccessPayload(await getWorkerControlStatus()));
    } catch {
      sendGptAccessUnavailable(
        res,
        'GPT_ACCESS_WORKER_UNAVAILABLE',
        'Worker status is unavailable.'
      );
    }
  })
);

router.get(
  '/gpt-access/worker-helper/health',
  requireGptAccessScope('workers.read'),
  asyncHandler(async (_req, res) => {
    try {
      res.json(sanitizeGptAccessPayload(await getWorkerControlHealth()));
    } catch {
      sendGptAccessUnavailable(
        res,
        'GPT_ACCESS_WORKER_UNAVAILABLE',
        'Worker helper health is unavailable.'
      );
    }
  })
);

router.get(
  '/gpt-access/queue/inspect',
  requireGptAccessScope('queue.read'),
  asyncHandler(async (_req, res) => {
    sendGptAccessResult(res, await getGptAccessQueueInspection());
  })
);

router.get(
  '/gpt-access/self-heal/status',
  requireGptAccessScope('mcp.approved_readonly'),
  asyncHandler(async (_req, res) => {
    sendGptAccessResult(res, await getGptAccessSelfHealStatus());
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

router.use('/gpt-access', (req, res) => {
  sendGptAccessResult(res, {
    statusCode: 404,
    payload: {
      ok: false,
      error: {
        code: 'GPT_ACCESS_ROUTE_NOT_FOUND',
        message: `GPT access route not found: ${req.method} ${req.path}`
      }
    }
  });
});

export default router;
