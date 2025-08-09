import OpenAI from 'openai';
import { getOpenAIClient, getDefaultModel } from './openai.js';

/**
 * Run the ARCANOS → GPT-5 → ARCANOS pipeline.
 *
 * Updated per AI-CORE routing requirements:
 * ALL requests now follow: ARCANOS Intake → GPT-5 Primary Reasoning → ARCANOS Execution
 * No conditional logic - GPT-5 is ALWAYS engaged as the primary reasoning stage.
 *
 * @param userInput - The raw user input to process
 * @returns The final ARCANOS-shaped response
 */
export async function runArcanosPipeline(userInput: string): Promise<string> {
  const client = getOpenAIClient();
  if (!client) {
    throw new Error('OpenAI client not initialized');
  }

  const arcanosModel = getDefaultModel();

  // Step 1: intake through ARCANOS
  const intake = await client.chat.completions.create({
    model: arcanosModel,
    messages: [
      {
        role: 'system',
        content:
          'ARCANOS v2 intake core. Frame all input for mandatory GPT-5 primary reasoning stage per AI-CORE routing requirements.'
      },
      { role: 'user', content: userInput }
    ]
  });

  const routedTask = intake.choices[0]?.message?.content || '';

  // Step 2: MANDATORY GPT-5 primary reasoning stage (no conditional logic)
  console.log('[🧠 PIPELINE] Engaging GPT-5 primary reasoning stage (unconditional per AI-CORE routing)');
  const gpt5 = await client.chat.completions.create({
    model: 'gpt-5', // Using GPT-5 as per AI-CORE routing requirements
    messages: [
      {
        role: 'system',
        content: 'ARCANOS: Use GPT-5 for deep reasoning on every request. Return structured analysis only.'
      },
      { 
        role: 'user', 
        content: userInput // Direct framed user request 
      }
    ]
  });
  const gpt5Output = gpt5.choices[0]?.message?.content || '';

  // Step 3: final execution and delivery via ARCANOS (always processes GPT-5 output)
  const finalPass = await client.chat.completions.create({
    model: arcanosModel,
    messages: [
      {
        role: 'system',
        content:
          'Final execution phase. Process GPT-5 primary reasoning output with ARCANOS safeguards, consistency, and final delivery logic.'
      },
      { 
        role: 'user', 
        content: `Original request: ${userInput}\n\nGPT-5 primary reasoning output: ${gpt5Output}\n\nProvide final ARCANOS response with safety filtering and tone adjustment.`
      }
    ]
  });

  return finalPass.choices[0]?.message?.content || '';
}

export default { runArcanosPipeline };

