import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

import { getPool, isDatabaseConnected, query, transaction } from '@core/db/index.js';
import {
  findOrCreateGptJob,
  getJobById,
  getJobQueueSummary,
  IdempotencyKeyConflictError,
  JobRepositoryUnavailableError
} from '@core/db/repositories/jobRepository.js';
import { buildQueuedGptJobInput } from '@shared/gpt/asyncGptJob.js';
import {
  buildGptIdempotencyDescriptor,
  normalizeExplicitIdempotencyKey,
  summarizeFingerprintHash
} from '@shared/gpt/gptIdempotency.js';
import { buildGptJobResultLookupPayload, GPT_QUERY_ACTION } from '@shared/gpt/gptJobResult.js';
import { redactSensitive } from '@shared/redaction.js';
import { runtimeDiagnosticsService } from '@services/runtimeDiagnosticsService.js';
import { getWorkerControlHealth, getWorkerControlStatus } from '@services/workerControlService.js';
import { planAutonomousWorkerJob } from '@services/workerAutonomyService.js';
import { buildSafetySelfHealSnapshot } from '@services/selfHealRuntimeInspectionService.js';
import { getWorkerRuntimeStatus } from '@platform/runtime/workerConfig.js';

const SERVICE_VERSION = '1.0.0';
const TOKEN_ENV_NAME = 'ARCANOS_GPT_ACCESS_TOKEN';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TOKEN_LENGTH = 4096;
const LOG_LIMIT_MAX = 500;
const LOG_LIMIT_DEFAULT = 100;
const LOG_SINCE_MINUTES_MAX = 24 * 60;
const EXPLAIN_TIMEOUT_MS = 5000;
const MAX_AI_JOB_TASK_LENGTH = 8000;
const MAX_AI_JOB_CONTEXT_LENGTH = 12000;
const MAX_AI_JOB_INPUT_JSON_LENGTH = 12000;
const DEFAULT_AI_JOB_OUTPUT_TOKENS = 2048;
const MAX_AI_JOB_OUTPUT_TOKENS = 4096;
const MAX_AI_JOB_WORDS = 2000;
const GPT_ACCESS_JOB_CREATE_ENDPOINT = '/gpt-access/jobs/create';
const GPT_ACCESS_JOB_RESULT_ENDPOINT = '/gpt-access/jobs/result';
const MAX_CREATE_AI_JOB_VALIDATION_DEPTH = 64;
export const GPT_ACCESS_SUPPRESS_PROMPT_DEBUG_TRACE_FLAG = '__arcanosSuppressPromptDebugTrace';
const UNSAFE_CREATE_AI_JOB_FIELDS = new Set([
  '__proto__',
  'admin_key',
  'apikey',
  'api-key',
  'api_key',
  'sql',
  'command',
  'constructor',
  'exec',
  'target',
  'endpoint',
  'headers',
  'auth',
  'authorization',
  'bearer',
  'cookie',
  'cookies',
  'openai_api_key',
  'password',
  'prototype',
  'proxy',
  'railway_token',
  'secret',
  'shell',
  'token',
  'url'
]);
const GPT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/i;

type CreateAiJobPayloadValidationIssue =
  | { kind: 'unsafe_field'; field: string }
  | { kind: 'depth_exceeded'; maxDepth: number };

export const GPT_ACCESS_SCOPES = [
  'runtime.read',
  'workers.read',
  'queue.read',
  'jobs.create',
  'jobs.result',
  'logs.read_sanitized',
  'db.explain_approved',
  'mcp.approved_readonly',
  'capabilities.read',
  'capabilities.run',
  'diagnostics.read'
] as const;

export type GptAccessScope = (typeof GPT_ACCESS_SCOPES)[number];

const GPT_ACCESS_SCOPES_REQUIRING_EXPLICIT_CONFIG = new Set<GptAccessScope>([
  'jobs.create',
  'capabilities.read',
  'capabilities.run'
]);

export const GPT_ACCESS_MCP_TOOLS = [
  'runtime.inspect',
  'workers.status',
  'queue.inspect',
  'self_heal.status',
  'diagnostics'
] as const;

export type GptAccessMcpTool = (typeof GPT_ACCESS_MCP_TOOLS)[number];

export const GPT_ACCESS_EXPLAIN_QUERY_KEYS = [
  'worker_claim',
  'worker_liveliness_upsert',
  'queue_pending',
  'job_result_lookup'
] as const;

export type GptAccessExplainQueryKey = (typeof GPT_ACCESS_EXPLAIN_QUERY_KEYS)[number];

type GatewayErrorCode =
  | 'UNAUTHORIZED_GPT_ACCESS'
  | 'GPT_ACCESS_SCOPE_DENIED'
  | 'GPT_ACCESS_ROUTE_NOT_FOUND'
  | 'GPT_ACCESS_INTERNAL_ERROR'
  | 'GPT_ACCESS_JOBS_UNAVAILABLE'
  | 'GPT_ACCESS_WORKER_UNAVAILABLE'
  | 'GPT_ACCESS_QUEUE_UNAVAILABLE'
  | 'GPT_ACCESS_DB_UNAVAILABLE'
  | 'GPT_ACCESS_MCP_TOOL_UNAVAILABLE'
  | 'GPT_ACCESS_SELF_HEAL_UNAVAILABLE'
  | 'GPT_ACCESS_IDEMPOTENCY_CONFLICT'
  | 'LOG_QUERY_BACKEND_NOT_CONFIGURED'
  | 'DB_EXPLAIN_BACKEND_NOT_CONFIGURED'
  | 'GPT_ACCESS_VALIDATION_ERROR';

export interface GptAccessErrorPayload {
  ok: false;
  error: {
    code: GatewayErrorCode;
    message: string;
  };
}

export interface ApprovedExplainTemplate {
  sql: string;
  params: unknown[];
  summary: string;
}

interface GptAccessLogger {
  info?: (event: string, data?: Record<string, unknown>) => void;
  warn?: (event: string, data?: Record<string, unknown>) => void;
  error?: (event: string, data?: Record<string, unknown>) => void;
}

export interface CreateGptAccessAiJobContext {
  actorKey: string;
  requestId?: string;
  traceId?: string;
  idempotencyKey?: string | null;
  logger?: GptAccessLogger;
}

export interface GptAccessJobResultContext {
  actorKey: string;
  requestId?: string;
  traceId?: string;
  logger?: GptAccessLogger;
}

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema)
  ])
);

const createAiJobRequestSchema = z.object({
  gptId: z.string().trim().min(1).max(128).regex(GPT_ID_PATTERN),
  task: z.string().trim().min(1).max(MAX_AI_JOB_TASK_LENGTH),
  input: z.record(jsonValueSchema).optional().default({}),
  context: z.string().trim().max(MAX_AI_JOB_CONTEXT_LENGTH).optional(),
  maxOutputTokens: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_AI_JOB_OUTPUT_TOKENS)
    .optional()
    .default(DEFAULT_AI_JOB_OUTPUT_TOKENS),
  idempotencyKey: z.string().trim().min(1).max(256).optional()
}).strict().superRefine((value, ctx) => {
  if (getJsonStringLength(value.input) > MAX_AI_JOB_INPUT_JSON_LENGTH) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['input'],
      message: `input JSON must be ${MAX_AI_JOB_INPUT_JSON_LENGTH} characters or fewer`
    });
  }
});

function inspectCreateAiJobPayload(value: unknown): CreateAiJobPayloadValidationIssue | null {
  const stack: Array<{ value: unknown; path: string[]; depth: number }> = [{ value, path: [], depth: 0 }];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !current.value || typeof current.value !== 'object') {
      continue;
    }

    if (current.depth > MAX_CREATE_AI_JOB_VALIDATION_DEPTH) {
      return {
        kind: 'depth_exceeded',
        maxDepth: MAX_CREATE_AI_JOB_VALIDATION_DEPTH
      };
    }

    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({
          value: current.value[index],
          path: [...current.path, String(index)],
          depth: current.depth + 1
        });
      }
      continue;
    }

    const entries = Object.entries(current.value as Record<string, unknown>);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, entryValue] = entries[index];
      const normalizedKey = key.trim().toLowerCase();
      const currentPath = [...current.path, key];
      if (UNSAFE_CREATE_AI_JOB_FIELDS.has(normalizedKey)) {
        return {
          kind: 'unsafe_field',
          field: normalizedKey
        };
      }

      stack.push({
        value: entryValue,
        path: currentPath,
        depth: current.depth + 1
      });
    }
  }

  return null;
}

const mcpRequestSchema = z.object({
  tool: z.string().trim().min(1),
  args: z.record(z.unknown()).optional().default({})
}).strict();

const jobResultRequestSchema = z.object({
  jobId: z.string().trim().regex(UUID_PATTERN),
  traceId: z.string().trim().min(1).max(128).optional()
}).strict();

const logsQuerySchema = z.object({
  service: z.string().trim().min(1).max(128).optional(),
  level: z.enum(['error', 'warn', 'info', 'debug']).optional().default('info'),
  contains: z.string().trim().min(1).max(256).optional(),
  sinceMinutes: z.coerce.number().int().min(1).max(LOG_SINCE_MINUTES_MAX).optional().default(60),
  limit: z.coerce.number().int().min(1).max(LOG_LIMIT_MAX).optional().default(LOG_LIMIT_DEFAULT)
}).strict();

const deepDiagnosticsSchema = z.object({
  focus: z.string().trim().min(1).max(256).optional(),
  includeDb: z.boolean().optional().default(true),
  includeWorkers: z.boolean().optional().default(true),
  includeLogs: z.boolean().optional().default(true),
  includeQueue: z.boolean().optional().default(true)
}).strict();

const explainRequestSchema = z.object({
  queryKey: z.string().trim().min(1),
  params: z.record(z.unknown()).optional().default({})
}).strict();

function sendGatewayError(
  res: Response,
  statusCode: number,
  code: GatewayErrorCode,
  message: string = code
): void {
  const payload: GptAccessErrorPayload = {
    ok: false,
    error: {
      code,
      message
    }
  };
  res.status(statusCode).json(payload);
}

function getJsonStringLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function normalizeTraceId(value: string | undefined): string {
  const trimmedValue = typeof value === 'string' ? value.trim() : '';
  return trimmedValue.length > 0 && trimmedValue.length <= 128 ? trimmedValue : crypto.randomUUID();
}

function hashPromptForGatewayLog(prompt: string): string {
  return crypto
    .createHash('sha256')
    .update(prompt.replace(/\s+/g, ' ').trim(), 'utf8')
    .digest('hex')
    .slice(0, 12);
}

function getCreateAiJobValidationMessage(error: z.ZodError): string {
  const firstIssue = error.issues[0];
  const firstPath = firstIssue?.path.join('.') ?? '';

  if (firstPath === 'task') {
    return `task must be a non-empty string with at most ${MAX_AI_JOB_TASK_LENGTH} characters.`;
  }

  if (firstPath === 'gptId') {
    return 'gptId must be a non-empty string with at most 128 characters.';
  }

  if (firstPath === 'input') {
    return `input must be a JSON object no larger than ${MAX_AI_JOB_INPUT_JSON_LENGTH} characters.`;
  }

  if (firstPath === 'context') {
    return `context must be at most ${MAX_AI_JOB_CONTEXT_LENGTH} characters.`;
  }

  if (firstPath === 'maxOutputTokens') {
    return `maxOutputTokens must be an integer between 1 and ${MAX_AI_JOB_OUTPUT_TOKENS}.`;
  }

  if (firstPath === 'idempotencyKey') {
    return 'idempotencyKey must be a non-empty string with at most 256 characters.';
  }

  return 'Invalid AI job request.';
}

function mapStoredJobStatusToCreateStatus(
  status: unknown
): 'queued' | 'running' | 'completed' | 'failed' {
  switch (status) {
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'cancelled':
    case 'expired':
      return 'failed';
    case 'pending':
    default:
      return 'queued';
  }
}

function buildGatewayAiJobBody(input: z.infer<typeof createAiJobRequestSchema>): Record<string, unknown> {
  const maxWords = Math.min(MAX_AI_JOB_WORDS, input.maxOutputTokens);
  const payload: Record<string, unknown> = {
    task: input.task,
    input: input.input,
    source: 'gpt-access',
    maxOutputTokens: input.maxOutputTokens,
    maxWords
  };

  if (input.context && input.context.length > 0) {
    payload.context = input.context;
  }

  return {
    action: GPT_QUERY_ACTION,
    prompt: input.task,
    payload,
    executionMode: 'async',
    maxWords,
    [GPT_ACCESS_SUPPRESS_PROMPT_DEBUG_TRACE_FLAG]: true
  };
}

async function resolveGatewayGptRouting(gptId: string, requestId: string) {
  const { resolveGptRouting } = await import('@routes/_core/gptDispatch.js');
  return resolveGptRouting(gptId, requestId);
}

function isProductionEnvironment(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT === 'production';
}

function readConfiguredAccessToken(): string | null {
  const token = process.env[TOKEN_ENV_NAME];
  return typeof token === 'string' && token.trim().length > 0 ? token : null;
}

function timingSafeTokenEquals(providedToken: string, expectedToken: string): boolean {
  if (providedToken.length > MAX_TOKEN_LENGTH || expectedToken.length > MAX_TOKEN_LENGTH) {
    return false;
  }

  const providedDigest = crypto.createHash('sha256').update(providedToken, 'utf8').digest();
  const expectedDigest = crypto.createHash('sha256').update(expectedToken, 'utf8').digest();
  const digestMatches = crypto.timingSafeEqual(providedDigest, expectedDigest);
  return digestMatches && providedToken.length === expectedToken.length;
}

function readBearerToken(req: Request): string | null {
  const authorization = req.header('authorization');
  if (!authorization) {
    return null;
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return null;
  }

  const bearerValue = match[1]?.trim();
  return bearerValue && bearerValue.length <= MAX_TOKEN_LENGTH ? bearerValue : null;
}

function readBearerTokenStatus(req: Request):
  | { ok: true; bearerValue: string }
  | { ok: false; reason: 'missing_auth' | 'invalid_auth' } {
  const authorization = req.header('authorization');
  if (!authorization || authorization.trim().length === 0) {
    return { ok: false, reason: 'missing_auth' };
  }

  const bearerValue = readBearerToken(req);
  return bearerValue
    ? { ok: true, bearerValue }
    : { ok: false, reason: 'invalid_auth' };
}

export function gptAccessAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const expectedToken = readConfiguredAccessToken();
  if (!expectedToken) {
    const message = isProductionEnvironment()
      ? `${TOKEN_ENV_NAME} is required.`
      : `${TOKEN_ENV_NAME} is not configured.`;
    req.logger?.error?.('gpt_access.auth.failed', {
      route: req.originalUrl,
      reason: 'missing_server_token',
      statusCode: 500
    });
    sendGatewayError(res, 500, 'GPT_ACCESS_INTERNAL_ERROR', message);
    return;
  }

  const providedToken = readBearerTokenStatus(req);
  if (!providedToken.ok) {
    req.logger?.warn?.('gpt_access.auth.failed', {
      route: req.originalUrl,
      reason: providedToken.reason,
      statusCode: 401
    });
    sendGatewayError(
      res,
      401,
      'UNAUTHORIZED_GPT_ACCESS',
      providedToken.reason === 'missing_auth'
        ? 'Missing GPT access bearer token.'
        : 'Invalid GPT access authorization header.'
    );
    return;
  }

  if (!timingSafeTokenEquals(providedToken.bearerValue, expectedToken)) {
    req.logger?.warn?.('gpt_access.auth.failed', {
      route: req.originalUrl,
      reason: 'invalid_auth',
      statusCode: 401
    });
    sendGatewayError(res, 401, 'UNAUTHORIZED_GPT_ACCESS', 'Invalid GPT access bearer token.');
    return;
  }

  next();
}

type GptAccessScopeConfig = {
  configuredScopes: Set<GptAccessScope>;
  explicitScopes: Set<GptAccessScope>;
};

let cachedRawGptAccessScopes: string | undefined;
let cachedGptAccessScopeConfig: GptAccessScopeConfig | null = null;

function resolveConfiguredAccessScopes(): GptAccessScopeConfig {
  const rawScopes = process.env.ARCANOS_GPT_ACCESS_SCOPES;
  if (cachedGptAccessScopeConfig && rawScopes === cachedRawGptAccessScopes) {
    return cachedGptAccessScopeConfig;
  }

  cachedRawGptAccessScopes = rawScopes;
  if (!rawScopes) {
    cachedGptAccessScopeConfig = {
      configuredScopes: new Set(GPT_ACCESS_SCOPES),
      explicitScopes: new Set()
    };
    return cachedGptAccessScopeConfig;
  }

  const requestedScopes = new Set(
    rawScopes
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean)
  );

  const explicitScopes = new Set(GPT_ACCESS_SCOPES.filter((scope) => requestedScopes.has(scope)));
  cachedGptAccessScopeConfig = {
    configuredScopes: explicitScopes,
    explicitScopes
  };
  return cachedGptAccessScopeConfig;
}

function isGptAccessScopeExplicitlyConfigured(scope: GptAccessScope): boolean {
  return resolveConfiguredAccessScopes().explicitScopes.has(scope);
}

export function requireGptAccessScope(scope: GptAccessScope) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    if (
      GPT_ACCESS_SCOPES_REQUIRING_EXPLICIT_CONFIG.has(scope)
      && !isGptAccessScopeExplicitlyConfigured(scope)
    ) {
      sendGatewayError(res, 403, 'GPT_ACCESS_SCOPE_DENIED', 'GPT access scope denied.');
      return;
    }

    const { configuredScopes } = resolveConfiguredAccessScopes();
    if (!configuredScopes.has(scope)) {
      sendGatewayError(res, 403, 'GPT_ACCESS_SCOPE_DENIED', 'GPT access scope denied.');
      return;
    }

    next();
  };
}

export function buildGptAccessHealthPayload() {
  return {
    ok: true,
    service: 'arcanos-gpt-access',
    time: new Date().toISOString(),
    authRequired: true,
    version: SERVICE_VERSION
  };
}

const GPT_ACCESS_PUBLIC_BASE_URL_ENV_KEYS = [
  'ARCANOS_GPT_ACCESS_BASE_URL',
  'ARCANOS_BASE_URL',
  'ARCANOS_BACKEND_URL',
  'SERVER_URL',
  'BACKEND_URL',
  'PUBLIC_BASE_URL',
  'RAILWAY_PUBLIC_URL',
  'RAILWAY_PUBLIC_DOMAIN',
  'RAILWAY_STATIC_URL'
] as const;

function firstHeaderValue(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const first = value.split(',')[0]?.trim();
  return first && first.length > 0 ? first : null;
}

function normalizeOpenApiServerUrl(value: string | undefined | null): string | null {
  const trimmedValue = value?.trim();
  if (!trimmedValue) {
    return null;
  }

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmedValue)
    ? trimmedValue
    : `https://${trimmedValue}`;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
    if (parsed.protocol === 'http:' && !isLocalOpenApiHostname(parsed.hostname)) {
      return null;
    }
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    parsed.search = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/u, '');
    return parsed.toString().replace(/\/$/u, '');
  } catch {
    return null;
  }
}

function isLocalOpenApiHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized === '127.0.0.1'
    || normalized === '::1';
}

function isLocalOpenApiServerUrl(value: string): boolean {
  try {
    return isLocalOpenApiHostname(new URL(value).hostname);
  } catch {
    return false;
  }
}

function resolveRequestOrigin(req: Request | undefined): string | null {
  if (!req) {
    return null;
  }

  const host = firstHeaderValue(req.header('x-forwarded-host')) ?? firstHeaderValue(req.header('host'));
  if (!host) {
    return null;
  }

  const proto = firstHeaderValue(req.header('x-forwarded-proto')) ?? req.protocol ?? 'https';
  const normalizedProto = proto.toLowerCase() === 'http' ? 'http' : 'https';
  const origin = normalizeOpenApiServerUrl(`${normalizedProto}://${host}`);
  return origin && isLocalOpenApiServerUrl(origin) ? origin : null;
}

export function resolveGptAccessOpenApiServerUrl(req?: Request): string {
  for (const envName of GPT_ACCESS_PUBLIC_BASE_URL_ENV_KEYS) {
    const configuredUrl = normalizeOpenApiServerUrl(process.env[envName]);
    if (configuredUrl) {
      return configuredUrl;
    }
  }

  return resolveRequestOrigin(req) ?? 'http://localhost:3000';
}

function isAllowedMcpTool(tool: string): tool is GptAccessMcpTool {
  return (GPT_ACCESS_MCP_TOOLS as readonly string[]).includes(tool);
}

function isAllowedExplainQueryKey(queryKey: string): queryKey is GptAccessExplainQueryKey {
  return (GPT_ACCESS_EXPLAIN_QUERY_KEYS as readonly string[]).includes(queryKey);
}

function hasRawSqlField(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return false;
  }

  const record = body as Record<string, unknown>;
  return typeof record.sql === 'string' || typeof record.query === 'string' || typeof record.rawSql === 'string';
}

function normalizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(params).slice(0, 10);
  return Object.fromEntries(
    entries.map(([key, value]) => {
      if (typeof value === 'string') {
        return [key, value.trim().slice(0, 200)];
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        return [key, value];
      }
      if (typeof value === 'boolean' || value === null) {
        return [key, value];
      }
      return [key, null];
    })
  );
}

function readOptionalString(params: Record<string, unknown>, key: string, fallback: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    return fallback;
  }
  return value.trim().slice(0, 200);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isGptAccessCreatedJob(job: Awaited<ReturnType<typeof getJobById>>): boolean {
  if (!job || job.job_type !== 'gpt' || !isRecord(job.input)) {
    return false;
  }

  return (
    job.input.requestPath === GPT_ACCESS_JOB_CREATE_ENDPOINT &&
    job.input.executionModeReason === 'gpt_access_create_ai_job'
  );
}

function readOptionalUuid(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value === 'string' && UUID_PATTERN.test(value.trim())) {
    return value.trim();
  }
  return '00000000-0000-4000-8000-000000000000';
}

function readOptionalNumber(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = params[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.trunc(value);
}

export function buildApprovedExplainTemplate(
  queryKey: GptAccessExplainQueryKey,
  rawParams: Record<string, unknown> = {}
): ApprovedExplainTemplate {
  const params = normalizeParams(rawParams);

  switch (queryKey) {
    case 'worker_claim': {
      const priorityLaneMaxPriority = readOptionalNumber(params, 'priorityLaneMaxPriority', 50);
      return {
        sql: `SELECT id
              FROM job_data
              WHERE status = 'pending'
                AND next_run_at <= NOW()
                AND NOT (job_type = 'gpt' AND priority <= $1)
              ORDER BY priority ASC, next_run_at ASC, created_at ASC
              LIMIT 1`,
        params: [priorityLaneMaxPriority],
        summary: 'SELECT-only equivalent of the pending worker claim ordering path.'
      };
    }
    case 'worker_liveliness_upsert': {
      const workerId = readOptionalString(params, 'workerId', 'gpt-access-diagnostic-worker');
      return {
        sql: `SELECT worker_id, last_seen_at, health_status
              FROM worker_liveness
              WHERE worker_id = $1
              LIMIT 1`,
        params: [workerId],
        summary: 'SELECT-only equivalent for worker liveness lookup before an upsert path.'
      };
    }
    case 'queue_pending':
      return {
        sql: `SELECT
                COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
                COUNT(*) FILTER (WHERE status = 'running')::int AS running_count,
                COUNT(*) FILTER (WHERE status = 'pending' AND next_run_at > NOW())::int AS delayed_count,
                COUNT(*) FILTER (
                  WHERE status = 'running'
                    AND lease_expires_at IS NOT NULL
                    AND lease_expires_at < NOW()
                )::int AS stalled_running_count,
                COALESCE(MAX(
                  CASE
                    WHEN status = 'pending' AND next_run_at <= NOW()
                    THEN EXTRACT(EPOCH FROM (NOW() - created_at)) * 1000
                    ELSE 0
                  END
                ), 0)::bigint AS oldest_pending_age_ms
              FROM job_data`,
        params: [],
        summary: 'Read-only queue pending/running/delayed/stalled summary.'
      };
    case 'job_result_lookup': {
      const jobId = readOptionalUuid(params, 'jobId');
      return {
        sql: `SELECT id, status, created_at, updated_at, completed_at
              FROM job_data
              WHERE id = $1::uuid
              LIMIT 1`,
        params: [jobId],
        summary: 'Read-only job result lookup by approved UUID parameter.'
      };
    }
  }
}

function summarizeExplainPlan(planJson: unknown, fallbackSummary: string): Record<string, unknown> {
  const rootPlan = Array.isArray(planJson)
    ? (planJson[0] as Record<string, unknown> | undefined)
    : undefined;
  const plan = rootPlan?.Plan as Record<string, unknown> | undefined;

  return {
    description: fallbackSummary,
    nodeType: typeof plan?.['Node Type'] === 'string' ? plan['Node Type'] : null,
    relationName: typeof plan?.['Relation Name'] === 'string' ? plan['Relation Name'] : null,
    actualRows: typeof plan?.['Actual Rows'] === 'number' ? plan['Actual Rows'] : null,
    actualTotalTimeMs: typeof plan?.['Actual Total Time'] === 'number' ? plan['Actual Total Time'] : null,
    totalCost: typeof plan?.['Total Cost'] === 'number' ? plan['Total Cost'] : null
  };
}

export async function runApprovedDbExplain(queryKey: GptAccessExplainQueryKey, params: Record<string, unknown> = {}) {
  if (!isDatabaseConnected() || !getPool()) {
    return {
      configured: false,
      statusCode: 501,
      payload: {
        ok: false,
        error: {
          code: 'DB_EXPLAIN_BACKEND_NOT_CONFIGURED',
          message: 'Database explain backend is not configured.'
        }
      }
    };
  }

  const template = buildApprovedExplainTemplate(queryKey, params);
  const rows = await transaction(async (client) => {
    await client.query(`SET LOCAL statement_timeout = '${EXPLAIN_TIMEOUT_MS}ms'`);
    const result = await client.query(
      `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) ${template.sql}`,
      template.params
    );
    return result.rows;
  });
  const planJson = rows[0]?.['QUERY PLAN'] ?? null;

  return {
    configured: true,
    statusCode: 200,
    payload: {
      ok: true,
      queryKey,
      summary: summarizeExplainPlan(planJson, template.summary),
      plan: planJson
    }
  };
}

const STRING_REDACTIONS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_OPENAI_KEY]'],
  [/\b(?:railway|rwy)[_-]?[A-Za-z0-9]{16,}\b/gi, '[REDACTED_RAILWAY_TOKEN]'],
  [/\b(?:postgres|postgresql|mysql|mongodb):\/\/[^\s"'<>]+/gi, '[REDACTED_DATABASE_URL]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]'],
  [/\b(?:authorization|cookie|set-cookie|api[_-]?key|token|secret|password|session(?:id)?|database_url)\s*[:=]\s*["']?[^"'\s,;}]+/gi, '$1=[REDACTED]'],
  [/\b(email|password)\s*[:=]\s*["']?[^"'\s,;}]+/gi, '$1=[REDACTED]']
];
const PROMPT_LOG_FIELD_KEYS = new Set(['prompt', 'rawprompt', 'normalizedprompt', 'task']);

export function sanitizeGptAccessString(value: string): string {
  return STRING_REDACTIONS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    value
  );
}

export function sanitizeGptAccessPayload(payload: unknown): unknown {
  const redacted = redactSensitive(payload);
  return sanitizeStringsDeep(redacted);
}

function sanitizeStringsDeep(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeGptAccessString(value);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeStringsDeep);
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
      const normalizedKey = key.toLowerCase();
      if (normalizedKey === 'email' || normalizedKey.includes('password')) {
        return [key, '[REDACTED]'];
      }
      if (PROMPT_LOG_FIELD_KEYS.has(normalizedKey)) {
        return [key, '[REDACTED_PROMPT]'];
      }
      return [key, sanitizeStringsDeep(entry)];
    })
  );
}

export async function querySanitizedBackendLogs(input: z.infer<typeof logsQuerySchema>) {
  if (!isDatabaseConnected() || !getPool()) {
    return {
      configured: false,
      statusCode: 501,
      payload: {
        ok: false,
        error: {
          code: 'LOG_QUERY_BACKEND_NOT_CONFIGURED',
          message: 'Backend log query storage is not configured.'
        }
      }
    };
  }

  const filters: string[] = [
    "timestamp > NOW() - ($1::bigint * INTERVAL '1 minute')",
    'level = $2'
  ];
  const params: unknown[] = [input.sinceMinutes, input.level];

  if (input.service) {
    params.push(input.service);
    filters.push(`worker_id = $${params.length}`);
  }

  if (input.contains) {
    params.push(`%${input.contains}%`);
    filters.push(`(message ILIKE $${params.length} OR metadata::text ILIKE $${params.length})`);
  }

  params.push(input.limit);
  const limitIndex = params.length;
  const result = await query(
    `SELECT worker_id, timestamp, level, message, metadata
       FROM execution_logs
       WHERE ${filters.join(' AND ')}
       ORDER BY timestamp DESC
       LIMIT $${limitIndex}`,
    params
  );

  return {
    configured: true,
    statusCode: 200,
    payload: {
      ok: true,
      count: result.rows.length,
      logs: sanitizeGptAccessPayload(result.rows)
    }
  };
}

export async function getGptAccessJobResult(body: unknown, context?: GptAccessJobResultContext) {
  const parsed = jobResultRequestSchema.safeParse(body);
  if (!parsed.success) {
    return {
      statusCode: 400,
      payload: {
        ok: false,
        error: {
          code: 'GPT_ACCESS_VALIDATION_ERROR',
          message: 'jobId must be a valid job UUID.'
        }
      }
    };
  }

  const traceId =
    parsed.data.traceId ??
    (typeof context?.traceId === 'string' && context.traceId.trim().length > 0
      ? context.traceId.trim()
      : null);

  if (!isDatabaseConnected()) {
    return {
      statusCode: 503,
      payload: {
        ok: false,
        traceId,
        error: {
          code: 'GPT_ACCESS_JOBS_UNAVAILABLE',
          message: 'Durable GPT job persistence is unavailable.'
        }
      }
    };
  }

  let job: Awaited<ReturnType<typeof getJobById>>;
  try {
    job = await getJobById(parsed.data.jobId);
  } catch (error: unknown) {
    context?.logger?.error?.('gpt_access.job_result.failed', {
      traceId,
      requestType: 'getJobResult',
      status: 'jobs_unavailable',
      errorType: error instanceof Error ? error.name : 'unknown'
    });
    return {
      statusCode: 503,
      payload: {
        ok: false,
        traceId,
        error: {
          code: 'GPT_ACCESS_JOBS_UNAVAILABLE',
          message: 'Durable GPT job persistence is unavailable.'
        }
      }
    };
  }

  const gatewayJob = isGptAccessCreatedJob(job) ? job : null;
  return {
    statusCode: 200,
    payload: sanitizeGptAccessPayload({
      ok: true,
      traceId,
      ...buildGptAccessJobResultLookupPayload(parsed.data.jobId, gatewayJob)
    })
  };
}

function buildGptAccessJobResultLookupPayload(
  jobId: string,
  job: Awaited<ReturnType<typeof getJobById>> | null
) {
  return {
    ...buildGptJobResultLookupPayload(jobId, job),
    poll: GPT_ACCESS_JOB_RESULT_ENDPOINT,
    stream: GPT_ACCESS_JOB_RESULT_ENDPOINT,
    resultEndpoint: GPT_ACCESS_JOB_RESULT_ENDPOINT
  };
}

export async function createGptAccessAiJob(body: unknown, context: CreateGptAccessAiJobContext) {
  const traceId = normalizeTraceId(context.traceId);
  const payloadIssue = inspectCreateAiJobPayload(body);
  if (payloadIssue?.kind === 'unsafe_field') {
    context.logger?.warn?.('gpt_access.ai_job.rejected', {
      traceId,
      requestType: 'createAiJob',
      status: 'validation_failed',
      unsafeField: payloadIssue.field
    });
    return {
      statusCode: 400,
      payload: {
        ok: false,
        error: {
          code: 'GPT_ACCESS_VALIDATION_ERROR',
          message: 'Unsafe field is not allowed for AI job creation.'
        }
      }
    };
  }

  if (payloadIssue?.kind === 'depth_exceeded') {
    context.logger?.warn?.('gpt_access.ai_job.rejected', {
      traceId,
      requestType: 'createAiJob',
      status: 'validation_failed',
      reason: 'payload_depth_exceeded',
      maxDepth: payloadIssue.maxDepth
    });
    return {
      statusCode: 400,
      payload: {
        ok: false,
        error: {
          code: 'GPT_ACCESS_VALIDATION_ERROR',
          message: `AI job request nesting depth must be ${payloadIssue.maxDepth} levels or fewer.`
        }
      }
    };
  }

  const parsed = createAiJobRequestSchema.safeParse(body);
  if (!parsed.success) {
    context.logger?.warn?.('gpt_access.ai_job.rejected', {
      traceId,
      requestType: 'createAiJob',
      status: 'validation_failed'
    });
    return {
      statusCode: 400,
      payload: {
        ok: false,
        error: {
          code: 'GPT_ACCESS_VALIDATION_ERROR',
          message: getCreateAiJobValidationMessage(parsed.error)
        }
      }
    };
  }

  const request = parsed.data;
  const bodyIdempotencyKey = normalizeExplicitIdempotencyKey(request.idempotencyKey);
  const headerIdempotencyKey = normalizeExplicitIdempotencyKey(context.idempotencyKey);
  if (bodyIdempotencyKey && headerIdempotencyKey && bodyIdempotencyKey !== headerIdempotencyKey) {
    context.logger?.warn?.('gpt_access.ai_job.rejected', {
      traceId,
      requestType: 'createAiJob',
      gptId: request.gptId,
      status: 'idempotency_key_mismatch'
    });
    return {
      statusCode: 400,
      payload: {
        ok: false,
        error: {
          code: 'GPT_ACCESS_VALIDATION_ERROR',
          message: 'idempotencyKey must match the Idempotency-Key header when both are supplied.'
        }
      }
    };
  }
  const explicitIdempotencyKey = headerIdempotencyKey ?? bodyIdempotencyKey;
  context.logger?.info?.('gpt_access.ai_job.requested', {
    traceId,
    requestType: 'createAiJob',
    gptId: request.gptId,
    promptLength: request.task.length,
    promptHash: hashPromptForGatewayLog(request.task),
    status: 'validating'
  });

  const routeResolution = await resolveGatewayGptRouting(request.gptId, context.requestId ?? traceId);
  if (!routeResolution.ok) {
    context.logger?.warn?.('gpt_access.ai_job.rejected', {
      traceId,
      requestType: 'createAiJob',
      gptId: request.gptId,
      status: 'unknown_gpt'
    });
    return {
      statusCode: 400,
      payload: {
        ok: false,
        error: {
          code: 'GPT_ACCESS_VALIDATION_ERROR',
          message: 'Unknown or unauthorized gptId.'
        }
      }
    };
  }

  const aiJobBody = buildGatewayAiJobBody(request);
  const descriptor = buildGptIdempotencyDescriptor({
    gptId: request.gptId,
    action: GPT_QUERY_ACTION,
    body: aiJobBody,
    actorKey: context.actorKey,
    explicitIdempotencyKey
  });
  const queuedInput = buildQueuedGptJobInput({
    gptId: request.gptId,
    body: aiJobBody,
    prompt: request.task,
    bypassIntentRouting: true,
    requestId: context.requestId ?? traceId,
    routeHint: GPT_QUERY_ACTION,
    requestPath: GPT_ACCESS_JOB_CREATE_ENDPOINT,
    executionModeReason: 'gpt_access_create_ai_job'
  });

  try {
    const plannedJob = await planAutonomousWorkerJob('gpt', queuedInput);
    const createResult = await findOrCreateGptJob({
      workerId: process.env.WORKER_ID || 'gpt-access',
      input: queuedInput,
      requestFingerprintHash: descriptor.fingerprintHash,
      idempotencyScopeHash: descriptor.scopeHash,
      idempotencyKeyHash: descriptor.source === 'explicit' ? descriptor.idempotencyKeyHash : null,
      idempotencyOrigin: descriptor.source,
      createOptions: plannedJob
    });

    context.logger?.info?.('gpt_access.ai_job.enqueued', {
      traceId,
      requestType: 'createAiJob',
      gptId: request.gptId,
      jobId: createResult.job.id,
      status: mapStoredJobStatusToCreateStatus(createResult.job.status),
      deduped: createResult.deduped,
      fingerprintHash: summarizeFingerprintHash(descriptor.fingerprintHash),
      scopeHash: summarizeFingerprintHash(descriptor.scopeHash)
    });

    if (!UUID_PATTERN.test(createResult.job.id)) {
      context.logger?.error?.('gpt_access.ai_job.failed', {
        traceId,
        requestType: 'createAiJob',
        gptId: request.gptId,
        jobId: createResult.job.id,
        status: 'invalid_job_id'
      });
      return {
        statusCode: 500,
        payload: {
          ok: false,
          error: {
            code: 'GPT_ACCESS_INTERNAL_ERROR',
            message: 'Created AI job did not return a valid UUID jobId.'
          }
        }
      };
    }

    return {
      statusCode: 202,
      payload: {
        ok: true,
        jobId: createResult.job.id,
        traceId,
        status: mapStoredJobStatusToCreateStatus(createResult.job.status),
        deduped: Boolean(createResult.deduped),
        resultEndpoint: GPT_ACCESS_JOB_RESULT_ENDPOINT
      }
    };
  } catch (error: unknown) {
    if (error instanceof IdempotencyKeyConflictError) {
      context.logger?.warn?.('gpt_access.ai_job.rejected', {
        traceId,
        requestType: 'createAiJob',
        gptId: request.gptId,
        status: 'idempotency_conflict'
      });
      return {
        statusCode: 409,
        payload: {
          ok: false,
          error: {
            code: 'GPT_ACCESS_IDEMPOTENCY_CONFLICT',
            message: 'The supplied idempotency key is already bound to a different GPT request.'
          }
        }
      };
    }

    if (error instanceof JobRepositoryUnavailableError) {
      context.logger?.error?.('gpt_access.ai_job.failed', {
        traceId,
        requestType: 'createAiJob',
        gptId: request.gptId,
        status: 'jobs_unavailable',
        errorType: error.name
      });
      return {
        statusCode: 503,
        payload: {
          ok: false,
          error: {
            code: 'GPT_ACCESS_JOBS_UNAVAILABLE',
            message: 'Durable GPT job persistence is unavailable.'
          }
        }
      };
    }

    context.logger?.error?.('gpt_access.ai_job.failed', {
      traceId,
      requestType: 'createAiJob',
      gptId: request.gptId,
      status: 'failed',
      errorType: error instanceof Error ? error.name : 'unknown'
    });
    return {
      statusCode: 500,
      payload: {
        ok: false,
        error: {
          code: 'GPT_ACCESS_INTERNAL_ERROR',
          message: 'Failed to create AI job.'
        }
      }
    };
  }
}

function normalizeDbCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function normalizeDbTimestamp(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

async function getSelfReflectionStorageStatus() {
  if (!isDatabaseConnected()) {
    return {
      configured: false,
      status: 'unavailable',
      message: 'Self-reflection persistence is unavailable because the database is not connected.',
      total: 0,
      latestCreatedAt: null,
      categories: []
    };
  }

  try {
    const [summaryResult, categoryResult] = await Promise.all([
      query(
        `SELECT COUNT(*)::int AS total, MAX(created_at) AS latest_created_at
           FROM self_reflections`
      ),
      query(
        `SELECT category, COUNT(*)::int AS total, MAX(created_at) AS latest_created_at
           FROM self_reflections
           GROUP BY category
           ORDER BY latest_created_at DESC NULLS LAST
           LIMIT 10`
      )
    ]);
    const summaryRow = summaryResult.rows[0] as Record<string, unknown> | undefined;

    return {
      configured: true,
      status: 'ok',
      total: normalizeDbCount(summaryRow?.total),
      latestCreatedAt: normalizeDbTimestamp(summaryRow?.latest_created_at),
      categories: categoryResult.rows.map((rowRaw: unknown) => {
        const row = rowRaw as Record<string, unknown>;
        return {
          category: typeof row.category === 'string' ? row.category : 'unknown',
          total: normalizeDbCount(row.total),
          latestCreatedAt: normalizeDbTimestamp(row.latest_created_at)
        };
      })
    };
  } catch {
    return {
      configured: true,
      status: 'unavailable',
      message: 'Self-reflection persistence could not be inspected.',
      total: null,
      latestCreatedAt: null,
      categories: []
    };
  }
}

export async function getGptAccessSelfHealStatus() {
  try {
    const selfReflection = await getSelfReflectionStorageStatus();
    return {
      statusCode: 200,
      payload: sanitizeGptAccessPayload({
        ok: true,
        tool: 'self_heal.status',
        result: buildSafetySelfHealSnapshot(),
        selfReflection
      })
    };
  } catch {
    return {
      statusCode: 503,
      payload: {
        ok: false,
        error: {
          code: 'GPT_ACCESS_SELF_HEAL_UNAVAILABLE',
          message: 'Self-heal status is unavailable.'
        }
      }
    };
  }
}

export async function getGptAccessQueueInspection() {
  try {
    return {
      statusCode: 200,
      payload: sanitizeGptAccessPayload({
        ok: true,
        tool: 'queue.inspect',
        result: await getJobQueueSummary()
      })
    };
  } catch {
    return {
      statusCode: 503,
      payload: {
        ok: false,
        error: {
          code: 'GPT_ACCESS_QUEUE_UNAVAILABLE',
          message: 'Queue inspection is unavailable.'
        }
      }
    };
  }
}

export async function runGptAccessMcpTool(body: unknown) {
  const parsed = mcpRequestSchema.safeParse(body);
  if (!parsed.success || !isAllowedMcpTool(parsed.data.tool)) {
    return {
      statusCode: 403,
      payload: {
        ok: false,
        error: {
          code: 'GPT_ACCESS_SCOPE_DENIED',
          message: 'Requested MCP tool is not allowlisted for GPT access.'
        }
      }
    };
  }

  const { tool } = parsed.data;
  switch (tool) {
    case 'runtime.inspect':
      return {
        statusCode: 200,
        payload: {
          ok: true,
          tool,
          result: runtimeDiagnosticsService.getHealthSnapshot()
        }
      };
    case 'workers.status':
      try {
        return {
          statusCode: 200,
          payload: sanitizeGptAccessPayload({
            ok: true,
            tool,
            result: await getWorkerControlStatus()
          })
        };
      } catch {
        return {
          statusCode: 503,
          payload: {
            ok: false,
            error: {
              code: 'GPT_ACCESS_WORKER_UNAVAILABLE',
              message: 'Worker status is unavailable.'
            }
          }
        };
      }
    case 'queue.inspect':
      return getGptAccessQueueInspection();
    case 'self_heal.status':
      return getGptAccessSelfHealStatus();
    case 'diagnostics':
      try {
        const [workers, queue, selfHealResult] = await Promise.all([
          getWorkerControlStatus(),
          getJobQueueSummary(),
          getGptAccessSelfHealStatus()
        ]);

        return {
          statusCode: 200,
          payload: sanitizeGptAccessPayload({
            ok: true,
            tool,
            result: {
              runtime: runtimeDiagnosticsService.getHealthSnapshot(),
              workers,
              queue,
              selfHeal: selfHealResult.payload
            }
          })
        };
      } catch {
        return {
          statusCode: 503,
          payload: {
            ok: false,
            error: {
              code: 'GPT_ACCESS_MCP_TOOL_UNAVAILABLE',
              message: 'Requested MCP diagnostic tool is unavailable.'
            }
          }
        };
      }
  }
}

export async function runDeepDiagnostics(body: unknown) {
  const parsed = deepDiagnosticsSchema.safeParse(body);
  if (!parsed.success) {
    return {
      statusCode: 400,
      payload: {
        ok: false,
        error: {
          code: 'GPT_ACCESS_VALIDATION_ERROR',
          message: 'Invalid diagnostics request.'
        }
      }
    };
  }

  const input = parsed.data;
  const traceId = crypto.randomUUID();
  const observations: unknown[] = [];
  const risks: string[] = [];
  const recommendedNextActions: string[] = [];

  const runtime = runtimeDiagnosticsService.getHealthSnapshot();
  observations.push({ area: 'runtime', status: runtime.status, uptime: runtime.uptime });

  let workers: unknown = null;
  if (input.includeWorkers) {
    try {
      workers = await getWorkerControlStatus();
      observations.push({ area: 'workers', status: 'collected' });
    } catch {
      risks.push('Worker status collection failed.');
    }
  }

  let helperHealth: unknown = null;
  if (input.includeWorkers) {
    try {
      helperHealth = await getWorkerControlHealth();
      observations.push({ area: 'worker-helper', status: 'collected' });
    } catch {
      risks.push('Worker helper health collection failed.');
    }
  }

  let queue: unknown = null;
  if (input.includeQueue) {
    try {
      queue = await getJobQueueSummary();
      observations.push({ area: 'queue', status: queue ? 'collected' : 'unavailable' });
    } catch {
      risks.push('Queue inspection failed.');
    }
  }

  let db: unknown = null;
  if (input.includeDb) {
    try {
      const explain = await runApprovedDbExplain('queue_pending', {});
      db = explain.payload;
      observations.push({ area: 'db', status: explain.configured ? 'explain_collected' : 'unavailable' });
    } catch {
      risks.push('Approved DB explain failed.');
    }
  }

  let logs: unknown = null;
  if (input.includeLogs) {
    try {
      const logsResult = await querySanitizedBackendLogs({
        level: 'error',
        sinceMinutes: 60,
        limit: 25
      });
      logs = logsResult.payload;
      observations.push({ area: 'logs', status: logsResult.configured ? 'collected' : 'unavailable' });
    } catch {
      risks.push('Sanitized log query failed.');
    }
  }

  if (risks.length > 0) {
    recommendedNextActions.push('Inspect unavailable diagnostics directly from the approved endpoint that failed.');
  }

  return {
    statusCode: 200,
    payload: sanitizeGptAccessPayload({
      ok: true,
      traceId,
      summary: input.focus
        ? `Read-only diagnostics collected for ${input.focus}.`
        : 'Read-only diagnostics collected.',
      observations,
      risks,
      recommendedNextActions,
      data: {
        runtime,
        workers,
        workerHelperHealth: helperHealth,
        queue,
        db,
        logs,
        workerRuntime: getWorkerRuntimeStatus()
      }
    })
  };
}

export async function explainApprovedQuery(body: unknown) {
  if (hasRawSqlField(body)) {
    return {
      statusCode: 403,
      payload: {
        ok: false,
        error: {
          code: 'GPT_ACCESS_SCOPE_DENIED',
          message: 'Raw SQL is not allowed through GPT access.'
        }
      }
    };
  }

  const parsed = explainRequestSchema.safeParse(body);
  if (!parsed.success || !isAllowedExplainQueryKey(parsed.data.queryKey)) {
    return {
      statusCode: 403,
      payload: {
        ok: false,
        error: {
          code: 'GPT_ACCESS_SCOPE_DENIED',
          message: 'Requested queryKey is not approved for GPT access.'
        }
      }
    };
  }

  try {
    return await runApprovedDbExplain(parsed.data.queryKey, parsed.data.params);
  } catch {
    return {
      statusCode: 500,
      payload: {
        ok: false,
        error: {
          code: 'GPT_ACCESS_INTERNAL_ERROR',
          message: 'Approved DB explain failed.'
        }
      }
    };
  }
}

export async function queryBackendLogs(body: unknown) {
  const parsed = logsQuerySchema.safeParse(body);
  if (!parsed.success) {
    return {
      statusCode: 400,
      payload: {
        ok: false,
        error: {
          code: 'GPT_ACCESS_VALIDATION_ERROR',
          message: 'Invalid log query request.'
        }
      }
    };
  }

  try {
    return await querySanitizedBackendLogs(parsed.data);
  } catch {
    return {
      statusCode: 500,
      payload: {
        ok: false,
        error: {
          code: 'GPT_ACCESS_INTERNAL_ERROR',
          message: 'Sanitized log query failed.'
        }
      }
    };
  }
}

export function buildGptAccessOpenApiDocument(options: { serverUrl?: string } = {}) {
  const serverUrl = normalizeOpenApiServerUrl(options.serverUrl) ?? resolveGptAccessOpenApiServerUrl();
  const protectedSecurity = [{ bearerAuth: [] }];

  return {
    openapi: '3.1.0',
    info: {
      title: 'ARCANOS GPT Access Gateway',
      version: SERVICE_VERSION,
      description: 'Scoped gateway for approved ARCANOS runtime, worker, queue, async AI job, job-result, log, database explain, MCP, capability, and diagnostics actions.'
    },
    servers: [
      {
        url: serverUrl
      }
    ],
    security: protectedSecurity,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'opaque'
        }
      },
      schemas: {
        ErrorResponse: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', const: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                message: { type: 'string' }
              },
              required: ['code', 'message']
            }
          },
          required: ['ok', 'error'],
          additionalProperties: false
        },
        CreateAiJobRequest: {
          type: 'object',
          description: 'Strict async AI job creation request. Unsafe transport/proxy fields such as sql, target, endpoint, headers, auth, cookies, proxy, and url are rejected at runtime, including inside input.',
          properties: {
            gptId: {
              type: 'string',
              minLength: 1,
              maxLength: 128,
              pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$'
            },
            task: { type: 'string', minLength: 1, maxLength: MAX_AI_JOB_TASK_LENGTH },
            input: {
              type: 'object',
              additionalProperties: true,
              description: `Optional JSON object, serialized length limited to ${MAX_AI_JOB_INPUT_JSON_LENGTH} characters. Unsafe transport/proxy keys are not allowed.`
            },
            context: { type: 'string', maxLength: MAX_AI_JOB_CONTEXT_LENGTH },
            maxOutputTokens: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_AI_JOB_OUTPUT_TOKENS,
              default: DEFAULT_AI_JOB_OUTPUT_TOKENS
            },
            idempotencyKey: {
              type: 'string',
              minLength: 1,
              maxLength: 256,
              description: 'Optional client idempotency key. Equivalent to the Idempotency-Key header.'
            }
          },
          required: ['gptId', 'task'],
          additionalProperties: false
        },
        CreateAiJobResponse: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', const: true },
            jobId: { type: 'string', format: 'uuid' },
            traceId: { type: 'string' },
            status: {
              type: 'string',
              enum: ['queued', 'running', 'completed', 'failed']
            },
            deduped: { type: 'boolean' },
            resultEndpoint: { type: 'string', const: GPT_ACCESS_JOB_RESULT_ENDPOINT }
          },
          required: ['ok', 'jobId', 'traceId', 'status', 'deduped', 'resultEndpoint'],
          additionalProperties: false
        },
        JobResultRequest: {
          type: 'object',
          properties: {
            jobId: { type: 'string', format: 'uuid' },
            traceId: { type: 'string' }
          },
          required: ['jobId'],
          additionalProperties: false
        },
        JobResultError: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            message: { type: 'string' },
            details: {
              type: 'object',
              additionalProperties: true
            }
          },
          required: ['code', 'message'],
          additionalProperties: true
        },
        JobResultResponse: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', const: true },
            traceId: { type: ['string', 'null'] },
            jobId: { type: 'string', format: 'uuid' },
            status: {
              type: 'string',
              enum: ['pending', 'completed', 'failed', 'expired', 'not_found']
            },
            jobStatus: { type: ['string', 'null'] },
            lifecycleStatus: { type: 'string' },
            createdAt: { type: ['string', 'null'] },
            updatedAt: { type: ['string', 'null'] },
            completedAt: { type: ['string', 'null'] },
            retentionUntil: { type: ['string', 'null'] },
            idempotencyUntil: { type: ['string', 'null'] },
            expiresAt: { type: ['string', 'null'] },
            poll: { type: 'string' },
            stream: { type: 'string' },
            resultEndpoint: { type: 'string', const: GPT_ACCESS_JOB_RESULT_ENDPOINT },
            result: {},
            error: {
              anyOf: [
                { '$ref': '#/components/schemas/JobResultError' },
                { type: 'null' }
              ]
            }
          },
          required: [
            'ok',
            'jobId',
            'status',
            'jobStatus',
            'lifecycleStatus',
            'createdAt',
            'updatedAt',
            'completedAt',
            'retentionUntil',
            'idempotencyUntil',
            'expiresAt',
            'poll',
            'stream',
            'resultEndpoint',
            'result',
            'error'
          ],
          additionalProperties: true
        },
        McpControlRequest: {
          type: 'object',
          properties: {
            tool: {
              type: 'string',
              enum: [...GPT_ACCESS_MCP_TOOLS]
            },
            args: { type: 'object', additionalProperties: true }
          },
          required: ['tool'],
          additionalProperties: false
        },
        GatewayToolResponse: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', const: true },
            tool: { type: 'string' },
            result: {},
            selfReflection: {
              type: 'object',
              additionalProperties: true
            }
          },
          required: ['ok', 'tool'],
          additionalProperties: true
        },
        CapabilityV1Summary: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            description: { type: ['string', 'null'] },
            route: { type: ['string', 'null'] },
            actions: {
              type: 'array',
              items: { type: 'string' }
            }
          },
          required: ['id', 'description', 'route', 'actions'],
          additionalProperties: false
        },
        CapabilityV1Detail: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            description: { type: ['string', 'null'] },
            route: { type: ['string', 'null'] },
            actions: {
              type: 'array',
              items: { type: 'string' }
            },
            defaultAction: { type: ['string', 'null'] },
            defaultTimeoutMs: { type: ['integer', 'null'] }
          },
          required: ['id', 'name', 'description', 'route', 'actions', 'defaultAction', 'defaultTimeoutMs'],
          additionalProperties: false
        },
        CapabilitiesV1Response: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', const: true },
            capabilities: {
              type: 'array',
              items: { '$ref': '#/components/schemas/CapabilityV1Summary' }
            }
          },
          required: ['ok', 'capabilities'],
          additionalProperties: false
        },
        CapabilityV1DetailResponse: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', const: true },
            exists: { type: 'boolean' },
            capability: {
              anyOf: [
                { '$ref': '#/components/schemas/CapabilityV1Detail' },
                { type: 'null' }
              ]
            }
          },
          required: ['ok', 'exists', 'capability'],
          additionalProperties: false
        },
        CapabilityRunRequest: {
          type: 'object',
          properties: {
            action: { type: 'string', minLength: 1, pattern: '.*\\S.*' },
            payload: {
              description: 'Optional JSON payload passed to the selected capability action.'
            }
          },
          required: ['action'],
          additionalProperties: false
        },
        CapabilityRunResponse: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', const: true },
            result: {
              description: 'Capability action result.'
            }
          },
          required: ['ok', 'result'],
          additionalProperties: false
        }
      }
    },
    paths: {
      '/gpt-access/health': {
        get: {
          operationId: 'arcanosAccessHealth',
          summary: 'Check the GPT access gateway health.',
          security: protectedSecurity,
          responses: {
            '200': {
              description: 'Gateway health payload.'
            },
            '401': { description: 'Unauthorized.', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } }
          }
        }
      },
      '/gpt-access/status': {
        get: {
          operationId: 'getRuntimeStatus',
          summary: 'Get sanitized runtime status.',
          security: protectedSecurity,
          responses: { '200': { description: 'Runtime status.' } }
        }
      },
      '/gpt-access/workers/status': {
        get: {
          operationId: 'getWorkersStatus',
          summary: 'Get worker and queue-observed status.',
          security: protectedSecurity,
          responses: { '200': { description: 'Worker status.' } }
        }
      },
      '/gpt-access/worker-helper/health': {
        get: {
          operationId: 'getWorkerHelperHealth',
          summary: 'Get worker helper health.',
          security: protectedSecurity,
          responses: { '200': { description: 'Worker helper health.' } }
        }
      },
      '/gpt-access/queue/inspect': {
        get: {
          operationId: 'inspectQueue',
          summary: 'Inspect the durable GPT/job queue without using /gpt/:gptId.',
          security: protectedSecurity,
          responses: {
            '200': {
              description: 'Queue inspection payload.',
              content: {
                'application/json': {
                  schema: { '$ref': '#/components/schemas/GatewayToolResponse' }
                }
              }
            },
            '401': { description: 'Unauthorized.', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Scope denied.', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } },
            '503': { description: 'Queue unavailable.', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } }
          }
        }
      },
      '/gpt-access/self-heal/status': {
        get: {
          operationId: 'getSelfHealStatus',
          summary: 'Read self-heal and self-reflection status without using /gpt/:gptId.',
          security: protectedSecurity,
          responses: {
            '200': {
              description: 'Self-heal and self-reflection status payload.',
              content: {
                'application/json': {
                  schema: { '$ref': '#/components/schemas/GatewayToolResponse' }
                }
              }
            },
            '401': { description: 'Unauthorized.', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Scope denied.', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } },
            '503': { description: 'Self-heal unavailable.', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } }
          }
        }
      },
      '/gpt-access/capabilities/v1': {
        get: {
          operationId: 'listCapabilitiesV1',
          summary: 'List GPT Access capabilities backed by connected runtime modules.',
          description: 'Returns a safe capability projection from the existing module registry. Handlers, secrets, GPT bindings, and implementation details are not exposed.',
          security: protectedSecurity,
          responses: {
            '200': {
              description: 'Capability list.',
              content: {
                'application/json': {
                  schema: { '$ref': '#/components/schemas/CapabilitiesV1Response' }
                }
              }
            },
            '401': { description: 'Unauthorized.', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Scope denied.', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } }
          }
        }
      },
      '/gpt-access/capabilities/v1/{id}': {
        get: {
          operationId: 'getCapabilityV1',
          summary: 'Inspect one GPT Access capability.',
          security: protectedSecurity,
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 }
            }
          ],
          responses: {
            '200': {
              description: 'Capability lookup payload. Unknown capabilities return exists=false.',
              content: {
                'application/json': {
                  schema: { '$ref': '#/components/schemas/CapabilityV1DetailResponse' }
                }
              }
            },
            '401': { description: 'Unauthorized.', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Scope denied.', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } }
          }
        }
      },
      '/gpt-access/capabilities/v1/{id}/run': {
        post: {
          operationId: 'runCapabilityV1',
          summary: 'Run one action on a GPT Access capability.',
          description: 'Executes through the existing module dispatch boundary. The capabilities.run scope must be explicitly configured, the module action must be allowlisted, and the request must pass the confirmation gate before this endpoint can execute actions.',
          security: protectedSecurity,
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 }
            },
            {
              name: 'x-confirmed',
              in: 'header',
              required: false,
              schema: { type: 'string' },
              description: 'Use "yes" for explicit operator approval, or the confirmGate challenge response format when retrying a challenged request.'
            }
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { '$ref': '#/components/schemas/CapabilityRunRequest' }
              }
            }
          },
          responses: {
            '200': {
              description: 'Capability action result.',
              content: {
                'application/json': {
                  schema: { '$ref': '#/components/schemas/CapabilityRunResponse' }
                }
              }
            },
            '400': { description: 'Invalid request.', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Unauthorized.', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Scope denied or module action not allowlisted.', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Capability or action not found.', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } },
            '500': { description: 'Unexpected capability execution failure.', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } }
          }
        }
      },
      '/gpt-access/modules': {
        get: {
          operationId: 'listGptAccessModulesAlias',
          summary: 'Compatibility alias for listing GPT Access capabilities.',
          description: 'Returns the same JSON as /gpt-access/capabilities/v1.',
          security: protectedSecurity,
          responses: {
            '200': {
              description: 'Capability list.',
              content: {
                'application/json': {
                  schema: { '$ref': '#/components/schemas/CapabilitiesV1Response' }
                }
              }
            },
            '401': { description: 'Unauthorized.', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Scope denied.', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } }
          }
        }
      },
      '/gpt-access/modules/{id}': {
        get: {
          operationId: 'getGptAccessModuleAlias',
          summary: 'Compatibility alias for inspecting one GPT Access capability.',
          description: 'Returns the same JSON shape as /gpt-access/capabilities/v1/{id}.',
          security: protectedSecurity,
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 }
            }
          ],
          responses: {
            '200': {
              description: 'Capability lookup payload. Unknown capabilities return exists=false.',
              content: {
                'application/json': {
                  schema: { '$ref': '#/components/schemas/CapabilityV1DetailResponse' }
                }
              }
            },
            '401': { description: 'Unauthorized.', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Scope denied.', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } }
          }
        }
      },
      '/gpt-access/jobs/create': {
        post: {
          operationId: 'createAiJob',
          summary: 'Create an async backend AI generation job.',
          description: 'Queues one protected backend AI generation request through the approved GPT access gateway. Use /gpt-access/jobs/result with the returned jobId to read completion.',
          security: protectedSecurity,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { '$ref': '#/components/schemas/CreateAiJobRequest' }
              }
            }
          },
          responses: {
            '202': {
              description: 'AI job queued.',
              content: {
                'application/json': {
                  schema: { '$ref': '#/components/schemas/CreateAiJobResponse' }
                }
              }
            },
            '400': { description: 'Invalid request.', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Unauthorized.', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Scope denied.', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } },
            '409': { description: 'Idempotency conflict.', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } },
            '503': { description: 'Jobs backend unavailable.', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } }
          }
        }
      },
      '/gpt-access/jobs/result': {
        post: {
          operationId: 'getJobResult',
          summary: 'Read an async job result without using /gpt/:gptId.',
          security: protectedSecurity,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { '$ref': '#/components/schemas/JobResultRequest' }
              }
            }
          },
          responses: {
            '200': {
              description: 'Job result lookup payload.',
              content: {
                'application/json': {
                  schema: { '$ref': '#/components/schemas/JobResultResponse' }
                }
              }
            },
            '400': { description: 'Invalid request.', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Unauthorized.', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Scope denied.', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } },
            '503': { description: 'Jobs backend unavailable.', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } }
          }
        }
      },
      '/gpt-access/diagnostics/deep': {
        post: {
          operationId: 'runDeepDiagnostics',
          summary: 'Run approved read-only deep diagnostics.',
          security: protectedSecurity,
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    focus: { type: 'string' },
                    includeDb: { type: 'boolean' },
                    includeWorkers: { type: 'boolean' },
                    includeLogs: { type: 'boolean' },
                    includeQueue: { type: 'boolean' }
                  },
                  additionalProperties: false
                }
              }
            }
          },
          responses: { '200': { description: 'Diagnostics payload.' } }
        }
      },
      '/gpt-access/db/explain': {
        post: {
          operationId: 'explainApprovedQuery',
          summary: 'Run EXPLAIN for an approved read-only query template.',
          security: protectedSecurity,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    queryKey: {
                      type: 'string',
                      enum: [...GPT_ACCESS_EXPLAIN_QUERY_KEYS]
                    },
                    params: { type: 'object', additionalProperties: true }
                  },
                  required: ['queryKey'],
                  additionalProperties: false
                }
              }
            }
          },
          responses: {
            '200': { description: 'EXPLAIN JSON plan.' },
            '403': { description: 'Query denied.', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } }
          }
        }
      },
      '/gpt-access/logs/query': {
        post: {
          operationId: 'queryBackendLogs',
          summary: 'Query sanitized backend logs if an internal log store is configured.',
          security: protectedSecurity,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    service: { type: 'string' },
                    level: { type: 'string', enum: ['error', 'warn', 'info', 'debug'] },
                    contains: { type: 'string' },
                    sinceMinutes: { type: 'integer', minimum: 1, maximum: LOG_SINCE_MINUTES_MAX },
                    limit: { type: 'integer', minimum: 1, maximum: LOG_LIMIT_MAX }
                  },
                  additionalProperties: false
                }
              }
            }
          },
          responses: {
            '200': { description: 'Sanitized logs.' },
            '501': { description: 'Log query backend not configured.', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } }
          }
        }
      },
      '/gpt-access/mcp': {
        post: {
          operationId: 'arcanosMcpControl',
          summary: 'Run an approved read-only MCP-style control tool.',
          security: protectedSecurity,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { '$ref': '#/components/schemas/McpControlRequest' }
              }
            }
          },
          responses: {
            '200': {
              description: 'Tool result.',
              content: {
                'application/json': {
                  schema: { '$ref': '#/components/schemas/GatewayToolResponse' }
                }
              }
            },
            '401': { description: 'Unauthorized.', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Tool denied.', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } },
            '503': { description: 'Tool unavailable.', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } }
          }
        }
      },
      '/gpt-access/openapi.json': {
        get: {
          operationId: 'getGptAccessOpenApi',
          summary: 'Get the GPT access OpenAPI document.',
          security: [],
          responses: { '200': { description: 'OpenAPI document.' } }
        }
      }
    }
  };
}

export function sendGptAccessResult(res: Response, result: { statusCode: number; payload: unknown }): void {
  res.status(result.statusCode).json(result.payload);
}
