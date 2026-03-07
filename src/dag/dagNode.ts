export type DAGNodeType = 'task' | 'decision' | 'agent';
export type DAGNodeExecutionStatus = 'success' | 'failed' | 'skipped';

export interface DAGNodeMetrics {
  tokenUsage?: number;
  durationMs?: number;
  [key: string]: number | undefined;
}

export interface DAGResult {
  nodeId: string;
  status: DAGNodeExecutionStatus;
  output: unknown;
  errorMessage?: string;
  metrics?: DAGNodeMetrics;
}

export interface QueuedDAGNodeDefinition {
  id: string;
  type: DAGNodeType;
  dependencies: string[];
  executionKey: string;
  metadata?: Record<string, unknown>;
}

export interface DAGNodeExecutionContext {
  dagId: string;
  node: QueuedDAGNodeDefinition;
  payload: Record<string, unknown>;
  dependencyResults: Record<string, DAGResult>;
  sharedState: Record<string, unknown>;
  depth: number;
  attempt: number;
}

export interface DAGNode {
  id: string;
  type: DAGNodeType;
  dependencies: string[];
  executionKey: string;
  metadata?: Record<string, unknown>;
  execute?(context: DAGNodeExecutionContext): Promise<DAGResult>;
}

/**
 * Remove non-serializable execution functions from a DAG node before queue persistence.
 *
 * Purpose:
 * - Keep queue payloads JSON-safe while preserving routing metadata for worker execution.
 *
 * Inputs/outputs:
 * - Input: runtime DAG node definition.
 * - Output: serializable node definition safe to store in `job_data.input`.
 *
 * Edge case behavior:
 * - Preserves `metadata` only when present to avoid noisy empty objects in job payloads.
 */
export function stripDagNodeExecutor(node: DAGNode): QueuedDAGNodeDefinition {
  const queuedNode: QueuedDAGNodeDefinition = {
    id: node.id,
    type: node.type,
    dependencies: [...node.dependencies],
    executionKey: node.executionKey
  };

  //audit Assumption: queue payloads should stay sparse; failure risk: serialized empty metadata obscures true node configuration; expected invariant: metadata exists only when the node explicitly defines it; handling strategy: copy metadata conditionally.
  if (node.metadata) {
    queuedNode.metadata = { ...node.metadata };
  }

  return queuedNode;
}

/**
 * Build a successful DAG result.
 *
 * Purpose:
 * - Centralize result construction so worker code and tests use one stable success shape.
 *
 * Inputs/outputs:
 * - Input: node identifier, output payload, and optional metrics.
 * - Output: normalized successful DAG result.
 *
 * Edge case behavior:
 * - Accepts any JSON-safe or structured output without additional coercion.
 */
export function createDagSuccessResult(
  nodeId: string,
  output: unknown,
  metrics?: DAGNodeMetrics
): DAGResult {
  return {
    nodeId,
    status: 'success',
    output,
    metrics
  };
}

/**
 * Build a failed DAG result.
 *
 * Purpose:
 * - Provide one consistent failure payload for orchestrator and worker error paths.
 *
 * Inputs/outputs:
 * - Input: node identifier, error message, and optional diagnostic output.
 * - Output: normalized failed DAG result.
 *
 * Edge case behavior:
 * - Falls back to the error message as output when no explicit failure payload is provided.
 */
export function createDagFailureResult(
  nodeId: string,
  errorMessage: string,
  output?: unknown
): DAGResult {
  return {
    nodeId,
    status: 'failed',
    output: output ?? { errorMessage },
    errorMessage
  };
}

/**
 * Build a skipped DAG result.
 *
 * Purpose:
 * - Capture dependency-blocked or guard-blocked nodes without treating them as successful work.
 *
 * Inputs/outputs:
 * - Input: node identifier and skip reason.
 * - Output: normalized skipped DAG result.
 *
 * Edge case behavior:
 * - Stores the skip reason in both `output` and `errorMessage` for simple consumers.
 */
export function createDagSkippedResult(nodeId: string, reason: string): DAGResult {
  return {
    nodeId,
    status: 'skipped',
    output: { reason },
    errorMessage: reason
  };
}
