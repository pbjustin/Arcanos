import { openai } from "./openaiClient";
import { computeTimeout } from "./adaptiveTimeout";
import type { AIJobPayload } from "../jobs/types";

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
    const response = await openai.chat.completions.create(
      {
        model: job.model,
        messages: job.messages as any,
        max_tokens: job.maxTokens ?? 1500
      },
      {
        signal: controller.signal
      }
    );

    clearTimeout(timer);
    return response;

  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}
