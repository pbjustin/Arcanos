import { runTrinityWritingPipeline } from "@core/logic/trinityWritingPipeline.js";
import { logger } from "@platform/logging/structuredLogging.js";
import { createRuntimeBudgetWithLimit } from "@platform/resilience/runtimeBudget.js";
import {
  getRequestAbortContext,
  getRequestAbortSignal,
  getRequestRemainingMs,
  isAbortError,
  runWithRequestAbortTimeout
} from "@arcanos/runtime";
import {
  GAMING_RUNTIME_BUDGET_SAFETY_BUFFER_MS,
  getGamingPipelineTimeoutMs,
  getGamingStageTimeoutMs
} from "@services/gamingConfig.js";
import { getOpenAIClientOrAdapter } from "@services/openai/clientBridge.js";
import { generateMockResponse } from "@services/openai.js";
import { tryExtractExactLiteralPromptShortcut } from "@services/exactLiteralPromptShortcut.js";
import {
  formatGamingSuccess,
  type GamingMode,
  type GamingSuccessEnvelope,
  type ValidatedGamingRequest
} from "@services/gamingModes.js";
import { buildGamingTrinityPrompt } from "@services/gamingPromptBuilder.js";
import {
  buildGamingWebContext,
  collectGamingGuideUrls
} from "@services/gamingWebContext.js";

export type GamingPipelineInput = Pick<
  ValidatedGamingRequest,
  "mode" | "prompt" | "game" | "guideUrl" | "guideUrls" | "auditEnabled"
>;

type GamingWebSource = GamingSuccessEnvelope["data"]["sources"][number];

type GamingLogContext = {
  module: "ARCANOS:GAMING";
  route: "gaming";
  mode: GamingMode;
  sourceEndpoint: string;
  requestId?: string;
  promptLength: number;
  gameProvided: boolean;
  guideSourceCount: number;
};

function readTimeoutPhase(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const candidate = error as Record<string, unknown>;
  for (const key of ["timeoutPhase", "trinityStage", "stage"]) {
    const value = candidate[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}

function readErrorString(error: unknown, key: string): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

const PROVIDER_TIMEOUT_ERROR_MARKERS = [
  "openai_call_aborted_due_to_budget",
  "runtime_budget_exhausted",
  "runtimebudgetexceeded",
  "budgetexceeded",
  "watchdog threshold",
  "execution aborted by watchdog"
];

function isGamingProviderTimeoutError(error: unknown): boolean {
  if (isAbortError(error)) {
    return true;
  }

  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as { name?: unknown; code?: unknown; message?: unknown };
  const values = [candidate.name, candidate.code, candidate.message]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());

  return values.some((value) =>
    PROVIDER_TIMEOUT_ERROR_MARKERS.some((marker) => value.includes(marker))
  );
}

function createGamingProviderTimeoutError(
  mode: GamingMode,
  error: unknown,
  timeoutMs: number,
  stageTimeoutMs: number,
  timeoutPhase = readTimeoutPhase(error) ?? "provider"
): Error {
  const timeoutError = new Error(`Gaming ${mode} generation timed out before a complete response was available.`);
  Object.assign(timeoutError, {
    code: "GAMING_PROVIDER_TIMEOUT",
    timeoutMs,
    stageTimeoutMs,
    timeoutPhase
  });
  return timeoutError;
}

function estimateResponsePayloadChars(response: string, sources: GamingWebSource[]): number {
  return sources.reduce(
    (total, source) =>
      total + source.url.length + (source.snippet?.length ?? 0) + (source.error?.length ?? 0),
    response.length
  );
}

function formatGameplaySuccessWithLogs(params: {
  mode: GamingMode;
  response: string;
  sources: GamingWebSource[];
  logContext: GamingLogContext;
  requestStartedAt: number;
}): GamingSuccessEnvelope {
  const postprocessStartedAt = Date.now();
  logger.info("gaming.postprocess.start", {
    ...params.logContext,
    responseChars: params.response.length,
    sourceCount: params.sources.length
  });

  const envelope = formatGamingSuccess({
    mode: params.mode,
    data: {
      response: params.response,
      sources: params.sources
    }
  });

  logger.info("gaming.postprocess.end", {
    ...params.logContext,
    postprocessMs: Date.now() - postprocessStartedAt,
    responseChars: params.response.length,
    sourceCount: params.sources.length
  });

  const payloadEstimateStartedAt = Date.now();
  const responsePayloadChars = estimateResponsePayloadChars(params.response, params.sources);
  logger.info("gaming.response.serialization", {
    ...params.logContext,
    serializedByTransport: true,
    payloadEstimateMs: Date.now() - payloadEstimateStartedAt,
    responsePayloadChars
  });
  logger.info("gaming.request.end", {
    ...params.logContext,
    ok: true,
    totalElapsedMs: Date.now() - params.requestStartedAt
  });

  return envelope;
}

function stringifyMockResult(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }

  if (result === null || result === undefined) {
    return "";
  }

  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function buildGamingRunOptions(mode: GamingMode) {
  if (mode === "guide") {
    return {
      answerMode: "explained" as const,
      requestedVerbosity: "detailed" as const,
      strictUserVisibleOutput: true
    };
  }

  return {
    answerMode: "direct" as const,
    strictUserVisibleOutput: true
  };
}

export async function runGameplayPipeline(params: GamingPipelineInput): Promise<GamingSuccessEnvelope> {
  const requestStartedAt = Date.now();
  const sourceEndpoint = `arcanos-gaming.${params.mode}`;
  const requestId = getRequestAbortContext()?.requestId;
  const guideSourceCount = (params.guideUrl ? 1 : 0) + params.guideUrls.length;
  const baseLogContext: GamingLogContext = {
    module: "ARCANOS:GAMING",
    route: "gaming",
    mode: params.mode,
    sourceEndpoint,
    ...(requestId ? { requestId } : {}),
    promptLength: params.prompt.length,
    gameProvided: Boolean(params.game),
    guideSourceCount
  };

  logger.info("gaming.request.start", baseLogContext);

  const exactLiteralShortcut = tryExtractExactLiteralPromptShortcut(params.prompt);
  if (exactLiteralShortcut) {
    return formatGameplaySuccessWithLogs({
      mode: params.mode,
      response: exactLiteralShortcut.literal,
      sources: [],
      logContext: baseLogContext,
      requestStartedAt
    });
  }

  const guideUrls = collectGamingGuideUrls(params);
  const { context: webContext, sources } = await buildGamingWebContext(guideUrls);
  const { client } = getOpenAIClientOrAdapter();

  if (!client) {
    logger.warn("gaming.provider.unavailable", {
      ...baseLogContext,
      provider: "openai",
      fallback: "mock"
    });
    const mock = generateMockResponse(params.prompt, params.mode);
    return formatGameplaySuccessWithLogs({
      mode: params.mode,
      response: stringifyMockResult(mock.result),
      sources,
      logContext: baseLogContext,
      requestStartedAt
    });
  }

  const pipelineTimeoutMs = getGamingPipelineTimeoutMs(params.mode, getRequestRemainingMs());
  const stageTimeoutMs = getGamingStageTimeoutMs(params.mode, pipelineTimeoutMs);
  const providerStartedAt = Date.now();
  logger.info("gaming.provider.start", {
    ...baseLogContext,
    provider: "trinity",
    timeoutMs: pipelineTimeoutMs,
    stageTimeoutMs
  });
  logger.info("gaming.stream.start", {
    ...baseLogContext,
    provider: "trinity",
    streaming: false
  });

  let trinityResult: Awaited<ReturnType<typeof runTrinityWritingPipeline>>;
  try {
    trinityResult = await runWithRequestAbortTimeout(
      {
        timeoutMs: pipelineTimeoutMs,
        requestId,
        parentSignal: getRequestAbortSignal(),
        abortMessage: `Gaming ${params.mode} pipeline timed out after ${pipelineTimeoutMs}ms`
      },
      () =>
        runTrinityWritingPipeline({
          input: {
            prompt: buildGamingTrinityPrompt(params, webContext, guideUrls.length > 0),
            moduleId: "ARCANOS:GAMING",
            sourceEndpoint,
            requestedAction: "query",
            body: params,
            executionMode: "request"
          },
          context: {
            client,
            ...(requestId ? { requestId } : {}),
            runtimeBudget: createRuntimeBudgetWithLimit(
              pipelineTimeoutMs,
              GAMING_RUNTIME_BUDGET_SAFETY_BUFFER_MS
            ),
            runOptions: {
              ...buildGamingRunOptions(params.mode),
              watchdogModelTimeoutMs: stageTimeoutMs
            }
          }
        })
    );
  } catch (error) {
    const elapsedMs = Date.now() - providerStartedAt;
    logger.info("gaming.stream.end", {
      ...baseLogContext,
      provider: "trinity",
      streaming: false,
      ok: false,
      elapsedMs
    });

    if (isGamingProviderTimeoutError(error)) {
      if (getRequestAbortSignal()?.aborted) {
        logger.info("gaming.request.end", {
          ...baseLogContext,
          ok: false,
          totalElapsedMs: Date.now() - requestStartedAt,
          errorCode: "REQUEST_ABORTED"
        });
        throw error;
      }

      const timeoutPhase = readTimeoutPhase(error) ?? "provider";
      logger.warn("gaming.provider.timeout", {
        ...baseLogContext,
        provider: "trinity",
        timeoutMs: pipelineTimeoutMs,
        stageTimeoutMs,
        elapsedMs,
        timeoutPhase,
        errorName: error instanceof Error ? error.name : typeof error,
        errorCode: readErrorString(error, "code")
      });
      logger.info("gaming.request.end", {
        ...baseLogContext,
        ok: false,
        totalElapsedMs: Date.now() - requestStartedAt,
        errorCode: "GAMING_PROVIDER_TIMEOUT"
      });
      throw createGamingProviderTimeoutError(params.mode, error, pipelineTimeoutMs, stageTimeoutMs, timeoutPhase);
    }

    logger.error("gaming.provider.error", {
      ...baseLogContext,
      provider: "trinity",
      elapsedMs,
      errorName: error instanceof Error ? error.name : typeof error,
      errorCode: readErrorString(error, "code")
    });
    logger.info("gaming.request.end", {
      ...baseLogContext,
      ok: false,
      totalElapsedMs: Date.now() - requestStartedAt,
      errorCode: "GAMING_PROVIDER_ERROR"
    });
    throw error;
  }

  logger.info("gaming.stream.end", {
    ...baseLogContext,
    provider: "trinity",
    streaming: false,
    ok: true,
    elapsedMs: Date.now() - providerStartedAt
  });
  logger.info("gaming.provider.end", {
    ...baseLogContext,
    provider: "trinity",
    elapsedMs: Date.now() - providerStartedAt,
    activeModel: trinityResult.activeModel,
    finishReason: trinityResult.meta?.provider?.finishReason ?? "unknown"
  });

  return formatGameplaySuccessWithLogs({
    mode: params.mode,
    response: trinityResult.result,
    sources,
    logContext: baseLogContext,
    requestStartedAt
  });
}
