import type OpenAI from 'openai';
import type { Response as OpenAIResponse } from 'openai/resources/responses/responses';

export type OpenAIResponsesLegacyFinishReason =
  OpenAI.Chat.Completions.ChatCompletion.Choice['finish_reason'];

export interface OpenAIResponsesProviderMetadata {
  provider: 'openai';
  api: 'responses';
  status: string | null;
  incomplete_details: unknown;
  usage: unknown;
  finish_reason: OpenAIResponsesLegacyFinishReason;
  incomplete: boolean;
  truncated: boolean;
  length_truncated: boolean;
  content_filtered: boolean;
}

export type OpenAIResponsesLegacyChatCompletion = OpenAI.Chat.Completions.ChatCompletion & {
  provider_metadata: OpenAIResponsesProviderMetadata;
  response_status: string | null;
  incomplete_details: unknown;
  incomplete: boolean;
  truncated: boolean;
  length_truncated: boolean;
  content_filtered: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readResponseStatus(response: OpenAIResponse): string | null {
  const status = (response as unknown as { status?: unknown }).status;
  return typeof status === 'string' && status.length > 0 ? status : null;
}

function readIncompleteDetails(response: OpenAIResponse): unknown {
  return (response as unknown as { incomplete_details?: unknown }).incomplete_details ?? null;
}

function readIncompleteReason(incompleteDetails: unknown): string | null {
  if (!isRecord(incompleteDetails)) return null;
  const reason = incompleteDetails.reason;
  return typeof reason === 'string' && reason.length > 0 ? reason : null;
}

function responseContainsToolCall(response: OpenAIResponse): boolean {
  const output = (response as unknown as { output?: unknown }).output;
  if (!Array.isArray(output)) return false;

  return output.some((item) => {
    if (!isRecord(item)) return false;
    const type = typeof item.type === 'string' ? item.type : '';
    return type === 'function_call' || type.endsWith('_call') || type.endsWith('_tool_call');
  });
}

export function resolveOpenAIResponsesLegacyFinishReason(
  response: OpenAIResponse
): OpenAIResponsesLegacyFinishReason {
  const status = readResponseStatus(response);
  const incompleteReason = readIncompleteReason(readIncompleteDetails(response));

  if (incompleteReason === 'max_output_tokens') return 'length';
  if (incompleteReason === 'content_filter') return 'content_filter';
  if (status === 'incomplete') return 'length';
  if (responseContainsToolCall(response)) return 'tool_calls';

  return 'stop';
}

export function buildOpenAIResponsesProviderMetadata(
  response: OpenAIResponse,
  finishReason: OpenAIResponsesLegacyFinishReason = resolveOpenAIResponsesLegacyFinishReason(response)
): OpenAIResponsesProviderMetadata {
  const status = readResponseStatus(response);
  const incompleteDetails = readIncompleteDetails(response);
  const incompleteReason = readIncompleteReason(incompleteDetails);
  const incomplete = status === 'incomplete' || incompleteDetails !== null;
  const lengthTruncated = finishReason === 'length' || incompleteReason === 'max_output_tokens';
  const contentFiltered = finishReason === 'content_filter' || incompleteReason === 'content_filter';

  return {
    provider: 'openai',
    api: 'responses',
    status,
    incomplete_details: incompleteDetails,
    usage: (response as unknown as { usage?: unknown }).usage ?? null,
    finish_reason: finishReason,
    incomplete,
    truncated: lengthTruncated,
    length_truncated: lengthTruncated,
    content_filtered: contentFiltered
  };
}

export function attachOpenAIResponsesMetadataToChatCompletion<
  TCompletion extends OpenAI.Chat.Completions.ChatCompletion
>(
  legacyResponse: TCompletion,
  response: OpenAIResponse,
  finishReason: OpenAIResponsesLegacyFinishReason = resolveOpenAIResponsesLegacyFinishReason(response)
): TCompletion & OpenAIResponsesLegacyChatCompletion {
  const providerMetadata = buildOpenAIResponsesProviderMetadata(response, finishReason);

  return Object.assign(legacyResponse, {
    provider_metadata: providerMetadata,
    response_status: providerMetadata.status,
    incomplete_details: providerMetadata.incomplete_details,
    incomplete: providerMetadata.incomplete,
    truncated: providerMetadata.truncated,
    length_truncated: providerMetadata.length_truncated,
    content_filtered: providerMetadata.content_filtered
  });
}
