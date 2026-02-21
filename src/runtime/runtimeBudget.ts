import { RuntimeBudgetExceededError } from './runtimeErrors.js';

export const WORKER_RUNTIME_BUDGET_MS = 45_000;
export const RUNTIME_SAFETY_BUFFER_MS = 2_000;

export interface RuntimeBudget {
  readonly startedAt: number;
  readonly hardDeadline: number;
  readonly watchdogLimit: number;
  readonly safetyBuffer: number;
}

interface CreateRuntimeBudgetOptions {
  watchdogLimitMs?: number;
  safetyBufferMs?: number;
}

export function createRuntimeBudget(options: CreateRuntimeBudgetOptions = {}): RuntimeBudget {
  const startedAt = Date.now();
  const watchdogLimit = options.watchdogLimitMs ?? WORKER_RUNTIME_BUDGET_MS;
  const safetyBuffer = options.safetyBufferMs ?? RUNTIME_SAFETY_BUFFER_MS;

  return {
    startedAt,
    hardDeadline: startedAt + watchdogLimit,
    watchdogLimit,
    safetyBuffer
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

export function hasSufficientBudget(budget: RuntimeBudget, requiredMs: number): boolean {
  return getSafeRemainingMs(budget) > requiredMs;
}

export function assertBudgetAvailable(budget: RuntimeBudget): void {
  if (getSafeRemainingMs(budget) <= 0) {
    throw new RuntimeBudgetExceededError();
  }
}

