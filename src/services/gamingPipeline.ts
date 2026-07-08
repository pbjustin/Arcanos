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
  traceId?: string;
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

const PROVIDER_COMPLETION_INCOMPLETE_FALLBACK_REASON = "PROVIDER_COMPLETION_INCOMPLETE";

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

function isGamingProviderCompletionIncompleteError(error: unknown): boolean {
  return readErrorString(error, "code") === "OPENAI_COMPLETION_INCOMPLETE";
}

function classifyGamingProviderFallbackReason(timeoutPhase?: string): string {
  const normalizedPhase = timeoutPhase?.toLowerCase();
  if (
    normalizedPhase === "intake" ||
    normalizedPhase === "reasoning" ||
    normalizedPhase === "final" ||
    normalizedPhase === "provider"
  ) {
    return "INTAKE_UPSTREAM_TIMEOUT";
  }
  if (normalizedPhase === "retrieval") {
    return "INTAKE_RETRIEVAL_TIMEOUT";
  }
  if (normalizedPhase === "parse") {
    return "INTAKE_PARSE_TIMEOUT";
  }
  return "INTAKE_UNKNOWN_TIMEOUT";
}

function estimateResponsePayloadChars(response: string, sources: GamingWebSource[]): number {
  return sources.reduce(
    (total, source) =>
      total + source.url.length + (source.snippet?.length ?? 0) + (source.error?.length ?? 0),
    response.length
  );
}

function logGamingIntakeStep(
  logContext: GamingLogContext,
  step: string,
  startedAt: number,
  details: Record<string, unknown> = {}
): void {
  const timeoutPhase = typeof details.timeoutPhase === "string" ? details.timeoutPhase : null;
  logger.info("gaming.intake.step", {
    ...logContext,
    step,
    timeoutPhase,
    ...details,
    elapsedMs: Date.now() - startedAt
  });
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

function hasEldenRingContext(params: GamingPipelineInput): boolean {
  return /\belden\s+ring\b/i.test(`${params.game ?? ""} ${params.prompt}`);
}

function buildGuideFallbackSteps(params: GamingPipelineInput): string[] {
  if (hasEldenRingContext(params)) {
    if (/\b(after\s+leaving\s+the\s+tutorial|where\s+do\s+i\s+go\s+first|go\s+first)\b/i.test(params.prompt)) {
      return [
        "Rest at The First Step Site of Grace, then head to the Church of Elleh for the merchant and crafting kit.",
        "Follow the guidance trail toward Gatefront Ruins, grab the map fragment, and rest at a grace to unlock Torrent.",
        "Avoid fighting the Tree Sentinel early; clear nearby caves, ruins, and soldier camps for runes and upgrade materials.",
        "Level Vigor early, upgrade one weapon you like, then try Margit and Stormveil only after Limgrave feels manageable."
      ];
    }

    return [
      "Start in Limgrave, unlock Sites of Grace, the Church of Elleh, Gatefront Ruins, the map fragment, and Torrent.",
      "Prioritize survivability first: level Vigor, keep equipment load medium or lighter, and upgrade one main weapon.",
      "Explore caves, ruins, and Weeping Peninsula before forcing Stormveil; skip enemies that are clearly overtuned.",
      "Use spirit ashes, guard counters, jumping attacks, and status tools when bosses punish repeated light-attack trades."
    ];
  }

  return [
    "Confirm the next objective, nearest checkpoint, and any missing game/version details before committing rare resources.",
    "Upgrade or repair core gear, stock healing and utility items, and retry the next encounter while watching repeatable mechanics.",
    "If progress stalls, narrow the request to the exact boss, quest, route, build, or checkpoint for a more precise guide.",
    "Treat patch-sensitive numbers as provisional until verified in game or against a provided guide URL."
  ];
}

function buildBuildFallbackSteps(params: GamingPipelineInput): string[] {
  return [
    `For ${params.game ?? "the requested game"}, start from the role the build must perform and choose one reliable damage or utility loop.`,
    "Prioritize core scaling stats, survivability, and resource sustain before niche optimization.",
    "Test changes in safe content before spending rare materials, ranked attempts, or irreversible respec resources."
  ];
}

function buildMetaFallbackSteps(params: GamingPipelineInput): string[] {
  return [
    `For ${params.game ?? "the requested game"}, treat current-state advice as patch-sensitive until verified against the latest in-game version.`,
    "Prefer flexible picks, builds, routes, or team comps that stay useful when a matchup or balance assumption is wrong.",
    "Avoid overcommitting to exact tier claims without a supplied patch, date, or guide source."
  ];
}

function sourceAvailabilityLine(sources: GamingWebSource[]): string {
  if (sources.length === 0) {
    return "Sources unavailable: no guide URL content was available for this request.";
  }

  const usableSourceCount = sources.filter((source) => Boolean(source.snippet)).length;
  if (usableSourceCount === 0) {
    return "Sources unavailable: provided guide sources could not be retrieved before the fallback.";
  }

  if (usableSourceCount < sources.length) {
    return `Sources partially available: ${usableSourceCount} of ${sources.length} provided guide sources were usable.`;
  }

  return `Sources available: ${usableSourceCount} provided guide source${usableSourceCount === 1 ? " was" : "s were"} retrieved.`;
}

function buildGamingProviderFallbackResponse(params: {
  input: GamingPipelineInput;
  sources: GamingWebSource[];
  fallbackReason: string;
  timeoutPhase?: string;
}): string {
  const steps =
    params.input.mode === "build"
      ? buildBuildFallbackSteps(params.input)
      : params.input.mode === "meta"
      ? buildMetaFallbackSteps(params.input)
      : buildGuideFallbackSteps(params.input);
  const sectionLabel = params.input.mode === "build" ? "Build" : "Steps";
  const providerIncomplete = params.fallbackReason === PROVIDER_COMPLETION_INCOMPLETE_FALLBACK_REASON;
  const phaseLine = providerIncomplete
    ? "Provider output: incomplete."
    : params.timeoutPhase
      ? `Timeout phase: ${params.timeoutPhase}.`
      : "Timeout phase: unknown.";
  const fallbackSummary = providerIncomplete
    ? `${sourceAvailabilityLine(params.sources)} The upstream provider returned an incomplete answer, so this is a bounded deterministic fallback.`
    : `${sourceAvailabilityLine(params.sources)} The full generation path hit ${params.fallbackReason}, so this is a bounded deterministic fallback.`;
  const supportLine = providerIncomplete
    ? "Backend-supported: partial. ARCANOS Gaming returned stable gameplay guidance instead of exposing incomplete upstream output."
    : "Backend-supported: partial. ARCANOS Gaming returned stable gameplay guidance instead of waiting for the timed-out upstream stage.";

  return [
    "Quick Answer",
    fallbackSummary,
    "",
    sectionLabel,
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    "Why It Works",
    supportLine,
    `Fallback reason: ${params.fallbackReason}. ${phaseLine}`,
    "",
    "Watch Outs",
    "- Ask again with a narrower boss, quest, route, build, patch, or guide URL for a more specific answer.",
    "- Verify patch-sensitive numbers and current meta details in game or with a provided source."
  ].join("\n");
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
  const requestContext = getRequestAbortContext();
  const requestId = requestContext?.requestId;
  const traceId = requestId;
  const guideSourceCount = (params.guideUrl ? 1 : 0) + params.guideUrls.length;
  const baseLogContext: GamingLogContext = {
    module: "ARCANOS:GAMING",
    route: "gaming",
    mode: params.mode,
    sourceEndpoint,
    ...(requestId ? { requestId } : {}),
    ...(traceId ? { traceId } : {}),
    promptLength: params.prompt.length,
    gameProvided: Boolean(params.game),
    guideSourceCount
  };

  logger.info("gaming.request.start", baseLogContext);

  const shortcutStartedAt = Date.now();
  const exactLiteralShortcut = tryExtractExactLiteralPromptShortcut(params.prompt);
  logGamingIntakeStep(baseLogContext, "shortcut", shortcutStartedAt, {
    ok: Boolean(exactLiteralShortcut)
  });
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
  const retrievalStartedAt = Date.now();
  let webContext = "";
  let sources: GamingWebSource[] = [];
  try {
    const webContextResult = await buildGamingWebContext(guideUrls, baseLogContext);
    webContext = webContextResult.context;
    sources = webContextResult.sources;
    logGamingIntakeStep(baseLogContext, "retrieval", retrievalStartedAt, {
      ok: true,
      retrievalLatencyMs: Date.now() - retrievalStartedAt,
      sourceCount: sources.length,
      usableSourceCount: sources.filter((source) => Boolean(source.snippet)).length,
      failedSourceCount: sources.filter((source) => Boolean(source.error)).length
    });
  } catch (error) {
    const errorCode = readErrorString(error, "code");
    const timeoutPhase = readTimeoutPhase(error) ?? (errorCode === "INTAKE_RETRIEVAL_TIMEOUT" ? "retrieval" : undefined);
    const fallbackReason = errorCode ?? (timeoutPhase ? classifyGamingProviderFallbackReason(timeoutPhase) : "INTAKE_RETRIEVAL_FAILED");
    logger.warn("gaming.retrieval.failure", {
      ...baseLogContext,
      elapsedMs: Date.now() - retrievalStartedAt,
      ...(timeoutPhase ? { timeoutPhase } : {}),
      fallbackReason,
      errorName: error instanceof Error ? error.name : typeof error,
      ...(errorCode ? { errorCode } : {})
    });
    logGamingIntakeStep(baseLogContext, "retrieval", retrievalStartedAt, {
      ok: false,
      ...(timeoutPhase ? { timeoutPhase } : {}),
      retrievalLatencyMs: Date.now() - retrievalStartedAt,
      fallbackReason
    });
  }

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
      elapsedMs,
      upstreamModelLatencyMs: elapsedMs
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
      const fallbackReason = classifyGamingProviderFallbackReason(timeoutPhase);
      logger.warn("gaming.provider.timeout", {
        ...baseLogContext,
        provider: "trinity",
        timeoutMs: pipelineTimeoutMs,
        stageTimeoutMs,
        elapsedMs,
        upstreamModelLatencyMs: elapsedMs,
        timeoutPhase,
        fallbackReason,
        errorName: error instanceof Error ? error.name : typeof error,
        errorCode: readErrorString(error, "code")
      });
      logGamingIntakeStep(baseLogContext, "provider", providerStartedAt, {
        ok: false,
        provider: "trinity",
        timeoutMs: pipelineTimeoutMs,
        stageTimeoutMs,
        timeoutPhase,
        upstreamModelLatencyMs: elapsedMs,
        fallbackReason
      });
      logger.warn("gaming.fallback.used", {
        ...baseLogContext,
        provider: "trinity",
        fallbackReason,
        timeoutPhase,
        elapsedMs,
        timeoutMs: pipelineTimeoutMs,
        stageTimeoutMs
      });
      return formatGameplaySuccessWithLogs({
        mode: params.mode,
        response: buildGamingProviderFallbackResponse({
          input: params,
          sources,
          fallbackReason,
          timeoutPhase
        }),
        sources,
        logContext: baseLogContext,
        requestStartedAt
      });
    }

    if (isGamingProviderCompletionIncompleteError(error)) {
      const fallbackReason = PROVIDER_COMPLETION_INCOMPLETE_FALLBACK_REASON;
      const errorCode = readErrorString(error, "code");
      logger.warn("gaming.provider.incomplete", {
        ...baseLogContext,
        ...(params.game ? { game: params.game } : {}),
        provider: "trinity",
        elapsedMs,
        upstreamModelLatencyMs: elapsedMs,
        errorCode,
        finishReason: readErrorString(error, "finishReason"),
        incompleteReason: readErrorString(error, "incompleteReason"),
        fallbackReason
      });
      logGamingIntakeStep(baseLogContext, "provider", providerStartedAt, {
        ok: false,
        provider: "trinity",
        upstreamModelLatencyMs: elapsedMs,
        errorCode,
        fallbackReason
      });
      logger.warn("gaming.fallback.used", {
        ...baseLogContext,
        ...(params.game ? { game: params.game } : {}),
        provider: "trinity",
        fallbackReason,
        elapsedMs,
        errorCode
      });
      return formatGameplaySuccessWithLogs({
        mode: params.mode,
        response: buildGamingProviderFallbackResponse({
          input: params,
          sources,
          fallbackReason
        }),
        sources,
        logContext: baseLogContext,
        requestStartedAt
      });
    }

    logGamingIntakeStep(baseLogContext, "provider", providerStartedAt, {
      ok: false,
      provider: "trinity",
      timeoutPhase: readTimeoutPhase(error) ?? "provider",
      upstreamModelLatencyMs: elapsedMs,
      errorCode: readErrorString(error, "code")
    });
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
    elapsedMs: Date.now() - providerStartedAt,
    upstreamModelLatencyMs: Date.now() - providerStartedAt
  });
  logger.info("gaming.provider.end", {
    ...baseLogContext,
    provider: "trinity",
    elapsedMs: Date.now() - providerStartedAt,
    upstreamModelLatencyMs: Date.now() - providerStartedAt,
    activeModel: trinityResult.activeModel,
    finishReason: trinityResult.meta?.provider?.finishReason ?? "unknown"
  });
  logGamingIntakeStep(baseLogContext, "provider", providerStartedAt, {
    ok: true,
    provider: "trinity",
    upstreamModelLatencyMs: Date.now() - providerStartedAt,
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
