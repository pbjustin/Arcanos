import type { RuntimeBudget } from "./runtimeBudget.js";
import {
  runGPT5 as runSharedGPT5,
  type GPT5Request,
  type GPT5Response,
} from "@arcanos/openai/runGPT5";
import { retryWithBackoff } from "@arcanos/openai/retry";
import { getRuntimeOpenAIClient } from "../ai/openaiClient.js";

export type { GPT5Request, GPT5Response } from "@arcanos/openai/runGPT5";

export async function runGPT5(
  request: GPT5Request,
  budget: RuntimeBudget
): Promise<GPT5Response> {
  return runSharedGPT5(
    getRuntimeOpenAIClient(),
    request,
    budget,
    { retry: retryWithBackoff }
  );
}
