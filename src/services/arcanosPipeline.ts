import type OpenAI from 'openai';

import { runTrinityWritingPipeline } from '@core/logic/trinityWritingPipeline.js';
import type { TrinityResult } from '@core/logic/trinity.js';
import { createRuntimeBudget } from '@platform/resilience/runtimeBudget.js';
import { requireOpenAIClientOrAdapter } from './openai/clientBridge.js';

export interface PipelineStages {
  trinity: OpenAI.Chat.Completions.ChatCompletionMessage;
}

export interface PipelineResult {
  result: OpenAI.Chat.Completions.ChatCompletionMessage;
  stages?: PipelineStages;
  fallback: boolean;
  meta: TrinityResult['meta'];
  activeModel: string;
  routingStages?: string[];
}

function extractMessageContent(message: OpenAI.Chat.Completions.ChatCompletionMessageParam): string {
  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  return '';
}

function messagesToPrompt(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): string {
  return messages
    .map((message) => {
      const role = typeof message.role === 'string' ? message.role : 'message';
      const content = extractMessageContent(message).trim();
      return content ? `${role}: ${content}` : '';
    })
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function buildAssistantMessage(content: string): OpenAI.Chat.Completions.ChatCompletionMessage {
  return {
    role: 'assistant',
    content,
    refusal: null
  };
}

export async function executeArcanosPipeline(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
): Promise<PipelineResult> {
  const { client } = requireOpenAIClientOrAdapter('OpenAI adapter not available');
  const prompt = messagesToPrompt(messages);

  if (!prompt) {
    throw new Error('Legacy ARCANOS pipeline requires at least one text message.');
  }

  const trinityResult = await runTrinityWritingPipeline({
    input: {
      prompt,
      moduleId: 'ARCANOS:PIPELINE',
      sourceEndpoint: 'arcanos-pipeline',
      requestedAction: 'query',
      body: {
        messages
      }
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

  const result = buildAssistantMessage(trinityResult.result);
  return {
    result,
    stages: {
      trinity: result
    },
    fallback: trinityResult.fallbackFlag,
    meta: trinityResult.meta,
    activeModel: trinityResult.activeModel,
    routingStages: trinityResult.routingStages
  };
}
