import { getPrompt } from "@platform/runtime/prompts.js";
import { runTrinityWritingPipeline } from '@core/logic/trinityWritingPipeline.js';
import { generateMockResponse } from "./openai.js";
import { fetchAndClean } from "@shared/webFetcher.js";
import { getOpenAIClientOrAdapter } from "./openai/clientBridge.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import { buildDirectAnswerModeSystemInstruction } from "@services/directAnswerMode.js";
import { tryExtractExactLiteralPromptShortcut } from "@services/exactLiteralPromptShortcut.js";
import { formatGamingSuccess, type GamingMode, type GamingSuccessEnvelope, type ValidatedGamingRequest } from "@services/gamingModes.js";
import { logger } from "@platform/logging/structuredLogging.js";
import { createRuntimeBudgetWithLimit } from '@platform/resilience/runtimeBudget.js';
import {
  getRequestAbortContext,
  getRequestAbortSignal,
  getRequestRemainingMs,
  isAbortError,
  runWithRequestAbortTimeout
} from "@arcanos/runtime";

type WebSource = GamingSuccessEnvelope["data"]["sources"][number];

type GameplayPipelineInput = Pick<
  ValidatedGamingRequest,
  "mode" | "prompt" | "game" | "guideUrl" | "guideUrls" | "auditEnabled"
>;

const DEFAULT_GAMING_PIPELINE_TIMEOUT_MS = 35_000;
const DEFAULT_GAMING_GUIDE_PIPELINE_TIMEOUT_MS = 50_000;
const DEFAULT_GAMING_STAGE_TIMEOUT_MS = 12_000;
const DEFAULT_GAMING_GUIDE_STAGE_TIMEOUT_MS = 15_000;
const GAMING_REQUEST_TIMEOUT_HEADROOM_MS = 1_000;
const GAMING_RUNTIME_BUDGET_SAFETY_BUFFER_MS = 500;

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

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function clampToRequestRemaining(timeoutMs: number, headroomMs = 0): number {
  const remainingRequestMs = getRequestRemainingMs();
  if (remainingRequestMs === null) {
    return timeoutMs;
  }

  return Math.max(1, Math.min(timeoutMs, remainingRequestMs - headroomMs));
}

function resolveGamingPipelineTimeoutMs(mode: GamingMode): number {
  const fallback =
    mode === "guide" ? DEFAULT_GAMING_GUIDE_PIPELINE_TIMEOUT_MS : DEFAULT_GAMING_PIPELINE_TIMEOUT_MS;
  const genericTimeoutMs = readPositiveIntegerEnv("ARCANOS_GAMING_PIPELINE_TIMEOUT_MS", fallback);
  const modeTimeoutMs = readPositiveIntegerEnv(
    `ARCANOS_GAMING_${mode.toUpperCase()}_PIPELINE_TIMEOUT_MS`,
    genericTimeoutMs
  );

  return clampToRequestRemaining(modeTimeoutMs, GAMING_REQUEST_TIMEOUT_HEADROOM_MS);
}

function resolveGamingStageTimeoutMs(mode: GamingMode, pipelineTimeoutMs: number): number {
  const fallback =
    mode === "guide" ? DEFAULT_GAMING_GUIDE_STAGE_TIMEOUT_MS : DEFAULT_GAMING_STAGE_TIMEOUT_MS;
  const genericTimeoutMs = readPositiveIntegerEnv("ARCANOS_GAMING_STAGE_TIMEOUT_MS", fallback);
  const modeTimeoutMs = readPositiveIntegerEnv(
    `ARCANOS_GAMING_${mode.toUpperCase()}_STAGE_TIMEOUT_MS`,
    genericTimeoutMs
  );

  return Math.max(1, Math.min(modeTimeoutMs, Math.max(1, pipelineTimeoutMs - GAMING_REQUEST_TIMEOUT_HEADROOM_MS)));
}

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

function createGamingProviderTimeoutError(
  mode: GamingMode,
  error: unknown,
  timeoutMs: number,
  stageTimeoutMs: number
): Error {
  const timeoutError = new Error(`Gaming ${mode} generation timed out before a complete response was available.`);
  Object.assign(timeoutError, {
    code: "GAMING_PROVIDER_TIMEOUT",
    timeoutMs,
    stageTimeoutMs,
    timeoutPhase: readTimeoutPhase(error)
  });
  return timeoutError;
}

function estimateResponseBytes(response: GamingSuccessEnvelope): number | null {
  try {
    return Buffer.byteLength(JSON.stringify(response), "utf8");
  } catch {
    return null;
  }
}

function formatGameplaySuccessWithLogs(params: {
  mode: GamingMode;
  response: string;
  sources: WebSource[];
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

  const serializationStartedAt = Date.now();
  const responseBytes = estimateResponseBytes(envelope);
  logger.info("gaming.response.serialization", {
    ...params.logContext,
    serializationMs: Date.now() - serializationStartedAt,
    responseBytes
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

const gamingPrompts = {
  webUncertaintyGuidance: getPrompt("gaming", "web_uncertainty_guidance"),
  webContextInstruction: getPrompt("gaming", "web_context_instruction"),
  auditSystem: getPrompt("gaming", "audit_system")
};

const modeInstructions: Record<GamingMode, string> = {
  guide: "Return a practical guide with concrete steps, checkpoints, and missing-info notes instead of simulation.",
  build: "Return a build recommendation with priorities, tradeoffs, and setup guidance. Do not invent patch details.",
  meta: "Return a meta overview with current assumptions, tradeoffs, counters, and explicit uncertainty when patch/version context is missing."
};

function rewriteGuideDirectAnswerCues(prompt: string): string {
  return prompt
    .replace(/\b(?:answer|respond|reply)\s+directly\b/gi, 'give practical guidance')
    .replace(/\bjust\s+answer\b/gi, 'focus on the answer')
    .replace(/\b(?:do\s+not|don't)\s+simulate\b/gi, 'avoid gameplay reenactment')
    .replace(/\bno\s+simulation\b/gi, 'avoid gameplay reenactment')
    .replace(/\bwithout\s+simulation\b/gi, 'without gameplay reenactment')
    .replace(/\b(?:do\s+not|don't|no|without)\s+role-?play\b/gi, 'avoid roleplay framing')
    .replace(/\b(?:do\s+not|don't|no|without)\s+pretend\b/gi, 'avoid pretending to play')
    .replace(/\bno\s+hypothetical(?:\s+runs?)?\b/gi, 'avoid hypothetical run narration')
    .replace(/\bhypothetical\s+run\b(?!\s+narration)/gi, 'run narration')
    .trim();
}

async function buildWebContext(urls: string[]): Promise<{ context: string; sources: WebSource[] }> {
  if (urls.length === 0) {
    return { context: "", sources: [] };
  }

  const uniqueUrls = Array.from(new Set(urls));
  const sources: WebSource[] = [];

  for (const url of uniqueUrls) {
    try {
      const snippet = await fetchAndClean(url, 5000);
      sources.push({ url, snippet });
    } catch (error) {
      sources.push({ url, error: resolveErrorMessage(error, "Unknown fetch error") });
    }
  }

  const context = sources
    .filter((source) => Boolean(source.snippet))
    .map((source, index) => `[Source ${index + 1}] ${source.url}\n${source.snippet}`)
    .join("\n\n");

  return { context, sources };
}

function buildGameplaySystemPrompt(mode: GamingMode): string {
  if (mode === "guide") {
    return [
      "You are ARCANOS:GAMING:GUIDE.",
      modeInstructions.guide,
      "Give concrete guidance with enough structure to complete the requested guide.",
      "Avoid gameplay reenactment, roleplay framing, invented live patch details, hotline banter, and theatrical framing.",
      "If the user requests an exact literal response, return only that literal.",
      "State missing game, platform, class, or version details plainly instead of guessing."
    ].join(" ");
  }

  return buildDirectAnswerModeSystemInstruction({
    moduleLabel: `ARCANOS:GAMING:${mode.toUpperCase()}`,
    domainGuidance: modeInstructions[mode],
    prohibitedBehaviors: [
      "simulate gameplay",
      "role-play a match or run",
      "invent live patch notes",
      "add hotline banter or theatrical framing"
    ],
    missingInfoBehavior: "State missing game, platform, class, or version details plainly instead of guessing."
  });
}

function buildGameplayPrompt(params: GameplayPipelineInput, webContext: string, hadSources: boolean): string {
  const modeLabel = `[MODE]\n${params.mode}`;
  const gameLabel = params.game ? `\n\n[GAME]\n${params.game}` : "";
  const requestPrompt = params.mode === "guide" ? rewriteGuideDirectAnswerCues(params.prompt) : params.prompt;
  const webLabel = webContext
    ? `\n\n[WEB CONTEXT]\n${webContext}\n\n${gamingPrompts.webContextInstruction}`
    : hadSources
    ? `\n\n[WEB CONTEXT]\nGuides were provided but no usable snippets were retrieved.\n\n${gamingPrompts.webUncertaintyGuidance}`
    : "";

  return `${modeLabel}${gameLabel}\n\n[REQUEST]\n${requestPrompt}${webLabel}`;
}

function buildGameplayRunOptions(mode: GamingMode) {
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

async function runGameplayPipeline(params: GameplayPipelineInput): Promise<GamingSuccessEnvelope> {
  const requestStartedAt = Date.now();
  const sourceEndpoint = `arcanos-gaming.${params.mode}`;
  const requestId = getRequestAbortContext()?.requestId;
  const initialGuideSourceCount = (params.guideUrl ? 1 : 0) + params.guideUrls.length;
  const baseLogContext: GamingLogContext = {
    module: "ARCANOS:GAMING",
    route: "gaming",
    mode: params.mode,
    sourceEndpoint,
    ...(requestId ? { requestId } : {}),
    promptLength: params.prompt.length,
    gameProvided: Boolean(params.game),
    guideSourceCount: initialGuideSourceCount
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

  const allUrls = [
    ...(params.guideUrl ? [params.guideUrl] : []),
    ...params.guideUrls
  ];
  const { context: webContext, sources } = await buildWebContext(allUrls);
  const enrichedPrompt = buildGameplayPrompt(params, webContext, allUrls.length > 0);
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

  const pipelineTimeoutMs = resolveGamingPipelineTimeoutMs(params.mode);
  const stageTimeoutMs = resolveGamingStageTimeoutMs(params.mode, pipelineTimeoutMs);
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
            prompt: [
              buildGameplaySystemPrompt(params.mode),
              '',
              enrichedPrompt,
              ...(params.auditEnabled ? ['', gamingPrompts.auditSystem] : [])
            ].join('\n'),
            moduleId: 'ARCANOS:GAMING',
            sourceEndpoint,
            requestedAction: 'query',
            body: params,
            executionMode: 'request'
          },
          context: {
            client,
            ...(requestId ? { requestId } : {}),
            runtimeBudget: createRuntimeBudgetWithLimit(
              pipelineTimeoutMs,
              GAMING_RUNTIME_BUDGET_SAFETY_BUFFER_MS
            ),
            runOptions: {
              ...buildGameplayRunOptions(params.mode),
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

    if (isAbortError(error)) {
      logger.warn("gaming.provider.timeout", {
        ...baseLogContext,
        provider: "trinity",
        timeoutMs: pipelineTimeoutMs,
        stageTimeoutMs,
        elapsedMs,
        timeoutPhase: readTimeoutPhase(error) ?? "provider",
        errorName: error instanceof Error ? error.name : typeof error,
        errorCode: readErrorString(error, "code")
      });
      logger.info("gaming.request.end", {
        ...baseLogContext,
        ok: false,
        totalElapsedMs: Date.now() - requestStartedAt,
        errorCode: "GAMING_PROVIDER_TIMEOUT"
      });
      throw createGamingProviderTimeoutError(params.mode, error, pipelineTimeoutMs, stageTimeoutMs);
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
  const finalized = trinityResult.result;

  if (!params.auditEnabled) {
    return formatGameplaySuccessWithLogs({
      mode: params.mode,
      response: finalized,
      sources,
      logContext: baseLogContext,
      requestStartedAt
    });
  }

  return formatGameplaySuccessWithLogs({
    mode: params.mode,
    response: finalized,
    sources,
    logContext: baseLogContext,
    requestStartedAt
  });
}

export async function runGuidePipeline(params: Omit<GameplayPipelineInput, "mode">): Promise<GamingSuccessEnvelope> {
  return runGameplayPipeline({ ...params, mode: "guide" });
}

export async function runBuildPipeline(params: Omit<GameplayPipelineInput, "mode">): Promise<GamingSuccessEnvelope> {
  return runGameplayPipeline({ ...params, mode: "build" });
}

export async function runMetaPipeline(params: Omit<GameplayPipelineInput, "mode">): Promise<GamingSuccessEnvelope> {
  return runGameplayPipeline({ ...params, mode: "meta" });
}
