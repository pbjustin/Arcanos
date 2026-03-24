import OpenAI from 'openai';

import type { OpenAIResponsesRequestOptions } from '@core/adapters/openai.adapter.js';
import { requireOpenAIClientOrAdapter } from '@services/openai/clientBridge.js';

type RunResponseOptions = {
  model: string;
  input: string | OpenAI.Responses.ResponseInput;
  temperature?: number;
  json?: boolean;
  requestOptions?: OpenAIResponsesRequestOptions;
};

/**
 * Purpose: execute a single OpenAI Responses API call through the shared adapter.
 * Inputs/Outputs: model/input plus optional temperature, JSON mode, and request options -> raw Responses API payload.
 * Edge cases: when `json` is true the request is forced into JSON-object mode; request options such as abort signals pass through unchanged for callers enforcing latency budgets.
 */
export async function runResponse({
  model,
  input,
  temperature = 0.7,
  json = false,
  requestOptions
}: RunResponseOptions) {
  const config: OpenAI.Responses.ResponseCreateParams = {
    model,
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
  return adapter.responses.create(config as any, requestOptions);

}
