import { config } from '../config/index.js';

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
export function handleFallbackRequest(request: FallbackRequest) {
  const {
    prompt,
    max_completion_tokens = 1024,
    temperature = 0.7,
    model = 'gpt-5'
  } = request;

  // Log diagnostic for transparency
  console.log(`[FallbackHandler] Model: ${model}, Tokens: ${max_completion_tokens}`);

  // Pass safe, guaranteed parameters to GPT-5
  return callModelAPI({
    model,
    prompt,
    max_completion_tokens,
    temperature
  });
}

// Example API caller (replace with your actual ARCANOS→GPT-5 call)
async function callModelAPI(payload: {
  model: string;
  prompt: string;
  max_completion_tokens: number;
  temperature: number;
}) {
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.ai.apiKey}`
      },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (error) {
    console.error('[FallbackHandler] Error:', error);
    throw error;
  }
}

export default { handleFallbackRequest };
