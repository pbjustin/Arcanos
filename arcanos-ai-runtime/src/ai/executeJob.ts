import { openai } from "./openaiClient.js";
import { computeTimeout } from "./adaptiveTimeout.js";
import type { Job } from "../jobs/jobStore.js";

export async function executeAIJob(job: Job) {
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
        messages: job.messages,
        max_tokens: job.maxTokens ?? 1500,
      },
      { signal: controller.signal }
    );
    return response;
  } finally {
    clearTimeout(timer);
  }
}
