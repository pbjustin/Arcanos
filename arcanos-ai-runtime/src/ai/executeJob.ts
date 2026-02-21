import { createRuntimeBudget, getElapsedMs } from "../runtime/runtimeBudget.js";
import { executeWithBudget } from "../runtime/executionController.js";
import { buildTimeoutEnvelope } from "../runtime/timeoutEnvelope.js";
import {
  RuntimeBudgetExceededError,
  OpenAIAbortError,
} from "../runtime/runtimeErrors.js";
import { recordMetric } from "../runtime/metrics.js";
import type { AIJobPayload } from "../jobs/types.js";
import type { TimeoutStage } from "../runtime/timeoutEnvelope.js";
import { v4 as uuidv4 } from "uuid";

type ExecutableAIJob = Pick<AIJobPayload, "model" | "messages" | "maxTokens">;

export async function executeAIJob(job: ExecutableAIJob) {
  const budget = createRuntimeBudget();
  const traceId = uuidv4();
  let currentStage: TimeoutStage = "reasoning";

  try {
    const { response, stage } = await executeWithBudget(job, budget);
    currentStage = stage;
    
    recordMetric("job_success", 1, { 
      model: job.model, 
      stage: currentStage,
      elapsed_ms: getElapsedMs(budget).toString()
    });

    return response;

  } catch (err: any) {
    if (
      err instanceof RuntimeBudgetExceededError ||
      err instanceof OpenAIAbortError
    ) {
      recordMetric("job_timeout", 1, { 
        stage: currentStage, 
        elapsed_ms: getElapsedMs(budget).toString() 
      });
      return buildTimeoutEnvelope(budget, traceId, currentStage);
    }

    recordMetric("job_error", 1, { error: err.name || "Error" });
    throw err;
  }
}
