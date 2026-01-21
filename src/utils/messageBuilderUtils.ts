/**
 * Message Builder Utilities
 * Provides reusable functions for constructing OpenAI message arrays
 */

import type { ChatCompletionMessageParam } from '../services/openai/types.js';

/**
 * Build message array with optional system prompt
 * Consolidates repeated pattern across GPT-5.1 calls
 */
export const buildSystemPromptMessages = (
  prompt: string,
  systemPrompt?: string
): ChatCompletionMessageParam[] => {
  const messages: ChatCompletionMessageParam[] = [];
  
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  
  messages.push({ role: 'user', content: prompt });
  
  return messages;
};
