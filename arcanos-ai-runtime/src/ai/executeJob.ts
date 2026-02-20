import { openai } from "./openaiClient.js";
import { computeTimeout } from "./adaptiveTimeout.js";
import type { AIJobPayload } from "../jobs/types.js";

type ExecutableAIJob = Pick<AIJobPayload, "model" | "messages" | "maxTokens">;

export async function executeAIJob(job: ExecutableAIJob) {
  const controller = new AbortController();

  const timeout = computeTimeout(
    job.model,
    JSON.stringify(job.messages),
    job.maxTokens ?? 1500
  );

  const timer = setTimeout(() => {
    controller.abort();
  }, timeout);

  try {
    return await openai.chat.completions.create(
      {
        model: job.model,
        messages: job.messages as any,
        max_tokens: job.maxTokens ?? 1500
      },
      {
        signal: controller.signal
      }
    );
  } finally {
    clearTimeout(timer);
  }
}
