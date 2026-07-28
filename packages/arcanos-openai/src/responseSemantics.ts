import type {
  ChatCompletion,
  ChatCompletionMessageToolCall
} from 'openai/resources/chat/completions.js';

import {
  extractResponseOutputText,
  normalizeUsage,
  type NormalizedUsage
} from './responseParsing.js';

export type OpenAIResponsesLegacyFinishReason =
  ChatCompletion.Choice['finish_reason'];

export type OpenAIResponsesLifecycle =
  | 'completed'
  | 'incomplete'
  | 'failed'
  | 'cancelled'
  | 'pending'
  | 'unknown';

export type OpenAIResponseLegacyConversionFailureReason =
  | 'terminal_status'
  | 'pending_status'
  | 'unsupported_status'
  | 'unsupported_tool_call';

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

export type OpenAIResponsesLegacyChatCompletion = ChatCompletion & {
  provider_metadata: OpenAIResponsesProviderMetadata;
  response_status: string | null;
  incomplete_details: unknown;
  incomplete: boolean;
  truncated: boolean;
  length_truncated: boolean;
  content_filtered: boolean;
};

export interface NormalizedOpenAIResponseSemantics {
  content: string;
  refusal: string | null;
  toolCalls: ChatCompletionMessageToolCall[];
  finishReason: OpenAIResponsesLegacyFinishReason | null;
  lifecycle: OpenAIResponsesLifecycle;
  status: string | null;
  incompleteDetails: unknown;
  incompleteReason: string | null;
  rawUsage: unknown;
  usage: NormalizedUsage;
  providerErrorCode: string | null;
  outputItemTypes: string[];
  unsupportedToolCallTypes: string[];
  conversionFailure: OpenAIResponseLegacyConversionFailureReason | null;
  legacyConvertible: boolean;
  incomplete: boolean;
  truncated: boolean;
  lengthTruncated: boolean;
  contentFiltered: boolean;
}

export interface LegacyConvertibleOpenAIResponseSemantics
  extends Omit<
    NormalizedOpenAIResponseSemantics,
    'conversionFailure' | 'finishReason' | 'legacyConvertible'
  > {
  conversionFailure: null;
  finishReason: OpenAIResponsesLegacyFinishReason;
  legacyConvertible: true;
}

interface ParsedResponseToolCalls {
  toolCalls: ChatCompletionMessageToolCall[];
  outputItemTypes: string[];
  unsupportedToolCallTypes: string[];
  hasMessageItem: boolean;
  hasMalformedClientToolCall: boolean;
}

const SAFE_PROVIDER_ERROR_CODE = /^[A-Za-z0-9_.:-]{1,128}$/;
const TERMINAL_FAILURE_STATUSES = new Set(['failed', 'cancelled']);
const PENDING_STATUSES = new Set(['queued', 'in_progress']);
const SUPPORTED_STATUSES = new Set([
  'completed',
  'incomplete',
  ...TERMINAL_FAILURE_STATUSES,
  ...PENDING_STATUSES
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readResponseStatus(response: Record<string, unknown>): string | null {
  return readNonEmptyString(response.status);
}

function readIncompleteDetails(response: Record<string, unknown>): unknown {
  return response.incomplete_details ?? null;
}

function readIncompleteReason(incompleteDetails: unknown): string | null {
  if (!isRecord(incompleteDetails)) return null;
  return readNonEmptyString(incompleteDetails.reason);
}

function readProviderErrorCode(response: Record<string, unknown>): string | null {
  if (!isRecord(response.error)) return null;
  const code = readNonEmptyString(response.error.code);
  return code && SAFE_PROVIDER_ERROR_CODE.test(code) ? code : null;
}

function resolveLifecycle(
  status: string | null,
  incompleteDetails: unknown
): OpenAIResponsesLifecycle {
  if (status === 'completed') return 'completed';
  if (status === 'incomplete' || (status === null && incompleteDetails !== null)) {
    return 'incomplete';
  }
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'queued' || status === 'in_progress') return 'pending';
  return 'unknown';
}

function isCallLikeOutputType(type: string): boolean {
  return type.endsWith('_call')
    || type.endsWith('_tool_call')
    || type === 'mcp_approval_request';
}

function canMapClientToolCalls(status: string | null): boolean {
  return status === null || status === 'completed';
}

function parseResponseToolCalls(
  response: Record<string, unknown>,
  status: string | null
): ParsedResponseToolCalls {
  const output = Array.isArray(response.output) ? response.output : [];
  const toolCalls: ChatCompletionMessageToolCall[] = [];
  const outputItemTypes: string[] = [];
  const unsupportedToolCallTypes: string[] = [];
  let hasMessageItem = false;
  let hasMalformedClientToolCall = false;

  for (const item of output) {
    if (!isRecord(item)) continue;
    const type = readNonEmptyString(item.type);
    if (!type) continue;

    outputItemTypes.push(type);
    if (type === 'message') {
      hasMessageItem = true;
      continue;
    }

    if (type === 'function_call') {
      const itemStatus = readNonEmptyString(item.status);
      const callId = readNonEmptyString(item.call_id);
      const name = readNonEmptyString(item.name);
      const argumentsJson = typeof item.arguments === 'string'
        ? item.arguments
        : null;
      const itemComplete = itemStatus === null || itemStatus === 'completed';

      if (
        canMapClientToolCalls(status)
        && itemComplete
        && callId
        && name
        && argumentsJson !== null
      ) {
        toolCalls.push({
          id: callId,
          type: 'function',
          function: {
            name,
            arguments: argumentsJson
          }
        });
      } else {
        unsupportedToolCallTypes.push(type);
        hasMalformedClientToolCall = true;
      }
      continue;
    }

    if (type === 'custom_tool_call') {
      const itemStatus = readNonEmptyString(item.status);
      const callId = readNonEmptyString(item.call_id);
      const name = readNonEmptyString(item.name);
      const input = typeof item.input === 'string' ? item.input : null;
      const itemComplete = itemStatus === null || itemStatus === 'completed';

      if (
        canMapClientToolCalls(status)
        && itemComplete
        && callId
        && name
        && input !== null
      ) {
        toolCalls.push({
          id: callId,
          type: 'custom',
          custom: {
            name,
            input
          }
        });
      } else {
        unsupportedToolCallTypes.push(type);
        hasMalformedClientToolCall = true;
      }
      continue;
    }

    if (isCallLikeOutputType(type)) {
      unsupportedToolCallTypes.push(type);
    }
  }

  return {
    toolCalls,
    outputItemTypes,
    unsupportedToolCallTypes,
    hasMessageItem,
    hasMalformedClientToolCall
  };
}

function resolveConversionFailure(input: {
  status: string | null;
  lifecycle: OpenAIResponsesLifecycle;
  content: string;
  refusal: string | null;
  parsedToolCalls: ParsedResponseToolCalls;
}): OpenAIResponseLegacyConversionFailureReason | null {
  if (input.lifecycle === 'failed' || input.lifecycle === 'cancelled') {
    return 'terminal_status';
  }
  if (input.lifecycle === 'pending') {
    return 'pending_status';
  }
  if (input.status === null || !SUPPORTED_STATUSES.has(input.status)) {
    return 'unsupported_status';
  }

  if (input.lifecycle !== 'incomplete') {
    if (input.parsedToolCalls.hasMalformedClientToolCall) {
      return 'unsupported_tool_call';
    }

    const hasOnlyUnsupportedToolOutput =
      input.parsedToolCalls.unsupportedToolCallTypes.length > 0
      && input.parsedToolCalls.toolCalls.length === 0
      && !input.parsedToolCalls.hasMessageItem
      && input.content.length === 0
      && input.refusal === null;
    if (hasOnlyUnsupportedToolOutput) {
      return 'unsupported_tool_call';
    }
  }

  return null;
}

function resolveFinishReason(input: {
  lifecycle: OpenAIResponsesLifecycle;
  incompleteReason: string | null;
  toolCalls: ChatCompletionMessageToolCall[];
  conversionFailure: OpenAIResponseLegacyConversionFailureReason | null;
}): OpenAIResponsesLegacyFinishReason | null {
  if (input.conversionFailure !== null) return null;
  if (input.incompleteReason === 'content_filter') return 'content_filter';
  if (input.incompleteReason === 'max_output_tokens') return 'length';
  if (input.lifecycle === 'incomplete') return 'length';
  if (input.toolCalls.length > 0) return 'tool_calls';
  return 'stop';
}

export function extractResponseRefusal(response: unknown): string | null {
  if (!isRecord(response)) return null;

  const directRefusal = readNonEmptyString(response.refusal);
  if (directRefusal) return directRefusal.trim() || null;

  const outputItems = Array.isArray(response.output) ? response.output : [];
  for (const outputItem of outputItems) {
    if (!isRecord(outputItem)) continue;
    const contentItems = Array.isArray(outputItem.content)
      ? outputItem.content
      : [];

    for (const contentItem of contentItems) {
      if (!isRecord(contentItem)) continue;

      const refusal = readNonEmptyString(contentItem.refusal);
      if (refusal) return refusal.trim() || null;

      if (contentItem.type === 'refusal') {
        const text = readNonEmptyString(contentItem.text);
        if (text) return text.trim() || null;
      }
    }
  }

  return null;
}

export function normalizeOpenAIResponseSemantics(
  response: unknown
): NormalizedOpenAIResponseSemantics {
  if (!isRecord(response)) {
    throw new TypeError('OpenAI response must be an object.');
  }

  const status = readResponseStatus(response);
  const incompleteDetails = readIncompleteDetails(response);
  const incompleteReason = readIncompleteReason(incompleteDetails);
  const lifecycle = resolveLifecycle(status, incompleteDetails);
  const content = extractResponseOutputText(response, '');
  const refusal = extractResponseRefusal(response);
  const parsedToolCalls = parseResponseToolCalls(response, status);
  const conversionFailure = resolveConversionFailure({
    status,
    lifecycle,
    content,
    refusal,
    parsedToolCalls
  });
  const finishReason = resolveFinishReason({
    lifecycle,
    incompleteReason,
    toolCalls: parsedToolCalls.toolCalls,
    conversionFailure
  });
  const incomplete = lifecycle === 'incomplete' || incompleteDetails !== null;
  const lengthTruncated = finishReason === 'length'
    || incompleteReason === 'max_output_tokens';
  const contentFiltered = finishReason === 'content_filter'
    || incompleteReason === 'content_filter';
  const rawUsage = response.usage ?? null;

  return {
    content,
    refusal,
    toolCalls: parsedToolCalls.toolCalls,
    finishReason,
    lifecycle,
    status,
    incompleteDetails,
    incompleteReason,
    rawUsage,
    usage: normalizeUsage(rawUsage),
    providerErrorCode: readProviderErrorCode(response),
    outputItemTypes: parsedToolCalls.outputItemTypes,
    unsupportedToolCallTypes: parsedToolCalls.unsupportedToolCallTypes,
    conversionFailure,
    legacyConvertible: conversionFailure === null,
    incomplete,
    truncated: lengthTruncated,
    lengthTruncated,
    contentFiltered
  };
}

function conversionErrorMessage(
  reason: OpenAIResponseLegacyConversionFailureReason
): string {
  switch (reason) {
    case 'terminal_status':
      return 'OpenAI response ended without a completed legacy-compatible result.';
    case 'pending_status':
      return 'OpenAI response is still pending and cannot be converted to a completed result.';
    case 'unsupported_status':
      return 'OpenAI response used an unsupported lifecycle status.';
    case 'unsupported_tool_call':
      return 'OpenAI response contains a tool call that the legacy chat shape cannot represent safely.';
  }
}

export class OpenAIResponseLegacyConversionError extends Error {
  readonly code = 'OPENAI_RESPONSE_LEGACY_CONVERSION_ERROR';
  readonly responseStatus: string | null;
  readonly reason: OpenAIResponseLegacyConversionFailureReason;
  readonly providerErrorCode: string | null;
  readonly outputItemTypes: readonly string[];

  constructor(semantics: NormalizedOpenAIResponseSemantics) {
    if (!semantics.conversionFailure) {
      throw new TypeError('Conversion error requires a non-convertible response.');
    }

    super(conversionErrorMessage(semantics.conversionFailure));
    this.name = 'OpenAIResponseLegacyConversionError';
    this.responseStatus = semantics.status;
    this.reason = semantics.conversionFailure;
    this.providerErrorCode = semantics.providerErrorCode;
    this.outputItemTypes = Object.freeze([...semantics.outputItemTypes]);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function requireLegacyConvertible(
  semantics: NormalizedOpenAIResponseSemantics
): LegacyConvertibleOpenAIResponseSemantics {
  if (!semantics.legacyConvertible || semantics.finishReason === null) {
    throw new OpenAIResponseLegacyConversionError(semantics);
  }

  return semantics as LegacyConvertibleOpenAIResponseSemantics;
}

export function normalizeOpenAIResponseForLegacyChat(
  response: unknown
): LegacyConvertibleOpenAIResponseSemantics {
  return requireLegacyConvertible(normalizeOpenAIResponseSemantics(response));
}

export function resolveOpenAIResponsesLegacyFinishReason(
  response: unknown
): OpenAIResponsesLegacyFinishReason {
  return normalizeOpenAIResponseForLegacyChat(response).finishReason;
}

function buildProviderMetadataFromSemantics(
  semantics: LegacyConvertibleOpenAIResponseSemantics,
  finishReason: OpenAIResponsesLegacyFinishReason
): OpenAIResponsesProviderMetadata {
  const lengthTruncated = finishReason === 'length'
    || semantics.incompleteReason === 'max_output_tokens';
  const contentFiltered = finishReason === 'content_filter'
    || semantics.incompleteReason === 'content_filter';

  return {
    provider: 'openai',
    api: 'responses',
    status: semantics.status,
    incomplete_details: semantics.incompleteDetails,
    usage: semantics.rawUsage,
    finish_reason: finishReason,
    incomplete: semantics.incomplete,
    truncated: lengthTruncated,
    length_truncated: lengthTruncated,
    content_filtered: contentFiltered
  };
}

export function buildOpenAIResponsesProviderMetadata(
  response: unknown,
  finishReason?: OpenAIResponsesLegacyFinishReason,
  normalized?: LegacyConvertibleOpenAIResponseSemantics
): OpenAIResponsesProviderMetadata {
  const semantics = normalized
    ?? normalizeOpenAIResponseForLegacyChat(response);
  return buildProviderMetadataFromSemantics(
    semantics,
    finishReason ?? semantics.finishReason
  );
}

export function attachOpenAIResponsesMetadataToChatCompletion<
  TCompletion extends ChatCompletion
>(
  legacyResponse: TCompletion,
  response: unknown,
  finishReason?: OpenAIResponsesLegacyFinishReason,
  normalized?: LegacyConvertibleOpenAIResponseSemantics
): TCompletion & OpenAIResponsesLegacyChatCompletion {
  const providerMetadata = buildOpenAIResponsesProviderMetadata(
    response,
    finishReason,
    normalized
  );

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
