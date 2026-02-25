import type OpenAI from 'openai';

import type { JobHandler } from '../jobs/index.js';
import { getWorkerOpenAIAdapter } from '../infrastructure/sdk/openai.js';

function extractOutputText(response: OpenAI.Responses.Response): string {
  if (typeof response.output_text === 'string' && response.output_text.length > 0) {
    return response.output_text;
  }

  const message = response.output.find(
    (item): item is OpenAI.Responses.ResponseOutputMessage => item.type === 'message'
  );

  const outputText = message?.content.find(
    (part): part is OpenAI.Responses.ResponseOutputText => part.type === 'output_text'
  );

  return outputText?.text ?? '';
}

export const openaiCompletionHandler: JobHandler<'OPENAI_COMPLETION'> = async ({ payload }) => {
  const adapter = getWorkerOpenAIAdapter();
  const { chatModel } = adapter.getDefaults();

  const response = await adapter.responses.create({
    model: payload.model ?? chatModel,
    input: [
      {
        role: 'user',
        content: payload.prompt
      }
    ]
  });

  return { response: extractOutputText(response) };
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
