import { resolveGenerativeModel } from '@services/openai/credentialProvider.js';
import { runTrinityWritingPipeline } from '@core/logic/trinityWritingPipeline.js';
import { createRuntimeBudget } from '@platform/resilience/runtimeBudget.js';
import { getOpenAIClientOrAdapter } from '@services/openai/clientBridge.js';

type TrinityOptions = {
  prompt: string;
  model?: string;
  temperature?: number;
  structured?: boolean;
  latencyBudgetMs?: number;
};

function buildStructuredPrompt(prompt: string): string {
  return `${prompt}\n\nReturn a valid JSON object. The word json is intentionally present for JSON response mode.`;
}

/**
 * Purpose: execute the legacy fine-tuned Trinity route through the canonical Trinity generation facade.
 * Inputs/Outputs: prompt + compatibility options -> legacy response envelope backed by TrinityResult.
 * Edge cases: `model` may confirm the configured authority; conflicting overrides fail before execution. Temperature remains compatibility metadata.
 */
export async function runTrinity({
  prompt,
  model: requestedModel,
  temperature = 0.7,
  structured = true,
  latencyBudgetMs
}: TrinityOptions) {
  const model = resolveGenerativeModel('final', requestedModel);
  const { client } = getOpenAIClientOrAdapter();
  if (!client) {
    throw new Error('OpenAI client unavailable for query-finetune Trinity facade.');
  }

  const trinityResult = await runTrinityWritingPipeline({
    input: {
      prompt: structured ? buildStructuredPrompt(prompt) : prompt,
      moduleId: 'QUERY:FINETUNE',
      sourceEndpoint: 'query-finetune',
      requestedAction: 'query',
      body: {
        prompt,
        model,
        temperature,
        structured
      },
      executionMode: 'request'
    },
    context: {
      client,
      runtimeBudget: createRuntimeBudget(),
      runOptions: {
        answerMode: structured ? 'audit' : 'direct',
        strictUserVisibleOutput: true,
        ...(typeof latencyBudgetMs === 'number' && Number.isFinite(latencyBudgetMs) && latencyBudgetMs > 0
          ? { watchdogModelTimeoutMs: Math.trunc(latencyBudgetMs) }
          : {})
      }
    }
  });

  return {
    requestedModel: model,
    model: trinityResult.activeModel,
    activeModel: trinityResult.activeModel,
    output: trinityResult.result,
    fallbackFlag: trinityResult.fallbackFlag,
    fallbackReason: trinityResult.fallbackSummary.fallbackReasons.join('; ') || undefined,
    raw: trinityResult
  };
}
