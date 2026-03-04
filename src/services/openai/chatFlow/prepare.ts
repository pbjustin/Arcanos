import { generateRequestId } from "@shared/idGenerator.js";
import { hasContent } from "@shared/promptUtils.js";
import { trackPromptUsage } from "@services/contextualReinforcement.js";
import { aiLogger } from "@platform/logging/structuredLogging.js";
import { createCacheKey } from "@shared/hashUtils.js";
import { DEFAULT_SYSTEM_PROMPT } from "../constants.js";
import type { CallOpenAIOptions, ChatCompletionMessageParam } from "../types.js";
import { buildChatMessages } from "../messageBuilder.js";

/**
 * prepare stage: build messages, metadata, and (optional) cache key descriptor.
 */
export function prepareChatFlow(
  model: string,
  prompt: string,
  tokenLimit: number,
  useCache: boolean,
  options: CallOpenAIOptions
): {
  systemPrompt: string;
  reinforcementMetadata: Record<string, unknown>;
  preparedMessages: ChatCompletionMessageParam[];
  cacheKey: string | null;
  cacheDescriptor: Record<string, unknown>;
} {
  const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const baseMetadata = options.metadata ?? {};
  const rawRequestId = baseMetadata ? (baseMetadata as Record<string, unknown>)["requestId"] : undefined;
  const requestIdString = typeof rawRequestId === "string" ? rawRequestId : undefined;
  const reinforcementRequestId = hasContent(requestIdString) ? requestIdString : generateRequestId("ctx");

  const reinforcementMetadata: Record<string, unknown> = {
    ...baseMetadata,
    requestId: reinforcementRequestId,
    model
  };

  trackPromptUsage(prompt, reinforcementMetadata);

  const preparedMessages = buildChatMessages(prompt, systemPrompt, options);

  if (Object.keys(reinforcementMetadata).length > 0) {
    aiLogger.debug("OpenAI call metadata", {
      operation: "callOpenAI",
      model,
      ...reinforcementMetadata
    });
  }

  const cacheDescriptor = {
    messages: preparedMessages,
    tokenLimit,
    temperature: options.temperature,
    top_p: options.top_p,
    frequency_penalty: options.frequency_penalty,
    presence_penalty: options.presence_penalty,
    response_format: options.responseFormat,
    user: options.user
  };

  const cacheKey = useCache ? createCacheKey(model, cacheDescriptor) : null;

  return { systemPrompt, reinforcementMetadata, preparedMessages, cacheKey, cacheDescriptor };
}
