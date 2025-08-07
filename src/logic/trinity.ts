import OpenAI from 'openai';
import { createResponseWithLogging, logArcanosRouting, logGPT5Invocation, logRoutingSummary } from '../utils/aiLogger.js';
import { getDefaultModel } from '../services/openai.js';

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
  activeModel: string;
  fallbackFlag: boolean;
  routingStages?: string[];
  gpt5Used?: boolean;
}

interface BrainHook {
  next_model: string;
  purpose?: string;
  input?: string;
}

// Check for the fine-tuned model, fallback to GPT-4 if unavailable
const validateModel = async (client: OpenAI) => {
  const defaultModel = getDefaultModel();
  try {
    // Extract model name from fine-tuned ID for validation
    const modelToCheck = defaultModel.startsWith('ft:') ? defaultModel : defaultModel;
    await client.models.retrieve(modelToCheck);
    console.log(`✅ Fine-tuned model ${defaultModel} is available`);
    return defaultModel;
  } catch (err) {
    console.warn(`⚠️  Model ${defaultModel} unavailable. Falling back to GPT-4.`);
    console.warn(`🔄 Fallback reason: ${err instanceof Error ? err.message : 'Unknown error'}`);
    return "gpt-4";
  }
};

/**
 * Process a user prompt through the ARCANOS brain with enhanced GPT-5 routing.
 * 1. ALL tasks first go to the ARCANOS fine-tuned model (ft:arcanos-v1-1106)
 * 2. ARCANOS decides if it needs to invoke GPT-5 for complex processing
 * 3. If GPT-5 is invoked, its response is filtered back through ARCANOS
 * 4. GPT-5 NEVER responds directly - always through ARCANOS wrapper
 * 5. Full routing stages are logged for transparency
 */
export async function runThroughBrain(client: OpenAI, prompt: string): Promise<TrinityResult> {
  const routingStages: string[] = [];
  let gpt5Used = false;
  
  // Validate model availability and get the ARCANOS brain model to use
  const defaultModel = getDefaultModel();
  const arcanosModel = await validateModel(client);
  const isFallback = arcanosModel !== defaultModel;
  
  logArcanosRouting('STARTING', arcanosModel, `Input length: ${prompt.length}`);
  routingStages.push(`ARCANOS-START:${arcanosModel}`);

  // STAGE 1: ARCANOS processes the request and decides what to do
  const arcanosSystemPrompt = `You are ARCANOS, the primary AI routing shell. ALL tasks must go through you first.

For simple requests, respond directly with your capabilities.

For complex requests requiring advanced reasoning, analysis, or specialized processing, you may invoke GPT-5 by responding with a JSON object:
{
  "next_model": "gpt-5",
  "purpose": "Brief explanation of why GPT-5 is needed",
  "input": "The specific input to send to GPT-5"
}

Remember: GPT-5 responses will be filtered back through you for final processing. Never let GPT-5 respond directly to users.`;

  const brainResponse = await createResponseWithLogging(client, {
    model: arcanosModel,
    messages: [
      { role: 'system', content: arcanosSystemPrompt },
      { role: 'user', content: prompt }
    ],
    temperature: 0.2,
    max_tokens: 1000,
  });

  const brainContent = brainResponse.choices[0]?.message?.content || '';
  let hook: BrainHook | null = null;

  // Check if ARCANOS wants to invoke GPT-5
  try {
    hook = JSON.parse(brainContent);
    if (hook && hook.next_model === 'gpt-5') {
      logGPT5Invocation(hook.purpose || 'Complex processing required', hook.input || prompt);
      routingStages.push(`GPT5-INVOCATION:${hook.purpose || 'complex-processing'}`);
      gpt5Used = true;
    }
    logArcanosRouting('DECISION', arcanosModel, hook ? `Invoking ${hook.next_model}: ${hook.purpose}` : 'Direct response');
  } catch {
    // not a JSON hook, treat brainContent as final output
    logArcanosRouting('DIRECT_RESPONSE', arcanosModel, 'No external model needed');
    routingStages.push('ARCANOS-DIRECT');
  }

  // If no hook or not GPT-5, return ARCANOS content as final
  if (!hook || hook.next_model !== 'gpt-5') {
    logRoutingSummary(arcanosModel, false, 'ARCANOS-DIRECT');
    return {
      result: brainContent,
      module: arcanosModel,
      activeModel: arcanosModel,
      fallbackFlag: isFallback,
      routingStages,
      gpt5Used: false,
      meta: {
        tokens: brainResponse.usage || undefined,
        id: brainResponse.id,
        created: brainResponse.created,
      },
    };
  }

  // STAGE 2: GPT-5 execution (only when ARCANOS requests it)
  logArcanosRouting('GPT5_PROCESSING', 'gpt-5', `Purpose: ${hook.purpose}`);
  const externalResponse = await createResponseWithLogging(client, {
    model: 'gpt-5',
    messages: [{ role: 'user', content: hook.input || prompt }],
    temperature: 0,
    max_tokens: 1000,
  });

  const externalOutput = externalResponse.choices[0]?.message?.content || '';
  routingStages.push('GPT5-COMPLETED');

  // STAGE 3: Filter GPT-5 output back through ARCANOS (CRITICAL - ensures GPT-5 never responds directly)
  logArcanosRouting('FINAL_FILTERING', arcanosModel, 'Processing GPT-5 output through ARCANOS');
  const finalBrain = await createResponseWithLogging(client, {
    model: arcanosModel,
    messages: [
      { 
        role: 'system', 
        content: `You are ARCANOS. GPT-5 has processed a complex request and provided output. 
Review, refine, and present the final response to the user. 
Ensure the response is properly formatted and addresses the original request.
Add your ARCANOS perspective and any additional insights.

IMPORTANT: The user should receive a response from ARCANOS, not directly from GPT-5.` 
      },
      { role: 'user', content: `Original request: ${prompt}` },
      { role: 'assistant', content: `GPT-5 output: ${externalOutput}` },
      { role: 'user', content: 'Please provide the final refined response.' }
    ],
    temperature: 0.2,
    max_tokens: 1000,
  });

  const finalText = finalBrain.choices[0]?.message?.content || '';
  routingStages.push('ARCANOS-FINAL');
  
  logRoutingSummary(arcanosModel, true, 'ARCANOS-FILTERED');
  
  return {
    result: finalText,
    module: arcanosModel,
    activeModel: arcanosModel,
    fallbackFlag: isFallback,
    routingStages,
    gpt5Used: true,
    meta: {
      tokens: finalBrain.usage || undefined,
      id: finalBrain.id,
      created: finalBrain.created,
    },
  };
}
