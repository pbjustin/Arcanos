import OpenAI from 'openai';
import { createCompletionWithLogging } from '../utils/aiLogger.js';

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

/**
 * Process a user prompt through the Trinity brain.
 * 1. Send prompt to ft:arcanos-v2.
 * 2. If the brain responds with a JSON hook specifying next_model,
 *    route the request to that model.
 * 3. Send the external model's output back through the brain for finalization.
 */
export async function runThroughBrain(client: OpenAI, prompt: string): Promise<TrinityResult> {
  const brainModel = 'ft:arcanos-v2';

  // First pass: brain decides what to do
  const brainResponse = await createCompletionWithLogging(client, {
    model: brainModel,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2,
    max_tokens: 1000,
    stream: false,
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
  const externalResponse = await createCompletionWithLogging(client, {
    model: hook.next_model,
    messages: [{ role: 'user', content: hook.input || prompt }],
    temperature: 0,
    max_tokens: 1000,
    stream: false,
  });

  const externalOutput = externalResponse.choices[0]?.message?.content || '';

  // Final pass: filter external output back through the brain
  const finalBrain = await createCompletionWithLogging(client, {
    model: brainModel,
    messages: [
      { role: 'system', content: `External model (${hook.next_model}) responded. Craft the final answer for the user.` },
      { role: 'user', content: prompt },
      { role: 'assistant', content: externalOutput },
    ],
    temperature: 0.2,
    max_tokens: 1000,
    stream: false,
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
