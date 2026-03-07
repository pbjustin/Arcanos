import type { DAGNode } from './dagNode.js';

export interface DAGGraphEdge {
  from: string;
  to: string;
}

export interface DAGGraph {
  id?: string;
  nodes: Record<string, DAGNode>;
  edges: DAGGraphEdge[];
  entrypoints: string[];
}

export interface DAGGraphValidationOptions {
  maxDepth: number;
  maxChildrenPerNode: number;
}

export interface DAGGraphValidationResult {
  depthByNodeId: Record<string, number>;
  dependentNodeIdsByNodeId: Record<string, string[]>;
}

/**
 * Return the node identifiers that depend on a completed node.
 *
 * Purpose:
 * - Give the orchestrator one stable lookup for downstream scheduling decisions.
 *
 * Inputs/outputs:
 * - Input: DAG graph and the completed node identifier.
 * - Output: dependent node identifiers in edge declaration order.
 *
 * Edge case behavior:
 * - Returns an empty array when the node has no outgoing edges.
 */
export function getDependentDagNodeIds(graph: DAGGraph, nodeId: string): string[] {
  return graph.edges
    .filter(edge => edge.from === nodeId)
    .map(edge => edge.to);
}

/**
 * Validate graph integrity and compute static scheduling metadata.
 *
 * Purpose:
 * - Fail fast on invalid DAG definitions before any queue jobs are created.
 *
 * Inputs/outputs:
 * - Input: DAG graph plus static safety limits.
 * - Output: depth and dependent-node indexes used by the orchestrator.
 *
 * Edge case behavior:
 * - Throws for missing nodes, dependency mismatches, cycles, excessive depth, and excessive fan-out.
 */
export function validateDagGraph(
  graph: DAGGraph,
  options: DAGGraphValidationOptions
): DAGGraphValidationResult {
  const nodeIds = Object.keys(graph.nodes);

  //audit Assumption: an empty graph is always an operator error; failure risk: orchestration loop reports false success without executing work; expected invariant: every DAG has at least one node; handling strategy: reject before scheduling begins.
  if (nodeIds.length === 0) {
    throw new Error('DAG graph must contain at least one node.');
  }

  const dependentNodeIdsByNodeId: Record<string, string[]> = {};
  for (const nodeId of nodeIds) {
    dependentNodeIdsByNodeId[nodeId] = getDependentDagNodeIds(graph, nodeId);
  }

  for (const entrypoint of graph.entrypoints) {
    //audit Assumption: entrypoints must refer to declared nodes; failure risk: ready queue starts with invalid identifiers and stalls immediately; expected invariant: every entrypoint exists in `graph.nodes`; handling strategy: reject unknown entrypoints.
    if (!graph.nodes[entrypoint]) {
      throw new Error(`DAG entrypoint "${entrypoint}" does not exist in graph.nodes.`);
    }

    //audit Assumption: entrypoints should be runnable immediately; failure risk: the orchestrator starts from a node that still waits on predecessors and deadlocks; expected invariant: every entrypoint has zero dependencies; handling strategy: reject blocked entrypoints.
    if (graph.nodes[entrypoint].dependencies.length > 0) {
      throw new Error(`DAG entrypoint "${entrypoint}" cannot declare dependencies.`);
    }
  }

  for (const edge of graph.edges) {
    //audit Assumption: edges can only connect declared nodes; failure risk: scheduling metadata diverges from executable graph state; expected invariant: every edge endpoint exists; handling strategy: reject invalid edges.
    if (!graph.nodes[edge.from] || !graph.nodes[edge.to]) {
      throw new Error(`DAG edge "${edge.from}" -> "${edge.to}" references an unknown node.`);
    }
  }

  for (const node of Object.values(graph.nodes)) {
    for (const dependencyNodeId of node.dependencies) {
      //audit Assumption: dependency lists must stay aligned with node registry; failure risk: runtime deadlocks waiting for undeclared predecessors; expected invariant: every dependency identifier exists; handling strategy: reject unknown dependencies.
      if (!graph.nodes[dependencyNodeId]) {
        throw new Error(`DAG node "${node.id}" depends on unknown node "${dependencyNodeId}".`);
      }
    }

    for (const dependencyNodeId of node.dependencies) {
      //audit Assumption: graph edges and dependency lists must describe the same topology; failure risk: downstream traversal misses runnable nodes or invents impossible dependencies; expected invariant: every dependency has a matching edge; handling strategy: reject mismatched topology.
      if (!graph.edges.some(edge => edge.from === dependencyNodeId && edge.to === node.id)) {
        throw new Error(`DAG edge missing for dependency "${dependencyNodeId}" -> "${node.id}".`);
      }
    }

    //audit Assumption: static child fan-out is the first line of defense against runaway orchestration; failure risk: one node floods the queue with unbounded descendants; expected invariant: no node exceeds configured child count; handling strategy: reject over-connected nodes before scheduling.
    if ((dependentNodeIdsByNodeId[node.id] ?? []).length > options.maxChildrenPerNode) {
      throw new Error(
        `DAG node "${node.id}" exceeds maxChildrenPerNode=${options.maxChildrenPerNode}.`
      );
    }
  }

  const inDegreeByNodeId = new Map<string, number>(
    nodeIds.map(nodeId => [nodeId, graph.nodes[nodeId]?.dependencies.length ?? 0])
  );
  const readyNodeIds = nodeIds.filter(nodeId => (inDegreeByNodeId.get(nodeId) ?? 0) === 0);
  const depthByNodeId = Object.fromEntries(readyNodeIds.map(nodeId => [nodeId, 0])) as Record<string, number>;
  const visitedNodeIds: string[] = [];
  const traversalQueue = [...readyNodeIds];

  //audit Assumption: DAGs without explicit entrypoints should still be derivable from zero-dependency nodes; failure risk: operators must duplicate topology in two places; expected invariant: at least one zero-dependency node exists in every valid DAG; handling strategy: use topological roots as the traversal seed.
  if (traversalQueue.length === 0) {
    throw new Error('DAG graph must contain at least one zero-dependency node.');
  }

  while (traversalQueue.length > 0) {
    const currentNodeId = traversalQueue.shift();
    if (!currentNodeId) {
      continue;
    }

    visitedNodeIds.push(currentNodeId);
    const currentDepth = depthByNodeId[currentNodeId] ?? 0;

    for (const dependentNodeId of dependentNodeIdsByNodeId[currentNodeId] ?? []) {
      const nextDepth = currentDepth + 1;
      const existingDepth = depthByNodeId[dependentNodeId];

      //audit Assumption: the deepest path determines recursion risk for a node; failure risk: shallower updates hide a deeper branch and bypass depth limits; expected invariant: stored depth equals the maximum discovered depth; handling strategy: replace only when a deeper path is found.
      if (existingDepth === undefined || nextDepth > existingDepth) {
        depthByNodeId[dependentNodeId] = nextDepth;
      }

      const nextInDegree = (inDegreeByNodeId.get(dependentNodeId) ?? 0) - 1;
      inDegreeByNodeId.set(dependentNodeId, nextInDegree);

      if (nextInDegree === 0) {
        traversalQueue.push(dependentNodeId);
      }
    }
  }

  //audit Assumption: incomplete topological traversal indicates a cycle; failure risk: orchestrator waits forever for dependencies that can never resolve; expected invariant: every node is visited once in a valid DAG; handling strategy: reject cyclic graphs.
  if (visitedNodeIds.length !== nodeIds.length) {
    throw new Error('DAG graph contains a cycle or an unreachable dependency chain.');
  }

  for (const [nodeId, depth] of Object.entries(depthByNodeId)) {
    //audit Assumption: depth is the correct recursion proxy for queued DAG execution; failure risk: recursive expansion exceeds cost and latency bounds; expected invariant: every node depth stays within configured guardrails; handling strategy: reject graphs that exceed `maxDepth`.
    if (depth > options.maxDepth) {
      throw new Error(`DAG node "${nodeId}" exceeds maxDepth=${options.maxDepth}.`);
    }
  }

  return {
    depthByNodeId,
    dependentNodeIdsByNodeId
  };
}
