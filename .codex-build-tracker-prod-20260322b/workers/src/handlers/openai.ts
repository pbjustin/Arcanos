import type { JobHandler } from '../jobs/index.js';
import { getWorkerOpenAIAdapter } from '../infrastructure/sdk/openai.js';

function extractOutputText(response: { output_text?: unknown; output?: unknown[] }): string {
  //audit Assumption: responses may or may not expose output_text shortcut; risk: empty worker payload despite valid output; invariant: return first textual output part when available; handling: fallback scan through output content blocks.
  if (typeof response.output_text === 'string' && response.output_text.length > 0) {
    return response.output_text;
  }

  const outputItems = Array.isArray(response.output) ? response.output : [];
  for (const outputItem of outputItems) {
    if (!outputItem || typeof outputItem !== 'object') {
      continue;
    }
    const typedOutputItem = outputItem as Record<string, unknown>;
    const content = Array.isArray(typedOutputItem.content) ? typedOutputItem.content : [];
    for (const contentItem of content) {
      if (!contentItem || typeof contentItem !== 'object') {
        continue;
      }
      const typedContentItem = contentItem as Record<string, unknown>;
      if (typedContentItem.type === 'output_text' && typeof typedContentItem.text === 'string') {
        return typedContentItem.text;
      }
    }
  }

  return '';
}

export const openaiCompletionHandler: JobHandler<'OPENAI_COMPLETION'> = async ({ payload }) => {
  const adapter = getWorkerOpenAIAdapter();
  const { chatModel } = adapter.getDefaults();
  const response = await adapter.responses.create({
    model: payload.model ?? chatModel,
    input: [{ role: 'user', content: [{ type: 'input_text', text: payload.prompt }] }]
  });

  return { response: extractOutputText(response as { output_text?: unknown; output?: unknown[] }) };
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
