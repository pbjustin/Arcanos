import { RuntimeBudgetExceededError } from './runtimeErrors.js';

export const WATCHDOG_LIMIT_MS = 45_000;
export const SAFETY_BUFFER_MS = 2_000;

export interface RuntimeBudget {
  readonly startedAt: number;
  readonly hardDeadline: number;
  readonly watchdogLimit: number;
  readonly safetyBuffer: number;
}

/**
 * Creates a runtime budget anchored to a single hard deadline.
 * Input: none. Output: RuntimeBudget snapshot with deadline metadata.
 * Edge case: uses wall-clock now; callers should create only one budget per job.
 */
export function createRuntimeBudget(): RuntimeBudget {
  const startedAt = Date.now();
  return {
    startedAt,
    hardDeadline: startedAt + WATCHDOG_LIMIT_MS,
    watchdogLimit: WATCHDOG_LIMIT_MS,
    safetyBuffer: SAFETY_BUFFER_MS
  };
}

/**
 * Computes safe remaining milliseconds by subtracting safety buffer from remaining time.
 * Input: RuntimeBudget. Output: remaining time that can be safely consumed.
 * Edge case: can return zero/negative value after deadline or within safety buffer.
 */
export function getSafeRemainingMs(budget: RuntimeBudget): number {
  return (budget.hardDeadline - Date.now()) - budget.safetyBuffer;
}

/**
 * Enforces runtime budget availability before critical stage execution.
 * Input: RuntimeBudget. Output: void or throws RuntimeBudgetExceededError.
 * Edge case: throws when safe remaining time is not positive.
 */
export function assertBudgetAvailable(budget: RuntimeBudget): void {
  //audit Assumption: non-positive safe window means execution cannot complete safely; risk: partial state and timeout races; invariant: stages start only with positive safe time; handling: hard-fail.
  if (getSafeRemainingMs(budget) <= 0) {
    throw new RuntimeBudgetExceededError();
  }
}
