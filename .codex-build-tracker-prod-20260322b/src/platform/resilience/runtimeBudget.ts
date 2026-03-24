import { RuntimeBudgetExceededError } from './runtimeErrors.js';
import { parseEnvBoolean, parseEnvInteger } from '@platform/runtime/envParsers.js';

export const WATCHDOG_LIMIT_MS = parseEnvInteger(process.env.WATCHDOG_LIMIT_MS, 120_000, {
  minimum: 1,
  roundingMode: 'floor'
});
export const SAFETY_BUFFER_MS = parseEnvInteger(process.env.SAFETY_BUFFER_MS, 2_000, {
  allowZero: true,
  minimum: 0,
  roundingMode: 'floor'
});
export const BUDGET_DISABLED = parseEnvBoolean(process.env.BUDGET_DISABLED, false);

export interface RuntimeBudget {
  readonly startedAt: number;
  readonly hardDeadline: number;
  readonly watchdogLimit: number;
  readonly safetyBuffer: number;
}

function normalizePositiveInteger(value: number, fallback: number): number {
  const truncatedValue = Math.trunc(value);

  //audit Assumption: runtime budget metadata must remain positive integers; risk: invalid custom limits create negative deadlines or zero-width budgets; invariant: budget fields stay >= 1ms unless the caller intentionally allows a zero safety buffer elsewhere; handling: clamp invalid values to the provided fallback.
  if (!Number.isFinite(truncatedValue) || truncatedValue <= 0) {
    return fallback;
  }

  return truncatedValue;
}

/**
 * Creates a runtime budget anchored to a single hard deadline.
 * Input: none. Output: RuntimeBudget snapshot with deadline metadata.
 * Edge case: uses wall-clock now; callers should create only one budget per job.
 */
export function createRuntimeBudget(): RuntimeBudget {
  return createRuntimeBudgetWithLimit(WATCHDOG_LIMIT_MS);
}

/**
 * Creates a runtime budget with a caller-provided watchdog limit.
 * Input: explicit watchdog limit and optional safety buffer. Output: RuntimeBudget snapshot with deadline metadata.
 * Edge case: invalid custom values fall back to the configured global defaults.
 */
export function createRuntimeBudgetWithLimit(
  watchdogLimitMs: number,
  safetyBufferMs: number = SAFETY_BUFFER_MS
): RuntimeBudget {
  const startedAt = Date.now();
  const normalizedWatchdogLimitMs = normalizePositiveInteger(watchdogLimitMs, WATCHDOG_LIMIT_MS);
  const normalizedSafetyBufferMs = Math.max(0, Math.trunc(safetyBufferMs));

  return {
    startedAt,
    hardDeadline: startedAt + normalizedWatchdogLimitMs,
    watchdogLimit: normalizedWatchdogLimitMs,
    safetyBuffer: normalizedSafetyBufferMs
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
