import OpenAI from 'openai';

// Type for the Responses API parameters without streaming
type ResponseCreateParams = Parameters<OpenAI['responses']['create']>[0] & { stream?: false };

/**
 * Wrapper around OpenAI Responses API that logs
 * input, model, token usage and output.
 */
export async function createResponseWithLogging(
  client: OpenAI,
  params: ResponseCreateParams
) {
  const { model, input } = params;
  const logInput = Array.isArray(input)
    ? input
        .map((m: any) => `[${m.role}] ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
        .join(' | ')
    : typeof input === 'string'
      ? input
      : JSON.stringify(input);

  console.log(`📝 AI Request => model: ${model} | input: ${logInput}`);

  const response = await client.responses.create(params) as any;
  const output = response.output_text || '';
  const tokens = response.usage?.total_tokens ?? 0;

  console.log(`🧠 AI Response => model: ${model} | tokens: ${tokens} | output: ${output}`);

  return response;
}
