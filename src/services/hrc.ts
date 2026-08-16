import { getDefaultModel } from "@services/openai.js";
import { HRC_SYSTEM_PROMPT } from "@platform/runtime/hrcPrompts.js";
import { getOpenAIClientOrAdapter } from "@services/openai/clientBridge.js";
import { getEnv } from "@platform/runtime/env.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import { callStructuredResponse } from "@arcanos/openai";
import { createLinkedAbortController, getRequestAbortSignal, isAbortError } from '@arcanos/runtime';
import type { ModuleDef } from './moduleLoader.js';

export interface HRCResult {
  fidelity: number;
  resilience: number;
  verdict: string;
}

interface ParsedHRCPayload {
  fidelity: number | string;
  resilience: number | string;
  verdict: string;
}

export interface HRCEvaluationOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

const nonCacheableHRCResults = new WeakSet<HRCResult>();

/**
 * Reports whether an HRC result is safe to share across caller scopes.
 * Abort fallbacks retain the public HRC result shape but must not enter the text cache.
 */
export function isHRCResultCacheable(result: HRCResult): boolean {
  return !nonCacheableHRCResults.has(result);
}

function isHRCResult(value: unknown): value is ParsedHRCPayload {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const isNumericField = (field: unknown): boolean =>
    (typeof field === 'number' && Number.isFinite(field)) ||
    (typeof field === 'string' && field.trim().length > 0 && Number.isFinite(Number(field)));
  return (
    isNumericField(candidate.fidelity) &&
    isNumericField(candidate.resilience) &&
    typeof candidate.verdict === 'string'
  );
}

/**
 * Hallucination-Resistant Core
 * Simple implementation that scores incoming text for fidelity and resilience
 * using the OpenAI SDK. Falls back gracefully when the client is unavailable.
 * Targets the project's fine-tuned model by default and can be overridden via HRC_MODEL.
 */
export class HRCCore {
  async evaluate(input: string, options: HRCEvaluationOptions = {}): Promise<HRCResult> {
    const { adapter } = getOpenAIClientOrAdapter();
    if (!adapter) {
      return {
        fidelity: 0,
        resilience: 0,
        verdict: 'OpenAI adapter not configured'
      };
    }

    const timeoutMs =
      typeof options.timeoutMs === 'number' &&
      Number.isFinite(options.timeoutMs) &&
      options.timeoutMs > 0
        ? Math.max(1, Math.trunc(options.timeoutMs))
        : null;
    const parentSignal = options.signal ?? getRequestAbortSignal();
    const requestScope = timeoutMs === null
      ? null
      : createLinkedAbortController({
          timeoutMs,
          parentSignal,
          abortMessage: `HRC evaluation timed out after ${timeoutMs}ms`
        });
    const evaluationSignal = requestScope?.signal ?? parentSignal;

    try {
      // Use config layer for env access (adapter boundary pattern)
      const model = getEnv('HRC_MODEL') || getDefaultModel();
      const { outputParsed } = await callStructuredResponse<ParsedHRCPayload>(adapter as any, {
        model,
        input: [
          {
            role: 'system',
            content: [{ type: 'input_text', text: HRC_SYSTEM_PROMPT }]
          },
          {
            role: 'user',
            content: [{ type: 'input_text', text: input }]
          }
        ],
        text: { format: { type: 'json_object' } },
        temperature: 0
      }, evaluationSignal ? { signal: evaluationSignal } : undefined, {
        validate: isHRCResult,
        source: 'HRC evaluation'
      });

      const result: HRCResult = {
        fidelity: Number(outputParsed.fidelity) || 0,
        resilience: Number(outputParsed.resilience) || 0,
        verdict: outputParsed.verdict
      };

      if (evaluationSignal?.aborted) {
        nonCacheableHRCResults.add(result);
      }

      return result;
    } catch (err) {
      const result: HRCResult = {
        fidelity: 0,
        resilience: 0,
        verdict: `Evaluation failed: ${resolveErrorMessage(err, 'unknown error')}`
      };

      if (evaluationSignal?.aborted || isAbortError(err)) {
        nonCacheableHRCResults.add(result);
      }

      return result;
    } finally {
      requestScope?.cleanup();
    }
  }
}

export const hrcCore = new HRCCore();

const HRCModule: ModuleDef = {
  name: 'HRC',
  description: 'Hallucination-Resistant Core – scores text for fidelity and resilience.',
  gptIds: ['hrc'],
  defaultTimeoutMs: 60000,
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
