import { getDefaultModel } from "@services/openai.js";
import { HRC_SYSTEM_PROMPT } from "@platform/runtime/hrcPrompts.js";
import { getOpenAIClientOrAdapter } from "@services/openai/clientBridge.js";
import { getEnv } from "@platform/runtime/env.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import type { ModuleDef } from './moduleLoader.js';

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
    const { adapter } = getOpenAIClientOrAdapter();
    if (!adapter) {
      return {
        fidelity: 0,
        resilience: 0,
        verdict: 'OpenAI adapter not configured'
      };
    }

    try {
      // Use config layer for env access (adapter boundary pattern)
      const model = getEnv('HRC_MODEL') || getDefaultModel();
      const response = await adapter.responses.create({
        model,
        input: [{ role: 'system', content: HRC_SYSTEM_PROMPT }, { role: 'user', content: input }],
        text: { format: { type: 'json_object' } },
        temperature: 0
      });

      const content = (response.output_text as string | undefined) || response.choices?.[0]?.message?.content || '{}';
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

const HRCModule: ModuleDef = {
  name: 'HRC',
  description: 'Hallucination-Resistant Core – scores text for fidelity and resilience.',
  gptIds: ['hrc'],
  actions: {
    async evaluate(payload: unknown) {
      const input = typeof payload === 'string'
        ? payload
        : (payload as Record<string, unknown>)?.message;
      if (typeof input !== 'string' || !input.trim()) {
        throw new Error('HRC evaluate requires a text input');
      }
      return hrcCore.evaluate(input);
    }
  }
};

export default HRCModule;
