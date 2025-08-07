import OpenAI from 'openai';

let openai: OpenAI | null = null;

const initializeOpenAI = (): OpenAI | null => {
  if (openai) return openai;

  try {
    const apiKey = process.env.API_KEY || process.env.OPENAI_API_KEY;
    if (apiKey) {
      openai = new OpenAI({ apiKey });
      console.log('✅ OpenAI client initialized');
      return openai;
    } else {
      console.warn('⚠️  No OpenAI API key found. AI endpoints will return errors.');
      return null;
    }
  } catch (error) {
    console.error('❌ Failed to initialize OpenAI client:', error);
    return null;
  }
};

export const getOpenAIClient = (): OpenAI | null => {
  return openai || initializeOpenAI();
};

export default { getOpenAIClient };