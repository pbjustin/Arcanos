import OpenAI from 'openai';
import { getOpenAIClient, getDefaultModel } from './openai.js';

/**
 * Run the ARCANOS → GPT-4 → ARCANOS pipeline.
 *
 * The request is first routed through the ARCANOS fine-tuned model. If the
 * intake response includes the "USE_GPT5" flag the content is processed by
 * GPT-4 before being returned to ARCANOS for final shaping.
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
          'ARCANOS v2 core intake. Route input for optimal GPT-4 involvement without bypass.'
      },
      { role: 'user', content: userInput }
    ]
  });

  const routedTask = intake.choices[0]?.message?.content || '';

  // Step 2: optional GPT-4 processing
  let gpt4Output = '';
  if (routedTask.includes('USE_GPT4')) {
    const gpt4 = await client.chat.completions.create({
      model: 'gpt-4-turbo',
      messages: [
        {
          role: 'system',
          content:
            'Execute task as routed by ARCANOS. Return to ARCANOS for final shaping.'
        },
        { role: 'user', content: routedTask.replace('USE_GPT4', '').trim() }
      ]
    });
    gpt4Output = gpt4.choices[0]?.message?.content || '';
  }

  // Step 3: final shaping via ARCANOS
  const finalPass = await client.chat.completions.create({
    model: arcanosModel,
    messages: [
      {
        role: 'system',
        content:
          'Final output shaping. Ensure consistency with ARCANOS role, safeguards, and mania logic.'
      },
      { role: 'user', content: gpt4Output || routedTask }
    ]
  });

  return finalPass.choices[0]?.message?.content || '';
}

export default { runArcanosPipeline };

