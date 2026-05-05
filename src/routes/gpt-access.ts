import express from 'express';

import { writePublicHealthResponse } from '@core/diagnostics.js';
import {
  createRateLimitMiddleware,
  getRequestActorKey,
  securityHeaders
} from '@platform/runtime/security.js';
import { confirmGate } from '@transport/http/middleware/confirmGate.js';
import {
  DISPATCH_RUN_BODY_KEYS,
  DISPATCH_UTTERANCE_MAX_LENGTH,
  INTENT_CLARIFICATION_REQUIRED,
  createCapabilityRegistry,
  createGptAccessDispatchRegistry,
  evaluateDispatchPolicy,
  readDispatchConfirmationTokenField,
  resolveDispatchPlan,
  runDispatchPlan,
  type CapabilityRegistry,
  stripDispatchConfirmationToken,
  type DispatchExecutionResult,
  type DispatchPolicyDecision,
  type DispatchPlan
} from '@dispatcher/naturalLanguage/index.js';
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
  sendInternalErrorPayload
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
  GPT_ACCESS_SCOPES,
  gptAccessAuthMiddleware,
  isGptAccessScopeAllowed,
  queryBackendLogs,
  requireGptAccessScope,
  resolveGptAccessOpenApiServerUrl,
  runDeepDiagnostics,
  runGptAccessMcpTool,
  sanitizeGptAccessPayload,
  sendGptAccessResult,
  type GptAccessScope
} from '@services/gptAccessGateway.js';

const router = express.Router();

type CapabilityRegistryEntry = ReturnType<typeof getModulesForRegistry>[number];
type CapabilityMetadata = NonNullable<ReturnType<typeof getModuleMetadata>>;
type CapabilityRunBody =
  | { ok: true; action: unknown; payload: unknown }
  | { ok: false; message: string };
type DispatchRunBody =
  | {
      ok: true;
      utterance: string;
      context?: Record<string, unknown>;
      dryRun: boolean;
    }
  | { ok: false; message: string };

const CAPABILITY_CONFIRMATION_TOKEN_BODY_KEY = 'confirmation_token';
const CAPABILITY_CONFIRMATION_HEADER_TOKEN_PREFIX = 'token:';
const CAPABILITY_RUN_BODY_KEYS = new Set(['action', 'payload']);
const GPT_ACCESS_SCOPE_NAMES = new Set<string>(GPT_ACCESS_SCOPES);
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

function readDispatchRunBody(body: unknown): DispatchRunBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'request body must be a JSON object.' };
  }

  const record = body as Record<string, unknown>;
  const unsupportedKey = Object.keys(record).find((key) => !DISPATCH_RUN_BODY_KEYS.has(key));
  if (unsupportedKey) {
    return {
      ok: false,
      message: 'request body may only include utterance, context, dryRun, and confirmation_token.'
    };
  }

  if (typeof record.utterance !== 'string' || record.utterance.trim().length === 0) {
    return { ok: false, message: 'utterance must be a non-empty string.' };
  }

  const utterance = record.utterance.trim();
  if (utterance.length > DISPATCH_UTTERANCE_MAX_LENGTH) {
    return {
      ok: false,
      message: `utterance must be ${DISPATCH_UTTERANCE_MAX_LENGTH} characters or fewer.`
    };
  }

  if (
    Object.prototype.hasOwnProperty.call(record, 'context')
    && (!record.context || typeof record.context !== 'object' || Array.isArray(record.context))
  ) {
    return { ok: false, message: 'context must be a JSON object when provided.' };
  }

  if (
    Object.prototype.hasOwnProperty.call(record, 'dryRun')
    && typeof record.dryRun !== 'boolean'
  ) {
    return { ok: false, message: 'dryRun must be a boolean when provided.' };
  }

  return {
    ok: true,
    utterance,
    context: record.context as Record<string, unknown> | undefined,
    dryRun: record.dryRun === true
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

function mapDispatchRunConfirmationToken(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    next();
    return;
  }

  const { body, confirmationToken } = stripDispatchConfirmationToken(req.body as Record<string, unknown>);
  req.body = body;

  if (confirmationToken === undefined) {
    next();
    return;
  }

  const tokenResult = readDispatchConfirmationTokenField(confirmationToken);
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

function isDispatchGptAccessScopeAllowed(scope: string): boolean {
  return GPT_ACCESS_SCOPE_NAMES.has(scope) && isGptAccessScopeAllowed(scope as GptAccessScope);
}

function createDispatchLlmPlanningRegistry(registry: CapabilityRegistry): CapabilityRegistry {
  return createCapabilityRegistry(
    registry.listActions().filter((registryAction) => {
      const policy = evaluateDispatchPolicy({
        plan: {
          action: registryAction.action,
          payload: {},
          confidence: 1,
          source: 'rules',
          requiresConfirmation: Boolean(
            registryAction.requiresConfirmation || registryAction.risk !== 'readonly'
          ),
          reason: 'llm_planning_catalog_filter'
        },
        registry,
        isScopeAllowed: isDispatchGptAccessScopeAllowed,
        isModuleActionAllowed
      });

      return policy.status === 'allowed' || policy.status === 'confirmation_required';
    })
  );
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

async function runGptAccessCapabilityAction(input: {
  capabilityId: string;
  action: string;
  payload: unknown;
}): Promise<DispatchExecutionResult> {
  let metadata;
  try {
    metadata = getModuleMetadata(input.capabilityId);
  } catch {
    return {
      statusCode: 503,
      payload: {
        ok: false,
        status: 'unavailable',
        service: 'gpt-access',
        error: {
          code: 'GPT_ACCESS_MCP_TOOL_UNAVAILABLE',
          message: 'Capability registry is unavailable.'
        }
      }
    };
  }

  if (!metadata) {
    return {
      statusCode: 404,
      payload: {
        ok: false,
        error: {
          code: 'GPT_ACCESS_CAPABILITY_NOT_FOUND',
          message: 'Capability not found.'
        }
      }
    };
  }

  if (!metadata.actions.includes(input.action)) {
    return {
      statusCode: 404,
      payload: {
        ok: false,
        error: {
          code: 'GPT_ACCESS_ACTION_NOT_FOUND',
          message: 'Capability action not found.'
        }
      }
    };
  }

  if (!isModuleActionAllowed(metadata.name, input.action)) {
    return {
      statusCode: 403,
      payload: {
        ok: false,
        error: {
          code: 'GPT_ACCESS_CAPABILITY_ACTION_DENIED',
          message: 'Capability action is not allowlisted for GPT Access execution.'
        }
      }
    };
  }

  try {
    const result = await dispatchModuleAction(metadata.name, input.action, input.payload);
    return {
      statusCode: 200,
      payload: {
        ok: true,
        result: sanitizeGptAccessPayload(result)
      }
    };
  } catch (error) {
    if (isModuleDispatchNotFoundError(error)) {
      return {
        statusCode: 404,
        payload: {
          ok: false,
          error: {
            code: 'GPT_ACCESS_CAPABILITY_NOT_FOUND',
            message: 'Capability or action not found.'
          }
        }
      };
    }

    return {
      statusCode: 500,
      payload: {
        ok: false,
        error: {
          code: 'GPT_ACCESS_INTERNAL_ERROR',
          message: 'Capability execution failed.'
        }
      }
    };
  }
}

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

  sendGptAccessResult(
    res,
    await runGptAccessCapabilityAction({
      capabilityId: req.params.id,
      action: action.trim(),
      payload
    })
  );
});

function toDispatchPolicyResponse(policy: DispatchPolicyDecision) {
  return {
    status: policy.status,
    allowed: policy.allowed,
    requiresConfirmation: policy.requiresConfirmation,
    shouldExecute: policy.shouldExecute,
    action: policy.action,
    reason: policy.reason,
    code: policy.code,
    requiredScope: policy.requiredScope ?? null
  };
}

function toDispatchPolicyErrorMessage(policy: DispatchPolicyDecision): string {
  switch (policy.code) {
    case INTENT_CLARIFICATION_REQUIRED:
      return 'Dispatch intent could not be resolved confidently. Please clarify the requested action.';
    case 'DISPATCH_ACTION_NOT_REGISTERED':
      return 'Dispatch action is not registered for GPT Access.';
    case 'DISPATCH_ACTION_PROHIBITED':
      return 'Dispatch action is prohibited by GPT Access policy.';
    case 'GPT_ACCESS_SCOPE_DENIED':
      return 'GPT Access scope is not allowed for this dispatch action.';
    case 'GPT_ACCESS_CAPABILITY_ACTION_DENIED':
      return 'GPT Access capability action is not allowlisted.';
    default:
      return policy.status === 'clarification_required'
        ? 'Dispatch intent could not be resolved confidently. Please clarify the requested action.'
        : 'Dispatch request was denied by policy.';
  }
}

function sendDispatchPolicyBlock(
  res: express.Response,
  plan: DispatchPlan,
  policy: DispatchPolicyDecision
): void {
  const statusCode = policy.status === 'clarification_required' ? 422 : 403;
  sendGptAccessResult(res, {
    statusCode,
    payload: {
      ok: false,
      error: {
        code: policy.code ?? (
          policy.status === 'clarification_required'
            ? INTENT_CLARIFICATION_REQUIRED
            : 'DISPATCH_POLICY_DENIED'
        ),
        message: toDispatchPolicyErrorMessage(policy)
      },
      plan,
      policy: toDispatchPolicyResponse(policy)
    }
  });
}

async function executeDispatchRun(
  req: express.Request,
  res: express.Response,
  plan: DispatchPlan,
  policy: DispatchPolicyDecision
): Promise<void> {
  if (!policy.registryAction) {
    sendDispatchPolicyBlock(res, plan, policy);
    return;
  }

  const result = await runDispatchPlan({
    plan,
    registry: createGptAccessDispatchRegistry(getModulesForRegistry()),
    handlers: {
      runMcpTool: (body) => runGptAccessMcpTool(body),
      runDiagnostics: (payload) => runDeepDiagnostics(payload),
      runCapability: (input) => runGptAccessCapabilityAction({
        capabilityId: input.capabilityId,
        action: input.action,
        payload: input.payload
      })
    }
  });

  sendGptAccessResult(res, {
    statusCode: result.statusCode,
    payload: {
      ok: result.statusCode >= 200 && result.statusCode < 300,
      plan,
      policy: toDispatchPolicyResponse(policy),
      result: sanitizeGptAccessPayload(result.payload)
    }
  });
}

const runGptAccessDispatch = asyncHandler(async (req, res) => {
  const body = readDispatchRunBody(req.body);
  if (!body.ok) {
    sendGptAccessBadRequest(res, body.message);
    return;
  }

  const registry = createGptAccessDispatchRegistry(getModulesForRegistry());
  const plan = await resolveDispatchPlan({
    utterance: body.utterance,
    registry,
    llmRegistry: createDispatchLlmPlanningRegistry(registry),
    context: body.context
  });
  const policy = evaluateDispatchPolicy({
    plan,
    registry,
    isScopeAllowed: isDispatchGptAccessScopeAllowed,
    isModuleActionAllowed
  });

  if (body.dryRun) {
    res.json({
      ok: true,
      dryRun: true,
      plan,
      policy: toDispatchPolicyResponse(policy)
    });
    return;
  }

  if (!policy.allowed) {
    sendDispatchPolicyBlock(res, plan, policy);
    return;
  }

  if (policy.requiresConfirmation) {
    confirmGate(req, res, () => {
      const confirmedPolicy: DispatchPolicyDecision = {
        ...policy,
        status: 'allowed',
        requiresConfirmation: false,
        shouldExecute: true,
        reason: 'confirmation_satisfied'
      };
      void executeDispatchRun(req, res, plan, confirmedPolicy).catch((error) => {
        req.logger?.error?.('gpt_access.dispatch.failed', {
          error: error instanceof Error ? error.message : String(error)
        });
        if (!res.headersSent) {
          sendGptAccessInternalError(res, 'Dispatch execution failed.');
        }
      });
    });
    return;
  }

  await executeDispatchRun(req, res, plan, policy);
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

router.post(
  '/gpt-access/dispatch/run',
  mapDispatchRunConfirmationToken,
  runGptAccessDispatch
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
