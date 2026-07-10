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
  buildGamingRagContext,
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
  game?: string;
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

type GamingCitationNormalization = {
  response: string;
  maxInlineSourceRef: number;
  applied: boolean;
};

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
    normalizedPhase === "provider" ||
    normalizedPhase?.includes("direct-answer") === true ||
    normalizedPhase?.includes("direct_answer") === true
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
    ...details,
    timeoutPhase,
    elapsedMs: Date.now() - startedAt
  });
}

function parseCitationNumbers(value: string): number[] {
  return Array.from(value.matchAll(/\d+/g))
    .map((match) => Number.parseInt(match[0], 10))
    .filter((number) => Number.isInteger(number) && number > 0);
}

function formatCitationNumbers(numbers: number[], sourceCount: number, wrapper: "paren" | "bracket"): string {
  const validNumbers = Array.from(new Set(numbers.filter((number) => number <= sourceCount)));
  if (validNumbers.length === 0) {
    return "";
  }

  const label = validNumbers.length === 1 ? "source" : "sources";
  const joined = validNumbers.join(", ");
  if (wrapper === "bracket") {
    return `[${label === "source" ? "Source" : "Sources"} ${joined}]`;
  }

  return `(${label} ${joined})`;
}

export function normalizeGamingInlineSourceReferences(response: string, sourceCount: number): GamingCitationNormalization {
  let maxInlineSourceRef = 0;
  let applied = false;
  const normalizeMatch = (fullMatch: string, rawNumbers: string, wrapper: "paren" | "bracket"): string => {
    const numbers = parseCitationNumbers(rawNumbers);
    for (const number of numbers) {
      maxInlineSourceRef = Math.max(maxInlineSourceRef, number);
    }

    const normalized = formatCitationNumbers(numbers, sourceCount, wrapper);
    if (normalized !== fullMatch) {
      applied = true;
    }
    return normalized;
  };

  const normalized = response
    .replace(/\[(?:sources?)\s+([\d,\s]+)\]/gi, (fullMatch, rawNumbers: string) =>
      normalizeMatch(fullMatch, rawNumbers, "bracket")
    )
    .replace(/\[([\d,\s]+)\]/g, (fullMatch, rawNumbers: string) => {
      const numbers = parseCitationNumbers(rawNumbers);
      for (const number of numbers) {
        maxInlineSourceRef = Math.max(maxInlineSourceRef, number);
      }

      const validNumbers = Array.from(new Set(numbers.filter((number) => number <= sourceCount)));
      const normalizedMatch = validNumbers.length > 0 ? `[${validNumbers.join(", ")}]` : "";
      if (normalizedMatch !== fullMatch) {
        applied = true;
      }
      return normalizedMatch;
    })
    .replace(/\((?:sources?)\s+([\d,\s]+)\)/gi, (fullMatch, rawNumbers: string) =>
      normalizeMatch(fullMatch, rawNumbers, "paren")
    )
    .replace(/\b(?:sources?)\s+(\d+(?:\s*,\s*\d+)*)\b/gi, (
      fullMatch: string,
      rawNumbers: string,
      offset: number,
      fullText: string
    ) => {
      const previousChar = fullText[offset - 1];
      const nextChar = fullText[offset + fullMatch.length];
      if (previousChar === "[" || previousChar === "(" || nextChar === "]" || nextChar === ")") {
        return fullMatch;
      }

      const numbers = parseCitationNumbers(rawNumbers);
      for (const number of numbers) {
        maxInlineSourceRef = Math.max(maxInlineSourceRef, number);
      }

      const normalized = formatCitationNumbers(numbers, sourceCount, "paren");
      if (normalized !== fullMatch) {
        applied = true;
      }
      return normalized;
    })
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  return {
    response: normalized,
    maxInlineSourceRef,
    applied
  };
}

function formatGameplaySuccessWithLogs(params: {
  mode: GamingMode;
  response: string;
  sources: GamingWebSource[];
  logContext: GamingLogContext;
  requestStartedAt: number;
  retrievedSourceCount?: number;
  omittedSourceCount?: number;
  fallbackReason?: string;
}): GamingSuccessEnvelope {
  const postprocessStartedAt = Date.now();
  const citationNormalization = normalizeGamingInlineSourceReferences(params.response, params.sources.length);
  const response = citationNormalization.response;
  logger.info("gaming.postprocess.start", {
    ...params.logContext,
    responseChars: params.response.length,
    sourceCount: params.sources.length,
    retrievedSourceCount: params.retrievedSourceCount ?? params.sources.length,
    publicSourceCount: params.sources.length,
    omittedSourceCount: params.omittedSourceCount ?? 0,
    maxInlineSourceRef: citationNormalization.maxInlineSourceRef,
    citationNormalizationApplied: citationNormalization.applied,
    ...(params.fallbackReason ? { fallbackReason: params.fallbackReason } : {})
  });

  const envelope = formatGamingSuccess({
    mode: params.mode,
    data: {
      response,
      sources: params.sources
    }
  });

  logger.info("gaming.postprocess.end", {
    ...params.logContext,
    postprocessMs: Date.now() - postprocessStartedAt,
    responseChars: response.length,
    sourceCount: params.sources.length,
    retrievedSourceCount: params.retrievedSourceCount ?? params.sources.length,
    publicSourceCount: params.sources.length,
    omittedSourceCount: params.omittedSourceCount ?? 0,
    maxInlineSourceRef: citationNormalization.maxInlineSourceRef,
    citationNormalizationApplied: citationNormalization.applied,
    ...(params.fallbackReason ? { fallbackReason: params.fallbackReason } : {})
  });

  const payloadEstimateStartedAt = Date.now();
  const responsePayloadChars = estimateResponsePayloadChars(response, params.sources);
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
    return "Sources unavailable: no source-backed game data was available for this request.";
  }

  const usableSourceCount = sources.filter((source) => Boolean(source.snippet)).length;
  if (usableSourceCount === 0) {
    return "Sources unavailable: selected game-data sources could not be retrieved before the fallback.";
  }

  if (usableSourceCount < sources.length) {
    return `Sources partially available: ${usableSourceCount} of ${sources.length} selected game-data sources were usable.`;
  }

  return `Sources available: ${usableSourceCount} source-backed game-data snippet${usableSourceCount === 1 ? " was" : "s were"} retrieved.`;
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
    : params.timeoutPhase
      ? "Backend-supported: partial. ARCANOS Gaming returned stable gameplay guidance instead of waiting for the timed-out upstream stage."
      : "Backend-supported: partial. ARCANOS Gaming returned stable gameplay guidance instead of exposing an upstream provider failure.";

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

function buildGamingRunOptions(mode: GamingMode, hasGuideSources: boolean) {
  if (mode === "guide") {
    if (hasGuideSources) {
      return {
        answerMode: "explained" as const,
        requestedVerbosity: "normal" as const,
        strictUserVisibleOutput: true
      };
    }

    return {
      answerMode: "direct" as const,
      requestedVerbosity: "normal" as const,
      strictUserVisibleOutput: true
    };
  }

  if (mode === "build") {
    return {
      answerMode: "direct" as const,
      strictUserVisibleOutput: true
    };
  }

  return {
    answerMode: "explained" as const,
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
    ...(params.game ? { game: params.game } : {}),
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
  let retrievalAttempted = guideUrls.length > 0;
  let retrievalHadUsableSources = false;
  let retrievedSourceCount = 0;
  let publicSourceCount = 0;
  let omittedSourceCount = 0;
  try {
    const webContextResult = await buildGamingRagContext(params, baseLogContext);
    webContext = webContextResult.context;
    sources = webContextResult.sources;
    retrievalAttempted = webContextResult.retrievalEnabled;
    retrievalHadUsableSources = sources.some((source) => Boolean(source.snippet));
    retrievedSourceCount = webContextResult.retrievedSourceCount;
    publicSourceCount = webContextResult.publicSourceCount;
    omittedSourceCount = webContextResult.omittedSourceCount;
    logGamingIntakeStep(baseLogContext, "retrieval", retrievalStartedAt, {
      ok: true,
      retrievalEnabled: webContextResult.retrievalEnabled,
      retrievalReason: webContextResult.retrievalReason,
      retrievalElapsedMs: webContextResult.retrievalElapsedMs,
      retrievalLatencyMs: webContextResult.retrievalElapsedMs,
      rankingElapsedMs: webContextResult.rankingElapsedMs,
      sourceCount: sources.length,
      retrievedSourceCount,
      publicSourceCount,
      omittedSourceCount,
      sourceDomains: webContextResult.sourceDomains,
      cacheHit: webContextResult.cacheHit,
      usableSourceCount: sources.filter((source) => Boolean(source.snippet)).length,
      failedSourceCount: sources.filter((source) => Boolean(source.error)).length,
      clearPassed: webContextResult.clear.passed,
      ...(webContextResult.fallbackReason ? { fallbackReason: webContextResult.fallbackReason } : {})
    });
    if (webContextResult.fallbackReason === "INTAKE_RETRIEVAL_TIMEOUT") {
      logger.warn("gaming.fallback.used", {
        ...baseLogContext,
        retrievalEnabled: webContextResult.retrievalEnabled,
        retrievalReason: webContextResult.retrievalReason,
        sourceCount: sources.length,
        retrievedSourceCount,
        publicSourceCount,
        omittedSourceCount,
        sourceDomains: webContextResult.sourceDomains,
        cacheHit: webContextResult.cacheHit,
        retrievalElapsedMs: webContextResult.retrievalElapsedMs,
        rankingElapsedMs: webContextResult.rankingElapsedMs,
        generationElapsedMs: 0,
        fallbackReason: webContextResult.fallbackReason,
        timeoutPhase: "retrieval"
      });
      return formatGameplaySuccessWithLogs({
        mode: params.mode,
        response: buildGamingProviderFallbackResponse({
          input: params,
          sources,
          fallbackReason: webContextResult.fallbackReason,
          timeoutPhase: "retrieval"
        }),
        sources,
        logContext: baseLogContext,
        requestStartedAt,
        retrievedSourceCount,
        omittedSourceCount,
        fallbackReason: webContextResult.fallbackReason
      });
    }
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
      retrievalEnabled: true,
      retrievalReason: "retrieval_exception",
      retrievalElapsedMs: Date.now() - retrievalStartedAt,
      retrievalLatencyMs: Date.now() - retrievalStartedAt,
      rankingElapsedMs: 0,
      sourceCount: 0,
      sourceDomains: [],
      cacheHit: false,
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
      requestStartedAt,
      retrievedSourceCount,
      omittedSourceCount
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
            prompt: buildGamingTrinityPrompt(params, webContext, retrievalAttempted || retrievalHadUsableSources),
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
              ...buildGamingRunOptions(params.mode, guideUrls.length > 0),
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
      generationElapsedMs: elapsedMs,
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
        generationElapsedMs: elapsedMs,
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
        generationElapsedMs: elapsedMs,
        fallbackReason
      });
      logger.warn("gaming.fallback.used", {
        ...baseLogContext,
        provider: "trinity",
        fallbackReason,
        timeoutPhase,
        elapsedMs,
        generationElapsedMs: elapsedMs,
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
        requestStartedAt,
        retrievedSourceCount,
        omittedSourceCount,
        fallbackReason
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
        generationElapsedMs: elapsedMs,
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
        generationElapsedMs: elapsedMs,
        errorCode,
        fallbackReason
      });
      logger.warn("gaming.fallback.used", {
        ...baseLogContext,
        ...(params.game ? { game: params.game } : {}),
        provider: "trinity",
        fallbackReason,
        elapsedMs,
        generationElapsedMs: elapsedMs,
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
        requestStartedAt,
        retrievedSourceCount,
        omittedSourceCount,
        fallbackReason
      });
    }

    logGamingIntakeStep(baseLogContext, "provider", providerStartedAt, {
      ok: false,
      provider: "trinity",
      timeoutPhase: readTimeoutPhase(error) ?? "provider",
      upstreamModelLatencyMs: elapsedMs,
      generationElapsedMs: elapsedMs,
      errorCode: readErrorString(error, "code")
    });
    logger.error("gaming.provider.error", {
      ...baseLogContext,
      provider: "trinity",
      elapsedMs,
      generationElapsedMs: elapsedMs,
      errorName: error instanceof Error ? error.name : typeof error,
      errorCode: readErrorString(error, "code")
    });
    const fallbackReason = readErrorString(error, "code") || "GAMING_PROVIDER_ERROR";
    logger.warn("gaming.fallback.used", {
      ...baseLogContext,
      provider: "trinity",
      fallbackReason,
      elapsedMs,
      generationElapsedMs: elapsedMs,
      errorCode: readErrorString(error, "code")
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
      requestStartedAt,
      retrievedSourceCount,
      omittedSourceCount,
      fallbackReason
    });
  }

  logger.info("gaming.stream.end", {
    ...baseLogContext,
    provider: "trinity",
    streaming: false,
    ok: true,
    elapsedMs: Date.now() - providerStartedAt,
    generationElapsedMs: Date.now() - providerStartedAt,
    upstreamModelLatencyMs: Date.now() - providerStartedAt
  });
  logger.info("gaming.provider.end", {
    ...baseLogContext,
    provider: "trinity",
    elapsedMs: Date.now() - providerStartedAt,
    generationElapsedMs: Date.now() - providerStartedAt,
    upstreamModelLatencyMs: Date.now() - providerStartedAt,
    activeModel: trinityResult.activeModel,
    finishReason: trinityResult.meta?.provider?.finishReason ?? "unknown"
  });
  logGamingIntakeStep(baseLogContext, "provider", providerStartedAt, {
    ok: true,
    provider: "trinity",
    upstreamModelLatencyMs: Date.now() - providerStartedAt,
    generationElapsedMs: Date.now() - providerStartedAt,
    activeModel: trinityResult.activeModel,
    finishReason: trinityResult.meta?.provider?.finishReason ?? "unknown"
  });

  return formatGameplaySuccessWithLogs({
    mode: params.mode,
    response: trinityResult.result,
    sources,
    logContext: baseLogContext,
    requestStartedAt,
    retrievedSourceCount,
    omittedSourceCount
  });
}
