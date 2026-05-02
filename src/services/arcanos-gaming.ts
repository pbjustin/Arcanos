import { runBuildPipeline, runGuidePipeline, runMetaPipeline } from "@services/gaming.js";
import { getGamingModuleTimeoutMs } from "@services/gamingConfig.js";
import { evaluateWithHRC } from "./hrcWrapper.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import { getRequestAbortSignal, isAbortError } from "@arcanos/runtime";
import {
  formatGamingError,
  type GamingErrorEnvelope,
  type GamingMode,
  type GamingSuccessEnvelope,
  validateGamingRequest
} from "@services/gamingModes.js";

type GamingEnvelope = GamingSuccessEnvelope | GamingErrorEnvelope;

function readSafeErrorString(error: unknown, key: string): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readSafeErrorBoolean(error: unknown, key: string): boolean | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
}

function readSafeErrorNumber(error: unknown, key: string): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatGenerationTimeout(mode: GamingMode, error: unknown): GamingErrorEnvelope {
  return formatGamingError({
    mode,
    error: {
      code: "GENERATION_TIMEOUT",
      message: "Gaming generation timed out before a complete answer was available.",
      details: {
        timeoutMs: readSafeErrorNumber(error, "timeoutMs"),
        stageTimeoutMs: readSafeErrorNumber(error, "stageTimeoutMs"),
        timeoutPhase: readSafeErrorString(error, "timeoutPhase")
      }
    }
  });
}

function formatKnownGenerationFailure(mode: GamingMode, error: unknown): GamingErrorEnvelope | null {
  const code = readSafeErrorString(error, "code");
  const requestAborted = getRequestAbortSignal()?.aborted === true;
  if (code === "GAMING_PROVIDER_TIMEOUT" && !requestAborted) {
    return formatGenerationTimeout(mode, error);
  }

  if (isAbortError(error) && !requestAborted) {
    return formatGenerationTimeout(mode, error);
  }

  if (code !== "OPENAI_COMPLETION_INCOMPLETE" && code !== "TRINITY_OUTPUT_INTEGRITY_FAILED") {
    return null;
  }

  return formatGamingError({
    mode,
    error: {
      code: code === "OPENAI_COMPLETION_INCOMPLETE" ? "GENERATION_INCOMPLETE" : "GENERATION_INTEGRITY_FAILED",
      message: "Gaming generation did not complete cleanly; no partial answer was returned.",
      details: {
        finishReason: readSafeErrorString(error, "finishReason"),
        incompleteReason: readSafeErrorString(error, "incompleteReason"),
        truncated: readSafeErrorBoolean(error, "truncated"),
        lengthTruncated: readSafeErrorBoolean(error, "lengthTruncated"),
        contentFiltered: readSafeErrorBoolean(error, "contentFiltered"),
        integrityIssues: Array.isArray((error as { integrityIssues?: unknown }).integrityIssues)
          ? (error as { integrityIssues: unknown[] }).integrityIssues.filter((issue): issue is string => typeof issue === "string")
          : undefined
      }
    }
  });
}

async function handleGamingRequest(payload: unknown): Promise<GamingEnvelope> {
  const validation = validateGamingRequest(payload);
  if (!validation.ok) {
    return validation.error;
  }

  const { mode, prompt, game, guideUrl, guideUrls, auditEnabled, hrcEnabled } = validation.value;

  let response: GamingSuccessEnvelope;
  try {
    response =
      mode === "guide"
        ? await runGuidePipeline({ prompt, game, guideUrl, guideUrls, auditEnabled })
        : mode === "build"
        ? await runBuildPipeline({ prompt, game, guideUrl, guideUrls, auditEnabled })
        : await runMetaPipeline({ prompt, game, guideUrl, guideUrls, auditEnabled });
  } catch (error: unknown) {
    const knownGenerationFailure = formatKnownGenerationFailure(mode, error);
    if (knownGenerationFailure) {
      return knownGenerationFailure;
    }
    throw error;
  }

  if (!hrcEnabled) {
    return response;
  }

  try {
    const hrc = await evaluateWithHRC(response.data.response);
    return {
      ...response,
      data: {
        ...response.data,
        hrc
      }
    };
  } catch (error: unknown) {
    return formatGamingError({
      mode,
      error: {
        code: "MODULE_ERROR",
        message: `HRC evaluation failed: ${resolveErrorMessage(error)}`
      }
    });
  }
}

export const ArcanosGaming = {
  name: "ARCANOS:GAMING",
  description: "Deterministic gameplay guide, build, and meta advisor.",
  gptIds: ["arcanos-gaming", "gaming"],
  defaultAction: "query",
  defaultTimeoutMs: getGamingModuleTimeoutMs(),
  actions: {
    async query(payload: unknown) {
      return handleGamingRequest(payload);
    },
  },
};

export default ArcanosGaming;
