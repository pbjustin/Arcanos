import OpenAI from "openai";
import { runtimeEnv } from "../config/env.js";

let runtimeClient: OpenAI | null = null;

/**
 * Resolve singleton OpenAI client for AI runtime.
 *
 * Purpose:
 * - Keep OpenAI construction in one canonical boundary for this sub-runtime.
 * Inputs/Outputs:
 * - Input: none (reads validated runtime config only).
 * - Output: initialized OpenAI client singleton.
 * Edge cases:
 * - Throws when OPENAI_API_KEY is missing.
 */
export function getRuntimeOpenAIClient(): OpenAI {
  //audit Assumption: runtime API key must be present for live calls; risk: repeated lazy failures inside job handlers; invariant: fail fast on first constructor attempt; handling: explicit key guard before client creation.
  if (!runtimeEnv.OPENAI_API_KEY || runtimeEnv.OPENAI_API_KEY.trim().length === 0) {
    throw new Error("OPENAI_API_KEY is required for AI runtime client initialization");
  }

  if (!runtimeClient) {
    runtimeClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY ?? runtimeEnv.OPENAI_API_KEY,
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
