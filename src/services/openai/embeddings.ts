import type OpenAI from 'openai';
import type { OpenAIAdapter } from "@core/adapters/openai.adapter.js";
import { buildEmbeddingRequest } from './requestBuilders/index.js';
import { getOpenAIClientOrAdapter } from './clientBridge.js';

const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

export interface CreateEmbeddingRequestOptions {
  readonly signal?: AbortSignal;
}

export const DEFAULT_OPENAI_EMBEDDING_MODEL = DEFAULT_EMBEDDING_MODEL;

export async function createEmbedding(
  input: string,
  clientOrAdapter?: OpenAI | OpenAIAdapter | null,
  options: CreateEmbeddingRequestOptions = {}
): Promise<number[]> {
  const requestParams = buildEmbeddingRequest({ input, model: DEFAULT_EMBEDDING_MODEL });

  if (clientOrAdapter) {
    //audit Assumption: backward compatibility path may pass a raw OpenAI client; risk: abrupt runtime breakage; invariant: embeddings remain callable for legacy callers; handling: use direct embeddings surface when adapter type not available.
    const embeddingClient = clientOrAdapter as OpenAI;
    const embeddingRes = await embeddingClient.embeddings.create(requestParams, options);
    return embeddingRes.data[0]?.embedding || [];
  }

  const { adapter } = getOpenAIClientOrAdapter();
  if (!adapter) {
    throw new Error('OpenAI adapter not initialized');
  }

  const embeddingRes = await adapter.embeddings.create(requestParams, options);

  // embeddingRes is CreateEmbeddingResponse which has a data array
  return embeddingRes.data[0]?.embedding || [];
}

/**
 * Create a bounded batch of embeddings while preserving input order.
 * The caller owns batch-size and text-length limits for its domain.
 */
export async function createEmbeddings(
  inputs: readonly string[],
  clientOrAdapter?: OpenAI | OpenAIAdapter | null,
  options: CreateEmbeddingRequestOptions = {}
): Promise<number[][]> {
  if (inputs.length === 0) {
    return [];
  }

  const normalizedInputs = inputs.map(input => {
    if (typeof input !== 'string' || input.trim().length === 0) {
      throw new TypeError('Embedding batch inputs must be non-empty strings.');
    }
    return input;
  });
  const requestParams = buildEmbeddingRequest({
    input: normalizedInputs,
    model: DEFAULT_EMBEDDING_MODEL,
  });

  const response = clientOrAdapter
    ? await (clientOrAdapter as OpenAI).embeddings.create(requestParams, options)
    : await (async () => {
        const { adapter } = getOpenAIClientOrAdapter();
        if (!adapter) {
          throw new Error('OpenAI adapter not initialized');
        }
        return adapter.embeddings.create(requestParams, options);
      })();

  const ordered = [...response.data].sort((left, right) => left.index - right.index);
  if (
    ordered.length !== normalizedInputs.length
    || ordered.some((item, index) => item.index !== index || item.embedding.length === 0)
  ) {
    throw new Error('Embedding provider returned an incomplete batch.');
  }

  return ordered.map(item => item.embedding);
}
