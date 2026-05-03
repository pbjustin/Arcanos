export const APPROVED_DB_EXPLAIN_KEYS = [
  'worker_claim',
  'worker_liveliness_upsert',
  'queue_pending',
  'job_result_lookup'
] as const;

export type ApprovedDbExplainKey = (typeof APPROVED_DB_EXPLAIN_KEYS)[number];

export const APPROVED_MCP_TOOLS = [
  'runtime.inspect',
  'workers.status',
  'queue.inspect',
  'self_heal.status',
  'diagnostics'
] as const;

export type ApprovedMcpTool = (typeof APPROVED_MCP_TOOLS)[number];

export const APPROVED_CONTROL_PLANE_ENDPOINTS = {
  status: '/gpt-access/status',
  workersStatus: '/gpt-access/workers/status',
  workerHelperHealth: '/gpt-access/worker-helper/health',
  queueInspect: '/gpt-access/queue/inspect',
  selfHealStatus: '/gpt-access/self-heal/status',
  diagnosticsDeep: '/gpt-access/diagnostics/deep',
  dbExplain: '/gpt-access/db/explain',
  logsQuery: '/gpt-access/logs/query',
  mcp: '/gpt-access/mcp',
  jobsResult: '/gpt-access/jobs/result'
} as const;

export const APPROVED_GPT_REASONING_ENDPOINTS = {
  jobsCreate: '/gpt-access/jobs/create',
  jobsResult: '/gpt-access/jobs/result'
} as const;

export type ApprovedControlPlaneEndpoint =
  (typeof APPROVED_CONTROL_PLANE_ENDPOINTS)[keyof typeof APPROVED_CONTROL_PLANE_ENDPOINTS];

export type ApprovedGptReasoningEndpoint =
  (typeof APPROVED_GPT_REASONING_ENDPOINTS)[keyof typeof APPROVED_GPT_REASONING_ENDPOINTS];

export type ApprovedGptAccessEndpoint = ApprovedControlPlaneEndpoint | ApprovedGptReasoningEndpoint;

export type GptAccessHttpMethod = 'GET' | 'POST';

export interface GptAccessTransportRequest {
  method: GptAccessHttpMethod;
  path: ApprovedGptAccessEndpoint;
  body?: unknown;
}

export interface GptAccessClientResult<TPayload = unknown> {
  endpoint: ApprovedGptAccessEndpoint;
  statusCode?: number;
  payload: TPayload;
}

export interface GptAccessTransport {
  request<TPayload = unknown>(
    request: GptAccessTransportRequest
  ): Promise<GptAccessClientResult<TPayload>>;
}

export type OperatorControlPlaneTool =
  | 'status'
  | 'workers.status'
  | 'worker_helper.health'
  | 'queue.inspect'
  | 'self_heal.status'
  | 'diagnostics.deep'
  | 'db.explain'
  | 'logs.query'
  | 'mcp.runtime.inspect'
  | 'mcp.workers.status'
  | 'mcp.queue.inspect'
  | 'mcp.self_heal.status'
  | 'mcp.diagnostics'
  | 'jobs.result';

export interface GptAccessDeepDiagnosticsRequest {
  focus?: string;
  includeDb?: boolean;
  includeWorkers?: boolean;
  includeLogs?: boolean;
  includeQueue?: boolean;
}

export interface GptAccessDbExplainRequest {
  queryKey: ApprovedDbExplainKey;
  params?: Record<string, unknown>;
}

export interface GptAccessLogsQueryRequest {
  service?: string;
  level?: 'error' | 'warn' | 'info' | 'debug';
  contains?: string;
  sinceMinutes?: number;
  limit?: number;
}

export interface GptAccessMcpRequest {
  tool: ApprovedMcpTool;
  args?: Record<string, unknown>;
}

export interface GptAccessJobResultRequest {
  jobId: string;
  traceId?: string;
}

export interface FetchGptAccessTransportOptions {
  baseUrl: string;
  accessToken: string;
  fetchFn?: OperatorFetchLike;
}

export type OperatorFetchLike = (
  input: URL,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  }
) => Promise<{
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APPROVED_GPT_ACCESS_ENDPOINT_VALUES = new Set<string>([
  ...Object.values(APPROVED_CONTROL_PLANE_ENDPOINTS),
  ...Object.values(APPROVED_GPT_REASONING_ENDPOINTS)
]);
const UNSAFE_TRANSPORT_FIELDS = new Set([
  'proto',
  'apikey',
  'adminkey',
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
  'header',
  'href',
  'openaiapikey',
  'password',
  'prototype',
  'proxy',
  'proxyurl',
  'rawheaders',
  'rawsql',
  'railwaytoken',
  'secret',
  'shell',
  'sql',
  'target',
  'token',
  'transport',
  'uri',
  'url'
]);
const UNSAFE_TRANSPORT_FIELD_FRAGMENTS = [
  'apikey',
  'authorization',
  'bearer',
  'callbackurl',
  'cookie',
  'endpoint',
  'header',
  'href',
  'password',
  'proxy',
  'rawheader',
  'rawsql',
  'secret',
  'sql',
  'target',
  'transport',
  'uri',
  'url'
];
const UNSAFE_TOKEN_FIELD_FRAGMENTS = [
  'accesstoken',
  'authtoken',
  'bearertoken',
  'openaitoken',
  'railwaytoken',
  'refreshtoken',
  'sessiontoken'
];

export class OperatorControlPlaneRequestError extends Error {
  readonly code = 'OPERATOR_CONTROL_PLANE_REQUEST_REJECTED';

  constructor(message: string) {
    super(message);
    this.name = 'OperatorControlPlaneRequestError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fail(message: string): never {
  throw new OperatorControlPlaneRequestError(message);
}

function normalizeFieldName(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isUnsafeTransportFieldName(key: string): boolean {
  const normalizedKey = normalizeFieldName(key);
  return UNSAFE_TRANSPORT_FIELDS.has(normalizedKey) ||
    UNSAFE_TRANSPORT_FIELD_FRAGMENTS.some((fragment) => normalizedKey.includes(fragment)) ||
    UNSAFE_TOKEN_FIELD_FRAGMENTS.some((fragment) => normalizedKey.includes(fragment));
}

function formatPath(path: string[]): string {
  return path.length > 0 ? path.join('.') : '<root>';
}

function assertApprovedGptAccessPath(path: unknown): asserts path is ApprovedGptAccessEndpoint {
  if (typeof path !== 'string' || path.length === 0) {
    fail('GPT access request path must be an approved relative endpoint.');
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//')) {
    fail('GPT access request path must not be an absolute URL.');
  }

  if (!APPROVED_GPT_ACCESS_ENDPOINT_VALUES.has(path)) {
    fail(`GPT access request path "${path}" is not approved.`);
  }
}

export function assertNoUnsafeTransportFields(value: unknown, label: string = 'request'): void {
  const stack: Array<{ value: unknown; path: string[]; ancestors: object[] }> = [{
    value,
    path: [],
    ancestors: []
  }];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !current.value || typeof current.value !== 'object') {
      continue;
    }

    const objectValue = current.value as object;
    if (current.ancestors.includes(objectValue)) {
      fail(`${label} must not contain circular objects at ${formatPath(current.path)}.`);
    }
    const nextAncestors = [...current.ancestors, objectValue];

    if (Array.isArray(current.value)) {
      current.value.forEach((entry, index) => {
        stack.push({ value: entry, path: [...current.path, String(index)], ancestors: nextAncestors });
      });
      continue;
    }

    Object.entries(current.value as Record<string, unknown>).forEach(([key, entry]) => {
      if (isUnsafeTransportFieldName(key)) {
        fail(`${label} contains unsafe transport field "${key}".`);
      }
      stack.push({ value: entry, path: [...current.path, key], ancestors: nextAncestors });
    });
  }
}

export function isApprovedDbExplainKey(value: string): value is ApprovedDbExplainKey {
  return (APPROVED_DB_EXPLAIN_KEYS as readonly string[]).includes(value);
}

export function isApprovedMcpTool(value: string): value is ApprovedMcpTool {
  return (APPROVED_MCP_TOOLS as readonly string[]).includes(value);
}

function assertApprovedDbExplainKey(value: string): asserts value is ApprovedDbExplainKey {
  if (!isApprovedDbExplainKey(value)) {
    fail(`DB explain queryKey "${value}" is not approved.`);
  }
}

function assertApprovedMcpTool(value: string): asserts value is ApprovedMcpTool {
  if (!isApprovedMcpTool(value)) {
    fail(`MCP tool "${value}" is not approved.`);
  }
}

function assertUuid(value: string, label: string): void {
  if (!UUID_PATTERN.test(value.trim())) {
    fail(`${label} must be a UUID.`);
  }
}

function normalizeOptionalRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function normalizeBaseUrl(baseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    fail('GPT access baseUrl must be a valid http(s) URL configured outside the operator request.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail('GPT access baseUrl must use http or https.');
  }

  return parsed;
}

function resolveFetchFn(fetchFn?: OperatorFetchLike): OperatorFetchLike {
  if (fetchFn) {
    return fetchFn;
  }

  if (typeof globalThis.fetch !== 'function') {
    fail('A fetch implementation is required for GPT access transport.');
  }

  return globalThis.fetch as unknown as OperatorFetchLike;
}

export function createFetchGptAccessTransport(
  options: FetchGptAccessTransportOptions
): GptAccessTransport {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const gatewayCredential = options.accessToken.trim();
  if (!gatewayCredential) {
    fail('GPT access token must be configured outside the operator request.');
  }
  const fetchFn = resolveFetchFn(options.fetchFn);

  return {
    async request<TPayload = unknown>(
      request: GptAccessTransportRequest
    ): Promise<GptAccessClientResult<TPayload>> {
      assertApprovedGptAccessPath(request.path);
      const url = new URL(request.path, baseUrl);
      const headers: Record<string, string> = {
        accept: 'application/json',
        authorization: `Bearer ${gatewayCredential}`
      };
      let body: string | undefined;

      if (request.method === 'POST') {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(request.body ?? {});
      }

      const response = await fetchFn(url, {
        method: request.method,
        headers,
        ...(body ? { body } : {})
      });

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        payload = await response.text();
      }

      return {
        endpoint: request.path,
        statusCode: response.status,
        payload: payload as TPayload
      };
    }
  };
}

export class OperatorControlPlaneClient {
  constructor(private readonly transport: GptAccessTransport) {}

  async getStatus(): Promise<GptAccessClientResult> {
    return this.transport.request({
      method: 'GET',
      path: APPROVED_CONTROL_PLANE_ENDPOINTS.status
    });
  }

  async getWorkersStatus(): Promise<GptAccessClientResult> {
    return this.transport.request({
      method: 'GET',
      path: APPROVED_CONTROL_PLANE_ENDPOINTS.workersStatus
    });
  }

  async getWorkerHelperHealth(): Promise<GptAccessClientResult> {
    return this.transport.request({
      method: 'GET',
      path: APPROVED_CONTROL_PLANE_ENDPOINTS.workerHelperHealth
    });
  }

  async getQueueInspection(): Promise<GptAccessClientResult> {
    return this.transport.request({
      method: 'GET',
      path: APPROVED_CONTROL_PLANE_ENDPOINTS.queueInspect
    });
  }

  async getSelfHealStatus(): Promise<GptAccessClientResult> {
    return this.transport.request({
      method: 'GET',
      path: APPROVED_CONTROL_PLANE_ENDPOINTS.selfHealStatus
    });
  }

  async runDeepDiagnostics(
    input: GptAccessDeepDiagnosticsRequest = {}
  ): Promise<GptAccessClientResult> {
    assertNoUnsafeTransportFields(input, 'diagnostics request');
    return this.transport.request({
      method: 'POST',
      path: APPROVED_CONTROL_PLANE_ENDPOINTS.diagnosticsDeep,
      body: {
        ...(input.focus ? { focus: input.focus } : {}),
        ...(typeof input.includeDb === 'boolean' ? { includeDb: input.includeDb } : {}),
        ...(typeof input.includeWorkers === 'boolean' ? { includeWorkers: input.includeWorkers } : {}),
        ...(typeof input.includeLogs === 'boolean' ? { includeLogs: input.includeLogs } : {}),
        ...(typeof input.includeQueue === 'boolean' ? { includeQueue: input.includeQueue } : {})
      }
    });
  }

  async explainApprovedQuery(
    input: GptAccessDbExplainRequest
  ): Promise<GptAccessClientResult> {
    assertNoUnsafeTransportFields(input, 'DB explain request');
    assertApprovedDbExplainKey(input.queryKey);
    return this.transport.request({
      method: 'POST',
      path: APPROVED_CONTROL_PLANE_ENDPOINTS.dbExplain,
      body: {
        queryKey: input.queryKey,
        params: normalizeOptionalRecord(input.params)
      }
    });
  }

  async queryLogs(input: GptAccessLogsQueryRequest = {}): Promise<GptAccessClientResult> {
    assertNoUnsafeTransportFields(input, 'logs query request');
    return this.transport.request({
      method: 'POST',
      path: APPROVED_CONTROL_PLANE_ENDPOINTS.logsQuery,
      body: {
        ...(input.service ? { service: input.service } : {}),
        ...(input.level ? { level: input.level } : {}),
        ...(input.contains ? { contains: input.contains } : {}),
        ...(typeof input.sinceMinutes === 'number' ? { sinceMinutes: input.sinceMinutes } : {}),
        ...(typeof input.limit === 'number' ? { limit: input.limit } : {})
      }
    });
  }

  async runMcpTool(input: GptAccessMcpRequest): Promise<GptAccessClientResult> {
    assertNoUnsafeTransportFields(input, 'MCP request');
    assertApprovedMcpTool(input.tool);
    return this.transport.request({
      method: 'POST',
      path: APPROVED_CONTROL_PLANE_ENDPOINTS.mcp,
      body: {
        tool: input.tool,
        args: normalizeOptionalRecord(input.args)
      }
    });
  }

  async getJobResult(input: GptAccessJobResultRequest): Promise<GptAccessClientResult> {
    assertNoUnsafeTransportFields(input, 'job result request');
    assertUuid(input.jobId, 'jobId');
    return this.transport.request({
      method: 'POST',
      path: APPROVED_CONTROL_PLANE_ENDPOINTS.jobsResult,
      body: {
        jobId: input.jobId.trim(),
        ...(input.traceId ? { traceId: input.traceId } : {})
      }
    });
  }
}

export function createControlPlaneClient(transport: GptAccessTransport): OperatorControlPlaneClient {
  return new OperatorControlPlaneClient(transport);
}
