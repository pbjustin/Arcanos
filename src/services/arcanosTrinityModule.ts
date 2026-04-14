import { runTrinityWritingPipeline } from '@core/logic/trinityWritingPipeline.js';
import { createRuntimeBudget } from '@platform/resilience/runtimeBudget.js';
import { buildTrinityOutputControlOptions } from '@shared/ask/trinityRequestOptions.js';
import type { AIRequestDTO } from '@shared/types/dto.js';
import { generateMockResponse } from './openai.js';
import { getOpenAIClientOrAdapter } from './openai/clientBridge.js';
import type { ModuleDef } from './moduleLoader.js';

interface TrinityModulePayload extends Partial<AIRequestDTO> {
  message?: string;
}

interface CreateArcanosTrinityModuleOptions {
  name: string;
  description: string;
  gptIds: string[];
  sourceEndpoint: string;
  mockEndpoint: string;
}

/**
 * Create a thin GPT/module registration wrapper around the Trinity pipeline.
 * Inputs/outputs: module metadata -> ModuleDef with a single `query` action.
 * Edge cases: scalar payloads are normalized to prompt objects so legacy GPT callers keep working.
 */
export function createArcanosTrinityModule(
  options: CreateArcanosTrinityModuleOptions
): ModuleDef {
  return {
    name: options.name,
    description: options.description,
    gptIds: options.gptIds,
    defaultAction: 'query',
    defaultTimeoutMs: 60000,
    actions: {
      async query(payload: unknown) {
        const normalizedPayload = normalizeTrinityPayload(payload);
        const prompt = extractTrinityPrompt(normalizedPayload);

        if (!prompt) {
          throw new Error(`${options.name} query requires a text prompt.`);
        }

        const { client } = getOpenAIClientOrAdapter();
        if (!client) {
          return generateMockResponse(prompt, options.mockEndpoint);
        }

        return runTrinityWritingPipeline({
          input: {
            prompt,
            sessionId: normalizedPayload.sessionId,
            overrideAuditSafe: normalizedPayload.overrideAuditSafe,
            sourceEndpoint: options.sourceEndpoint,
            body: normalizedPayload
          },
          context: {
            client,
            requestId: normalizedPayload.sessionId,
            runtimeBudget: createRuntimeBudget(),
            runOptions: buildTrinityOutputControlOptions(normalizedPayload)
          }
        });
      }
    }
  };
}

function normalizeTrinityPayload(payload: unknown): TrinityModulePayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return typeof payload === 'string' ? { prompt: payload } : {};
  }

  return payload as TrinityModulePayload;
}

function extractTrinityPrompt(payload: TrinityModulePayload): string {
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
