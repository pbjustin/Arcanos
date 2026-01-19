import OpenAI from 'openai';
import { getDefaultModel, getGPT5Model, getOpenAIClient } from './openai.js';
import { ARCANOS_PIPELINE_PROMPTS } from '../config/arcanosPipelinePrompts.js';

const ARC_V2 = getDefaultModel();
const ARC_V2_FALLBACK = 'gpt-4o-mini';
const GPT5 = getGPT5Model();
const GPT35_SUBAGENT = 'gpt-4o-mini';

export interface PipelineStages {
  arcFirst: OpenAI.Chat.Completions.ChatCompletionMessage;
  subAgent: OpenAI.Chat.Completions.ChatCompletionMessage;
  gpt5Reasoning: OpenAI.Chat.Completions.ChatCompletionMessage;
}

export interface PipelineResult {
  result: OpenAI.Chat.Completions.ChatCompletionMessage;
  stages?: PipelineStages;
  fallback: boolean;
}

export async function executeArcanosPipeline(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
): Promise<PipelineResult> {
  const client = getOpenAIClient();

  if (!client) {
    throw new Error('OpenAI client not available');
  }

  try {
    const arcFirst = await client.chat.completions.create({
      model: ARC_V2,
      messages
    });
    const arcFirstOutput = arcFirst.choices[0].message;

    const subAgentResp = await client.chat.completions.create({
      model: GPT35_SUBAGENT,
      messages: [
        { role: 'system', content: ARCANOS_PIPELINE_PROMPTS.subAgent },
        { role: 'assistant', content: arcFirstOutput.content || '' }
      ]
    });
    const subAgentOutput = subAgentResp.choices[0].message;

    const gpt5Response = await client.chat.completions.create({
      model: GPT5,
      messages: [
        { role: 'system', content: ARCANOS_PIPELINE_PROMPTS.overseer },
        { role: 'assistant', content: arcFirstOutput.content || '' },
        { role: 'assistant', content: subAgentOutput.content || '' }
      ]
    });
    const gpt5Reasoning = gpt5Response.choices[0].message;

    const arcFinal = await client.chat.completions.create({
      model: ARC_V2,
      messages: [
        ...messages,
        { role: 'assistant', content: arcFirstOutput.content || '' },
        { role: 'assistant', content: subAgentOutput.content || '' },
        { role: 'assistant', content: gpt5Reasoning.content || '' }
      ]
    });
    const finalOutput = arcFinal.choices[0].message;

    return {
      result: finalOutput,
      stages: {
        arcFirst: arcFirstOutput,
        subAgent: subAgentOutput,
        gpt5Reasoning
      },
      fallback: false
    };
  } catch (err) {
    console.warn('Primary ARCANOS pipeline failed, using fallback model', err);
    const fallback = await client.chat.completions.create({
      model: ARC_V2_FALLBACK,
      messages
    });

    return { result: fallback.choices[0].message, fallback: true };
  }
}
