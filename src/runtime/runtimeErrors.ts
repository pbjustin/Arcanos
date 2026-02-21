export class RuntimeBudgetExceededError extends Error {
  constructor() {
    super('runtime_budget_exhausted');
    this.name = 'RuntimeBudgetExceededError';
  }
}

