import type { JobHandler } from '../jobs/index.js';
import { getWorkerOpenAIAdapter } from '../infrastructure/sdk/openai.js';

export const openaiCompletionHandler: JobHandler<'OPENAI_COMPLETION'> = async ({ payload }) => {
  const adapter = getWorkerOpenAIAdapter();
  const { chatModel } = adapter.getDefaults();
  const response = await adapter.responses.create({
    model: payload.model ?? chatModel,
    messages: [{ role: 'user', content: payload.prompt }]
  });

  return { response: response.choices[0].message?.content ?? '' };
};

export const openaiEmbeddingHandler: JobHandler<'OPENAI_EMBEDDING'> = async ({ payload }) => {
  const adapter = getWorkerOpenAIAdapter();
  const { embeddingModel } = adapter.getDefaults();
  const response = await adapter.embeddings.create({
    model: payload.model ?? embeddingModel,
    input: payload.input
  });

  return { embedding: response.data[0]?.embedding ?? [] };
};
