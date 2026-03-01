export declare const WATCHDOG_LIMIT_MS = 45000;
export declare const SAFETY_BUFFER_MS = 2000;
export interface RuntimeBudget {
    readonly startedAt: number;
    readonly hardDeadline: number;
    readonly watchdogLimit: number;
    readonly safetyBuffer: number;
}
export declare function createRuntimeBudget(): RuntimeBudget;
export declare function getElapsedMs(budget: RuntimeBudget): number;
export declare function getRemainingMs(budget: RuntimeBudget): number;
export declare function getSafeRemainingMs(budget: RuntimeBudget): number;
export declare function hasSufficientBudget(budget: RuntimeBudget, requiredMs: number): boolean;
export declare function assertBudgetAvailable(budget: RuntimeBudget): void;
//# sourceMappingURL=runtimeBudget.d.ts.map