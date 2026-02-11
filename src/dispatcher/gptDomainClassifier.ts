import type OpenAI from 'openai';
import type { CognitiveDomain } from '../types/cognitiveDomain.js';

const VALID_DOMAINS: ReadonlySet<string> = new Set([
  'diagnostic', 'code', 'creative', 'natural', 'execution'
]);

const MAX_CLASSIFIER_INPUT_LENGTH = 500;

/**
 * Truncate text at semantic boundaries (sentence or word) rather than mid-word.
 * Preserves meaning and reduces classification errors from incomplete text.
 */
function truncateAtSemanticBoundary(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  const candidate = text.slice(0, maxLength);

  // Prefer to cut at the end of a sentence if possible.
  const lastPeriod = candidate.lastIndexOf('. ');
  const lastQuestion = candidate.lastIndexOf('? ');
  const lastExclamation = candidate.lastIndexOf('! ');
  const lastSentenceEnd = Math.max(lastPeriod, lastQuestion, lastExclamation);

  // Only use a very early sentence end if it is not pathologically short,
  // to avoid discarding most of the allowed context.
  if (lastSentenceEnd !== -1 && lastSentenceEnd >= Math.floor(maxLength * 0.5)) {
    return candidate.slice(0, lastSentenceEnd + 1);
  }

  // Otherwise, fall back to the last whitespace before the limit.
  const lastSpace = candidate.lastIndexOf(' ');
  if (lastSpace > 0) {
    return candidate.slice(0, lastSpace);
  }

  // If there are no suitable boundaries, fall back to a hard cut.
  return candidate;
}

export async function gptFallbackClassifier(
  openai: OpenAI,
  prompt: string
): Promise<CognitiveDomain> {
  // Truncate to limit token cost and reduce prompt-injection surface,
  // preferring to cut at sentence or word boundaries.
  const truncated = truncateAtSemanticBoundary(prompt, MAX_CLASSIFIER_INPUT_LENGTH);

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

  console.warn(
    '[gptFallbackClassifier] Received invalid domain label from GPT classifier, falling back to "natural":',
    label || '<empty>'
  );
  return 'natural';
}
