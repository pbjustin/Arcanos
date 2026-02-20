import OpenAI from "openai";
import { runtimeEnv } from "../config/env.js";

export const openai = new OpenAI({
  apiKey: runtimeEnv.OPENAI_API_KEY,
  timeout: 120000, // 120s transport ceiling
  maxRetries: 2
});
