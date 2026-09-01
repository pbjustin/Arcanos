import crypto from 'node:crypto';
import express from "express";
import { DEFAULT_BACKSTAGE_UNIVERSE_ID } from '@arcanos/protocol';
import { resolveGptRouting, routeGptRequest } from "./_core/gptDispatch.js";
import { publicProviderGptAdmission } from '@transport/http/middleware/publicProviderAdmission.js';
import { canonicalGptIdentifierBoundary } from '@transport/http/middleware/canonicalGptIdentifierBoundary.js';
import {
  backstageMutationHttpBoundary,
  resolveBackstageMutationHttpOperation,
} from '@services/controlPlane/backstageMutationHttpBoundary.js';
import { backstageMutationConfirmationGate } from '@transport/http/middleware/backstageMutationConfirmationGate.js';
import {
  isBackstageNotionEnrichmentAuthorized,
  optionalBackstageNotionEnrichmentAuth,
} from '@services/backstageNotionEnrichmentAuthorization.js';
import {
  getAuthenticatedGptClientIdentity,
  isBackstageBookerAccessAuthenticated,
} from '@services/backstageBookerAccessAuth.js';
import { resolveBackstageNotionAuthorityRoot } from '@services/backstageNotionAuthority.js';
import { tryExtractExactLiteralPromptShortcut } from '@services/exactLiteralPromptShortcut.js';
import { detectBackstageBookerIntent } from '@services/backstageBookerRouteShortcut.js';
import {
  buildArcanosCoreTimeoutFallbackEnvelope,
  resolveArcanosCoreTimeoutPhase
} from "@services/arcanos-core.js";
import { classifyGptMemoryInterception } from '@services/memoryDispatchInterception.js';
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
import {
  createAbortError,
  getRequestAbortSignal,
  isAbortError,
  runWithRequestAbortTimeout
} from '@arcanos/runtime';
import { hasDagOrchestrationIntentCue } from '@services/naturalLanguageMemory.js';
import { shouldTreatPromptAsDagExecution } from '@shared/dag/dagExecutionRouting.js';
import {
  recordDagTraceTimeout,
  recordGptFastPathLatency,
  recordGptJobEvent,
  recordGptJobLookup,
  recordGptRequestEvent,
  recordGptRouteDecision,
  recordUnknownGpt
} from '@platform/observability/appMetrics.js';
import {
  IdempotencyKeyConflictError,
  JobRepositoryUnavailableError,
  findOrCreateGptJob
} from '@core/db/repositories/jobRepository.js';
import { planAutonomousWorkerJob } from '@services/workerAutonomyService.js';
import {
  buildQueuedGptBackstageMutationAdmission,
  buildQueuedGptJobInput,
  buildProtectedBackstageQueuedGptJobInput,
  buildQueuedGptPendingResponse,
  protectedBackstageQueuedGptJobMatchesIdentity,
  PROTECTED_BACKSTAGE_JOB_FINGERPRINT_DOMAIN,
} from '@shared/gpt/asyncGptJob.js';
import {
  unprotectBackstageQueuedGptJobOutput,
} from '@shared/backstage/backstageQueuedJobResultProtection.js';
import {
  buildBackstageBookerProtectedOverflowFailure,
  buildBackstageBookerProtectedFailureState,
  projectBackstageBookerManagedPendingResponse,
  resolveBackstageBookerProtectedPayloadRejection,
} from '@shared/backstage/backstageBookerAsyncContinuation.js';
import {
  readProtectedBackstageCompletionProvenance,
  resolveBackstageProtectedFailureCode,
} from '@shared/backstage/backstageProtectedFailure.js';
import {
  BackstageJobPayloadProtectionError,
  resolveBackstageJobPayloadProtectionConfig,
} from '@shared/backstage/backstageJobPayloadProtection.js';
import {
  BACKSTAGE_ROSTER_PERSISTENCE_ERROR_CODE,
  BACKSTAGE_ROSTER_PERSISTENCE_ERROR_MESSAGE,
  BACKSTAGE_ROSTER_VALIDATION_ERROR_CODE,
  isBackstageRosterValidationError
} from '@shared/backstage/backstageRoster.js';
import {
  BACKSTAGE_STORYLINE_PERSISTENCE_ERROR_CODE,
  BACKSTAGE_STORYLINE_PUBLIC_RESPONSE_MAX_BYTES,
  BACKSTAGE_STORYLINE_VALIDATION_ERROR_CODE,
  isBackstageStorylineValidationError
} from '@shared/backstage/backstageStoryline.js';
import {
  BACKSTAGE_MODULE_NAME,
  BACKSTAGE_MODULE_ROUTE,
  BACKSTAGE_ROUTE_TIMEOUT_MINIMUM_MS,
  BACKSTAGE_GENERATION_TOKEN_LIMIT_DEFAULT,
  classifyBackstageBookerWorkload,
  isBackstageGptRoute,
  resolveBackstageGptAction,
  type BackstageBookerWorkloadDecision,
} from '@shared/backstage/backstageActionPolicy.js';
import { resolveBackstageCompactOutputContract } from '@shared/backstage/backstageCompactOutputContract.js';
import {
  resolveBackstageInitialAcceptanceWaitMs,
  resolveGptAsyncHeavyWaitForResultMs,
} from '@shared/gpt/gptAsyncWaitPolicy.js';
import {
  BACKSTAGE_NOTION_AUTHORITY_READ_ONLY_ERROR_CODE,
  BACKSTAGE_NOTION_AUTHORITY_UNAVAILABLE_ERROR_CODE,
  BACKSTAGE_CANON_UNAVAILABLE_ERROR_CODE,
  BackstageBookerContractError,
  extractBackstageBookerCanonicalGenerationPrompt,
  markBackstageBookerExplicitPayload,
  markBackstageBookerFlattenedPayload,
  normalizeBackstageBookerIngressMutationPayload
} from '@services/backstageBookerContracts.js';
import {
  BACKSTAGE_NOTION_CURSOR_INVALID_ERROR_CODE,
  BACKSTAGE_NOTION_INDEX_UNAVAILABLE_ERROR_CODE,
  BACKSTAGE_NOTION_SCOPE_RESOLUTION_ERROR_CODE,
} from '@services/backstageNotionRag.js';
import {
  BACKSTAGE_BOOKER_INTEGRITY_FAILED_ERROR_CODE,
  BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE_ERROR_CODE,
  BACKSTAGE_CONTINUITY_QUERY_FAILED_ERROR_CODE,
} from '@shared/backstage/backstageGenerationError.js';
import {
  resolveBackstageCanonDomainErrorHttpStatus,
} from '@core/db/repositories/backstageBookerRepository.js';
import {
  buildResearchModulePreflightPayload,
  getResearchGptPromptPreflight,
  isResearchRequestValidationError,
  normalizeResearchModulePayload,
  RESEARCH_ACTION_NAME,
  RESEARCH_MODULE_NAME,
} from '@shared/researchRequest.js';
import { isDiagnosticRequest } from '@shared/http/diagnosticRequest.js';
import {
  canonicalResearchGptAdmissionBoundary,
  canonicalResearchGptPreflightBoundary,
} from './_core/researchGptPreflight.js';
import { resolveGptModuleRequestedActionAlias } from '@shared/gpt/gptModuleAction.js';
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
  mergeGptClientJobProvenanceIntoAutonomyState,
} from '@shared/gpt/gptClientRegistry.js';
import {
  resolveGptJobLifecycleStatus,
  summarizeGptJobTimings
} from '@shared/gpt/gptJobLifecycle.js';
import {
  PRIORITY_GPT_JOB_PRIORITY,
  isPriorityGpt,
  isPriorityQueueEnabled,
  resolveGptDirectExecutionThresholdMs,
  resolveGptWaitTimeoutMs
} from '@shared/gpt/priorityGpt.js';
import {
  startReservedPriorityGptDirectExecution,
  tryAcquirePriorityGptDirectExecutionSlot,
  type PriorityGptDirectExecutionSlot
} from '@services/priorityGptDirectExecutionService.js';
import { getRequestEstablishedActorKey } from '@platform/runtime/security.js';
import {
  GPT_QUERY_ACTION,
  GPT_QUERY_AND_WAIT_ACTION
} from '@shared/gpt/gptJobResult.js';
import { classifyGptRequestPlane } from './_core/gptPlaneClassification.js';
import {
  classifyGptFastPathRequest,
  type GptFastPathDecision,
  type GptFastPathModeHint
} from '@shared/gpt/gptFastPath.js';
import { ARCANOS_SUPPRESS_TIMEOUT_FALLBACK_FLAG } from '@shared/gpt/gptDirectAction.js';
import {
  buildGptDispatchPayload,
  extractGptPromptText,
  extractGptDispatchPromptText,
  extractGptPromptTextFromRecord,
  extractGptPromptTextFromRequest,
  resolveRequestedGptActionFromRequest,
} from '@shared/gpt/gptRequestAction.js';
import { executeDirectGptAction, executeFastGptPrompt } from '@services/gptFastPath.js';
import {
  formatGamingError,
  resolveGamingMode,
  validateGamingEvidenceRetryRequest
} from '@services/gamingModes.js';
import {
  dispatchPublicGamingRequest,
  isClearlyOperationalGamingPrompt,
  OPERATIONAL_REQUEST_NOT_GAMEPLAY_CODE,
  OPERATIONAL_REQUEST_NOT_GAMEPLAY_MESSAGE,
  type ArcanosRequestIntent,
  type PublicArcanosAction
} from '@services/gamingPublicDispatcher.js';
import {
  buildPublicGamingCanaryFailure,
  executePublicGamingCanary,
  prepareGuardedPublicGamingCanaryResponse,
  PUBLIC_GAMING_CANARY_MAX_RESPONSE_BYTES,
  PUBLIC_GAMING_CANARY_SCHEMA_VERSION,
  type PublicGamingCanaryResponse
} from '@services/publicGamingCanary.js';
import { getConfig } from '@platform/runtime/unifiedConfig.js';
import { handleGptDagBridge } from '@services/gptDagBridge.js';
import {
  isGptDagAction,
} from '@shared/gpt/gptDagBridgeActions.js';
import {
  authenticateMemoryPlaneRequest,
  sendMemoryPlaneAuthError,
  setMemoryPlaneNoStorePolicy,
} from '@transport/http/middleware/memoryPlaneAuth.js';
import {
  buildAsyncJobResponseMetadata,
  buildDirectReturnTimeoutResponse,
  normalizeCompletedAsyncGptResponse,
} from './_core/gptAsyncJobResponses.js';
import {
  classifyGptRouteExecution,
  type GptExecutionMode,
  type GptExecutionPlan,
} from './_core/gptRouteExecutionPolicy.js';
import { runResearchWithAbortDrain } from './_core/researchAbortDrain.js';
import {
  JOB_READ_AUTH_UNAVAILABLE_CODE,
  JOB_READ_AUTH_UNAVAILABLE_MESSAGE,
  JOB_READ_PROVENANCE_UNAVAILABLE_CODE,
  JOB_READ_PROVENANCE_UNAVAILABLE_MESSAGE,
  buildJobReadCapabilityResponseFields,
  isGenericJobCapabilityEligible,
  resolveConfiguredJobReadCapabilitySecret,
} from '@shared/jobs/jobReadCapability.js';

const router = express.Router();
const ASYNC_GPT_JOBS_UNAVAILABLE_MESSAGE =
  'Async GPT job status is temporarily unavailable because durable job persistence is unavailable.';
const ARCANOS_CORE_GPT_IDS = new Set(['arcanos-core', 'core', 'arcanos-daemon']);
const DIRECT_MODULE_QUERY_GPT_IDS = new Set(['arcanos-gaming', 'gaming']);
const GPT_DISPATCHER_ROUTE = '/gpt/:gptId';
const DEFAULT_GPT_ASYNC_HEAVY_PROMPT_CHARS = 1_200;
const DEFAULT_GPT_ASYNC_HEAVY_MESSAGE_COUNT = 8;
const DEFAULT_GPT_ASYNC_HEAVY_MAX_WORDS = 700;
const DIRECT_RETURN_ROUTE_TIMEOUT_HEADROOM_MS = 750;
const DIRECT_GAMING_ACTION_ROUTE_TIMEOUT_MS = 40_000;
const QUERY_AND_WAIT_DIRECT_ACTION_REASON = 'query_and_wait_direct_action';
const DIRECT_RETURN_WAIT_KEYS = [
  'waitForResultMs',
  'wait_for_result_ms',
  'timeoutMs',
  'timeout_ms'
];
const DIRECT_RETURN_POLL_KEYS = ['pollIntervalMs', 'poll_interval_ms'];
const BACKSTAGE_BOOKER_ASYNC_GENERATION_FLAG =
  'ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED';
const BACKSTAGE_UNIVERSE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const BACKSTAGE_PAYLOAD_PROVENANCE_ADAPTER = Object.freeze({
  markExplicitPayload: markBackstageBookerExplicitPayload,
  markFlattenedPayload: markBackstageBookerFlattenedPayload,
});

const OPENAI_KEY_PLACEHOLDERS = new Set([
  '',
  'your-openai-api-key-here',
  'your-openai-key-here',
  'mock-api-key',
  'sk-mock-for-ci-testing'
]);

function resolveDispatcherTraceId(req: express.Request, requestId: string | undefined): string {
  const traceId = typeof req.traceId === 'string' && req.traceId.trim().length > 0
    ? req.traceId.trim()
    : '';
  if (traceId) {
    return traceId;
  }

  const fallbackRequestId = typeof requestId === 'string' && requestId.trim().length > 0
    ? requestId.trim()
    : '';
  return fallbackRequestId || crypto.randomUUID();
}

function isConfiguredOpenAIKey(value: string | undefined): boolean {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 &&
    !OPENAI_KEY_PLACEHOLDERS.has(trimmed) &&
    !trimmed.startsWith('sk-mock-');
}

function hasConfiguredOpenAIKey(): boolean {
  return isConfiguredOpenAIKey(getConfig().openaiApiKey);
}

function logGptDispatcherOutcome(params: {
  req: express.Request;
  traceId: string;
  gptId: string;
  action: string;
  status: number;
  error?: {
    name?: string;
    message?: string;
  };
}): void {
  const payload = {
    traceId: params.traceId,
    route: GPT_DISPATCHER_ROUTE,
    action: params.action,
    gptId: params.gptId,
    status: params.status,
    ...(params.error
      ? {
          errorName: params.error.name ?? 'Error',
          errorMessage: params.error.message ?? ''
        }
      : {})
  };

  if (params.status >= 500) {
    params.req.logger?.error('gpt.dispatcher.response', payload);
  } else if (params.status >= 400) {
    params.req.logger?.warn('gpt.dispatcher.response', payload);
  } else {
    params.req.logger?.info('gpt.dispatcher.response', payload);
  }
}

function logPublicGamingDispatch(params: {
  req: express.Request;
  requestId: string;
  traceId: string;
  action: PublicArcanosAction | typeof GPT_QUERY_AND_WAIT_ACTION | 'unsupported';
  intent: ArcanosRequestIntent;
  route: 'gaming' | 'operational_rejected' | 'public_canary' | 'unsupported';
  mode: 'guide' | 'build' | 'meta' | null;
}): void {
  params.req.logger?.info('gpt.public_gaming.dispatch', {
    requestId: params.requestId,
    traceId: params.traceId,
    action: params.action,
    intent: params.intent,
    route: params.route,
    mode: params.mode,
    schemaVersion: PUBLIC_GAMING_CANARY_SCHEMA_VERSION
  });
}

function sendGuardedPublicGamingCanaryResponse(
  req: express.Request,
  res: express.Response,
  response: PublicGamingCanaryResponse,
  statusCode: 200 | 400 | 500 | 503,
  logEvent: string
) {
  const guarded = prepareGuardedPublicGamingCanaryResponse({
    response,
    statusCode,
    requestId: req.requestId,
    traceId: req.traceId
  });

  return sendBoundedJsonResponse(req, res, guarded.response, {
    logEvent,
    statusCode: guarded.statusCode,
    maxBytes: PUBLIC_GAMING_CANARY_MAX_RESPONSE_BYTES
  });
}

function buildDispatcherRouteMeta(params: {
  requestId: string | undefined;
  traceId: string;
  gptId: string;
  action: string;
  route: string;
}) {
  return {
    requestId: params.requestId,
    traceId: params.traceId,
    gptId: params.gptId,
    action: params.action,
    route: params.route,
    timestamp: new Date().toISOString()
  };
}

function buildGptDispatcherErrorPayload(params: {
  requestId: string | undefined;
  traceId: string;
  gptId: string;
  action: string;
  code: string;
  message: string;
  route?: string;
  details?: Record<string, unknown>;
}) {
  return {
    ok: false,
    requestId: params.requestId ?? params.traceId,
    gptId: params.gptId,
    action: params.action,
    route: GPT_DISPATCHER_ROUTE,
    code: params.code,
    traceId: params.traceId,
    error: {
      code: params.code,
      message: params.message,
      ...(params.details ? { details: params.details } : {})
    },
    _route: buildDispatcherRouteMeta({
      requestId: params.requestId,
      traceId: params.traceId,
      gptId: params.gptId,
      action: params.action,
      route: params.route ?? 'dispatcher'
    })
  };
}

function extractDispatcherResultText(result: unknown): string {
  if (typeof result === 'string') {
    return result.trim();
  }

  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    const textCandidate =
      record.result ??
      record.outputText ??
      record.output_text ??
      record.text ??
      record.answer ??
      record.content;
    if (typeof textCandidate === 'string' && textCandidate.trim().length > 0) {
      return textCandidate.trim();
    }
  }

  try {
    return JSON.stringify(result);
  } catch {
    return String(result ?? '');
  }
}

function readPayloadRecord(
  normalizedBody: Record<string, unknown> | null
): Record<string, unknown> | null {
  const payload = normalizedBody?.payload;
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

function readBackstageUniverseId(body: unknown): string | null {
  const normalizedBody = normalizeGptRequestBody(body);
  const payload = readPayloadRecord(normalizedBody);
  const candidate = payload?.universeId ?? normalizedBody?.universeId;
  return typeof candidate === 'string'
    && candidate === candidate.trim()
    && BACKSTAGE_UNIVERSE_ID_PATTERN.test(candidate)
      ? candidate
      : null;
}

function classifyBackstageRouteWorkload(params: {
  body: unknown;
  moduleName: string;
  action: string | null | undefined;
  promptText: string | null;
  requestedExecutionMode: GptExecutionMode | null;
}): BackstageBookerWorkloadDecision | null {
  if (params.moduleName !== BACKSTAGE_MODULE_NAME) {
    return null;
  }

  const action = resolveBackstageGptAction(params.action);
  const prompt = params.promptText ?? '';
  const outputContract = resolveBackstageCompactOutputContract(
    prompt,
    BACKSTAGE_GENERATION_TOKEN_LIMIT_DEFAULT
  );
  const universeId = readBackstageUniverseId(params.body);
  const authorizationEstablished = isBackstageNotionEnrichmentAuthorized();
  const notionAuthorityContext = authorizationEstablished
    && universeId !== null
    && resolveBackstageNotionAuthorityRoot(universeId) !== null;

  return classifyBackstageBookerWorkload({
    action,
    authorizationEstablished,
    requestedExecutionMode: params.requestedExecutionMode,
    promptCodeUnits: prompt.length,
    contextCodeUnits: 0,
    expectedItemCount: outputContract.itemPolicy.budgetItemCount,
    expectedOutputWords: outputContract.wordBounds.totalWordLimit,
    notionAuthorityContext,
    completeBookingContainerComponentCount:
      outputContract.completeBookingContainerComponentCount
      || outputContract.alternativeCardContainerRequest,
    providerInvocationRequired:
      !prompt || tryExtractExactLiteralPromptShortcut(prompt) === null,
  });
}

function shouldUseDagExecutionTimeoutProfile(prompt: string | null): boolean {
  if (!prompt || !hasDagOrchestrationIntentCue(prompt)) {
    return false;
  }

  return shouldTreatPromptAsDagExecution(prompt);
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

function readStrictBooleanEnv(name: string, fallbackValue: boolean): boolean {
  const rawValue = process.env[name];
  if (rawValue === 'true') {
    return true;
  }
  if (rawValue === 'false') {
    return false;
  }
  return fallbackValue;
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
    readBooleanEnv('GPT_ROUTE_ASYNC_CORE_DEFAULT', false);
}

function isDirectModuleQueryGpt(gptId: string): boolean {
  return DIRECT_MODULE_QUERY_GPT_IDS.has(gptId.trim().toLowerCase());
}

function resolvePublicGamingMode(body: unknown) {
  const normalizedBody = normalizeGptRequestBody(body);
  const payload = readPayloadRecord(normalizedBody);
  return resolveGamingMode(payload) ?? resolveGamingMode(normalizedBody);
}

function isControlledGamingDispatcherError(
  code: string
): code is 'MODULE_TIMEOUT' | 'REQUEST_ABORTED' {
  return code === 'MODULE_TIMEOUT' || code === 'REQUEST_ABORTED';
}

function buildControlledGamingErrorResponse(params: {
  body: unknown;
  requestId: string | undefined;
  traceId: string;
  gptId: string;
  dispatcherCode: 'MODULE_TIMEOUT' | 'REQUEST_ABORTED';
  timeoutMs?: number;
  timeoutPhase?: string;
  routeMeta?: Record<string, unknown>;
}) {
  const requestId = params.requestId ?? params.traceId;
  const errorCode = params.dispatcherCode === 'MODULE_TIMEOUT'
    ? 'GENERATION_TIMEOUT'
    : params.dispatcherCode;
  const message = params.dispatcherCode === 'MODULE_TIMEOUT'
    ? 'Gaming generation timed out before a complete answer was available.'
    : 'Gaming generation was aborted before a complete answer was available.';
  const timeoutDetails = params.dispatcherCode === 'MODULE_TIMEOUT'
    ? {
        ...(typeof params.timeoutMs === 'number' ? { timeoutMs: params.timeoutMs } : {}),
        ...(params.timeoutPhase ? { timeoutPhase: params.timeoutPhase } : {})
      }
    : undefined;

  return {
    ok: true as const,
    requestId,
    traceId: params.traceId,
    result: formatGamingError({
      mode: resolvePublicGamingMode(params.body),
      error: {
        code: errorCode,
        message,
        ...(timeoutDetails && Object.keys(timeoutDetails).length > 0
          ? { details: timeoutDetails }
          : {})
      }
    }),
    _route: {
      ...(params.routeMeta ?? {}),
      requestId,
      traceId: params.traceId,
      gptId: params.gptId,
      module: 'ARCANOS:GAMING',
      action: GPT_QUERY_ACTION,
      route: 'gaming',
      timestamp:
        typeof params.routeMeta?.timestamp === 'string'
          ? params.routeMeta.timestamp
          : new Date().toISOString()
    }
  };
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

  return classifyGptRouteExecution({
    explicitExecutionMode,
    requestedAction: params.requestedAction,
    promptPresent: Boolean(params.promptText),
    promptLength,
    messageCount,
    answerMode,
    maxWords,
    heavyPrompt,
    directModuleQuery: isDirectModuleQueryGpt(params.gptId),
    coreGpt: ARCANOS_CORE_GPT_IDS.has(params.gptId),
    coreQueryAsyncDefault: shouldDefaultCoreQueriesToAsync(
      params.gptId,
      params.requestedAction
    ),
  });
}

function clampAsyncWaitForRouteTimeout(waitForResultMs: number, routeTimeoutMs: number): number {
  const routeSafeWaitBudgetMs = Math.max(
    0,
    routeTimeoutMs - DIRECT_RETURN_ROUTE_TIMEOUT_HEADROOM_MS
  );
  return Math.min(waitForResultMs, routeSafeWaitBudgetMs);
}

function shouldUseQueryAndWaitDirectActionLane(params: {
  queryAndWaitRequested: boolean;
  gptId: string;
  promptText: string | null;
}): boolean {
  if (!params.queryAndWaitRequested || !params.promptText) {
    return false;
  }

  return ARCANOS_CORE_GPT_IDS.has(params.gptId);
}

function resolveQueryAndWaitDirectActionTimeoutMs(params: {
  requestedWaitForResultMs: number | undefined;
  routeTimeoutMs: number;
}): number {
  const requestedWaitMs = params.requestedWaitForResultMs ?? resolveGptWaitTimeoutMs();
  return Math.max(
    1,
    clampAsyncWaitForRouteTimeout(
      resolveAsyncGptWaitForResultMs(requestedWaitMs),
      params.routeTimeoutMs
    )
  );
}

function buildQueryAndWaitDirectRouteDecision(params: {
  body: unknown;
  promptText: string;
  timeoutMs: number;
  explicitMode: GptFastPathModeHint;
}): GptFastPathDecision {
  return {
    path: 'fast_path',
    eligible: true,
    reason: QUERY_AND_WAIT_DIRECT_ACTION_REASON,
    queueBypassed: true,
    promptLength: params.promptText.length,
    messageCount: extractMessageCount(params.body),
    maxWords: extractMaxWords(params.body),
    timeoutMs: params.timeoutMs,
    action: GPT_QUERY_AND_WAIT_ACTION,
    promptGenerationIntent: false,
    explicitMode: params.explicitMode
  };
}

function resolveDirectGptActionFailureStatus(error: unknown): number {
  if (isAbortError(error)) {
    return 504;
  }

  const message = resolveErrorMessage(error).toLowerCase();
  if (message.includes('openai client unavailable') || message.includes('client unavailable')) {
    return 503;
  }

  if (message.includes('returned empty output')) {
    return 500;
  }

  const status = (error as { status?: unknown; statusCode?: unknown } | null)?.status;
  const statusCode = typeof status === 'number'
    ? status
    : (error as { statusCode?: unknown } | null)?.statusCode;
  if (typeof statusCode === 'number' && Number.isInteger(statusCode)) {
    if (statusCode === 429) {
      return 429;
    }

    if (statusCode >= 500 && statusCode <= 599) {
      return 502;
    }
  }

  return 502;
}

function resolveDefaultGptQueryAndWaitRouteTimeoutMs(): number {
  return resolveGptWaitTimeoutMs() + DIRECT_RETURN_ROUTE_TIMEOUT_HEADROOM_MS;
}

function sendGuardedGptJsonResponse(
  req: express.Request,
  res: express.Response,
  payload: object,
  logEvent: string,
  statusCode = 200,
  bounds: {
    maxBytes?: number;
    maxBytesCeiling?: number;
    overflowPayload?: Record<string, unknown>;
    overflowStatusCode?: number;
  } = {}
) {
  const payloadRecord = projectAsyncJobResponseForRequest(
    req,
    payload
  ) as Record<string, unknown>;
  const requestId = req.requestId ?? req.traceId ?? 'unknown';
  const traceId = req.traceId ?? requestId;
  const correlatedPayload = payloadRecord.ok === false
    ? {
        ...payloadRecord,
        requestId,
        traceId,
        ...(payloadRecord._route && typeof payloadRecord._route === 'object' && !Array.isArray(payloadRecord._route)
          ? {
              _route: {
                ...(payloadRecord._route as Record<string, unknown>),
                requestId,
                traceId
              }
            }
          : {})
      }
    : payloadRecord;
  const protectedOverflowPayload =
    buildBackstageBookerProtectedOverflowFailure(correlatedPayload);
  return sendBoundedJsonResponse(req, res, correlatedPayload, {
    logEvent,
    statusCode,
    ...bounds,
    ...(protectedOverflowPayload
      ? {
          overflowPayload: protectedOverflowPayload,
          overflowStatusCode: 503,
        }
      : {}),
  });
}

function projectAsyncJobResponseForRequest(
  req: express.Request,
  payload: object
): object {
  const jobId = (payload as Record<string, unknown>).jobId;
  return typeof jobId === 'string'
    && jobId.length > 0
    && req.params.gptId === BACKSTAGE_MODULE_ROUTE
    && isBackstageBookerAccessAuthenticated(req)
    ? projectBackstageBookerManagedPendingResponse({
        ...(payload as Record<string, unknown>),
        jobId,
      })
    : payload;
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
  normalizedQueryBody[ARCANOS_SUPPRESS_TIMEOUT_FALLBACK_FLAG] = true;
  if (readBooleanEnv('GPT_ROUTE_ASYNC_CORE_DEFAULT', false)) {
    normalizedQueryBody.executionMode = 'async';
  }
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

  if (extractGptPromptTextFromRecord(normalizedBody)) {
    return normalizedBody;
  }

  return {
    ...normalizedBody,
    prompt: promptText
  };
}

function normalizeBackstageRosterMutationBody(body: unknown): Record<string, unknown> {
  const bodyRecord = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const normalizedPayload = normalizeBackstageBookerIngressMutationPayload(
    'updateRoster',
    body,
    'canonical-gpt'
  );
  const preserveLegacyArray = Array.isArray(bodyRecord.payload)
    && !Object.prototype.hasOwnProperty.call(bodyRecord, 'universeId');

  return {
    ...bodyRecord,
    payload: preserveLegacyArray ? normalizedPayload.wrestlers : normalizedPayload
  };
}

function normalizeBackstageStorylineMutationBody(body: unknown): Record<string, unknown> {
  const bodyRecord = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const normalizedPayload = normalizeBackstageBookerIngressMutationPayload(
    'trackStoryline',
    body,
    'canonical-gpt'
  );
  const explicitPayload = bodyRecord.payload;
  const preserveLegacyPayload = Object.prototype.hasOwnProperty.call(bodyRecord, 'payload')
    && explicitPayload !== null
    && typeof explicitPayload === 'object'
    && !Array.isArray(explicitPayload)
    && !Object.prototype.hasOwnProperty.call(
      explicitPayload as Record<string, unknown>,
      'universeId'
    )
    && !Object.prototype.hasOwnProperty.call(bodyRecord, 'universeId');

  return {
    ...bodyRecord,
    payload: preserveLegacyPayload ? normalizedPayload.beat : normalizedPayload
  };
}

type BackstageCanonMutationAction = 'upsertStoryline' | 'appendCanonBeat';

const BACKSTAGE_CANON_MUTATION_DOMAIN_FIELDS: Readonly<
  Record<BackstageCanonMutationAction, readonly string[]>
> = Object.freeze({
  upsertStoryline: Object.freeze([
    'universeId',
    'mutationId',
    'expectedVersion',
    'storyline',
  ]),
  appendCanonBeat: Object.freeze([
    'universeId',
    'mutationId',
    'storylineKey',
    'expectedVersion',
    'beat',
    'nextStatus',
  ]),
});

function normalizeBackstageCanonMutationBody(
  body: unknown,
  action: BackstageCanonMutationAction
): Record<string, unknown> {
  const bodyRecord = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const normalizedPayload = normalizeBackstageBookerIngressMutationPayload(
    action,
    body,
    'canonical-gpt'
  );
  const normalizedBody: Record<string, unknown> = {
    ...bodyRecord,
    payload: normalizedPayload,
  };

  // Flattened canonical requests may carry their domain fields at the transport
  // root. Once the shared contract has materialized the canonical payload, keep
  // only that copy so queued persistence and request fingerprints cannot retain
  // a second, non-normalized UUID or timestamp representation.
  for (const field of BACKSTAGE_CANON_MUTATION_DOMAIN_FIELDS[action]) {
    delete normalizedBody[field];
  }

  return normalizedBody;
}

function validateResearchGptRequestBody(body: unknown): void {
  normalizeResearchModulePayload(
    buildResearchModulePreflightPayload(body),
  );
}

function normalizeFailedBackstageRosterPersistenceOutput(output: unknown): {
  code: typeof BACKSTAGE_ROSTER_PERSISTENCE_ERROR_CODE;
  message: typeof BACKSTAGE_ROSTER_PERSISTENCE_ERROR_MESSAGE;
} | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return null;
  }

  const candidate = output as Record<string, unknown>;
  const error = candidate.error;
  const route = candidate._route;
  if (
    candidate.ok !== false
    || !error
    || typeof error !== 'object'
    || Array.isArray(error)
    || !route
    || typeof route !== 'object'
    || Array.isArray(route)
  ) {
    return null;
  }

  const errorRecord = error as Record<string, unknown>;
  const routeRecord = route as Record<string, unknown>;
  if (
    errorRecord.code !== BACKSTAGE_ROSTER_PERSISTENCE_ERROR_CODE
    || routeRecord.module !== BACKSTAGE_MODULE_NAME
    || routeRecord.action !== 'updateRoster'
  ) {
    return null;
  }

  return {
    code: BACKSTAGE_ROSTER_PERSISTENCE_ERROR_CODE,
    message: BACKSTAGE_ROSTER_PERSISTENCE_ERROR_MESSAGE
  };
}

function resolveAsyncBridgeAction(queryAndWaitRequested: boolean) {
  return queryAndWaitRequested
    ? GPT_QUERY_AND_WAIT_ACTION
    : GPT_QUERY_ACTION;
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

function applyGptRouteDecisionHeaders(
  res: express.Response,
  decision: GptFastPathDecision
): void {
  res.setHeader('x-gpt-route-decision', decision.path);
  res.setHeader('x-gpt-route-decision-reason', decision.reason);
  res.setHeader('x-gpt-fast-path-queue-bypassed', decision.queueBypassed ? 'true' : 'false');
  res.setHeader('x-gpt-queue-bypassed', 'false');
}

function applyGptQueueBypassedHeader(
  res: express.Response,
  queueBypassed: boolean
): void {
  res.setHeader('x-gpt-queue-bypassed', queueBypassed ? 'true' : 'false');
}

router.post('/arcanos-gaming/canary', (req, res) => {
  const startedAt = Date.now();
  const requestId = req.requestId;
  const traceId = resolveDispatcherTraceId(req, requestId);
  const decision = dispatchPublicGamingRequest(req.body, 'canary');
  applyCanonicalGptRouteHeaders(res, 'arcanos-gaming');

  logPublicGamingDispatch({
    req,
    requestId: requestId ?? traceId,
    traceId,
    action: decision.action,
    intent: decision.intent,
    route: decision.ok ? 'public_canary' : 'unsupported',
    mode: null
  });

  if (!decision.ok) {
    const response = buildPublicGamingCanaryFailure({
      code: 'BAD_REQUEST',
      requestId,
      traceId,
      durationMs: Date.now() - startedAt
    });
    return sendGuardedPublicGamingCanaryResponse(
      req,
      res,
      response,
      400,
      'gpt.response.public_canary_bad_request'
    );
  }

  const result = executePublicGamingCanary({ requestId, traceId, startedAtMs: startedAt });
  return sendGuardedPublicGamingCanaryResponse(
    req,
    res,
    result.response,
    result.statusCode,
    'gpt.response.public_canary'
  );
});

router.post('/arcanos-gaming/evidence-retry', (req, res, next) => {
  const validation = validateGamingEvidenceRetryRequest(req.body);
  if (!validation.ok) {
    const requestId = req.requestId;
    const traceId = resolveDispatcherTraceId(req, requestId);
    applyCanonicalGptRouteHeaders(res, 'arcanos-gaming');
    const errorPayload = buildGptDispatcherErrorPayload({
      requestId,
      traceId,
      gptId: 'arcanos-gaming',
      action: 'query',
      code: validation.code,
      message: validation.message,
      route: 'gaming_evidence_retry_validation'
    });
    logGptDispatcherOutcome({
      req,
      traceId,
      gptId: 'arcanos-gaming',
      action: 'query',
      status: 400,
      error: { name: validation.code, message: validation.message }
    });
    return sendGuardedGptJsonResponse(
      req,
      res,
      errorPayload,
      'gpt.response.gaming_evidence_retry_validation',
      400
    );
  }

  req.body = {
    action: 'query',
    payload: {
      mode: validation.value.mode,
      game: validation.value.game,
      prompt: validation.value.originalPrompt,
      guideUrls: validation.value.candidateUrls,
      evidenceOrigin: 'frontend_web_search',
      evidenceAttempt: 1,
      ...(validation.value.requestedVersion
        ? { requestedVersion: validation.value.requestedVersion }
        : {})
    }
  };
  req.url = '/arcanos-gaming';
  return next('route');
});

router.post(
  "/:gptId",
  canonicalGptIdentifierBoundary,
  backstageMutationHttpBoundary,
  backstageMutationConfirmationGate,
  optionalBackstageNotionEnrichmentAuth,
  canonicalResearchGptAdmissionBoundary,
  publicProviderGptAdmission,
  canonicalResearchGptPreflightBoundary,
  async (req, res, next) => {
  const routeGptId = req.params.gptId;
  const priorityGpt = isPriorityGpt(routeGptId);
  const directGamingRoute = isDirectModuleQueryGpt(routeGptId);
  const requestedAction = resolveRequestedGptActionFromRequest(req);
  const queryRequested = requestedAction === GPT_QUERY_ACTION;
  const queryAndWaitRequested = requestedAction === GPT_QUERY_AND_WAIT_ACTION;
  const bypassIntentRouting = queryRequested || queryAndWaitRequested;
  const asyncBridgeAction = resolveAsyncBridgeAction(queryAndWaitRequested);
  const researchGptPreflight = getResearchGptPromptPreflight(req);
  const promptText = researchGptPreflight?.validationComplete
    ? researchGptPreflight.promptText
    : extractGptPromptTextFromRequest(req);
  const routeTimeoutProfile = shouldUseDagExecutionTimeoutProfile(promptText)
    ? 'dag_execution'
    : 'default';
  const explicitAsyncWaitForResultMs = readRequestedAsyncGptWaitForResultMs(req, req.body);
  const explicitAsyncPollIntervalMs = readRequestedAsyncGptPollIntervalMs(req, req.body);
  const queryAndWaitRequestedTimeoutMs =
    explicitAsyncWaitForResultMs ?? resolveGptWaitTimeoutMs();
  const backstageRoute = isBackstageGptRoute(routeGptId);
  const routeTimeoutMs = directGamingRoute
    ? DIRECT_GAMING_ACTION_ROUTE_TIMEOUT_MS
    : resolveGptRouteHardTimeoutMs({
        profile: routeTimeoutProfile,
        ...(backstageRoute
          ? { minimumMsOverride: BACKSTAGE_ROUTE_TIMEOUT_MINIMUM_MS }
          : {}),
        ...(queryAndWaitRequested && routeTimeoutProfile === 'default'
          ? {
              defaultMsOverride: Math.max(
                resolveDefaultGptQueryAndWaitRouteTimeoutMs(),
                queryAndWaitRequestedTimeoutMs + DIRECT_RETURN_ROUTE_TIMEOUT_HEADROOM_MS
              )
            }
          : {})
      });
  const requestId = (req as any).requestId;
  const traceId = resolveDispatcherTraceId(req, requestId);
  let queuedJobId: string | null = null;
  let queuedPendingResponse:
    | ReturnType<typeof buildQueuedGptPendingResponse>
    | null = null;
  let queuedAsyncWaitForResultMs: number | null = null;
  let queuedAsyncPollIntervalMs: number | null = null;
  let backstageInitialAcceptanceStartedAtMs: number | null = null;
  let backstageInitialAcceptanceAction: string | null = null;
  let protectedBackstageRequestAction: string | null = null;
  const timeoutMessage = `GPT route timeout after ${routeTimeoutMs}ms`;
  const clientAbortController = new AbortController();
  const abortForClosedClient = () => {
    if (!res.writableEnded) {
      clientAbortController.abort(createAbortError('GPT route client disconnected'));
    }
  };

  res.on('close', abortForClosedClient);

  try {
    const runRouteWithAbort = researchGptPreflight
      ? runResearchWithAbortDrain
      : runWithRequestAbortTimeout;
    return await runRouteWithAbort(
      {
        timeoutMs: routeTimeoutMs,
        requestId,
        parentSignal: clientAbortController.signal,
        abortMessage: timeoutMessage
      },
      async () => {
        const incomingGptId = routeGptId;
        const requestLogger = (req as any).logger;
        const priorityQueueConfigured = priorityGpt && isPriorityQueueEnabled();
        const normalizedBody = normalizeGptRequestBody(req.body);
        const bodyGptId = resolveBodyGptId(req.body);
        const effectiveRequestedAction = queryAndWaitRequested ? 'query' : requestedAction;
        const backstageMutationOperation =
          await resolveBackstageMutationHttpOperation(req);
        const normalizedEffectiveBody =
          hydrateDirectQueryBody(
            normalizeQueryAndWaitBody(normalizedBody, requestedAction) ?? normalizedBody,
            promptText,
            bypassIntentRouting
          ) ?? req.body;
        let effectiveBody = backstageMutationOperation
          ? {
              ...(normalizedEffectiveBody as Record<string, unknown>),
              action: backstageMutationOperation.action,
            }
          : normalizedEffectiveBody;
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
          action: requestedAction,
          priorityGpt,
          priorityQueueConfigured
        });

        if (bodyGptId && bodyGptId !== incomingGptId) {
          requestLogger?.warn?.('gpt.request.invalid_body_gpt_id', {
            endpoint: req.originalUrl,
            pathGptId: incomingGptId,
            bodyGptId,
            traceId
          });
          const errorPayload = buildGptDispatcherErrorPayload({
            requestId,
            traceId,
            gptId: incomingGptId,
            action: requestedAction ?? GPT_QUERY_ACTION,
            code: 'BODY_GPT_ID_FORBIDDEN',
            message: 'body gptId must match the /gpt/{gptId} path parameter.',
            route: 'body_gpt_id_guard'
          });
          logGptDispatcherOutcome({
            req,
            traceId,
            gptId: incomingGptId,
            action: requestedAction ?? GPT_QUERY_ACTION,
            status: 400,
            error: {
              name: 'BODY_GPT_ID_FORBIDDEN',
              message: errorPayload.error.message
            }
          });
          return sendGuardedGptJsonResponse(
            req,
            res,
            errorPayload,
            'gpt.response.body_gpt_id_forbidden',
            400
          );
        }

        if (researchGptPreflight?.validationError) {
          const error = researchGptPreflight.validationError;
          requestLogger?.warn?.('gpt.request.research_validation_failed', {
            endpoint: req.originalUrl,
            gptId: incomingGptId,
            requestId,
            action: RESEARCH_ACTION_NAME,
            errorCode: error.code,
          });
          const errorPayload = buildGptDispatcherErrorPayload({
            requestId,
            traceId,
            gptId: incomingGptId,
            action: RESEARCH_ACTION_NAME,
            code: error.code,
            message: error.message,
            route: 'research_request_validation',
          });
          logGptDispatcherOutcome({
            req,
            traceId,
            gptId: incomingGptId,
            action: RESEARCH_ACTION_NAME,
            status: 400,
            error: {
              name: error.code,
              message: error.message,
            },
          });
          return sendGuardedGptJsonResponse(
            req,
            res,
            errorPayload,
            'gpt.response.research_validation',
            400,
          );
        }

        if (bodyGptId) {
          requestLogger?.info?.('gpt.request.body_gpt_id_accepted', {
            endpoint: req.originalUrl,
            pathGptId: incomingGptId,
            bodyGptId,
            traceId
          });
        }

        const publicGamingQueryAndWaitOperational = isDirectModuleQueryGpt(incomingGptId)
          && queryAndWaitRequested
          && normalizedBody !== null
          && promptText !== null
          && isClearlyOperationalGamingPrompt(promptText);
        if (publicGamingQueryAndWaitOperational) {
          logPublicGamingDispatch({
            req,
            requestId: requestId ?? traceId,
            traceId,
            action: GPT_QUERY_AND_WAIT_ACTION,
            intent: 'integration_status',
            route: 'operational_rejected',
            mode: null
          });
          const errorPayload = buildGptDispatcherErrorPayload({
            requestId,
            traceId,
            gptId: incomingGptId,
            action: GPT_QUERY_AND_WAIT_ACTION,
            code: OPERATIONAL_REQUEST_NOT_GAMEPLAY_CODE,
            message: OPERATIONAL_REQUEST_NOT_GAMEPLAY_MESSAGE,
            route: 'gaming_operational_guard'
          });
          logGptDispatcherOutcome({
            req,
            traceId,
            gptId: incomingGptId,
            action: GPT_QUERY_AND_WAIT_ACTION,
            status: 400,
            error: {
              name: OPERATIONAL_REQUEST_NOT_GAMEPLAY_CODE,
              message: OPERATIONAL_REQUEST_NOT_GAMEPLAY_MESSAGE
            }
          });
          return sendGuardedGptJsonResponse(
            req,
            res,
            errorPayload,
            'gpt.response.gaming_operational_guard',
            400
          );
        }

        const publicGamingDecision = isDirectModuleQueryGpt(incomingGptId)
          && !queryAndWaitRequested
          && !isGptDagAction(requestedAction)
          ? dispatchPublicGamingRequest(req.body, 'query')
          : null;

        if (publicGamingDecision) {
          logPublicGamingDispatch({
            req,
            requestId: requestId ?? traceId,
            traceId,
            action: publicGamingDecision.action,
            intent: publicGamingDecision.intent,
            route: publicGamingDecision.ok
              ? 'gaming'
              : publicGamingDecision.intent === 'integration_status'
                ? 'operational_rejected'
                : 'unsupported',
            mode: publicGamingDecision.mode
          });
        }

        if (publicGamingDecision && !publicGamingDecision.ok) {
          const action = publicGamingDecision.action;
          const errorPayload = buildGptDispatcherErrorPayload({
            requestId,
            traceId,
            gptId: incomingGptId,
            action,
            code: publicGamingDecision.error.code,
            message: publicGamingDecision.error.message,
            route: publicGamingDecision.intent === 'integration_status'
              ? 'gaming_operational_guard'
              : 'gaming_validation'
          });
          logGptDispatcherOutcome({
            req,
            traceId,
            gptId: incomingGptId,
            action,
            status: 400,
            error: {
              name: publicGamingDecision.error.code,
              message: publicGamingDecision.error.message
            }
          });
          return sendGuardedGptJsonResponse(
            req,
            res,
            errorPayload,
            'gpt.response.gaming_validation',
            400
          );
        }

        requestLogger?.info?.("gpt.request.auth_state", {
          endpoint: req.originalUrl,
          gptId: incomingGptId,
          ...buildGptRequestAuthState(req),
        });

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

        // DAG bridge actions classify as control-plane, but this route owns their bridge-specific responses.
        if (planeClassification.plane === 'reject' && !isGptDagAction(requestedAction)) {
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

          const errorPayload = {
            ...buildGptDispatcherErrorPayload({
              requestId,
              traceId,
              gptId: incomingGptId,
              action: planeClassification.action,
              code: planeClassification.errorCode,
              message: planeClassification.message,
              route:
                planeClassification.kind === 'job_lookup'
                  ? 'job_lookup_guard'
                  : 'control_guard'
            }),
            canonical: planeClassification.canonical
          };
          logGptDispatcherOutcome({
            req,
            traceId,
            gptId: incomingGptId,
            action: planeClassification.action,
            status: 400,
            error: {
              name: planeClassification.errorCode,
              message: planeClassification.message
            }
          });
          return sendGuardedGptJsonResponse(
            req,
            res,
            errorPayload,
            'gpt.response.control_rejected',
            400
          );
        }

        const routingValidation = await resolveGptRouting(incomingGptId, requestId);
        if (!routingValidation.ok) {
          const statusCode = routingValidation.error.code === 'UNKNOWN_GPT' ? 404 : 400;
          const errorPayload = buildGptDispatcherErrorPayload({
            requestId,
            traceId,
            gptId: incomingGptId,
            action: requestedAction ?? GPT_QUERY_ACTION,
            code: routingValidation.error.code,
            message: routingValidation.error.message,
            route: 'routing_validation'
          });
          requestLogger?.warn?.('gpt.request.route_result', {
            endpoint: req.originalUrl,
            gptId: incomingGptId,
            statusCode,
            ok: false,
            errorCode: routingValidation.error.code,
            queueBypassed: true
          });
          if (routingValidation.error.code === 'UNKNOWN_GPT') {
            logGptConnectionFailed(incomingGptId);
            recordUnknownGpt({
              gptId: incomingGptId,
              outcome: 'not_registered'
            });
          }
          return sendGuardedGptJsonResponse(
            req,
            res,
            errorPayload,
            'gpt.response.route_error',
            statusCode
          );
        }

        const registeredGptMetricIdentity = {
          kind: 'registered' as const,
          id: routingValidation.plan.matchedId,
        };

        const effectiveBodyRecord = effectiveBody
          && typeof effectiveBody === 'object'
          && !Array.isArray(effectiveBody)
          ? effectiveBody as Record<string, unknown>
          : null;
        const rawResearchAction = effectiveBodyRecord
          ? Object.getOwnPropertyDescriptor(effectiveBodyRecord, 'action')?.value
          : undefined;
        const requestedResearchAction = typeof rawResearchAction === 'string'
          ? resolveGptModuleRequestedActionAlias(
              rawResearchAction,
              routingValidation.plan.availableActions,
            )
          : undefined;
        const requestedModuleAction = effectiveRequestedAction
          ? resolveGptModuleRequestedActionAlias(
              effectiveRequestedAction,
              routingValidation.plan.availableActions,
            )
          : undefined;
        const researchAction = requestedResearchAction ?? routingValidation.plan.action;
        const resolvedModuleAction = requestedModuleAction ?? researchAction;
        if (
          effectiveBodyRecord
          && resolvedModuleAction
          && !queryAndWaitRequested
          && (
            requestedModuleAction
            || routingValidation.plan.module === BACKSTAGE_MODULE_NAME
          )
        ) {
          // Bind the action selected from every supported transport alias into
          // the canonical body consumed by both inline dispatch and workers.
          // This prevents an array, payload, query, or header alias from being
          // reinterpreted as the module default after crossing the queue.
          effectiveBody = {
            ...effectiveBodyRecord,
            action: resolvedModuleAction,
          };
        }
        const canonicalEffectiveBodyRecord = effectiveBody
          && typeof effectiveBody === 'object'
          && !Array.isArray(effectiveBody)
          ? effectiveBody as Record<string, unknown>
          : null;
        const resolvedBackstageAction = resolvedModuleAction;
        const protectedBackstageGenerationAction =
          routingValidation.plan.module === BACKSTAGE_MODULE_NAME
          && (
            resolvedBackstageAction === 'generateBooking'
            || resolvedBackstageAction === 'generateBookingWithHRC'
          )
            ? resolvedBackstageAction
            : null;
        const managedProtectedBackstageGenerationAction =
          isBackstageBookerAccessAuthenticated(req)
            ? protectedBackstageGenerationAction
            : null;
        protectedBackstageRequestAction = managedProtectedBackstageGenerationAction;
        const backstageContinuityQuerySyncOnly =
          routingValidation.plan.module === BACKSTAGE_MODULE_NAME
          && resolvedBackstageAction === 'queryContinuity';
        const requestedExecutionMode = resolveRequestedExecutionMode(req, effectiveBody);
        const modulePromptText = protectedBackstageGenerationAction
          ? extractBackstageBookerCanonicalGenerationPrompt(
              protectedBackstageGenerationAction,
              buildGptDispatchPayload(
                effectiveBody,
                undefined,
                BACKSTAGE_PAYLOAD_PROVENANCE_ADAPTER
              )
            )
          : routingValidation.plan.module === BACKSTAGE_MODULE_NAME
            ? extractGptDispatchPromptText(effectiveBody)
            : promptText;
        const automaticBackstageGenerationWouldCrossQueueBoundary =
          routingValidation.plan.module === 'ARCANOS:CORE'
          && bypassIntentRouting !== true
          && resolvedModuleAction === GPT_QUERY_ACTION
          && detectBackstageBookerIntent(modulePromptText) !== null;
        const backstageWorkloadDecision = classifyBackstageRouteWorkload({
          body: effectiveBody,
          moduleName: routingValidation.plan.module,
          action: requestedModuleAction ?? researchAction,
          promptText: modulePromptText,
          requestedExecutionMode,
        });
        const researchDiagnosticRequest = isDiagnosticRequest(
          canonicalEffectiveBodyRecord ?? undefined,
          promptText,
        );
        if (
          routingValidation.plan.module === RESEARCH_MODULE_NAME
          && researchAction === RESEARCH_ACTION_NAME
          && !researchDiagnosticRequest
          && !(queryAndWaitRequested && !normalizedBody)
        ) {
          try {
            validateResearchGptRequestBody(effectiveBody);
          } catch (error: unknown) {
            if (!isResearchRequestValidationError(error)) {
              throw error;
            }

            requestLogger?.warn?.('gpt.request.research_validation_failed', {
              endpoint: req.originalUrl,
              gptId: incomingGptId,
              requestId,
              action: RESEARCH_ACTION_NAME,
              errorCode: error.code,
            });
            const errorPayload = buildGptDispatcherErrorPayload({
              requestId,
              traceId,
              gptId: incomingGptId,
              action: RESEARCH_ACTION_NAME,
              code: error.code,
              message: error.message,
              route: 'research_request_validation',
            });
            logGptDispatcherOutcome({
              req,
              traceId,
              gptId: incomingGptId,
              action: RESEARCH_ACTION_NAME,
              status: 400,
              error: {
                name: error.code,
                message: error.message,
              },
            });
            return sendGuardedGptJsonResponse(
              req,
              res,
              errorPayload,
              'gpt.response.research_validation',
              400,
            );
          }
        }

        if (
          backstageMutationOperation?.action === 'updateRoster'
          && routingValidation.plan.module === BACKSTAGE_MODULE_NAME
        ) {
          try {
            effectiveBody = normalizeBackstageRosterMutationBody(effectiveBody);
          } catch (error: unknown) {
            const isContractError = error instanceof BackstageBookerContractError
              && error.action === 'updateRoster';
            if (!isBackstageRosterValidationError(error) && !isContractError) {
              throw error;
            }
            const errorCode = isBackstageRosterValidationError(error)
              ? error.code
              : BACKSTAGE_ROSTER_VALIDATION_ERROR_CODE;
            const errorMessage = error instanceof Error
              ? error.message
              : 'Invalid Backstage Booker updateRoster payload.';

            requestLogger?.warn?.('gpt.request.backstage_roster_validation_failed', {
              endpoint: req.originalUrl,
              gptId: incomingGptId,
              requestId,
              action: backstageMutationOperation.action,
              errorCode
            });
            const errorPayload = buildGptDispatcherErrorPayload({
              requestId,
              traceId,
              gptId: incomingGptId,
              action: backstageMutationOperation.action,
              code: errorCode,
              message: errorMessage,
              route: 'backstage_roster_validation'
            });
            logGptDispatcherOutcome({
              req,
              traceId,
              gptId: incomingGptId,
              action: backstageMutationOperation.action,
              status: 400,
              error: {
                name: errorCode,
                message: errorMessage
              }
            });
            return sendGuardedGptJsonResponse(
              req,
              res,
              errorPayload,
              'gpt.response.backstage_roster_validation',
              400
            );
          }
        }

        if (
          backstageMutationOperation?.action === 'trackStoryline'
          && routingValidation.plan.module === BACKSTAGE_MODULE_NAME
        ) {
          try {
            effectiveBody = normalizeBackstageStorylineMutationBody(effectiveBody);
          } catch (error: unknown) {
            const isContractError = error instanceof BackstageBookerContractError
              && error.action === 'trackStoryline';
            if (!isBackstageStorylineValidationError(error) && !isContractError) {
              throw error;
            }
            const errorCode = isBackstageStorylineValidationError(error)
              ? error.code
              : BACKSTAGE_STORYLINE_VALIDATION_ERROR_CODE;
            const errorMessage = error instanceof Error
              ? error.message
              : 'Invalid Backstage Booker trackStoryline payload.';

            requestLogger?.warn?.('gpt.request.backstage_storyline_validation_failed', {
              endpoint: req.originalUrl,
              gptId: incomingGptId,
              requestId,
              action: backstageMutationOperation.action,
              errorCode
            });
            const errorPayload = buildGptDispatcherErrorPayload({
              requestId,
              traceId,
              gptId: incomingGptId,
              action: backstageMutationOperation.action,
              code: errorCode,
              message: errorMessage,
              route: 'backstage_storyline_validation'
            });
            logGptDispatcherOutcome({
              req,
              traceId,
              gptId: incomingGptId,
              action: backstageMutationOperation.action,
              status: 400,
              error: {
                name: errorCode,
                message: errorMessage
              }
            });
            return sendGuardedGptJsonResponse(
              req,
              res,
              errorPayload,
              'gpt.response.backstage_storyline_validation',
              400
            );
          }
        }

        if (
          (
            backstageMutationOperation?.action === 'upsertStoryline'
            || backstageMutationOperation?.action === 'appendCanonBeat'
          )
          && routingValidation.plan.module === BACKSTAGE_MODULE_NAME
        ) {
          const canonAction = backstageMutationOperation.action;
          try {
            effectiveBody = normalizeBackstageCanonMutationBody(effectiveBody, canonAction);
          } catch (error: unknown) {
            if (
              !(error instanceof BackstageBookerContractError)
              || error.action !== canonAction
            ) {
              throw error;
            }

            const errorCode = 'BACKSTAGE_BOOKER_INVALID';
            requestLogger?.warn?.('gpt.request.backstage_canon_validation_failed', {
              endpoint: req.originalUrl,
              gptId: incomingGptId,
              requestId,
              action: canonAction,
              errorCode,
            });
            const errorPayload = buildGptDispatcherErrorPayload({
              requestId,
              traceId,
              gptId: incomingGptId,
              action: canonAction,
              code: errorCode,
              message: error.message,
              route: 'backstage_canon_validation',
              details: {
                action: canonAction,
                issues: error.issues.slice(0, 16),
              },
            });
            logGptDispatcherOutcome({
              req,
              traceId,
              gptId: incomingGptId,
              action: canonAction,
              status: 400,
              error: {
                name: errorCode,
                message: error.message,
              },
            });
            return sendGuardedGptJsonResponse(
              req,
              res,
              errorPayload,
              'gpt.response.backstage_canon_validation',
              400
            );
          }
        }

        const memoryClassificationBody = routingValidation.plan.module === RESEARCH_MODULE_NAME
          ? {
              action: rawResearchAction,
              prompt: promptText,
            }
          : effectiveBody;
        const memoryInterception = classifyGptMemoryInterception({
          body: memoryClassificationBody,
          availableActions: routingValidation.plan.availableActions,
          fallbackActionCandidate: routingValidation.plan.action,
          forceDirectModuleRouting: directGamingRoute || bypassIntentRouting,
        });
        let memoryPlaneAuthorized: true | undefined;
        if (memoryInterception.intercept) {
          const memoryAuthentication = authenticateMemoryPlaneRequest(req);
          if (!memoryAuthentication.ok) {
            sendMemoryPlaneAuthError(req, res, memoryAuthentication);
            return;
          }
          setMemoryPlaneNoStorePolicy(res);
          memoryPlaneAuthorized = true;
        }

        if (queryAndWaitRequested && !normalizedBody) {
          requestLogger?.warn?.('integration.job.query_and_wait_invalid_body', {
            endpoint: req.originalUrl,
            gptId: incomingGptId,
            requestId,
            bodyType: typeof req.body,
            traceId
          });
          const errorPayload = buildGptDispatcherErrorPayload({
            requestId,
            traceId,
            gptId: incomingGptId,
            action: GPT_QUERY_AND_WAIT_ACTION,
            code: 'BAD_REQUEST',
            message: 'query_and_wait requires a JSON object request body.',
            route: 'validation'
          });
          logGptDispatcherOutcome({
            req,
            traceId,
            gptId: incomingGptId,
            action: GPT_QUERY_AND_WAIT_ACTION,
            status: 400,
            error: {
              name: 'BAD_REQUEST',
              message: errorPayload.error.message
            }
          });
          return sendGuardedGptJsonResponse(
            req,
            res,
            errorPayload,
            'gpt.response.query_and_wait_invalid_body',
            400
          );
        }

        if (isGptDagAction(requestedAction)) {
          const dagBridgeResponse = await handleGptDagBridge({
            req,
            requestId,
            traceId,
            gptId: incomingGptId,
            action: requestedAction!,
            normalizedBody,
            promptText,
            logger: requestLogger,
          });

          logGptDispatcherOutcome({
            req,
            traceId,
            gptId: incomingGptId,
            action: requestedAction!,
            status: dagBridgeResponse.statusCode,
            ...(dagBridgeResponse.statusCode >= 400
              ? {
                  error: {
                    name: String(dagBridgeResponse.payload.code ?? 'GPT_DAG_BRIDGE_ERROR'),
                    message:
                      typeof dagBridgeResponse.payload.error === 'object' &&
                      dagBridgeResponse.payload.error !== null &&
                      typeof (dagBridgeResponse.payload.error as Record<string, unknown>).message === 'string'
                        ? String((dagBridgeResponse.payload.error as Record<string, unknown>).message)
                        : 'DAG bridge action failed.'
                  }
                }
              : {})
          });

          return sendGuardedGptJsonResponse(
            req,
            res,
            dagBridgeResponse.payload,
            dagBridgeResponse.logEvent,
            dagBridgeResponse.statusCode
          );
        }

        if (queryRequested && !promptText) {
          requestLogger?.warn?.('integration.job.query_missing_prompt', {
            endpoint: req.originalUrl,
            gptId: incomingGptId,
            requestId,
            traceId
          });
          const errorPayload = buildGptDispatcherErrorPayload({
            requestId,
            traceId,
            gptId: incomingGptId,
            action: GPT_QUERY_ACTION,
            code: 'PROMPT_REQUIRED',
            message: 'query requires a non-empty prompt.',
            route: 'validation'
          });
          logGptDispatcherOutcome({
            req,
            traceId,
            gptId: incomingGptId,
            action: GPT_QUERY_ACTION,
            status: 400,
            error: {
              name: 'PROMPT_REQUIRED',
              message: errorPayload.error.message
            }
          });
          return sendGuardedGptJsonResponse(
            req,
            res,
            errorPayload,
            'gpt.response.query_prompt_required',
            400
          );
        }

        if (queryAndWaitRequested && !promptText) {
          requestLogger?.warn?.('integration.job.query_and_wait_missing_prompt', {
            endpoint: req.originalUrl,
            gptId: incomingGptId,
            requestId,
            traceId
          });
          const errorPayload = buildGptDispatcherErrorPayload({
            requestId,
            traceId,
            gptId: incomingGptId,
            action: GPT_QUERY_AND_WAIT_ACTION,
            code: 'PROMPT_REQUIRED',
            message: 'query_and_wait requires a non-empty prompt.',
            route: 'validation'
          });
          logGptDispatcherOutcome({
            req,
            traceId,
            gptId: incomingGptId,
            action: GPT_QUERY_AND_WAIT_ACTION,
            status: 400,
            error: {
              name: 'PROMPT_REQUIRED',
              message: errorPayload.error.message
            }
          });
          return sendGuardedGptJsonResponse(
            req,
            res,
            errorPayload,
            'gpt.response.query_and_wait_prompt_required',
            400
          );
        }

        if (
          (queryRequested || queryAndWaitRequested) &&
          !isDirectModuleQueryGpt(incomingGptId) &&
          process.env.NODE_ENV !== 'test' &&
          !hasConfiguredOpenAIKey()
        ) {
          const action = queryAndWaitRequested ? GPT_QUERY_AND_WAIT_ACTION : GPT_QUERY_ACTION;
          const errorPayload = buildGptDispatcherErrorPayload({
            requestId,
            traceId,
            gptId: incomingGptId,
            action,
            code: 'OPENAI_API_KEY_MISSING',
            message: 'OPENAI_API_KEY is required for GPT query actions.',
            route: 'configuration'
          });
          logGptDispatcherOutcome({
            req,
            traceId,
            gptId: incomingGptId,
            action,
            status: 503,
            error: {
              name: 'OPENAI_API_KEY_MISSING',
              message: errorPayload.error.message
            }
          });
          return sendGuardedGptJsonResponse(
            req,
            res,
            errorPayload,
            'gpt.response.openai_api_key_missing',
            503
          );
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
          return sendGuardedGptJsonResponse(req, res, {
            ok: false,
            error: {
              code: 'CONTROL_PLANE_ROUTING_BREACH',
              message: 'Control-plane requests must exit before async GPT job planning.'
            },
            _route: {
              requestId,
              traceId,
              gptId: incomingGptId,
              route: 'control_guard',
              action: planeClassification.action,
              timestamp: new Date().toISOString()
            }
          }, 'gpt.response.control_plane_routing_breach', 500);
        }

        const explicitIdempotencyKey = normalizeExplicitIdempotencyKey(
          req.header('Idempotency-Key') ?? req.header('idempotency-key')
        );
        const establishedPublicGptActorKey = getRequestEstablishedActorKey(req);
        const publicGptIdempotencyActorKey =
          establishedPublicGptActorKey
          ?? `anonymous-request:${crypto.randomUUID()}`;
        const idempotencyGptId = protectedBackstageGenerationAction
          ? BACKSTAGE_MODULE_ROUTE
          : incomingGptId;
        if (explicitIdempotencyKey) {
          requestLogger?.info?.('gpt.request.idempotency_key_present', {
            endpoint: req.originalUrl,
            gptId: incomingGptId,
            requestId,
            idempotencyKeyHash: summarizeFingerprintHash(
              buildGptIdempotencyDescriptor({
                gptId: idempotencyGptId,
                action: resolvedModuleAction,
                body: effectiveBody,
                fingerprintDomain: protectedBackstageGenerationAction
                  ? PROTECTED_BACKSTAGE_JOB_FINGERPRINT_DOMAIN
                  : undefined,
                surface: 'public-gpt',
                actorKey: publicGptIdempotencyActorKey,
                explicitIdempotencyKey
              }).idempotencyKeyHash
            )
          });
          recordGptRequestEvent({
            event: 'idempotency_key_present',
            source: 'explicit'
          });
        }

        if (
          shouldUseQueryAndWaitDirectActionLane({
            queryAndWaitRequested,
            gptId: incomingGptId,
            promptText
          })
        ) {
          const directActionTimeoutMs = resolveQueryAndWaitDirectActionTimeoutMs({
            requestedWaitForResultMs: explicitAsyncWaitForResultMs,
            routeTimeoutMs
          });
          const directActionRouteDecision = buildQueryAndWaitDirectRouteDecision({
            body: effectiveBody,
            promptText: promptText!,
            timeoutMs: directActionTimeoutMs,
            explicitMode: resolveRequestedFastPathMode(req, effectiveBody)
          });
          applyGptRouteDecisionHeaders(res, directActionRouteDecision);
          applyGptQueueBypassedHeader(res, true);
          recordGptRouteDecision({
            path: directActionRouteDecision.path,
            reason: directActionRouteDecision.reason,
            queueBypassed: true
          });
          requestLogger?.info?.('gpt.request.route_decision', {
            endpoint: req.originalUrl,
            gptId: incomingGptId,
            action: GPT_QUERY_AND_WAIT_ACTION,
            path: directActionRouteDecision.path,
            reason: directActionRouteDecision.reason,
            queueBypassed: true,
            promptLength: directActionRouteDecision.promptLength,
            messageCount: directActionRouteDecision.messageCount,
            maxWords: directActionRouteDecision.maxWords,
            timeoutMs: directActionRouteDecision.timeoutMs,
            promptGenerationIntent: directActionRouteDecision.promptGenerationIntent,
            explicitMode: directActionRouteDecision.explicitMode
          });

          const directActionStartedAt = Date.now();
          try {
            const directEnvelope = await executeDirectGptAction({
              gptId: incomingGptId,
              gptMetricIdentity: registeredGptMetricIdentity,
              prompt: promptText!,
              requestId,
              action: GPT_QUERY_AND_WAIT_ACTION,
              timeoutMs: directActionTimeoutMs,
              parentSignal: clientAbortController.signal,
              logger: requestLogger
            });
            const totalLatencyMs = Date.now() - directActionStartedAt;
            recordGptFastPathLatency({
              gpt: registeredGptMetricIdentity,
              outcome: 'completed',
              durationMs: totalLatencyMs
            });
            const routingInfo: GptRoutingInfo = {
              gptId: directEnvelope._route.gptId,
              moduleName: directEnvelope._route.module,
              route: directEnvelope._route.route,
              matchMethod: 'exact'
            };
            logGptConnection(routingInfo);
            logGptAckSent(routingInfo, 1);
            requestLogger?.info?.('integration.job.query_and_wait_completed', {
              endpoint: req.originalUrl,
              gptId: incomingGptId,
              requestId,
              waitForResultMs: directActionTimeoutMs,
              directExecution: true,
              latencyMs: totalLatencyMs
            });
            logGptDispatcherOutcome({
              req,
              traceId,
              gptId: incomingGptId,
              action: GPT_QUERY_AND_WAIT_ACTION,
              status: 200
            });
            const shapedDirectResult = shapeClientRouteResult(directEnvelope.result) as Record<string, unknown>;
            return sendGuardedGptJsonResponse(
              req,
              res,
              {
                ok: true,
                gptId: incomingGptId,
                action: GPT_QUERY_AND_WAIT_ACTION,
                status: 'completed',
                result: extractDispatcherResultText(directEnvelope.result),
                ...(shapedDirectResult.meta ? { meta: shapedDirectResult.meta } : {}),
                ...(shapedDirectResult.activeModel ? { activeModel: shapedDirectResult.activeModel } : {}),
                ...(typeof shapedDirectResult.fallbackFlag === 'boolean'
                  ? { fallbackFlag: shapedDirectResult.fallbackFlag }
                  : {}),
                ...(Array.isArray(shapedDirectResult.routingStages)
                  ? { routingStages: shapedDirectResult.routingStages }
                  : {}),
                routeDecision: directActionRouteDecision,
                directAction: directEnvelope.directAction,
                traceId,
                _route: {
                  ...directEnvelope._route,
                  requestId,
                  traceId
                }
              },
              'gpt.response.query_and_wait_direct_completed',
              200
            );
          } catch (error) {
            const errorMessage = resolveErrorMessage(error);
            const directActionFailureStatus = resolveDirectGptActionFailureStatus(error);
            const timedOut = directActionFailureStatus === 504;
            recordGptFastPathLatency({
              gpt: registeredGptMetricIdentity,
              outcome: 'error',
              durationMs: Date.now() - directActionStartedAt
            });
            requestLogger?.warn?.(
              timedOut
                ? 'gpt.request.query_and_wait_direct_timeout'
                : 'gpt.request.query_and_wait_direct_failed',
              {
                endpoint: req.originalUrl,
                gptId: incomingGptId,
                requestId,
                timeoutMs: directActionTimeoutMs,
                statusCode: directActionFailureStatus,
                error: errorMessage
              }
            );
            const errorPayload = buildGptDispatcherErrorPayload({
              requestId,
              traceId,
              gptId: incomingGptId,
              action: GPT_QUERY_AND_WAIT_ACTION,
              code: timedOut ? 'GPT_QUERY_AND_WAIT_TIMEOUT' : 'GPT_QUERY_AND_WAIT_FAILED',
              message: errorMessage,
              route: 'query_and_wait_direct'
            });
            logGptDispatcherOutcome({
              req,
              traceId,
              gptId: incomingGptId,
              action: GPT_QUERY_AND_WAIT_ACTION,
              status: directActionFailureStatus,
              error: {
                name: error instanceof Error ? error.name : 'Error',
                message: errorMessage
              }
            });
            return sendGuardedGptJsonResponse(
              req,
              res,
              {
                ...errorPayload,
                routeDecision: directActionRouteDecision
              },
              timedOut
                ? 'gpt.response.query_and_wait_direct_timeout'
                : 'gpt.response.query_and_wait_direct_failed',
              directActionFailureStatus
            );
          }
        }

        const protectedBackstageRequestLocalOnly = Boolean(
          protectedBackstageGenerationAction
          && backstageWorkloadDecision?.forceSynchronous
        );
        const protectedBackstageQueueRequired = Boolean(
          backstageWorkloadDecision?.queueRequired
          && readStrictBooleanEnv(BACKSTAGE_BOOKER_ASYNC_GENERATION_FLAG, false)
        );
        const classifiedFastPathDecision = classifyGptFastPathRequest({
          gptId: incomingGptId,
          body: effectiveBody,
          promptText,
          requestedAction: effectiveRequestedAction,
          routeTimeoutProfile,
          explicitMode: resolveRequestedFastPathMode(req, effectiveBody),
          hasExplicitIdempotencyKey: Boolean(explicitIdempotencyKey)
        });
        const fastPathDecision: GptFastPathDecision = memoryPlaneAuthorized === true
          ? {
              ...classifiedFastPathDecision,
              path: 'orchestrated_path',
              eligible: false,
              reason: 'memory_dispatch_intercept',
              queueBypassed: true,
            }
          : protectedBackstageRequestLocalOnly || protectedBackstageQueueRequired
          ? {
              ...classifiedFastPathDecision,
              path: 'orchestrated_path',
              eligible: false,
              reason: `backstage_${backstageWorkloadDecision!.reason}`,
              queueBypassed: protectedBackstageRequestLocalOnly,
            }
          : classifiedFastPathDecision;
        applyGptRouteDecisionHeaders(res, fastPathDecision);
        if (memoryPlaneAuthorized === true) {
          applyGptQueueBypassedHeader(res, true);
        }
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

        if (fastPathDecision.reason === 'invalid_payload_shape_requires_module_dispatch') {
          recordGptRouteDecision({
            path: fastPathDecision.path,
            reason: fastPathDecision.reason,
            queueBypassed: false
          });
          return sendGuardedGptJsonResponse(req, res, {
            ok: false,
            action: asyncBridgeAction,
            error: {
              code: 'BAD_REQUEST',
              message: 'GPT request payload must be a JSON object when provided.'
            },
            routeDecision: fastPathDecision,
            _route: {
              requestId,
              gptId: incomingGptId,
              route: 'async',
              timestamp: new Date().toISOString()
            }
          }, 'gpt.response.invalid_payload_shape', 400);
        }

        let fastPathFallbackToOrchestrated = false;
        if (fastPathDecision.path === 'fast_path' && promptText) {
          const fastPathStartedAt = Date.now();
          const fastPathTimeoutMs = fastPathDecision.timeoutMs;
          try {
            const fastPathEnvelope = await executeFastGptPrompt({
              gptId: incomingGptId,
              gptMetricIdentity: registeredGptMetricIdentity,
              prompt: promptText,
              requestId,
              timeoutMs: fastPathTimeoutMs,
              routeDecision: fastPathDecision,
              parentSignal: clientAbortController.signal,
              logger: requestLogger
            });
            const totalLatencyMs = Date.now() - fastPathStartedAt;
            recordGptFastPathLatency({
              gpt: registeredGptMetricIdentity,
              outcome: 'completed',
              durationMs: totalLatencyMs
            });
            applyGptQueueBypassedHeader(res, true);
            recordGptRouteDecision({
              path: fastPathDecision.path,
              reason: fastPathDecision.reason,
              queueBypassed: true
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
              gpt: registeredGptMetricIdentity,
              outcome: 'fallback',
              durationMs: totalLatencyMs
            });
            res.setHeader('x-gpt-route-decision', 'orchestrated_path');
            res.setHeader('x-gpt-route-decision-reason', 'fast_path_fallback');
            res.setHeader('x-gpt-fast-path-queue-bypassed', 'false');
            res.setHeader('x-gpt-queue-bypassed', 'false');
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

        const classifiedExecutionPlan = resolveGptExecutionPlan({
          req,
          gptId: incomingGptId,
          body: effectiveBody,
          promptText,
          requestedAction: effectiveRequestedAction,
          routeTimeoutProfile
        });
        const executionPlan: GptExecutionPlan = backstageContinuityQuerySyncOnly
          ? {
              ...classifiedExecutionPlan,
              mode: 'sync',
              reason: 'backstage_continuity_request_local_auth',
              heavyPrompt: false,
            }
          : memoryPlaneAuthorized === true
          ? {
              ...classifiedExecutionPlan,
              mode: 'sync',
              reason: 'memory_dispatch_intercept',
              heavyPrompt: false,
            }
          : protectedBackstageRequestLocalOnly
          ? {
              ...classifiedExecutionPlan,
              mode: 'sync',
              reason: `backstage_${backstageWorkloadDecision!.reason}`,
              heavyPrompt: false,
            }
          : protectedBackstageQueueRequired
          ? {
              ...classifiedExecutionPlan,
              mode: 'async',
              reason: `backstage_${backstageWorkloadDecision!.reason}`,
              heavyPrompt: true,
            }
          : classifiedExecutionPlan;
        const shouldUseJobBackedExecution =
          !backstageContinuityQuerySyncOnly
          && !protectedBackstageRequestLocalOnly
          && memoryPlaneAuthorized !== true
          && (
            (queryAndWaitRequested && executionPlan.mode === 'async')
            || executionPlan.mode === 'async'
            || fastPathFallbackToOrchestrated
            || Boolean(explicitIdempotencyKey)
          );
        const protectedBackstageJobExecution =
          protectedBackstageGenerationAction !== null
          && shouldUseJobBackedExecution;
        const priorityJobBackedExecutionRequested =
          !backstageContinuityQuerySyncOnly
          && memoryPlaneAuthorized !== true
          && (
            queryAndWaitRequested
            || executionPlan.mode === 'async'
            || fastPathFallbackToOrchestrated
            || Boolean(explicitIdempotencyKey)
          );
        const priorityQueueActive =
          protectedBackstageGenerationAction === null
          && priorityQueueConfigured
          && priorityJobBackedExecutionRequested;
        const priorityDirectReturnRequested = priorityQueueActive;
        const directReturnRequested =
          queryAndWaitRequested ||
          priorityDirectReturnRequested ||
          (
            !queryRequested &&
            explicitAsyncWaitForResultMs !== undefined &&
            executionPlan.mode === 'async'
          );
        let requestedAsyncWaitForResultMs = explicitAsyncWaitForResultMs;
        if (priorityDirectReturnRequested && requestedAsyncWaitForResultMs === undefined) {
          requestedAsyncWaitForResultMs = Math.min(
            resolveGptDirectExecutionThresholdMs(),
            resolveGptWaitTimeoutMs()
          );
        } else if (queryRequested) {
          requestedAsyncWaitForResultMs = 0;
        } else if (requestedAsyncWaitForResultMs === undefined) {
          if (queryAndWaitRequested) {
            requestedAsyncWaitForResultMs = resolveGptWaitTimeoutMs();
          } else if (executionPlan.heavyPrompt) {
            requestedAsyncWaitForResultMs =
              resolveGptAsyncHeavyWaitForResultMs({
                protectedBackstageQueueRequired,
                configuredGenericWaitForResultMs:
                  process.env.GPT_ASYNC_HEAVY_WAIT_FOR_RESULT_MS,
              });
          }
        }
        if (protectedBackstageJobExecution) {
          requestedAsyncWaitForResultMs = resolveBackstageInitialAcceptanceWaitMs(
            requestedAsyncWaitForResultMs
          );
        }
        const asyncWaitForResultMs = clampAsyncWaitForRouteTimeout(
          resolveAsyncGptWaitForResultMs(requestedAsyncWaitForResultMs),
          routeTimeoutMs
        );
        const asyncPollIntervalMs = resolveAsyncGptPollIntervalMs(explicitAsyncPollIntervalMs);
        queuedAsyncWaitForResultMs = asyncWaitForResultMs;
        queuedAsyncPollIntervalMs = asyncPollIntervalMs;
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
          asyncPollIntervalMs,
          priorityGpt,
          priorityQueueActive,
          ...(backstageWorkloadDecision
            ? {
                backstageWorkloadClass: backstageWorkloadDecision.workloadClass,
                backstageWorkloadReason: backstageWorkloadDecision.reason,
                backstageQueueRequired: backstageWorkloadDecision.queueRequired,
                backstageForceSynchronous: backstageWorkloadDecision.forceSynchronous,
                backstagePromptCodeUnits: backstageWorkloadDecision.promptCodeUnits,
                backstageContextCodeUnits: backstageWorkloadDecision.contextCodeUnits,
                backstageExpectedItemCount: backstageWorkloadDecision.expectedItemCount,
                backstageExpectedOutputWords: backstageWorkloadDecision.expectedOutputWords,
                backstageNotionAuthorityContext:
                  backstageWorkloadDecision.notionAuthorityContext,
                backstageCompleteBookingContainerComponentCount:
                  backstageWorkloadDecision.completeBookingContainerComponentCount,
                backstageProviderInvocationRequired:
                  backstageWorkloadDecision.providerInvocationRequired,
              }
            : {})
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
        const protectedBackstageUniverseId = protectedBackstageGenerationAction
          ? readBackstageUniverseId(effectiveBody) ?? DEFAULT_BACKSTAGE_UNIVERSE_ID
          : null;

        if (shouldUseJobBackedExecution) {
          if (protectedBackstageJobExecution) {
            backstageInitialAcceptanceStartedAtMs = Date.now();
            backstageInitialAcceptanceAction = protectedBackstageGenerationAction;
            requestLogger?.info?.('backstage.initial_acceptance.started', {
              requestId,
              traceId,
              action: protectedBackstageGenerationAction,
              acceptanceWaitMs: asyncWaitForResultMs,
            });
          }
          res.setHeader('Cache-Control', 'no-store');
          if (
            automaticBackstageGenerationWouldCrossQueueBoundary
            && !protectedBackstageJobExecution
          ) {
            requestLogger?.warn?.('gpt.request.backstage_async_canonical_route_required', {
              endpoint: req.originalUrl,
              gptId: incomingGptId,
              requestId,
            });
            return sendGuardedGptJsonResponse(req, res, {
              ok: false,
              error: {
                code: 'BACKSTAGE_ASYNC_CANONICAL_ROUTE_REQUIRED',
                message: 'Job-backed booking generation requires the canonical Backstage Booker route.',
              },
              _route: {
                requestId,
                traceId,
                gptId: idempotencyGptId,
                timestamp: new Date().toISOString(),
              },
            }, 'gpt.response.backstage_async_canonical_route_required', 400);
          }
          if (protectedBackstageJobExecution) {
            try {
              resolveBackstageJobPayloadProtectionConfig();
            } catch (error: unknown) {
              const errorCode = error instanceof BackstageJobPayloadProtectionError
                ? error.code
                : 'BACKSTAGE_JOB_PAYLOAD_CONFIG_INVALID';
              requestLogger?.error?.('gpt.request.backstage_async_protection_unavailable', {
                endpoint: req.originalUrl,
                gptId: incomingGptId,
                requestId,
                errorCode,
              });
              return sendGuardedGptJsonResponse(req, res, {
                ok: false,
                ...buildBackstageBookerProtectedFailureState({
                  code: 'BACKSTAGE_ASYNC_UNAVAILABLE',
                  message: 'Protected Backstage generation is temporarily unavailable.',
                }),
                _route: {
                  requestId,
                  traceId,
                  gptId: incomingGptId,
                  timestamp: new Date().toISOString(),
                },
              }, 'gpt.response.backstage_async_protection_unavailable', 503);
            }
          }
          if (!resolveConfiguredJobReadCapabilitySecret()) {
            return sendGuardedGptJsonResponse(req, res, {
              ok: false,
              ...(protectedBackstageJobExecution
                ? buildBackstageBookerProtectedFailureState({
                    code: JOB_READ_AUTH_UNAVAILABLE_CODE,
                    message: JOB_READ_AUTH_UNAVAILABLE_MESSAGE,
                  })
                : {
                    error: {
                      code: JOB_READ_AUTH_UNAVAILABLE_CODE,
                      message: JOB_READ_AUTH_UNAVAILABLE_MESSAGE,
                    },
                  }),
              _route: {
                requestId,
                gptId: incomingGptId,
                timestamp: new Date().toISOString(),
              },
            }, 'gpt.response.job_read_auth_unavailable', 503);
          }
          applyGptQueueBypassedHeader(res, false);
          recordGptRouteDecision({
            path: fastPathFallbackToOrchestrated ? 'orchestrated_path' : fastPathDecision.path,
            reason: fastPathFallbackToOrchestrated ? 'fast_path_fallback' : fastPathDecision.reason,
            queueBypassed: false
          });
          if (!normalizedBody) {
            if (explicitIdempotencyKey || protectedBackstageJobExecution) {
              requestLogger?.warn?.('gpt.request.idempotency_invalid_body', {
                endpoint: req.originalUrl,
                gptId: incomingGptId,
                requestId,
                bodyType: typeof req.body
              });
              const invalidBodyMessage = protectedBackstageJobExecution
                ? 'Protected Backstage generation requires a JSON object request body.'
                : 'Idempotent GPT requests require a JSON object request body.';
              return sendGuardedGptJsonResponse(req, res, {
                ok: false,
                ...(protectedBackstageJobExecution
                  ? buildBackstageBookerProtectedFailureState({
                      code: 'BAD_REQUEST',
                      message: invalidBodyMessage,
                    })
                  : {
                      error: { code: 'BAD_REQUEST', message: invalidBodyMessage },
                      idempotencyKey: explicitIdempotencyKey,
                    }),
                _route: {
                  requestId,
                  gptId: incomingGptId,
                  timestamp: new Date().toISOString()
                }
              }, 'gpt.response.idempotency_invalid_body', 400);
            }

            requestLogger?.warn?.('gpt.request.async_invalid_body_sync_fallback', {
              endpoint: req.originalUrl,
              gptId: idempotencyGptId,
              requestId,
              bodyType: typeof req.body,
              executionReason: executionPlan.reason
            });
          } else {
            const idempotencyDescriptor = buildGptIdempotencyDescriptor({
              gptId: idempotencyGptId,
              action: resolvedModuleAction,
              body: effectiveBody,
              fingerprintDomain: protectedBackstageGenerationAction
                ? PROTECTED_BACKSTAGE_JOB_FINGERPRINT_DOMAIN
                : undefined,
              surface: 'public-gpt',
              actorKey: publicGptIdempotencyActorKey,
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
            const backstageMutationPrincipalId =
              req.controlPlanePrincipal?.principalId;
            if (backstageMutationOperation && !backstageMutationPrincipalId) {
              requestLogger?.error?.('gpt.request.backstage_mutation_admission_unavailable', {
                endpoint: req.originalUrl,
                gptId: incomingGptId,
                requestId,
                action: backstageMutationOperation.action,
              });
              return sendGuardedGptJsonResponse(req, res, {
                ok: false,
                error: {
                  code: 'BACKSTAGE_MUTATION_ADMISSION_UNAVAILABLE',
                  message: 'Backstage mutation admission could not be persisted.'
                },
                _route: {
                  requestId,
                  traceId,
                  gptId: incomingGptId,
                  route: 'backstage_mutation_admission',
                  action: backstageMutationOperation.action,
                  timestamp: new Date().toISOString()
                }
              }, 'gpt.response.backstage_mutation_admission_unavailable', 500);
            }
            const backstageMutationAdmission = backstageMutationOperation
              ? buildQueuedGptBackstageMutationAdmission({
                  action: backstageMutationOperation.action,
                  principalId: backstageMutationPrincipalId!,
                })
              : undefined;
            let queuedGptJobInput:
              | ReturnType<typeof buildQueuedGptJobInput>
              | ReturnType<typeof buildProtectedBackstageQueuedGptJobInput>;
            try {
              queuedGptJobInput = protectedBackstageJobExecution
                ? buildProtectedBackstageQueuedGptJobInput({
                    body: effectiveBody as Record<string, unknown>,
                    prompt: modulePromptText,
                    action: protectedBackstageGenerationAction!,
                    universeId: protectedBackstageUniverseId!,
                    notionEnrichmentAuthorized:
                      isBackstageNotionEnrichmentAuthorized(),
                    bypassIntentRouting,
                    requestId,
                    traceId,
                    correlationId: traceId,
                    executionModeReason: executionPlan.reason,
                  })
                : buildQueuedGptJobInput({
                    gptId: incomingGptId,
                    body: effectiveBody as Record<string, unknown>,
                    prompt: promptText,
                    bypassIntentRouting,
                    requestId,
                    traceId,
                    correlationId: traceId,
                    routeHint: resolvedModuleAction ?? 'query',
                    requestPath: `/gpt/${encodeURIComponent(incomingGptId)}`,
                    executionModeReason: executionPlan.reason,
                    backstageMutationAdmission,
                  });
            } catch (error: unknown) {
              if (
                protectedBackstageJobExecution
                && error instanceof BackstageJobPayloadProtectionError
              ) {
                const publicRejection =
                  resolveBackstageBookerProtectedPayloadRejection(error.code);
                requestLogger?.warn?.('gpt.request.backstage_async_payload_rejected', {
                  endpoint: req.originalUrl,
                  gptId: incomingGptId,
                  requestId,
                  errorCode: error.code,
                });
                return sendGuardedGptJsonResponse(req, res, {
                  ok: false,
                  ...buildBackstageBookerProtectedFailureState(publicRejection),
                  _route: {
                    requestId,
                    traceId,
                    gptId: incomingGptId,
                    timestamp: new Date().toISOString(),
                  },
                }, 'gpt.response.backstage_async_payload_rejected', publicRejection.statusCode);
              }
              throw error;
            }
            const priorityDirectWorkerId = `${process.env.WORKER_ID || 'api'}:priority-gpt-direct`;
            let priorityDirectSlot: PriorityGptDirectExecutionSlot | null = priorityQueueActive
              ? tryAcquirePriorityGptDirectExecutionSlot()
              : null;
            const releasePriorityDirectSlot = (): void => {
              const reservedSlot = priorityDirectSlot;
              priorityDirectSlot = null;
              reservedSlot?.release();
            };
            let plannedJob!: Awaited<ReturnType<typeof planAutonomousWorkerJob>>;
            let createResult;
            try {
              if (protectedBackstageJobExecution) {
                getRequestAbortSignal()?.throwIfAborted();
              }
              const plannedJobBase = await planAutonomousWorkerJob('gpt', queuedGptJobInput);
              const priorityAwarePlannedJob = priorityQueueActive
                ? {
                    ...plannedJobBase,
                    status: priorityDirectSlot ? 'running' : plannedJobBase.status,
                    startedAt: priorityDirectSlot ? new Date() : plannedJobBase.startedAt,
                    lastHeartbeatAt: priorityDirectSlot ? new Date() : plannedJobBase.lastHeartbeatAt,
                    leaseExpiresAt: priorityDirectSlot
                      ? new Date(
                          Date.now() +
                          Math.max(resolveGptWaitTimeoutMs(), asyncWaitForResultMs) +
                          DIRECT_RETURN_ROUTE_TIMEOUT_HEADROOM_MS
                        )
                      : plannedJobBase.leaseExpiresAt,
                    priority: PRIORITY_GPT_JOB_PRIORITY,
                    lastWorkerId: priorityDirectSlot
                      ? priorityDirectWorkerId
                      : plannedJobBase.lastWorkerId,
                    autonomyState: {
                      ...(plannedJobBase.autonomyState ?? {}),
                      priorityQueue: {
                        enabled: true,
                        gptId: incomingGptId,
                        directExecution: priorityDirectSlot ? 'reserved' : 'queued',
                        requestedAt: new Date().toISOString()
                      }
                    }
                  }
                : plannedJobBase;
              const authenticatedClientIdentity =
                getAuthenticatedGptClientIdentity(req);
              plannedJob = authenticatedClientIdentity
                ? {
                    ...priorityAwarePlannedJob,
                    autonomyState:
                      mergeGptClientJobProvenanceIntoAutonomyState(
                        priorityAwarePlannedJob.autonomyState,
                        authenticatedClientIdentity
                      ),
                  }
                : priorityAwarePlannedJob;
              if (protectedBackstageJobExecution) {
                getRequestAbortSignal()?.throwIfAborted();
              }
              createResult = await findOrCreateGptJob({
                workerId: process.env.WORKER_ID || 'api',
                input: queuedGptJobInput,
                requestFingerprintHash: idempotencyDescriptor.fingerprintHash,
                idempotencyScopeHash: idempotencyDescriptor.scopeHash,
                idempotencyKeyHash: explicitIdempotencyKey
                  ? idempotencyDescriptor.idempotencyKeyHash
                  : null,
                idempotencyOrigin: idempotencyDescriptor.source,
                createOptions: {
                  ...plannedJob,
                  correlationId: traceId
                }
              });
            } catch (error: unknown) {
              releasePriorityDirectSlot();
              if (error instanceof IdempotencyKeyConflictError) {
                return sendGuardedGptJsonResponse(req, res, {
                  ok: false,
                  action: asyncBridgeAction,
                  ...(protectedBackstageJobExecution
                    ? buildBackstageBookerProtectedFailureState({
                        code: 'IDEMPOTENCY_KEY_CONFLICT',
                        message: 'The supplied idempotency key is already bound to a different GPT request.',
                      })
                    : {
                        error: {
                          code: 'IDEMPOTENCY_KEY_CONFLICT',
                          message: 'The supplied idempotency key is already bound to a different GPT request.'
                        },
                        idempotencyKey: idempotencyDescriptor.publicIdempotencyKey,
                      }),
                  _route: {
                    requestId,
                    gptId: incomingGptId,
                    timestamp: new Date().toISOString()
                  }
                }, 'gpt.response.idempotency_conflict', 409);
              }

              if (error instanceof JobRepositoryUnavailableError) {
                if (
                  protectedBackstageJobExecution
                  || explicitIdempotencyKey
                  || queryAndWaitRequested
                  || queryRequested
                ) {
                  requestLogger?.error?.('gpt.request.idempotency_unavailable', {
                    endpoint: req.originalUrl,
                    gptId: incomingGptId,
                    requestId,
                    error: protectedBackstageJobExecution
                      ? 'Protected Backstage job persistence is unavailable.'
                      : error.message
                  });
                  const unavailableCode = protectedBackstageJobExecution
                    ? 'BACKSTAGE_ASYNC_UNAVAILABLE'
                    : (queryAndWaitRequested || queryRequested)
                      ? 'ASYNC_GPT_JOBS_UNAVAILABLE'
                      : 'IDEMPOTENCY_UNAVAILABLE';
                  const unavailableMessage = protectedBackstageJobExecution
                    ? 'Protected Backstage generation requires durable GPT job persistence, but the jobs backend is unavailable.'
                    : queryAndWaitRequested
                    ? 'query_and_wait requires durable GPT job persistence, but the jobs backend is unavailable.'
                    : queryRequested
                    ? 'query requires durable GPT job persistence, but the jobs backend is unavailable.'
                    : 'Durable idempotency is unavailable because GPT job persistence is not configured.';
                  return sendGuardedGptJsonResponse(req, res, {
                    ok: false,
                    action: asyncBridgeAction,
                    ...(protectedBackstageJobExecution
                      ? buildBackstageBookerProtectedFailureState({
                          code: unavailableCode,
                          message: unavailableMessage,
                        })
                      : {
                          error: { code: unavailableCode, message: unavailableMessage },
                          idempotencyKey: idempotencyDescriptor.publicIdempotencyKey,
                        }),
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
              if (
                protectedBackstageJobExecution
                && !protectedBackstageQueuedGptJobMatchesIdentity(job.input, {
                  action: protectedBackstageGenerationAction!,
                  universeId: protectedBackstageUniverseId!,
                })
              ) {
                releasePriorityDirectSlot();
                requestLogger?.error?.('gpt.request.backstage_async_identity_mismatch', {
                  endpoint: req.originalUrl,
                  gptId: incomingGptId,
                  requestId,
                  jobId: job.id,
                  created: createResult.created,
                  deduped: createResult.deduped,
                  errorCode: 'BACKSTAGE_JOB_PAYLOAD_IDENTITY_INVALID',
                });
                return sendGuardedGptJsonResponse(req, res, {
                  ok: false,
                  ...buildBackstageBookerProtectedFailureState({
                    code: 'BACKSTAGE_ASYNC_UNAVAILABLE',
                    message: 'Protected Backstage generation is temporarily unavailable.',
                  }),
                  _route: {
                    requestId,
                    traceId,
                    gptId: incomingGptId,
                    timestamp: new Date().toISOString(),
                  },
                }, 'gpt.response.backstage_async_identity_mismatch', 503);
              }
              if (!isGenericJobCapabilityEligible(job)) {
                releasePriorityDirectSlot();
                requestLogger?.error?.('gpt.request.job_provenance_unavailable', {
                  endpoint: req.originalUrl,
                  gptId: incomingGptId,
                  requestId,
                  jobId: job.id,
                  jobType: job.job_type ?? null,
                });
                return sendGuardedGptJsonResponse(req, res, {
                  ok: false,
                  ...(protectedBackstageJobExecution
                    ? buildBackstageBookerProtectedFailureState({
                        code: JOB_READ_PROVENANCE_UNAVAILABLE_CODE,
                        message: JOB_READ_PROVENANCE_UNAVAILABLE_MESSAGE,
                      })
                    : {
                        error: {
                          code: JOB_READ_PROVENANCE_UNAVAILABLE_CODE,
                          message: JOB_READ_PROVENANCE_UNAVAILABLE_MESSAGE,
                        },
                      }),
                  _route: {
                    requestId,
                    gptId: incomingGptId,
                    timestamp: new Date().toISOString(),
                  },
                }, 'gpt.response.job_provenance_unavailable', 503);
              }
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
              if (protectedBackstageJobExecution) {
                const postLatencyMs = Math.max(
                  0,
                  Date.now() - backstageInitialAcceptanceStartedAtMs!
                );
                requestLogger?.info?.('backstage.initial_acceptance.accepted', {
                  requestId,
                  traceId,
                  jobId: job.id,
                  action: protectedBackstageGenerationAction,
                  deduped: createResult.deduped,
                  acceptanceWaitMs: asyncWaitForResultMs,
                  postLatencyMs,
                  jobStatus: job.status,
                });
                if (createResult.deduped) {
                  requestLogger?.info?.('backstage.initial_acceptance.replay_deduped', {
                    requestId,
                    traceId,
                    jobId: job.id,
                    action: protectedBackstageGenerationAction,
                    deduped: true,
                    acceptanceWaitMs: asyncWaitForResultMs,
                    postLatencyMs,
                    jobStatus: job.status,
                  });
                }
              }
              if (priorityDirectSlot) {
                if (createResult.created) {
                  const reservedSlot = priorityDirectSlot;
                  priorityDirectSlot = null;
                  try {
                    startReservedPriorityGptDirectExecution({
                      jobId: job.id,
                      claimGeneration: job.claim_generation,
                      rawInput: queuedGptJobInput,
                      workerId: priorityDirectWorkerId,
                      slot: reservedSlot,
                      requestLogger
                    });
                  } catch (error) {
                    reservedSlot.release();
                    throw error;
                  }
                  requestLogger?.info?.('gpt.priority_direct.reserved', {
                    endpoint: req.originalUrl,
                    gptId: incomingGptId,
                    requestId,
                    jobId: job.id,
                    waitForResultMs: asyncWaitForResultMs
                  });
                } else {
                  releasePriorityDirectSlot();
                }
              }
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
                  projectAsyncJobResponseForRequest(req, queuedPendingResponse),
                  'gpt.response.async_pending',
                  202
                );
              }

              const requestAbortSignal = getRequestAbortSignal();
              let waitedJob: Awaited<ReturnType<typeof waitForQueuedGptJobCompletion>>;
              try {
                waitedJob = await waitForQueuedGptJobCompletion(
                  job.id,
                  {
                    waitForResultMs: asyncWaitForResultMs,
                    pollIntervalMs: asyncPollIntervalMs,
                    signal: requestAbortSignal
                  }
                );
              } catch (error) {
                requestAbortSignal?.throwIfAborted();
                if (!(error instanceof JobRepositoryUnavailableError)) {
                  throw error;
                }

                requestLogger?.error?.('gpt.request.async_jobs_unavailable', {
                  endpoint: req.originalUrl,
                  gptId: incomingGptId,
                  requestId,
                  jobId: job.id
                });
                if (protectedBackstageJobExecution) {
                  return sendGuardedGptJsonResponse(
                    req,
                    res,
                    projectAsyncJobResponseForRequest(req, queuedPendingResponse),
                    'gpt.response.backstage_initial_acceptance_continuation_unavailable',
                    202
                  );
                }
                return sendGuardedGptJsonResponse(req, res, {
                  ok: false,
                  error: {
                    code: 'ASYNC_GPT_JOBS_UNAVAILABLE',
                    message: ASYNC_GPT_JOBS_UNAVAILABLE_MESSAGE
                  },
                  ...buildAsyncJobResponseMetadata({
                    action: asyncBridgeAction,
                    jobId: job.id,
                    jobStatus: job.status,
                    deduped: createResult.deduped,
                    idempotencyKey: idempotencyDescriptor.publicIdempotencyKey,
                    idempotencySource: idempotencyDescriptor.source
                  }),
                  _route: {
                    requestId,
                    gptId: incomingGptId,
                    timestamp: new Date().toISOString()
                  }
                }, 'gpt.response.async_jobs_unavailable', 503);
              }

              if (waitedJob.state === 'completed') {
                let completedJobOutput: unknown;
                try {
                  completedJobOutput = unprotectBackstageQueuedGptJobOutput({
                    jobId: waitedJob.job.id,
                    rawInput: waitedJob.job.input,
                    output: waitedJob.job.output,
                  });
                } catch {
                  requestLogger?.error?.('gpt.request.backstage_async_result_unavailable', {
                    endpoint: req.originalUrl,
                    gptId: incomingGptId,
                    jobId: job.id,
                  });
                  if (protectedBackstageJobExecution) {
                    return sendGuardedGptJsonResponse(
                      req,
                      res,
                      projectAsyncJobResponseForRequest(req, queuedPendingResponse),
                      'gpt.response.backstage_initial_acceptance_result_unavailable',
                      202
                    );
                  }
                  return sendGuardedGptJsonResponse(req, res, {
                    ok: false,
                    error: {
                      code: 'BACKSTAGE_ASYNC_RESULT_UNAVAILABLE',
                      message: 'Protected Backstage generation result is unavailable.',
                    },
                    jobId: job.id,
                    poll: `/jobs/${job.id}/result`,
                    ...buildJobReadCapabilityResponseFields(job.id),
                  }, 'gpt.response.backstage_async_result_unavailable', 503);
                }
                const completedEnvelope = normalizeCompletedAsyncGptResponse(completedJobOutput);
                if (
                  !completedEnvelope
                  || (
                    protectedBackstageJobExecution
                    && (
                      !protectedBackstageGenerationAction
                      || !readProtectedBackstageCompletionProvenance(
                        completedJobOutput,
                        {
                          gptId: 'backstage-booker',
                          action: protectedBackstageGenerationAction,
                        }
                      )
                    )
                  )
                ) {
                  requestLogger?.error?.('gpt.request.async_completed_invalid', {
                    endpoint: req.originalUrl,
                    gptId: incomingGptId,
                    jobId: job.id
                  });
                  if (protectedBackstageJobExecution) {
                    return sendGuardedGptJsonResponse(
                      req,
                      res,
                      projectAsyncJobResponseForRequest(req, queuedPendingResponse),
                      'gpt.response.backstage_initial_acceptance_result_unavailable',
                      202
                    );
                  }
                  return sendGuardedGptJsonResponse(req, res, {
                    ok: false,
                    action: asyncBridgeAction,
                    error: {
                      code: 'ASYNC_GPT_JOB_OUTPUT_INVALID',
                      message: 'Async GPT job completed without a valid envelope.'
                    },
                    jobId: job.id,
                    poll: `/jobs/${job.id}/result`,
                    stream: `/jobs/${job.id}/stream`,
                    ...buildJobReadCapabilityResponseFields(job.id),
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
                if (protectedBackstageJobExecution) {
                  requestLogger?.info?.('backstage.initial_acceptance.completed_inline', {
                    requestId,
                    traceId,
                    jobId: job.id,
                    action: protectedBackstageGenerationAction,
                    deduped: createResult.deduped,
                    acceptanceWaitMs: asyncWaitForResultMs,
                    postLatencyMs: Math.max(
                      0,
                      Date.now() - backstageInitialAcceptanceStartedAtMs!
                    ),
                    jobStatus: waitedJob.job.status,
                  });
                }
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

                const isBackstageStorylineResponse =
                  completedEnvelope._route.module === BACKSTAGE_MODULE_NAME
                  && completedEnvelope._route.action === 'trackStoryline'
                  && Array.isArray(completedEnvelope.result);
                return sendGuardedGptJsonResponse(
                  req,
                  res,
                  {
                    ...completedEnvelope,
                    ...buildAsyncJobResponseMetadata({
                      action: asyncBridgeAction,
                      jobId: job.id,
                      jobStatus: waitedJob.job.status,
                      deduped: createResult.deduped,
                      idempotencyKey: idempotencyDescriptor.publicIdempotencyKey,
                      idempotencySource: idempotencyDescriptor.source
                    }),
                    result: protectedBackstageJobExecution
                      ? completedEnvelope.result
                      : isBackstageStorylineResponse
                      ? completedEnvelope.result
                      : shapeClientRouteResult(completedEnvelope.result),
                  },
                  'gpt.response.async_completed',
                  200,
                  isBackstageStorylineResponse
                    ? {
                        maxBytes: BACKSTAGE_STORYLINE_PUBLIC_RESPONSE_MAX_BYTES,
                        maxBytesCeiling: BACKSTAGE_STORYLINE_PUBLIC_RESPONSE_MAX_BYTES
                      }
                    : {}
                );
              }

              if (protectedBackstageJobExecution) {
                requestLogger?.info?.('gpt.request.async_pending', {
                  endpoint: req.originalUrl,
                  gptId: incomingGptId,
                  jobId: job.id,
                  waitForResultMs: asyncWaitForResultMs,
                  pollIntervalMs: asyncPollIntervalMs,
                  deduped: createResult.deduped,
                  dedupeReason: createResult.dedupeReason,
                  observedState: waitedJob.state,
                });
                return sendGuardedGptJsonResponse(
                  req,
                  res,
                  projectAsyncJobResponseForRequest(req, queuedPendingResponse),
                  'gpt.response.backstage_initial_acceptance_pending',
                  202
                );
              }

              if (waitedJob.state === 'failed') {
                const rosterPersistenceFailure =
                  normalizeFailedBackstageRosterPersistenceOutput(waitedJob.job.output);
                requestLogger?.warn?.('gpt.request.async_failed', {
                  endpoint: req.originalUrl,
                  gptId: incomingGptId,
                  jobId: job.id,
                  error: rosterPersistenceFailure?.code
                    ?? waitedJob.job.error_message
                    ?? 'Async GPT job failed.',
                  deduped: createResult.deduped,
                  ...summarizeGptJobTimings(waitedJob.job)
                });
                return sendGuardedGptJsonResponse(req, res, {
                  ok: false,
                  error: rosterPersistenceFailure ?? {
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
                }, 'gpt.response.async_failed', rosterPersistenceFailure ? 503 : 500);
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
                  poll: `/jobs/${job.id}/result`,
                  stream: `/jobs/${job.id}/stream`,
                  ...buildJobReadCapabilityResponseFields(job.id),
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
                  projectAsyncJobResponseForRequest(
                    req,
                    buildDirectReturnTimeoutResponse({
                      pendingResponse: queuedPendingResponse,
                      jobId: job.id,
                      waitForResultMs: asyncWaitForResultMs,
                      pollIntervalMs: asyncPollIntervalMs
                    })
                  ),
                  'gpt.response.async_direct_return_timeout',
                  202
                );
              }
              return sendGuardedGptJsonResponse(
                req,
                res,
                projectAsyncJobResponseForRequest(req, queuedPendingResponse),
                'gpt.response.async_pending',
                202
              );
            }
          }
        }

        applyGptQueueBypassedHeader(res, true);
        recordGptRouteDecision({
          path: fastPathDecision.path,
          reason: fastPathDecision.reason,
          queueBypassed: true
        });
        const envelope = await routeGptRequest({
          gptId: incomingGptId,
          body: effectiveBody,
          requestId,
          logger: requestLogger,
          request: req,
          bypassIntentRouting,
          memoryPlaneAuthorized,
        });
        const routeAbortSignal = getRequestAbortSignal();
        if (routeAbortSignal?.aborted) {
          throw routeAbortSignal.reason instanceof Error
            ? routeAbortSignal.reason
            : createAbortError(timeoutMessage);
        }

        if (!envelope.ok) {
          if (
            isDirectModuleQueryGpt(incomingGptId) &&
            isControlledGamingDispatcherError(envelope.error.code)
          ) {
            const controlledGamingResponse = buildControlledGamingErrorResponse({
              body: effectiveBody,
              requestId,
              traceId,
              gptId: incomingGptId,
              dispatcherCode: envelope.error.code,
              ...(envelope.error.code === 'MODULE_TIMEOUT'
                ? { timeoutMs: routeTimeoutMs, timeoutPhase: 'module-dispatch' }
                : {}),
              routeMeta: envelope._route as Record<string, unknown>
            });
            if (envelope.error.code === 'MODULE_TIMEOUT') {
              applyAIDegradedResponseHeaders(res, {
                timeoutKind: 'pipeline_timeout',
                degradedModeReason: 'gaming_module_timeout',
                bypassedSubsystems: ['gaming_generation']
              });
            }
            requestLogger?.warn?.('gpt.request.route_result', {
              endpoint: req.originalUrl,
              gptId: incomingGptId,
              statusCode: 200,
              ok: false,
              errorCode: envelope.error.code,
              controlledGamingFailure: true
            });
            logGptDispatcherOutcome({
              req,
              traceId,
              gptId: incomingGptId,
              action: requestedAction ?? GPT_QUERY_ACTION,
              status: 200
            });
            return sendGuardedGptJsonResponse(
              req,
              res,
              controlledGamingResponse,
              'gpt.response.gaming_controlled_failure',
              200
            );
          }

          applyAIDegradedResponseHeaders(res, extractAIDegradedResponseMetadata(envelope.error.details));
          const unexpectedGamingRouteFailure =
            isDirectModuleQueryGpt(incomingGptId) && envelope.error.code === 'MODULE_ERROR';
          const publicErrorEnvelope = managedProtectedBackstageGenerationAction
            ? {
                ok: false as const,
                ...buildBackstageBookerProtectedFailureState({
                  code: resolveBackstageProtectedFailureCode(envelope.error.code),
                  message: 'Protected Backstage generation did not complete.',
                }),
                requestId: requestId ?? traceId,
                gptId: incomingGptId,
                action: managedProtectedBackstageGenerationAction,
                route: GPT_DISPATCHER_ROUTE,
                traceId,
                _route: {
                  requestId: requestId ?? traceId,
                  traceId,
                  gptId: incomingGptId,
                  action: managedProtectedBackstageGenerationAction,
                  timestamp: new Date().toISOString(),
                },
              }
            : {
                ...envelope,
                ...(unexpectedGamingRouteFailure
                  ? {
                      error: {
                        code: 'GAMING_ROUTE_ERROR',
                        message: 'ARCANOS Gaming encountered an unexpected route error.'
                      }
                    }
                  : {}),
                requestId: requestId ?? traceId,
                gptId: incomingGptId,
                action: requestedAction ?? GPT_QUERY_ACTION,
                route: GPT_DISPATCHER_ROUTE,
                traceId,
                _route: {
                  ...envelope._route,
                  requestId: requestId ?? traceId,
                  traceId
                }
              };
          const canonDomainStatus = resolveBackstageCanonDomainErrorHttpStatus(
            envelope.error.code
          );
          const statusCode = canonDomainStatus ?? (
            envelope.error.code === "UNKNOWN_GPT"
              ? 404
              : envelope.error.code === 'MEMORY_AUTH_REQUIRED'
              ? 401
              : envelope.error.code === 'MEMORY_AUTH_UNAVAILABLE'
              ? 503
              : envelope.error.code === BACKSTAGE_ROSTER_PERSISTENCE_ERROR_CODE
              ? 503
              : envelope.error.code === BACKSTAGE_STORYLINE_PERSISTENCE_ERROR_CODE
              ? 500
              : envelope.error.code === BACKSTAGE_CANON_UNAVAILABLE_ERROR_CODE
              ? 503
              : envelope.error.code === BACKSTAGE_NOTION_INDEX_UNAVAILABLE_ERROR_CODE
              ? 503
               : envelope.error.code === BACKSTAGE_NOTION_SCOPE_RESOLUTION_ERROR_CODE
               ? (envelope.error.details as { reason?: unknown } | undefined)?.reason === 'not_found'
                 ? 404
                 : 409
               : envelope.error.code === BACKSTAGE_NOTION_CURSOR_INVALID_ERROR_CODE
               ? 409
              : envelope.error.code === BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE_ERROR_CODE
                || envelope.error.code === BACKSTAGE_BOOKER_INTEGRITY_FAILED_ERROR_CODE
              ? 500
              : envelope.error.code === BACKSTAGE_CONTINUITY_QUERY_FAILED_ERROR_CODE
              ? 500
              : envelope.error.code === BACKSTAGE_NOTION_AUTHORITY_UNAVAILABLE_ERROR_CODE
              ? 503
              : envelope.error.code === BACKSTAGE_NOTION_AUTHORITY_READ_ONLY_ERROR_CODE
              ? 409
              : envelope.error.code === "SYSTEM_STATE_CONFLICT"
              ? 409
              : unexpectedGamingRouteFailure
              ? 500
              : envelope.error.code === "MODULE_TIMEOUT"
              ? 504
              : 400
          );
          requestLogger?.warn?.("gpt.request.route_result", {
            endpoint: req.originalUrl,
            gptId: incomingGptId,
            statusCode,
            ok: false,
            errorCode: envelope.error.code,
          });
          if (envelope.error.code === "UNKNOWN_GPT") {
            logGptConnectionFailed(incomingGptId);
            logGptDispatcherOutcome({
              req,
              traceId,
              gptId: incomingGptId,
              action: requestedAction ?? GPT_QUERY_ACTION,
              status: 404,
              error: {
                name: envelope.error.code,
                message: envelope.error.message
              }
            });
            return sendGuardedGptJsonResponse(req, res, publicErrorEnvelope, 'gpt.response.route_error', 404);
          }
          if (envelope.error.code === "SYSTEM_STATE_CONFLICT") {
            return sendGuardedGptJsonResponse(req, res, publicErrorEnvelope, 'gpt.response.route_error', 409);
          }
          if (unexpectedGamingRouteFailure) {
            logGptDispatcherOutcome({
              req,
              traceId,
              gptId: incomingGptId,
              action: requestedAction ?? GPT_QUERY_ACTION,
              status: 500,
              error: {
                name: 'GAMING_ROUTE_ERROR',
                message: 'ARCANOS Gaming encountered an unexpected route error.'
              }
            });
            return sendGuardedGptJsonResponse(
              req,
              res,
              publicErrorEnvelope,
              'gpt.response.gaming_unexpected_failure',
              500
            );
          }
          if (envelope.error.code === "MODULE_TIMEOUT") {
            return sendGuardedGptJsonResponse(req, res, publicErrorEnvelope, 'gpt.response.route_error', 504);
          }
          return sendGuardedGptJsonResponse(
            req,
            res,
            publicErrorEnvelope,
            'gpt.response.route_error',
            statusCode
          );
        }

        if (managedProtectedBackstageGenerationAction) {
          const protectedProvenance = readProtectedBackstageCompletionProvenance(
            envelope,
            {
              gptId: 'backstage-booker',
              action: managedProtectedBackstageGenerationAction,
            }
          );
          if (!protectedProvenance) {
            requestLogger?.error?.('backstage.protected_result.failed', {
              requestId,
              traceId,
              action: managedProtectedBackstageGenerationAction,
              code: 'BACKSTAGE_ASYNC_RESULT_UNAVAILABLE',
              reason: 'missing_or_invalid_inline_provenance',
            });
            return sendGuardedGptJsonResponse(req, res, {
              ok: false,
              ...buildBackstageBookerProtectedFailureState({
                code: 'BACKSTAGE_ASYNC_RESULT_UNAVAILABLE',
                message: 'Protected Backstage generation result is unavailable.',
              }),
              requestId: requestId ?? traceId,
              traceId,
              _route: {
                requestId: requestId ?? traceId,
                traceId,
                gptId: incomingGptId,
                action: managedProtectedBackstageGenerationAction,
                timestamp: new Date().toISOString(),
              },
            }, 'gpt.response.backstage_inline_result_unavailable', 503);
          }
          requestLogger?.info?.('backstage.protected_result.completed', {
            requestId,
            traceId,
            action: managedProtectedBackstageGenerationAction,
          });
          requestLogger?.info?.('backstage.protected_result.authority_status', {
            requestId,
            traceId,
            action: managedProtectedBackstageGenerationAction,
            authority: protectedProvenance.authority,
            snapshotStatus: protectedProvenance.snapshotStatus,
            official: protectedProvenance.official,
            continuityVerified: protectedProvenance.continuityVerified,
            fallbackUsed: protectedProvenance.fallbackUsed,
          });
        }

        if ((queryRequested || queryAndWaitRequested) && ARCANOS_CORE_GPT_IDS.has(incomingGptId)) {
          const routingInfo: GptRoutingInfo = {
            gptId: envelope._route.gptId,
            moduleName: envelope._route.module ?? "unknown",
            route: envelope._route.route ?? "unknown",
            matchMethod: (envelope._route.matchMethod as any) ?? "none",
          };
          logGptConnection(routingInfo);
          logGptAckSent(routingInfo, (envelope._route.availableActions ?? []).length);
          applyAIDegradedResponseHeaders(res, extractAIDegradedResponseMetadata(envelope.result));
          const resultText = extractDispatcherResultText(envelope.result);
          const shapedCoreResult =
            typeof envelope.result === 'object' && envelope.result !== null
              ? (shapeClientRouteResult(envelope.result) as Record<string, unknown>)
              : {};
          requestLogger?.info?.("gpt.request.route_result", {
            endpoint: req.originalUrl,
            gptId: incomingGptId,
            statusCode: 200,
            ok: true,
            module: envelope._route.module ?? "unknown",
            route: envelope._route.route ?? "unknown",
            traceId,
            dispatcherAction: queryAndWaitRequested ? GPT_QUERY_AND_WAIT_ACTION : GPT_QUERY_ACTION
          });
          logGptDispatcherOutcome({
            req,
            traceId,
            gptId: incomingGptId,
            action: queryAndWaitRequested ? GPT_QUERY_AND_WAIT_ACTION : GPT_QUERY_ACTION,
            status: 200
          });
          return sendGuardedGptJsonResponse(
            req,
            res,
            {
              ok: true,
              gptId: incomingGptId,
              action: GPT_QUERY_ACTION,
              result: resultText,
              ...(shapedCoreResult.meta ? { meta: shapedCoreResult.meta } : {}),
              ...(shapedCoreResult.activeModel ? { activeModel: shapedCoreResult.activeModel } : {}),
              ...(typeof shapedCoreResult.fallbackFlag === 'boolean'
                ? { fallbackFlag: shapedCoreResult.fallbackFlag }
                : {}),
              ...(Array.isArray(shapedCoreResult.routingStages)
                ? { routingStages: shapedCoreResult.routingStages }
                : {}),
              traceId,
              _route: {
                ...envelope._route,
                requestId,
                traceId
              }
            },
            'gpt.response.dispatcher_query',
            200
          );
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
          const diagnosticResult = shapeClientRouteResult(envelope.result) as Record<string, unknown>;
          const diagnosticPayload = prepareBoundedClientJsonPayload(
            {
              ...diagnosticResult,
              requestId: requestId ?? traceId,
              traceId
            },
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
        const isBackstageStorylineResponse =
          envelope._route.module === BACKSTAGE_MODULE_NAME
          && envelope._route.action === 'trackStoryline'
          && Array.isArray(envelope.result);
        const publicPayload = {
          ...envelope,
          ...(isDirectModuleQueryGpt(incomingGptId)
            ? {
                requestId: requestId ?? traceId,
                traceId,
                _route: {
                  ...envelope._route,
                  requestId: requestId ?? traceId,
                  traceId
                }
              }
            : {}),
          result: managedProtectedBackstageGenerationAction
            ? envelope.result
            : isBackstageStorylineResponse
            ? envelope.result
            : shapeClientRouteResult(envelope.result),
        };
        const protectedOverflowPayload =
          buildBackstageBookerProtectedOverflowFailure(publicPayload);
        const publicEnvelope = prepareBoundedClientJsonPayload(publicPayload, {
          logger: req.logger,
          logEvent: 'gpt.response',
          ...(protectedOverflowPayload
            ? { overflowPayload: protectedOverflowPayload }
            : {}),
          ...(isBackstageStorylineResponse
            ? {
                maxBytes: BACKSTAGE_STORYLINE_PUBLIC_RESPONSE_MAX_BYTES,
                maxBytesCeiling: BACKSTAGE_STORYLINE_PUBLIC_RESPONSE_MAX_BYTES
              }
            : {}),
        });
        requestLogger?.info?.('gpt.response.serialization', {
          endpoint: req.originalUrl,
          gptId: incomingGptId,
          action: envelope._route.action ?? 'query',
          serializationMs: Date.now() - responseSerializationStartedAt,
          responseBytes: publicEnvelope.responseBytes,
          truncated: publicEnvelope.truncated,
        });

        const targetResponse = publicEnvelope.truncated && protectedOverflowPayload
          ? res.status(503)
          : res;
        return sendPreparedJsonResponse(targetResponse, publicEnvelope);
      }
    );
  } catch (err) {
    if (isAbortError(err)) {
      const promptText = extractGptPromptText(req.body);
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
      if (clientDisconnected && backstageInitialAcceptanceStartedAtMs !== null) {
        req.logger?.warn?.('backstage.initial_acceptance.client_disconnected', {
          requestId,
          traceId,
          jobId: queuedJobId,
          action: backstageInitialAcceptanceAction,
          acceptanceWaitMs: queuedAsyncWaitForResultMs,
          postLatencyMs: Math.max(
            0,
            Date.now() - backstageInitialAcceptanceStartedAtMs
          ),
          jobStatus: queuedJobId === null ? 'not_accepted' : 'accepted',
        });
      }
      const responseOpen = !res.headersSent && !res.writableEnded && !res.destroyed;
      if (routeTimedOut && responseOpen && queuedPendingResponse) {
        const pendingResponse = queuedPendingResponse as ReturnType<typeof buildQueuedGptPendingResponse>;
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
          buildDirectReturnTimeoutResponse({
            pendingResponse,
            jobId: queuedJobId ?? pendingResponse.jobId,
            waitForResultMs: queuedAsyncWaitForResultMs ?? routeTimeoutMs,
            pollIntervalMs: queuedAsyncPollIntervalMs ?? resolveAsyncGptPollIntervalMs(explicitAsyncPollIntervalMs)
          }),
          'gpt.response.timeout_pending',
          202
        );
      }
      if (
        routeTimedOut
        && responseOpen
        && protectedBackstageRequestAction !== null
      ) {
        return sendGuardedGptJsonResponse(req, res, {
          ok: false,
          ...buildBackstageBookerProtectedFailureState({
            code: 'BACKSTAGE_ASYNC_TIMEOUT',
            message: 'Protected Backstage generation did not complete before the request deadline.',
          }),
          requestId: requestId ?? traceId,
          traceId,
          _route: {
            requestId: requestId ?? traceId,
            traceId,
            gptId: req.params.gptId,
            action: protectedBackstageRequestAction,
            timestamp: new Date().toISOString(),
          },
        }, 'gpt.response.backstage_initial_acceptance_timeout', 504);
      }
      if (routeTimedOut && responseOpen && isDirectModuleQueryGpt(gptId)) {
        const controlledGamingResponse = buildControlledGamingErrorResponse({
          body: req.body,
          requestId,
          traceId,
          gptId,
          dispatcherCode: 'MODULE_TIMEOUT',
          timeoutMs: routeTimeoutMs,
          timeoutPhase: 'gpt-route'
        });
        applyAIDegradedResponseHeaders(res, {
          timeoutKind: 'pipeline_timeout',
          degradedModeReason: 'gaming_route_timeout',
          bypassedSubsystems: ['gaming_generation']
        });
        logGptDispatcherOutcome({
          req,
          traceId,
          gptId,
          action: requestedAction ?? GPT_QUERY_ACTION,
          status: 200
        });
        return sendGuardedGptJsonResponse(
          req,
          res,
          controlledGamingResponse,
          'gpt.response.gaming_route_timeout',
          200
        );
      }
      if (
        routeTimedOut &&
        responseOpen &&
        promptText &&
        ARCANOS_CORE_GPT_IDS.has(gptId) &&
        requestedAction !== GPT_QUERY_AND_WAIT_ACTION
      ) {
        const timeoutPhase = resolveArcanosCoreTimeoutPhase(err) ?? 'gpt-route';
        const timeoutFallback = buildArcanosCoreTimeoutFallbackEnvelope({
          prompt: promptText,
          gptId,
          requestId,
          route: 'core',
          timeoutPhase
        });
        applyAIDegradedResponseHeaders(res, extractAIDegradedResponseMetadata(timeoutFallback.result));
        req.logger?.warn?.('gpt.request.timeout_fallback', {
          endpoint: req.originalUrl,
          gptId,
          errorType: 'route_timeout_static_fallback',
          timeoutPhase,
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
          requestId: requestId ?? traceId,
          traceId,
          error: {
            code: 'MODULE_TIMEOUT',
            message: timeoutMessage
          },
          _route: {
            requestId: requestId ?? traceId,
            traceId,
            gptId: req.params.gptId,
            timestamp: new Date().toISOString()
          }
        }, 'gpt.response.timeout', 504);
      }
      if (clientDisconnected && responseOpen) {
        res.destroy(err instanceof Error ? err : undefined);
        return;
      }
      if (responseOpen && protectedBackstageRequestAction !== null) {
        return sendGuardedGptJsonResponse(req, res, {
          ok: false,
          ...buildBackstageBookerProtectedFailureState({
            code: 'BACKSTAGE_ASYNC_EXECUTION_FAILED',
            message: 'Protected Backstage generation did not complete.',
          }),
          requestId: requestId ?? traceId,
          traceId,
          _route: {
            requestId: requestId ?? traceId,
            traceId,
            gptId: req.params.gptId,
            action: protectedBackstageRequestAction,
            timestamp: new Date().toISOString(),
          },
        }, 'gpt.response.backstage_initial_acceptance_aborted', 503);
      }
      if (responseOpen) {
        return sendGuardedGptJsonResponse(req, res, {
          ok: false,
          requestId: requestId ?? traceId,
          traceId,
          error: {
            code: 'REQUEST_ABORTED',
            message: 'Request was aborted before completion.'
          },
          _route: {
            requestId: requestId ?? traceId,
            traceId,
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
      action: requestedAction ?? GPT_QUERY_ACTION,
      traceId,
      error: resolveErrorMessage(err)
    });
    const responseOpen = !res.headersSent && !res.writableEnded && !res.destroyed;
    const recoveryPendingResponse = queuedPendingResponse as
      | ReturnType<typeof buildQueuedGptPendingResponse>
      | null;
    if (responseOpen && recoveryPendingResponse) {
      req.logger?.warn?.('gpt.request.async_recovery_pending', {
        endpoint: req.originalUrl,
        gptId: req.params.gptId,
        traceId,
        jobId: queuedJobId ?? recoveryPendingResponse.jobId,
        error: resolveErrorMessage(err),
      });
      return sendGuardedGptJsonResponse(
        req,
        res,
        projectAsyncJobResponseForRequest(req, recoveryPendingResponse),
        'gpt.response.async_recovery_pending',
        202
      );
    }
    if (responseOpen && protectedBackstageRequestAction !== null) {
      return sendGuardedGptJsonResponse(req, res, {
        ok: false,
        ...buildBackstageBookerProtectedFailureState({
          code: 'BACKSTAGE_ASYNC_EXECUTION_FAILED',
          message: 'Protected Backstage generation did not complete.',
        }),
        requestId: requestId ?? traceId,
        traceId,
        _route: {
          requestId: requestId ?? traceId,
          traceId,
          gptId: req.params.gptId,
          action: protectedBackstageRequestAction,
          timestamp: new Date().toISOString(),
        },
      }, 'gpt.response.backstage_initial_acceptance_unexpected_failure', 500);
    }
    if (responseOpen) {
      const internalMessage = resolveErrorMessage(err);
      const errorPayload = buildGptDispatcherErrorPayload({
        requestId,
        traceId,
        gptId: req.params.gptId,
        action: requestedAction ?? GPT_QUERY_ACTION,
        code: 'GPT_DISPATCHER_UNEXPECTED_ERROR',
        message: 'An unexpected GPT route error occurred.',
        route: 'unexpected_failure'
      });
      logGptDispatcherOutcome({
        req,
        traceId,
        gptId: req.params.gptId,
        action: requestedAction ?? GPT_QUERY_ACTION,
        status: 500,
        error: {
          name: err instanceof Error ? err.name : 'Error',
          message: internalMessage
        }
      });
      return sendGuardedGptJsonResponse(
        req,
        res,
        errorPayload,
        'gpt.response.unexpected_failure',
        500
      );
    }
    return next(err);
  } finally {
    res.off('close', abortForClosedClient);
  }
});

export default router;
