import { generateRequestId } from '../shared/idGenerator.js';
import {
  createDagFailureResult,
  createDagSkippedResult,
  type DAGResult
} from './dagNode.js';
import {
  getDependentDagNodeIds,
  validateDagGraph,
  type DAGGraph
} from './dagGraph.js';
import {
  DatabaseBackedDagJobQueue,
  type DagJobQueue
} from '../jobs/jobQueue.js';
import type { DagQueueJobRecord } from '../jobs/jobSchema.js';
import { dagLogger, type DagLogger } from '../utils/logger.js';
import {
  createDagMetricsRecorder,
  type DagMetricsRecorder,
  type DagMetricsSnapshot
} from '../utils/metrics.js';
import { getDagWorkerPoolSettings, type DagWorkerPoolSettings } from '../workers/workerPool.js';

type OrchestratorNodeRuntimeStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'cancelled';

interface RunningDagNodeJob {
  jobId: string;
  nodeId: string;
  completionPromise: Promise<{
    jobId: string;
    record: DagQueueJobRecord;
  }>;
}

export interface DAGRunContext {
  dagId?: string;
  payloadByNodeId?: Record<string, Record<string, unknown>>;
  sharedState?: Record<string, unknown>;
  abortSignal?: AbortSignal;
  observer?: DAGRunObserver;
}

export interface DAGRunSummary {
  dagId: string;
  status: 'success' | 'failed' | 'cancelled';
  resultsByNodeId: Record<string, DAGResult>;
  failedNodeIds: string[];
  skippedNodeIds: string[];
  cancelledNodeIds: string[];
  tokenBudgetUsed: number;
  totalAiCalls: number;
  totalRetries: number;
  maxParallelNodesObserved: number;
  metrics: DagMetricsSnapshot;
  startedAt: string;
  completedAt: string;
}

export type DAGGuardViolationType =
  | 'max_spawn_depth_exceeded'
  | 'max_children_exceeded'
  | 'max_retries_exceeded'
  | 'max_ai_calls_exceeded'
  | 'budget_exceeded'
  | 'deadline_exceeded'
  | 'loop_detected'
  | 'rate_limit_exceeded'
  | 'unknown';

export interface DAGGuardViolationEvent {
  dagId: string;
  type: DAGGuardViolationType;
  at: string;
  nodeId?: string;
  message: string;
  details?: unknown;
}

export interface DAGRunObserver {
  onRunStarted?(payload: { dagId: string; startedAt: string }): void;
  onRunCompleted?(summary: DAGRunSummary): void;
  onNodeQueued?(payload: {
    dagId: string;
    nodeId: string;
    jobId: string;
    attempt: number;
    depth: number;
    queuedAt: string;
  }): void;
  onNodeStarted?(payload: {
    dagId: string;
    nodeId: string;
    jobId: string;
    attempt: number;
    startedAt: string;
    workerId?: string;
  }): void;
  onNodeCompleted?(payload: {
    dagId: string;
    nodeId: string;
    jobId: string;
    result: DAGResult;
    completedAt: string;
  }): void;
  onNodeFailed?(payload: {
    dagId: string;
    nodeId: string;
    jobId: string;
    result: DAGResult;
    completedAt: string;
    attempt: number;
    willRetry: boolean;
  }): void;
  onNodeRetried?(payload: {
    dagId: string;
    nodeId: string;
    attempt: number;
    maxRetries: number;
    at: string;
    errorMessage?: string;
  }): void;
  onNodeSkipped?(payload: {
    dagId: string;
    nodeId: string;
    at: string;
    reason: string;
  }): void;
  onNodeCancelled?(payload: {
    dagId: string;
    nodeId: string;
    at: string;
    reason: string;
  }): void;
  onGuardViolation?(payload: DAGGuardViolationEvent): void;
}

export interface DAGOrchestratorDependencies {
  jobQueue?: DagJobQueue;
  logger?: DagLogger;
  metrics?: DagMetricsRecorder;
  settings?: Partial<DagWorkerPoolSettings>;
}

function createInitialReadyNodeIds(graph: DAGGraph): string[] {
  const fallbackReadyNodeIds = Object.values(graph.nodes)
    .filter(node => node.dependencies.length === 0)
    .map(node => node.id);

  return graph.entrypoints.length > 0 ? [...graph.entrypoints] : fallbackReadyNodeIds;
}

function normalizeTerminalDagResult(jobRecord: DagQueueJobRecord): DAGResult {
  if (jobRecord.output) {
    return jobRecord.output;
  }

  //audit Assumption: failed queue jobs may not have persisted a typed DAG result payload; failure risk: orchestrator loses the cause of a terminal node failure; expected invariant: every terminal node still resolves to a DAGResult; handling strategy: synthesize a failure result from queue metadata when output is missing.
  if (jobRecord.status === 'failed') {
    return createDagFailureResult(
      jobRecord.nodeId,
      jobRecord.errorMessage ?? `DAG node "${jobRecord.nodeId}" failed without a structured result payload.`
    );
  }

  return createDagFailureResult(
    jobRecord.nodeId,
    `DAG node "${jobRecord.nodeId}" completed without a structured result payload.`
  );
}

function extractDagResultTokenUsage(result: DAGResult): number {
  if (typeof result.metrics?.tokenUsage === 'number') {
    return result.metrics.tokenUsage;
  }

  if (!result.output || typeof result.output !== 'object') {
    return 0;
  }

  const output = result.output as {
    meta?: { tokens?: { total_tokens?: number; totalTokens?: number } };
    usage?: { total_tokens?: number };
    tokensUsed?: number;
  };

  //audit Assumption: queued agent outputs can expose token usage under several known shapes; failure risk: budget accounting silently undercounts downstream AI calls; expected invariant: the first numeric token count found is used; handling strategy: inspect supported output shapes and fall back to zero.
  if (typeof output.meta?.tokens?.total_tokens === 'number') {
    return output.meta.tokens.total_tokens;
  }

  if (typeof output.meta?.tokens?.totalTokens === 'number') {
    return output.meta.tokens.totalTokens;
  }

  if (typeof output.usage?.total_tokens === 'number') {
    return output.usage.total_tokens;
  }

  if (typeof output.tokensUsed === 'number') {
    return output.tokensUsed;
  }

  return 0;
}

/**
 * Queue-backed DAG orchestrator layered on the shared worker infrastructure.
 *
 * Purpose:
 * - Schedule DAG nodes subject to dependency, concurrency, retry, and budget guards.
 *
 * Inputs/outputs:
 * - Input: DAG graph plus optional per-node payloads and shared run context.
 * - Output: terminal DAG run summary containing per-node results and metrics.
 *
 * Edge case behavior:
 * - Downstream nodes are skipped when any required dependency fails or is skipped.
 */
export class DAGOrchestrator {
  private readonly jobQueue: DagJobQueue;

  private readonly logger: DagLogger;

  private readonly metrics: DagMetricsRecorder;

  private readonly settings: DagWorkerPoolSettings;

  constructor(dependencies: DAGOrchestratorDependencies = {}) {
    this.jobQueue = dependencies.jobQueue ?? new DatabaseBackedDagJobQueue();
    this.logger = dependencies.logger ?? dagLogger;
    this.metrics = dependencies.metrics ?? createDagMetricsRecorder();
    this.settings = getDagWorkerPoolSettings(dependencies.settings);
  }

  /**
   * Execute a DAG graph using the shared DB-backed worker queue.
   *
   * Purpose:
   * - Turn a static task graph into a guarded sequence of queued worker jobs.
   *
   * Inputs/outputs:
   * - Input: DAG graph and optional run context.
   * - Output: terminal DAG summary with one result per completed or skipped node.
   *
   * Edge case behavior:
   * - Throws only for invalid graph definitions; runtime node failures are reported in the returned summary.
   */
  async runGraph(
    graph: DAGGraph,
    context: DAGRunContext = {}
  ): Promise<DAGRunSummary> {
    const startedAt = new Date().toISOString();
    const dagId = context.dagId || graph.id || generateRequestId('dag');
    const validation = validateDagGraph(graph, {
      maxDepth: this.settings.maxDepth,
      maxChildrenPerNode: this.settings.maxChildrenPerNode
    });

    const readyNodeIds: string[] = createInitialReadyNodeIds(graph);
    const runtimeStatusByNodeId = new Map<string, OrchestratorNodeRuntimeStatus>(
      Object.keys(graph.nodes).map(nodeId => [nodeId, 'pending'])
    );
    const runningJobsByJobId = new Map<string, RunningDagNodeJob>();
    const resultsByNodeId: Record<string, DAGResult> = {};
    const attemptsByNodeId = new Map<string, number>();
    const cancelledNodeIds = new Set<string>();
    let tokenBudgetUsed = 0;
    let totalRetries = 0;
    let totalAiCalls = 0;
    let maxParallelNodesObserved = 0;

    context.observer?.onRunStarted?.({
      dagId,
      startedAt
    });

    const emitGuardViolation = (
      type: DAGGuardViolationType,
      message: string,
      nodeId?: string,
      details?: unknown
    ): void => {
      const violation: DAGGuardViolationEvent = {
        dagId,
        type,
        at: new Date().toISOString(),
        nodeId,
        message,
        details
      };
      this.metrics.incrementCounter(`guard_${type}`);
      context.observer?.onGuardViolation?.(violation);
    };

    const enqueueReadyNode = (nodeId: string): void => {
      const existingStatus = runtimeStatusByNodeId.get(nodeId);

      //audit Assumption: ready queue entries must remain unique per pending node; failure risk: the orchestrator enqueues the same node multiple times and duplicates side effects; expected invariant: only pending nodes that are not already queued are inserted; handling strategy: ignore duplicates and terminal nodes.
      if (existingStatus !== 'pending' || readyNodeIds.includes(nodeId)) {
        return;
      }

      readyNodeIds.push(nodeId);
    };

    const cancelPendingNodes = (reason: string): void => {
      for (const [nodeId, nodeStatus] of runtimeStatusByNodeId.entries()) {
        //audit Assumption: cancellation should only affect nodes that have not reached a terminal state; failure risk: completed or failed nodes are overwritten as cancelled and lose diagnostic history; expected invariant: only pending or queued nodes become cancelled; handling strategy: skip terminal and actively running nodes.
        if (nodeStatus !== 'pending' && nodeStatus !== 'queued') {
          continue;
        }

        runtimeStatusByNodeId.set(nodeId, 'cancelled');
        cancelledNodeIds.add(nodeId);
        const readyNodeIndex = readyNodeIds.indexOf(nodeId);
        if (readyNodeIndex >= 0) {
          readyNodeIds.splice(readyNodeIndex, 1);
        }
        context.observer?.onNodeCancelled?.({
          dagId,
          nodeId,
          at: new Date().toISOString(),
          reason
        });
      }
    };

    const cascadeBlockedDependents = (nodeId: string, reason: string): void => {
      for (const dependentNodeId of validation.dependentNodeIdsByNodeId[nodeId] ?? []) {
        const dependentNode = graph.nodes[dependentNodeId];
        const dependentStatus = runtimeStatusByNodeId.get(dependentNodeId);

        if (
          dependentStatus === 'completed' ||
          dependentStatus === 'failed' ||
          dependentStatus === 'skipped' ||
          dependentStatus === 'cancelled'
        ) {
          continue;
        }

        const hasBlockedDependency = dependentNode.dependencies.some(dependencyNodeId => {
          const dependencyStatus = runtimeStatusByNodeId.get(dependencyNodeId);
          return dependencyStatus === 'failed' || dependencyStatus === 'skipped';
        });

        if (!hasBlockedDependency) {
          continue;
        }

        runtimeStatusByNodeId.set(dependentNodeId, 'skipped');
        resultsByNodeId[dependentNodeId] = createDagSkippedResult(dependentNodeId, reason);
        this.metrics.incrementCounter('node_skipped');
        context.observer?.onNodeSkipped?.({
          dagId,
          nodeId: dependentNodeId,
          at: new Date().toISOString(),
          reason
        });
        cascadeBlockedDependents(
          dependentNodeId,
          `Dependency for node "${dependentNodeId}" did not complete successfully.`
        );
      }
    };

    const skipNodeAndDependents = (nodeId: string, reason: string): void => {
      const existingStatus = runtimeStatusByNodeId.get(nodeId);

      //audit Assumption: skip propagation should be idempotent; failure risk: repeated cascades overwrite real failures or inflate skipped metrics; expected invariant: each node becomes skipped at most once; handling strategy: ignore nodes that already reached a terminal state.
      if (
        existingStatus === 'completed' ||
        existingStatus === 'failed' ||
        existingStatus === 'skipped' ||
        existingStatus === 'cancelled'
      ) {
        return;
      }

      runtimeStatusByNodeId.set(nodeId, 'skipped');
      resultsByNodeId[nodeId] = createDagSkippedResult(nodeId, reason);
      this.metrics.incrementCounter('node_skipped');
      context.observer?.onNodeSkipped?.({
        dagId,
        nodeId,
        at: new Date().toISOString(),
        reason
      });
      cascadeBlockedDependents(nodeId, reason);
    };

    const scheduleReadyNodes = async (): Promise<void> => {
      if (context.abortSignal?.aborted) {
        cancelPendingNodes('Run cancellation requested.');
        return;
      }

      while (
        readyNodeIds.length > 0 &&
        runningJobsByJobId.size < this.settings.maxConcurrentNodes
      ) {
        const nextNodeId = readyNodeIds.shift();
        if (!nextNodeId) {
          continue;
        }

        const node = graph.nodes[nextNodeId];
        const currentStatus = runtimeStatusByNodeId.get(nextNodeId);

        if (currentStatus !== 'pending') {
          continue;
        }

        //audit Assumption: the DAG-wide AI call cap must prevent further queue expansion; failure risk: recursive or broad graphs exhaust upstream model budgets; expected invariant: no new node is enqueued once the cap is reached; handling strategy: emit a guard violation and skip blocked descendants.
        if (totalAiCalls >= this.settings.maxAiCallsPerRun) {
          emitGuardViolation(
            'max_ai_calls_exceeded',
            `DAG AI call budget exceeded (${totalAiCalls}/${this.settings.maxAiCallsPerRun}).`,
            nextNodeId,
            {
              totalAiCalls,
              maxAiCallsPerRun: this.settings.maxAiCallsPerRun
            }
          );
          skipNodeAndDependents(
            nextNodeId,
            `DAG AI call budget exceeded (${totalAiCalls}/${this.settings.maxAiCallsPerRun}).`
          );
          continue;
        }

        //audit Assumption: token budget should stop future scheduling but not retroactively cancel already-running nodes; failure risk: new nodes are enqueued after the DAG exceeds its budget; expected invariant: unscheduled nodes do not start once the budget is exhausted; handling strategy: skip the node and cascade the block downstream.
        if (tokenBudgetUsed >= this.settings.maxTokenBudgetPerDag) {
          emitGuardViolation(
            'budget_exceeded',
            `DAG token budget exceeded (${tokenBudgetUsed}/${this.settings.maxTokenBudgetPerDag}).`,
            nextNodeId,
            {
              tokenBudgetUsed,
              maxTokenBudgetPerDag: this.settings.maxTokenBudgetPerDag
            }
          );
          skipNodeAndDependents(
            nextNodeId,
            `DAG token budget exceeded (${tokenBudgetUsed}/${this.settings.maxTokenBudgetPerDag}).`
          );
          continue;
        }

        const dependencyResults = Object.fromEntries(
          node.dependencies
            .map(dependencyNodeId => [dependencyNodeId, resultsByNodeId[dependencyNodeId]])
            .filter(([, result]) => Boolean(result))
        ) as Record<string, DAGResult>;
        const attempt = attemptsByNodeId.get(nextNodeId) ?? 0;
        const queuedJob = await this.jobQueue.enqueueDagNodeJob({
          dagId,
          node,
          payload: context.payloadByNodeId?.[nextNodeId] ?? {},
          dependencyResults,
          sharedState: context.sharedState ?? {},
          depth: validation.depthByNodeId[nextNodeId] ?? 0,
          attempt,
          maxRetries: this.settings.maxRetries,
          waitingTimeoutMs: this.settings.nodeTimeoutMs
        });

        runtimeStatusByNodeId.set(nextNodeId, 'queued');
        totalAiCalls += 1;
        this.metrics.incrementCounter('node_enqueued');
        this.metrics.recordGauge('running_nodes', runningJobsByJobId.size + 1);
        this.logger.info('Queued DAG node', {
          dagId,
          nodeId: nextNodeId,
          jobId: queuedJob.jobId,
          attempt
        });
        context.observer?.onNodeQueued?.({
          dagId,
          nodeId: nextNodeId,
          jobId: queuedJob.jobId,
          attempt,
          depth: validation.depthByNodeId[nextNodeId] ?? 0,
          queuedAt: queuedJob.timestamps.queuedAt
        });

        runningJobsByJobId.set(queuedJob.jobId, {
          jobId: queuedJob.jobId,
          nodeId: nextNodeId,
          completionPromise: this.jobQueue
            .waitForDagJobCompletion(queuedJob.jobId, {
              pollIntervalMs: this.settings.pollIntervalMs,
              timeoutMs: this.settings.nodeTimeoutMs,
              onStatusChange: statusRecord => {
                if (statusRecord.status !== 'running') {
                  return;
                }

                runtimeStatusByNodeId.set(statusRecord.nodeId, 'running');
                context.observer?.onNodeStarted?.({
                  dagId,
                  nodeId: statusRecord.nodeId,
                  jobId: statusRecord.jobId,
                  attempt: statusRecord.retries,
                  startedAt: statusRecord.timestamps.updatedAt,
                  workerId: statusRecord.workerId ?? undefined
                });
              }
            })
            .then(record => ({ jobId: queuedJob.jobId, record }))
        });
        maxParallelNodesObserved = Math.max(maxParallelNodesObserved, runningJobsByJobId.size);
      }
    };

    await scheduleReadyNodes();

    while (runningJobsByJobId.size > 0 || readyNodeIds.length > 0) {
      await scheduleReadyNodes();

      if (context.abortSignal?.aborted && runningJobsByJobId.size === 0) {
        break;
      }

      if (runningJobsByJobId.size === 0) {
        break;
      }

      const completedRunningJob = await Promise.race(
        Array.from(runningJobsByJobId.values()).map(runningJob => runningJob.completionPromise)
      );
      runningJobsByJobId.delete(completedRunningJob.jobId);
      this.metrics.recordGauge('running_nodes', runningJobsByJobId.size);

      const terminalResult = normalizeTerminalDagResult(completedRunningJob.record);
      const nodeId = completedRunningJob.record.nodeId;

      if (terminalResult.status === 'failed') {
        const nextAttempt = (attemptsByNodeId.get(nodeId) ?? 0) + 1;
        attemptsByNodeId.set(nodeId, nextAttempt);
        const willRetry = nextAttempt <= completedRunningJob.record.maxRetries;
        context.observer?.onNodeFailed?.({
          dagId,
          nodeId,
          jobId: completedRunningJob.record.jobId,
          result: terminalResult,
          completedAt: completedRunningJob.record.timestamps.completedAt ?? new Date().toISOString(),
          attempt: nextAttempt,
          willRetry
        });

        //audit Assumption: transient worker failures should be retried up to the configured cap; failure risk: first-attempt blips abort otherwise healthy DAG runs; expected invariant: retries stop once `maxRetries` is exhausted; handling strategy: requeue failed nodes while attempts remain.
        if (willRetry) {
          runtimeStatusByNodeId.set(nodeId, 'pending');
          this.metrics.incrementCounter('node_retried');
          totalRetries += 1;
          this.logger.warn('Retrying DAG node after failure', {
            dagId,
            nodeId,
            attempt: nextAttempt,
            maxRetries: completedRunningJob.record.maxRetries,
            errorMessage: terminalResult.errorMessage
          });
          context.observer?.onNodeRetried?.({
            dagId,
            nodeId,
            attempt: nextAttempt,
            maxRetries: completedRunningJob.record.maxRetries,
            at: new Date().toISOString(),
            errorMessage: terminalResult.errorMessage
          });
          enqueueReadyNode(nodeId);
          continue;
        }

        runtimeStatusByNodeId.set(nodeId, 'failed');
        resultsByNodeId[nodeId] = terminalResult;
        emitGuardViolation(
          'max_retries_exceeded',
          `Node "${nodeId}" exhausted retry budget (${completedRunningJob.record.maxRetries}).`,
          nodeId,
          {
            retries: nextAttempt,
            maxRetries: completedRunningJob.record.maxRetries
          }
        );
        cascadeBlockedDependents(
          nodeId,
          terminalResult.errorMessage ?? `Node "${nodeId}" failed.`
        );
        continue;
      }

      if (terminalResult.status === 'skipped') {
        runtimeStatusByNodeId.set(nodeId, 'skipped');
        resultsByNodeId[nodeId] = terminalResult;
        cascadeBlockedDependents(
          nodeId,
          terminalResult.errorMessage ?? `Node "${nodeId}" was skipped.`
        );
        continue;
      }

      runtimeStatusByNodeId.set(nodeId, 'completed');
      resultsByNodeId[nodeId] = terminalResult;
      tokenBudgetUsed += extractDagResultTokenUsage(terminalResult);
      this.metrics.incrementCounter('node_completed');
      this.metrics.recordGauge('token_budget_used', tokenBudgetUsed);
      context.observer?.onNodeCompleted?.({
        dagId,
        nodeId,
        jobId: completedRunningJob.record.jobId,
        result: terminalResult,
        completedAt: completedRunningJob.record.timestamps.completedAt ?? new Date().toISOString()
      });

      for (const dependentNodeId of getDependentDagNodeIds(graph, nodeId)) {
        const dependentNode = graph.nodes[dependentNodeId];
        const blockedDependency = dependentNode.dependencies.some(dependencyNodeId => {
          const dependencyStatus = runtimeStatusByNodeId.get(dependencyNodeId);
          return dependencyStatus === 'failed' || dependencyStatus === 'skipped';
        });

        if (blockedDependency) {
          skipNodeAndDependents(
            dependentNodeId,
            `Dependency for node "${dependentNodeId}" did not complete successfully.`
          );
          continue;
        }

        const allDependenciesCompleted = dependentNode.dependencies.every(dependencyNodeId => {
          const dependencyStatus = runtimeStatusByNodeId.get(dependencyNodeId);
          return dependencyStatus === 'completed';
        });

        if (allDependenciesCompleted) {
          enqueueReadyNode(dependentNodeId);
        }
      }
    }

    const unresolvedNodeIds = Object.keys(graph.nodes).filter(nodeId => {
      const status = runtimeStatusByNodeId.get(nodeId);
      return status === 'pending' || status === 'queued' || status === 'running';
    });

    for (const unresolvedNodeId of unresolvedNodeIds) {
      if (context.abortSignal?.aborted) {
        runtimeStatusByNodeId.set(unresolvedNodeId, 'cancelled');
        cancelledNodeIds.add(unresolvedNodeId);
        context.observer?.onNodeCancelled?.({
          dagId,
          nodeId: unresolvedNodeId,
          at: new Date().toISOString(),
          reason: 'Run cancellation requested.'
        });
      } else {
        runtimeStatusByNodeId.set(unresolvedNodeId, 'failed');
        resultsByNodeId[unresolvedNodeId] = createDagFailureResult(
          unresolvedNodeId,
          `Node "${unresolvedNodeId}" was left unresolved by the DAG orchestrator.`
        );
        this.metrics.incrementCounter('node_unresolved');
        emitGuardViolation(
          'deadline_exceeded',
          `Node "${unresolvedNodeId}" was left unresolved by the DAG orchestrator.`,
          unresolvedNodeId
        );
      }
    }

    const failedNodeIds = Object.entries(resultsByNodeId)
      .filter(([, result]) => result.status === 'failed')
      .map(([nodeId]) => nodeId)
      .sort();
    const skippedNodeIds = Object.entries(resultsByNodeId)
      .filter(([, result]) => result.status === 'skipped')
      .map(([nodeId]) => nodeId)
      .sort();
    const orderedCancelledNodeIds = Array.from(cancelledNodeIds.values()).sort();

    const completedAt = new Date().toISOString();
    const status = context.abortSignal?.aborted
      ? 'cancelled'
      : failedNodeIds.length === 0 && skippedNodeIds.length === 0
      ? 'success'
      : 'failed';

    const summary: DAGRunSummary = {
      dagId,
      status,
      resultsByNodeId,
      failedNodeIds,
      skippedNodeIds,
      cancelledNodeIds: orderedCancelledNodeIds,
      tokenBudgetUsed,
      totalAiCalls,
      totalRetries,
      maxParallelNodesObserved,
      metrics: this.metrics.snapshot(),
      startedAt,
      completedAt
    };

    context.observer?.onRunCompleted?.(summary);
    return summary;
  }
}
