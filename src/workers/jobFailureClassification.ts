import type { DAGResult } from '../dag/dagNode.js';
import { classifyWorkerExecutionError } from '@services/workerAutonomyService.js';

function extractRetryableHint(value: unknown, depth = 0): boolean | null {
  if (depth > 3 || !value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.retryable === 'boolean') {
    return record.retryable;
  }

  const nestedPlannerHint = extractRetryableHint(record.plannerExecution, depth + 1);
  if (nestedPlannerHint !== null) {
    return nestedPlannerHint;
  }

  return extractRetryableHint(record.output, depth + 1);
}

/**
 * Resolve the worker retry decision for a failed DAG node.
 * Purpose: preserve explicit DAG-layer retryability when available and only fall back to message heuristics otherwise.
 * Inputs/outputs: accepts a failed DAG result and returns the normalized worker failure classification.
 * Edge case behavior: nested planner metadata is inspected because some DAG failures persist retryability inside the diagnostic output payload.
 */
export function classifyDagNodeFailureForWorkerRetry(
  dagResult: Pick<DAGResult, 'errorMessage' | 'retryable' | 'output'>
): {
  message: string;
  retryable: boolean;
} {
  const message = dagResult.errorMessage ?? 'DAG node failed.';
  const explicitRetryable = extractRetryableHint(dagResult);

  if (explicitRetryable !== null) {
    return {
      message,
      retryable: explicitRetryable
    };
  }

  return classifyWorkerExecutionError(message);
}
