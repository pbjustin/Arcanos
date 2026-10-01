import OpenAI from 'openai';

import type { OpenAIResponsesRequestOptions } from '@core/adapters/openai.adapter.js';
import { requireOpenAIClientOrAdapter } from '@services/openai/clientBridge.js';
import { resolveGenerativeModel, type GenerativeModelRole } from '@services/openai/credentialProvider.js';
import { ensureModelMatchesExpectation } from '@services/openai/chatFallbacks.js';

type RunResponseOptions = {
  model?: string;
  modelRole?: GenerativeModelRole;
  input: string | OpenAI.Responses.ResponseInput;
  temperature?: number;
  json?: boolean;
  requestOptions?: OpenAIResponsesRequestOptions;
};

/**
 * Purpose: execute a single OpenAI Responses API call through the shared adapter.
 * Inputs/Outputs: input plus shared model role, optional matching model, temperature, JSON mode, and request options -> raw Responses API payload.
 * Edge cases: final authority is the default role and provider identity is verified; `json` forces JSON-object mode and request options preserve latency budgets.
 */
export async function runResponse({
  model,
  modelRole = 'final',
  input,
  temperature = 0.7,
  json = false,
  requestOptions
}: RunResponseOptions) {
  const resolvedModel = resolveGenerativeModel(modelRole, model);
  const config: OpenAI.Responses.ResponseCreateParams = {
    model: resolvedModel,
    input,
    temperature
  };

  if (json) {
    config.text = {
      format: { type: 'json_object' }
    };
  }

  const { adapter } = requireOpenAIClientOrAdapter('OpenAI adapter not initialized');
  // Best practice: disable response storage unless explicitly needed.
  (config as any).store = false;
  const response = await adapter.responses.create(config as any, requestOptions);
  ensureModelMatchesExpectation(response, resolvedModel);
  return response;

}
