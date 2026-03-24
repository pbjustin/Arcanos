import type { OpenAIAdapter } from "@core/adapters/openai.adapter.js";
import type { CallOpenAIOptions } from "../types.js";
import { withRetry } from "@platform/resilience/unifiedRetry.js";
import { DEFAULT_MAX_RETRIES, REQUEST_ID_HEADER } from "../constants.js";
import { getApiTimeoutMs } from "@arcanos/openai/unifiedClient";
import { buildResponsesRequest } from "../requestBuilders.js";
import { classifyOpenAIError } from "@core/lib/errors/reusable.js";
import { logRequestAttempt, logRequestPermanentFailure } from "./trace.js";

/**
 * execute stage: perform the network call (with retry) and return raw Responses API payload.
 */
export async function executeChatFlow(
  adapter: OpenAIAdapter,
  model: string,
  messages: any[],
  tokenLimit: number,
  options: CallOpenAIOptions
): Promise<any> {
  return await withRetry(
    async () => {
      return await performResponsesRequest(adapter, model, messages, tokenLimit, options);
    },
    {
      maxRetries: DEFAULT_MAX_RETRIES,
      operationName: "callOpenAI",
      useCircuitBreaker: true
    }
  );
}

async function performResponsesRequest(
  adapter: OpenAIAdapter,
  model: string,
  messages: any[],
  tokenLimit: number,
  options: CallOpenAIOptions
): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getApiTimeoutMs());

  try {
    const userMessage = messages.find((m: any) => m.role === "user");
    const prompt =
      typeof userMessage?.content === "string"
        ? userMessage.content
        : Array.isArray(userMessage?.content)
          ? userMessage.content.find((p: any) => p.type === "text")?.text || ""
          : "";

    const requestPayload = buildResponsesRequest({
      prompt,
      model,
      messages,
      maxTokens: tokenLimit,
      temperature: options.temperature,
      top_p: options.top_p,
      frequency_penalty: options.frequency_penalty,
      presence_penalty: options.presence_penalty,
      responseFormat: options.responseFormat,
      user: options.user,
      includeRoutingMessage: false
    });

    // single-attempt logging (retry layer logs at a higher level)
    logRequestAttempt(model, 1, 1);

    const requestId = typeof options?.metadata?.requestId === 'string'
      ? String(options.metadata.requestId)
      : crypto.randomUUID();

    const response = await adapter.responses.create(requestPayload, {
      signal: controller.signal,
      headers: {
        // Local tracing header used throughout ARCANOS.
        [REQUEST_ID_HEADER]: requestId,
        // Best practice: provide explicit tracing + idempotency keys for safe retries.
        'Request-Id': requestId,
        'Idempotency-Key': requestId
      }
    });

    clearTimeout(timeout);
    return response;
  } catch (err: unknown) {
    clearTimeout(timeout);
    const error = err instanceof Error ? err : new Error(String(err));
    const classification = classifyOpenAIError(error);
    logRequestPermanentFailure(model, 1, classification.type, classification.message, error);
    throw error;
  }
}
