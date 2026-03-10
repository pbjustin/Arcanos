import OpenAI from 'openai';

import { DEFAULT_MODEL } from '../config/openai.js';
import { runResponse } from '../lib/runResponse.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { logger } from '@platform/logging/structuredLogging.js';
import { getFallbackModel } from '@services/openai.js';

type TrinityOptions = {
  prompt: string;
  model?: string;
  temperature?: number;
  structured?: boolean;
  latencyBudgetMs?: number;
};

class ModelLatencyBudgetExceededError extends Error {
  readonly model: string;
  readonly latencyBudgetMs: number;

  constructor(model: string, latencyBudgetMs: number) {
    super(`Model '${model}' exceeded the per-attempt latency budget of ${latencyBudgetMs}ms.`);
    this.name = 'ModelLatencyBudgetExceededError';
    this.model = model;
    this.latencyBudgetMs = latencyBudgetMs;
  }
}

function extractOutputText(response: OpenAI.Responses.Response): string | null {
  const message = response.output.find(
    (item): item is OpenAI.Responses.ResponseOutputMessage => item.type === 'message'
  );

  const outputText = message?.content.find(
    (part): part is OpenAI.Responses.ResponseOutputText => part.type === 'output_text'
  );

  return outputText?.text ?? null;
}

function buildStructuredPrompt(prompt: string): string {
  return `${prompt}\n\nReturn a valid JSON object. The word json is intentionally present for JSON response mode.`;
}

function buildResponseInput(prompt: string, structured: boolean): OpenAI.Responses.ResponseInput {
  return [
    {
      role: 'user',
      content: structured ? buildStructuredPrompt(prompt) : prompt
    }
  ];
}

function normalizeLatencyBudgetMs(latencyBudgetMs: number | undefined): number | null {
  //audit Assumption: route-supplied latency budgets must be positive finite integers; failure risk: invalid values disable timeout enforcement or cause immediate aborts; expected invariant: model attempts either run unbounded or with a sane millisecond ceiling; handling strategy: sanitize invalid inputs to `null` and floor valid values.
  if (typeof latencyBudgetMs !== 'number' || !Number.isFinite(latencyBudgetMs) || latencyBudgetMs <= 0) {
    return null;
  }

  return Math.floor(latencyBudgetMs);
}

function isModelLatencyBudgetExceededError(error: unknown): error is ModelLatencyBudgetExceededError {
  return error instanceof ModelLatencyBudgetExceededError;
}

function startLatencyBudgetAbortTimer(
  model: string,
  latencyBudgetMs: number
): {
  abortSignal: AbortSignal;
  clearBudgetTimer: () => void;
  latencyBudgetPromise: Promise<never>;
} {
  const abortController = new AbortController();
  let rejectBudgetPromise: ((error: ModelLatencyBudgetExceededError) => void) | null = null;
  const latencyBudgetPromise = new Promise<never>((_resolve, reject) => {
    rejectBudgetPromise = reject as (error: ModelLatencyBudgetExceededError) => void;
  });

  const timeoutHandle = setTimeout(() => {
    abortController.abort();
    rejectBudgetPromise?.(new ModelLatencyBudgetExceededError(model, latencyBudgetMs));
  }, latencyBudgetMs);

  if (typeof timeoutHandle === 'object' && typeof timeoutHandle.unref === 'function') {
    timeoutHandle.unref();
  }

  return {
    abortSignal: abortController.signal,
    clearBudgetTimer: () => clearTimeout(timeoutHandle),
    latencyBudgetPromise
  };
}

async function runModelAttemptWithinLatencyBudget(options: {
  model: string;
  input: OpenAI.Responses.ResponseInput;
  temperature: number;
  structured: boolean;
  latencyBudgetMs?: number;
}): Promise<OpenAI.Responses.Response> {
  const normalizedLatencyBudgetMs = normalizeLatencyBudgetMs(options.latencyBudgetMs);

  if (normalizedLatencyBudgetMs === null) {
    return runResponse({
      model: options.model,
      input: options.input,
      temperature: options.temperature,
      json: options.structured
    });
  }

  const timedRequest = startLatencyBudgetAbortTimer(options.model, normalizedLatencyBudgetMs);
  const modelResponsePromise = runResponse({
    model: options.model,
    input: options.input,
    temperature: options.temperature,
    json: options.structured,
    requestOptions: {
      signal: timedRequest.abortSignal
    }
  });

  try {
    return await Promise.race([
      modelResponsePromise,
      timedRequest.latencyBudgetPromise
    ]);
  } finally {
    timedRequest.clearBudgetTimer();
  }
}

function logLatencyBudgetExceeded(options: {
  requestedModel: string;
  activeModel: string;
  attempt: 'primary' | 'fallback';
  elapsedMs: number;
  latencyBudgetMs: number;
}) {
  logger.warn('MODEL_LATENCY_BUDGET_EXCEEDED', {
    module: 'trinity.route',
    operation: 'model-timeout',
    stage: 'QUERY_FINETUNE_ROUTE',
    attempt: options.attempt,
    requestedModel: options.requestedModel,
    activeModel: options.activeModel,
    latencyBudgetMs: options.latencyBudgetMs,
    elapsedMs: options.elapsedMs
  });
}

/**
 * Purpose: execute the lightweight fine-tuned Trinity route with explicit base-model fallback.
 * Inputs/Outputs: prompt + optional model/temperature/structured flag + per-attempt latency budget -> model output plus fallback metadata.
 * Edge cases: when the primary model fails and fallback is distinct, the fallback attempt is logged and returned with `fallbackFlag: true`; timeout-budget overruns emit structured warnings before failover; if both attempts fail, the combined error is thrown.
 */
export async function runTrinity({
  prompt,
  model = DEFAULT_MODEL,
  temperature = 0.7,
  structured = true,
  latencyBudgetMs
}: TrinityOptions) {
  const requestedModel = model;
  const responseInput = buildResponseInput(prompt, structured);
  const normalizedLatencyBudgetMs = normalizeLatencyBudgetMs(latencyBudgetMs);
  const primaryAttemptStartedAtMs = Date.now();

  try {
    const response = await runModelAttemptWithinLatencyBudget({
      model: requestedModel,
      input: responseInput as OpenAI.Responses.ResponseInput,
      temperature,
      structured,
      latencyBudgetMs: normalizedLatencyBudgetMs ?? undefined
    });

    return {
      requestedModel,
      model: response.model,
      activeModel: response.model,
      output: extractOutputText(response),
      fallbackFlag: false,
      raw: response
    };
  } catch (primaryError) {
    const fallbackModel = getFallbackModel();
    const normalizedRequestedModel = requestedModel.trim();
    const normalizedFallbackModel = fallbackModel.trim();
    const fallbackReason = resolveErrorMessage(primaryError);

    //audit Assumption: latency-budget aborts are operationally distinct from generic model failures; failure risk: timeout spikes blend into normal fallback traffic and stay invisible; expected invariant: per-attempt budget breaches emit an explicit structured warning before fallback runs; handling strategy: detect the synthetic budget error and log it with attempt metadata.
    if (isModelLatencyBudgetExceededError(primaryError)) {
      logLatencyBudgetExceeded({
        requestedModel: normalizedRequestedModel,
        activeModel: normalizedRequestedModel,
        attempt: 'primary',
        elapsedMs: Date.now() - primaryAttemptStartedAtMs,
        latencyBudgetMs: primaryError.latencyBudgetMs
      });
    }

    //audit Assumption: fallback should only run when it changes the model choice; failure risk: retry loop silently repeats the same failing model; expected invariant: fallback attempts use a distinct model id; handling strategy: short-circuit and rethrow when no distinct fallback model exists.
    if (normalizedFallbackModel.length === 0 || normalizedFallbackModel === normalizedRequestedModel) {
      throw primaryError;
    }

    logger.warn('MODEL_FALLBACK_TRIGGERED', {
      module: 'trinity.route',
      operation: 'model-fallback',
      stage: 'QUERY_FINETUNE_ROUTE',
      requestedModel: normalizedRequestedModel,
      fallbackModel: normalizedFallbackModel,
      reason: fallbackReason,
      latencyBudgetMs: normalizedLatencyBudgetMs
    });

    const fallbackAttemptStartedAtMs = Date.now();

    try {
      //audit Assumption: a timeout-triggered failover still needs its own bounded attempt window; failure risk: a strict end-to-end budget leaves no time for fallback and converts timeout resilience into immediate 500s; expected invariant: both primary and fallback model calls are individually bounded; handling strategy: reuse the sanitized per-attempt latency budget on the fallback request as well.
      const fallbackResponse = await runModelAttemptWithinLatencyBudget({
        model: normalizedFallbackModel,
        input: responseInput as OpenAI.Responses.ResponseInput,
        temperature,
        structured,
        latencyBudgetMs: normalizedLatencyBudgetMs ?? undefined
      });

      return {
        requestedModel: normalizedRequestedModel,
        model: fallbackResponse.model,
        activeModel: fallbackResponse.model,
        output: extractOutputText(fallbackResponse),
        fallbackFlag: true,
        fallbackReason,
        raw: fallbackResponse
      };
    } catch (fallbackError) {
      if (isModelLatencyBudgetExceededError(fallbackError)) {
        logLatencyBudgetExceeded({
          requestedModel: normalizedRequestedModel,
          activeModel: normalizedFallbackModel,
          attempt: 'fallback',
          elapsedMs: Date.now() - fallbackAttemptStartedAtMs,
          latencyBudgetMs: fallbackError.latencyBudgetMs
        });
      }

      //audit Assumption: callers need both failure causes when fallback also fails; failure risk: root-cause context is lost behind the second exception; expected invariant: thrown error names both the primary and fallback failures; handling strategy: synthesize a combined error message with both reasons.
      throw new Error(
        `Primary model '${normalizedRequestedModel}' failed (${fallbackReason}); fallback model '${normalizedFallbackModel}' failed (${resolveErrorMessage(fallbackError)}).`
      );
    }
  }
}
