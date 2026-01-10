import OpenAI from 'openai';

/**
 * Shared OpenAI client instance for workers
 * Lazily initialized to avoid requiring API key at module load time
 */
let openaiInstance: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!openaiInstance) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('Missing OpenAI API key. Please set OPENAI_API_KEY environment variable.');
    }
    openaiInstance = new OpenAI({ apiKey });
  }
  return openaiInstance;
}

export default new Proxy({} as OpenAI, {
  get(_target, prop) {
    const client = getOpenAIClient();
    return client[prop as keyof OpenAI];
  }
});
