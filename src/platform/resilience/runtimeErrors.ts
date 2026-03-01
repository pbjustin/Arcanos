/**
 * Runtime error types used by time-budgeted execution flows.
 *
 * These errors are intentionally string-stable (message + name) so they can be
 * relied on in logs, tests, and client-side handling.
 */

export class RuntimeBudgetExceededError extends Error {
  constructor() {
    super('runtime_budget_exhausted');
    this.name = 'RuntimeBudgetExceededError';
  }
}

/**
 * Thrown when an OpenAI call is aborted due to an exhausted runtime budget.
 *
 * Useful for differentiating "timeout budget abort" from other network errors.
 */
export class OpenAIAbortError extends Error {
  constructor() {
    super('openai_call_aborted_due_to_budget');
    this.name = 'OpenAIAbortError';
  }
}
