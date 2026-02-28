import OpenAI from "openai";

let runtimeClient: OpenAI | null = null;

/**
 * Resolve singleton OpenAI client for AI runtime.
 */
export function getRuntimeOpenAIClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for AI runtime client initialization");
  }

  if (!runtimeClient) {
    runtimeClient = new OpenAI({
      apiKey,
      timeout: 120000,
      maxRetries: 2
    });
  }

  return runtimeClient;
}

/**
 * Reset runtime OpenAI singleton (test-only utility).
 */
export function resetRuntimeOpenAIClient(): void {
  runtimeClient = null;
}
