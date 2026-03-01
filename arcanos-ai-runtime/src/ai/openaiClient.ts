import type OpenAI from "openai";
import { createOpenAIClient } from "@arcanos/openai/client";

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
    runtimeClient = createOpenAIClient({ apiKey, timeoutMs: 120000 });
    // NOTE: retries should be applied via retryWithBackoff at call sites (shared).
  }

  return runtimeClient;
}

/**
 * Reset runtime OpenAI singleton (test-only utility).
 */
export function resetRuntimeOpenAIClient(): void {
  runtimeClient = null;
}
