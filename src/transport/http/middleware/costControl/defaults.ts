import { callOpenAI } from "@services/openai.js";
import { getDefaultModel } from "@services/openai/credentialProvider.js";
import type { CostControlConfig, OpenAIClient, OpenAIRequestPayload } from './types.js';

export const DEFAULT_CONFIG: CostControlConfig = {
  cacheTtlMs: 60_000,
  batchWindowMs: 500,
  rateLimitPerMinute: 5,
  requestTimeoutMs: 8_000,
  batchEndpointPath: '/openai-endpoint',
  defaultTokenLimit: 1024
};

export function createDefaultOpenAIClient(config: CostControlConfig): OpenAIClient {
  const call = async (payload: OpenAIRequestPayload) => {
    const model = payload.model ?? getDefaultModel();
    const tokenLimit = payload.maxTokens ?? config.defaultTokenLimit;
    //audit Assumption: model/tokenLimit are valid inputs; risk: invalid configuration; invariant: callOpenAI returns a result or throws; handling: propagate errors.
    return callOpenAI(model, payload.prompt, tokenLimit, true, {
      metadata: payload.metadata
    });
  };
  const batch = async (payloads: OpenAIRequestPayload[]) => {
    //audit Assumption: batch size can be handled sequentially; risk: latency increases; invariant: each payload yields a result; handling: Promise.all to aggregate.
    return Promise.all(payloads.map((payload) => call(payload)));
  };
  return { call, batch };
}
