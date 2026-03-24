export class RuntimeBudgetExceededError extends Error {
    constructor() {
        super("runtime_budget_exhausted");
        this.name = "RuntimeBudgetExceededError";
    }
}
export class OpenAIAbortError extends Error {
    constructor() {
        super("openai_call_aborted_due_to_budget");
        this.name = "OpenAIAbortError";
    }
}
//# sourceMappingURL=runtimeErrors.js.map