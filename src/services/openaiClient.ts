import type { ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';

import {
  getOpenAIAdapter,
  type OpenAIAdapterConfig,
  type OpenAIAdapterRequestOptions
} from '@core/adapters/openai.adapter.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { getConfig } from '@platform/runtime/unifiedConfig.js';

export interface NormalizedOpenAIError {
  name: string;
  message: string;
  status: number | null;
  code: string | null;
  retryable: boolean;
}

export interface ResponsesCreateOptions extends OpenAIAdapterRequestOptions {
  requestId?: string | null;
  jobId?: string | null;
}

function isRetryableStatus(status: number | null): boolean {
  return status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    (status !== null && status >= 500 && status < 600);
}

function readErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const record = error as Record<string, unknown>;
  const status = record.status ?? record.statusCode ?? record.httpCode;
  return typeof status === 'number' && Number.isFinite(status) ? status : null;
}

function readErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const record = error as Record<string, unknown>;
  return typeof record.code === 'string' && record.code.trim().length > 0
    ? record.code.trim()
    : null;
}

export function normalizeOpenAIError(error: unknown): NormalizedOpenAIError {
  const status = readErrorStatus(error);
  const code = readErrorCode(error);
  const message = resolveErrorMessage(error);
  const normalizedMessage = message.toLowerCase();

  return {
    name: error instanceof Error && error.name ? error.name : 'OpenAIError',
    message,
    status,
    code,
    retryable:
      isRetryableStatus(status) ||
      normalizedMessage.includes('timeout') ||
      normalizedMessage.includes('rate limit') ||
      normalizedMessage.includes('network') ||
      normalizedMessage.includes('econn') ||
      normalizedMessage.includes('socket hang up')
  };
}

function assertResponsesPayload(payload: ResponseCreateParamsNonStreaming): void {
  if (!payload || typeof payload !== 'object') {
    throw new Error('OpenAI Responses payload must be an object.');
  }
  if (typeof payload.model !== 'string' || payload.model.trim().length === 0) {
    throw new Error('OpenAI Responses payload requires a non-empty model.');
  }
  const input = (payload as { input?: unknown }).input;
  if (
    !(typeof input === 'string' && input.trim().length > 0) &&
    !(Array.isArray(input) && input.length > 0)
  ) {
    throw new Error('OpenAI Responses payload requires non-empty input.');
  }
}

export function getConfiguredOpenAIAdapter() {
  const config = getConfig();
  const openaiCredential = config.openaiApiKey?.trim();
  if (!openaiCredential) {
    throw new Error('OPENAI_API_KEY is required for OpenAI calls.');
  }

  return getOpenAIAdapter({
    ['apiKey']: openaiCredential,
    baseURL: config.openaiBaseUrl,
    timeout: config.workerApiTimeoutMs,
    maxRetries: config.openaiMaxRetries,
    defaultModel: config.defaultModel
  } as OpenAIAdapterConfig);
}

export async function createResponses(
  payload: ResponseCreateParamsNonStreaming,
  options: ResponsesCreateOptions = {}
) {
  assertResponsesPayload(payload);
  try {
    const adapter = getConfiguredOpenAIAdapter();
    return await adapter.responses.create(payload, {
      signal: options.signal,
      headers: options.headers
    });
  } catch (error: unknown) {
    throw Object.assign(new Error(normalizeOpenAIError(error).message), {
      openai: normalizeOpenAIError(error),
      cause: error
    });
  }
}
