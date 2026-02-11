import type OpenAI from 'openai';
import type { CognitiveDomain } from '../types/cognitiveDomain.js';

const VALID_DOMAINS: ReadonlySet<string> = new Set([
  'diagnostic', 'code', 'creative', 'natural', 'execution'
]);

const MAX_CLASSIFIER_INPUT_LENGTH = 500;

export async function gptFallbackClassifier(
  openai: OpenAI,
  prompt: string
): Promise<CognitiveDomain> {
  // Truncate to limit token cost and reduce prompt-injection surface
  const truncated = prompt.slice(0, MAX_CLASSIFIER_INPUT_LENGTH);

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    max_tokens: 10,
    messages: [
      {
        role: 'system',
        content:
          'Classify the request into exactly one of: diagnostic, code, creative, natural, execution. Return only the label.'
      },
      { role: 'user', content: truncated }
    ]
  });

  const label = response.choices?.[0]?.message?.content?.trim()?.toLowerCase() ?? '';

  if (VALID_DOMAINS.has(label)) {
    return label as CognitiveDomain;
  }

  return 'natural';
}
