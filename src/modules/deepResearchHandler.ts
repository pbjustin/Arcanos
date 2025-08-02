import OpenAI from 'openai';
import { getMemory, storeMemory } from '../services/memory';

export interface DeepResearchResult {
  phase1: string;
  phase2: string;
  phase3: string;
  phase4?: string;
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function sanitizeKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+$/, '');
}

export async function runDeepResearch(prompt: string, context: any = {}): Promise<DeepResearchResult> {
  const horizon = context.horizon || 3; // default forecast horizon in years
  const memoryKey = `deepResearch/${sanitizeKey(prompt)}/forecast`;

  // Phase 1 - Historical Context
  const phase1Completion = await openai.chat.completions.create({
    model: 'gpt-4',
    temperature: 0.5,
    messages: [
      { role: 'system', content: 'Extract relevant historical patterns or technological benchmarks.' },
      { role: 'user', content: prompt }
    ]
  });
  const phase1 = phase1Completion.choices[0].message.content?.trim() || '';

  // Phase 2 - Present-Day Assessment
  const presentPrompt = context
    ? `${prompt}\n\nContext: ${JSON.stringify(context)}`
    : prompt;
  const phase2Completion = await openai.chat.completions.create({
    model: 'gpt-4',
    temperature: 0.5,
    messages: [
      { role: 'system', content: 'Assess current capabilities and trends.' },
      { role: 'user', content: presentPrompt }
    ]
  });
  const phase2 = phase2Completion.choices[0].message.content?.trim() || '';

  // Phase 3 - Predictive Forecasting
  const forecastPrompt = `${prompt}\nForecast horizon: ${horizon} years`;
  const phase3Completion = await openai.chat.completions.create({
    model: 'gpt-4',
    temperature: 0.5,
    messages: [
      { role: 'system', content: 'Project outcomes or advancements over the specified horizon.' },
      { role: 'user', content: forecastPrompt }
    ]
  });
  const phase3 = phase3Completion.choices[0].message.content?.trim() || '';

  // Phase 4 - Memory Overlay (optional)
  let phase4: string | undefined;
  try {
    const previous = await getMemory(memoryKey);
    if (previous) {
      const comparisonPrompt = `Previous forecast:\n${previous}\n\nNew forecast:\n${phase3}\n\nSummarize key changes as evolution deltas.`;
      const deltaCompletion = await openai.chat.completions.create({
        model: 'gpt-4',
        temperature: 0.5,
        messages: [
          { role: 'system', content: 'Compare forecasts and highlight differences.' },
          { role: 'user', content: comparisonPrompt }
        ]
      });
      phase4 = deltaCompletion.choices[0].message.content?.trim() || '';
    }
    await storeMemory(memoryKey, phase3);
  } catch (err) {
    console.warn('Memory overlay failed:', err);
  }

  return { phase1, phase2, phase3, ...(phase4 && { phase4 }) };
}

export default { runDeepResearch };
