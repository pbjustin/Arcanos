import {
  DEFAULT_DAG_MAX_TOKEN_BUDGET,
  DEFAULT_DAG_NODE_TIMEOUT_MS
} from './workerExecutionLimits.js';

export interface DagWorkerPoolSettings {
  maxConcurrentNodes: number;
  maxDepth: number;
  maxChildrenPerNode: number;
  maxRetries: number;
  maxAiCallsPerRun: number;
  maxTokenBudgetPerDag: number;
  nodeTimeoutMs: number;
  pollIntervalMs: number;
}

function readPositiveIntegerFromEnvironment(variableName: string, fallbackValue: number): number {
  const rawValue = process.env[variableName];
  const parsedValue = Number.parseInt(rawValue ?? '', 10);

  //audit Assumption: invalid env overrides should not silently produce NaN-driven limits; failure risk: orchestration guards become non-deterministic; expected invariant: every worker-pool limit resolves to a positive integer; handling strategy: ignore invalid overrides and keep the fallback.
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return fallbackValue;
  }

  return parsedValue;
}

/**
 * Resolve DAG worker pool guardrails from environment variables with safe defaults.
 *
 * Purpose:
 * - Centralize concurrency, depth, retry, and timeout limits for orchestration code.
 *
 * Inputs/outputs:
 * - Input: optional partial overrides for tests or route-level customization.
 * - Output: normalized worker pool settings.
 *
 * Edge case behavior:
 * - Invalid environment values fall back to defaults instead of propagating NaN limits.
 */
export function getDagWorkerPoolSettings(
  overrides: Partial<DagWorkerPoolSettings> = {}
): DagWorkerPoolSettings {
  return {
    maxConcurrentNodes: overrides.maxConcurrentNodes ?? readPositiveIntegerFromEnvironment('DAG_MAX_CONCURRENT_NODES', 5),
    maxDepth: overrides.maxDepth ?? readPositiveIntegerFromEnvironment('DAG_MAX_DEPTH', 3),
    maxChildrenPerNode: overrides.maxChildrenPerNode ?? readPositiveIntegerFromEnvironment('DAG_MAX_CHILDREN_PER_NODE', 5),
    maxRetries: overrides.maxRetries ?? readPositiveIntegerFromEnvironment('DAG_MAX_RETRIES', 2),
    maxAiCallsPerRun: overrides.maxAiCallsPerRun ?? readPositiveIntegerFromEnvironment('DAG_MAX_AI_CALLS_PER_RUN', 20),
    maxTokenBudgetPerDag: overrides.maxTokenBudgetPerDag ?? readPositiveIntegerFromEnvironment('DAG_MAX_TOKEN_BUDGET', DEFAULT_DAG_MAX_TOKEN_BUDGET),
    nodeTimeoutMs: overrides.nodeTimeoutMs ?? readPositiveIntegerFromEnvironment('DAG_NODE_TIMEOUT_MS', DEFAULT_DAG_NODE_TIMEOUT_MS),
    pollIntervalMs: overrides.pollIntervalMs ?? readPositiveIntegerFromEnvironment('DAG_POLL_INTERVAL_MS', 250)
  };
}
