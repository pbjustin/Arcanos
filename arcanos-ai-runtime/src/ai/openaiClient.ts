import OpenAI from "openai";

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
  timeout: 120000, // 120s transport ceiling
  maxRetries: 2
});
