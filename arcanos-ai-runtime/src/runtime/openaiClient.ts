import { OpenAI } from "openai";
import type {
  Response as OpenAIResponse,
  ResponseCreateParamsNonStreaming,
  ResponseInput,
} from "openai/resources/responses/responses";
import type { RuntimeBudget } from "./runtimeBudget.js";
import { getSafeRemainingMs, assertBudgetAvailable } from "./runtimeBudget.js";
import { OpenAIAbortError } from "./runtimeErrors.js";

export interface GPT5Request {
  model: string;
  messages: Array<Record<string, unknown>>;
  maxTokens?: number;
  instructions?: string;
}

export type GPT5Response = OpenAIResponse;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required to call runGPT5");
    }

    client = new OpenAI({ apiKey });
  }

  return client;
}

function buildRequestPayload(
  request: GPT5Request
): ResponseCreateParamsNonStreaming {
  const payload: ResponseCreateParamsNonStreaming = {
    model: request.model,
    input: request.messages as unknown as ResponseInput,
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
    const response = await getClient().responses.create(
      buildRequestPayload(request),
      { signal: controller.signal }
    );

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
