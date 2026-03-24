import { RuntimeBudgetExceededError } from "./runtimeErrors.js";

export const WATCHDOG_LIMIT_MS = 45000;
export const SAFETY_BUFFER_MS = 2000;

export interface RuntimeBudget {
  readonly startedAt: number;
  readonly hardDeadline: number;
  readonly watchdogLimit: number;
  readonly safetyBuffer: number;
}

export function createRuntimeBudget(): RuntimeBudget {
  const startedAt = Date.now();

  return {
    startedAt,
    hardDeadline: startedAt + WATCHDOG_LIMIT_MS,
    watchdogLimit: WATCHDOG_LIMIT_MS,
    safetyBuffer: SAFETY_BUFFER_MS,
  };
}

export function getElapsedMs(budget: RuntimeBudget): number {
  return Date.now() - budget.startedAt;
}

export function getRemainingMs(budget: RuntimeBudget): number {
  return budget.hardDeadline - Date.now();
}

export function getSafeRemainingMs(budget: RuntimeBudget): number {
  return getRemainingMs(budget) - budget.safetyBuffer;
}

export function hasSufficientBudget(
  budget: RuntimeBudget,
  requiredMs: number
): boolean {
  return getSafeRemainingMs(budget) > requiredMs;
}

export function assertBudgetAvailable(budget: RuntimeBudget): void {
  // Use a minimal required amount, or just check if > 0
  if (getSafeRemainingMs(budget) <= 0) {
    throw new RuntimeBudgetExceededError();
  }
}
