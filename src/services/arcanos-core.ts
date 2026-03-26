import OpenAI from 'openai';
import { runThroughBrain } from '@core/logic/trinity.js';
import type { TrinityAnswerMode, TrinityResult, TrinityRunOptions } from '@core/logic/trinity.js';
import { createRuntimeBudgetWithLimit } from '@platform/resilience/runtimeBudget.js';
import { logger } from '@platform/logging/structuredLogging.js';
import { recordTraceEvent } from '@platform/logging/telemetry.js';
import { generateMockResponse } from '@services/openai.js';
import { getOpenAIClientOrAdapter } from '@services/openai/clientBridge.js';
import { APPLICATION_CONSTANTS } from '@shared/constants.js';
import type { ModuleDef } from './moduleLoader.js';
import { executeSystemStateRequest } from './systemState.js';
import {
  getRequestAbortSignal,
  getRequestRemainingMs,
  isAbortError,
  runWithRequestAbortTimeout
} from '@arcanos/runtime';
import { resolveErrorMessage } from '@core/lib/errors/index.js';

type ArcanosCoreQueryPayload = {
  prompt?: string;
  message?: string;
  query?: string;
  text?: string;
  content?: string;
  sessionId?: string;
  overrideAuditSafe?: string;
  answerMode?: string;
  max_words?: number;
  maxWords?: number;
};

const DEFAULT_ARCANOS_CORE_ROUTE_TIMEOUT_MS = 60_000;
const DEFAULT_ARCANOS_CORE_HANDLER_HEADROOM_MS = 5_000;
const DEFAULT_ARCANOS_CORE_HANDLER_TIMEOUT_MS =
  DEFAULT_ARCANOS_CORE_ROUTE_TIMEOUT_MS - DEFAULT_ARCANOS_CORE_HANDLER_HEADROOM_MS;
const DEFAULT_ARCANOS_CORE_PIPELINE_TIMEOUT_MS = 5_000;
const MIN_ARCANOS_CORE_PIPELINE_TIMEOUT_MS = 2_500;
const MAX_ARCANOS_CORE_PIPELINE_TIMEOUT_MS = 15_000;
const DEFAULT_ARCANOS_CORE_DEGRADED_HEADROOM_MS = 2_000;
const DEFAULT_ARCANOS_CORE_DEGRADED_MAX_WORDS = 60;
const DEFAULT_ARCANOS_CORE_RUNTIME_BUDGET_SAFETY_BUFFER_MS = 250;
const ARCANOS_CORE_PIPELINE_TIMEOUT_REASON = 'arcanos_core_pipeline_timeout_direct_answer';
const ARCANOS_CORE_STATIC_FALLBACK_REASON = 'arcanos_core_pipeline_timeout_static_fallback';
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
  sessionId?: string;
  overrideAuditSafe?: string;
  runOptions?: Omit<TrinityRunOptions, 'sourceEndpoint'>;
}

function extractPrompt(payload: ArcanosCoreQueryPayload): string {
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

  throw new Error('Prompt is required');
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : undefined;
}

function normalizeAnswerMode(value: unknown): TrinityAnswerMode | undefined {
  if (value !== 'direct' && value !== 'explained' && value !== 'audit' && value !== 'debug') {
    return undefined;
  }

  return value;
}

function resolveCoreHandlerTimeoutMs(): number {
  const configuredTimeoutMs = Number.parseInt(process.env.ARCANOS_CORE_HANDLER_TIMEOUT_MS ?? '', 10);
  //audit Assumption: the core handler should finish slightly before the outer route timeout when no explicit override is configured; failure risk: a shorter default aborts Trinity mid-stage, while a longer default lets Railway edge time out first; expected invariant: the fallback handler timeout stays below the route cap and above Trinity's per-stage guards; handling strategy: default to route timeout minus fixed headroom, then clamp to the remaining request budget.
  const normalizedConfiguredTimeoutMs =
    Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
      ? Math.trunc(configuredTimeoutMs)
      : DEFAULT_ARCANOS_CORE_HANDLER_TIMEOUT_MS;
  const remainingRequestMs = getRequestRemainingMs();

  if (remainingRequestMs === null) {
    return normalizedConfiguredTimeoutMs;
  }

  return Math.max(1, Math.min(normalizedConfiguredTimeoutMs, remainingRequestMs));
}

function resolveCorePipelineTimeoutMs(): number {
  const configuredTimeoutMs = Number.parseInt(process.env.ARCANOS_CORE_PIPELINE_TIMEOUT_MS ?? '', 10);
  if (!Number.isFinite(configuredTimeoutMs) || configuredTimeoutMs <= 0) {
    return DEFAULT_ARCANOS_CORE_PIPELINE_TIMEOUT_MS;
  }

  return Math.max(
    MIN_ARCANOS_CORE_PIPELINE_TIMEOUT_MS,
    Math.min(MAX_ARCANOS_CORE_PIPELINE_TIMEOUT_MS, Math.trunc(configuredTimeoutMs))
  );
}

function resolveCoreDegradedHeadroomMs(totalTimeoutMs: number): number {
  const configuredHeadroomMs = Number.parseInt(process.env.ARCANOS_CORE_DEGRADED_HEADROOM_MS ?? '', 10);
  const normalizedConfiguredHeadroomMs =
    Number.isFinite(configuredHeadroomMs) && configuredHeadroomMs > 0
      ? Math.trunc(configuredHeadroomMs)
      : DEFAULT_ARCANOS_CORE_DEGRADED_HEADROOM_MS;

  return Math.max(750, Math.min(normalizedConfiguredHeadroomMs, Math.max(750, totalTimeoutMs - 1_000)));
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

function buildCoreStaticFallbackResult(prompt: string): TrinityResult {
  const created = Date.now();
  const normalizedPrompt = prompt.replace(/\s+/g, ' ').trim();
  const promptPreview =
    normalizedPrompt.length > 140 ? `${normalizedPrompt.slice(0, 137).trimEnd()}...` : normalizedPrompt;

  return {
    result: [
      'The full ARCANOS analysis path hit its latency guard and returned a bounded fallback response.',
      `Request summary: ${promptPreview}`,
      'Retry with a narrower scope if you need the full multi-stage reasoning path.'
    ].join(' '),
    module: 'trinity',
    meta: {
      id: `arcanos-core-timeout-${created}`,
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
        'Primary pipeline timed out',
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
      requestId: `arcanos-core-timeout-${created}`,
      logged: false
    },
    timeoutKind: 'pipeline_timeout',
    degradedModeReason: ARCANOS_CORE_STATIC_FALLBACK_REASON,
    bypassedSubsystems: [...ARCANOS_CORE_PIPELINE_BYPASSED_SUBSYSTEMS]
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

function buildCorePipelinePlan(): {
  totalTimeoutMs: number;
  primaryTimeoutMs: number;
  degradedTimeoutMs: number;
} {
  const handlerTimeoutMs = resolveCoreHandlerTimeoutMs();
  const remainingRequestMs = getRequestRemainingMs();
  const totalTimeoutMs = remainingRequestMs === null
    ? Math.min(handlerTimeoutMs, resolveCorePipelineTimeoutMs())
    : Math.max(1, Math.min(handlerTimeoutMs, resolveCorePipelineTimeoutMs(), remainingRequestMs));
  const degradedHeadroomMs = resolveCoreDegradedHeadroomMs(totalTimeoutMs);
  const degradedTimeoutMs = totalTimeoutMs > 2_000
    ? Math.min(degradedHeadroomMs, Math.max(750, totalTimeoutMs - 1_000))
    : 0;
  const primaryTimeoutMs = Math.max(1, totalTimeoutMs - degradedTimeoutMs);

  return {
    totalTimeoutMs,
    primaryTimeoutMs,
    degradedTimeoutMs
  };
}

function buildCoreDegradedRunOptions(
  sourceEndpoint: string,
  runOptions?: Omit<TrinityRunOptions, 'sourceEndpoint'>
): TrinityRunOptions {
  return {
    ...(runOptions ?? {}),
    sourceEndpoint: `${sourceEndpoint}.degraded`,
    answerMode: 'direct',
    requestedVerbosity: 'minimal',
    maxWords: resolveCoreDegradedMaxWords(runOptions?.maxWords ?? null),
    debugPipeline: false,
    strictUserVisibleOutput: true,
    directAnswerModelOverride: APPLICATION_CONSTANTS.MODEL_GPT_4_1_MINI
  };
}

export async function runArcanosCoreQuery(
  params: RunArcanosCoreQueryParams
): Promise<TrinityResult> {
  const startedAt = Date.now();
  const pipelinePlan = buildCorePipelinePlan();
  const runtimeBudget = createRuntimeBudgetWithLimit(
    pipelinePlan.primaryTimeoutMs,
    resolveCoreRuntimeBudgetSafetyBufferMs(pipelinePlan.primaryTimeoutMs)
  );
  const primaryAbortMessage = buildCorePipelineAbortMessage(pipelinePlan.primaryTimeoutMs);

  logger.info('[core] handler.start', {
    module: 'ARCANOS:CORE',
    sourceEndpoint: params.sourceEndpoint,
    promptLength: params.prompt.length,
    sessionId: params.sessionId,
    timeoutMs: pipelinePlan.primaryTimeoutMs,
    totalTimeoutMs: pipelinePlan.totalTimeoutMs,
    degradedTimeoutMs: pipelinePlan.degradedTimeoutMs
  });
  logger.info('[core] stall_guard.armed', {
    module: 'ARCANOS:CORE',
    sourceEndpoint: params.sourceEndpoint,
    timeoutMs: pipelinePlan.primaryTimeoutMs,
    totalTimeoutMs: pipelinePlan.totalTimeoutMs,
    degradedTimeoutMs: pipelinePlan.degradedTimeoutMs
  });

  try {
    logger.info('[core] before trinity.query', {
      module: 'ARCANOS:CORE',
      sourceEndpoint: params.sourceEndpoint
    });
    const result = await runWithRequestAbortTimeout(
      {
        timeoutMs: pipelinePlan.primaryTimeoutMs,
        parentSignal: getRequestAbortSignal(),
        abortMessage: primaryAbortMessage
      },
      () =>
        runThroughBrain(
          params.client,
          params.prompt,
          params.sessionId,
          params.overrideAuditSafe,
          {
            sourceEndpoint: params.sourceEndpoint,
            ...(params.runOptions ?? {})
          },
          runtimeBudget
        )
    );
    logger.info('[core] after trinity.query', {
      module: 'ARCANOS:CORE',
      sourceEndpoint: params.sourceEndpoint,
      durationMs: Date.now() - startedAt
    });
    logger.info('[core] returning result', {
      module: 'ARCANOS:CORE',
      sourceEndpoint: params.sourceEndpoint,
      durationMs: Date.now() - startedAt
    });
    return result;
  } catch (error) {
    const errorMessage = resolveErrorMessage(error);
    const durationMs = Date.now() - startedAt;
    if (shouldRecoverViaCoreDegradedPath(error, durationMs, pipelinePlan)) {
      logger.warn('[PIPELINE] timeout clamp fired', {
        module: 'ARCANOS:CORE',
        sourceEndpoint: params.sourceEndpoint,
        durationMs,
        timeoutKind: 'pipeline_timeout',
        primaryTimeoutMs: pipelinePlan.primaryTimeoutMs,
        totalTimeoutMs: pipelinePlan.totalTimeoutMs,
        degradedTimeoutMs: pipelinePlan.degradedTimeoutMs,
        cancellationAttempted: true,
        error: errorMessage
      });
      recordTraceEvent('core.pipeline.timeout', {
        sourceEndpoint: params.sourceEndpoint,
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
          reason: ARCANOS_CORE_PIPELINE_TIMEOUT_REASON,
          timeoutKind: 'pipeline_timeout',
          degradedTimeoutMs: pipelinePlan.degradedTimeoutMs,
          bypassedSubsystems: ARCANOS_CORE_PIPELINE_BYPASSED_SUBSYSTEMS
        });
        recordTraceEvent('core.pipeline.degraded', {
          sourceEndpoint: params.sourceEndpoint,
          reason: ARCANOS_CORE_PIPELINE_TIMEOUT_REASON,
          timeoutKind: 'pipeline_timeout',
          degradedTimeoutMs: pipelinePlan.degradedTimeoutMs,
          bypassedSubsystems: [...ARCANOS_CORE_PIPELINE_BYPASSED_SUBSYSTEMS]
        });

        const degradedResult = await runWithRequestAbortTimeout(
          {
            timeoutMs: pipelinePlan.degradedTimeoutMs,
            parentSignal: getRequestAbortSignal(),
            abortMessage: buildCoreDegradedAbortMessage(pipelinePlan.degradedTimeoutMs)
          },
          () =>
            runThroughBrain(
              params.client,
              params.prompt,
              params.sessionId,
              params.overrideAuditSafe,
              buildCoreDegradedRunOptions(params.sourceEndpoint, params.runOptions),
              createRuntimeBudgetWithLimit(
                pipelinePlan.degradedTimeoutMs,
                resolveCoreRuntimeBudgetSafetyBufferMs(pipelinePlan.degradedTimeoutMs)
              )
            )
        );

        logger.info('[PIPELINE] degraded path completed', {
          module: 'ARCANOS:CORE',
          sourceEndpoint: params.sourceEndpoint,
          durationMs: Date.now() - startedAt,
          timeoutKind: 'pipeline_timeout',
          activeModel: degradedResult.activeModel,
          bypassedSubsystems: ARCANOS_CORE_PIPELINE_BYPASSED_SUBSYSTEMS
        });

        return {
          ...degradedResult,
          timeoutKind: 'pipeline_timeout',
          degradedModeReason: ARCANOS_CORE_PIPELINE_TIMEOUT_REASON,
          bypassedSubsystems: [...ARCANOS_CORE_PIPELINE_BYPASSED_SUBSYSTEMS]
        };
      } catch (degradedError) {
        logger.error('[PIPELINE] degraded path failed', {
          module: 'ARCANOS:CORE',
          sourceEndpoint: params.sourceEndpoint,
          durationMs: Date.now() - startedAt,
          timeoutKind: 'pipeline_timeout',
          degradedTimeoutMs: pipelinePlan.degradedTimeoutMs,
          error: resolveErrorMessage(degradedError)
        });
        recordTraceEvent('core.pipeline.degraded_failure', {
          sourceEndpoint: params.sourceEndpoint,
          timeoutKind: 'pipeline_timeout',
          degradedTimeoutMs: pipelinePlan.degradedTimeoutMs,
          error: resolveErrorMessage(degradedError)
        });
        const staticFallback = buildCoreStaticFallbackResult(params.prompt);
        logger.warn('[PIPELINE] static fallback engaged', {
          module: 'ARCANOS:CORE',
          sourceEndpoint: params.sourceEndpoint,
          durationMs: Date.now() - startedAt,
          timeoutKind: 'pipeline_timeout',
          reason: ARCANOS_CORE_STATIC_FALLBACK_REASON,
          bypassedSubsystems: ARCANOS_CORE_PIPELINE_BYPASSED_SUBSYSTEMS
        });
        recordTraceEvent('core.pipeline.static_fallback', {
          sourceEndpoint: params.sourceEndpoint,
          timeoutKind: 'pipeline_timeout',
          reason: ARCANOS_CORE_STATIC_FALLBACK_REASON,
          bypassedSubsystems: [...ARCANOS_CORE_PIPELINE_BYPASSED_SUBSYSTEMS]
        });
        return staticFallback;
      }
    }

    logger.error('[core] handler.error', {
      module: 'ARCANOS:CORE',
      sourceEndpoint: params.sourceEndpoint,
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
      const normalizedPayload =
        payload && typeof payload === 'object' && !Array.isArray(payload)
          ? (payload as ArcanosCoreQueryPayload)
          : {};
      const prompt = extractPrompt(normalizedPayload);
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
      const { client } = getOpenAIClientOrAdapter();

      if (!client) {
        logger.info('[core] handler.mock_response', {
          module: 'ARCANOS:CORE',
          durationMs: 0
        });
        return generateMockResponse(prompt, 'gpt/arcanos-core');
      }

      return runArcanosCoreQuery({
        client,
        prompt,
        sessionId,
        overrideAuditSafe,
        sourceEndpoint: 'gpt.arcanos-core.query',
        runOptions: {
          ...(answerMode ? { answerMode } : {}),
          ...(maxWords ? { maxWords } : {})
        }
      });
    },
    async system_state(payload: unknown) {
      return executeSystemStateRequest(payload);
    }
  }
};

export default ArcanosCore;
