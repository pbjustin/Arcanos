import type OpenAI from 'openai';
import type { CognitiveDomain } from '../types/cognitiveDomain.js';
import { COGNITIVE_DOMAINS } from '../types/cognitiveDomain.js';

const VALID_DOMAINS: ReadonlySet<string> = new Set(COGNITIVE_DOMAINS as readonly string[]);

const MAX_CLASSIFIER_INPUT_LENGTH = 500;

function sanitizeClassifierInput(input: string): string {
  // remove non-printable/control characters, normalize whitespace, limit length
  let cleaned = input.replace(/[\x00-\x1F\x7F]+/g, ' ').trim();

  // Neutralize role labels to reduce role/assistant/user prompt injection attempts:
  cleaned = cleaned.replace(/\b(system|assistant|assistant:|user|user:|role)\b\s*:/gi, '$1\u200B:');

  // Escape triple backticks to prevent fenced-chat injections
  cleaned = cleaned.replace(/```/g, '\u200B```');

  // Also neutralize explicit "role:" tokens that might appear (loose)
  cleaned = cleaned.replace(/\brole\s*:/gi, 'role\u200B:');

  return cleaned.slice(0, MAX_CLASSIFIER_INPUT_LENGTH);
}

export async function gptFallbackClassifier(
  openai: OpenAI,
  prompt: string
): Promise<CognitiveDomain> {
  const sanitized = sanitizeClassifierInput(prompt);

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
      { role: 'user', content: sanitized }
    ]
  });

  const label = response.choices?.[0]?.message?.content?.trim()?.toLowerCase() ?? '';

  if (VALID_DOMAINS.has(label)) {
    return label as CognitiveDomain;
  }

  return 'natural';
}
