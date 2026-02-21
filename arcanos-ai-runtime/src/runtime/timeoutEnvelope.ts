import type { RuntimeBudget } from "./runtimeBudget.js";
import { getElapsedMs, getRemainingMs } from "./runtimeBudget.js";

export type TimeoutStage =
  | "reasoning"
  | "validation"
  | "second_pass";

export interface TimeoutEnvelope {
  status: "timeout_prevented";
  category: "runtime_budget_exhausted";
  stage: TimeoutStage;
  partial: boolean;
  confidence: number | null;
  elapsed_ms: number;
  remaining_budget_ms: number;
  watchdog_limit_ms: number;
  trace_id: string;
}

export function buildTimeoutEnvelope(
  budget: RuntimeBudget,
  traceId: string,
  stage: TimeoutStage,
  confidence: number | null = null
): TimeoutEnvelope {
  return {
    status: "timeout_prevented",
    category: "runtime_budget_exhausted",
    stage,
    partial: stage !== "reasoning",
    confidence,
    elapsed_ms: getElapsedMs(budget),
    remaining_budget_ms: getRemainingMs(budget),
    watchdog_limit_ms: budget.watchdogLimit,
    trace_id: traceId,
  };
}
