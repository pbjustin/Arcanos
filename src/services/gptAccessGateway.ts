import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

import { getPool, isDatabaseConnected, query, transaction } from '@core/db/index.js';
import { getJobById, getJobQueueSummary } from '@core/db/repositories/jobRepository.js';
import { buildGptJobResultLookupPayload } from '@shared/gpt/gptJobResult.js';
import { redactSensitive } from '@shared/redaction.js';
import { runtimeDiagnosticsService } from '@services/runtimeDiagnosticsService.js';
import { getWorkerControlHealth, getWorkerControlStatus } from '@services/workerControlService.js';
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

export const GPT_ACCESS_SCOPES = [
  'runtime.read',
  'workers.read',
  'queue.read',
  'jobs.result',
  'logs.read_sanitized',
  'db.explain_approved',
  'mcp.approved_readonly',
  'diagnostics.read'
] as const;

export type GptAccessScope = (typeof GPT_ACCESS_SCOPES)[number];

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
  | 'GPT_ACCESS_INTERNAL_ERROR'
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

export function gptAccessAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const expectedToken = readConfiguredAccessToken();
  if (!expectedToken) {
    const message = isProductionEnvironment()
      ? `${TOKEN_ENV_NAME} is required.`
      : `${TOKEN_ENV_NAME} is not configured.`;
    sendGatewayError(res, 500, 'GPT_ACCESS_INTERNAL_ERROR', message);
    return;
  }

  const providedToken = readBearerToken(req);
  if (!providedToken || !timingSafeTokenEquals(providedToken, expectedToken)) {
    sendGatewayError(res, 401, 'UNAUTHORIZED_GPT_ACCESS', 'Valid GPT access bearer token required.');
    return;
  }

  next();
}

function resolveConfiguredAccessScopes(): Set<GptAccessScope> {
  const rawScopes = process.env.ARCANOS_GPT_ACCESS_SCOPES;
  if (!rawScopes) {
    return new Set(GPT_ACCESS_SCOPES);
  }

  const requestedScopes = new Set(
    rawScopes
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean)
  );

  return new Set(GPT_ACCESS_SCOPES.filter((scope) => requestedScopes.has(scope)));
}

export function requireGptAccessScope(scope: GptAccessScope) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    const configuredScopes = resolveConfiguredAccessScopes();
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
      if (key.toLowerCase() === 'email' || key.toLowerCase().includes('password')) {
        return [key, '[REDACTED]'];
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

export async function getGptAccessJobResult(body: unknown) {
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

  const job = await getJobById(parsed.data.jobId);
  return {
    statusCode: 200,
    payload: sanitizeGptAccessPayload({
      ok: true,
      traceId: parsed.data.traceId ?? null,
      ...buildGptJobResultLookupPayload(parsed.data.jobId, job)
    })
  };
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
      return {
        statusCode: 200,
        payload: {
          ok: true,
          tool,
          result: await getWorkerControlStatus()
        }
      };
    case 'queue.inspect':
      return {
        statusCode: 200,
        payload: {
          ok: true,
          tool,
          result: await getJobQueueSummary()
        }
      };
    case 'self_heal.status':
      return {
        statusCode: 200,
        payload: {
          ok: true,
          tool,
          result: sanitizeGptAccessPayload(buildSafetySelfHealSnapshot())
        }
      };
    case 'diagnostics':
      return {
        statusCode: 200,
        payload: {
          ok: true,
          tool,
          result: {
            runtime: runtimeDiagnosticsService.getHealthSnapshot(),
            workers: await getWorkerControlStatus(),
            selfHeal: sanitizeGptAccessPayload(buildSafetySelfHealSnapshot())
          }
        }
      };
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

export function buildGptAccessOpenApiDocument() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'ARCANOS GPT Access Gateway',
      version: SERVICE_VERSION,
      description: 'Scoped read-only gateway for approved ARCANOS runtime, worker, queue, job, log, database explain, MCP, and diagnostics actions.'
    },
    servers: [
      {
        url: 'https://acranos-production.up.railway.app'
      }
    ],
    security: [
      {
        bearerAuth: []
      }
    ],
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
          required: ['ok', 'error']
        }
      }
    },
    paths: {
      '/gpt-access/health': {
        get: {
          operationId: 'arcanosAccessHealth',
          summary: 'Check the GPT access gateway health.',
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
          responses: { '200': { description: 'Runtime status.' } }
        }
      },
      '/gpt-access/workers/status': {
        get: {
          operationId: 'getWorkersStatus',
          summary: 'Get worker and queue-observed status.',
          responses: { '200': { description: 'Worker status.' } }
        }
      },
      '/gpt-access/worker-helper/health': {
        get: {
          operationId: 'getWorkerHelperHealth',
          summary: 'Get worker helper health.',
          responses: { '200': { description: 'Worker helper health.' } }
        }
      },
      '/gpt-access/jobs/result': {
        post: {
          operationId: 'getJobResult',
          summary: 'Read an async job result without using /gpt/:gptId.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    jobId: { type: 'string' },
                    traceId: { type: 'string' }
                  },
                  required: ['jobId'],
                  additionalProperties: false
                }
              }
            }
          },
          responses: { '200': { description: 'Job result lookup payload.' } }
        }
      },
      '/gpt-access/diagnostics/deep': {
        post: {
          operationId: 'runDeepDiagnostics',
          summary: 'Run approved read-only deep diagnostics.',
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
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
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
                }
              }
            }
          },
          responses: {
            '200': { description: 'Tool result.' },
            '403': { description: 'Tool denied.', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } }
          }
        }
      },
      '/gpt-access/openapi.json': {
        get: {
          operationId: 'getGptAccessOpenApi',
          summary: 'Get the GPT access OpenAPI document.',
          responses: { '200': { description: 'OpenAPI document.' } }
        }
      }
    }
  };
}

export function sendGptAccessResult(res: Response, result: { statusCode: number; payload: unknown }): void {
  res.status(result.statusCode).json(result.payload);
}
