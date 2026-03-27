import { RuntimeBudgetExceededError } from "./runtimeErrors.js";

function parseEnvInteger(rawValue: string | undefined, fallbackValue: number, allowZero = false): number {
  if (typeof rawValue !== 'string' || rawValue.trim().length === 0) {
    return fallbackValue;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsedValue) && (allowZero ? parsedValue >= 0 : parsedValue > 0)
    ? Math.trunc(parsedValue)
    : fallbackValue;
}

function parseEnvBoolean(rawValue: string | undefined, fallbackValue: boolean): boolean {
  if (typeof rawValue !== 'string') {
    return fallbackValue;
  }

  switch (rawValue.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false;
    default:
      return fallbackValue;
  }
}

export const WATCHDOG_LIMIT_MS = parseEnvInteger(process.env.WATCHDOG_LIMIT_MS, 120_000);
export const SAFETY_BUFFER_MS = parseEnvInteger(process.env.SAFETY_BUFFER_MS, 2_000, true);
export const BUDGET_DISABLED = parseEnvBoolean(process.env.BUDGET_DISABLED, false);

function normalizePositiveInteger(value: number, fallback: number): number {
  const truncatedValue = Math.trunc(value);

  if (!Number.isFinite(truncatedValue) || truncatedValue <= 0) {
    return fallback;
  }

  return truncatedValue;
}

export interface RuntimeBudget {
  readonly startedAt: number;
  readonly hardDeadline: number;
  readonly watchdogLimit: number;
  readonly safetyBuffer: number;
}

export function createRuntimeBudget(): RuntimeBudget {
  return createRuntimeBudgetWithLimit(WATCHDOG_LIMIT_MS);
}

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
    safetyBuffer: normalizedSafetyBufferMs,
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

  if (getSafeRemainingMs(budget) <= 0) {
    throw new RuntimeBudgetExceededError();
  }
}
