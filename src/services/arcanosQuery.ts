import { runTrinityWritingPipeline } from '@core/logic/trinityWritingPipeline.js';
import { createRuntimeBudget } from '@platform/resilience/runtimeBudget.js';
import { buildMockArcanosResponse } from "@platform/runtime/arcanosPrompts.js";
import { getDefaultModel } from './openai.js';
import { getOpenAIClientOrAdapter } from './openai/clientBridge.js';

// Use centralized model configuration for mock compatibility only.
const FT_MODEL = getDefaultModel();

/**
 * Purpose: Execute the ARCANOS query surface through the canonical Trinity generation facade.
 * Inputs/Outputs: Accepts a text prompt and returns a finalized response string.
 * Edge cases: Falls back to mock output when no client is configured.
 */
export async function arcanosQuery(prompt: string): Promise<string> {
  const { client } = getOpenAIClientOrAdapter();

  if (!client) {
    return buildMockArcanosResponse(prompt, FT_MODEL);
  }

  const result = await runTrinityWritingPipeline({
    input: {
      prompt,
      moduleId: 'ARCANOS:QUERY',
      sourceEndpoint: 'arcanosQuery',
      requestedAction: 'query',
      body: { prompt },
      executionMode: 'request'
    },
    context: {
      client,
      runtimeBudget: createRuntimeBudget(),
      runOptions: {
        answerMode: 'direct',
        strictUserVisibleOutput: true
      }
    }
  });

  return result.result;
}
