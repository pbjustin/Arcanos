import OpenAI from 'openai';

// Type for the Chat Completions API parameters (non-streaming)
type ChatCompletionCreateParams = OpenAI.Chat.Completions.ChatCompletionCreateParams & { stream?: false };

/**
 * Enhanced logging for ARCANOS routing stages
 */
export function logArcanosRouting(stage: string, model: string, details?: string) {
  const timestamp = new Date().toISOString();
  console.log(`🔀 [ARCANOS ROUTING] ${timestamp} - ${stage} | Model: ${model}${details ? ` | ${details}` : ''}`);
}

/**
 * Log when ARCANOS routes to GPT-5.2
 */
export function logGPT5Invocation(reason: string, input: string) {
  const timestamp = new Date().toISOString();
  console.log(`🚀 [GPT-5.2 INVOCATION] ${timestamp} - Reason: ${reason} | Input: ${input.substring(0, 100)}${input.length > 100 ? '...' : ''}`);
}

/**
 * Log the final routing summary
 */
export function logRoutingSummary(arcanosModel: string, gpt5Used: boolean, finalStage: string) {
  const timestamp = new Date().toISOString();
  console.log(`📊 [ROUTING SUMMARY] ${timestamp} - ARCANOS: ${arcanosModel} | GPT-5.2 Used: ${gpt5Used} | Final Stage: ${finalStage}`);
}

/**
 * Wrapper around OpenAI Chat Completions API that provides comprehensive logging
 * 
 * This function logs all AI interactions for debugging, auditing, and analysis:
 * - Logs input prompts (truncated for readability)
 * - Tracks model usage and token consumption
 * - Records AI responses for debugging
 * - Maintains consistent logging format across ARCANOS
 * 
 * @param client - OpenAI client instance
 * @param params - Chat completion parameters (without streaming)
 * @returns Promise<OpenAI.Chat.Completions.ChatCompletion> - The AI response with full metadata
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
