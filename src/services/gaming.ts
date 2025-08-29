import { openai } from '../clients/openai.js';
import { getDefaultModel, getGPT5Model } from './openai.js';

const FINETUNE_MODEL = process.env.FINETUNE_MODEL || getDefaultModel();

export async function runGaming(userPrompt: string) {
  if (!openai) throw new Error('OpenAI client not initialized');
  try {
    // Step 1: Fine-tuned ARCANOS Intake
    const intake = await openai.chat.completions.create({
      model: FINETUNE_MODEL,
      messages: [
        { role: 'system', content: 'ARCANOS Intake: Route to Gaming module.' },
        { role: 'user', content: userPrompt }
      ]
    });
    const refinedPrompt = intake.choices[0].message?.content || '';

    // Step 2: GPT-5 Reasoning (Hotline Advisor Mode)
    const gpt5 = await openai.chat.completions.create({
      model: getGPT5Model(),
      messages: [
        {
          role: 'system',
          content:
            'You are ARCANOS:GAMING, a Nintendo-style hotline advisor. Provide strategies, hints, tips, and walkthroughs. Speak like a professional hotline guide: friendly, knowledgeable, and interactive.'
        },
        { role: 'user', content: refinedPrompt }
      ],
      temperature: 0.6
    });
    const reasoningOutput = gpt5.choices[0].message?.content || '';

    // Step 3: Fine-tuned ARCANOS Audit
    const audit = await openai.chat.completions.create({
      model: FINETUNE_MODEL,
      messages: [
        { role: 'system', content: 'ARCANOS Audit: Validate Gaming module response for clarity, safety, and alignment.' },
        { role: 'user', content: reasoningOutput }
      ]
    });

    const finalized = audit.choices[0].message?.content || '';

    return {
      gaming_response: finalized,
      audit_trace: {
        intake: refinedPrompt,
        reasoning: reasoningOutput,
        finalized
      }
    };
  } catch (err) {
    console.error('❌ ARCANOS:GAMING Error:', err);
    throw err;
  }
}
