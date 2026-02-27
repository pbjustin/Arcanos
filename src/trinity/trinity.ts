import OpenAI from 'openai';

import { DEFAULT_MODEL } from '../config/openai.js';
import { runResponse } from '../lib/runResponse.js';

type TrinityOptions = {
  prompt: string;
  model?: string;
  temperature?: number;
  structured?: boolean;
};

function extractOutputText(response: OpenAI.Responses.Response): string | null {
  const message = response.output.find(
    (item): item is OpenAI.Responses.ResponseOutputMessage => item.type === 'message'
  );

  const outputText = message?.content.find(
    (part): part is OpenAI.Responses.ResponseOutputText => part.type === 'output_text'
  );

  return outputText?.text ?? null;
}

export async function runTrinity({
  prompt,
  model = DEFAULT_MODEL,
  temperature = 0.7,
  structured = true
}: TrinityOptions) {
  const constructedInput: OpenAI.Responses.ResponseInput = [
    {
      role: 'user',
      content: prompt
    }
  ];

  const response = await runResponse({
    model,
    input: constructedInput,
    temperature,
    json: structured
  });

  const output = extractOutputText(response);

  return {
    model: response.model,
    output,
    raw: response
  };
}