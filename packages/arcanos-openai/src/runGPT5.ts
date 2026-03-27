const shouldStore = (() => {
  const raw = process.env.OPENAI_STORE;
  if (!raw) return false;
  const v = String(raw).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
})();
import type {
  Response as OpenAIResponse,
  ResponseCreateParamsNonStreaming,
  ResponseInput,
} from "openai/resources/responses/responses";
import type { RuntimeBudget } from "@arcanos/runtime";
import {
  assertBudgetAvailable,
  createLinkedAbortController,
  getRequestAbortSignal,
  getRequestRemainingMs,
  getSafeRemainingMs,
  isAbortError,
  OpenAIAbortError,
} from "@arcanos/runtime";
import type { RetryOptions } from "./retry.js";

export interface GPT5Request {
  model: string;
  input?: Array<Record<string, unknown>>;
  messages?: Array<Record<string, unknown>>;
  maxTokens?: number;
  instructions?: string;
}

export type GPT5Response = OpenAIResponse;
export interface GPT5Client {
  responses: {
    create: (
      payload: ResponseCreateParamsNonStreaming,
      options: { signal: AbortSignal }
    ) => Promise<GPT5Response>;
  };
}

export type GPT5Retry = <T>(
  fn: (attempt: number) => Promise<T>,
  options?: RetryOptions
) => Promise<T>;

export interface GPT5RunOptions {
  retry?: GPT5Retry;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function resolveRequestInput(request: GPT5Request): Array<Record<string, unknown>> {
  if (Array.isArray(request.input)) {
    return request.input;
  }

  // Backward compatibility for call sites still using the legacy field during migration.
  if (Array.isArray(request.messages)) {
    return request.messages;
  }

  return [];
}

function buildRequestPayload(
  request: GPT5Request
): ResponseCreateParamsNonStreaming {
  const payload: ResponseCreateParamsNonStreaming = {
    model: request.model,
    input: resolveRequestInput(request) as unknown as ResponseInput,
    store: shouldStore,
    include: ['reasoning.encrypted_content'],
  };

  if (request.maxTokens !== undefined) {
    payload.max_output_tokens = request.maxTokens;
  }

  if (request.instructions) {
    payload.instructions = request.instructions;
  }

  return payload;
}

function resolveRequestTimeoutMs(
  budget: RuntimeBudget,
  explicitTimeoutMs?: number
): number {
  assertBudgetAvailable(budget);
  const safeRemainingMs = getSafeRemainingMs(budget);
  if (safeRemainingMs <= 0) {
    assertBudgetAvailable(budget);
  }

  const requestRemainingMs = getRequestRemainingMs();
  const preferredTimeoutMs =
    typeof explicitTimeoutMs === "number" && Number.isFinite(explicitTimeoutMs) && explicitTimeoutMs > 0
      ? Math.trunc(explicitTimeoutMs)
      : safeRemainingMs;

  return Math.max(
    1,
    Math.min(
      preferredTimeoutMs,
      safeRemainingMs,
      requestRemainingMs ?? safeRemainingMs
    )
  );
}

export async function runGPT5(
  client: GPT5Client,
  request: GPT5Request,
  budget: RuntimeBudget,
  options: GPT5RunOptions = {}
): Promise<GPT5Response> {
  assertBudgetAvailable(budget);
  const requestTimeoutMs = resolveRequestTimeoutMs(budget, options.timeoutMs);
  const requestScope = createLinkedAbortController({
    timeoutMs: requestTimeoutMs,
    parentSignal: options.signal ?? getRequestAbortSignal(),
    abortMessage: `OpenAI GPT-5 request timed out after ${requestTimeoutMs}ms`
  });

  try {
    const executeRequest = (attempt: number) => client.responses.create(
      buildRequestPayload(request),
      { signal: requestScope.signal }
    );
    const response = options.retry
      ? await options.retry(executeRequest, { signal: requestScope.signal })
      : await executeRequest(1);

    return response;

  } catch (error: unknown) {
    if (requestScope.signal.aborted || isAbortError(error)) {
      throw new OpenAIAbortError();
    }

    throw error;
  } finally {
    requestScope.cleanup();
  }
}



