import { RuntimeBudgetExceededError } from './runtimeErrors.js';

function readIntegerEnv(name: string, fallback: number, allowZero = false): number {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const rounded = Math.floor(parsed);
  if (allowZero ? rounded < 0 : rounded <= 0) {
    return fallback;
  }

  return rounded;
}

export const WATCHDOG_LIMIT_MS = readIntegerEnv('WATCHDOG_LIMIT_MS', 120_000);
export const SAFETY_BUFFER_MS = readIntegerEnv('SAFETY_BUFFER_MS', 2_000, true);
export const BUDGET_DISABLED = process.env.BUDGET_DISABLED === 'true';

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

export function getElapsedMs(budget: RuntimeBudget): number {
  return Date.now() - budget.startedAt;
}

export function getRemainingMs(budget: RuntimeBudget): number {
  return budget.hardDeadline - Date.now();
}

/**
 * Computes safe remaining milliseconds by subtracting safety buffer from remaining time.
 * Input: RuntimeBudget. Output: remaining time that can be safely consumed.
 * Edge case: can return zero/negative value after deadline or within safety buffer.
 */
export function getSafeRemainingMs(budget: RuntimeBudget): number {
  if (BUDGET_DISABLED) {
    return Math.max(1, WATCHDOG_LIMIT_MS - SAFETY_BUFFER_MS);
  }

  return Math.max(0, getRemainingMs(budget) - budget.safetyBuffer);
}

export function hasSufficientBudget(budget: RuntimeBudget, requiredMs: number): boolean {
  return getSafeRemainingMs(budget) > requiredMs;
}

/**
 * Enforces runtime budget availability before critical stage execution.
 * Input: RuntimeBudget. Output: void or throws RuntimeBudgetExceededError.
 * Edge case: throws when safe remaining time is not positive.
 */
export function assertBudgetAvailable(budget: RuntimeBudget): void {
  if (BUDGET_DISABLED) {
    return;
  }

  //audit Assumption: non-positive safe window means execution cannot complete safely; risk: partial state and timeout races; invariant: stages start only with positive safe time; handling: hard-fail.
  if (getSafeRemainingMs(budget) <= 0) {
    throw new RuntimeBudgetExceededError();
  }
}