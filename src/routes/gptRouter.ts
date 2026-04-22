import crypto from 'node:crypto';
import express from "express";
import { routeGptRequest } from "./_core/gptDispatch.js";
import { buildArcanosCoreTimeoutFallbackEnvelope } from "@services/arcanos-core.js";
import {
  logGptConnection,
  logGptConnectionFailed,
  logGptAckSent,
  type GptRoutingInfo,
} from "@platform/logging/gptLogger.js";
import {
  prepareBoundedClientJsonPayload,
  shapeClientRouteResult
} from '@shared/http/clientResponseGuards.js';
import { sendPreparedJsonResponse } from '@shared/http/sendPreparedJsonResponse.js';
import { sendBoundedJsonResponse } from '@shared/http/sendBoundedJsonResponse.js';
import { applyCanonicalGptRouteHeaders } from '@shared/http/gptRouteHeaders.js';
import {
  applyAIDegradedResponseHeaders,
  extractAIDegradedResponseMetadata
} from '@shared/http/aiDegradedHeaders.js';
import { resolveGptRouteHardTimeoutMs } from '@shared/http/gptRouteTimeout.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { getDiagnosticsSnapshot } from '@core/diagnostics.js';
import {
  createAbortError,
  isAbortError,
  runWithRequestAbortTimeout
} from '@arcanos/runtime';
import { hasDagOrchestrationIntentCue } from '@services/naturalLanguageMemory.js';
import {
  recordDagTraceTimeout,
  recordGptFastPathLatency,
  recordGptJobEvent,
  recordGptJobLookup,
  recordGptRequestEvent,
  recordGptRouteDecision
} from '@platform/observability/appMetrics.js';
import { shouldTreatPromptAsDagExecution } from '@shared/dag/dagExecutionRouting.js';
import {
  IdempotencyKeyConflictError,
  JobRepositoryUnavailableError,
  getJobById,
  findOrCreateGptJob
} from '@core/db/repositories/jobRepository.js';
import { planAutonomousWorkerJob } from '@services/workerAutonomyService.js';
import {
  buildQueuedGptJobInput,
  buildQueuedGptPendingResponse
} from '@shared/gpt/asyncGptJob.js';
import {
  waitForQueuedGptJobCompletion,
  resolveAsyncGptPollIntervalMs,
  resolveAsyncGptWaitForResultMs
} from '@services/queuedGptCompletionService.js';
import {
  buildGptIdempotencyDescriptor,
  normalizeGptRequestBody,
  normalizeExplicitIdempotencyKey,
  summarizeFingerprintHash
} from '@shared/gpt/gptIdempotency.js';
import {
  resolveGptJobLifecycleStatus,
  summarizeGptJobTimings
} from '@shared/gpt/gptJobLifecycle.js';
import { getRequestActorKey } from '@platform/runtime/security.js';
import {
  GPT_QUERY_ACTION,
  GPT_GET_STATUS_ACTION,
  GPT_GET_RESULT_ACTION,
  GPT_QUERY_AND_WAIT_ACTION,
  buildGptJobStatusBridgePayload,
  buildGptJobResultBridgePayload,
  parseGptJobStatusRequest,
  parseGptJobResultRequest
} from '@shared/gpt/gptJobResult.js';
import {
  type GptDirectControlAction,
  normalizeGptDirectControlAction,
} from '@shared/gpt/gptControlActions.js';
import {
  buildGptControlResponseMeta,
  getGptExecutionPlanAvailableSections,
  isPlannableGptControlAction,
  planGptControlExecution,
  type GptExecutionPlan as GptControlExecutionPlan,
} from '@shared/gpt/gptExecutionPlanner.js';
import { prepareShapedControlResponse } from '@shared/gpt/gptControlResponseShape.js';
import { classifyGptRequestPlane } from './_core/gptPlaneClassification.js';
import {
  executeSystemStateRequest,
  SystemStateConflictError
} from '@services/systemState.js';
import {
  classifyGptFastPathRequest,
  type GptFastPathDecision,
  type GptFastPathModeHint
} from '@shared/gpt/gptFastPath.js';
import { executeFastGptPrompt } from '@services/gptFastPath.js';
import { executeRuntimeInspection } from '@services/runtimeInspectionRoutingService.js';
import { getWorkerControlStatus } from '@services/workerControlService.js';
import { buildSafetySelfHealSnapshot } from '@services/selfHealRuntimeInspectionService.js';

const router = express.Router();
const ARCANOS_CORE_GPT_IDS = new Set(['arcanos-core', 'core', 'arcanos-daemon']);
const DEFAULT_GPT_ASYNC_HEAVY_PROMPT_CHARS = 1_200;
const DEFAULT_GPT_ASYNC_HEAVY_MESSAGE_COUNT = 8;
const DEFAULT_GPT_ASYNC_HEAVY_MAX_WORDS = 700;
const DEFAULT_GPT_ASYNC_HEAVY_WAIT_FOR_RESULT_MS = 500;
const DEFAULT_GPT_QUERY_AND_WAIT_TIMEOUT_MS = 25_000;
const DIRECT_RETURN_ROUTE_TIMEOUT_HEADROOM_MS = 750;
const DEFAULT_GPT_QUERY_AND_WAIT_ROUTE_TIMEOUT_MS =
  DEFAULT_GPT_QUERY_AND_WAIT_TIMEOUT_MS + DIRECT_RETURN_ROUTE_TIMEOUT_HEADROOM_MS;
const DEBUG_GPT_MAX_BYTES_HEADER = 'x-debug-max-bytes';
const DIRECT_RETURN_WAIT_KEYS = [
  'waitForResultMs',
  'wait_for_result_ms',
  'timeoutMs',
  'timeout_ms'
];
const DIRECT_RETURN_POLL_KEYS = ['pollIntervalMs', 'poll_interval_ms'];

type GptExecutionMode = 'sync' | 'async';
type GptExecutionPlan = {
  mode: GptExecutionMode;
  reason: string;
  promptLength: number;
  messageCount: number;
  answerMode: string | null;
  maxWords: number | null;
  heavyPrompt: boolean;
};

type GptJobLookupAction = typeof GPT_GET_STATUS_ACTION | typeof GPT_GET_RESULT_ACTION;

function readActionAlias(record: Record<string, unknown>): string | null {
  const actionValue = record.action;
  if (typeof actionValue === 'string' && actionValue.trim().length > 0) {
    return actionValue.trim();
  }

  const operationValue = record.operation;
  return typeof operationValue === 'string' && operationValue.trim().length > 0
    ? operationValue.trim()
    : null;
}

function resolveRequestedAction(body: unknown): string | null {
  const normalizedBody = normalizeGptRequestBody(body);
  if (!normalizedBody) {
    return null;
  }

  const directAction = readActionAlias(normalizedBody);
  if (directAction) {
    return directAction.toLowerCase();
  }

  const payload = normalizedBody.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  const payloadAction = readActionAlias(payload as Record<string, unknown>);
  return payloadAction ? payloadAction.toLowerCase() : null;
}

function readPayloadRecord(
  normalizedBody: Record<string, unknown> | null
): Record<string, unknown> | null {
  const payload = normalizedBody?.payload;
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

function extractPromptTextFromRecord(record: Record<string, unknown> | null): string | null {
  const candidate =
    record?.message ??
    record?.prompt ??
    record?.userInput ??
    record?.content ??
    record?.text ??
    record?.query;

  if (typeof candidate === 'string' && candidate.trim().length > 0) {
    return candidate.trim();
  }

  if (!Array.isArray(record?.messages)) {
    return null;
  }

  for (let index = record.messages.length - 1; index >= 0; index -= 1) {
    const entry = record.messages[index];
    const normalizedEntry =
      typeof entry === 'object' && entry !== null && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)
        : null;

    if (
      normalizedEntry?.role === 'user' &&
      typeof normalizedEntry.content === 'string' &&
      normalizedEntry.content.trim().length > 0
    ) {
      return normalizedEntry.content.trim();
    }
  }

  return null;
}

function extractPromptText(body: unknown): string | null {
  const normalizedBody = normalizeGptRequestBody(body);
  return (
    extractPromptTextFromRecord(normalizedBody) ??
    extractPromptTextFromRecord(readPayloadRecord(normalizedBody))
  );
}

function resolveDebugGptPublicResponseMaxBytes(req: express.Request): number | undefined {
  if (
    process.env.NODE_ENV === 'production' ||
    process.env.ARCANOS_ENABLE_DEBUG_GPT_CONTROLS !== 'true'
  ) {
    return undefined;
  }

  const rawValue = req.header(DEBUG_GPT_MAX_BYTES_HEADER);
  if (!rawValue) {
    return undefined;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : undefined;
}

function hashPromptText(promptText: string | null): string | null {
  if (!promptText) {
    return null;
  }

  return crypto
    .createHash('sha256')
    .update(promptText.replace(/\s+/g, ' ').trim())
    .digest('hex')
    .slice(0, 12);
}

function compareLogKeys(leftKey: string, rightKey: string): number {
  if (leftKey < rightKey) {
    return -1;
  }

  if (leftKey > rightKey) {
    return 1;
  }

  return 0;
}

function buildGptRequestMetaLog(input: {
  body: unknown;
  normalizedBody: Record<string, unknown> | null;
  promptText: string | null;
}): Record<string, unknown> {
  const bodyRecord =
    input.normalizedBody ??
    (
      input.body &&
      typeof input.body === 'object' &&
      !Array.isArray(input.body)
        ? input.body as Record<string, unknown>
        : null
    );
  const bodyKeys = bodyRecord
    ? Object.keys(bodyRecord).sort(compareLogKeys)
    : [];
  const promptLikeFields = bodyKeys.filter((key) =>
    ['content', 'message', 'messages', 'prompt', 'query', 'text', 'userInput'].includes(key)
  );

  return {
    bodyType: input.normalizedBody
      ? 'json-object'
      : Array.isArray(input.body)
      ? 'array'
      : typeof input.body,
    bodyKeyCount: bodyKeys.length,
    bodyKeys,
    promptHash: hashPromptText(input.promptText),
    promptLength: input.promptText?.length ?? 0,
    promptLikeFields,
    messageCount: Array.isArray(bodyRecord?.messages) ? bodyRecord.messages.length : 0
  };
}

function shouldUseDagExecutionTimeoutProfile(prompt: string | null): boolean {
  if (!prompt || !hasDagOrchestrationIntentCue(prompt)) {
    return false;
  }

  return shouldTreatPromptAsDagExecution(prompt);
}

function resolveBodyGptId(body: unknown): string | null {
  const normalizedBody = normalizeGptRequestBody(body);
  const gptId = normalizedBody?.gptId;
  return typeof gptId === 'string' && gptId.trim().length > 0
    ? gptId.trim()
    : null;
}

function readPositiveIntegerEnv(name: string, fallbackValue: number): number {
  const parsedValue = Number(process.env[name]);
  return Number.isFinite(parsedValue) && parsedValue > 0
    ? Math.trunc(parsedValue)
    : fallbackValue;
}

function readBooleanEnv(name: string, fallbackValue: boolean): boolean {
  const normalizedValue = (process.env[name] ?? '').trim().toLowerCase();
  if (!normalizedValue) {
    return fallbackValue;
  }

  return normalizedValue !== 'false' && normalizedValue !== '0' && normalizedValue !== 'no';
}

function parseBooleanLike(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }

  return null;
}

function parseNonNegativeIntegerLike(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const normalizedValue = value.trim();
  if (!normalizedValue) {
    return undefined;
  }

  const parsedValue = Number(normalizedValue);
  return Number.isFinite(parsedValue) && parsedValue >= 0
    ? Math.trunc(parsedValue)
    : undefined;
}

function readNumberOverrideFromSources(
  req: express.Request,
  body: unknown,
  fieldNames: readonly string[],
  headerNames: readonly string[] = []
): number | undefined {
  const normalizedBody = normalizeGptRequestBody(body);
  for (const fieldName of fieldNames) {
    const value = normalizedBody?.[fieldName];
    const parsedValue = parseNonNegativeIntegerLike(value);
    if (parsedValue !== undefined) {
      return parsedValue;
    }
  }

  const queryRecord = req.query as Record<string, unknown>;
  for (const fieldName of fieldNames) {
    const queryValue = queryRecord[fieldName];
    const parsedValue = Array.isArray(queryValue)
      ? parseNonNegativeIntegerLike(queryValue[0])
      : parseNonNegativeIntegerLike(queryValue);
    if (parsedValue !== undefined) {
      return parsedValue;
    }
  }

  for (const headerName of headerNames) {
    const parsedValue = parseNonNegativeIntegerLike(req.header(headerName));
    if (parsedValue !== undefined) {
      return parsedValue;
    }
  }

  return undefined;
}

function readRequestedAsyncGptWaitForResultMs(
  req: express.Request,
  body: unknown
): number | undefined {
  return readNumberOverrideFromSources(
    req,
    body,
    DIRECT_RETURN_WAIT_KEYS,
    ['x-gpt-wait-for-result-ms', 'x-gpt-timeout-ms']
  );
}

function readRequestedAsyncGptPollIntervalMs(
  req: express.Request,
  body: unknown
): number | undefined {
  return readNumberOverrideFromSources(
    req,
    body,
    DIRECT_RETURN_POLL_KEYS,
    ['x-gpt-poll-interval-ms']
  );
}

function resolveRequestedExecutionMode(
  req: express.Request,
  body: unknown
): GptExecutionMode | null {
  const normalizedBody = normalizeGptRequestBody(body);
  const payload = readPayloadRecord(normalizedBody);
  const bodyModeCandidate =
    typeof normalizedBody?.executionMode === 'string'
      ? normalizedBody.executionMode
      : typeof payload?.executionMode === 'string'
      ? payload.executionMode
      : typeof normalizedBody?.responseMode === 'string'
      ? normalizedBody.responseMode
      : typeof payload?.responseMode === 'string'
      ? payload.responseMode
      : typeof normalizedBody?.mode === 'string'
      ? normalizedBody.mode
      : typeof payload?.mode === 'string'
      ? payload.mode
      : null;
  const normalizedBodyMode = bodyModeCandidate?.trim().toLowerCase();
  if (normalizedBodyMode === 'async') {
    return 'async';
  }
  if (normalizedBodyMode === 'sync') {
    return 'sync';
  }
  if (normalizedBodyMode === 'orchestrated' || normalizedBodyMode === 'orchestrated_path') {
    return 'async';
  }

  const asyncFlag = parseBooleanLike(normalizedBody?.async);
  if (asyncFlag === true) {
    return 'async';
  }
  if (asyncFlag === false) {
    return 'sync';
  }

  const queryModeCandidate =
    typeof req.query.executionMode === 'string'
      ? req.query.executionMode
      : typeof req.query.responseMode === 'string'
      ? req.query.responseMode
      : typeof req.query.mode === 'string'
      ? req.query.mode
      : null;
  const normalizedQueryMode = queryModeCandidate?.trim().toLowerCase();
  if (normalizedQueryMode === 'async') {
    return 'async';
  }
  if (normalizedQueryMode === 'sync') {
    return 'sync';
  }
  if (normalizedQueryMode === 'orchestrated' || normalizedQueryMode === 'orchestrated_path') {
    return 'async';
  }

  const queryAsyncFlag = parseBooleanLike(req.query.async);
  if (queryAsyncFlag === true) {
    return 'async';
  }
  if (queryAsyncFlag === false) {
    return 'sync';
  }

  const headerModeCandidate =
    req.header('x-gpt-execution-mode') ??
    req.header('x-execution-mode') ??
    req.header('x-response-mode');
  const normalizedHeaderMode = headerModeCandidate?.trim().toLowerCase();
  if (normalizedHeaderMode === 'async') {
    return 'async';
  }
  if (normalizedHeaderMode === 'sync') {
    return 'sync';
  }
  if (normalizedHeaderMode === 'orchestrated' || normalizedHeaderMode === 'orchestrated_path') {
    return 'async';
  }

  const preferHeader = req.header('prefer')?.trim().toLowerCase() ?? '';
  if (preferHeader.includes('respond-async')) {
    return 'async';
  }

  return null;
}

function normalizeFastPathModeHint(value: unknown): GptFastPathModeHint {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'fast' || normalized === 'fast_path' || normalized === 'inline') {
    return 'fast';
  }

  if (
    normalized === 'async' ||
    normalized === 'orchestrated' ||
    normalized === 'orchestrated_path' ||
    normalized === 'queued'
  ) {
    return 'orchestrated';
  }

  return null;
}

function resolveRequestedFastPathMode(
  req: express.Request,
  body: unknown
): GptFastPathModeHint {
  const normalizedBody = normalizeGptRequestBody(body);
  const bodyModeCandidate =
    normalizedBody?.executionMode ??
    normalizedBody?.responseMode ??
    normalizedBody?.mode;
  const bodyMode = normalizeFastPathModeHint(bodyModeCandidate);
  if (bodyMode) {
    return bodyMode;
  }

  const queryMode =
    normalizeFastPathModeHint(req.query.executionMode) ??
    normalizeFastPathModeHint(req.query.responseMode) ??
    normalizeFastPathModeHint(req.query.mode);
  if (queryMode) {
    return queryMode;
  }

  const headerMode =
    normalizeFastPathModeHint(req.header('x-gpt-execution-mode')) ??
    normalizeFastPathModeHint(req.header('x-execution-mode')) ??
    normalizeFastPathModeHint(req.header('x-response-mode'));
  if (headerMode) {
    return headerMode;
  }

  const preferHeader = req.header('prefer')?.trim().toLowerCase() ?? '';
  return preferHeader.includes('respond-async') ? 'orchestrated' : null;
}

function extractMessageCount(body: unknown): number {
  const normalizedBody = normalizeGptRequestBody(body);
  if (Array.isArray(normalizedBody?.messages)) {
    return normalizedBody.messages.length;
  }

  const payload = readPayloadRecord(normalizedBody);
  return Array.isArray(payload?.messages) ? payload.messages.length : 0;
}

function extractAnswerMode(body: unknown): string | null {
  const normalizedBody = normalizeGptRequestBody(body);
  const payload = readPayloadRecord(normalizedBody);
  const answerMode = normalizedBody?.answerMode ?? payload?.answerMode;
  return typeof answerMode === 'string' && answerMode.trim().length > 0
    ? answerMode.trim().toLowerCase()
    : null;
}

function extractMaxWords(body: unknown): number | null {
  const normalizedBody = normalizeGptRequestBody(body);
  const payload = readPayloadRecord(normalizedBody);
  const candidates = [
    normalizedBody?.maxWords,
    normalizedBody?.max_words,
    payload?.maxWords,
    payload?.max_words
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
      return Math.trunc(candidate);
    }
  }

  return null;
}

function shouldDefaultCoreQueriesToAsync(
  gptId: string,
  requestedAction: string | null
): boolean {
  if (requestedAction && requestedAction !== GPT_QUERY_ACTION) {
    return false;
  }

  return ARCANOS_CORE_GPT_IDS.has(gptId) &&
    readBooleanEnv('GPT_ROUTE_ASYNC_CORE_DEFAULT', true);
}

function resolveGptExecutionPlan(params: {
  req: express.Request;
  gptId: string;
  body: unknown;
  promptText: string | null;
  requestedAction: string | null;
  routeTimeoutProfile: 'default' | 'dag_execution';
}): GptExecutionPlan {
  const explicitExecutionMode = resolveRequestedExecutionMode(params.req, params.body);
  const promptLength = params.promptText?.length ?? 0;
  const messageCount = extractMessageCount(params.body);
  const answerMode = extractAnswerMode(params.body);
  const maxWords = extractMaxWords(params.body);
  const heavyPrompt =
    params.requestedAction !== 'diagnostics' &&
    (
      params.routeTimeoutProfile === 'dag_execution' ||
      promptLength >= readPositiveIntegerEnv(
        'GPT_ASYNC_HEAVY_PROMPT_CHARS',
        DEFAULT_GPT_ASYNC_HEAVY_PROMPT_CHARS
      ) ||
      messageCount >= readPositiveIntegerEnv(
        'GPT_ASYNC_HEAVY_MESSAGE_COUNT',
        DEFAULT_GPT_ASYNC_HEAVY_MESSAGE_COUNT
      ) ||
      (maxWords !== null &&
        maxWords >= readPositiveIntegerEnv(
          'GPT_ASYNC_HEAVY_MAX_WORDS',
          DEFAULT_GPT_ASYNC_HEAVY_MAX_WORDS
        )) ||
      answerMode === 'audit' ||
      answerMode === 'debug'
    );

  if (explicitExecutionMode) {
    return {
      mode: explicitExecutionMode,
      reason: `explicit_${explicitExecutionMode}_request`,
      promptLength,
      messageCount,
      answerMode,
      maxWords,
      heavyPrompt
    };
  }

  if (params.requestedAction === 'diagnostics') {
    return {
      mode: 'sync',
      reason: 'diagnostics_request',
      promptLength,
      messageCount,
      answerMode,
      maxWords,
      heavyPrompt: false
    };
  }

  if (!params.promptText && (!params.requestedAction || params.requestedAction === GPT_QUERY_ACTION)) {
    return {
      mode: 'sync',
      reason: 'missing_prompt_validation',
      promptLength,
      messageCount,
      answerMode,
      maxWords,
      heavyPrompt: false
    };
  }

  if (params.requestedAction === GPT_QUERY_ACTION) {
    return {
      mode: 'async',
      reason: 'explicit_query_action',
      promptLength,
      messageCount,
      answerMode,
      maxWords,
      heavyPrompt
    };
  }

  if (shouldDefaultCoreQueriesToAsync(params.gptId, params.requestedAction)) {
    return {
      mode: 'async',
      reason: 'core_query_async_default',
      promptLength,
      messageCount,
      answerMode,
      maxWords,
      heavyPrompt: true
    };
  }

  if (heavyPrompt) {
    return {
      mode: 'async',
      reason: 'heavy_prompt_auto_async',
      promptLength,
      messageCount,
      answerMode,
      maxWords,
      heavyPrompt
    };
  }

  return {
    mode: 'sync',
    reason: 'default_sync_path',
    promptLength,
    messageCount,
    answerMode,
    maxWords,
    heavyPrompt: false
  };
}

function clampAsyncWaitForRouteTimeout(waitForResultMs: number, routeTimeoutMs: number): number {
  const routeSafeWaitBudgetMs = Math.max(
    0,
    routeTimeoutMs - DIRECT_RETURN_ROUTE_TIMEOUT_HEADROOM_MS
  );
  return Math.min(waitForResultMs, routeSafeWaitBudgetMs);
}

function buildDirectReturnTimeoutResponse(params: {
  pendingResponse: ReturnType<typeof buildQueuedGptPendingResponse>;
  jobId: string;
  waitForResultMs: number;
  pollIntervalMs: number;
}) {
  return {
    ...params.pendingResponse,
    instruction: `Direct wait timed out after ${params.waitForResultMs}ms. Use GET /jobs/${params.jobId}/result to retrieve the final result.`,
    directReturn: {
      requested: true,
      timedOut: true,
      waitForResultMs: params.waitForResultMs,
      pollIntervalMs: params.pollIntervalMs,
      poll: `/jobs/${params.jobId}`,
      result: `/jobs/${params.jobId}/result`
    }
  };
}

function sendGuardedGptJsonResponse(
  req: express.Request,
  res: express.Response,
  payload: object,
  logEvent: string,
  statusCode = 200
) {
  return sendBoundedJsonResponse(req, res, payload as Record<string, unknown>, {
    logEvent,
    statusCode,
  });
}

function normalizeQueryAndWaitBody(
  normalizedBody: Record<string, unknown> | null,
  requestedAction: string | null
): Record<string, unknown> | null {
  if (!normalizedBody) {
    return null;
  }

  if (requestedAction !== GPT_QUERY_AND_WAIT_ACTION) {
    return normalizedBody;
  }

  const normalizedQueryBody = { ...normalizedBody };
  delete normalizedQueryBody.action;
  normalizedQueryBody.executionMode = 'async';
  return normalizedQueryBody;
}

function hydrateDirectQueryBody(
  normalizedBody: Record<string, unknown> | null,
  promptText: string | null,
  enabled: boolean
): Record<string, unknown> | null {
  if (!enabled || !normalizedBody || !promptText) {
    return normalizedBody;
  }

  if (extractPromptTextFromRecord(normalizedBody)) {
    return normalizedBody;
  }

  return {
    ...normalizedBody,
    prompt: promptText
  };
}

function resolveAsyncBridgeAction(queryAndWaitRequested: boolean) {
  return queryAndWaitRequested
    ? GPT_QUERY_AND_WAIT_ACTION
    : GPT_QUERY_ACTION;
}

function buildJobLookupRouteMeta(params: {
  requestId: string | undefined;
  gptId: string;
  action: GptJobLookupAction;
  route: 'job_status' | 'job_result';
}) {
  return {
    requestId: params.requestId,
    gptId: params.gptId,
    action: params.action,
    route: params.route,
    timestamp: new Date().toISOString()
  };
}

function buildDirectControlRouteMeta(params: {
  requestId: string | undefined;
  gptId: string;
  action: string;
  route: string;
}) {
  return {
    requestId: params.requestId,
    gptId: params.gptId,
    action: params.action,
    route: params.route,
    timestamp: new Date().toISOString()
  };
}

function buildDirectControlPayload(
  normalizedBody: Record<string, unknown> | null
): unknown {
  if (!normalizedBody) {
    return {};
  }

  if (Object.prototype.hasOwnProperty.call(normalizedBody, 'payload')) {
    return normalizedBody.payload;
  }

  const payload = { ...normalizedBody };
  delete payload.action;
  delete payload.gptId;
  return payload;
}

type DirectControlDispatchResponse =
  | {
      kind: 'guarded';
      statusCode: number;
      logEvent: string;
      payload: Record<string, unknown>;
    }
  | {
      kind: 'prepared';
      statusCode: number;
      payload: Record<string, unknown>;
      headers?: Record<string, string>;
    };

async function dispatchDirectControlAction(params: {
  req: express.Request;
  requestId: string | undefined;
  gptId: string;
  action: GptDirectControlAction;
  normalizedBody: Record<string, unknown> | null;
  promptText: string | null;
  logger?: {
    info?: (...args: any[]) => void;
    warn?: (...args: any[]) => void;
  };
}): Promise<DirectControlDispatchResponse> {
  const routeMeta = buildDirectControlRouteMeta({
    requestId: params.requestId,
    gptId: params.gptId,
    action: params.action,
    route: params.action.replace(/[._]/g, '_')
  });
  const directControlPayload = buildDirectControlPayload(params.normalizedBody);
  const directControlPlanResult = isPlannableGptControlAction(params.action)
    ? planGptControlExecution({
        action: params.action,
        promptText: params.promptText,
        payload: directControlPayload,
      })
    : null;

  if (directControlPlanResult && !directControlPlanResult.ok) {
    params.logger?.warn?.('gpt.request.control_plan_invalid', {
      endpoint: params.req.originalUrl,
      gptId: params.gptId,
      requestId: params.requestId,
      action: params.action,
      errorCode: directControlPlanResult.error.code,
      canonical: directControlPlanResult.canonical,
    });
    return {
      kind: 'guarded',
      statusCode: 400,
      logEvent: 'gpt.response.control_plan_invalid',
      payload: {
        ok: false,
        action: params.action,
        error: directControlPlanResult.error,
        canonical: directControlPlanResult.canonical,
        _route: routeMeta,
      }
    };
  }

  const directControlPlan = directControlPlanResult?.ok === true
    ? directControlPlanResult.plan
    : null;
  const directControlAvailableSections = directControlPlanResult?.ok === true
    ? directControlPlanResult.availableSections
    : [];

  if (directControlPlan) {
    params.logger?.info?.('gpt.request.control_plan', {
      endpoint: params.req.originalUrl,
      gptId: params.gptId,
      requestId: params.requestId,
      action: directControlPlan.action,
      detail: directControlPlan.detail,
      sections: directControlPlan.sections,
      shouldUseAsync: directControlPlan.shouldUseAsync,
      source: directControlPlan.source,
    });
  }

  if (params.action === 'diagnostics') {
    const diagnostics = await getDiagnosticsSnapshot(params.req.app);
    params.logger?.info?.('gpt.request.diagnostics', {
      endpoint: params.req.originalUrl,
      gptId: params.gptId,
      internal: true,
      registeredGpts: Array.isArray(diagnostics.registered_gpts)
        ? diagnostics.registered_gpts.length
        : diagnostics.registered_gpts,
      routeCount: Array.isArray(diagnostics.active_routes)
        ? diagnostics.active_routes.length
        : diagnostics.active_routes
    });
    recordGptRequestEvent({
      event: 'control_direct',
      source: 'diagnostics'
    });

    const diagnosticsSerializationStartedAt = Date.now();
    const diagnosticsPayload = prepareBoundedClientJsonPayload(
      diagnostics as unknown as Record<string, unknown>,
      {
        logger: (params.req as any).logger,
        logEvent: 'gpt.response.diagnostics'
      }
    );
    params.logger?.info?.('gpt.response.serialization', {
      endpoint: params.req.originalUrl,
      gptId: params.gptId,
      action: 'diagnostics',
      serializationMs: Date.now() - diagnosticsSerializationStartedAt,
      responseBytes: diagnosticsPayload.responseBytes,
      truncated: diagnosticsPayload.truncated,
    });

    const headers: Record<string, string> = {
      'x-response-bytes': String(diagnosticsPayload.responseBytes)
    };
    if (diagnosticsPayload.truncated) {
      headers['x-response-truncated'] = 'true';
    }

    return {
      kind: 'prepared',
      statusCode: 200,
      payload: diagnosticsPayload.payload,
      headers,
    };
  }

  if (params.action === 'system_state') {
    if (!ARCANOS_CORE_GPT_IDS.has(params.gptId)) {
      params.logger?.warn?.('gpt.request.system_state_rejected', {
        endpoint: params.req.originalUrl,
        gptId: params.gptId,
        requestId: params.requestId,
        reason: 'non_core_gpt'
      });
      return {
        kind: 'guarded',
        statusCode: 400,
        logEvent: 'gpt.response.system_state_rejected',
        payload: {
          ok: false,
          error: {
            code: 'SYSTEM_STATE_REQUIRES_CORE_GPT',
            message: 'system_state requests must target an ARCANOS core GPT id.'
          },
          _route: routeMeta
        }
      };
    }

    try {
      const systemStateResult = await executeSystemStateRequest(
        directControlPayload
      );
      params.logger?.info?.('gpt.request.system_state', {
        endpoint: params.req.originalUrl,
        gptId: params.gptId,
        requestId: params.requestId,
        route: 'system_state'
      });
      recordGptRequestEvent({
        event: 'control_direct',
        source: 'system_state'
      });
      return {
        kind: 'guarded',
        statusCode: 200,
        logEvent: 'gpt.response.system_state',
        payload: {
          ok: true,
          result: systemStateResult,
          _route: routeMeta
        }
      };
    } catch (error) {
      if (error instanceof SystemStateConflictError) {
        params.logger?.warn?.('gpt.request.system_state_conflict', {
          endpoint: params.req.originalUrl,
          gptId: params.gptId,
          requestId: params.requestId,
          conflict: error.conflict
        });
        return {
          kind: 'guarded',
          statusCode: 409,
          logEvent: 'gpt.response.system_state_conflict',
          payload: {
            ok: false,
            error: {
              code: error.code,
              message: error.message,
              details: error.conflict
            },
            _route: routeMeta
          }
        };
      }

      params.logger?.warn?.('gpt.request.system_state_invalid', {
        endpoint: params.req.originalUrl,
        gptId: params.gptId,
        requestId: params.requestId,
        error: resolveErrorMessage(error)
      });
      return {
        kind: 'guarded',
        statusCode: 400,
        logEvent: 'gpt.response.system_state_invalid',
        payload: {
          ok: false,
          error: {
            code: 'BAD_REQUEST',
            message: resolveErrorMessage(error)
          },
          _route: routeMeta
        }
      };
    }
  }

  if (params.action === 'runtime.inspect') {
    const runtimeInspection = await executeRuntimeInspection({
      requestId: params.requestId ?? `${params.gptId}:runtime.inspect`,
      rawPrompt: params.promptText ?? 'runtime inspect live runtime status',
      normalizedPrompt: params.promptText ?? 'runtime inspect live runtime status',
      request: params.req
    });

    if (!runtimeInspection.ok || !runtimeInspection.responsePayload) {
      params.logger?.warn?.('gpt.request.runtime_inspection_unavailable', {
        endpoint: params.req.originalUrl,
        gptId: params.gptId,
        requestId: params.requestId,
        selectedTools: runtimeInspection.selectedTools,
        runtimeEndpointsQueried: runtimeInspection.runtimeEndpointsQueried,
        cliUsed: runtimeInspection.cliUsed,
      });
      return {
        kind: 'guarded',
        statusCode: 503,
        logEvent: 'gpt.response.runtime_inspection_unavailable',
        payload: {
          ok: false,
          action: params.action,
          error: runtimeInspection.error ?? {
            code: 'RUNTIME_INSPECTION_UNAVAILABLE',
            message: 'runtime inspection unavailable'
          },
          _route: routeMeta
        }
      };
    }

    params.logger?.info?.('gpt.request.runtime_inspection', {
      endpoint: params.req.originalUrl,
      gptId: params.gptId,
      requestId: params.requestId,
      selectedTools: runtimeInspection.selectedTools,
      runtimeEndpointsQueried: runtimeInspection.runtimeEndpointsQueried,
      cliUsed: runtimeInspection.cliUsed,
    });
    recordGptRequestEvent({
      event: 'control_direct',
      source: 'runtime.inspect'
    });
    const shapedRuntimeInspection = prepareShapedControlResponse({
      action: 'runtime.inspect',
      rawResult: runtimeInspection.responsePayload,
      plan: (directControlPlan ??
        {
          action: 'runtime.inspect',
          detail: 'summary',
          sections: getGptExecutionPlanAvailableSections('runtime.inspect'),
          shouldUseAsync: false,
          source: 'planner',
        }) as GptControlExecutionPlan<'runtime.inspect'>,
      routeMeta,
      logger: params.req.logger,
      logEvent: 'gpt.response.runtime_inspection',
      maxResponseBytes: resolveDebugGptPublicResponseMaxBytes(params.req),
    });
    return {
      kind: 'prepared',
      statusCode: 200,
      payload: shapedRuntimeInspection.payload,
      headers: {
        'x-response-bytes': String(shapedRuntimeInspection.responseBytes),
        ...(
          shapedRuntimeInspection.explicitTruncated || shapedRuntimeInspection.truncated
            ? { 'x-response-truncated': 'true' }
            : {}
        ),
      },
    };
  }

  if (params.action === 'workers.status') {
    const workerStatus = await getWorkerControlStatus();
    params.logger?.info?.('gpt.request.workers_status', {
      endpoint: params.req.originalUrl,
      gptId: params.gptId,
      requestId: params.requestId,
      overallStatus: workerStatus.workerService.health.overallStatus,
    });
    recordGptRequestEvent({
      event: 'control_direct',
      source: 'workers.status'
    });
    return {
      kind: 'guarded',
      statusCode: 200,
      logEvent: 'gpt.response.workers_status',
      payload: {
        ok: true,
        action: params.action,
        result: workerStatus,
        ...(directControlPlan
          ? {
              meta: buildGptControlResponseMeta({
                plan: directControlPlan,
                availableSections: directControlAvailableSections,
                truncated: false,
              }),
            }
          : {}),
        _route: routeMeta
      }
    };
  }

  if (params.action === 'queue.inspect') {
    const workerStatus = await getWorkerControlStatus();
    const queueInspection = {
      timestamp: workerStatus.timestamp,
      workerService: {
        observationMode: workerStatus.workerService.observationMode,
        database: workerStatus.workerService.database,
        queueSummary: workerStatus.workerService.queueSummary,
        queueSemantics: workerStatus.workerService.queueSemantics,
        retryPolicy: workerStatus.workerService.retryPolicy,
        recentFailedJobs: workerStatus.workerService.recentFailedJobs,
        latestJob: workerStatus.workerService.latestJob,
        health: workerStatus.workerService.health,
      }
    };
    params.logger?.info?.('gpt.request.queue_inspect', {
      endpoint: params.req.originalUrl,
      gptId: params.gptId,
      requestId: params.requestId,
      queuePending: workerStatus.workerService.queueSummary?.pending ?? null,
      queueRunning: workerStatus.workerService.queueSummary?.running ?? null,
    });
    recordGptRequestEvent({
      event: 'control_direct',
      source: 'queue.inspect'
    });
    return {
      kind: 'guarded',
      statusCode: 200,
      logEvent: 'gpt.response.queue_inspect',
      payload: {
        ok: true,
        action: params.action,
        result: queueInspection,
        ...(directControlPlan
          ? {
              meta: buildGptControlResponseMeta({
                plan: directControlPlan,
                availableSections: directControlAvailableSections,
                truncated: false,
              }),
            }
          : {}),
        _route: routeMeta
      }
    };
  }

  const selfHealStatus = buildSafetySelfHealSnapshot();
  params.logger?.info?.('gpt.request.self_heal_status', {
    endpoint: params.req.originalUrl,
    gptId: params.gptId,
    requestId: params.requestId,
    active: selfHealStatus.active,
    enabled: selfHealStatus.enabled,
  });
  recordGptRequestEvent({
    event: 'control_direct',
    source: 'self_heal.status'
  });
  const shapedSelfHealStatus = prepareShapedControlResponse({
    action: 'self_heal.status',
    rawResult: selfHealStatus as Record<string, unknown>,
    plan: (directControlPlan ??
      {
        action: 'self_heal.status',
        detail: 'summary',
        sections: getGptExecutionPlanAvailableSections('self_heal.status'),
        shouldUseAsync: false,
        source: 'planner',
      }) as GptControlExecutionPlan<'self_heal.status'>,
    routeMeta,
    logger: params.req.logger,
    logEvent: 'gpt.response.self_heal_status',
    maxResponseBytes: resolveDebugGptPublicResponseMaxBytes(params.req),
  });
  return {
    kind: 'prepared',
    statusCode: 200,
    payload: shapedSelfHealStatus.payload,
    headers: {
      'x-response-bytes': String(shapedSelfHealStatus.responseBytes),
      ...(
        shapedSelfHealStatus.explicitTruncated || shapedSelfHealStatus.truncated
          ? { 'x-response-truncated': 'true' }
          : {}
      ),
    },
  };
}

function normalizeCompletedAsyncGptResponse(
  output: unknown
): ({
  ok: true;
  result: unknown;
  _route: {
    requestId?: string;
    gptId: string;
    module?: string;
    action?: string;
    matchMethod?: string;
    route?: string;
    availableActions?: string[];
    moduleVersion?: string | null;
    timestamp: string;
  };
} | null) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return null;
  }

  const candidate = output as Record<string, unknown>;
  if (candidate.ok !== true) {
    return null;
  }

  if (!candidate._route || typeof candidate._route !== 'object' || Array.isArray(candidate._route)) {
    return null;
  }

  return candidate as {
    ok: true;
    result: unknown;
    _route: {
      requestId?: string;
      gptId: string;
      module?: string;
      action?: string;
      matchMethod?: string;
      route?: string;
      availableActions?: string[];
      moduleVersion?: string | null;
      timestamp: string;
    };
  };
}

function isTimeoutAbortError(error: unknown, timeoutMessage: string): boolean {
  if (!isAbortError(error)) {
    return false;
  }

  const errorMessage = resolveErrorMessage(error).trim().toLowerCase();
  return errorMessage.includes(timeoutMessage.trim().toLowerCase());
}

function isClientDisconnectAbort(error: unknown): boolean {
  if (!isAbortError(error)) {
    return false;
  }

  return resolveErrorMessage(error).toLowerCase().includes('client disconnected');
}

function buildGptRequestAuthState(req: express.Request): Record<string, unknown> {
  const authorizationHeader = req.header("authorization");
  const cookieHeader = req.header("cookie");
  const csrfHeader = req.header("x-csrf-token") ?? req.header("csrf-token");
  const confirmedHeader = req.header("x-confirmed");
  const xGptIdHeader = req.header("x-gpt-id");
  const authUser = req.authUser;

  let authSource = "anonymous";
  if (authUser?.source) {
    authSource = `auth-user:${authUser.source}`;
  } else if (authorizationHeader) {
    authSource = "authorization-header";
  } else if (req.daemonToken) {
    authSource = "daemon-token";
  } else if (cookieHeader) {
    authSource = "cookie";
  }

  return {
    authenticated:
      Boolean(authUser) ||
      Boolean(req.daemonToken) ||
      Boolean(authorizationHeader) ||
      Boolean(cookieHeader),
    authSource,
    authUserSource: authUser?.source ?? null,
    bearerPresent: Boolean(authorizationHeader),
    webStatePresent: Boolean(cookieHeader),
    csrfPresent: Boolean(csrfHeader),
    confirmedYes: confirmedHeader === "yes",
    gptPathHeaderPresent: Boolean(xGptIdHeader),
  };
}

function buildAsyncJobResponseMetadata(input: {
  action: typeof GPT_QUERY_ACTION | typeof GPT_QUERY_AND_WAIT_ACTION;
  jobId: string;
  jobStatus: string;
  deduped: boolean;
  idempotencyKey: string;
  idempotencySource: 'explicit' | 'derived';
}) {
  return {
    action: input.action,
    jobId: input.jobId,
    status: input.jobStatus,
    lifecycleStatus: resolveGptJobLifecycleStatus(input.jobStatus),
    poll: `/jobs/${input.jobId}`,
    stream: `/jobs/${input.jobId}/stream`,
    ...(input.deduped ? { deduped: true } : {}),
    idempotencyKey: input.idempotencyKey,
    idempotencySource: input.idempotencySource
  };
}

function applyGptRouteDecisionHeaders(
  res: express.Response,
  decision: GptFastPathDecision
): void {
  res.setHeader('x-gpt-route-decision', decision.path);
  res.setHeader('x-gpt-route-decision-reason', decision.reason);
  res.setHeader('x-gpt-queue-bypassed', decision.queueBypassed ? 'true' : 'false');
}

router.post("/:gptId", async (req, res, next) => {
  const requestedAction = resolveRequestedAction(req.body);
  const queryRequested = requestedAction === GPT_QUERY_ACTION;
  const queryAndWaitRequested = requestedAction === GPT_QUERY_AND_WAIT_ACTION;
  const bypassIntentRouting = queryRequested || queryAndWaitRequested;
  const asyncBridgeAction = resolveAsyncBridgeAction(queryAndWaitRequested);
  const promptText = extractPromptText(req.body);
  const routeTimeoutProfile = shouldUseDagExecutionTimeoutProfile(promptText)
    ? 'dag_execution'
    : 'default';
  const explicitAsyncWaitForResultMs = readRequestedAsyncGptWaitForResultMs(req, req.body);
  const explicitAsyncPollIntervalMs = readRequestedAsyncGptPollIntervalMs(req, req.body);
  const queryAndWaitRequestedTimeoutMs =
    explicitAsyncWaitForResultMs ?? DEFAULT_GPT_QUERY_AND_WAIT_TIMEOUT_MS;
  const routeTimeoutMs = resolveGptRouteHardTimeoutMs({
    profile: routeTimeoutProfile,
    ...(queryAndWaitRequested && routeTimeoutProfile === 'default'
      ? {
          defaultMsOverride: Math.max(
            DEFAULT_GPT_QUERY_AND_WAIT_ROUTE_TIMEOUT_MS,
            queryAndWaitRequestedTimeoutMs + DIRECT_RETURN_ROUTE_TIMEOUT_HEADROOM_MS
          )
        }
      : {})
  });
  const requestId = (req as any).requestId;
  let queuedJobId: string | null = null;
  let queuedPendingResponse:
    | ReturnType<typeof buildQueuedGptPendingResponse>
    | null = null;
  const timeoutMessage = `GPT route timeout after ${routeTimeoutMs}ms`;
  const clientAbortController = new AbortController();
  const abortForClosedClient = () => {
    if (!res.writableEnded) {
      clientAbortController.abort(createAbortError('GPT route client disconnected'));
    }
  };

  res.on('close', abortForClosedClient);

  try {
    return await runWithRequestAbortTimeout(
      {
        timeoutMs: routeTimeoutMs,
        requestId,
        parentSignal: clientAbortController.signal,
        abortMessage: timeoutMessage
      },
      async () => {
        const incomingGptId = req.params.gptId;
        const requestLogger = (req as any).logger;
        const normalizedBody = normalizeGptRequestBody(req.body);
        const bodyGptId = resolveBodyGptId(req.body);
        const effectiveRequestedAction = queryAndWaitRequested ? 'query' : requestedAction;
        const effectiveBody =
          hydrateDirectQueryBody(
            normalizeQueryAndWaitBody(normalizedBody, requestedAction) ?? normalizedBody,
            promptText,
            bypassIntentRouting
          ) ?? req.body;
        applyCanonicalGptRouteHeaders(res, incomingGptId);

        requestLogger?.info?.('gpt.request.timeout_plan', {
          endpoint: req.originalUrl,
          gptId: incomingGptId,
          timeoutMs: routeTimeoutMs,
          timeoutProfile: routeTimeoutProfile,
        });

        requestLogger?.info?.('gpt.request.meta', {
          endpoint: req.originalUrl,
          gptId: incomingGptId,
          ...buildGptRequestMetaLog({
            body: req.body,
            normalizedBody,
            promptText
          })
        });
        requestLogger?.info?.('gpt.request.action', {
          endpoint: req.originalUrl,
          gptId: incomingGptId,
          action: requestedAction
        });

        if (bodyGptId) {
          requestLogger?.warn?.('gpt.request.invalid_body_gpt_id', {
            endpoint: req.originalUrl,
            pathGptId: incomingGptId,
            bodyGptId
          });
          return sendGuardedGptJsonResponse(req, res, {
            ok: false,
            error: {
              code: 'BODY_GPT_ID_FORBIDDEN',
              message: 'gptId must be supplied by the /gpt/{gptId} path only.'
            },
            _route: {
              requestId,
              gptId: incomingGptId,
              timestamp: new Date().toISOString()
            }
          }, 'gpt.response.body_gpt_id_forbidden', 400);
        }

        requestLogger?.info?.("gpt.request.auth_state", {
          endpoint: req.originalUrl,
          gptId: incomingGptId,
          ...buildGptRequestAuthState(req),
        });

        if (queryAndWaitRequested && !normalizedBody) {
          requestLogger?.warn?.('integration.job.query_and_wait_invalid_body', {
            endpoint: req.originalUrl,
            gptId: incomingGptId,
            requestId,
            bodyType: typeof req.body
          });
          return sendGuardedGptJsonResponse(req, res, {
            ok: false,
            action: GPT_QUERY_AND_WAIT_ACTION,
            error: {
              code: 'BAD_REQUEST',
              message: 'query_and_wait requires a JSON object request body.'
            },
            _route: {
              requestId,
              gptId: incomingGptId,
              action: GPT_QUERY_AND_WAIT_ACTION,
              route: 'async',
              timestamp: new Date().toISOString()
            }
          }, 'gpt.response.query_and_wait_invalid_body', 400);
        }

        if (queryRequested && !promptText) {
          requestLogger?.warn?.('integration.job.query_missing_prompt', {
            endpoint: req.originalUrl,
            gptId: incomingGptId,
            requestId
          });
          return sendGuardedGptJsonResponse(req, res, {
            ok: false,
            action: GPT_QUERY_ACTION,
            error: {
              code: 'PROMPT_REQUIRED',
              message: 'query requires a non-empty prompt.'
            },
            _route: {
              requestId,
              gptId: incomingGptId,
              action: GPT_QUERY_ACTION,
              route: 'async',
              timestamp: new Date().toISOString()
            }
          }, 'gpt.response.query_prompt_required', 400);
        }

        if (queryAndWaitRequested && !promptText) {
          requestLogger?.warn?.('integration.job.query_and_wait_missing_prompt', {
            endpoint: req.originalUrl,
            gptId: incomingGptId,
            requestId
          });
          return sendGuardedGptJsonResponse(req, res, {
            ok: false,
            action: GPT_QUERY_AND_WAIT_ACTION,
            error: {
              code: 'PROMPT_REQUIRED',
              message: 'query_and_wait requires a non-empty prompt.'
            },
            _route: {
              requestId,
              gptId: incomingGptId,
              action: GPT_QUERY_AND_WAIT_ACTION,
              route: 'async',
              timestamp: new Date().toISOString()
            }
          }, 'gpt.response.query_and_wait_prompt_required', 400);
        }

        const planeClassification = classifyGptRequestPlane({
          body: effectiveBody,
          promptText,
          requestedAction
        });
        requestLogger?.info?.('gpt.request.classified', {
          endpoint: req.originalUrl,
          gptId: incomingGptId,
          action: planeClassification.action,
          plane: planeClassification.plane,
          kind: planeClassification.kind,
          reason: planeClassification.reason
        });

        if (planeClassification.plane === 'reject') {
          if (planeClassification.kind === 'job_lookup' && planeClassification.jobLookup) {
            const jobLookup = planeClassification.jobLookup;
            const outcome = jobLookup.ok ? 'rejected' : 'missing_job_id';
            requestLogger?.warn?.(
              jobLookup.ok
                ? 'gpt.request.job_lookup_guard_rejected'
                : 'gpt.request.job_lookup_guard_missing_job_id',
              {
                endpoint: req.originalUrl,
                gptId: incomingGptId,
                requestId,
                lookup: jobLookup.kind,
                source: jobLookup.source,
                jobId: jobLookup.ok ? jobLookup.jobId : null
              }
            );
            recordGptJobLookup({
              channel: 'prompt_guard',
              lookup: jobLookup.kind,
              outcome
            });
          } else {
            requestLogger?.warn?.('gpt.request.control_rejected', {
              endpoint: req.originalUrl,
              gptId: incomingGptId,
              requestId,
              kind: planeClassification.kind,
              reason: planeClassification.reason,
              canonical: planeClassification.canonical
            });
            recordGptRequestEvent({
              event: 'control_rejected',
              source: planeClassification.kind
            });
          }

          return sendGuardedGptJsonResponse(req, res, {
            ok: false,
            action: planeClassification.action,
            error: {
              code: planeClassification.errorCode,
              message: planeClassification.message
            },
            canonical: planeClassification.canonical,
            _route: {
              requestId,
              gptId: incomingGptId,
              route:
                planeClassification.kind === 'job_lookup'
                  ? 'job_lookup_guard'
                  : 'control_guard',
              action: planeClassification.action,
              timestamp: new Date().toISOString()
            }
          }, 'gpt.response.control_rejected', 400);
        }
        if (planeClassification.plane === 'control' && planeClassification.kind === 'job_status') {
          const parsedJobStatusRequest = parseGptJobStatusRequest(effectiveBody);
          const routeMeta = buildJobLookupRouteMeta({
            requestId,
            gptId: incomingGptId,
            action: GPT_GET_STATUS_ACTION,
            route: 'job_status'
          });

          if (!parsedJobStatusRequest.ok) {
            requestLogger?.warn?.('gpt.request.status_lookup_invalid', {
              endpoint: req.originalUrl,
              gptId: incomingGptId,
              requestId,
              error: parsedJobStatusRequest.error
            });
            return sendGuardedGptJsonResponse(req, res, {
              ok: false,
              action: GPT_GET_STATUS_ACTION,
              error: {
                code: 'JOB_ID_INVALID',
                message: `get_status action requires payload.jobId. ${parsedJobStatusRequest.error}`
              },
              _route: routeMeta
            }, 'gpt.response.job_status_invalid', 400);
          }

          const job = await getJobById(parsedJobStatusRequest.jobId);
          requestLogger?.info?.('integration.job.status_lookup', {
            endpoint: req.originalUrl,
            gptId: incomingGptId,
            requestId,
            jobId: parsedJobStatusRequest.jobId,
            lookupStatus: job ? 'found' : 'not_found',
            jobStatus: job?.status ?? null,
            canonicalPath: `/jobs/${parsedJobStatusRequest.jobId}`
          });
          recordGptJobLookup({
            channel: 'gpt_action',
            lookup: 'status',
            outcome: job?.status ?? 'not_found'
          });

          if (!job) {
            return sendGuardedGptJsonResponse(req, res, {
              ok: false,
              action: GPT_GET_STATUS_ACTION,
              jobId: parsedJobStatusRequest.jobId,
              error: {
                code: 'JOB_NOT_FOUND',
                message: 'Async GPT job was not found.'
              },
              _route: routeMeta
            }, 'gpt.response.job_status_not_found', 404);
          }

          const jobStatusEnvelope = buildGptJobStatusBridgePayload(job);
          return sendGuardedGptJsonResponse(req, res, {
            ok: true,
            ...jobStatusEnvelope,
            _route: routeMeta
          }, 'gpt.response.job_status');
        }

        if (planeClassification.plane === 'control' && planeClassification.kind === 'job_result') {
          const parsedJobResultRequest = parseGptJobResultRequest(effectiveBody);
          const routeMeta = buildJobLookupRouteMeta({
            requestId,
            gptId: incomingGptId,
            action: GPT_GET_RESULT_ACTION,
            route: 'job_result'
          });

          if (!parsedJobResultRequest.ok) {
            requestLogger?.warn?.('gpt.request.result_lookup_invalid', {
              endpoint: req.originalUrl,
              gptId: incomingGptId,
              requestId,
              error: parsedJobResultRequest.error
            });
            return sendGuardedGptJsonResponse(req, res, {
              ok: false,
              action: GPT_GET_RESULT_ACTION,
              error: {
                code: 'JOB_ID_INVALID',
                message: `get_result action requires payload.jobId. ${parsedJobResultRequest.error}`
              },
              _route: routeMeta
            }, 'gpt.response.job_result_invalid', 400);
          }

          const jobLookup = buildGptJobResultBridgePayload(
            parsedJobResultRequest.jobId,
            await getJobById(parsedJobResultRequest.jobId)
          );
          requestLogger?.info?.('integration.job.result_lookup', {
            endpoint: req.originalUrl,
            gptId: incomingGptId,
            requestId,
            jobId: jobLookup.jobId,
            lookupStatus: jobLookup.status,
            jobStatus: jobLookup.jobStatus,
            lifecycleStatus: jobLookup.lifecycleStatus,
            canonicalPath: `/jobs/${jobLookup.jobId}/result`
          });
          requestLogger?.info?.('gpt.request.result_lookup', {
            endpoint: req.originalUrl,
            gptId: incomingGptId,
            requestId,
            jobId: jobLookup.jobId,
            lookupStatus: jobLookup.status,
            jobStatus: jobLookup.jobStatus,
            lifecycleStatus: jobLookup.lifecycleStatus
          });
          recordGptJobLookup({
            channel: 'gpt_action',
            lookup: 'result',
            outcome: jobLookup.status
          });

          return sendGuardedGptJsonResponse(req, res, {
            ok: true,
            ...jobLookup,
            _route: routeMeta
          }, 'gpt.response.job_result');
        }

        if (planeClassification.plane === 'control') {
          const directControlAction = normalizeGptDirectControlAction(planeClassification.action);
          if (directControlAction) {
            const directControlResponse = await dispatchDirectControlAction({
              req,
              requestId,
              gptId: incomingGptId,
              action: directControlAction,
              normalizedBody,
              promptText,
              logger: requestLogger,
            });

            if (directControlResponse.kind === 'prepared') {
              for (const [headerName, headerValue] of Object.entries(
                directControlResponse.headers ?? {}
              )) {
                res.setHeader(headerName, headerValue);
              }
              return res.status(directControlResponse.statusCode).json(directControlResponse.payload);
            }

            return sendGuardedGptJsonResponse(
              req,
              res,
              directControlResponse.payload,
              directControlResponse.logEvent,
              directControlResponse.statusCode
            );
          }
        }

        if (planeClassification.plane !== 'writing') {
          requestLogger?.error?.('gpt.request.control_plane_job_creation_blocked', {
            endpoint: req.originalUrl,
            gptId: incomingGptId,
            requestId,
            plane: planeClassification.plane,
            kind: planeClassification.kind,
            reason: planeClassification.reason
          });
          return res.status(500).json({
            ok: false,
            error: {
              code: 'CONTROL_PLANE_ROUTING_BREACH',
              message: 'Control-plane requests must exit before async GPT job planning.'
            },
            _route: {
              requestId,
              gptId: incomingGptId,
              route: 'control_guard',
              action: planeClassification.action,
              timestamp: new Date().toISOString()
            }
          });
        }

        const explicitIdempotencyKey = normalizeExplicitIdempotencyKey(
          req.header('Idempotency-Key') ?? req.header('idempotency-key')
        );
        if (explicitIdempotencyKey) {
          requestLogger?.info?.('gpt.request.idempotency_key_present', {
            endpoint: req.originalUrl,
            gptId: incomingGptId,
            requestId,
            idempotencyKeyHash: summarizeFingerprintHash(
              buildGptIdempotencyDescriptor({
                gptId: incomingGptId,
                action: effectiveRequestedAction,
                body: effectiveBody,
                actorKey: getRequestActorKey(req),
                explicitIdempotencyKey
              }).idempotencyKeyHash
            )
          });
          recordGptRequestEvent({
            event: 'idempotency_key_present',
            source: 'explicit'
          });
        }

        const fastPathDecision = classifyGptFastPathRequest({
          gptId: incomingGptId,
          body: effectiveBody,
          promptText,
          requestedAction: effectiveRequestedAction,
          routeTimeoutProfile,
          explicitMode: resolveRequestedFastPathMode(req, effectiveBody),
          hasExplicitIdempotencyKey: Boolean(explicitIdempotencyKey)
        });
        applyGptRouteDecisionHeaders(res, fastPathDecision);
        recordGptRouteDecision({
          path: fastPathDecision.path,
          reason: fastPathDecision.reason,
          queueBypassed: fastPathDecision.queueBypassed
        });
        requestLogger?.info?.('gpt.request.route_decision', {
          endpoint: req.originalUrl,
          gptId: incomingGptId,
          action: effectiveRequestedAction ?? 'query',
          path: fastPathDecision.path,
          reason: fastPathDecision.reason,
          queueBypassed: fastPathDecision.queueBypassed,
          promptLength: fastPathDecision.promptLength,
          messageCount: fastPathDecision.messageCount,
          maxWords: fastPathDecision.maxWords,
          timeoutMs: fastPathDecision.timeoutMs,
          promptGenerationIntent: fastPathDecision.promptGenerationIntent,
          explicitMode: fastPathDecision.explicitMode
        });

        let fastPathFallbackToOrchestrated = false;
        if (fastPathDecision.path === 'fast_path' && promptText) {
          const fastPathStartedAt = Date.now();
          const fastPathTimeoutMs = fastPathDecision.timeoutMs;
          try {
            const fastPathEnvelope = await executeFastGptPrompt({
              gptId: incomingGptId,
              prompt: promptText,
              requestId,
              timeoutMs: fastPathTimeoutMs,
              routeDecision: fastPathDecision,
              parentSignal: clientAbortController.signal,
              logger: requestLogger
            });
            const totalLatencyMs = Date.now() - fastPathStartedAt;
            recordGptFastPathLatency({
              gptId: incomingGptId,
              outcome: 'completed',
              durationMs: totalLatencyMs
            });
            requestLogger?.info?.('gpt.request.fast_path_completed', {
              endpoint: req.originalUrl,
              gptId: incomingGptId,
              requestId,
              latencyMs: totalLatencyMs,
              timeoutMs: fastPathTimeoutMs,
              queueBypassed: true
            });
            applyAIDegradedResponseHeaders(res, extractAIDegradedResponseMetadata(fastPathEnvelope.result));
            const fastPathSerializationStartedAt = Date.now();
            const publicEnvelope = prepareBoundedClientJsonPayload({
              ...fastPathEnvelope,
              result: shapeClientRouteResult(fastPathEnvelope.result),
            }, {
              logger: req.logger,
              logEvent: 'gpt.response.fast_path',
            });
            requestLogger?.info?.('gpt.response.serialization', {
              endpoint: req.originalUrl,
              gptId: incomingGptId,
              action: 'query',
              executionPath: 'fast_path',
              serializationMs: Date.now() - fastPathSerializationStartedAt,
              responseBytes: publicEnvelope.responseBytes,
              truncated: publicEnvelope.truncated,
            });
            return sendPreparedJsonResponse(res, publicEnvelope);
          } catch (error) {
            if (clientAbortController.signal.aborted) {
              throw error;
            }

            const totalLatencyMs = Date.now() - fastPathStartedAt;
            recordGptFastPathLatency({
              gptId: incomingGptId,
              outcome: 'fallback',
              durationMs: totalLatencyMs
            });
            res.setHeader('x-gpt-route-decision', 'orchestrated_path');
            res.setHeader('x-gpt-route-decision-reason', 'fast_path_fallback');
            res.setHeader('x-gpt-queue-bypassed', 'false');
            recordGptRouteDecision({
              path: 'orchestrated_path',
              reason: 'fast_path_fallback',
              queueBypassed: false
            });
            fastPathFallbackToOrchestrated = true;
            requestLogger?.warn?.('gpt.request.fast_path_fallback', {
              endpoint: req.originalUrl,
              gptId: incomingGptId,
              requestId,
              latencyMs: totalLatencyMs,
              timeoutMs: fastPathTimeoutMs,
              error: resolveErrorMessage(error)
            });
          }
        }

        const executionPlan = resolveGptExecutionPlan({
          req,
          gptId: incomingGptId,
          body: effectiveBody,
          promptText,
          requestedAction: effectiveRequestedAction,
          routeTimeoutProfile
        });
        const directReturnRequested =
          queryAndWaitRequested ||
          (
            !queryRequested &&
            explicitAsyncWaitForResultMs !== undefined &&
            executionPlan.mode === 'async'
          );
        let requestedAsyncWaitForResultMs = explicitAsyncWaitForResultMs;
        if (queryRequested) {
          requestedAsyncWaitForResultMs = 0;
        } else if (requestedAsyncWaitForResultMs === undefined) {
          if (queryAndWaitRequested) {
            requestedAsyncWaitForResultMs = DEFAULT_GPT_QUERY_AND_WAIT_TIMEOUT_MS;
          } else if (executionPlan.heavyPrompt) {
            requestedAsyncWaitForResultMs = readPositiveIntegerEnv(
              'GPT_ASYNC_HEAVY_WAIT_FOR_RESULT_MS',
              DEFAULT_GPT_ASYNC_HEAVY_WAIT_FOR_RESULT_MS
            );
          }
        }
        const asyncWaitForResultMs = clampAsyncWaitForRouteTimeout(
          resolveAsyncGptWaitForResultMs(requestedAsyncWaitForResultMs),
          routeTimeoutMs
        );
        const asyncPollIntervalMs = resolveAsyncGptPollIntervalMs(explicitAsyncPollIntervalMs);
        requestLogger?.info?.('gpt.request.execution_plan', {
          endpoint: req.originalUrl,
          gptId: incomingGptId,
          action: requestedAction ?? 'query',
          executionMode: executionPlan.mode,
          executionReason: executionPlan.reason,
          promptLength: executionPlan.promptLength,
          messageCount: executionPlan.messageCount,
          heavyPrompt: executionPlan.heavyPrompt,
          answerMode: executionPlan.answerMode,
          maxWords: executionPlan.maxWords,
          directReturnRequested,
          requestedAsyncWaitForResultMs: requestedAsyncWaitForResultMs ?? null,
          requestedAsyncPollIntervalMs: explicitAsyncPollIntervalMs ?? null,
          asyncWaitForResultMs,
          asyncPollIntervalMs
        });
        if (explicitAsyncWaitForResultMs !== undefined && !directReturnRequested) {
          requestLogger?.info?.('gpt.request.direct_return_ignored', {
            endpoint: req.originalUrl,
            gptId: incomingGptId,
            action: requestedAction ?? 'query',
            executionMode: executionPlan.mode,
            executionReason: executionPlan.reason,
            requestedWaitForResultMs: explicitAsyncWaitForResultMs
          });
        }
        if (directReturnRequested) {
          requestLogger?.info?.('gpt.request.direct_return_plan', {
            endpoint: req.originalUrl,
            gptId: incomingGptId,
            action: requestedAction ?? 'query',
            executionMode: executionPlan.mode,
            executionReason: executionPlan.reason,
            requestedWaitForResultMs: explicitAsyncWaitForResultMs,
            resolvedWaitForResultMs: asyncWaitForResultMs,
            requestedPollIntervalMs: explicitAsyncPollIntervalMs ?? null,
            resolvedPollIntervalMs: asyncPollIntervalMs
          });
        }

        const shouldUseJobBackedExecution =
          queryAndWaitRequested ||
          executionPlan.mode === 'async' ||
          fastPathFallbackToOrchestrated ||
          Boolean(explicitIdempotencyKey);

        if (shouldUseJobBackedExecution) {
          if (!normalizedBody) {
            if (explicitIdempotencyKey) {
              requestLogger?.warn?.('gpt.request.idempotency_invalid_body', {
                endpoint: req.originalUrl,
                gptId: incomingGptId,
                requestId,
                bodyType: typeof req.body
              });
              return sendGuardedGptJsonResponse(req, res, {
                ok: false,
                error: {
                  code: 'BAD_REQUEST',
                  message: 'Idempotent GPT requests require a JSON object request body.'
                },
                idempotencyKey: explicitIdempotencyKey,
                _route: {
                  requestId,
                  gptId: incomingGptId,
                  timestamp: new Date().toISOString()
                }
              }, 'gpt.response.idempotency_invalid_body', 400);
            }

            requestLogger?.warn?.('gpt.request.async_invalid_body_sync_fallback', {
              endpoint: req.originalUrl,
              gptId: incomingGptId,
              requestId,
              bodyType: typeof req.body,
              executionReason: executionPlan.reason
            });
          } else {
            const idempotencyDescriptor = buildGptIdempotencyDescriptor({
              gptId: incomingGptId,
              action: effectiveRequestedAction,
              body: effectiveBody,
              actorKey: getRequestActorKey(req),
              explicitIdempotencyKey
            });
            if (!explicitIdempotencyKey) {
              requestLogger?.info?.('gpt.request.idempotency_key_derived', {
                endpoint: req.originalUrl,
                gptId: incomingGptId,
                requestId,
                fingerprintHash: summarizeFingerprintHash(idempotencyDescriptor.fingerprintHash),
                scopeHash: summarizeFingerprintHash(idempotencyDescriptor.scopeHash)
              });
              recordGptRequestEvent({
                event: 'idempotency_key_derived',
                source: 'derived'
              });
            }
            const queuedGptJobInput = buildQueuedGptJobInput({
              gptId: incomingGptId,
              body: effectiveBody as Record<string, unknown>,
              prompt: promptText,
              bypassIntentRouting,
              requestId,
              routeHint: effectiveRequestedAction ?? 'query',
              requestPath: req.originalUrl,
              executionModeReason: executionPlan.reason
            });
            const plannedJob = await planAutonomousWorkerJob('gpt', queuedGptJobInput);
            let createResult;
            try {
              createResult = await findOrCreateGptJob({
                workerId: process.env.WORKER_ID || 'api',
                input: queuedGptJobInput,
                requestFingerprintHash: idempotencyDescriptor.fingerprintHash,
                idempotencyScopeHash: idempotencyDescriptor.scopeHash,
                idempotencyKeyHash: explicitIdempotencyKey
                  ? idempotencyDescriptor.idempotencyKeyHash
                  : null,
                idempotencyOrigin: idempotencyDescriptor.source,
                createOptions: plannedJob
              });
            } catch (error: unknown) {
              if (error instanceof IdempotencyKeyConflictError) {
                return sendGuardedGptJsonResponse(req, res, {
                  ok: false,
                  action: asyncBridgeAction,
                  error: {
                    code: 'IDEMPOTENCY_KEY_CONFLICT',
                    message: 'The supplied idempotency key is already bound to a different GPT request.'
                  },
                  idempotencyKey: idempotencyDescriptor.publicIdempotencyKey,
                  _route: {
                    requestId,
                    gptId: incomingGptId,
                    timestamp: new Date().toISOString()
                  }
                }, 'gpt.response.idempotency_conflict', 409);
              }

              if (error instanceof JobRepositoryUnavailableError) {
                if (explicitIdempotencyKey || queryAndWaitRequested || queryRequested) {
                  requestLogger?.error?.('gpt.request.idempotency_unavailable', {
                    endpoint: req.originalUrl,
                    gptId: incomingGptId,
                    requestId,
                    error: error.message
                  });
                  return sendGuardedGptJsonResponse(req, res, {
                    ok: false,
                    action: asyncBridgeAction,
                    error: {
                      code: (queryAndWaitRequested || queryRequested)
                        ? 'ASYNC_GPT_JOBS_UNAVAILABLE'
                        : 'IDEMPOTENCY_UNAVAILABLE',
                      message: queryAndWaitRequested
                        ? 'query_and_wait requires durable GPT job persistence, but the jobs backend is unavailable.'
                        : queryRequested
                        ? 'query requires durable GPT job persistence, but the jobs backend is unavailable.'
                        : 'Durable idempotency is unavailable because GPT job persistence is not configured.'
                    },
                    idempotencyKey: idempotencyDescriptor.publicIdempotencyKey,
                    _route: {
                      requestId,
                      gptId: incomingGptId,
                      timestamp: new Date().toISOString()
                    }
                  }, 'gpt.response.jobs_unavailable', 503);
                }

                requestLogger?.warn?.('gpt.request.async_unavailable_sync_fallback', {
                  endpoint: req.originalUrl,
                  gptId: incomingGptId,
                  requestId,
                  error: error.message,
                  executionReason: executionPlan.reason
                });
              } else {
                throw error;
              }
            }
            if (createResult) {
              const job = createResult.job;
              queuedJobId = job.id;
              queuedPendingResponse = buildQueuedGptPendingResponse({
                action: asyncBridgeAction,
                jobId: job.id,
                gptId: incomingGptId,
                requestId,
                jobStatus: job.status,
                lifecycleStatus: resolveGptJobLifecycleStatus(job.status),
                deduped: createResult.deduped,
                idempotencyKey: idempotencyDescriptor.publicIdempotencyKey,
                idempotencySource: idempotencyDescriptor.source
              });
              requestLogger?.info?.(createResult.deduped ? 'gpt.request.deduped' : 'gpt.request.async_enqueued', {
                endpoint: req.originalUrl,
                gptId: incomingGptId,
                jobId: job.id,
                dedupeReason: createResult.dedupeReason,
                deduped: createResult.deduped,
                idempotencySource: idempotencyDescriptor.source,
                fingerprintHash: summarizeFingerprintHash(idempotencyDescriptor.fingerprintHash),
                scopeHash: summarizeFingerprintHash(idempotencyDescriptor.scopeHash),
                planningReasons: plannedJob.planningReasons,
                priority: plannedJob.priority ?? null,
                nextRunAt: plannedJob.nextRunAt instanceof Date
                  ? plannedJob.nextRunAt.toISOString()
                  : plannedJob.nextRunAt ?? null,
                executionReason: executionPlan.reason
              });
              if (createResult.deduped) {
                recordGptRequestEvent({
                  event: 'deduped',
                  source: idempotencyDescriptor.source
                });
                requestLogger?.info?.('gpt.request.duplicate_prevention_race_loss', {
                  endpoint: req.originalUrl,
                  gptId: incomingGptId,
                  jobId: job.id,
                  dedupeReason: createResult.dedupeReason
                });
              } else {
                requestLogger?.info?.('gpt.request.duplicate_prevention_race_win', {
                  endpoint: req.originalUrl,
                  gptId: incomingGptId,
                  jobId: job.id
                });
              }
              if (queryAndWaitRequested) {
                requestLogger?.info?.('integration.job.query_and_wait_started', {
                  endpoint: req.originalUrl,
                  gptId: incomingGptId,
                  requestId,
                  jobId: job.id,
                  waitForResultMs: asyncWaitForResultMs,
                  pollIntervalMs: asyncPollIntervalMs,
                  deduped: createResult.deduped,
                  dedupeReason: createResult.dedupeReason
                });
              }

              if (queryRequested && !directReturnRequested) {
                requestLogger?.info?.('integration.job.query_created', {
                  endpoint: req.originalUrl,
                  gptId: incomingGptId,
                  requestId,
                  jobId: job.id,
                  deduped: createResult.deduped,
                  dedupeReason: createResult.dedupeReason
                });
                return sendGuardedGptJsonResponse(
                  req,
                  res,
                  queuedPendingResponse,
                  'gpt.response.async_pending',
                  202
                );
              }

              const waitedJob = await waitForQueuedGptJobCompletion(
                job.id,
                {
                  waitForResultMs: asyncWaitForResultMs,
                  pollIntervalMs: asyncPollIntervalMs
                }
              );

              if (waitedJob.state === 'completed') {
                const completedEnvelope = normalizeCompletedAsyncGptResponse(waitedJob.job.output);
                if (!completedEnvelope) {
                  requestLogger?.error?.('gpt.request.async_completed_invalid', {
                    endpoint: req.originalUrl,
                    gptId: incomingGptId,
                    jobId: job.id
                  });
                  return sendGuardedGptJsonResponse(req, res, {
                    ok: false,
                    action: asyncBridgeAction,
                    error: {
                      code: 'ASYNC_GPT_JOB_OUTPUT_INVALID',
                      message: 'Async GPT job completed without a valid envelope.'
                    },
                    jobId: job.id,
                    poll: `/jobs/${job.id}`,
                    stream: `/jobs/${job.id}/stream`,
                    _route: {
                      requestId,
                      gptId: incomingGptId,
                      timestamp: new Date().toISOString()
                    }
                  }, 'gpt.response.async_completed_invalid', 500);
                }

                const routingInfo: GptRoutingInfo = {
                  gptId: completedEnvelope._route.gptId,
                  moduleName: completedEnvelope._route.module ?? "unknown",
                  route: completedEnvelope._route.route ?? "unknown",
                  matchMethod: (completedEnvelope._route.matchMethod as any) ?? "none",
                };
                logGptConnection(routingInfo);
                logGptAckSent(routingInfo, (completedEnvelope._route.availableActions ?? []).length);
                applyAIDegradedResponseHeaders(
                  res,
                  extractAIDegradedResponseMetadata(completedEnvelope.result)
                );
                requestLogger?.info?.('gpt.request.async_completed', {
                  endpoint: req.originalUrl,
                  gptId: incomingGptId,
                  jobId: job.id,
                  module: completedEnvelope._route.module ?? 'unknown',
                  route: completedEnvelope._route.route ?? 'unknown',
                  deduped: createResult.deduped,
                  dedupeReason: createResult.dedupeReason,
                  ...summarizeGptJobTimings(waitedJob.job)
                });
                if (createResult.deduped && createResult.dedupeReason === 'reused_completed_result') {
                  requestLogger?.info?.('gpt.job.reused_completed_result', {
                    endpoint: req.originalUrl,
                    gptId: incomingGptId,
                    jobId: job.id
                  });
                  recordGptJobEvent({
                    event: 'reused_completed_result',
                    status: 'completed',
                    retryable: false
                  });
                }
                if (directReturnRequested) {
                  requestLogger?.info?.('gpt.request.direct_return_completed', {
                    endpoint: req.originalUrl,
                    gptId: incomingGptId,
                    jobId: job.id,
                    waitForResultMs: asyncWaitForResultMs,
                    pollIntervalMs: asyncPollIntervalMs,
                    deduped: createResult.deduped,
                    dedupeReason: createResult.dedupeReason
                  });
                }
                if (queryAndWaitRequested) {
                  requestLogger?.info?.('integration.job.query_and_wait_completed', {
                    endpoint: req.originalUrl,
                    gptId: incomingGptId,
                    requestId,
                    jobId: job.id,
                    waitForResultMs: asyncWaitForResultMs,
                    pollIntervalMs: asyncPollIntervalMs,
                    deduped: createResult.deduped,
                    dedupeReason: createResult.dedupeReason
                  });
                }

                const publicEnvelope = prepareBoundedClientJsonPayload({
                  ...completedEnvelope,
                  ...buildAsyncJobResponseMetadata({
                    action: asyncBridgeAction,
                    jobId: job.id,
                    jobStatus: waitedJob.job.status,
                    deduped: createResult.deduped,
                    idempotencyKey: idempotencyDescriptor.publicIdempotencyKey,
                    idempotencySource: idempotencyDescriptor.source
                  }),
                  result: shapeClientRouteResult(completedEnvelope.result),
                }, {
                  logger: req.logger,
                  logEvent: 'gpt.response.async_completed',
                });
                return sendPreparedJsonResponse(res, publicEnvelope);
              }

              if (waitedJob.state === 'failed') {
                requestLogger?.warn?.('gpt.request.async_failed', {
                  endpoint: req.originalUrl,
                  gptId: incomingGptId,
                  jobId: job.id,
                  error: waitedJob.job.error_message ?? 'Async GPT job failed.',
                  deduped: createResult.deduped,
                  ...summarizeGptJobTimings(waitedJob.job)
                });
                return sendGuardedGptJsonResponse(req, res, {
                  ok: false,
                  error: {
                    code: 'ASYNC_GPT_JOB_FAILED',
                    message: waitedJob.job.error_message ?? 'Async GPT job failed.'
                  },
                  ...buildAsyncJobResponseMetadata({
                    action: asyncBridgeAction,
                    jobId: job.id,
                    jobStatus: waitedJob.job.status,
                    deduped: createResult.deduped,
                    idempotencyKey: idempotencyDescriptor.publicIdempotencyKey,
                    idempotencySource: idempotencyDescriptor.source
                  }),
                  _route: {
                    requestId,
                    gptId: incomingGptId,
                    timestamp: new Date().toISOString()
                  }
                }, 'gpt.response.async_failed', 500);
              }

              if (waitedJob.state === 'cancelled') {
                requestLogger?.warn?.('gpt.job.cancelled', {
                  endpoint: req.originalUrl,
                  gptId: incomingGptId,
                  jobId: job.id,
                  deduped: createResult.deduped,
                  ...summarizeGptJobTimings(waitedJob.job)
                });
                recordGptJobEvent({
                  event: 'cancelled',
                  status: 'cancelled',
                  retryable: false
                });
                return sendGuardedGptJsonResponse(req, res, {
                  ok: false,
                  error: {
                    code: 'ASYNC_GPT_JOB_CANCELLED',
                    message: waitedJob.job.error_message ?? 'Async GPT job was cancelled.'
                  },
                  ...buildAsyncJobResponseMetadata({
                    action: asyncBridgeAction,
                    jobId: job.id,
                    jobStatus: waitedJob.job.status,
                    deduped: createResult.deduped,
                    idempotencyKey: idempotencyDescriptor.publicIdempotencyKey,
                    idempotencySource: idempotencyDescriptor.source
                  }),
                  _route: {
                    requestId,
                    gptId: incomingGptId,
                    timestamp: new Date().toISOString()
                  }
                }, 'gpt.response.async_cancelled', 409);
              }

              if (waitedJob.state === 'expired') {
                requestLogger?.warn?.('gpt.job.expired', {
                  endpoint: req.originalUrl,
                  gptId: incomingGptId,
                  jobId: job.id
                });
                recordGptJobEvent({
                  event: 'expired',
                  status: 'expired',
                  retryable: false
                });
                return sendGuardedGptJsonResponse(req, res, {
                  ok: false,
                  error: {
                    code: 'ASYNC_GPT_JOB_EXPIRED',
                    message: waitedJob.job.error_message ?? 'Async GPT job expired after its retention window.'
                  },
                  ...buildAsyncJobResponseMetadata({
                    action: asyncBridgeAction,
                    jobId: job.id,
                    jobStatus: waitedJob.job.status,
                    deduped: createResult.deduped,
                    idempotencyKey: idempotencyDescriptor.publicIdempotencyKey,
                    idempotencySource: idempotencyDescriptor.source
                  }),
                  _route: {
                    requestId,
                    gptId: incomingGptId,
                    timestamp: new Date().toISOString()
                  }
                }, 'gpt.response.async_expired', 410);
              }

              if (waitedJob.state === 'missing') {
                requestLogger?.error?.('gpt.request.async_missing', {
                  endpoint: req.originalUrl,
                  gptId: incomingGptId,
                  jobId: job.id
                });
                return sendGuardedGptJsonResponse(req, res, {
                  ok: false,
                  action: asyncBridgeAction,
                  error: {
                    code: 'ASYNC_GPT_JOB_MISSING',
                    message: 'Async GPT job disappeared before completion.'
                  },
                  jobId: job.id,
                  poll: `/jobs/${job.id}`,
                  stream: `/jobs/${job.id}/stream`,
                  _route: {
                    requestId,
                    gptId: incomingGptId,
                    timestamp: new Date().toISOString()
                  }
                }, 'gpt.response.async_missing', 500);
              }

              requestLogger?.info?.('gpt.request.async_pending', {
                endpoint: req.originalUrl,
                gptId: incomingGptId,
                jobId: job.id,
                waitForResultMs: asyncWaitForResultMs,
                pollIntervalMs: asyncPollIntervalMs,
                deduped: createResult.deduped,
                dedupeReason: createResult.dedupeReason
              });
              if (directReturnRequested) {
                requestLogger?.info?.('gpt.request.direct_return_timeout', {
                  endpoint: req.originalUrl,
                  gptId: incomingGptId,
                  jobId: job.id,
                  waitForResultMs: asyncWaitForResultMs,
                  pollIntervalMs: asyncPollIntervalMs,
                  jobStatus: waitedJob.job?.status ?? job.status,
                  deduped: createResult.deduped,
                  dedupeReason: createResult.dedupeReason
                });
                if (queryAndWaitRequested) {
                  requestLogger?.info?.('integration.job.query_and_wait_timeout', {
                    endpoint: req.originalUrl,
                    gptId: incomingGptId,
                    requestId,
                    jobId: job.id,
                    waitForResultMs: asyncWaitForResultMs,
                    pollIntervalMs: asyncPollIntervalMs,
                    jobStatus: waitedJob.job?.status ?? job.status,
                    deduped: createResult.deduped,
                    dedupeReason: createResult.dedupeReason
                  });
                }
                return sendGuardedGptJsonResponse(
                  req,
                  res,
                  buildDirectReturnTimeoutResponse({
                    pendingResponse: queuedPendingResponse,
                    jobId: job.id,
                    waitForResultMs: asyncWaitForResultMs,
                    pollIntervalMs: asyncPollIntervalMs
                  }),
                  'gpt.response.async_direct_return_timeout',
                  202
                );
              }
              return sendGuardedGptJsonResponse(
                req,
                res,
                queuedPendingResponse,
                'gpt.response.async_pending',
                202
              );
            }
          }
        }

        const envelope = await routeGptRequest({
          gptId: incomingGptId,
          body: effectiveBody,
          requestId,
          logger: requestLogger,
          request: req,
          bypassIntentRouting,
        });

        if (!envelope.ok) {
          applyAIDegradedResponseHeaders(res, extractAIDegradedResponseMetadata(envelope.error.details));
          const statusCode =
            envelope.error.code === "UNKNOWN_GPT"
              ? 404
              : envelope.error.code === "SYSTEM_STATE_CONFLICT"
              ? 409
              : envelope.error.code === "MODULE_TIMEOUT"
              ? 504
              : 400;
          requestLogger?.warn?.("gpt.request.route_result", {
            endpoint: req.originalUrl,
            gptId: incomingGptId,
            statusCode,
            ok: false,
            errorCode: envelope.error.code,
          });
          if (envelope.error.code === "UNKNOWN_GPT") {
            logGptConnectionFailed(incomingGptId);
            return sendGuardedGptJsonResponse(req, res, envelope, 'gpt.response.route_error', 404);
          }
          if (envelope.error.code === "SYSTEM_STATE_CONFLICT") {
            return sendGuardedGptJsonResponse(req, res, envelope, 'gpt.response.route_error', 409);
          }
          if (envelope.error.code === "MODULE_TIMEOUT") {
            return sendGuardedGptJsonResponse(req, res, envelope, 'gpt.response.route_error', 504);
          }
          return sendGuardedGptJsonResponse(req, res, envelope, 'gpt.response.route_error', 400);
        }

        const routingInfo: GptRoutingInfo = {
          gptId: envelope._route.gptId,
          moduleName: envelope._route.module ?? "unknown",
          route: envelope._route.route ?? "unknown",
          matchMethod: (envelope._route.matchMethod as any) ?? "none",
        };

        logGptConnection(routingInfo);
        logGptAckSent(routingInfo, (envelope._route.availableActions ?? []).length);
        applyAIDegradedResponseHeaders(res, extractAIDegradedResponseMetadata(envelope.result));
        requestLogger?.info?.("gpt.request.route_result", {
          endpoint: req.originalUrl,
          gptId: incomingGptId,
          statusCode: 200,
          ok: true,
          module: envelope._route.module ?? "unknown",
          route: envelope._route.route ?? "unknown",
        });

        if (
          envelope._route.route === 'diagnostic' &&
          typeof envelope.result === 'object' &&
          envelope.result !== null &&
          (envelope.result as Record<string, unknown>).route === 'diagnostic'
        ) {
          const diagnosticSerializationStartedAt = Date.now();
          const diagnosticPayload = prepareBoundedClientJsonPayload(
            shapeClientRouteResult(envelope.result) as Record<string, unknown>,
            {
              logger: req.logger,
              logEvent: 'gpt.response.diagnostic',
            }
          );
          requestLogger?.info?.('gpt.response.serialization', {
            endpoint: req.originalUrl,
            gptId: incomingGptId,
            action: envelope._route.action ?? 'diagnostic',
            serializationMs: Date.now() - diagnosticSerializationStartedAt,
            responseBytes: diagnosticPayload.responseBytes,
            truncated: diagnosticPayload.truncated,
          });
          return sendPreparedJsonResponse(res, diagnosticPayload);
        }

        const responseSerializationStartedAt = Date.now();
        const publicEnvelope = prepareBoundedClientJsonPayload({
          ...envelope,
          result: shapeClientRouteResult(envelope.result),
        }, {
          logger: req.logger,
          logEvent: 'gpt.response',
        });
        requestLogger?.info?.('gpt.response.serialization', {
          endpoint: req.originalUrl,
          gptId: incomingGptId,
          action: envelope._route.action ?? 'query',
          serializationMs: Date.now() - responseSerializationStartedAt,
          responseBytes: publicEnvelope.responseBytes,
          truncated: publicEnvelope.truncated,
        });

        return sendPreparedJsonResponse(res, publicEnvelope);
      }
    );
  } catch (err) {
    if (isAbortError(err)) {
      const promptText = extractPromptText(req.body);
      const gptId = req.params.gptId;
      const errorMessage = resolveErrorMessage(err);
      const routeTimedOut = isTimeoutAbortError(err, timeoutMessage);
      const clientDisconnected = isClientDisconnectAbort(err);
      if (routeTimedOut && promptText && hasDagOrchestrationIntentCue(promptText)) {
        recordDagTraceTimeout({
          handler: 'gpt-route',
          reason: 'request_timeout',
        });
      }
      req.logger?.warn?.(routeTimedOut ? 'gpt.request.timeout' : 'gpt.request.aborted', {
        endpoint: req.originalUrl,
        gptId: req.params.gptId,
        timeoutMs: routeTimeoutMs,
        error: errorMessage,
        abortKind: routeTimedOut ? 'route_timeout' : clientDisconnected ? 'client_disconnect' : 'request_abort',
        queuedJobId
      });
      const responseOpen = !res.headersSent && !res.writableEnded && !res.destroyed;
      if (routeTimedOut && responseOpen && queuedPendingResponse) {
        req.logger?.warn?.('gpt.request.timeout_pending', {
          endpoint: req.originalUrl,
          gptId,
          jobId: queuedJobId,
          timeoutMs: routeTimeoutMs,
          error: errorMessage,
        });
        return sendGuardedGptJsonResponse(
          req,
          res,
          queuedPendingResponse,
          'gpt.response.timeout_pending',
          202
        );
      }
      if (routeTimedOut && responseOpen && promptText && ARCANOS_CORE_GPT_IDS.has(gptId)) {
        const timeoutFallback = buildArcanosCoreTimeoutFallbackEnvelope({
          prompt: promptText,
          gptId,
          requestId,
          route: 'core'
        });
        applyAIDegradedResponseHeaders(res, extractAIDegradedResponseMetadata(timeoutFallback.result));
        req.logger?.warn?.('gpt.request.timeout_fallback', {
          endpoint: req.originalUrl,
          gptId,
          errorType: 'route_timeout_static_fallback',
          timeoutMs: routeTimeoutMs,
          error: errorMessage,
        });
        const publicEnvelope = prepareBoundedClientJsonPayload({
          ...timeoutFallback,
          result: shapeClientRouteResult(timeoutFallback.result),
        }, {
          logger: req.logger,
          logEvent: 'gpt.response.timeout_fallback',
        });
        return sendPreparedJsonResponse(res.status(200), publicEnvelope);
      }
      if (routeTimedOut && responseOpen) {
        return sendGuardedGptJsonResponse(req, res, {
          ok: false,
          error: {
            code: 'MODULE_TIMEOUT',
            message: timeoutMessage
          },
          _route: {
            requestId,
            gptId: req.params.gptId,
            timestamp: new Date().toISOString()
          }
        }, 'gpt.response.timeout', 504);
      }
      if (clientDisconnected && responseOpen) {
        res.destroy(err instanceof Error ? err : undefined);
        return;
      }
      if (responseOpen) {
        return sendGuardedGptJsonResponse(req, res, {
          ok: false,
          error: {
            code: 'REQUEST_ABORTED',
            message: 'Request was aborted before completion.'
          },
          _route: {
            requestId,
            gptId: req.params.gptId,
            timestamp: new Date().toISOString()
          }
        }, 'gpt.response.request_aborted', 503);
      }
      return;
    }

    req.logger?.error?.('gpt.request.unexpected_failure', {
      endpoint: req.originalUrl,
      gptId: req.params.gptId,
      error: resolveErrorMessage(err)
    });
    return next(err);
  } finally {
    res.off('close', abortForClosedClient);
  }
});

export default router;
