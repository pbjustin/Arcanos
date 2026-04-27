import crypto from 'node:crypto';
import type express from 'express';

import {
  TRINITY_CORE_DAG_TEMPLATE_NAME,
  UnsupportedDagTemplateError,
  resolvePublicDagTemplateName,
} from '@dag/templates.js';
import { arcanosDagRunService } from '@services/arcanosDagRunService.js';
import { redactSensitive } from '@shared/redaction.js';
import {
  GPT_DAG_BRIDGE_ACTIONS,
  type GptDagBridgeAction,
  isGptDagBridgeAction,
} from '@shared/gpt/gptDagBridgeActions.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';

const GPT_DISPATCHER_ROUTE = '/gpt/:gptId';
const DEFAULT_ALLOWED_GPTS = ['arcanos-core'];
const DEFAULT_GRAPH_ID = 'default';
const DEFAULT_DAG_PRIORITY = 'normal';
const MAX_PROMPT_CHARS = 50_000;
const MAX_IDEMPOTENCY_KEY_CHARS = 160;
const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;

const FORBIDDEN_PAYLOAD_KEYS = new Set([
  'action',
  'auth',
  'authorization',
  'controlplaneaction',
  'control_plane_action',
  'endpoint',
  'headers',
  'method',
  'route',
  'source',
  'target',
  'url',
]);

type BridgeLogger = {
  error?: (message: string, meta?: Record<string, unknown>) => void;
  info?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
};

export interface GptDagBridgeContext {
  req: express.Request;
  requestId: string | undefined;
  traceId: string;
  gptId: string;
  action: string;
  normalizedBody: Record<string, unknown> | null;
  promptText: string | null;
  logger?: BridgeLogger;
}

export interface GptDagBridgeResponse {
  statusCode: number;
  logEvent: string;
  payload: Record<string, unknown>;
}

interface DagBridgeAuditInput {
  ctx: GptDagBridgeContext;
  status: number;
  latencyMs: number;
  runId?: string | null;
  graphId?: string | null;
  errorCode?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function parseBooleanEnv(name: string, fallbackValue: boolean): boolean {
  const rawValue = process.env[name]?.trim().toLowerCase();
  if (!rawValue) {
    return fallbackValue;
  }

  return rawValue === 'true' || rawValue === '1' || rawValue === 'yes';
}

function parseBooleanLike(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalizedValue = value.trim().toLowerCase();
  if (normalizedValue === 'true' || normalizedValue === '1' || normalizedValue === 'yes') {
    return true;
  }
  if (normalizedValue === 'false' || normalizedValue === '0' || normalizedValue === 'no') {
    return false;
  }

  return null;
}

function readPositiveInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : null;
  }

  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    return null;
  }

  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseCsv(value: string | undefined, fallback: string[]): string[] {
  const parsed = value
    ?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  return parsed && parsed.length > 0 ? parsed : fallback;
}

function timingSafeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function extractBearerToken(req: express.Request): string | null {
  const authorization = req.header('authorization') ?? '';
  const [scheme, ...rest] = authorization.trim().split(/\s+/u);
  if (scheme?.toLowerCase() !== 'bearer') {
    return null;
  }

  const token = rest.join(' ').trim();
  return token || null;
}

function buildRouteMeta(ctx: GptDagBridgeContext, route: string) {
  return {
    requestId: ctx.requestId,
    traceId: ctx.traceId,
    gptId: ctx.gptId,
    action: ctx.action,
    route,
    source: `gpt.${ctx.gptId}`,
    sourceEndpoint: `gpt.${ctx.gptId}.${ctx.action}`,
    timestamp: new Date().toISOString(),
  };
}

function buildErrorResponse(
  ctx: GptDagBridgeContext,
  statusCode: number,
  code: string,
  message: string,
  route: string,
  details?: Record<string, unknown>
): GptDagBridgeResponse {
  return {
    statusCode,
    logEvent: `gpt.response.${route}`,
    payload: {
      ok: false,
      gptId: ctx.gptId,
      action: ctx.action,
      route: GPT_DISPATCHER_ROUTE,
      traceId: ctx.traceId,
      source: `gpt.${ctx.gptId}`,
      code,
      error: {
        code,
        message,
        ...(details ? { details } : {}),
      },
      _route: buildRouteMeta(ctx, route),
    },
  };
}

function resolvePayload(ctx: GptDagBridgeContext): Record<string, unknown> {
  return isRecord(ctx.normalizedBody?.payload) ? ctx.normalizedBody.payload : {};
}

function stripForbiddenPayloadKeys(value: unknown, depth = 0): unknown {
  if (depth > 8) {
    return '[max depth reached]';
  }

  if (Array.isArray(value)) {
    return value.map((entry) => stripForbiddenPayloadKeys(entry, depth + 1));
  }

  if (!isRecord(value)) {
    return value;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_PAYLOAD_KEYS.has(key.toLowerCase())) {
      continue;
    }

    sanitized[key] = stripForbiddenPayloadKeys(entry, depth + 1);
  }

  return sanitized;
}

function getSafeInputFromPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const input = isRecord(payload.input) ? payload.input : {};
  const sanitizedInput = stripForbiddenPayloadKeys(input);
  const redactedInput = redactSensitive(sanitizedInput);
  return isRecord(redactedInput) ? redactedInput : {};
}

function getSafePrompt(ctx: GptDagBridgeContext): string | null {
  const prompt = ctx.promptText?.trim() ?? '';
  if (!prompt) {
    return null;
  }

  const redactedPrompt = redactSensitive(prompt.slice(0, MAX_PROMPT_CHARS));
  return typeof redactedPrompt === 'string' && redactedPrompt.trim().length > 0
    ? redactedPrompt.trim()
    : null;
}

function getGraphId(payload: Record<string, unknown>): string {
  return readString(payload.graphId) ?? DEFAULT_GRAPH_ID;
}

function validateGraphId(graphId: string): { ok: true; template: string } | { ok: false } {
  const template = resolvePublicDagTemplateName(graphId);
  return template === TRINITY_CORE_DAG_TEMPLATE_NAME
    ? { ok: true, template }
    : { ok: false };
}

function getOptionsRecord(payload: Record<string, unknown>): Record<string, unknown> {
  return isRecord(payload.options) ? payload.options : {};
}

function getBridgeAsync(payload: Record<string, unknown>): boolean {
  const options = getOptionsRecord(payload);
  return parseBooleanLike(payload.async) ?? parseBooleanLike(options.async) ?? true;
}

function getBridgePriority(): 'normal' {
  return DEFAULT_DAG_PRIORITY;
}

function getIdempotencyKey(payload: Record<string, unknown>): string | null {
  const options = getOptionsRecord(payload);
  const idempotencyKey = readString(payload.idempotencyKey) ?? readString(options.idempotencyKey);
  return idempotencyKey ? idempotencyKey.slice(0, MAX_IDEMPOTENCY_KEY_CHARS) : null;
}

function buildCreateRunOptions(payload: Record<string, unknown>) {
  const options = getOptionsRecord(payload);
  const maxConcurrency = readPositiveInteger(options.maxConcurrency ?? payload.maxConcurrency);

  return {
    ...(maxConcurrency !== null ? { maxConcurrency } : {}),
  };
}

function getActorHeader(req: express.Request, name: string): string | null {
  const value = readString(req.header(name));
  return value ? value.slice(0, 128) : null;
}

function getRequestPermissions(req: express.Request): Set<string> {
  const rawPermissions =
    req.header('x-arcanos-permissions') ??
    req.header('x-arcanos-permission') ??
    '';

  return new Set(
    rawPermissions
      .split(',')
      .map((permission) => permission.trim())
      .filter(Boolean)
  );
}

function getRequiredPermission(action: GptDagBridgeAction): 'dag:read' | 'dag:execute' {
  return action === 'dag.dispatch' ? 'dag:execute' : 'dag:read';
}

function logBridgeAudit(input: DagBridgeAuditInput): void {
  const userId = getActorHeader(input.ctx.req, 'x-user-id');
  const orgId = getActorHeader(input.ctx.req, 'x-org-id');
  const event = {
    gptId: input.ctx.gptId,
    action: input.ctx.action,
    traceId: input.ctx.traceId,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.graphId ? { graphId: input.graphId } : {}),
    ...(userId ? { userId } : {}),
    ...(orgId ? { orgId } : {}),
    status: input.status,
    latencyMs: input.latencyMs,
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
  };

  if (input.status >= 500) {
    input.ctx.logger?.error?.('gpt.dag_bridge.audit', event);
  } else if (input.status >= 400) {
    input.ctx.logger?.warn?.('gpt.dag_bridge.audit', event);
  } else {
    input.ctx.logger?.info?.('gpt.dag_bridge.audit', event);
  }
}

export function assertGptCanUseDag(
  ctx: GptDagBridgeContext,
  action: GptDagBridgeAction
): GptDagBridgeResponse | null {
  if (!parseBooleanEnv('GPT_DAG_BRIDGE_ENABLED', false)) {
    return buildErrorResponse(
      ctx,
      403,
      'GPT_DAG_BRIDGE_DISABLED',
      'DAG bridge actions are disabled for the GPT route.',
      'dag_bridge_disabled'
    );
  }

  const allowedGpts = parseCsv(process.env.GPT_DAG_BRIDGE_ALLOWED_GPTS, DEFAULT_ALLOWED_GPTS);
  if (!allowedGpts.includes('*') && !allowedGpts.includes(ctx.gptId)) {
    return buildErrorResponse(
      ctx,
      403,
      'GPT_DAG_BRIDGE_GPT_NOT_ALLOWED',
      'This GPT ID is not allowed to use DAG bridge actions.',
      'dag_bridge_gpt_not_allowed'
    );
  }

  if (parseBooleanEnv('GPT_DAG_BRIDGE_REQUIRE_AUTH', false)) {
    const expectedToken =
      process.env.GPT_DAG_BRIDGE_BEARER_TOKEN?.trim() ??
      process.env.OPENAI_ACTION_SHARED_SECRET?.trim() ??
      '';
    if (!expectedToken) {
      return buildErrorResponse(
        ctx,
        503,
        'GPT_DAG_BRIDGE_AUTH_NOT_CONFIGURED',
        'DAG bridge bearer authentication is required but not configured.',
        'dag_bridge_auth_not_configured'
      );
    }

    const providedToken = extractBearerToken(ctx.req);
    if (!providedToken || !timingSafeEqual(providedToken, expectedToken)) {
      return buildErrorResponse(
        ctx,
        401,
        'GPT_DAG_BRIDGE_UNAUTHORIZED',
        'DAG bridge bearer authentication failed.',
        'dag_bridge_unauthorized'
      );
    }
  }

  if (parseBooleanEnv('GPT_DAG_BRIDGE_REQUIRE_PERMISSIONS', false)) {
    const requiredPermission = getRequiredPermission(action);
    const permissions = getRequestPermissions(ctx.req);
    if (!permissions.has(requiredPermission)) {
      return buildErrorResponse(
        ctx,
        403,
        'GPT_DAG_BRIDGE_PERMISSION_DENIED',
        `DAG bridge action requires ${requiredPermission}.`,
        'dag_bridge_permission_denied',
        { requiredPermission }
      );
    }
  }

  return null;
}

export async function getDagCapabilities(ctx: GptDagBridgeContext): Promise<GptDagBridgeResponse> {
  const capabilities = {
    features: arcanosDagRunService.getFeatureFlags(),
    limits: arcanosDagRunService.getExecutionLimits(),
    graphs: [
      {
        graphId: DEFAULT_GRAPH_ID,
        template: TRINITY_CORE_DAG_TEMPLATE_NAME,
        actions: [...GPT_DAG_BRIDGE_ACTIONS],
      },
    ],
  };

  return {
    statusCode: 200,
    logEvent: 'gpt.response.dag_capabilities',
    payload: {
      ok: true,
      gptId: ctx.gptId,
      action: 'dag.capabilities',
      route: GPT_DISPATCHER_ROUTE,
      traceId: ctx.traceId,
      source: `gpt.${ctx.gptId}`,
      capabilities,
      data: capabilities,
      _route: buildRouteMeta(ctx, 'dag_capabilities'),
    },
  };
}

export async function dispatchDagRun(ctx: GptDagBridgeContext): Promise<GptDagBridgeResponse> {
  const payload = resolvePayload(ctx);
  const graphId = getGraphId(payload);
  const graphValidation = validateGraphId(graphId);
  if (!graphValidation.ok) {
    return buildErrorResponse(
      ctx,
      400,
      'DAG_GRAPH_UNSUPPORTED',
      `Unsupported DAG graph '${graphId}'.`,
      'dag_dispatch_invalid_graph',
      { graphId }
    );
  }

  const prompt = getSafePrompt(ctx);
  const input = {
    ...getSafeInputFromPayload(payload),
    ...(prompt ? { prompt } : {}),
  };
  if (Object.keys(input).length === 0) {
    return buildErrorResponse(
      ctx,
      400,
      'DAG_INPUT_REQUIRED',
      'dag.dispatch requires prompt or payload.input.',
      'dag_dispatch_input_required'
    );
  }

  const idempotencyKey = getIdempotencyKey(payload);
  const bridgeAsync = getBridgeAsync(payload);
  const bridgePriority = getBridgePriority();
  const dispatchPayload = {
    target: 'dag',
    source: `gpt.${ctx.gptId}`,
    sourceType: 'gpt',
    gptId: ctx.gptId,
    traceId: ctx.traceId,
    graphId,
    input,
    options: {
      async: bridgeAsync,
      priority: bridgePriority,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
    metadata: {
      route: GPT_DISPATCHER_ROUTE,
      action: 'dag.dispatch',
    },
  };

  const run = await arcanosDagRunService.createRun({
    sessionId: `gpt.${ctx.gptId}.${ctx.traceId}`,
    template: graphValidation.template,
    input,
    options: buildCreateRunOptions(payload),
  });

  return {
    statusCode: 202,
    logEvent: 'gpt.response.dag_dispatch',
    payload: {
      ok: true,
      gptId: ctx.gptId,
      action: 'dag.dispatch',
      route: GPT_DISPATCHER_ROUTE,
      traceId: ctx.traceId,
      source: `gpt.${ctx.gptId}`,
      sourceType: 'gpt',
      graphId,
      runId: run.runId,
      status: run.status,
      result: { run },
      dispatch: dispatchPayload,
      _route: buildRouteMeta(ctx, 'dag_dispatch'),
    },
  };
}

function readRunId(ctx: GptDagBridgeContext): string | null {
  return readString(resolvePayload(ctx).runId);
}

function validateRunId(runId: string | null): runId is string {
  return Boolean(runId && SAFE_RUN_ID_PATTERN.test(runId));
}

export async function getDagRunStatus(ctx: GptDagBridgeContext): Promise<GptDagBridgeResponse> {
  const runId = readRunId(ctx);
  if (!runId) {
    return buildErrorResponse(
      ctx,
      400,
      'DAG_RUN_ID_REQUIRED',
      'dag.status requires payload.runId.',
      'dag_status_run_id_required'
    );
  }
  if (!validateRunId(runId)) {
    return buildErrorResponse(
      ctx,
      400,
      'DAG_RUN_ID_INVALID',
      'payload.runId is not a valid DAG run identifier.',
      'dag_status_run_id_invalid'
    );
  }

  const waitedRun = await arcanosDagRunService.waitForRunUpdate(runId, {});
  if (!waitedRun) {
    return buildErrorResponse(ctx, 404, 'DAG_RUN_NOT_FOUND', 'DAG run was not found.', 'dag_status_not_found', {
      runId,
    });
  }

  const redactedRun = redactSensitive(waitedRun.run) as Record<string, unknown>;
  return {
    statusCode: 200,
    logEvent: 'gpt.response.dag_status',
    payload: {
      ok: true,
      gptId: ctx.gptId,
      action: 'dag.status',
      route: GPT_DISPATCHER_ROUTE,
      traceId: ctx.traceId,
      source: `gpt.${ctx.gptId}`,
      runId,
      status: redactedRun.status,
      result: { run: redactedRun },
      data: { run: redactedRun },
      _route: buildRouteMeta(ctx, 'dag_status'),
    },
  };
}

export async function getDagRunTrace(ctx: GptDagBridgeContext): Promise<GptDagBridgeResponse> {
  const runId = readRunId(ctx);
  if (!runId) {
    return buildErrorResponse(
      ctx,
      400,
      'DAG_RUN_ID_REQUIRED',
      'dag.trace requires payload.runId.',
      'dag_trace_run_id_required'
    );
  }
  if (!validateRunId(runId)) {
    return buildErrorResponse(
      ctx,
      400,
      'DAG_RUN_ID_INVALID',
      'payload.runId is not a valid DAG run identifier.',
      'dag_trace_run_id_invalid'
    );
  }

  const trace = await arcanosDagRunService.getRunTrace(runId);
  if (!trace) {
    return buildErrorResponse(ctx, 404, 'DAG_RUN_NOT_FOUND', 'DAG run was not found.', 'dag_trace_not_found', {
      runId,
    });
  }

  const redactedTrace = redactSensitive(trace) as Record<string, unknown>;
  return {
    statusCode: 200,
    logEvent: 'gpt.response.dag_trace',
    payload: {
      ok: true,
      gptId: ctx.gptId,
      action: 'dag.trace',
      route: GPT_DISPATCHER_ROUTE,
      traceId: ctx.traceId,
      source: `gpt.${ctx.gptId}`,
      runId,
      result: redactedTrace,
      data: redactedTrace,
      _route: buildRouteMeta(ctx, 'dag_trace'),
    },
  };
}

export async function handleGptDagBridge(ctx: GptDagBridgeContext): Promise<GptDagBridgeResponse> {
  const startedAtMs = Date.now();
  let response: GptDagBridgeResponse;
  let runId: string | null = null;
  let graphId: string | null = null;

  if (!isGptDagBridgeAction(ctx.action)) {
    response = buildErrorResponse(
      ctx,
      400,
      'GPT_DAG_ACTION_UNSUPPORTED',
      `Unsupported DAG bridge action '${ctx.action}'.`,
      'dag_bridge_unsupported_action',
      { supportedActions: [...GPT_DAG_BRIDGE_ACTIONS] }
    );
    logBridgeAudit({
      ctx,
      status: response.statusCode,
      latencyMs: Date.now() - startedAtMs,
      errorCode: response.payload.code as string,
    });
    return response;
  }

  const guardResponse = assertGptCanUseDag(ctx, ctx.action);
  if (guardResponse) {
    logBridgeAudit({
      ctx,
      status: guardResponse.statusCode,
      latencyMs: Date.now() - startedAtMs,
      errorCode: guardResponse.payload.code as string,
    });
    return guardResponse;
  }

  try {
    switch (ctx.action) {
      case 'dag.capabilities':
        response = await getDagCapabilities(ctx);
        break;
      case 'dag.dispatch':
        graphId = getGraphId(resolvePayload(ctx));
        response = await dispatchDagRun(ctx);
        runId = readString(response.payload.runId);
        break;
      case 'dag.status':
        runId = readRunId(ctx);
        response = await getDagRunStatus(ctx);
        break;
      case 'dag.trace':
        runId = readRunId(ctx);
        response = await getDagRunTrace(ctx);
        break;
    }
  } catch (error) {
    if (error instanceof UnsupportedDagTemplateError) {
      response = buildErrorResponse(
        ctx,
        400,
        'DAG_GRAPH_UNSUPPORTED',
        error.message,
        'dag_dispatch_invalid_graph'
      );
    } else {
      const message = resolveErrorMessage(error);
      response = buildErrorResponse(
        ctx,
        503,
        'DAG_BRIDGE_UNAVAILABLE',
        'DAG bridge action failed.',
        'dag_bridge_unavailable',
        { message }
      );
    }
  }

  logBridgeAudit({
    ctx,
    status: response.statusCode,
    latencyMs: Date.now() - startedAtMs,
    runId,
    graphId,
    errorCode: response.statusCode >= 400 ? readString(response.payload.code) : null,
  });
  return response;
}
