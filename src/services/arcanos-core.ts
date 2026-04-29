import OpenAI from 'openai';
import type { TrinityAnswerMode, TrinityResult, TrinityRunOptions } from '@core/logic/trinity.js';
import {
  applyTrinityGenerationInvariant,
  runTrinityWritingPipeline
} from '@core/logic/trinityWritingPipeline.js';
import type { TrinityGenerationMessage } from '@core/logic/trinityGenerationFacade.js';
import {
  createRuntimeBudgetWithLimit,
  getSafeRemainingMs,
  type RuntimeBudget
} from '@platform/resilience/runtimeBudget.js';
import { logger } from '@platform/logging/structuredLogging.js';
import { recordTraceEvent } from '@platform/logging/telemetry.js';
import { generateMockResponse } from '@services/openai.js';
import { getOpenAIClientOrAdapter } from '@services/openai/clientBridge.js';
import { getAiExecutionContext } from '@services/openai/aiExecutionContext.js';
import { APPLICATION_CONSTANTS } from '@shared/constants.js';
import {
  ARCANOS_SUPPRESS_TIMEOUT_FALLBACK_FLAG,
  normalizeBooleanFlagValue
} from '@shared/gpt/gptDirectAction.js';
import type { ModuleDef } from './moduleLoader.js';
import { executeSystemStateRequest } from './systemState.js';
import {
  getRequestAbortContext,
  getRequestAbortSignal,
  getRequestRemainingMs,
  isAbortError,
  runWithRequestAbortTimeout
} from '@arcanos/runtime';
import { resolveErrorMessage } from '@core/lib/errors/index.js';

type ArcanosCoreQueryPayload = {
  action?: string;
  operation?: string;
  prompt?: string;
  message?: string;
  query?: string;
  text?: string;
  content?: string;
  messages?: TrinityGenerationMessage[];
  sessionId?: string;
  overrideAuditSafe?: string;
  answerMode?: string;
  max_words?: number;
  maxWords?: number;
  maxOutputTokens?: number;
  __arcanosGptId?: string;
  __arcanosSourceEndpoint?: string;
  __arcanosRequestedAction?: string;
  __arcanosExecutionMode?: string;
  __arcanosExecutionReason?: string;
  [ARCANOS_SUPPRESS_TIMEOUT_FALLBACK_FLAG]?: boolean | string | number;
};

type ArcanosCoreExecutionMode = 'request' | 'background';

const DEFAULT_ARCANOS_CORE_ROUTE_TIMEOUT_MS = 60_000;
const DEFAULT_ARCANOS_CORE_HANDLER_HEADROOM_MS = 5_000;
const DEFAULT_ARCANOS_CORE_HANDLER_TIMEOUT_MS =
  DEFAULT_ARCANOS_CORE_ROUTE_TIMEOUT_MS - DEFAULT_ARCANOS_CORE_HANDLER_HEADROOM_MS;
const DEFAULT_ARCANOS_CORE_PIPELINE_TIMEOUT_MS = 45_000;
const MIN_ARCANOS_CORE_PIPELINE_TIMEOUT_MS = 2_500;
const MAX_ARCANOS_CORE_PIPELINE_TIMEOUT_MS = 60_000;
const DEFAULT_ARCANOS_CORE_DEGRADED_HEADROOM_MS = 8_000;
const DEFAULT_ARCANOS_CORE_BACKGROUND_HANDLER_TIMEOUT_MS = 180_000;
const DEFAULT_ARCANOS_CORE_BACKGROUND_PIPELINE_TIMEOUT_MS = 120_000;
const MIN_ARCANOS_CORE_BACKGROUND_PIPELINE_TIMEOUT_MS = 15_000;
const MAX_ARCANOS_CORE_BACKGROUND_PIPELINE_TIMEOUT_MS = 180_000;
const DEFAULT_ARCANOS_CORE_BACKGROUND_DEGRADED_HEADROOM_MS = 10_000;
const DEFAULT_ARCANOS_CORE_DEGRADED_MAX_WORDS = 60;
const DEFAULT_ARCANOS_CORE_RUNTIME_BUDGET_SAFETY_BUFFER_MS = 250;
const ARCANOS_CORE_PIPELINE_TIMEOUT_REASON = 'arcanos_core_pipeline_timeout_direct_answer';
const ARCANOS_CORE_STATIC_FALLBACK_REASON = 'arcanos_core_pipeline_timeout_static_fallback';
const ARCANOS_CORE_RUNTIME_TRACE_EVENT = 'core.runtime.trace';
const ARCANOS_CORE_PIPELINE_BYPASSED_SUBSYSTEMS = [
  'trinity_intake',
  'trinity_reasoning',
  'trinity_clear_audit',
  'trinity_reflection',
  'trinity_final'
] as const;

export interface RunArcanosCoreQueryParams {
  client: OpenAI;
  prompt: string;
  sourceEndpoint: string;
  requestId?: string;
  gptId?: string;
  moduleId?: string;
  requestedAction?: string | null;
  body?: unknown;
  sessionId?: string;
  overrideAuditSafe?: string;
  maxOutputTokens?: number;
  messages?: TrinityGenerationMessage[];
  runOptions?: Omit<TrinityRunOptions, 'sourceEndpoint'>;
  executionModeOverride?: ArcanosCoreExecutionMode;
  executionModeReason?: string;
  allowTimeoutFallback?: boolean;
}

export interface BuildArcanosCoreTimeoutFallbackParams {
  prompt: string;
  requestId?: string | null;
  sourceEndpoint?: string | null;
  gptId?: string | null;
  moduleId?: string | null;
  requestedAction?: string | null;
  executionMode?: string | null;
  createdAtMs?: number;
  timeoutPhase?: string | null;
}

export interface ArcanosCoreTimeoutFallbackEnvelope {
  ok: true;
  result: TrinityResult;
  _route: {
    gptId: string;
    module: 'ARCANOS:CORE';
    action: 'query';
    route: string;
    timestamp: string;
    requestId?: string;
  };
}

function normalizeTraceString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveCoreTraceContext(explicitRequestId?: string | null): {
  requestId: string | undefined;
  traceId: string | null;
} {
  const aiExecutionContext = getAiExecutionContext();
  const abortContext = getRequestAbortContext();
  const requestId =
    normalizeTraceString(explicitRequestId) ??
    normalizeTraceString(abortContext?.requestId) ??
    normalizeTraceString(aiExecutionContext?.requestId);

  return {
    requestId,
    traceId: normalizeTraceString(aiExecutionContext?.traceId) ?? null
  };
}

function resolveTraceRemainingBudgetMs(runtimeBudget?: RuntimeBudget | null): number | null {
  if (runtimeBudget) {
    return getSafeRemainingMs(runtimeBudget);
  }

  const remainingRequestMs = getRequestRemainingMs();
  return typeof remainingRequestMs === 'number' ? remainingRequestMs : null;
}

function emitCoreRuntimeTrace(params: {
  phase: string;
  startedAt: number;
  requestId?: string | null;
  sourceEndpoint?: string;
  executionMode?: ArcanosCoreExecutionMode;
  route?: string;
  runtimeBudget?: RuntimeBudget | null;
  remainingBudgetMs?: number | null;
  timeoutMs?: number | null;
  totalTimeoutMs?: number | null;
  degradedReason?: string | null;
  timeoutPhase?: string | null;
  level?: 'info' | 'warn' | 'error';
  extra?: Record<string, unknown>;
}): void {
  const traceContext = resolveCoreTraceContext(params.requestId);
  const remainingBudgetMs =
    typeof params.remainingBudgetMs === 'number'
      ? Math.max(0, Math.trunc(params.remainingBudgetMs))
      : resolveTraceRemainingBudgetMs(params.runtimeBudget);
  const payload = {
    module: 'ARCANOS:CORE',
    traceId: traceContext.traceId,
    requestId: traceContext.requestId,
    gptId: 'arcanos-core',
    action: 'query',
    route: params.route ?? 'core',
    sourceEndpoint: params.sourceEndpoint,
    executionMode: params.executionMode,
    phase: params.phase,
    elapsedMs: Math.max(0, Date.now() - params.startedAt),
    remainingBudgetMs,
    timeoutMs: typeof params.timeoutMs === 'number' ? Math.trunc(params.timeoutMs) : null,
    totalTimeoutMs: typeof params.totalTimeoutMs === 'number' ? Math.trunc(params.totalTimeoutMs) : null,
    degradedReason: params.degradedReason ?? null,
    timeoutPhase: params.timeoutPhase ?? null,
    ...(params.extra ?? {})
  };
  const logLevel = params.level ?? 'info';
  logger[logLevel](ARCANOS_CORE_RUNTIME_TRACE_EVENT, payload);
}

export function resolveArcanosCoreTimeoutPhase(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const candidate = error as Record<string, unknown>;
  return (
    normalizeTraceString(candidate.timeoutPhase) ??
    normalizeTraceString(candidate.trinityStage) ??
    normalizeTraceString(candidate.stage)
  );
}

function resolveCoreFallbackTimeoutPhase(
  primaryError: unknown,
  degradedError?: unknown
): string {
  const primaryPhase = resolveArcanosCoreTimeoutPhase(primaryError);
  const degradedPhase = resolveArcanosCoreTimeoutPhase(degradedError);

  if (primaryPhase && degradedPhase && primaryPhase !== degradedPhase) {
    return `${primaryPhase}.${degradedPhase}`;
  }

  return degradedPhase ?? primaryPhase ?? 'pipeline';
}

function extractDirectPrompt(payload: ArcanosCoreQueryPayload): string | null {
  for (const candidate of [
    payload.prompt,
    payload.message,
    payload.query,
    payload.text,
    payload.content
  ]) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
}

function extractTextFromMessageContent(content: unknown): string | null {
  if (typeof content === 'string' && content.trim().length > 0) {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const parts = content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }

      if (part && typeof part === 'object' && !Array.isArray(part)) {
        const record = part as Record<string, unknown>;
        return typeof record.text === 'string' ? record.text : '';
      }

      return '';
    })
    .map((part) => part.trim())
    .filter(Boolean);

  return parts.length > 0 ? parts.join('\n') : null;
}

function extractPromptFromMessages(messages: unknown): string | null {
  if (!Array.isArray(messages)) {
    return null;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      continue;
    }

    const record = message as Record<string, unknown>;
    if (record.role !== 'user') {
      continue;
    }

    const text = extractTextFromMessageContent(record.content);
    if (text) {
      return text;
    }
  }

  return null;
}

function readTrinityMessages(messages: unknown): TrinityGenerationMessage[] | undefined {
  return Array.isArray(messages) && extractPromptFromMessages(messages)
    ? (messages as TrinityGenerationMessage[])
    : undefined;
}

function extractPrompt(payload: ArcanosCoreQueryPayload): string {
  const directPrompt = extractDirectPrompt(payload);
  if (directPrompt) {
    return directPrompt;
  }

  const messagePrompt = extractPromptFromMessages(payload.messages);
  if (messagePrompt) {
    return messagePrompt;
  }

  throw new Error('Prompt is required');
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : 1;
}

function normalizeAnswerMode(value: unknown): TrinityAnswerMode | undefined {
  if (value !== 'direct' && value !== 'explained' && value !== 'audit' && value !== 'debug') {
    return undefined;
  }

  return value;
}

function resolveCoreExecutionMode(): ArcanosCoreExecutionMode {
  return 'request';
}

function resolveCoreHandlerTimeoutMs(
  executionMode: ArcanosCoreExecutionMode,
  remainingRequestMs: number | null
): number {
  const envKey =
    executionMode === 'background'
      ? 'ARCANOS_CORE_BACKGROUND_HANDLER_TIMEOUT_MS'
      : 'ARCANOS_CORE_HANDLER_TIMEOUT_MS';
  const configuredTimeoutMs = Number.parseInt(process.env[envKey] ?? '', 10);
  //audit Assumption: the core handler should finish slightly before the outer route timeout when no explicit override is configured; failure risk: a shorter default aborts Trinity mid-stage, while a longer default lets Railway edge time out first; expected invariant: the fallback handler timeout stays below the route cap and above Trinity's per-stage guards; handling strategy: default to route timeout minus fixed headroom, then clamp to the remaining request budget.
  const normalizedConfiguredTimeoutMs =
    Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
      ? Math.trunc(configuredTimeoutMs)
      : executionMode === 'background'
      ? DEFAULT_ARCANOS_CORE_BACKGROUND_HANDLER_TIMEOUT_MS
      : DEFAULT_ARCANOS_CORE_HANDLER_TIMEOUT_MS;

  if (remainingRequestMs === null) {
    return normalizedConfiguredTimeoutMs;
  }

  return Math.max(1, Math.min(normalizedConfiguredTimeoutMs, remainingRequestMs));
}

function resolveCorePipelineTimeoutMs(
  executionMode: ArcanosCoreExecutionMode
): number {
  const envKey =
    executionMode === 'background'
      ? 'ARCANOS_CORE_BACKGROUND_PIPELINE_TIMEOUT_MS'
      : 'ARCANOS_CORE_PIPELINE_TIMEOUT_MS';
  const configuredTimeoutMs = Number.parseInt(process.env[envKey] ?? '', 10);
  if (!Number.isFinite(configuredTimeoutMs) || configuredTimeoutMs <= 0) {
    return executionMode === 'background'
      ? DEFAULT_ARCANOS_CORE_BACKGROUND_PIPELINE_TIMEOUT_MS
      : DEFAULT_ARCANOS_CORE_PIPELINE_TIMEOUT_MS;
  }

  if (executionMode === 'background') {
    return Math.max(
      MIN_ARCANOS_CORE_BACKGROUND_PIPELINE_TIMEOUT_MS,
      Math.min(MAX_ARCANOS_CORE_BACKGROUND_PIPELINE_TIMEOUT_MS, Math.trunc(configuredTimeoutMs))
    );
  }

  return Math.max(
    MIN_ARCANOS_CORE_PIPELINE_TIMEOUT_MS,
    Math.min(MAX_ARCANOS_CORE_PIPELINE_TIMEOUT_MS, Math.trunc(configuredTimeoutMs))
  );
}

function resolveCoreDegradedHeadroomMs(
  totalTimeoutMs: number,
  executionMode: ArcanosCoreExecutionMode
): number {
  const envKey =
    executionMode === 'background'
      ? 'ARCANOS_CORE_BACKGROUND_DEGRADED_HEADROOM_MS'
      : 'ARCANOS_CORE_DEGRADED_HEADROOM_MS';
  const configuredHeadroomMs = Number.parseInt(process.env[envKey] ?? '', 10);
  const normalizedConfiguredHeadroomMs =
    Number.isFinite(configuredHeadroomMs) && configuredHeadroomMs > 0
      ? Math.trunc(configuredHeadroomMs)
      : executionMode === 'background'
      ? DEFAULT_ARCANOS_CORE_BACKGROUND_DEGRADED_HEADROOM_MS
      : DEFAULT_ARCANOS_CORE_DEGRADED_HEADROOM_MS;

  const proportionalHeadroomCapMs = Math.max(750, Math.floor(totalTimeoutMs * 0.4));
  return Math.max(
    750,
    Math.min(normalizedConfiguredHeadroomMs, proportionalHeadroomCapMs, Math.max(750, totalTimeoutMs - 1_000))
  );
}

function resolveCoreDegradedMaxWords(existingMaxWords?: number | null): number {
  const configuredMaxWords = Number.parseInt(process.env.ARCANOS_CORE_DEGRADED_MAX_WORDS ?? '', 10);
  const normalizedConfiguredMaxWords =
    Number.isFinite(configuredMaxWords) && configuredMaxWords > 0
      ? Math.trunc(configuredMaxWords)
      : DEFAULT_ARCANOS_CORE_DEGRADED_MAX_WORDS;

  if (typeof existingMaxWords === 'number' && Number.isFinite(existingMaxWords) && existingMaxWords > 0) {
    return Math.max(40, Math.min(existingMaxWords, normalizedConfiguredMaxWords));
  }

  return normalizedConfiguredMaxWords;
}

function resolveCoreRuntimeBudgetSafetyBufferMs(timeoutMs: number): number {
  return Math.max(0, Math.min(DEFAULT_ARCANOS_CORE_RUNTIME_BUDGET_SAFETY_BUFFER_MS, Math.floor(timeoutMs / 4)));
}

function buildCoreStaticFallbackResult(params: BuildArcanosCoreTimeoutFallbackParams): TrinityResult {
  const created = params.createdAtMs ?? Date.now();
  const normalizedPrompt = params.prompt.replace(/\s+/g, ' ').trim();
  const promptPreview =
    normalizedPrompt.length > 140 ? `${normalizedPrompt.slice(0, 137).trimEnd()}...` : normalizedPrompt;
  const timeoutPhase = normalizeTraceString(params.timeoutPhase) ?? 'pipeline';
  const normalizedRequestId =
    typeof params.requestId === 'string' && params.requestId.trim().length > 0
      ? params.requestId.trim()
      : `arcanos-core-timeout-${created}`;

  const result: TrinityResult = {
    result: [
      'The full ARCANOS analysis path hit its latency guard and returned a bounded fallback response.',
      `Request summary: ${promptPreview}`,
      'Retry with a narrower scope if you need the full multi-stage reasoning path.'
    ].join(' '),
    module: 'trinity',
    meta: {
      id: normalizedRequestId,
      created
    },
    activeModel: 'arcanos-core:static-timeout-fallback',
    fallbackFlag: true,
    routingStages: ['ARCANOS-CORE-TIMEOUT-FALLBACK'],
    dryRun: false,
    fallbackSummary: {
      intakeFallbackUsed: true,
      gpt5FallbackUsed: false,
      finalFallbackUsed: true,
      fallbackReasons: [
        `Primary pipeline timed out during ${timeoutPhase}`,
        'Direct-answer degraded recovery timed out',
        'Static timeout fallback used'
      ]
    },
    auditSafe: {
      mode: true,
      overrideUsed: false,
      auditFlags: ['CORE_PIPELINE_TIMEOUT_FALLBACK'],
      processedSafely: true
    },
    memoryContext: {
      entriesAccessed: 0,
      contextSummary: 'Bypassed during timeout fallback.',
      memoryEnhanced: false,
      maxRelevanceScore: 0,
      averageRelevanceScore: 0
    },
    taskLineage: {
      requestId: normalizedRequestId,
      logged: false
    },
    timeoutKind: 'pipeline_timeout',
    timeoutPhase,
    degradedModeReason: ARCANOS_CORE_STATIC_FALLBACK_REASON,
    bypassedSubsystems: [...ARCANOS_CORE_PIPELINE_BYPASSED_SUBSYSTEMS]
  };

  return applyTrinityGenerationInvariant(result, {
    sourceEndpoint: normalizeTraceString(params.sourceEndpoint) ?? 'gpt.arcanos-core.query',
    gptId: normalizeTraceString(params.gptId),
    moduleId: normalizeTraceString(params.moduleId) ?? 'ARCANOS:CORE',
    requestedAction: params.requestedAction,
    executionMode: normalizeTraceString(params.executionMode),
  });
}

export function buildArcanosCoreTimeoutFallbackResult(
  params: BuildArcanosCoreTimeoutFallbackParams
): TrinityResult {
  return buildCoreStaticFallbackResult(params);
}

export function buildArcanosCoreTimeoutFallbackEnvelope(params: {
  prompt: string;
  gptId: string;
  route?: string;
  requestId?: string | null;
  timestamp?: string;
  createdAtMs?: number;
  timeoutPhase?: string | null;
}): ArcanosCoreTimeoutFallbackEnvelope {
  const result = buildCoreStaticFallbackResult({
    prompt: params.prompt,
    requestId: params.requestId,
    sourceEndpoint: 'gpt.arcanos-core.query',
    gptId: params.gptId,
    moduleId: 'ARCANOS:CORE',
    requestedAction: 'query',
    createdAtMs: params.createdAtMs,
    timeoutPhase: params.timeoutPhase
  });

  return {
    ok: true,
    result,
    _route: {
      gptId: params.gptId,
      module: 'ARCANOS:CORE',
      action: 'query',
      route: params.route ?? 'core',
      timestamp: params.timestamp ?? new Date().toISOString(),
      ...(typeof params.requestId === 'string' && params.requestId.trim().length > 0
        ? { requestId: params.requestId.trim() }
        : {})
    }
  };
}

function buildCorePipelineAbortMessage(timeoutMs: number): string {
  return `ARCANOS:CORE pipeline timeout after ${timeoutMs}ms`;
}

function buildCoreDegradedAbortMessage(timeoutMs: number): string {
  return `ARCANOS:CORE degraded path timed out after ${timeoutMs}ms`;
}

function isCorePipelineTimeoutError(error: unknown): boolean {
  return resolveErrorMessage(error).toLowerCase().includes('arcanos:core pipeline timeout after');
}

function shouldRecoverViaCoreDegradedPath(
  error: unknown,
  durationMs: number,
  pipelinePlan: { primaryTimeoutMs: number; degradedTimeoutMs: number }
): boolean {
  if (!isAbortError(error) || pipelinePlan.degradedTimeoutMs <= 0) {
    return false;
  }

  if (isCorePipelineTimeoutError(error)) {
    return true;
  }

  const errorMessage = resolveErrorMessage(error).toLowerCase();
  const nearBoundaryThresholdMs = Math.max(1_000, Math.floor(pipelinePlan.primaryTimeoutMs * 0.85));
  const looksLikeBudgetAbort =
    errorMessage.includes('request was aborted') ||
    errorMessage.includes('runtime_budget_exhausted') ||
    errorMessage.includes('budget');

  return looksLikeBudgetAbort && durationMs >= nearBoundaryThresholdMs;
}

function buildCorePipelinePlan(
  executionModeOverride?: ArcanosCoreExecutionMode
): {
  executionMode: ArcanosCoreExecutionMode;
  totalTimeoutMs: number;
  primaryTimeoutMs: number;
  degradedTimeoutMs: number;
} {
  const remainingRequestMs = getRequestRemainingMs();
  const executionMode = executionModeOverride ?? resolveCoreExecutionMode();
  const handlerTimeoutMs = resolveCoreHandlerTimeoutMs(executionMode, remainingRequestMs);
  const pipelineTimeoutMs = resolveCorePipelineTimeoutMs(executionMode);
  const totalTimeoutMs = remainingRequestMs === null
    ? Math.max(1, Math.min(handlerTimeoutMs, pipelineTimeoutMs))
    : Math.max(1, Math.min(handlerTimeoutMs, pipelineTimeoutMs, remainingRequestMs));
  const degradedHeadroomMs = resolveCoreDegradedHeadroomMs(totalTimeoutMs, executionMode);
  const degradedTimeoutMs = totalTimeoutMs > 2_000
    ? Math.min(degradedHeadroomMs, Math.max(750, totalTimeoutMs - 1_000))
    : 0;
  const primaryTimeoutMs = Math.max(1, totalTimeoutMs - degradedTimeoutMs);

  return {
    executionMode,
    totalTimeoutMs,
    primaryTimeoutMs,
    degradedTimeoutMs
  };
}

function resolveTrinityRequestId(explicitRequestId?: string): string | undefined {
  const normalizedExplicitRequestId =
    typeof explicitRequestId === 'string' && explicitRequestId.trim().length > 0
      ? explicitRequestId.trim()
      : null;

  if (normalizedExplicitRequestId) {
    return normalizedExplicitRequestId;
  }

  const activeRequestId = getRequestAbortContext()?.requestId;
  return typeof activeRequestId === 'string' && activeRequestId.trim().length > 0
    ? activeRequestId.trim()
    : undefined;
}

function buildCoreDegradedRunOptions(
  sourceEndpoint: string,
  runOptions?: Omit<TrinityRunOptions, 'sourceEndpoint'>,
  watchdogModelTimeoutMs?: number
): TrinityRunOptions {
  return {
    ...(runOptions ?? {}),
    sourceEndpoint: `${sourceEndpoint}.degraded`,
    answerMode: 'direct',
    requestedVerbosity: 'minimal',
    maxWords: resolveCoreDegradedMaxWords(runOptions?.maxWords ?? null),
    debugPipeline: false,
    strictUserVisibleOutput: true,
    directAnswerModelOverride: APPLICATION_CONSTANTS.MODEL_GPT_4_1_MINI,
    ...(typeof watchdogModelTimeoutMs === 'number' && Number.isFinite(watchdogModelTimeoutMs) && watchdogModelTimeoutMs > 0
      ? { watchdogModelTimeoutMs: Math.trunc(watchdogModelTimeoutMs) }
      : {})
  };
}

export async function runArcanosCoreQuery(
  params: RunArcanosCoreQueryParams
): Promise<TrinityResult> {
  const startedAt = Date.now();
  const pipelinePlan = buildCorePipelinePlan(params.executionModeOverride);
  const trinityRequestId = resolveTrinityRequestId(params.requestId);
  const primaryRunOptions: TrinityRunOptions = {
    ...(params.runOptions ?? {}),
    sourceEndpoint: params.sourceEndpoint,
    ...(pipelinePlan.executionMode === 'background'
      ? { watchdogModelTimeoutMs: pipelinePlan.primaryTimeoutMs }
      : {})
  };
  const runtimeBudget = createRuntimeBudgetWithLimit(
    pipelinePlan.primaryTimeoutMs,
    resolveCoreRuntimeBudgetSafetyBufferMs(pipelinePlan.primaryTimeoutMs)
  );
  const primaryAbortMessage = buildCorePipelineAbortMessage(pipelinePlan.primaryTimeoutMs);
  const {
    sourceEndpoint: primarySourceEndpoint = params.sourceEndpoint,
    ...primaryRunOptionsWithoutSource
  } = primaryRunOptions;
  const structuredMessages =
    params.messages && params.messages.length > 0 ? params.messages : undefined;

  emitCoreRuntimeTrace({
    phase: 'route_resolved',
    startedAt,
    requestId: trinityRequestId ?? params.requestId,
    sourceEndpoint: params.sourceEndpoint,
    executionMode: pipelinePlan.executionMode,
    timeoutMs: pipelinePlan.primaryTimeoutMs,
    totalTimeoutMs: pipelinePlan.totalTimeoutMs,
    remainingBudgetMs: getRequestRemainingMs()
  });
  logger.info('[core] handler.start', {
    module: 'ARCANOS:CORE',
    sourceEndpoint: params.sourceEndpoint,
    executionMode: pipelinePlan.executionMode,
    promptLength: params.prompt.length,
    sessionId: params.sessionId,
    timeoutMs: pipelinePlan.primaryTimeoutMs,
    totalTimeoutMs: pipelinePlan.totalTimeoutMs,
    degradedTimeoutMs: pipelinePlan.degradedTimeoutMs,
    watchdogModelTimeoutMs: primaryRunOptions.watchdogModelTimeoutMs ?? null
  });
  logger.info('[core] stall_guard.armed', {
    module: 'ARCANOS:CORE',
    sourceEndpoint: params.sourceEndpoint,
    executionMode: pipelinePlan.executionMode,
    timeoutMs: pipelinePlan.primaryTimeoutMs,
    totalTimeoutMs: pipelinePlan.totalTimeoutMs,
    degradedTimeoutMs: pipelinePlan.degradedTimeoutMs,
    watchdogModelTimeoutMs: primaryRunOptions.watchdogModelTimeoutMs ?? null
  });

  try {
    logger.info('[core] before trinity.query', {
      module: 'ARCANOS:CORE',
      sourceEndpoint: params.sourceEndpoint,
      executionMode: pipelinePlan.executionMode
    });
    emitCoreRuntimeTrace({
      phase: 'pipeline_started',
      startedAt,
      requestId: trinityRequestId ?? params.requestId,
      sourceEndpoint: params.sourceEndpoint,
      executionMode: pipelinePlan.executionMode,
      runtimeBudget,
      timeoutMs: pipelinePlan.primaryTimeoutMs,
      totalTimeoutMs: pipelinePlan.totalTimeoutMs
    });
    const result = await runWithRequestAbortTimeout(
      {
        timeoutMs: pipelinePlan.primaryTimeoutMs,
        parentSignal: getRequestAbortSignal(),
        abortMessage: primaryAbortMessage
      },
      () =>
        runTrinityWritingPipeline({
          input: {
            ...(structuredMessages ? { messages: structuredMessages } : { prompt: params.prompt }),
            gptId: params.gptId,
            moduleId: params.moduleId ?? 'ARCANOS:CORE',
            sessionId: params.sessionId,
            overrideAuditSafe: params.overrideAuditSafe,
            sourceEndpoint: primarySourceEndpoint,
            requestedAction: params.requestedAction,
            body: params.body ?? (structuredMessages ? { messages: structuredMessages } : { prompt: params.prompt }),
            maxOutputTokens: params.maxOutputTokens,
            executionMode: pipelinePlan.executionMode,
            background: pipelinePlan.executionMode === 'background'
              ? {
                  reason: params.executionModeReason ?? 'arcanos_core_background'
                }
              : undefined
          },
          context: {
            client: params.client,
            ...(trinityRequestId ? { requestId: trinityRequestId } : {}),
            runtimeBudget,
            runOptions: primaryRunOptionsWithoutSource
          }
        })
    );
    logger.info('[core] after trinity.query', {
      module: 'ARCANOS:CORE',
      sourceEndpoint: params.sourceEndpoint,
      executionMode: pipelinePlan.executionMode,
      durationMs: Date.now() - startedAt
    });
    logger.info('[core] returning result', {
      module: 'ARCANOS:CORE',
      sourceEndpoint: params.sourceEndpoint,
      executionMode: pipelinePlan.executionMode,
      durationMs: Date.now() - startedAt
    });
    emitCoreRuntimeTrace({
      phase: 'response_sent',
      startedAt,
      requestId: trinityRequestId ?? params.requestId,
      sourceEndpoint: params.sourceEndpoint,
      executionMode: pipelinePlan.executionMode,
      runtimeBudget,
      timeoutMs: pipelinePlan.primaryTimeoutMs,
      totalTimeoutMs: pipelinePlan.totalTimeoutMs,
      degradedReason: result.degradedModeReason ?? null,
      timeoutPhase: result.timeoutPhase ?? null
    });
    return result;
  } catch (error) {
    const errorMessage = resolveErrorMessage(error);
    const durationMs = Date.now() - startedAt;
    if (shouldRecoverViaCoreDegradedPath(error, durationMs, pipelinePlan)) {
      const primaryTimeoutPhase = resolveCoreFallbackTimeoutPhase(error);
      if (params.allowTimeoutFallback === false) {
        logger.warn('[PIPELINE] timeout fallback suppressed', {
          module: 'ARCANOS:CORE',
          sourceEndpoint: params.sourceEndpoint,
          executionMode: pipelinePlan.executionMode,
          durationMs,
          timeoutKind: 'pipeline_timeout',
          timeoutPhase: primaryTimeoutPhase,
          primaryTimeoutMs: pipelinePlan.primaryTimeoutMs,
          totalTimeoutMs: pipelinePlan.totalTimeoutMs,
          degradedTimeoutMs: pipelinePlan.degradedTimeoutMs,
          error: errorMessage
        });
        emitCoreRuntimeTrace({
          phase: 'fallback_suppressed',
          startedAt,
          requestId: trinityRequestId ?? params.requestId,
          sourceEndpoint: params.sourceEndpoint,
          executionMode: pipelinePlan.executionMode,
          runtimeBudget,
          timeoutMs: pipelinePlan.primaryTimeoutMs,
          totalTimeoutMs: pipelinePlan.totalTimeoutMs,
          degradedReason: ARCANOS_CORE_PIPELINE_TIMEOUT_REASON,
          timeoutPhase: primaryTimeoutPhase,
          level: 'warn',
          extra: {
            error: errorMessage
          }
        });
        recordTraceEvent('core.pipeline.timeout_fallback_suppressed', {
          sourceEndpoint: params.sourceEndpoint,
          executionMode: pipelinePlan.executionMode,
          durationMs,
          timeoutKind: 'pipeline_timeout',
          timeoutPhase: primaryTimeoutPhase,
          primaryTimeoutMs: pipelinePlan.primaryTimeoutMs,
          totalTimeoutMs: pipelinePlan.totalTimeoutMs,
          degradedTimeoutMs: pipelinePlan.degradedTimeoutMs
        });
        throw error;
      }

      emitCoreRuntimeTrace({
        phase: 'fallback_triggered',
        startedAt,
        requestId: trinityRequestId ?? params.requestId,
        sourceEndpoint: params.sourceEndpoint,
        executionMode: pipelinePlan.executionMode,
        runtimeBudget,
        timeoutMs: pipelinePlan.primaryTimeoutMs,
        totalTimeoutMs: pipelinePlan.totalTimeoutMs,
        degradedReason: ARCANOS_CORE_PIPELINE_TIMEOUT_REASON,
        timeoutPhase: primaryTimeoutPhase,
        level: 'warn',
        extra: {
          error: errorMessage
        }
      });
      logger.warn('[PIPELINE] timeout clamp fired', {
        module: 'ARCANOS:CORE',
        sourceEndpoint: params.sourceEndpoint,
        executionMode: pipelinePlan.executionMode,
        durationMs,
        timeoutKind: 'pipeline_timeout',
        timeoutPhase: primaryTimeoutPhase,
        primaryTimeoutMs: pipelinePlan.primaryTimeoutMs,
        totalTimeoutMs: pipelinePlan.totalTimeoutMs,
        degradedTimeoutMs: pipelinePlan.degradedTimeoutMs,
        cancellationAttempted: true,
        error: errorMessage
      });
      recordTraceEvent('core.pipeline.timeout', {
        sourceEndpoint: params.sourceEndpoint,
        executionMode: pipelinePlan.executionMode,
        durationMs,
        timeoutKind: 'pipeline_timeout',
        primaryTimeoutMs: pipelinePlan.primaryTimeoutMs,
        totalTimeoutMs: pipelinePlan.totalTimeoutMs,
        degradedTimeoutMs: pipelinePlan.degradedTimeoutMs
      });

      try {
        logger.warn('[PIPELINE] degraded path engaged', {
          module: 'ARCANOS:CORE',
          sourceEndpoint: params.sourceEndpoint,
          executionMode: pipelinePlan.executionMode,
          reason: ARCANOS_CORE_PIPELINE_TIMEOUT_REASON,
          timeoutKind: 'pipeline_timeout',
          timeoutPhase: primaryTimeoutPhase,
          degradedTimeoutMs: pipelinePlan.degradedTimeoutMs,
          bypassedSubsystems: ARCANOS_CORE_PIPELINE_BYPASSED_SUBSYSTEMS
        });
        recordTraceEvent('core.pipeline.degraded', {
          sourceEndpoint: params.sourceEndpoint,
          executionMode: pipelinePlan.executionMode,
          reason: ARCANOS_CORE_PIPELINE_TIMEOUT_REASON,
          timeoutKind: 'pipeline_timeout',
          timeoutPhase: primaryTimeoutPhase,
          degradedTimeoutMs: pipelinePlan.degradedTimeoutMs,
          bypassedSubsystems: [...ARCANOS_CORE_PIPELINE_BYPASSED_SUBSYSTEMS]
        });

        const degradedResult = await runWithRequestAbortTimeout(
          {
            timeoutMs: pipelinePlan.degradedTimeoutMs,
            parentSignal: getRequestAbortSignal(),
            abortMessage: buildCoreDegradedAbortMessage(pipelinePlan.degradedTimeoutMs)
          },
          () => {
            const degradedRunOptions = buildCoreDegradedRunOptions(
              params.sourceEndpoint,
              params.runOptions,
              pipelinePlan.executionMode === 'background'
                ? pipelinePlan.degradedTimeoutMs
                : undefined
            );
            const {
              sourceEndpoint: degradedSourceEndpoint = `${params.sourceEndpoint}.degraded`,
              ...degradedRunOptionsWithoutSource
            } = degradedRunOptions;

            return runTrinityWritingPipeline({
              input: {
                ...(structuredMessages ? { messages: structuredMessages } : { prompt: params.prompt }),
                gptId: params.gptId,
                moduleId: params.moduleId ?? 'ARCANOS:CORE',
                sessionId: params.sessionId,
                overrideAuditSafe: params.overrideAuditSafe,
                sourceEndpoint: degradedSourceEndpoint,
                requestedAction: params.requestedAction,
                body: params.body ?? (structuredMessages ? { messages: structuredMessages } : { prompt: params.prompt }),
                maxOutputTokens: params.maxOutputTokens,
                executionMode: pipelinePlan.executionMode,
                background: pipelinePlan.executionMode === 'background'
                  ? {
                      reason: params.executionModeReason ?? 'arcanos_core_background_degraded'
                    }
                  : undefined
              },
              context: {
                client: params.client,
                ...(trinityRequestId ? { requestId: trinityRequestId } : {}),
                runtimeBudget: createRuntimeBudgetWithLimit(
                  pipelinePlan.degradedTimeoutMs,
                  resolveCoreRuntimeBudgetSafetyBufferMs(pipelinePlan.degradedTimeoutMs)
                ),
                runOptions: degradedRunOptionsWithoutSource
              }
            });
          }
        );

        logger.info('[PIPELINE] degraded path completed', {
          module: 'ARCANOS:CORE',
          sourceEndpoint: params.sourceEndpoint,
          executionMode: pipelinePlan.executionMode,
          durationMs: Date.now() - startedAt,
          timeoutKind: 'pipeline_timeout',
          timeoutPhase: primaryTimeoutPhase,
          activeModel: degradedResult.activeModel,
          bypassedSubsystems: ARCANOS_CORE_PIPELINE_BYPASSED_SUBSYSTEMS
        });
        emitCoreRuntimeTrace({
          phase: 'response_sent',
          startedAt,
          requestId: trinityRequestId ?? params.requestId,
          sourceEndpoint: params.sourceEndpoint,
          executionMode: pipelinePlan.executionMode,
          timeoutMs: pipelinePlan.primaryTimeoutMs,
          totalTimeoutMs: pipelinePlan.totalTimeoutMs,
          degradedReason: ARCANOS_CORE_PIPELINE_TIMEOUT_REASON,
          timeoutPhase: primaryTimeoutPhase
        });

        return {
          ...degradedResult,
          timeoutKind: 'pipeline_timeout',
          timeoutPhase: primaryTimeoutPhase,
          degradedModeReason: ARCANOS_CORE_PIPELINE_TIMEOUT_REASON,
          bypassedSubsystems: [...ARCANOS_CORE_PIPELINE_BYPASSED_SUBSYSTEMS]
        };
      } catch (degradedError) {
        const timeoutPhase = resolveCoreFallbackTimeoutPhase(error, degradedError);
        logger.error('[PIPELINE] degraded path failed', {
          module: 'ARCANOS:CORE',
          sourceEndpoint: params.sourceEndpoint,
          executionMode: pipelinePlan.executionMode,
          durationMs: Date.now() - startedAt,
          timeoutKind: 'pipeline_timeout',
          timeoutPhase,
          degradedTimeoutMs: pipelinePlan.degradedTimeoutMs,
          error: resolveErrorMessage(degradedError)
        });
        recordTraceEvent('core.pipeline.degraded_failure', {
          sourceEndpoint: params.sourceEndpoint,
          executionMode: pipelinePlan.executionMode,
          timeoutKind: 'pipeline_timeout',
          timeoutPhase,
          degradedTimeoutMs: pipelinePlan.degradedTimeoutMs,
          error: resolveErrorMessage(degradedError)
        });
        const staticFallback = buildCoreStaticFallbackResult({
          prompt: params.prompt,
          requestId: getRequestAbortContext()?.requestId ?? null,
          sourceEndpoint: params.sourceEndpoint,
          gptId: params.gptId,
          moduleId: params.moduleId ?? 'ARCANOS:CORE',
          requestedAction: params.requestedAction,
          executionMode: pipelinePlan.executionMode,
          timeoutPhase,
        });
        logger.warn('[PIPELINE] static fallback engaged', {
          module: 'ARCANOS:CORE',
          sourceEndpoint: params.sourceEndpoint,
          executionMode: pipelinePlan.executionMode,
          durationMs: Date.now() - startedAt,
          timeoutKind: 'pipeline_timeout',
          reason: ARCANOS_CORE_STATIC_FALLBACK_REASON,
          timeoutPhase,
          bypassedSubsystems: ARCANOS_CORE_PIPELINE_BYPASSED_SUBSYSTEMS
        });
        emitCoreRuntimeTrace({
          phase: 'fallback_triggered',
          startedAt,
          requestId: trinityRequestId ?? params.requestId,
          sourceEndpoint: params.sourceEndpoint,
          executionMode: pipelinePlan.executionMode,
          timeoutMs: pipelinePlan.primaryTimeoutMs,
          totalTimeoutMs: pipelinePlan.totalTimeoutMs,
          degradedReason: ARCANOS_CORE_STATIC_FALLBACK_REASON,
          timeoutPhase,
          level: 'warn',
          extra: {
            error: resolveErrorMessage(degradedError)
          }
        });
        recordTraceEvent('core.pipeline.static_fallback', {
          sourceEndpoint: params.sourceEndpoint,
          executionMode: pipelinePlan.executionMode,
          timeoutKind: 'pipeline_timeout',
          reason: ARCANOS_CORE_STATIC_FALLBACK_REASON,
          timeoutPhase,
          bypassedSubsystems: [...ARCANOS_CORE_PIPELINE_BYPASSED_SUBSYSTEMS]
        });
        emitCoreRuntimeTrace({
          phase: 'response_sent',
          startedAt,
          requestId: trinityRequestId ?? params.requestId,
          sourceEndpoint: params.sourceEndpoint,
          executionMode: pipelinePlan.executionMode,
          timeoutMs: pipelinePlan.primaryTimeoutMs,
          totalTimeoutMs: pipelinePlan.totalTimeoutMs,
          degradedReason: ARCANOS_CORE_STATIC_FALLBACK_REASON,
          timeoutPhase,
          level: 'warn'
        });
        return staticFallback;
      }
    }

    logger.error('[core] handler.error', {
      module: 'ARCANOS:CORE',
      sourceEndpoint: params.sourceEndpoint,
      executionMode: pipelinePlan.executionMode,
      durationMs,
      error: errorMessage
    });
    throw error;
  }
}

export const ArcanosCore: ModuleDef = {
  name: 'ARCANOS:CORE',
  description: 'Primary ARCANOS core assistant routed through the Trinity execution pipeline.',
  gptIds: ['arcanos-core', 'core', 'arcanos-daemon'],
  defaultAction: 'query',
  defaultTimeoutMs: DEFAULT_ARCANOS_CORE_ROUTE_TIMEOUT_MS,
  actions: {
    async query(payload: unknown) {
      const actionStartedAt = Date.now();
      emitCoreRuntimeTrace({
        phase: 'request_received',
        startedAt: actionStartedAt,
        sourceEndpoint: 'gpt.arcanos-core.query'
      });
      const normalizedPayload =
        payload && typeof payload === 'object' && !Array.isArray(payload)
          ? (payload as ArcanosCoreQueryPayload)
          : {};
      const directPrompt = extractDirectPrompt(normalizedPayload);
      const messages = directPrompt ? undefined : readTrinityMessages(normalizedPayload.messages);
      const prompt = extractPrompt(normalizedPayload);
      emitCoreRuntimeTrace({
        phase: 'prompt_normalization',
        startedAt: actionStartedAt,
        sourceEndpoint: 'gpt.arcanos-core.query',
        extra: {
          promptLength: prompt.length
        }
      });
      const sessionId =
        typeof normalizedPayload.sessionId === 'string' && normalizedPayload.sessionId.trim().length > 0
          ? normalizedPayload.sessionId.trim()
          : undefined;
      const overrideAuditSafe =
        typeof normalizedPayload.overrideAuditSafe === 'string' && normalizedPayload.overrideAuditSafe.trim().length > 0
          ? normalizedPayload.overrideAuditSafe.trim()
          : undefined;
      const answerMode = normalizeAnswerMode(
        typeof normalizedPayload.answerMode === 'string' ? normalizedPayload.answerMode.trim() : undefined
      );
      const maxWords =
        normalizePositiveInteger(normalizedPayload.maxWords) ??
        normalizePositiveInteger(normalizedPayload.max_words);
      const executionModeOverride =
        normalizedPayload.__arcanosExecutionMode === 'background'
          ? 'background'
          : normalizedPayload.__arcanosExecutionMode === 'request'
          ? 'request'
          : undefined;
      const gptId = normalizeTraceString(normalizedPayload.__arcanosGptId);
      const sourceEndpoint =
        normalizeTraceString(normalizedPayload.__arcanosSourceEndpoint) ??
        'gpt.arcanos-core.query';
      const requestedAction =
        normalizeTraceString(normalizedPayload.__arcanosRequestedAction) ??
        normalizeTraceString(normalizedPayload.action) ??
        normalizeTraceString(normalizedPayload.operation) ??
        'query';
      const maxOutputTokens = normalizePositiveInteger(normalizedPayload.maxOutputTokens);
      const allowTimeoutFallback = !normalizeBooleanFlagValue(
        normalizedPayload[ARCANOS_SUPPRESS_TIMEOUT_FALLBACK_FLAG]
      );
      const { client } = getOpenAIClientOrAdapter();
      emitCoreRuntimeTrace({
        phase: 'gpt_config_loaded',
        startedAt: actionStartedAt,
        sourceEndpoint,
        extra: {
          hasClient: !!client,
          gptId: gptId ?? null,
          sessionId: sessionId ?? null,
          answerMode: answerMode ?? null
        }
      });

      if (!client) {
        logger.info('[core] handler.mock_response', {
          module: 'ARCANOS:CORE',
          durationMs: 0
        });
        emitCoreRuntimeTrace({
          phase: 'response_sent',
          startedAt: actionStartedAt,
          sourceEndpoint,
          degradedReason: 'mock_response'
        });
        return generateMockResponse(prompt, 'gpt/arcanos-core');
      }

      return runArcanosCoreQuery({
        client,
        prompt,
        requestId: getRequestAbortContext()?.requestId,
        gptId,
        moduleId: 'ARCANOS:CORE',
        requestedAction,
        body: normalizedPayload,
        messages,
        sessionId,
        overrideAuditSafe,
        sourceEndpoint,
        maxOutputTokens,
        runOptions: {
          ...(answerMode ? { answerMode } : {}),
          ...(maxWords ? { maxWords } : {})
        },
        executionModeOverride,
        executionModeReason: normalizeTraceString(normalizedPayload.__arcanosExecutionReason),
        allowTimeoutFallback
      });
    },
    async system_state(payload: unknown) {
      return executeSystemStateRequest(payload);
    }
  }
};

export default ArcanosCore;
