import OpenAI from 'openai';

let openai: OpenAI | null = null;
let defaultModel: string | null = null;

const initializeOpenAI = (): OpenAI | null => {
  if (openai) return openai;

  try {
    const apiKey = process.env.API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error('❌ STARTUP ERROR: OPENAI_API_KEY is required and not set');
      throw new Error('OPENAI_API_KEY is required for ARCANOS to function');
    }

    openai = new OpenAI({ apiKey });
    defaultModel = process.env.AI_MODEL || 'REDACTED_FINE_TUNED_MODEL_ID';
    
    console.log('✅ OpenAI client initialized');
    console.log(`🧠 Default AI Model: ${defaultModel}`);
    console.log(`🔄 Fallback Model: gpt-4`);
    
    return openai;
  } catch (error) {
    console.error('❌ Failed to initialize OpenAI client:', error);
    return null;
  }
};

export const getOpenAIClient = (): OpenAI | null => {
  return openai || initializeOpenAI();
};

export const getDefaultModel = (): string => {
  return defaultModel || process.env.AI_MODEL || 'REDACTED_FINE_TUNED_MODEL_ID';
};

export const validateAPIKeyAtStartup = (): boolean => {
  const apiKey = process.env.API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('❌ STARTUP VALIDATION FAILED: OPENAI_API_KEY is required');
    return false;
  }
  console.log('✅ OPENAI_API_KEY validation passed');
  return true;
};

export default { getOpenAIClient, getDefaultModel, validateAPIKeyAtStartup };