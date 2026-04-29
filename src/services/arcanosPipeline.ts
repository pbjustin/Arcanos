import type OpenAI from 'openai';

import { runTrinityWritingPipeline } from '@core/logic/trinityWritingPipeline.js';
import type { TrinityResult } from '@core/logic/trinity.js';
import { createRuntimeBudget } from '@platform/resilience/runtimeBudget.js';
import { ARCANOS_PIPELINE_PROMPTS } from "@platform/runtime/arcanosPipelinePrompts.js";
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { requireOpenAIClientOrAdapter } from './openai/clientBridge.js';

export interface PipelineStages {
  arcFirst: OpenAI.Chat.Completions.ChatCompletionMessage;
  subAgent: OpenAI.Chat.Completions.ChatCompletionMessage;
  gpt5Reasoning: OpenAI.Chat.Completions.ChatCompletionMessage;
}

export interface PipelineResult {
  result: OpenAI.Chat.Completions.ChatCompletionMessage;
  stages?: PipelineStages;
  fallback: boolean;
  meta: TrinityResult['meta'];
  activeModel: string;
  routingStages?: string[];
}

function buildAssistantMessage(content: string): OpenAI.Chat.Completions.ChatCompletionMessage {
  return {
    role: 'assistant',
    content,
    refusal: null
  };
}

function assistantContent(message: OpenAI.Chat.Completions.ChatCompletionMessage): string {
  return typeof message.content === 'string' ? message.content : '';
}

async function runPipelineStage(params: {
  client: OpenAI;
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  stage: string;
  body?: Record<string, unknown>;
}): Promise<{ message: OpenAI.Chat.Completions.ChatCompletionMessage; trinity: TrinityResult }> {
  const trinity = await runTrinityWritingPipeline({
    input: {
      messages: params.messages,
      moduleId: 'ARCANOS:PIPELINE',
      sourceEndpoint: `arcanos-pipeline.${params.stage}`,
      requestedAction: 'query',
      body: {
        stage: params.stage,
        messages: params.messages,
        ...(params.body ?? {})
      },
      executionMode: 'request',
      background: {
        legacyPipelineStage: params.stage
      }
    },
    context: {
      client: params.client,
      runtimeBudget: createRuntimeBudget(),
      runOptions: {
        answerMode: 'direct',
        strictUserVisibleOutput: true
      }
    }
  });

  return {
    message: buildAssistantMessage(trinity.result),
    trinity
  };
}

export async function executeArcanosPipeline(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
): Promise<PipelineResult> {
  const { client } = requireOpenAIClientOrAdapter('OpenAI adapter not available');

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('Legacy ARCANOS pipeline requires at least one text message.');
  }

  try {
    const arcFirst = await runPipelineStage({
      client,
      messages,
      stage: 'arc-first'
    });
    const subAgent = await runPipelineStage({
      client,
      messages: [
        { role: 'system', content: ARCANOS_PIPELINE_PROMPTS.subAgent },
        { role: 'assistant', content: assistantContent(arcFirst.message) }
      ],
      stage: 'sub-agent'
    });
    const gpt5Reasoning = await runPipelineStage({
      client,
      messages: [
        { role: 'system', content: ARCANOS_PIPELINE_PROMPTS.overseer },
        { role: 'assistant', content: assistantContent(arcFirst.message) },
        { role: 'assistant', content: assistantContent(subAgent.message) }
      ],
      stage: 'overseer'
    });
    const final = await runPipelineStage({
      client,
      messages: [
        ...messages,
        { role: 'assistant', content: assistantContent(arcFirst.message) },
        { role: 'assistant', content: assistantContent(subAgent.message) },
        { role: 'assistant', content: assistantContent(gpt5Reasoning.message) }
      ],
      stage: 'final'
    });

    return {
      result: final.message,
      stages: {
        arcFirst: arcFirst.message,
        subAgent: subAgent.message,
        gpt5Reasoning: gpt5Reasoning.message
      },
      fallback: false,
      meta: final.trinity.meta,
      activeModel: final.trinity.activeModel,
      routingStages: final.trinity.routingStages
    };
  } catch (error) {
    console.warn('Primary ARCANOS Trinity pipeline failed, using Trinity fallback stage', resolveErrorMessage(error));
    const fallback = await runPipelineStage({
      client,
      messages,
      stage: 'fallback',
      body: {
        fallbackReason: resolveErrorMessage(error)
      }
    });

    return {
      result: fallback.message,
      fallback: true,
      meta: fallback.trinity.meta,
      activeModel: fallback.trinity.activeModel,
      routingStages: fallback.trinity.routingStages
    };
  }
}
