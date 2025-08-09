import OpenAI from 'openai';
import { getOpenAIClient, getDefaultModel } from './openai.js';

/**
 * Run the ARCANOS → GPT-5 → ARCANOS pipeline.
 *
 * The request is first routed through the ARCANOS fine-tuned model. If the
 * intake response includes the "USE_GPT5" flag the content is processed by
 * GPT-5 before being returned to ARCANOS for final shaping.
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
          'ARCANOS v2 core intake. Route input for optimal GPT-5 involvement without bypass.'
      },
      { role: 'user', content: userInput }
    ]
  });

  const routedTask = intake.choices[0]?.message?.content || '';

  // Step 2: optional GPT-5 processing
  let gpt5Output = '';
  if (routedTask.includes('USE_GPT5')) {
    const gpt5 = await client.chat.completions.create({
      model: 'gpt-5',
      messages: [
        {
          role: 'system',
          content:
            'Execute task as routed by ARCANOS. Return to ARCANOS for final shaping.'
        },
        { role: 'user', content: routedTask.replace('USE_GPT5', '').trim() }
      ]
    });
    gpt5Output = gpt5.choices[0]?.message?.content || '';
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
      { role: 'user', content: gpt5Output || routedTask }
    ]
  });

  return finalPass.choices[0]?.message?.content || '';
}

export default { runArcanosPipeline };

