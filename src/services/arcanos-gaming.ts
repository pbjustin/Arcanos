import { runBuildPipeline, runGuidePipeline, runMetaPipeline } from "@services/gaming.js";
import { getGamingModuleTimeoutMs } from "@services/gamingConfig.js";
import { evaluateWithHRC } from "./hrcWrapper.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import { getRequestAbortContext, getRequestAbortSignal, isAbortError } from "@arcanos/runtime";
import { logger } from "@platform/logging/structuredLogging.js";
import {
  BackendQueryAgent,
  ClarificationAgent,
  IntentRouterAgent,
  ResponseComposerAgent,
  type GamingBackendActionPayload,
  type GamingIntent
} from "@services/gamingAgents.js";
import {
  formatGamingError,
  type GamingErrorEnvelope,
  type GamingMode,
  type GamingSuccessEnvelope,
  validateGamingRequest
} from "@services/gamingModes.js";

type GamingEnvelope = GamingSuccessEnvelope | GamingErrorEnvelope;
type GamingRequestLogContext = {
  module: "ARCANOS:GAMING";
  route: "gaming";
  requestId?: string;
  traceId?: string;
};

function buildGamingRequestLogContext(): GamingRequestLogContext {
  const requestId = getRequestAbortContext()?.requestId;
  return {
    module: "ARCANOS:GAMING",
    route: "gaming",
    ...(requestId ? { requestId, traceId: requestId } : {})
  };
}

function logGamingIntakeStep(
  logContext: GamingRequestLogContext,
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

function describeGamingErrorEnvelope(error: GamingErrorEnvelope["error"]): string {
  const detailParts: string[] = [];
  if (error.details && typeof error.details === "object") {
    const details = error.details as Record<string, unknown>;
    const timeoutPhase = typeof details.timeoutPhase === "string" ? details.timeoutPhase : undefined;
    const timeoutMs = typeof details.timeoutMs === "number" ? details.timeoutMs : undefined;
    const stageTimeoutMs = typeof details.stageTimeoutMs === "number" ? details.stageTimeoutMs : undefined;
    if (timeoutPhase) {
      detailParts.push(`phase=${timeoutPhase}`);
    }
    if (timeoutMs) {
      detailParts.push(`timeoutMs=${timeoutMs}`);
    }
    if (stageTimeoutMs) {
      detailParts.push(`stageTimeoutMs=${stageTimeoutMs}`);
    }
  }

  return `${error.code}: ${error.message}${detailParts.length > 0 ? ` (${detailParts.join(", ")})` : ""}`;
}

async function executeGamingBackendQuery(payload: GamingBackendActionPayload): Promise<GamingEnvelope> {
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

function formatSecurityBlocked(intent: GamingIntent): GamingErrorEnvelope {
  return formatGamingError({
    mode: intent.mode === "guide" || intent.mode === "build" || intent.mode === "meta" ? intent.mode : null,
    error: {
      code: intent.securityBlocked?.code ?? "SECURITY_BLOCKED",
      message: intent.securityBlocked?.message ?? "ARCANOS Gaming only handles writing-plane gameplay guidance.",
      details: {
        reason: intent.securityBlocked?.reason ?? "security_blocked"
      }
    }
  });
}

function formatInvalidMode(): GamingErrorEnvelope {
  return formatGamingError({
    mode: null,
    error: {
      code: "GAMEPLAY_MODE_REQUIRED",
      message: "Gameplay requests require explicit mode 'guide', 'build', or 'meta'."
    }
  });
}

function formatNonGamingRequest(): GamingErrorEnvelope {
  return formatGamingError({
    mode: null,
    error: {
      code: "NON_GAMING_REQUEST",
      message: "ARCANOS Gaming handles gameplay guide, build, and meta requests."
    }
  });
}

function formatClarification(clarification: Extract<ReturnType<typeof ClarificationAgent.evaluate>, { required: true }>): GamingErrorEnvelope {
  return formatGamingError({
    mode: clarification.mode,
    error: {
      code: "CLARIFICATION_REQUIRED",
      message: clarification.question,
      details: {
        missing: clarification.missing
      }
    }
  });
}

function isGamingMode(value: GamingIntent["mode"]): value is GamingMode {
  return value === "guide" || value === "build" || value === "meta";
}

function isUsableGamingSuccessEnvelope(value: GamingEnvelope): value is GamingSuccessEnvelope {
  return value.ok === true &&
    value.data !== null &&
    typeof value.data === "object" &&
    typeof value.data.response === "string";
}

function buildTelemetryEntityFlags(intent: GamingIntent) {
  return {
    game: Boolean(intent.game),
    platform: Boolean(intent.platform),
    version: Boolean(intent.version),
    class: Boolean(intent.class),
    role: Boolean(intent.role),
    difficulty: Boolean(intent.difficulty),
    progressPoint: Boolean(intent.progressPoint),
    spoilerTolerance: intent.spoilerTolerance
  };
}

async function handleGamingRequest(payload: unknown): Promise<GamingEnvelope> {
  const requestLogContext = buildGamingRequestLogContext();
  const classifyStartedAt = Date.now();
  const intent = IntentRouterAgent.classify(payload);
  logger.info("gaming.routing.intent", {
    ...requestLogContext,
    mode: intent.mode,
    confidence: intent.confidence,
    signals: intent.routingSignals,
    entityFlags: buildTelemetryEntityFlags(intent),
    securityBlocked: Boolean(intent.securityBlocked),
    timeoutPhase: null,
    elapsedMs: Date.now() - classifyStartedAt
  });
  logGamingIntakeStep(requestLogContext, "classify", classifyStartedAt, {
    mode: intent.mode,
    confidence: intent.confidence,
    gameProvided: Boolean(intent.game),
    signalCount: intent.routingSignals.length,
    securityBlocked: Boolean(intent.securityBlocked)
  });

  if (intent.securityBlocked) {
    logger.warn("gaming.routing.security_blocked", {
      ...requestLogContext,
      mode: intent.mode,
      confidence: intent.confidence,
      reason: intent.securityBlocked.reason
    });
    return formatSecurityBlocked(intent);
  }

  if (intent.invalidMode) {
    return formatInvalidMode();
  }

  if (intent.mode === "non-gaming") {
    return formatNonGamingRequest();
  }

  const clarification = ClarificationAgent.evaluate(intent);
  if (clarification.required) {
    logger.info("gaming.routing.clarification", {
      ...requestLogContext,
      mode: clarification.mode,
      confidence: intent.confidence,
      missing: clarification.missing
    });
    return formatClarification(clarification);
  }

  if (!isGamingMode(intent.mode)) {
    return formatNonGamingRequest();
  }

  const gamingIntent: GamingIntent & { mode: GamingMode } = {
    ...intent,
    mode: intent.mode
  };
  const backendBuildStartedAt = Date.now();
  const backendAction = BackendQueryAgent.build(gamingIntent);
  logGamingIntakeStep(requestLogContext, "backend-build", backendBuildStartedAt, {
    mode: gamingIntent.mode,
    action: backendAction.action,
    gameProvided: Boolean(backendAction.payload.game),
    guideSourceCount: (backendAction.payload.url ? 1 : 0) + (backendAction.payload.guideUrls?.length ?? 0) + (backendAction.payload.urls?.length ?? 0)
  });
  const backendCallStartedAt = Date.now();
  try {
    const backendEnvelope = await BackendQueryAgent.call(backendAction, executeGamingBackendQuery);
    logGamingIntakeStep(requestLogContext, "backend-call", backendCallStartedAt, {
      mode: gamingIntent.mode,
      ok: backendEnvelope.ok,
      ...(backendEnvelope.ok ? { sourceCount: backendEnvelope.data.sources.length } : { errorCode: backendEnvelope.error.code })
    });
    if (!backendEnvelope.ok) {
      logger.warn("gaming.backend.failure", {
        ...requestLogContext,
        mode: gamingIntent.mode,
        confidence: gamingIntent.confidence,
        errorCode: backendEnvelope.error.code
      });
      if (backendEnvelope.error.code === "GENERATION_TIMEOUT") {
        return ResponseComposerAgent.composeBackendFailureFallback({
          intent: gamingIntent,
          error: new Error(describeGamingErrorEnvelope(backendEnvelope.error))
        });
      }
      return backendEnvelope;
    }

    if (!isUsableGamingSuccessEnvelope(backendEnvelope)) {
      logger.warn("gaming.backend.failure", {
        ...requestLogContext,
        mode: gamingIntent.mode,
        confidence: gamingIntent.confidence,
        errorCode: "MALFORMED_BACKEND_RESPONSE"
      });
      return ResponseComposerAgent.composeBackendFailureFallback({
        intent: gamingIntent,
        error: new Error("Malformed backend response")
      });
    }

    logger.info("gaming.backend.success", {
      ...requestLogContext,
      mode: gamingIntent.mode,
      confidence: gamingIntent.confidence,
      sourceCount: backendEnvelope.data.sources.length
    });

    return ResponseComposerAgent.compose({
      intent: gamingIntent,
      backendEnvelope
    });
  } catch (error: unknown) {
    if (getRequestAbortSignal()?.aborted || isAbortError(error)) {
      throw error;
    }

    logGamingIntakeStep(requestLogContext, "backend-call", backendCallStartedAt, {
      mode: gamingIntent.mode,
      ok: false,
      errorCode: "BACKEND_EXCEPTION"
    });
    logger.warn("gaming.backend.failure", {
      ...requestLogContext,
      mode: gamingIntent.mode,
      confidence: gamingIntent.confidence,
      errorCode: "BACKEND_EXCEPTION"
    });
    return ResponseComposerAgent.composeBackendFailureFallback({
      intent: gamingIntent,
      error
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
