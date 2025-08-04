/**
 * Clean OpenAI Client Module
 * Simple, production-ready OpenAI SDK v4 client
 */

import { OpenAI } from 'openai';
import type { 
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
  ChatCompletion
} from 'openai/resources';

// Validate required environment variables
if (!process.env.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY environment variable is required');
}

// Create and export the OpenAI client instance
export const openaiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

// Export OpenAI types for convenience
export type { OpenAI } from 'openai';
export type { 
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
  ChatCompletion
} from 'openai/resources';

// Helper function for basic chat completions
export async function createChatCompletion(
  messages: ChatCompletionMessageParam[],
  options: Partial<ChatCompletionCreateParams> = {}
): Promise<ChatCompletion> {
  const completion = await openaiClient.chat.completions.create({
    model: 'gpt-4',
    messages,
    temperature: 0.7,
    max_tokens: 2000,
    stream: false, // Ensure we don't get a stream
    ...options,
  });
  
  return completion as ChatCompletion;
}