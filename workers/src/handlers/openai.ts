import OpenAI from 'openai';
import type { JobHandler } from '../jobs/index.js';

const client = new OpenAI();

export const openaiCompletionHandler: JobHandler<'OPENAI_COMPLETION'> = async ({ payload }) => {
  const response = await client.chat.completions.create({
    model: payload.model ?? 'gpt-4-turbo',
    messages: [{ role: 'user', content: payload.prompt }]
  });

  return { response: response.choices[0].message?.content ?? '' };
};

export const openaiEmbeddingHandler: JobHandler<'OPENAI_EMBEDDING'> = async ({ payload }) => {
  const response = await client.embeddings.create({
    model: payload.model ?? 'text-embedding-3-large',
    input: payload.input
  });

  return { embedding: response.data[0]?.embedding ?? [] };
};
