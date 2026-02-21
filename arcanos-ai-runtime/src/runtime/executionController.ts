import type {
  RuntimeBudget,
} from "./runtimeBudget.js";
import {
  hasSufficientBudget,
  assertBudgetAvailable,
} from "./runtimeBudget.js";
import { runGPT5 } from "./openaiClient.js";
import type { TimeoutStage } from "./timeoutEnvelope.js";

interface ExecutionOptions {
  secondPassThreshold?: number;
  estimatedSecondPassCostMs?: number;
}

export interface ExecutionResult {
  response: any;
  stage: TimeoutStage;
}

export async function executeWithBudget(
  input: any,
  budget: RuntimeBudget,
  options: ExecutionOptions = {}
): Promise<ExecutionResult> {
  const {
    secondPassThreshold = 0.85,
    estimatedSecondPassCostMs = 8000,
  } = options;

  let currentStage: TimeoutStage = "reasoning";
  assertBudgetAvailable(budget);
  
  const firstPass = await runGPT5(input, budget);

  const confidence = extractConfidence(firstPass);

  if (confidence < secondPassThreshold) {
    if (hasSufficientBudget(budget, estimatedSecondPassCostMs)) {
      currentStage = "second_pass";
      assertBudgetAvailable(budget);
      const secondPass = await runGPT5(buildSecondPassInput(firstPass), budget);
      return { response: secondPass, stage: currentStage };
    }
  }

  return { response: firstPass, stage: currentStage };
}

function extractConfidence(response: any): number {
  // TODO: Replace with real confidence extraction logic
  return 0.9;
}

function buildSecondPassInput(response: any) {
  return {
    refinement: response.output_text,
  };
}
