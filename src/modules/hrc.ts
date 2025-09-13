import { getOpenAIClient } from '../services/openai.js';
import { getDefaultModel } from '../services/openai.js';

export interface HRCResult {
  fidelity: number;
  resilience: number;
  verdict: string;
}

/**
 * Hallucination-Resistant Core
 * Simple implementation that scores incoming text for fidelity and resilience
 * using the OpenAI SDK. Falls back gracefully when the client is unavailable.
 * Targets the project's fine-tuned model by default and can be overridden via HRC_MODEL.
 */
export class HRCCore {
  async evaluate(input: string): Promise<HRCResult> {
    // Get OpenAI client from the centralized service
    const openai = getOpenAIClient();
    
    // If OpenAI client isn't configured, return minimal default result
    if (!openai) {
      return {
        fidelity: 0,
        resilience: 0,
        verdict: 'OpenAI client not configured'
      };
    }

    try {
      const model = process.env.HRC_MODEL || getDefaultModel();
      const response = await openai.chat.completions.create({
        model,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You are the Hallucination-Resistant Core. Analyse the user message and return JSON {"fidelity":0-1,"resilience":0-1,"verdict":string}.',
          },
          { role: 'user', content: input }
        ],
        temperature: 0
      });

      const content = response.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(content);

      return {
        fidelity: Number(parsed.fidelity) || 0,
        resilience: Number(parsed.resilience) || 0,
        verdict: typeof parsed.verdict === 'string' ? parsed.verdict : 'unavailable'
      };
    } catch (err) {
      return {
        fidelity: 0,
        resilience: 0,
        verdict: `Evaluation failed: ${err instanceof Error ? err.message : 'unknown error'}`
      };
    }
  }
}

export const hrcCore = new HRCCore();
