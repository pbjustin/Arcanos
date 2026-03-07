export const DEFAULT_WORKER_TRINITY_RUNTIME_BUDGET_MS = 420_000;
export const DEFAULT_WORKER_TRINITY_STAGE_TIMEOUT_MS = 180_000;
export const DEFAULT_DAG_MAX_TOKEN_BUDGET = 250_000;
export const DEFAULT_DAG_NODE_TIMEOUT_MS = 420_000;
export const DEFAULT_DAG_QUEUE_CLAIM_GRACE_MS = 120_000;

function readPositiveIntegerFromEnvironment(
  variableName: string,
  fallbackValue: number
): number {
  const rawValue = process.env[variableName];
  const parsedValue = Number.parseInt(rawValue ?? '', 10);

  //audit Assumption: long-run worker guardrails must remain finite positive integers; failure risk: malformed env overrides collapse timeout or budget enforcement; expected invariant: each configured limit resolves to a positive integer; handling strategy: ignore invalid overrides and keep the documented fallback.
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return fallbackValue;
  }

  return parsedValue;
}

export interface WorkerExecutionLimits {
  workerTrinityRuntimeBudgetMs: number;
  workerTrinityStageTimeoutMs: number;
  dagMaxTokenBudget: number;
  dagNodeTimeoutMs: number;
  dagQueueClaimGraceMs: number;
}

/**
 * Resolve the shared long-run execution limits used by queued workers and DAG orchestration.
 *
 * Purpose:
 * - Keep worker Trinity budgets, DAG node timeouts, and queue grace periods on one configuration surface.
 *
 * Inputs/outputs:
 * - Input: optional partial overrides for tests or specialized callers.
 * - Output: normalized execution limits with environment-aware fallbacks.
 *
 * Edge case behavior:
 * - Invalid environment values fall back to documented defaults rather than propagating NaN or zero budgets.
 */
export function getWorkerExecutionLimits(
  overrides: Partial<WorkerExecutionLimits> = {}
): WorkerExecutionLimits {
  return {
    workerTrinityRuntimeBudgetMs:
      overrides.workerTrinityRuntimeBudgetMs ??
      readPositiveIntegerFromEnvironment(
        'WORKER_TRINITY_RUNTIME_BUDGET_MS',
        DEFAULT_WORKER_TRINITY_RUNTIME_BUDGET_MS
      ),
    workerTrinityStageTimeoutMs:
      overrides.workerTrinityStageTimeoutMs ??
      readPositiveIntegerFromEnvironment(
        'WORKER_TRINITY_STAGE_TIMEOUT_MS',
        DEFAULT_WORKER_TRINITY_STAGE_TIMEOUT_MS
      ),
    dagMaxTokenBudget:
      overrides.dagMaxTokenBudget ??
      readPositiveIntegerFromEnvironment(
        'DAG_MAX_TOKEN_BUDGET',
        DEFAULT_DAG_MAX_TOKEN_BUDGET
      ),
    dagNodeTimeoutMs:
      overrides.dagNodeTimeoutMs ??
      readPositiveIntegerFromEnvironment(
        'DAG_NODE_TIMEOUT_MS',
        DEFAULT_DAG_NODE_TIMEOUT_MS
      ),
    dagQueueClaimGraceMs:
      overrides.dagQueueClaimGraceMs ??
      readPositiveIntegerFromEnvironment(
        'DAG_QUEUE_CLAIM_GRACE_MS',
        DEFAULT_DAG_QUEUE_CLAIM_GRACE_MS
      )
  };
}
