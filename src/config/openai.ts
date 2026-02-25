import OpenAI from 'openai';

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!
});

export const DEFAULT_MODEL = process.env.ARCANOS_MODEL || 'gpt-5';

export const DEFAULT_FINE_TUNE =
  process.env.ARCANOS_FINE_TUNE || 'ft:gpt-4.1-2025-04-14:personal:arcanos:C8Msdote';