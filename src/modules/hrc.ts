import { getDefaultModel } from '../services/openai.js';
import { HRC_SYSTEM_PROMPT } from '../config/hrcPrompts.js';
import { getOpenAIAdapter } from '../adapters/openai.adapter.js';
import { getEnv } from '../config/env.js';
import { resolveErrorMessage } from '../lib/errors/index.js';

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
    // Use adapter (adapter boundary pattern)
    let adapter;
    try {
      adapter = getOpenAIAdapter();
    } catch {
      return {
        fidelity: 0,
        resilience: 0,
        verdict: 'OpenAI adapter not configured'
      };
    }

    try {
      // Use config layer for env access (adapter boundary pattern)
      const model = getEnv('HRC_MODEL') || getDefaultModel();
      const response = await adapter.chat.completions.create({
        model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: HRC_SYSTEM_PROMPT },
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
        verdict: `Evaluation failed: ${resolveErrorMessage(err, 'unknown error')}`
      };
    }
  }
}

export const hrcCore = new HRCCore();
