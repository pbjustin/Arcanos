import OpenAI from 'openai';

/**
 * Shared OpenAI client instance for workers
 * Lazily initialized to avoid requiring API key at module load time
 */
let openaiInstance: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!openaiInstance) {
    openaiInstance = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY || 'dummy-key-for-testing'
    });
  }
  return openaiInstance;
}

export default new Proxy({} as OpenAI, {
  get(_target, prop) {
    return getOpenAIClient()[prop as keyof OpenAI];
  }
});
