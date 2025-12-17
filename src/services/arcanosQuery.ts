import { getOpenAIClient, getDefaultModel, getGPT5Model } from './openai.js';
import { ARCANOS_PROMPTS, buildMockArcanosResponse } from '../config/arcanosPrompts.js';

// Use centralized model configuration
const FT_MODEL = getDefaultModel();
const REASONING_MODEL = getGPT5Model();

function buildFineTunedMessages(prompt: string) {
  return [
    { role: 'system' as const, content: ARCANOS_PROMPTS.system },
    { role: 'user' as const, content: prompt }
  ];
}

function buildReasoningMessages(fineTunedOutput: string) {
  return [
    { role: 'system' as const, content: ARCANOS_PROMPTS.reasoningLayer },
    { role: 'user' as const, content: `Original fine-tuned model output:\n${fineTunedOutput}` }
  ];
}

export async function arcanosQuery(prompt: string): Promise<string> {
  try {
    // Get OpenAI client - will return null if no API key
    const client = getOpenAIClient();

    if (!client) {
      // Return mock response when no API key is configured
      return buildMockArcanosResponse(prompt, FT_MODEL);
    }

    // Step 1 → Fine-tuned GPT-4.1
    const ftResponse = await client.chat.completions.create({
      model: FT_MODEL,
      messages: buildFineTunedMessages(prompt)
    });

    const ftOutput = ftResponse.choices[0].message.content || '';

    // Step 2 → Reasoning with GPT-5.2
    const reasoningResponse = await client.chat.completions.create({
      model: REASONING_MODEL,
      messages: buildReasoningMessages(ftOutput)
    });

    return reasoningResponse.choices[0].message.content || '';
  } catch (error) {
    console.error('ARCANOS error:', error);
    throw error;
  }
}
