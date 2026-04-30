import {
  APPROVED_CONTROL_PLANE_ENDPOINTS,
  assertNoUnsafeTransportFields,
  isApprovedDbExplainKey,
  type ApprovedDbExplainKey,
  type ApprovedMcpTool,
  type GptAccessClientResult,
  type GptAccessDbExplainRequest,
  type GptAccessDeepDiagnosticsRequest,
  type GptAccessJobResultRequest,
  type GptAccessLogsQueryRequest,
  type OperatorControlPlaneTool
} from './controlPlaneClient.js';
import {
  type CreateReasoningJobRequest,
  type GptReasoningPort,
  type JsonValue
} from './gptReasoningClient.js';

export type OperatorIntentRouteKind = 'control_plane' | 'gpt_reasoning' | 'hybrid';

export interface OperatorIntentClassification {
  routeKind: OperatorIntentRouteKind;
  confidence: number;
  matchedSignals: string[];
  selectedTool: OperatorControlPlaneTool | 'gpt_reasoning.jobs.create';
  reason: string;
}

export interface OperatorControlPlanePort {
  getStatus(): Promise<GptAccessClientResult>;
  getWorkersStatus(): Promise<GptAccessClientResult>;
  getWorkerHelperHealth(): Promise<GptAccessClientResult>;
  runDeepDiagnostics(input?: GptAccessDeepDiagnosticsRequest): Promise<GptAccessClientResult>;
  explainApprovedQuery(input: GptAccessDbExplainRequest): Promise<GptAccessClientResult>;
  queryLogs(input?: GptAccessLogsQueryRequest): Promise<GptAccessClientResult>;
  runMcpTool(input: { tool: ApprovedMcpTool; args?: Record<string, unknown> }): Promise<GptAccessClientResult>;
  getJobResult(input: GptAccessJobResultRequest): Promise<GptAccessClientResult>;
}

export interface OperatorIntentDispatcherClients {
  controlPlane: OperatorControlPlanePort;
  reasoning: GptReasoningPort;
}

export interface OperatorDispatchRequest {
  input: string;
  clients: OperatorIntentDispatcherClients;
  gptId?: string;
  inputContext?: Record<string, unknown>;
  context?: string;
  maxOutputTokens?: number;
  idempotencyKey?: string;
  controlPlaneInput?: Record<string, unknown>;
}

export interface OperatorControlPlaneTraceMetadata {
  selectedTool: OperatorControlPlaneTool;
  endpoint: string;
  traceId?: string;
  requestId?: string;
  status?: string;
  timestamp?: string;
}

export interface OperatorControlPlaneDispatchResult {
  selectedTool: OperatorControlPlaneTool;
  endpoint: string;
  trace: OperatorControlPlaneTraceMetadata;
  result: GptAccessClientResult;
  sanitizedSummary?: unknown;
}

export interface OperatorDispatchResult {
  ok: true;
  routeKind: OperatorIntentRouteKind;
  classification: OperatorIntentClassification;
  controlPlane?: OperatorControlPlaneDispatchResult;
  gptReasoning?: GptAccessClientResult;
}

interface SignalDefinition {
  signal: string;
  pattern: RegExp;
}

const DEFAULT_GPT_ID = 'arcanos-core';
const MAX_SANITIZED_SUMMARY_CHARS = 10_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CONTROL_PLANE_SIGNALS: SignalDefinition[] = [
  { signal: 'runtime', pattern: /\bruntime\b/i },
  { signal: 'worker', pattern: /\bworker(?:s|-helper)?\b/i },
  { signal: 'queue', pattern: /\bqueue(?:d|s)?\b/i },
  { signal: 'diagnostics', pattern: /\bdiagnostics?\b/i },
  { signal: 'diagnose', pattern: /\bdiagnos(?:e|is|ing)\b/i },
  { signal: 'trace', pattern: /\btrace\b|\btracing\b/i },
  { signal: 'logs', pattern: /\blogs?\b|\blog query\b/i },
  { signal: 'health', pattern: /\bhealth\b|\bliveness\b/i },
  { signal: 'status', pattern: /\bstatus\b/i },
  { signal: 'db explain', pattern: /\bdb\s+explain\b|\bdatabase\s+explain\b|\bexplain\s+db\b/i },
  { signal: 'database slow', pattern: /\bdatabase\s+slow\b|\bslow\s+database\b|\bslow\s+query\b/i },
  { signal: 'history.insert', pattern: /\bhistory\.insert\b/i },
  { signal: 'stalled', pattern: /\bstalled\b/i },
  { signal: 'heartbeat', pattern: /\bheartbeat\b/i },
  { signal: 'self heal', pattern: /\bself[-\s]?heal(?:ing)?\b/i },
  { signal: 'MCP', pattern: /\bmcp\b|\bmodel\s+context\s+protocol\b/i },
  { signal: 'job result', pattern: /\bjob\s+(?:result|output)\b|\bresult\s+for\s+job\b/i },
  { signal: 'job lookup', pattern: /\bjob\s+lookup\b|\blook\s+up\s+job\b|\blookup\s+job\b/i },
  { signal: 'Railway', pattern: /\brailway\b/i },
  { signal: 'deployment', pattern: /\bdeployment\b|\bdeploy(?:ed|ment)?\b/i },
  { signal: 'RUN_WORKERS', pattern: /\bRUN_WORKERS\b/i },
  { signal: 'ARCANOS_PROCESS_KIND', pattern: /\bARCANOS_PROCESS_KIND\b/i },
  { signal: 'backend state', pattern: /\b(?:reach|inspect|read|query|check)\s+(?:the\s+)?backend\b/i }
];

const GPT_REASONING_SIGNALS: SignalDefinition[] = [
  { signal: 'explain', pattern: /\bexplain\b/i },
  { signal: 'summarize', pattern: /\bsummari[sz]e\b|\bsummary\b/i },
  { signal: 'plan', pattern: /\bplan\b|\bplanning\b/i },
  { signal: 'review', pattern: /\breview\b/i },
  { signal: 'generate', pattern: /\bgenerate\b/i },
  { signal: 'refactor', pattern: /\brefactor\b/i },
  { signal: 'draft', pattern: /\bdraft\b/i },
  { signal: 'write prompt', pattern: /\bwrite\s+(?:a\s+)?prompt\b|\bprompt\s+engineering\b/i },
  { signal: 'architecture advice', pattern: /\barchitecture\s+advice\b|\barchitectural\s+advice\b/i },
  { signal: 'code review', pattern: /\bcode\s+review\b/i },
  { signal: 'recommend', pattern: /\brecommend(?:ation)?\b/i },
  { signal: 'interpret', pattern: /\binterpret\b/i },
  { signal: 'have AI', pattern: /\bhave\s+ai\b|\buse\s+ai\b/i }
];

const HYBRID_VERB_PATTERN = /\b(?:run|inspect|trace|diagnose|check|reach|read|query)\b/i;
const HYBRID_INTERPRET_PATTERN = /\b(?:explain|summari[sz]e|interpret|recommend|fix|have\s+ai|use\s+ai|add\s+input)\b/i;
const HYBRID_CONNECTOR_PATTERN = /\b(?:and|then|after|with)\b/i;
const SENSITIVE_KEY_PATTERN = /\b(?:authorization|cookie|set-cookie|api[_-]?key|token|secret|password|session(?:id)?|database[_-]?url|headers?|rawheaders?)\b/i;
const FULL_ENV_KEY_PATTERN = /^(?:env|fullenv|rawenv|processenv|environmentvariables)$/i;
const STRING_REDACTIONS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_OPENAI_KEY]'],
  [/\b(?:railway|rwy)[_-]?[A-Za-z0-9]{16,}\b/gi, '[REDACTED_RAILWAY_TOKEN]'],
  [/\b(?:postgres|postgresql|mysql|mongodb):\/\/[^\s"'<>]+/gi, '[REDACTED_DATABASE_URL]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]'],
  [/\b(?:authorization|cookie|set-cookie|api[_-]?key|token|secret|password|session(?:id)?|database_url)\s*[:=]\s*["']?[^"'\s,;}]+/gi, '$1=[REDACTED]']
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toJsonValue(entry)])
    ) as { [key: string]: JsonValue };
  }

  return null;
}

function matchSignals(input: string, definitions: SignalDefinition[]): string[] {
  return definitions
    .filter((definition) => definition.pattern.test(input))
    .map((definition) => definition.signal);
}

function hasSignal(signals: string[], signal: string): boolean {
  return signals.includes(signal);
}

function hasAnySignal(signals: string[], candidates: string[]): boolean {
  return candidates.some((candidate) => hasSignal(signals, candidate));
}

function hasHybridIntent(input: string, controlSignals: string[], reasoningSignals: string[]): boolean {
  if (controlSignals.length === 0 || reasoningSignals.length === 0) {
    return false;
  }

  return (
    (HYBRID_VERB_PATTERN.test(input) && HYBRID_INTERPRET_PATTERN.test(input)) ||
    (HYBRID_CONNECTOR_PATTERN.test(input) && HYBRID_INTERPRET_PATTERN.test(input))
  );
}

function selectControlPlaneTool(input: string, signals: string[]): OperatorControlPlaneTool {
  if (hasAnySignal(signals, ['job result', 'job lookup'])) {
    return 'jobs.result';
  }

  if (hasAnySignal(signals, ['db explain', 'database slow', 'history.insert'])) {
    return 'db.explain';
  }

  if (hasSignal(signals, 'logs')) {
    return 'logs.query';
  }

  if (hasAnySignal(signals, ['diagnostics', 'diagnose', 'trace', 'Railway', 'deployment', 'RUN_WORKERS', 'ARCANOS_PROCESS_KIND', 'backend state'])) {
    return 'diagnostics.deep';
  }

  if (hasSignal(signals, 'queue')) {
    return 'mcp.queue.inspect';
  }

  if (hasSignal(signals, 'self heal')) {
    return 'mcp.self_heal.status';
  }

  if (hasAnySignal(signals, ['health', 'heartbeat', 'stalled'])) {
    return 'worker_helper.health';
  }

  if (hasSignal(signals, 'worker')) {
    return 'workers.status';
  }

  if (hasSignal(signals, 'MCP')) {
    return 'mcp.diagnostics';
  }

  if (hasSignal(signals, 'runtime')) {
    return input.match(/\binspect(?:ion)?\b/i) ? 'mcp.runtime.inspect' : 'status';
  }

  return 'status';
}

export function classifyOperatorIntent(input: string): OperatorIntentClassification {
  const normalizedInput = input.trim();
  const controlSignals = matchSignals(normalizedInput, CONTROL_PLANE_SIGNALS);
  const reasoningSignals = matchSignals(normalizedInput, GPT_REASONING_SIGNALS);
  const matchedSignals = Array.from(new Set([...controlSignals, ...reasoningSignals]));

  if (hasHybridIntent(normalizedInput, controlSignals, reasoningSignals)) {
    return {
      routeKind: 'hybrid',
      confidence: 0.88,
      matchedSignals,
      selectedTool: selectControlPlaneTool(normalizedInput, controlSignals),
      reason: 'operator_request_requires_control_plane_state_before_ai_interpretation'
    };
  }

  if (controlSignals.length > 0) {
    return {
      routeKind: 'control_plane',
      confidence: reasoningSignals.length > 0 ? 0.82 : 0.93,
      matchedSignals,
      selectedTool: selectControlPlaneTool(normalizedInput, controlSignals),
      reason: reasoningSignals.length > 0
        ? 'ambiguous_runtime_or_safety_sensitive_request_failed_closed_to_control_plane'
        : 'operator_request_matches_direct_control_plane_signal'
    };
  }

  if (reasoningSignals.length > 0) {
    return {
      routeKind: 'gpt_reasoning',
      confidence: 0.86,
      matchedSignals,
      selectedTool: 'gpt_reasoning.jobs.create',
      reason: 'operator_request_matches_gpt_reasoning_signal'
    };
  }

  return {
    routeKind: 'gpt_reasoning',
    confidence: 0.55,
    matchedSignals,
    selectedTool: 'gpt_reasoning.jobs.create',
    reason: 'no_control_plane_signal_detected_defaulting_to_gpt_reasoning'
  };
}

function endpointForTool(tool: OperatorControlPlaneTool): string {
  switch (tool) {
    case 'status':
      return APPROVED_CONTROL_PLANE_ENDPOINTS.status;
    case 'workers.status':
      return APPROVED_CONTROL_PLANE_ENDPOINTS.workersStatus;
    case 'worker_helper.health':
      return APPROVED_CONTROL_PLANE_ENDPOINTS.workerHelperHealth;
    case 'diagnostics.deep':
      return APPROVED_CONTROL_PLANE_ENDPOINTS.diagnosticsDeep;
    case 'db.explain':
      return APPROVED_CONTROL_PLANE_ENDPOINTS.dbExplain;
    case 'logs.query':
      return APPROVED_CONTROL_PLANE_ENDPOINTS.logsQuery;
    case 'jobs.result':
      return APPROVED_CONTROL_PLANE_ENDPOINTS.jobsResult;
    case 'mcp.runtime.inspect':
    case 'mcp.workers.status':
    case 'mcp.queue.inspect':
    case 'mcp.self_heal.status':
    case 'mcp.diagnostics':
      return APPROVED_CONTROL_PLANE_ENDPOINTS.mcp;
  }
}

function pickString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function pickBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function pickNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function inferExplainQueryKey(input: string): ApprovedDbExplainKey {
  if (/\bclaim\b|\bworker\b/i.test(input)) {
    return 'worker_claim';
  }

  if (/\bliveness\b|\bheartbeat\b/i.test(input)) {
    return 'worker_liveliness_upsert';
  }

  if (/\bjob\s+(?:result|lookup)\b/i.test(input)) {
    return 'job_result_lookup';
  }

  return 'queue_pending';
}

function extractUuid(input: string): string | null {
  const match = input.match(UUID_PATTERN);
  return match?.[0] ?? null;
}

function buildDiagnosticsInput(
  request: OperatorDispatchRequest,
  controlPlaneInput: Record<string, unknown>
): GptAccessDeepDiagnosticsRequest {
  return {
    focus: pickString(controlPlaneInput, 'focus') ?? request.input.trim().slice(0, 256),
    includeDb: pickBoolean(controlPlaneInput, 'includeDb') ?? true,
    includeWorkers: pickBoolean(controlPlaneInput, 'includeWorkers') ?? true,
    includeLogs: pickBoolean(controlPlaneInput, 'includeLogs') ?? true,
    includeQueue: pickBoolean(controlPlaneInput, 'includeQueue') ?? true
  };
}

function buildDbExplainInput(
  request: OperatorDispatchRequest,
  controlPlaneInput: Record<string, unknown>
): GptAccessDbExplainRequest {
  const rawQueryKey = pickString(controlPlaneInput, 'queryKey');
  const queryKey = rawQueryKey && isApprovedDbExplainKey(rawQueryKey)
    ? rawQueryKey
    : inferExplainQueryKey(request.input);
  const params = isRecord(controlPlaneInput.params) ? controlPlaneInput.params : {};

  return { queryKey, params };
}

function buildLogsInput(controlPlaneInput: Record<string, unknown>): GptAccessLogsQueryRequest {
  const rawLevel = pickString(controlPlaneInput, 'level');
  const level = rawLevel === 'error' || rawLevel === 'warn' || rawLevel === 'info' || rawLevel === 'debug'
    ? rawLevel
    : undefined;

  return {
    service: pickString(controlPlaneInput, 'service'),
    level,
    contains: pickString(controlPlaneInput, 'contains'),
    sinceMinutes: pickNumber(controlPlaneInput, 'sinceMinutes'),
    limit: pickNumber(controlPlaneInput, 'limit')
  };
}

function mcpToolForSelectedTool(tool: OperatorControlPlaneTool): ApprovedMcpTool {
  switch (tool) {
    case 'mcp.runtime.inspect':
      return 'runtime.inspect';
    case 'mcp.workers.status':
      return 'workers.status';
    case 'mcp.queue.inspect':
      return 'queue.inspect';
    case 'mcp.self_heal.status':
      return 'self_heal.status';
    case 'mcp.diagnostics':
      return 'diagnostics';
    default:
      return 'diagnostics';
  }
}

function buildJobResultInput(
  request: OperatorDispatchRequest,
  controlPlaneInput: Record<string, unknown>
): GptAccessJobResultRequest {
  const jobId = pickString(controlPlaneInput, 'jobId') ?? extractUuid(request.input);
  if (!jobId) {
    throw new Error('Operator job result lookup requires a UUID jobId.');
  }

  return {
    jobId,
    traceId: pickString(controlPlaneInput, 'traceId')
  };
}

async function runControlPlaneTool(
  request: OperatorDispatchRequest,
  classification: OperatorIntentClassification
): Promise<OperatorControlPlaneDispatchResult> {
  const selectedTool = classification.selectedTool as OperatorControlPlaneTool;
  const controlPlaneInput = request.controlPlaneInput ?? {};
  assertNoUnsafeTransportFields(controlPlaneInput, 'operator control-plane input');

  let result: GptAccessClientResult;

  switch (selectedTool) {
    case 'status':
      result = await request.clients.controlPlane.getStatus();
      break;
    case 'workers.status':
      result = await request.clients.controlPlane.getWorkersStatus();
      break;
    case 'worker_helper.health':
      result = await request.clients.controlPlane.getWorkerHelperHealth();
      break;
    case 'diagnostics.deep':
      result = await request.clients.controlPlane.runDeepDiagnostics(
        buildDiagnosticsInput(request, controlPlaneInput)
      );
      break;
    case 'db.explain':
      result = await request.clients.controlPlane.explainApprovedQuery(
        buildDbExplainInput(request, controlPlaneInput)
      );
      break;
    case 'logs.query':
      result = await request.clients.controlPlane.queryLogs(buildLogsInput(controlPlaneInput));
      break;
    case 'jobs.result':
      result = await request.clients.controlPlane.getJobResult(
        buildJobResultInput(request, controlPlaneInput)
      );
      break;
    case 'mcp.runtime.inspect':
    case 'mcp.workers.status':
    case 'mcp.queue.inspect':
    case 'mcp.self_heal.status':
    case 'mcp.diagnostics':
      result = await request.clients.controlPlane.runMcpTool({
        tool: mcpToolForSelectedTool(selectedTool),
        args: isRecord(controlPlaneInput.args) ? controlPlaneInput.args : {}
      });
      break;
  }

  const endpoint = result.endpoint ?? endpointForTool(selectedTool);
  const trace = buildControlPlaneTraceMetadata(selectedTool, endpoint, result.payload);
  return { selectedTool, endpoint, trace, result };
}

function redactString(value: string): string {
  return STRING_REDACTIONS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    value
  );
}

export function sanitizeOperatorControlPlaneResult(payload: unknown): unknown {
  const seen = new WeakSet<object>();

  function sanitize(value: unknown, key: string | null, depth: number): unknown {
    if (depth > 12) {
      return '[REDACTED_DEPTH]';
    }

    if (typeof key === 'string' && (SENSITIVE_KEY_PATTERN.test(key) || FULL_ENV_KEY_PATTERN.test(key))) {
      return '[REDACTED]';
    }

    if (typeof value === 'string') {
      return redactString(value);
    }

    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }

    if (!value || typeof value !== 'object') {
      return null;
    }

    const objectValue = value as object;
    if (seen.has(objectValue)) {
      return '[REDACTED_CIRCULAR]';
    }
    seen.add(objectValue);

    if (Array.isArray(value)) {
      return value.slice(0, 50).map((entry) => sanitize(entry, null, depth + 1));
    }

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        sanitize(entryValue, entryKey, depth + 1)
      ])
    );
  }

  return sanitize(payload, null, 0);
}

function truncateSummary(summary: string): string {
  return summary.length > MAX_SANITIZED_SUMMARY_CHARS
    ? `${summary.slice(0, MAX_SANITIZED_SUMMARY_CHARS)}...[truncated]`
    : summary;
}

function buildSanitizedSummary(payload: unknown): { payload: unknown; context: string } {
  const sanitizedPayload = sanitizeOperatorControlPlaneResult(payload);
  return {
    payload: sanitizedPayload,
    context: truncateSummary(JSON.stringify(sanitizedPayload, null, 2))
  };
}

function findFirstStringKey(value: unknown, key: string, depth: number = 0): string | undefined {
  if (depth > 6 || !isRecord(value)) {
    return undefined;
  }

  const direct = value[key];
  if (typeof direct === 'string' && direct.trim().length > 0) {
    return direct.trim();
  }

  for (const entry of Object.values(value)) {
    if (isRecord(entry)) {
      const nested = findFirstStringKey(entry, key, depth + 1);
      if (nested) {
        return nested;
      }
    }
  }

  return undefined;
}

function buildControlPlaneTraceMetadata(
  selectedTool: OperatorControlPlaneTool,
  endpoint: string,
  payload: unknown
): OperatorControlPlaneTraceMetadata {
  return {
    selectedTool,
    endpoint,
    traceId: findFirstStringKey(payload, 'traceId'),
    requestId: findFirstStringKey(payload, 'requestId'),
    status: findFirstStringKey(payload, 'status'),
    timestamp: findFirstStringKey(payload, 'timestamp') ?? findFirstStringKey(payload, 'time')
  };
}

function buildReasoningJobRequest(
  request: OperatorDispatchRequest,
  hybridContext?: {
    classification: OperatorIntentClassification;
    controlPlane: OperatorControlPlaneDispatchResult;
    sanitizedContext: string;
  }
): CreateReasoningJobRequest {
  const inputContext = request.inputContext ?? {};
  assertNoUnsafeTransportFields(inputContext, 'operator reasoning input context');

  if (hybridContext) {
    const input: Record<string, JsonValue> = {
      controlPlane: toJsonValue({
        selectedTool: hybridContext.controlPlane.selectedTool,
        endpoint: hybridContext.controlPlane.endpoint,
        trace: hybridContext.controlPlane.trace,
        sanitizedResult: hybridContext.controlPlane.sanitizedSummary
      })
    };
    const context = [
      'Sanitized control-plane observation for operator reasoning.',
      `Route: ${hybridContext.classification.selectedTool}`,
      `Endpoint: ${hybridContext.controlPlane.endpoint}`,
      hybridContext.sanitizedContext
    ].join('\n');

    return {
      gptId: request.gptId ?? DEFAULT_GPT_ID,
      task: 'Interpret the provided sanitized operational observation and produce concise guidance for the operator.',
      input,
      context,
      ...(typeof request.maxOutputTokens === 'number' ? { maxOutputTokens: request.maxOutputTokens } : {}),
      ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {})
    };
  }

  const input: Record<string, JsonValue> = {
    operatorRequest: request.input,
    inputContext: toJsonValue(inputContext)
  };
  const contextParts = [request.context?.trim()].filter(Boolean) as string[];

  return {
    gptId: request.gptId ?? DEFAULT_GPT_ID,
    task: request.input,
    input,
    ...(contextParts.length > 0 ? { context: contextParts.join('\n\n') } : {}),
    ...(typeof request.maxOutputTokens === 'number' ? { maxOutputTokens: request.maxOutputTokens } : {}),
    ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {})
  };
}

export async function dispatchOperatorRequest(
  request: OperatorDispatchRequest
): Promise<OperatorDispatchResult> {
  const classification = classifyOperatorIntent(request.input);

  if (classification.routeKind === 'control_plane') {
    const controlPlane = await runControlPlaneTool(request, classification);
    return {
      ok: true,
      routeKind: 'control_plane',
      classification,
      controlPlane
    };
  }

  if (classification.routeKind === 'gpt_reasoning') {
    const gptReasoning = await request.clients.reasoning.createReasoningJob(
      buildReasoningJobRequest(request)
    );
    return {
      ok: true,
      routeKind: 'gpt_reasoning',
      classification,
      gptReasoning
    };
  }

  const controlPlane = await runControlPlaneTool(request, classification);
  const sanitized = buildSanitizedSummary(controlPlane.result.payload);
  controlPlane.sanitizedSummary = sanitized.payload;

  const gptReasoning = await request.clients.reasoning.createReasoningJob(
    buildReasoningJobRequest(request, {
      classification,
      controlPlane,
      sanitizedContext: sanitized.context
    })
  );

  return {
    ok: true,
    routeKind: 'hybrid',
    classification,
    controlPlane,
    gptReasoning
  };
}
