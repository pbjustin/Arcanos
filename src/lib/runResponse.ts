import OpenAI from 'openai';

import { requireOpenAIClientOrAdapter } from '@services/openai/clientBridge.js';

type RunResponseOptions = {
  model: string;
  input: string | OpenAI.Responses.ResponseInput;
  temperature?: number;
  json?: boolean;
};

export async function runResponse({
  model,
  input,
  temperature = 0.7,
  json = false
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
  return adapter.responses.create(config as any);

}