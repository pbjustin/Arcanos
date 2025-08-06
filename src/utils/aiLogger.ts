import OpenAI from 'openai';
import type { ChatCompletionCreateParams } from 'openai/resources/chat/completions';

/**
 * Wrapper around OpenAI chat completions that logs
 * input, model, token usage and output.
 */
export async function createCompletionWithLogging(
  client: OpenAI,
  params: ChatCompletionCreateParams & { stream?: false }
) {
  const { model, messages } = params;
  const input = messages
    .map(m => `[${m.role}] ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join(' | ');

  console.log(`📝 AI Request => model: ${model} | input: ${input}`);

  const response = await client.chat.completions.create(params) as any;
  const output = response.choices[0]?.message?.content || '';
  const tokens = response.usage?.total_tokens ?? 0;

  console.log(`🧠 AI Response => model: ${model} | tokens: ${tokens} | output: ${output}`);

  return response;
}
