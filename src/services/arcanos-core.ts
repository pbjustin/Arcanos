import { runThroughBrain } from '@core/logic/trinity.js';
import { generateMockResponse } from '@services/openai.js';
import { getOpenAIClientOrAdapter } from '@services/openai/clientBridge.js';
import { createRuntimeBudget } from '@platform/resilience/runtimeBudget.js';
import { buildTrinityOutputControlOptions } from '@shared/ask/trinityRequestOptions.js';
import type { AIRequestDTO } from '@shared/types/dto.js';

interface ArcanosCoreQueryPayload extends Partial<AIRequestDTO> {
  message?: string;
  overrideAuditSafe?: string;
}

export const ArcanosCore = {
  name: 'ARCANOS:CORE',
  description: 'Primary ARCANOS entryway that routes prompt-first requests through the Trinity core pipeline.',
  gptIds: ['arcanos-core', 'core'],
  defaultAction: 'query',
  defaultTimeoutMs: 60000,
  actions: {
    async query(payload: unknown) {
      const normalizedPayload = normalizeCorePayload(payload);
      const prompt = extractCorePrompt(normalizedPayload);

      if (!prompt) {
        throw new Error('ARCANOS:CORE query requires a text prompt.');
      }

      const { client } = getOpenAIClientOrAdapter();
      if (!client) {
        return generateMockResponse(prompt, 'gpt/arcanos-core');
      }

      return runThroughBrain(
        client,
        prompt,
        normalizedPayload.sessionId,
        normalizedPayload.overrideAuditSafe,
        {
          sourceEndpoint: 'gpt.arcanos-core.query',
          ...buildTrinityOutputControlOptions(normalizedPayload)
        },
        createRuntimeBudget()
      );
    },
  },
};

export default ArcanosCore;

function normalizeCorePayload(payload: unknown): ArcanosCoreQueryPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return typeof payload === 'string' ? { prompt: payload } : {};
  }

  return payload as ArcanosCoreQueryPayload;
}

function extractCorePrompt(payload: ArcanosCoreQueryPayload): string {
  for (const candidate of [
    payload.prompt,
    payload.message,
    payload.userInput,
    payload.content,
    payload.text,
    payload.query
  ]) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return '';
}
