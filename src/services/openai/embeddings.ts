import type OpenAI from 'openai';
import type { OpenAIAdapter } from "@core/adapters/openai.adapter.js";
import { buildEmbeddingRequest } from './requestBuilders.js';
import { getOpenAIClientOrAdapter } from './clientBridge.js';

const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

export async function createEmbedding(
  input: string,
  clientOrAdapter?: OpenAI | OpenAIAdapter | null
): Promise<number[]> {
  const requestParams = buildEmbeddingRequest({ input, model: DEFAULT_EMBEDDING_MODEL });

  if (clientOrAdapter) {
    //audit Assumption: backward compatibility path may pass a raw OpenAI client; risk: abrupt runtime breakage; invariant: embeddings remain callable for legacy callers; handling: use direct embeddings surface when adapter type not available.
    const embeddingClient = clientOrAdapter as OpenAI;
    const embeddingRes = await embeddingClient.embeddings.create(requestParams);
    return embeddingRes.data[0]?.embedding || [];
  }

  const { adapter } = getOpenAIClientOrAdapter();
  if (!adapter) {
    throw new Error('OpenAI adapter not initialized');
  }

  const embeddingRes = await adapter.embeddings.create(requestParams);

  // embeddingRes is CreateEmbeddingResponse which has a data array
  return embeddingRes.data[0]?.embedding || [];
}
