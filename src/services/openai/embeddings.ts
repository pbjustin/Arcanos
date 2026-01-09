import OpenAI from 'openai';
import { getOpenAIClient } from './clientFactory.js';

const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

export async function createEmbedding(
  input: string,
  client: OpenAI | null = getOpenAIClient()
): Promise<number[]> {
  if (!client) {
    throw new Error('OpenAI client not initialized');
  }

  const embeddingRes = await client.embeddings.create({
    model: DEFAULT_EMBEDDING_MODEL,
    input
  });

  return embeddingRes.data[0].embedding;
}
