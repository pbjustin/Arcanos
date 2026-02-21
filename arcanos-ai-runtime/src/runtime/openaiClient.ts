import OpenAI from "openai";
import type {
  RuntimeBudget,
import {
  RuntimeBudget,
  getSafeRemainingMs,
  assertBudgetAvailable,
} from "./runtimeBudget.js";
import {
  RuntimeBudgetExceededError,
  OpenAIAbortError,
} from "./runtimeErrors.js";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function runGPT5(
  input: any,
  budget: RuntimeBudget
) {
  assertBudgetAvailable(budget);
  const safeRemaining = getSafeRemainingMs(budget);

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, safeRemaining);

  try {
    // @ts-ignore - GPT-5 might not be in types yet
    const response = await client.responses.create(
      {
        model: "gpt-5",
        input,
      },
      { signal: controller.signal }
    );

    return response;

  } catch (err: any) {
    if (err.name === "AbortError" || err.message?.toLowerCase().includes("aborted")) {
      throw new OpenAIAbortError();
    }

    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
