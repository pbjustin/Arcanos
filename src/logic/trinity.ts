import OpenAI from 'openai';
import { createResponseWithLogging } from '../utils/aiLogger.js';

interface TrinityResult {
  result: string;
  module: string;
  meta: {
    tokens?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    } | undefined;
    id: string;
    created: number;
  };
}

interface BrainHook {
  next_model: string;
  purpose?: string;
  input?: string;
}

// Check for the fine-tuned model, fallback to GPT-4 if unavailable
const MODEL_ID = process.env.MODEL_ID || "ft:arcanos-v2";

const validateModel = async (client: OpenAI) => {
  try {
    await client.models.retrieve(MODEL_ID);
    return MODEL_ID;
  } catch (err) {
    console.warn(`[ARCANOS WARNING] Model ${MODEL_ID} unavailable. Falling back to GPT-4.`);
    return "gpt-4";
  }
};

/**
 * Process a user prompt through the Trinity brain.
 * 1. Validate and get the available brain model (ft:arcanos-v2 or fallback to gpt-4).
 * 2. Send prompt to the brain model.
 * 3. If the brain responds with a JSON hook specifying next_model,
 *    route the request to that model.
 * 4. Send the external model's output back through the brain for finalization.
 */
export async function runThroughBrain(client: OpenAI, prompt: string): Promise<TrinityResult> {
  // Validate model availability and get the brain model to use
  const brainModel = await validateModel(client);

  // First pass: brain decides what to do
  const brainResponse = await createResponseWithLogging(client, {
    model: brainModel,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2,
    max_tokens: 1000,
  });

  const brainContent = brainResponse.choices[0]?.message?.content || '';
  let hook: BrainHook | null = null;

  try {
    hook = JSON.parse(brainContent);
    console.log(`[🧠 BRAIN DECISION]`, hook);
  } catch {
    // not a JSON hook, treat brainContent as final output
  }

  // If no hook, return brain's content as final
  if (!hook || !hook.next_model) {
    return {
      result: brainContent,
      module: brainModel,
      meta: {
        tokens: brainResponse.usage || undefined,
        id: brainResponse.id,
        created: brainResponse.created,
      },
    };
  }

  // External model execution
  const externalResponse = await createResponseWithLogging(client, {
    model: hook.next_model,
    messages: [{ role: 'user', content: hook.input || prompt }],
    temperature: 0,
    max_tokens: 1000,
  });

  const externalOutput = externalResponse.choices[0]?.message?.content || '';

  // Final pass: filter external output back through the brain
  const finalBrain = await createResponseWithLogging(client, {
    model: brainModel,
    messages: [
      { role: 'system', content: `External model (${hook.next_model}) responded. Craft the final answer for the user.` },
      { role: 'user', content: prompt },
      { role: 'assistant', content: externalOutput },
    ],
    temperature: 0.2,
    max_tokens: 1000,
  });

  const finalText = finalBrain.choices[0]?.message?.content || '';

  return {
    result: finalText,
    module: brainModel,
    meta: {
      tokens: finalBrain.usage || undefined,
      id: finalBrain.id,
      created: finalBrain.created,
    },
  };
}
