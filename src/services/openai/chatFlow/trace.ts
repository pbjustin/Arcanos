import { logOpenAIEvent, logOpenAISuccess } from "@platform/logging/openaiLogger.js";
import { recordTraceEvent } from "@platform/logging/telemetry.js";
import { OPENAI_LOG_MESSAGES } from "@platform/runtime/openaiLogMessages.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";

export function traceOpenAIMock(model: string, route?: unknown, reason: string = "client_unavailable") {
  recordTraceEvent("openai.call.mock", { model, route, reason });
}

export function traceOpenAICacheHit(cacheKey: string) {
  logOpenAIEvent("info", OPENAI_LOG_MESSAGES.CACHE.HIT, { cacheKey });
}

export function traceOpenAIStart(model: string, tokenLimit: number, cacheEnabled: boolean) {
  recordTraceEvent("openai.call.start", { model, tokenLimit, cacheEnabled });
}

export function traceOpenAISuccess(model: string, cached: boolean | undefined) {
  recordTraceEvent("openai.call.success", { model, cached, cacheHit: cached === true });
}

export function traceOpenAIError(model: string, error: unknown) {
  recordTraceEvent("openai.call.error", { model, error: resolveErrorMessage(error, "unknown") });
}

export function logRequestAttempt(model: string, attempt: number, total: number) {
  logOpenAIEvent("info", OPENAI_LOG_MESSAGES.REQUEST.ATTEMPT(attempt, total, model));
}

export function logRequestSuccess(activeModel: string, attempt: number, totalTokens: unknown) {
  logOpenAISuccess(OPENAI_LOG_MESSAGES.REQUEST.SUCCESS, { attempt, model: activeModel, totalTokens: totalTokens ?? "unknown" });
}

export function logRequestPermanentFailure(model: string, attempt: number, errorType: string, errorMessage: string, error?: Error) {
  logOpenAIEvent("error", OPENAI_LOG_MESSAGES.REQUEST.FAILED_PERMANENT(attempt), { model, errorType, errorMessage }, error);
}
