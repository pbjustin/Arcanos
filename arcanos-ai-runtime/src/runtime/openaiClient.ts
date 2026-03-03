import type {
  Response as OpenAIResponse,
  ResponseCreateParamsNonStreaming,
  ResponseInput,
} from "openai/resources/responses/responses";
import type { RuntimeBudget } from "./runtimeBudget.js";
import { getSafeRemainingMs, assertBudgetAvailable } from "./runtimeBudget.js";
import { OpenAIAbortError } from "./runtimeErrors.js";
import { retryWithBackoff } from "@arcanos/openai/retry";
import { getRuntimeOpenAIClient } from "../ai/openaiClient.js";

export interface GPT5Request {
  model: string;
  input?: Array<Record<string, unknown>>;
  messages?: Array<Record<string, unknown>>;
  maxTokens?: number;
  instructions?: string;
}

export type GPT5Response = OpenAIResponse;

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
  };

  if (request.maxTokens !== undefined) {
    payload.max_output_tokens = request.maxTokens;
  }

  if (request.instructions) {
    payload.instructions = request.instructions;
  }

  return payload;
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.name === "AbortError" ||
    error.message.toLowerCase().includes("aborted")
  );
}

export async function runGPT5(
  request: GPT5Request,
  budget: RuntimeBudget
): Promise<GPT5Response> {
  assertBudgetAvailable(budget);
  const safeRemaining = getSafeRemainingMs(budget);

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, safeRemaining);

  try {
    const response = await retryWithBackoff(() => getRuntimeOpenAIClient().responses.create(
      buildRequestPayload(request),
      { signal: controller.signal }
    ), { signal: controller.signal });

    return response;

  } catch (error: unknown) {
    if (isAbortError(error)) {
      throw new OpenAIAbortError();
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
