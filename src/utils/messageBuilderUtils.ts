/**
 * Message Builder Utilities
 * Provides reusable functions for constructing OpenAI message arrays
 */

import type { ChatCompletionMessageParam } from '../services/openai/types.js';

/**
 * Validate that message content is a non-empty string.
 * Inputs: unknown content value and a label for error context.
 * Outputs: the original string if valid.
 * Edge cases: throws when content is non-string or empty to avoid API schema violations.
 */
function assertNonEmptyContent(content: unknown, label: string): string {
  //audit Assumption: OpenAI message content must be non-empty string; risk: schema error; invariant: trimmed string length > 0; handling: throw explicit error.
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error(`ARCANOS_SCHEMA_VIOLATION: ${label} must be a non-empty string`);
  }
  return content;
}

/**
 * Build message array with optional system prompt for OpenAI calls.
 * Inputs: user prompt string, optional system prompt string.
 * Outputs: message array formatted for OpenAI chat completion.
 * Edge cases: throws when prompt/system prompt is empty to prevent content:null errors.
 */
export const buildSystemPromptMessages = (
  prompt: string,
  systemPrompt?: string
): ChatCompletionMessageParam[] => {
  const messages: ChatCompletionMessageParam[] = [];
  const validatedPrompt = assertNonEmptyContent(prompt, 'prompt');
  //audit Assumption: system prompt is optional; risk: invalid string bypass; invariant: only add when valid; handling: validate when provided.
  if (systemPrompt !== undefined) {
    const validatedSystemPrompt = assertNonEmptyContent(systemPrompt, 'systemPrompt');
    messages.push({ role: 'system', content: validatedSystemPrompt });
  }
  //audit Assumption: message array must include user prompt; risk: missing prompt; invariant: user message present; handling: always append.
  messages.push({ role: 'user', content: validatedPrompt });
  return messages;
};
