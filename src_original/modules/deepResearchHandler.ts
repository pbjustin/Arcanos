import OpenAI from 'openai';
import { getMemory, storeMemory } from '../services/memory.js';

/**
 * Structured result for the deep research flow
 */
export interface DeepResearchAnalysis {
  historicalGrounding: string;
  presentCondition: string;
  predictiveForecast: string;
  memoryComparison?: string;
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function sanitizeKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+$/, '');
}

async function queryOpenAI(system: string, user: string): Promise<string> {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4',
    temperature: 0.5,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  return completion.choices[0].message.content?.trim() || '';
}

/**
 * Run a four phase deep research analysis.
 */
export async function runDeepResearch(prompt: string, context: any = {}): Promise<DeepResearchAnalysis> {
  const horizon = context.horizon || 3; // default forecast horizon in years
  const memoryKey = `deepResearch/${sanitizeKey(prompt)}/forecast`;

  try {
    // Phase 1 - Historical grounding
    const historicalGrounding = await queryOpenAI(
      'Extract key historical events or precedents related to the topic.',
      prompt,
    );

    // Phase 2 - Present condition modeling
    const presentInput = context ? `${prompt}\n\nContext: ${JSON.stringify(context)}` : prompt;
    const presentCondition = await queryOpenAI(
      'Analyze the current state and influencing factors.',
      presentInput,
    );

    // Phase 3 - Predictive forecasting
    const forecastInput = `${prompt}\nForecast horizon: ${horizon} years`;
    const predictiveForecast = await queryOpenAI(
      'Forecast how this topic may evolve over the specified horizon.',
      forecastInput,
    );

    // Phase 4 - Memory comparison (if state is available)
    let memoryComparison: string | undefined;
    const previous = context.state || (await getMemory(memoryKey));
    if (previous) {
      const comparisonPrompt =
        `Previous state:\n${typeof previous === 'string' ? previous : JSON.stringify(previous)}\n\n` +
        `New forecast:\n${predictiveForecast}\n\nHighlight key changes and consistencies.`;
      memoryComparison = await queryOpenAI(
        'Compare the new forecast with the previous state and summarize differences.',
        comparisonPrompt,
      );
    }

    await storeMemory(memoryKey, predictiveForecast).catch((err) => {
      console.warn('Memory storage failed:', err);
    });

    return {
      historicalGrounding,
      presentCondition,
      predictiveForecast,
      ...(memoryComparison && { memoryComparison }),
    };
  } catch (error: any) {
    console.error('Deep research failed:', error);
    throw error;
  }
}

export default { runDeepResearch };
