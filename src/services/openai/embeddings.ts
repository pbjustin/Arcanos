import type OpenAI from 'openai';
import type { OpenAIAdapter } from '../../adapters/openai.adapter.js';
import { getOpenAIAdapter } from '../../adapters/openai.adapter.js';
import type { CreateEmbeddingResponse } from 'openai/resources/embeddings.js';
import type { ChatCompletion } from './types.js';

const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

export async function createEmbedding(
  input: string,
  clientOrAdapter?: OpenAI | OpenAIAdapter | null
): Promise<number[]> {
  // Use adapter if provided, otherwise get singleton adapter
  let adapter: OpenAIAdapter;
  if (clientOrAdapter && 'embeddings' in clientOrAdapter && typeof clientOrAdapter.embeddings === 'object') {
    adapter = clientOrAdapter as OpenAIAdapter;
  } else if (clientOrAdapter && typeof (clientOrAdapter as OpenAI).embeddings === 'object') {
    // Legacy client - wrap it
    const client = clientOrAdapter as OpenAI;
    adapter = {
      chat: { 
        completions: { 
          create: async (params) => {
            const nonStreamingParams = { ...params, stream: false } as typeof params & { stream: false };
            const result = await client.chat.completions.create(nonStreamingParams);
            return result as import('./types.js').ChatCompletion;
          }
        } 
      },
      embeddings: { 
        create: async (params) => {
          return client.embeddings.create(params) as Promise<CreateEmbeddingResponse>;
        }
      },
      audio: { 
        transcriptions: { 
          create: async (params: Parameters<OpenAI['audio']['transcriptions']['create']>[0]) => {
            // Ensure non-streaming by omitting stream property
            const { stream: _stream, ...restParams } = params as Record<string, unknown>;
            return client.audio.transcriptions.create(restParams as Parameters<OpenAI['audio']['transcriptions']['create']>[0]);
          }
        } 
      },
      getClient: () => client
    };
  } else {
    // Get singleton adapter
    try {
      adapter = getOpenAIAdapter();
    } catch {
      throw new Error('OpenAI adapter not initialized');
    }
  }

  const embeddingRes = await adapter.embeddings.create({
    model: DEFAULT_EMBEDDING_MODEL,
    input
  });

  // embeddingRes is CreateEmbeddingResponse which has a data array
  return embeddingRes.data[0]?.embedding || [];
}
