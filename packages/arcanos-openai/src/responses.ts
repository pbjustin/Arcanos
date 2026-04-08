import type {
  Response as OpenAIResponse,
  ResponseCreateParamsNonStreaming,
} from 'openai/resources/responses/responses';

import { extractResponseOutputText } from './responseParsing.js';

export interface OpenAIResponsesRequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export interface OpenAIResponsesClientLike {
  responses: {
    create: (
      params: ResponseCreateParamsNonStreaming,
      options?: OpenAIResponsesRequestOptions
    ) => Promise<OpenAIResponse>;
  };
}

export interface StructuredResponseParseOptions<T> {
  validate?: (value: unknown) => value is T;
  extractRefusal?: (response: unknown) => string | null;
  source?: string;
}

export interface StructuredResponseResult<T> {
  response: OpenAIResponse;
  outputText: string;
  outputParsed: T;
}

export class OpenAIResponseRefusalError extends Error {
  constructor(message: string, readonly source: string) {
    super(message);
    this.name = 'OpenAIResponseRefusalError';
  }
}

export class OpenAIResponseMissingOutputError extends Error {
  constructor(readonly source: string) {
    super(`${source} returned no structured output.`);
    this.name = 'OpenAIResponseMissingOutputError';
  }
}

export class OpenAIResponseMalformedJsonError extends Error {
  constructor(message: string, readonly source: string) {
    super(message);
    this.name = 'OpenAIResponseMalformedJsonError';
  }
}

export class OpenAIResponseValidationError extends Error {
  constructor(readonly source: string) {
    super(`${source} returned structured output that failed validation.`);
    this.name = 'OpenAIResponseValidationError';
  }
}

function normalizeSource(source?: string): string {
  return typeof source === 'string' && source.trim().length > 0
    ? source.trim()
    : 'OpenAI structured response';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function validateStructuredValue<T>(
  value: unknown,
  options: StructuredResponseParseOptions<T>
): T {
  if (options.validate && !options.validate(value)) {
    throw new OpenAIResponseValidationError(normalizeSource(options.source));
  }

  return value as T;
}

export function extractResponseRefusal(response: unknown): string | null {
  if (!isObject(response)) {
    return null;
  }

  if (typeof response.refusal === 'string' && response.refusal.trim().length > 0) {
    return response.refusal.trim();
  }

  const outputItems = Array.isArray(response.output) ? response.output : [];
  for (const outputItem of outputItems) {
    if (!isObject(outputItem)) {
      continue;
    }

    const contentItems = Array.isArray(outputItem.content) ? outputItem.content : [];
    for (const contentItem of contentItems) {
      if (!isObject(contentItem)) {
        continue;
      }

      if (typeof contentItem.refusal === 'string' && contentItem.refusal.trim().length > 0) {
        return contentItem.refusal.trim();
      }

      if (
        contentItem.type === 'refusal' &&
        typeof contentItem.text === 'string' &&
        contentItem.text.trim().length > 0
      ) {
        return contentItem.text.trim();
      }
    }
  }

  return null;
}

export function parseStructuredJson<T = unknown>(
  response: unknown,
  options: StructuredResponseParseOptions<T> = {}
): T {
  const refusalReason = (options.extractRefusal ?? extractResponseRefusal)(response);
  if (refusalReason) {
    throw new OpenAIResponseRefusalError(
      `Model refusal: ${refusalReason}`,
      normalizeSource(options.source)
    );
  }

  if (isObject(response) && response.output_parsed !== undefined && response.output_parsed !== null) {
    return validateStructuredValue(response.output_parsed, options);
  }

  const outputText = extractResponseOutputText(response, '').trim();
  if (!outputText) {
    throw new OpenAIResponseMissingOutputError(normalizeSource(options.source));
  }

  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(outputText);
  } catch (error) {
    const source = normalizeSource(options.source);
    throw new OpenAIResponseMalformedJsonError(
      `${source} returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
      source
    );
  }

  return validateStructuredValue(parsedValue, options);
}

export async function callTextResponse(
  client: OpenAIResponsesClientLike,
  params: ResponseCreateParamsNonStreaming,
  requestOptions?: OpenAIResponsesRequestOptions
): Promise<{ response: OpenAIResponse; outputText: string }> {
  const response = await client.responses.create(params, requestOptions);
  return {
    response,
    outputText: extractResponseOutputText(response, ''),
  };
}

export async function callStructuredResponse<T>(
  client: OpenAIResponsesClientLike,
  params: ResponseCreateParamsNonStreaming,
  requestOptions?: OpenAIResponsesRequestOptions,
  parseOptions: StructuredResponseParseOptions<T> = {}
): Promise<StructuredResponseResult<T>> {
  const { response, outputText } = await callTextResponse(client, params, requestOptions);
  const outputParsed = parseStructuredJson<T>(response, parseOptions);
  return {
    response,
    outputText,
    outputParsed,
  };
}

export async function createSafeResponsesParse<T = unknown>(
  client: OpenAIResponsesClientLike,
  params: ResponseCreateParamsNonStreaming,
  requestOptions?: OpenAIResponsesRequestOptions,
  parseOptions: StructuredResponseParseOptions<T> = {}
): Promise<OpenAIResponse & { output_parsed: T }> {
  const { response, outputParsed } = await callStructuredResponse<T>(
    client,
    params,
    requestOptions,
    parseOptions
  );

  return Object.assign({}, response as unknown as Record<string, unknown>, {
    output_parsed: outputParsed,
  }) as unknown as OpenAIResponse & { output_parsed: T };
}

export type OpenAIResponseText = Awaited<ReturnType<typeof callTextResponse>>;
export type OpenAIStructuredResponse<T> = Awaited<ReturnType<typeof callStructuredResponse<T>>>;
