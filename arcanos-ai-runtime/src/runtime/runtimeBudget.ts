import { RuntimeBudgetExceededError } from "./runtimeErrors.js";

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

export const WATCHDOG_LIMIT_MS = readIntegerEnv("WATCHDOG_LIMIT_MS", 60000);
export const SAFETY_BUFFER_MS = readIntegerEnv("SAFETY_BUFFER_MS", 2000, true);
export const BUDGET_DISABLED = process.env.BUDGET_DISABLED === "true";

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
  if (BUDGET_DISABLED) {
    return Math.max(1, WATCHDOG_LIMIT_MS - SAFETY_BUFFER_MS);
  }

  return Math.max(0, getRemainingMs(budget) - budget.safetyBuffer);
}

export function hasSufficientBudget(
  budget: RuntimeBudget,
  requiredMs: number
): boolean {
  return getSafeRemainingMs(budget) > requiredMs;
}

export function assertBudgetAvailable(budget: RuntimeBudget): void {
  if (BUDGET_DISABLED) {
    return;
  }

  // Use a minimal required amount, or just check if > 0
  if (getSafeRemainingMs(budget) <= 0) {
    throw new RuntimeBudgetExceededError();
  }
}
