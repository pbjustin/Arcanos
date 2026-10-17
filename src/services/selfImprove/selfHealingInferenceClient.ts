import type OpenAI from 'openai';
import type { ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';

export const SELF_HEALING_INFERENCE_OUTPUT_TOKEN_LIMIT = 512;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * A single diagnosis receives one non-streaming Responses call. Forwarding through
 * the original adapter-bound method preserves model validation, circuit breakers,
 * usage accounting and existing transport controls without mutating the shared SDK.
 */
export function createSelfHealingInferenceClient(originalClient: OpenAI) {
  let requested = false;
  let pending = false;
  let failure: unknown = null;
  const client = Object.freeze({
    responses: Object.freeze({
      async create(params: ResponseCreateParamsNonStreaming, options?: OpenAI.RequestOptions) {
        if (requested) throw new Error('Self-healing inference request budget exhausted.');
        if ((params as { stream?: unknown }).stream === true) {
          throw new Error('Self-healing inference requires a bounded non-streaming response.');
        }
        requested = true;
        pending = true;
        try {
          return await originalClient.responses.create({
            ...params,
            max_output_tokens: typeof params.max_output_tokens === 'number'
              && Number.isFinite(params.max_output_tokens) && params.max_output_tokens > 0
              ? Math.max(1, Math.min(Math.trunc(params.max_output_tokens), SELF_HEALING_INFERENCE_OUTPUT_TOKEN_LIMIT))
              : SELF_HEALING_INFERENCE_OUTPUT_TOKEN_LIMIT,
            stream: false
          }, {
            ...options,
            maxRetries: 0,
            timeout: typeof options?.timeout === 'number'
              && Number.isFinite(options.timeout) && options.timeout > 0
              ? Math.min(options.timeout, REQUEST_TIMEOUT_MS) : REQUEST_TIMEOUT_MS
          });
        } catch (error) {
          failure = error;
          throw error;
        } finally {
          pending = false;
        }
      }
    })
  }) as unknown as OpenAI;

  return {
    client,
    getFailure: (): unknown => failure,
    isPending: (): boolean => pending,
    wasRequested: (): boolean => requested
  };
}
