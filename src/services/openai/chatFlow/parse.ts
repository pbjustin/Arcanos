import { extractResponseOutputText, convertResponseToLegacyChatCompletion } from "../requestBuilders/index.js";
import { NO_RESPONSE_CONTENT_FALLBACK } from "../constants.js";
import type { ChatCompletion } from "../types.js";

/**
 * parse stage: normalize Responses API output to legacy ChatCompletion + plain text.
 */
export function parseChatFlowResponse(
  response: any,
  requestedModel: string
): { output: string; activeModel: string; legacyResponse: ChatCompletion } {
  const output = extractResponseOutputText(response, NO_RESPONSE_CONTENT_FALLBACK);
  const activeModel = response?.model || requestedModel;
  const legacyResponse = convertResponseToLegacyChatCompletion(response, activeModel);
  return { output, activeModel, legacyResponse };
}
