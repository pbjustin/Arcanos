import OpenAI from 'openai';

import { openai } from '../config/openai.js';

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

  return openai.responses.create(config);
}