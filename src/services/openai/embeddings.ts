import type OpenAI from 'openai';
import type { OpenAIAdapter } from '../../adapters/openai.adapter.js';
import { getOpenAIAdapter } from '../../adapters/openai.adapter.js';

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
      chat: { completions: { create: (params) => client.chat.completions.create(params) } },
      embeddings: { create: (params) => client.embeddings.create(params) },
      audio: { transcriptions: { create: (params) => client.audio.transcriptions.create(params) } },
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

  return embeddingRes.data[0].embedding;
}
