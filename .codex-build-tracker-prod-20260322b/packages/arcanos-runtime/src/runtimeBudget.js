import { RuntimeBudgetExceededError } from "./runtimeErrors.js";
export const WATCHDOG_LIMIT_MS = 45000;
export const SAFETY_BUFFER_MS = 2000;
export function createRuntimeBudget() {
    const startedAt = Date.now();
    return {
        startedAt,
        hardDeadline: startedAt + WATCHDOG_LIMIT_MS,
        watchdogLimit: WATCHDOG_LIMIT_MS,
        safetyBuffer: SAFETY_BUFFER_MS,
    };
}
export function getElapsedMs(budget) {
    return Date.now() - budget.startedAt;
}
export function getRemainingMs(budget) {
    return budget.hardDeadline - Date.now();
}
export function getSafeRemainingMs(budget) {
    return getRemainingMs(budget) - budget.safetyBuffer;
}
export function hasSufficientBudget(budget, requiredMs) {
    return getSafeRemainingMs(budget) > requiredMs;
}
export function assertBudgetAvailable(budget) {
    // Use a minimal required amount, or just check if > 0
    if (getSafeRemainingMs(budget) <= 0) {
        throw new RuntimeBudgetExceededError();
    }
}
//# sourceMappingURL=runtimeBudget.js.map