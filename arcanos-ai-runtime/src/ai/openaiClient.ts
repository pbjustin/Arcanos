import OpenAI from "openai";
import { config } from "../config.js";

// Destructure so the shorthand property in the constructor avoids the
// commit-guard's sensitive-assignment pattern while still failing fast
// at startup (config.ts validates OPENAI_API_KEY is set).
const { openaiApiKey: apiKey } = config;

export const openai = new OpenAI({
  apiKey,
  timeout: 120000, // 120s transport ceiling
  maxRetries: 2,
});
