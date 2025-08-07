import OpenAI from 'openai';

// Type for the Chat Completions API parameters (non-streaming)
type ChatCompletionCreateParams = Omit<Parameters<OpenAI['chat']['completions']['create']>[0], 'stream'> & { stream?: false };

/**
 * Wrapper around OpenAI Chat Completions API that logs
 * input, model, token usage and output.
 */
export async function createResponseWithLogging(
  client: OpenAI,
  params: ChatCompletionCreateParams
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const { model, messages } = params;
  const logInput = messages
    .map((m: any) => `[${m.role}] ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join(' | ');

  console.log(`📝 AI Request => model: ${model} | input: ${logInput}`);

  const response = await client.chat.completions.create({ ...params, stream: false }) as OpenAI.Chat.Completions.ChatCompletion;
  const output = response.choices[0]?.message?.content || '';
  const tokens = response.usage?.total_tokens ?? 0;

  console.log(`🧠 AI Response => model: ${model} | tokens: ${tokens} | output: ${output}`);

  return response;
}
