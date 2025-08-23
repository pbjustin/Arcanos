import { getOpenAIClient, getGPT5Model } from './openai.js';

interface FallbackRequest {
  prompt: string;
  max_completion_tokens?: number;
  temperature?: number;
  model?: string;
}

/**
 * Handle fallback request by ensuring token parameter defaults.
 * Adds default max_completion_tokens when missing.
 */
export async function handleFallbackRequest(request: FallbackRequest) {
  const {
    prompt,
    max_completion_tokens = 1024,
    temperature = 0.7,
    model = getGPT5Model()
  } = request;

  // Log diagnostic for transparency
  console.log(`[FallbackHandler] Model: ${model}, Tokens: ${max_completion_tokens}`);

  // Use centralized OpenAI service instead of direct API call
  return await callModelAPI({
    model,
    prompt,
    max_completion_tokens,
    temperature
  });
}

// Use centralized OpenAI client instead of direct fetch
async function callModelAPI(payload: {
  model: string;
  prompt: string;
  max_completion_tokens: number;
  temperature: number;
}) {
  try {
    const client = getOpenAIClient();
    if (!client) {
      throw new Error('OpenAI client not available');
    }

    const response = await client.chat.completions.create({
      model: payload.model,
      messages: [
        { role: 'user', content: payload.prompt }
      ],
      max_completion_tokens: payload.max_completion_tokens,
      temperature: payload.temperature
    });

    return response;
  } catch (error) {
    console.error('[FallbackHandler] Error:', error);
    throw error;
  }
}

export default { handleFallbackRequest };
