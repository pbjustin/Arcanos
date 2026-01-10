import OpenAI from 'openai';

/**
 * Shared OpenAI client instance for workers
 */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export default openai;
