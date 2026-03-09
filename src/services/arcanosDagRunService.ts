import { generateRequestId } from '../shared/idGenerator.js';
import {
  getDagRunSnapshotById,
  upsertDagRunSnapshot
} from '../core/db/repositories/dagRunRepository.js';
import { DAGOrchestrator, type DAGRunObserver, type DAGRunSummary as InternalDagRunSummary } from '../dag/orchestrator.js';
import {
  buildDagTemplate,
  resolvePublicDagTemplateName,
  type DagTemplateDefinition
} from '../dag/templates.js';
import { getDagWorkerPoolSettings, type DagWorkerPoolSettings } from '../workers/workerPool.js';
import {
  TrinityOrchestrator,
  type TrinityRunRecord
} from '../workers/orchestrator.js';
import type {
  CreateDagRunRequest,
  DagEvent,
  DagEventsData,
  DagLineageData,
  DagMetricsData,
  DagRunError,
  DagRunMetrics,
  DagRunSummary,
  DagTreeData,
  DagTreeNode,
  DagVerification,
  DagVerificationLineage,
  DagVerificationData,
  ErrorInfo,
  ExecutionLimits,
  FeatureFlags,
  FinalOutput,
  GuardViolation,
  NodeDetail,
  NodeMetrics,
  NodeStatus,
  TrinityNodeMetadata,
  TrinityPipelineRole,
  TrinityRuntimeMetadata
} from '../shared/types/arcanos-verification-contract.types.js';
import { sleep } from '@shared/sleep.js';

type DagRunExecutionState = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';

interface StoredNodeDetail extends NodeDetail {
  childNodeIds: string[];
  queuedAt?: string;
}

interface StoredDagRunRecord {
  runId: string;
  sessionId: string;
  template: string;
  plannerNodeId: string | null;
  rootNodeId: string | null;
  status: DagRunExecutionState;
  createdAt: string;
  updatedAt: string;
  summary: DagRunSummary;
  nodesById: Map<string, StoredNodeDetail>;
  events: DagEvent[];
  errors: DagRunError[];
  guardViolations: GuardViolation[];
  metrics: DagRunMetrics;
  verification: DagVerification;
  limits: ExecutionLimits;
  features: FeatureFlags;
  loopDetected: boolean;
  orchestratorState: TrinityRunRecord;
  templateDefinition: DagTemplateDefinition;
  abortController: AbortController;
  executionPromise?: Promise<void>;
}

interface PersistedDagRunSnapshot {
  runId: string;
  sessionId: string;
  template: string;
  plannerNodeId: string | null;
  rootNodeId: string | null;
  status: DagRunExecutionState;
  createdAt: string;
  updatedAt: string;
  summary: DagRunSummary;
  nodes: StoredNodeDetail[];
  events: DagEvent[];
  errors: DagRunError[];
  guardViolations: GuardViolation[];
  metrics: DagRunMetrics;
  verification: DagVerification;
  limits: ExecutionLimits;
  features: FeatureFlags;
  loopDetected: boolean;
  orchestratorState: TrinityRunRecord;
}

const TRINITY_PIPELINE_NAME = 'trinity' as const;
const TRINITY_PIPELINE_VERSION = '1.0' as const;

export interface WaitForDagRunUpdateOptions {
  updatedAfter?: string;
  waitForUpdateMs?: number;
}

export interface DagRunWaitResult {
  run: DagRunSummary;
  updated: boolean;
  waited: boolean;
}

function createFeatureFlags(): FeatureFlags {
  return {
    dagOrchestration: true,
    parallelExecution: true,
    recursiveSpawning: false,
    jobTreeInspection: true,
    eventStreaming: false
  };
}

function createExecutionLimits(settings: DagWorkerPoolSettings): ExecutionLimits {
  return {
    maxConcurrency: settings.maxConcurrentNodes,
    maxSpawnDepth: settings.maxDepth,
    maxChildrenPerNode: settings.maxChildrenPerNode,
    maxRetriesPerNode: settings.maxRetries,
    maxAiCallsPerRun: settings.maxAiCallsPerRun,
    defaultNodeTimeoutMs: settings.nodeTimeoutMs
  };
}

function createTrinityRuntimeMetadata(): TrinityRuntimeMetadata {
  return {
    pipeline: TRINITY_PIPELINE_NAME,
    trinity_version: TRINITY_PIPELINE_VERSION
  };
}

function mapAgentRoleToTrinityPipelineRole(agentRole: NodeDetail['agentRole']): TrinityPipelineRole {
  return `trinity_${agentRole}` as TrinityPipelineRole;
}

function createTrinityNodeMetadata(agentRole: NodeDetail['agentRole']): TrinityNodeMetadata {
  return {
    ...createTrinityRuntimeMetadata(),
    role: mapAgentRoleToTrinityPipelineRole(agentRole)
  };
}

function normalizeNodeOutput(output: unknown): Record<string, unknown> | undefined {
  if (output === undefined || output === null) {
    return undefined;
  }

  if (typeof output === 'object' && !Array.isArray(output)) {
    return output as Record<string, unknown>;
  }

  return {
    value: output
  };
}

function extractNodeMetricsFromOutput(output: Record<string, unknown> | undefined): NodeMetrics | undefined {
  if (!output) {
    return undefined;
  }

  const meta = output.meta as
    | { tokens?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }
    | undefined;
  const usage = output.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
  const metrics: NodeMetrics = {};

  if (typeof meta?.tokens?.prompt_tokens === 'number') {
    metrics.promptTokens = meta.tokens.prompt_tokens;
  } else if (typeof usage?.prompt_tokens === 'number') {
    metrics.promptTokens = usage.prompt_tokens;
  }

  if (typeof meta?.tokens?.completion_tokens === 'number') {
    metrics.completionTokens = meta.tokens.completion_tokens;
  } else if (typeof usage?.completion_tokens === 'number') {
    metrics.completionTokens = usage.completion_tokens;
  } else if (typeof meta?.tokens?.total_tokens === 'number') {
    metrics.completionTokens = meta.tokens.total_tokens;
  } else if (typeof usage?.total_tokens === 'number') {
    metrics.completionTokens = usage.total_tokens;
  }

  return Object.keys(metrics).length > 0 ? metrics : undefined;
}

function extractNodeDuration(metrics: NodeMetrics | undefined, output: Record<string, unknown> | undefined): number | undefined {
  if (typeof metrics?.durationMs === 'number') {
    return metrics.durationMs;
  }

  if (!output) {
    return undefined;
  }

  const resultMetrics = output.metrics as { durationMs?: number } | undefined;
  return typeof resultMetrics?.durationMs === 'number' ? resultMetrics.durationMs : undefined;
}

function normalizeNodeStatus(status: NodeStatus): NodeStatus {
  return status;
}

function createDefaultMetrics(totalNodes: number): DagRunMetrics {
  return {
    totalNodes,
    maxParallelNodesObserved: 0,
    maxSpawnDepthObserved: 0,
    totalRetries: 0,
    totalFailures: 0,
    totalAiCalls: 0,
    estimatedCostUsd: 0,
    wallClockDurationMs: 0,
    sumNodeDurationMs: 0,
    queueWaitMsP50: 0,
    queueWaitMsP95: 0
  };
}

function createDefaultVerification(): DagVerification {
  return {
    runCompleted: false,
    plannerSpawnedChildren: false,
    parallelExecutionObserved: false,
    aggregationRanLast: false,
    retryPolicyRespected: true,
    budgetPolicyRespected: true,
    deadlockDetected: false,
    stalledJobsDetected: false,
    loopDetected: false
  };
}

function toEpochMilliseconds(timestamp: string | undefined): number {
  if (!timestamp) {
    return 0;
  }

  const parsedValue = Date.parse(timestamp);
  return Number.isFinite(parsedValue) ? parsedValue : 0;
}

function calculateMaxParallelNodesObserved(
  nodeList: StoredNodeDetail[],
  updatedAt: string
): number {
  const intervalBoundaries: Array<{
    timestampMs: number;
    delta: 1 | -1;
    sortOrder: number;
  }> = [];
  const fallbackEndTimestampMs = toEpochMilliseconds(updatedAt);

  for (const node of nodeList) {
    const startedAtTimestampMs = toEpochMilliseconds(node.startedAt);
    if (startedAtTimestampMs <= 0) {
      continue;
    }

    const completedAtTimestampMs = node.completedAt
      ? toEpochMilliseconds(node.completedAt)
      : fallbackEndTimestampMs;
    const normalizedCompletedAtTimestampMs =
      completedAtTimestampMs > startedAtTimestampMs
        ? completedAtTimestampMs
        : startedAtTimestampMs + 1;

    intervalBoundaries.push({
      timestampMs: startedAtTimestampMs,
      delta: 1,
      sortOrder: 1
    });
    intervalBoundaries.push({
      timestampMs: normalizedCompletedAtTimestampMs,
      delta: -1,
      sortOrder: 0
    });
  }

  intervalBoundaries.sort((leftBoundary, rightBoundary) => {
    if (leftBoundary.timestampMs !== rightBoundary.timestampMs) {
      return leftBoundary.timestampMs - rightBoundary.timestampMs;
    }

    return leftBoundary.sortOrder - rightBoundary.sortOrder;
  });

  let currentlyRunningNodes = 0;
  let maxParallelNodesObserved = 0;

  for (const boundary of intervalBoundaries) {
    currentlyRunningNodes += boundary.delta;
    maxParallelNodesObserved = Math.max(
      maxParallelNodesObserved,
      currentlyRunningNodes
    );
  }

  return maxParallelNodesObserved;
}

function cloneFinalOutput(finalOutput: FinalOutput | undefined): FinalOutput | undefined {
  if (!finalOutput) {
    return undefined;
  }

  return { ...finalOutput };
}

function cloneDagRunSummary(summary: DagRunSummary): DagRunSummary {
  return {
    ...createTrinityRuntimeMetadata(),
    ...summary,
    template: resolvePublicDagTemplateName(summary.template),
    finalOutput: cloneFinalOutput(summary.finalOutput)
  };
}

function cloneSerializable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneStoredNodeDetail(node: StoredNodeDetail): StoredNodeDetail {
  return cloneSerializable(node);
}

function cloneTrinityRunRecord(record: TrinityRunRecord): TrinityRunRecord {
  return cloneSerializable(record);
}

function normalizeTrinityRunStatus(
  status: DagRunExecutionState
): TrinityRunRecord['status'] {
  switch (status) {
    case 'complete':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'queued':
    case 'running':
    default:
      return 'running';
  }
}

function createFallbackTrinityRunRecord(
  snapshot: {
    runId: string;
    status: DagRunExecutionState;
    updatedAt: string;
    nodes: StoredNodeDetail[];
  }
): TrinityRunRecord {
  const artifactReferences = Array.from(
    new Set(
      snapshot.nodes
        .map(node => node.artifactRef)
        .filter(
          (artifactReference): artifactReference is string =>
            typeof artifactReference === 'string' && artifactReference.trim().length > 0
        )
    )
  );

  return {
    runId: snapshot.runId,
    status: normalizeTrinityRunStatus(snapshot.status),
    activeNodes: snapshot.nodes
      .filter(node => node.status === 'running')
      .map(node => node.nodeId),
    completedNodes: snapshot.nodes
      .filter(node => node.status === 'complete')
      .map(node => node.nodeId),
    failedNodes: snapshot.nodes
      .filter(node => node.status === 'failed')
      .map(node => node.nodeId),
    artifacts: artifactReferences,
    updatedAtIso: snapshot.updatedAt
  };
}

function createPersistedDagRunSnapshot(record: StoredDagRunRecord): PersistedDagRunSnapshot {
  const orchestratorState =
    record.orchestratorState ??
    createFallbackTrinityRunRecord({
      runId: record.runId,
      status: record.status,
      updatedAt: record.updatedAt,
      nodes: Array.from(record.nodesById.values())
    });

  return {
    runId: record.runId,
    sessionId: record.sessionId,
    template: record.template,
    plannerNodeId: record.plannerNodeId,
    rootNodeId: record.rootNodeId,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    summary: cloneDagRunSummary(createApiSummary(record)),
    nodes: Array.from(record.nodesById.values()).map(cloneStoredNodeDetail),
    events: cloneSerializable(record.events),
    errors: cloneSerializable(record.errors),
    guardViolations: cloneSerializable(record.guardViolations),
    metrics: cloneSerializable(record.metrics),
    verification: cloneSerializable(record.verification),
    limits: cloneSerializable(record.limits),
    features: cloneSerializable(record.features),
    loopDetected: record.loopDetected,
    orchestratorState: cloneTrinityRunRecord(orchestratorState)
  };
}

function normalizePersistedDagRunSnapshot(
  snapshot: Record<string, unknown>
): PersistedDagRunSnapshot | null {
  const runId = typeof snapshot.runId === 'string' ? snapshot.runId : null;
  const sessionId = typeof snapshot.sessionId === 'string' ? snapshot.sessionId : null;
  const template = typeof snapshot.template === 'string' ? snapshot.template : null;
  const status = typeof snapshot.status === 'string' ? snapshot.status as DagRunExecutionState : null;
  const createdAt = typeof snapshot.createdAt === 'string' ? snapshot.createdAt : null;
  const updatedAt = typeof snapshot.updatedAt === 'string' ? snapshot.updatedAt : null;
  const summary = snapshot.summary as DagRunSummary | undefined;
  const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes as StoredNodeDetail[] : null;
  const events = Array.isArray(snapshot.events) ? snapshot.events as DagEvent[] : null;
  const errors = Array.isArray(snapshot.errors) ? snapshot.errors as DagRunError[] : null;
  const guardViolations = Array.isArray(snapshot.guardViolations)
    ? snapshot.guardViolations as GuardViolation[]
    : null;
  const metrics = snapshot.metrics as DagRunMetrics | undefined;
  const verification = snapshot.verification as DagVerification | undefined;
  const limits = snapshot.limits as ExecutionLimits | undefined;
  const features = snapshot.features as FeatureFlags | undefined;
  const orchestratorState = snapshot.orchestratorState as TrinityRunRecord | undefined;

  //audit Assumption: persisted run snapshots must include the core DAG contract fields; failure risk: malformed DB state causes route crashes or false not-found responses; expected invariant: required identifiers and snapshot arrays are present; handling strategy: reject invalid snapshots with `null`.
  if (
    !runId ||
    !sessionId ||
    !template ||
    !status ||
    !createdAt ||
    !updatedAt ||
    !summary ||
    !nodes ||
    !events ||
    !errors ||
    !guardViolations ||
    !metrics ||
    !verification ||
    !limits ||
    !features
  ) {
    return null;
  }

  const normalizedOrchestratorState = orchestratorState
    ? cloneTrinityRunRecord(orchestratorState)
    : createFallbackTrinityRunRecord({
        runId,
        status,
        updatedAt,
        nodes
      });

  return {
    runId,
    sessionId,
    template: resolvePublicDagTemplateName(template),
    plannerNodeId: typeof snapshot.plannerNodeId === 'string' ? snapshot.plannerNodeId : null,
    rootNodeId: typeof snapshot.rootNodeId === 'string' ? snapshot.rootNodeId : null,
    status,
    createdAt,
    updatedAt,
    summary: {
      ...summary,
      template: resolvePublicDagTemplateName(summary.template),
      activeNodes:
        typeof summary.activeNodes === 'number'
          ? summary.activeNodes
          : normalizedOrchestratorState.activeNodes.length,
      completedNodes:
        typeof summary.completedNodes === 'number'
          ? summary.completedNodes
          : normalizedOrchestratorState.completedNodes.length,
      failedNodes:
        typeof summary.failedNodes === 'number'
          ? summary.failedNodes
          : normalizedOrchestratorState.failedNodes.length,
      artifacts:
        Array.isArray(summary.artifacts)
          ? [...summary.artifacts]
          : [...normalizedOrchestratorState.artifacts],
      resumable:
        typeof summary.resumable === 'boolean'
          ? summary.resumable
          : status !== 'complete'
    },
    nodes,
    events,
    errors,
    guardViolations,
    metrics,
    verification,
    limits,
    features,
    loopDetected: snapshot.loopDetected === true,
    orchestratorState: normalizedOrchestratorState
  };
}

function createNodeMapFromSnapshot(snapshot: PersistedDagRunSnapshot): Map<string, StoredNodeDetail> {
  return new Map(snapshot.nodes.map(node => [node.nodeId, cloneStoredNodeDetail(node)]));
}

function percentile(values: number[], percentileRank: number): number {
  if (values.length === 0) {
    return 0;
  }

  const orderedValues = [...values].sort((left, right) => left - right);
  const index = Math.min(
    orderedValues.length - 1,
    Math.max(0, Math.ceil((percentileRank / 100) * orderedValues.length) - 1)
  );
  return orderedValues[index] ?? 0;
}

function convertRunStatus(status: DagRunExecutionState): DagRunSummary['status'] {
  switch (status) {
    case 'complete':
      return 'complete';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'running':
      return 'running';
    case 'queued':
    default:
      return 'queued';
  }
}

function createApiSummary(record: StoredDagRunRecord): DagRunSummary {
  const orchestratorState =
    record.orchestratorState ??
    createFallbackTrinityRunRecord({
      runId: record.runId,
      status: record.status,
      updatedAt: record.updatedAt,
      nodes: Array.from(record.nodesById.values())
    });
  const completedNodes = orchestratorState.completedNodes.length;
  const failedNodes = orchestratorState.failedNodes.length;

  return {
    ...createTrinityRuntimeMetadata(),
    runId: record.runId,
    sessionId: record.sessionId,
    template: resolvePublicDagTemplateName(record.template),
    status: convertRunStatus(record.status),
    plannerNodeId: record.plannerNodeId,
    rootNodeId: record.rootNodeId,
    spawnDepthMaxObserved: record.metrics.maxSpawnDepthObserved,
    totalNodes: record.metrics.totalNodes,
    activeNodes: orchestratorState.activeNodes.length,
    completedNodes,
    failedNodes,
    retryCount: record.metrics.totalRetries,
    durationMs: record.metrics.wallClockDurationMs,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    artifacts: [...orchestratorState.artifacts],
    resumable: record.status !== 'complete',
    finalOutput: record.summary.finalOutput
  };
}

function calculateFinalOutput(record: StoredDagRunRecord): FinalOutput | undefined {
  if (!record.rootNodeId) {
    return undefined;
  }

  const rootNode = record.nodesById.get(record.rootNodeId);
  if (!rootNode?.output) {
    return undefined;
  }

  const summaryValue =
    typeof rootNode.output.summary === 'string'
      ? rootNode.output.summary
      : typeof rootNode.output.result === 'string'
        ? rootNode.output.result
        : undefined;

  return {
    ...rootNode.output,
    summary: summaryValue
  };
}

function calculateLineageEntriesFromNodes(
  runId: string,
  nodesById: Map<string, StoredNodeDetail>,
  loopDetected: boolean
): DagLineageData {
  const lineage = Array.from(nodesById.values()).map(node => {
    const chain: string[] = [];
    let currentParentNodeId = node.parentNodeId;

    while (currentParentNodeId) {
      chain.unshift(currentParentNodeId);
      currentParentNodeId = nodesById.get(currentParentNodeId)?.parentNodeId ?? null;
    }

    return {
      nodeId: node.nodeId,
      parentNodeId: node.parentNodeId,
      spawnDepth: node.spawnDepth,
      lineage: chain
    };
  });

  return {
    runId,
    lineage,
    loopDetected
  };
}

function recalculateMetrics(record: StoredDagRunRecord): DagRunMetrics {
  const nodeList = Array.from(record.nodesById.values());
  const durationValues = nodeList
    .map(node => node.metrics?.durationMs)
    .filter((value): value is number => typeof value === 'number');
  const queueWaitValues = nodeList
    .map(node => {
      if (!node.queuedAt || !node.startedAt) {
        return undefined;
      }
      return new Date(node.startedAt).getTime() - new Date(node.queuedAt).getTime();
    })
    .filter((value): value is number => typeof value === 'number' && value >= 0);
  const totalPromptTokens = nodeList.reduce((sum, node) => sum + (node.metrics?.promptTokens ?? 0), 0);
  const totalCompletionTokens = nodeList.reduce((sum, node) => sum + (node.metrics?.completionTokens ?? 0), 0);
  const totalFailures = nodeList.filter(node => node.status === 'failed').length;
  const wallClockDurationMs = Math.max(
    0,
    new Date(record.updatedAt).getTime() - new Date(record.createdAt).getTime()
  );
  //audit Assumption: live DAG verification should infer concurrency from node timing windows even before the orchestrator emits its terminal summary; failure risk: genuinely parallel child execution is reported as serial until run completion; expected invariant: overlapping node intervals raise maxParallelNodesObserved mid-run; handling strategy: sweep started/completed timestamps and preserve the highest observed value.
  const maxParallelNodesObserved = Math.max(
    record.metrics.maxParallelNodesObserved,
    calculateMaxParallelNodesObserved(nodeList, record.updatedAt)
  );

  return {
    totalNodes: nodeList.length,
    maxParallelNodesObserved,
    maxSpawnDepthObserved: Math.max(0, ...nodeList.map(node => node.spawnDepth)),
    totalRetries: record.metrics.totalRetries,
    totalFailures,
    totalAiCalls: record.metrics.totalAiCalls,
    estimatedCostUsd: Number((((totalPromptTokens + totalCompletionTokens) / 1000) * 0.005).toFixed(6)),
    wallClockDurationMs,
    sumNodeDurationMs: durationValues.reduce((sum, value) => sum + value, 0),
    queueWaitMsP50: percentile(queueWaitValues, 50),
    queueWaitMsP95: percentile(queueWaitValues, 95)
  };
}

function calculateVerification(record: StoredDagRunRecord): DagVerification {
  const plannerNode = record.plannerNodeId ? record.nodesById.get(record.plannerNodeId) : null;
  const rootNode = record.rootNodeId ? record.nodesById.get(record.rootNodeId) : null;
  const nodeList = Array.from(record.nodesById.values());
  const rootCompletedAt = rootNode?.completedAt ? new Date(rootNode.completedAt).getTime() : 0;
  const allOtherCompletedBeforeRoot = nodeList
    .filter(node => node.nodeId !== rootNode?.nodeId && node.completedAt)
    .every(node => {
      const completedAt = node.completedAt ? new Date(node.completedAt).getTime() : 0;
      return completedAt <= rootCompletedAt;
    });
  const retryPolicyRespected = nodeList.every(node => node.attempt <= Math.max(1, node.maxRetries + 1));
  const budgetPolicyRespected =
    record.metrics.totalAiCalls <= record.limits.maxAiCallsPerRun &&
    record.metrics.maxSpawnDepthObserved <= record.limits.maxSpawnDepth;

  return {
    runCompleted: record.status === 'complete',
    plannerSpawnedChildren: Boolean(plannerNode && plannerNode.childNodeIds.length > 0),
    parallelExecutionObserved: record.metrics.maxParallelNodesObserved > 1,
    aggregationRanLast: Boolean(rootNode?.completedAt) && allOtherCompletedBeforeRoot,
    retryPolicyRespected,
    budgetPolicyRespected,
    deadlockDetected: record.guardViolations.some(violation => violation.type === 'deadline_exceeded'),
    stalledJobsDetected: record.guardViolations.some(violation => violation.type === 'deadline_exceeded'),
    loopDetected: record.loopDetected
  };
}

/**
 * Build explicit Trinity lineage metadata for the verification payload.
 *
 * Purpose:
 * - Let the verification API assert the worker AI pipeline and expose the concrete worker evidence seen so far.
 *
 * Inputs/outputs:
 * - Input: persisted DAG snapshot containing nodes and the originating run session id.
 * - Output: Trinity lineage metadata for the verification response.
 *
 * Edge case behavior:
 * - Falls back to `synthetic_fallback` when the run snapshot lacks a non-empty session id.
 */
function createVerificationLineage(snapshot: PersistedDagRunSnapshot): DagVerificationLineage {
  const normalizedSessionId = typeof snapshot.sessionId === 'string'
    ? snapshot.sessionId.trim()
    : '';
  const observedWorkerIds = Array.from(
    new Set(
      snapshot.nodes
        .map(node => node.workerId)
        .filter((workerId): workerId is string => typeof workerId === 'string' && workerId.trim().length > 0)
    )
  );
  const observedSourceEndpoints = Array.from(
    new Set(snapshot.nodes.map(node => `dag.agent.${node.agentRole}`))
  );

  //audit Assumption: API-created DAG runs always propagate their session id into worker execution; failure risk: callers cannot distinguish inherited Trinity sessions from synthetic fallback sessions; expected invariant: non-empty run session ids are labeled as inherited and empty values are called out explicitly; handling strategy: branch on the normalized session id and surface the propagation mode in the verification payload.
  if (normalizedSessionId.length === 0) {
    return {
      workerPipeline: 'trinity',
      workerEntryPoint: 'runWorkerTrinityPrompt',
      sessionId: '',
      sessionPropagationMode: 'synthetic_fallback',
      tokenAuditSessionMode: 'shared_session',
      observedWorkerIds,
      observedSourceEndpoints
    };
  }

  return {
    workerPipeline: 'trinity',
    workerEntryPoint: 'runWorkerTrinityPrompt',
    sessionId: normalizedSessionId,
    sessionPropagationMode: 'inherit_run_session',
    tokenAuditSessionMode: 'dag_node_branch',
    observedWorkerIds,
    observedSourceEndpoints
  };
}

function createPublicNodeDetail(node: StoredNodeDetail): NodeDetail {
  return {
    ...cloneStoredNodeDetail(node),
    ...createTrinityNodeMetadata(node.agentRole)
  };
}

function enrichDagEventDataWithTrinityMetadata(
  data: unknown,
  nodesById: Map<string, StoredNodeDetail>
): Record<string, unknown> {
  //audit Assumption: every public event payload should remain object-shaped after Trinity enrichment; failure risk: primitive payloads would violate the public DagEvent contract and erase probe-visible markers; expected invariant: returned event data is always a record with pipeline metadata; handling strategy: wrap non-object payloads in a `value` field before adding Trinity metadata.
  const normalizedData: Record<string, unknown> =
    data && typeof data === 'object' && !Array.isArray(data)
      ? {
          ...(data as Record<string, unknown>),
          ...createTrinityRuntimeMetadata()
        }
      : {
          ...createTrinityRuntimeMetadata(),
          value: data
        };
  const nodeId = typeof normalizedData.nodeId === 'string' ? normalizedData.nodeId : null;

  //audit Assumption: node-scoped event payloads should expose an explicit Trinity role marker for probes and diagnostics; failure risk: runtime events prove orchestration but not the Trinity archetype; expected invariant: events with a known node id include a matching `role` marker; handling strategy: enrich object payloads opportunistically when the node exists in the current run snapshot.
  if (nodeId) {
    const node = nodesById.get(nodeId);
    if (node) {
      normalizedData.role = mapAgentRoleToTrinityPipelineRole(node.agentRole);
    }
  }

  return normalizedData;
}

function createErrorInfo(message: string, details?: unknown, type?: string): ErrorInfo {
  return {
    type,
    message,
    details
  };
}

/**
 * In-memory DAG run registry and background execution coordinator.
 *
 * Purpose:
 * - Back the verification API with run summaries, node details, events, errors, metrics, and cancellation state.
 * - Persist run snapshots so DAG inspection works across Railway instances and process restarts.
 *
 * Inputs/outputs:
 * - Input: create-run requests and run identifiers for lookup or cancellation.
 * - Output: contract-aligned DAG run data.
 *
 * Edge case behavior:
 * - Active execution control remains local to the instance running the DAG, but inspection data is shared through persistence.
 */
export class ArcanosDagRunService {
  private readonly runsById = new Map<string, StoredDagRunRecord>();
  private readonly persistenceByRunId = new Map<string, Promise<void>>();
  private readonly trinityOrchestrator = new TrinityOrchestrator();

  /**
   * Return the feature flags exposed by the verification API.
   *
   * Purpose:
   * - Give route handlers one stable place to resolve public feature availability.
   *
   * Inputs/outputs:
   * - Input: none.
   * - Output: public verification feature flags.
   *
   * Edge case behavior:
   * - Recursive spawning and event streaming remain `false` until the backend supports them end-to-end.
   */
  getFeatureFlags(): FeatureFlags {
    return createFeatureFlags();
  }

  /**
   * Return the public execution limits currently enforced by the DAG orchestrator.
   *
   * Purpose:
   * - Keep the capabilities and metrics endpoints aligned with runtime guardrails.
   *
   * Inputs/outputs:
   * - Input: optional per-request overrides.
   * - Output: normalized public execution limits.
   *
   * Edge case behavior:
   * - Uses environment-backed defaults when no overrides are provided.
   */
  getExecutionLimits(overrides: Partial<DagWorkerPoolSettings> = {}): ExecutionLimits {
    return createExecutionLimits(getDagWorkerPoolSettings(overrides));
  }

  /**
   * Resolve the latest snapshot for one DAG run from local memory or shared persistence.
   *
   * Purpose:
   * - Let verification APIs read active runs on the current instance while still supporting cross-instance lookups.
   *
   * Inputs/outputs:
   * - Input: run identifier.
   * - Output: normalized persisted snapshot or `null`.
   *
   * Edge case behavior:
   * - Local in-memory state wins when available because it may be newer than the last persisted write.
   */
  private async getRunSnapshot(runId: string): Promise<PersistedDagRunSnapshot | null> {
    const localRecord = this.runsById.get(runId);
    if (localRecord) {
      return createPersistedDagRunSnapshot(localRecord);
    }

    const persistedRecord = await getDagRunSnapshotById(runId);
    if (!persistedRecord) {
      return null;
    }

    return normalizePersistedDagRunSnapshot(persistedRecord.snapshot);
  }

  /**
   * Persist the current run snapshot immediately.
   *
   * Purpose:
   * - Ensure newly created DAG runs are visible to other instances before the API responds.
   *
   * Inputs/outputs:
   * - Input: in-memory run record.
   * - Output: completion of the shared snapshot write.
   *
   * Edge case behavior:
   * - Throws on persistence failure so the caller can surface an explicit error.
   */
  private async persistRecordNow(record: StoredDagRunRecord): Promise<void> {
    const snapshot = createPersistedDagRunSnapshot(record);
    await upsertDagRunSnapshot({
      runId: snapshot.runId,
      sessionId: snapshot.sessionId,
      template: snapshot.template,
      status: snapshot.status,
      plannerNodeId: snapshot.plannerNodeId,
      rootNodeId: snapshot.rootNodeId,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      snapshot: cloneSerializable(snapshot) as unknown as Record<string, unknown>
    });
  }

  /**
   * Queue a persisted snapshot write without blocking the caller.
   *
   * Purpose:
   * - Serialize frequent observer-driven writes so DB state stays monotonic while DAG execution continues.
   *
   * Inputs/outputs:
   * - Input: in-memory run record.
   * - Output: none.
   *
   * Edge case behavior:
   * - Persistence failures are logged but do not crash the active DAG execution loop.
   */
  private queuePersistRecord(record: StoredDagRunRecord): void {
    const previousWrite = this.persistenceByRunId.get(record.runId) ?? Promise.resolve();
    const nextWrite = previousWrite
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.persistRecordNow(record);
        } catch (error: unknown) {
          //audit Assumption: snapshot persistence is required for cross-instance inspection but should not terminate active DAG execution; failure risk: monitoring data lags behind runtime state; expected invariant: write errors are observable in logs; handling strategy: log and continue.
          console.warn('[DAG Runs] Failed to persist DAG snapshot:', error);
        }
      });

    this.persistenceByRunId.set(record.runId, nextWrite);
    void nextWrite.finally(() => {
      if (this.persistenceByRunId.get(record.runId) === nextWrite) {
        this.persistenceByRunId.delete(record.runId);
      }
    });
  }

  /**
   * Update the compact Trinity run tracker snapshot stored alongside a DAG run record.
   *
   * Purpose:
   * - Keep the high-signal resumability state in sync with observer events and persisted snapshots.
   *
   * Inputs/outputs:
   * - Input: in-memory DAG record plus the latest tracker snapshot.
   * - Output: none.
   *
   * Edge case behavior:
   * - Stores a defensive clone so external callers cannot mutate retained tracker state.
   */
  private syncOrchestratorState(
    record: StoredDagRunRecord,
    nextState: TrinityRunRecord
  ): void {
    record.orchestratorState = cloneTrinityRunRecord(nextState);
  }

  /**
   * Ensure the in-process Trinity run tracker has a live copy of one DAG record.
   *
   * Purpose:
   * - Rehydrate compact run state after snapshot reloads, test fixtures, or service restarts before applying new transitions.
   *
   * Inputs/outputs:
   * - Input: one DAG record with its latest compact tracker snapshot.
   * - Output: none.
   *
   * Edge case behavior:
   * - Existing tracked runs are left unchanged to preserve the freshest in-memory state.
   */
  private ensureTrackedRunState(record: StoredDagRunRecord): void {
    if (this.trinityOrchestrator.getRun(record.runId)) {
      return;
    }

    const fallbackState =
      record.orchestratorState ??
      createFallbackTrinityRunRecord({
        runId: record.runId,
        status: record.status,
        updatedAt: record.updatedAt,
        nodes: Array.from(record.nodesById.values())
      });

    this.trinityOrchestrator.startRun(record.runId);

    for (const nodeId of fallbackState.completedNodes) {
      this.trinityOrchestrator.markNodeCompleted(record.runId, nodeId);
    }

    for (const nodeId of fallbackState.failedNodes) {
      this.trinityOrchestrator.markNodeFailed(record.runId, nodeId);
    }

    for (const nodeId of fallbackState.activeNodes) {
      this.trinityOrchestrator.markNodeActive(record.runId, nodeId);
    }

    for (const artifactReference of fallbackState.artifacts) {
      this.trinityOrchestrator.attachArtifact(record.runId, artifactReference);
    }

    if (fallbackState.status === 'completed') {
      this.trinityOrchestrator.markRunCompleted(record.runId);
    } else if (fallbackState.status === 'failed') {
      this.trinityOrchestrator.markRunFailed(record.runId);
    } else if (fallbackState.status === 'cancelled') {
      this.trinityOrchestrator.markRunCancelled(record.runId);
    }

    this.syncOrchestratorState(record, this.trinityOrchestrator.getRun(record.runId)!);
  }

  /**
   * Create and start a new DAG verification run.
   *
   * Purpose:
   * - Persist initial run state and launch the background orchestrator without blocking the HTTP request.
   *
   * Inputs/outputs:
   * - Input: verified create-run request payload.
   * - Output: created run summary in `queued` state.
   *
   * Edge case behavior:
   * - Throws for unsupported templates so callers can return `400`.
   */
  async createRun(request: CreateDagRunRequest): Promise<DagRunSummary> {
    const runId = generateRequestId('dagrun');
    const settings = getDagWorkerPoolSettings({
      maxConcurrentNodes: request.options?.maxConcurrency
    });
    const limits = createExecutionLimits(settings);
    const features = createFeatureFlags();
    const templateDefinition = buildDagTemplate(request);
    const publicTemplateName = templateDefinition.templateName;
    const createdAt = new Date().toISOString();
    const nodesById = new Map<string, StoredNodeDetail>();
    const orchestratorState = this.trinityOrchestrator.startRun(runId);

    for (const [nodeId, node] of Object.entries(templateDefinition.graph.nodes)) {
      const nodeMetadata = templateDefinition.nodeMetadataById[nodeId];
      const childNodeIds = templateDefinition.graph.edges
        .filter(edge => edge.from === nodeId)
        .map(edge => edge.to);

      nodesById.set(nodeId, {
        nodeId,
        runId,
        parentNodeId: nodeMetadata.parentNodeId,
        agentRole: nodeMetadata.agentRole,
        jobType: nodeMetadata.jobType,
        status: templateDefinition.graph.entrypoints.includes(nodeId) ? 'queued' : 'waiting',
        dependencyIds: [...node.dependencies],
        spawnDepth: node.dependencies.length === 0 ? 0 : 1,
        attempt: 0,
        maxRetries: limits.maxRetriesPerNode,
        input: normalizeNodeOutput(node.metadata) ?? {},
        error: null,
        childNodeIds
      });
    }

    const record: StoredDagRunRecord = {
      runId,
      sessionId: request.sessionId,
      template: publicTemplateName,
      plannerNodeId: templateDefinition.plannerNodeId,
      rootNodeId: templateDefinition.rootNodeId,
      status: 'queued',
      createdAt,
      updatedAt: createdAt,
      summary: {
        ...createTrinityRuntimeMetadata(),
        runId,
        sessionId: request.sessionId,
        template: publicTemplateName,
        status: 'queued',
        plannerNodeId: templateDefinition.plannerNodeId,
        rootNodeId: templateDefinition.rootNodeId,
        spawnDepthMaxObserved: 0,
        totalNodes: nodesById.size,
        completedNodes: 0,
        failedNodes: 0,
        retryCount: 0,
        durationMs: 0,
        createdAt,
        updatedAt: createdAt
      },
      nodesById,
      events: [],
      errors: [],
      guardViolations: [],
      metrics: createDefaultMetrics(nodesById.size),
      verification: createDefaultVerification(),
      limits,
      features,
      loopDetected: false,
      orchestratorState,
      templateDefinition,
      abortController: new AbortController()
    };

    record.summary = createApiSummary(record);

    this.runsById.set(runId, record);
    this.recordEvent(record, 'run.created', {
      runId,
      sessionId: request.sessionId,
      template: publicTemplateName
    });
    await this.persistRecordNow(record);

    record.executionPromise = this.executeRun(record, request, settings);
    return record.summary;
  }

  /**
   * Get a run summary by identifier.
   *
   * Purpose:
   * - Support polling for high-level DAG run state.
   *
   * Inputs/outputs:
   * - Input: run identifier.
   * - Output: run summary or `null`.
   *
   * Edge case behavior:
   * - Returns `null` when the run id is unknown.
   */
  async getRun(runId: string): Promise<DagRunSummary | null> {
    const snapshot = await this.getRunSnapshot(runId);
    return snapshot ? cloneDagRunSummary(snapshot.summary) : null;
  }

  /**
   * Wait for a run summary to advance beyond a known update timestamp.
   *
   * Purpose:
   * - Support long-poll status reads so clients can watch large DAG runs without aggressive polling.
   *
   * Inputs/outputs:
   * - Input: run identifier plus an optional `updatedAfter` cursor and max wait duration.
   * - Output: the latest run summary, whether it changed, and whether the call actually waited.
   *
   * Edge case behavior:
   * - Returns `null` when the run id is unknown.
   * - Resolves immediately when the run is already newer than `updatedAfter` or when wait time is `0`.
   */
  waitForRunUpdate(
    runId: string,
    options: WaitForDagRunUpdateOptions = {}
  ): Promise<DagRunWaitResult | null> {
    return this.waitForRunUpdateInternal(runId, options);
  }

  private async waitForRunUpdateInternal(
    runId: string,
    options: WaitForDagRunUpdateOptions
  ): Promise<DagRunWaitResult | null> {
    const initialSnapshot = await this.getRunSnapshot(runId);
    if (!initialSnapshot) {
      return null;
    }

    const updatedAfterTimestampMs = toEpochMilliseconds(options.updatedAfter);
    const currentUpdatedAtMs = toEpochMilliseconds(initialSnapshot.updatedAt);
    const waitForUpdateMs = Math.max(0, options.waitForUpdateMs ?? 0);

    //audit Assumption: callers only need to wait when they already hold the newest known summary; failure risk: unnecessary long-polling wastes request budget; expected invariant: newer snapshots return immediately; handling strategy: short-circuit when updatedAt has advanced or waiting is disabled.
    if (!options.updatedAfter || currentUpdatedAtMs > updatedAfterTimestampMs || waitForUpdateMs === 0) {
      return {
        run: cloneDagRunSummary(initialSnapshot.summary),
        updated: !options.updatedAfter || currentUpdatedAtMs > updatedAfterTimestampMs,
        waited: false
      };
    }

    const deadlineMs = Date.now() + waitForUpdateMs;
    let latestSnapshot = initialSnapshot;

    while (Date.now() < deadlineMs) {
      const remainingMs = Math.max(0, deadlineMs - Date.now());
      await sleep(Math.min(remainingMs, 250), { unref: true });

      const nextSnapshot = await this.getRunSnapshot(runId);
      //audit Assumption: a persisted run should remain readable while a client is waiting on it; failure risk: transient read miss could incorrectly downgrade to not-found; expected invariant: the last known snapshot remains usable; handling strategy: keep the latest successful snapshot when a poll read returns null.
      if (!nextSnapshot) {
        continue;
      }

      latestSnapshot = nextSnapshot;
      if (toEpochMilliseconds(nextSnapshot.updatedAt) > updatedAfterTimestampMs) {
        return {
          run: cloneDagRunSummary(nextSnapshot.summary),
          updated: true,
          waited: true
        };
      }
    }

    return {
      run: cloneDagRunSummary(latestSnapshot.summary),
      updated: toEpochMilliseconds(latestSnapshot.updatedAt) > updatedAfterTimestampMs,
      waited: true
    };
  }

  /**
   * Get the DAG tree for one run.
   *
   * Purpose:
   * - Provide the node list, dependencies, children, and timing fields used by the tree endpoint.
   *
   * Inputs/outputs:
   * - Input: run identifier.
   * - Output: tree data or `null`.
   *
   * Edge case behavior:
   * - Returns `null` when the run id is unknown.
   */
  async getRunTree(runId: string): Promise<DagTreeData | null> {
    const snapshot = await this.getRunSnapshot(runId);
    if (!snapshot) {
      return null;
    }

    const nodes: DagTreeNode[] = snapshot.nodes.map(node => ({
      ...createTrinityNodeMetadata(node.agentRole),
      nodeId: node.nodeId,
      parentNodeId: node.parentNodeId,
      agentRole: node.agentRole,
      jobType: node.jobType,
      status: normalizeNodeStatus(node.status),
      dependencyIds: [...node.dependencyIds],
      childNodeIds: [...node.childNodeIds],
      spawnDepth: node.spawnDepth,
      workerId: node.workerId,
      startedAt: node.startedAt,
      completedAt: node.completedAt
    }));

    return {
      ...createTrinityRuntimeMetadata(),
      runId,
      nodes
    };
  }

  /**
   * Get one node detail by run and node id.
   *
   * Purpose:
   * - Support node inspection for inputs, outputs, attempts, and error state.
   *
   * Inputs/outputs:
   * - Input: run identifier and node identifier.
   * - Output: node detail or `null`.
   *
   * Edge case behavior:
   * - Returns `null` when the run or node id is unknown.
   */
  async getNode(runId: string, nodeId: string): Promise<NodeDetail | null> {
    const snapshot = await this.getRunSnapshot(runId);
    if (!snapshot) {
      return null;
    }

    const node = snapshot.nodes.find(candidateNode => candidateNode.nodeId === nodeId);
    return node ? createPublicNodeDetail(node) : null;
  }

  /**
   * Get the recorded event stream for one run.
   *
   * Purpose:
   * - Expose the append-only lifecycle log used by verification tooling.
   *
   * Inputs/outputs:
   * - Input: run identifier.
   * - Output: events data or `null`.
   *
   * Edge case behavior:
   * - Returns `null` when the run id is unknown.
   */
  async getRunEvents(runId: string): Promise<DagEventsData | null> {
    const snapshot = await this.getRunSnapshot(runId);
    if (!snapshot) {
      return null;
    }

    const nodesById = new Map(snapshot.nodes.map(node => [node.nodeId, node] as const));

    return {
      ...createTrinityRuntimeMetadata(),
      runId,
      events: snapshot.events.map(event => ({
        ...cloneSerializable(event),
        data: enrichDagEventDataWithTrinityMetadata(event.data, nodesById)
      }))
    };
  }

  /**
   * Get metrics and guard violations for one run.
   *
   * Purpose:
   * - Back the metrics endpoint with the latest aggregate values.
   *
   * Inputs/outputs:
   * - Input: run identifier.
   * - Output: metrics data or `null`.
   *
   * Edge case behavior:
   * - Returns `null` when the run id is unknown.
   */
  async getRunMetrics(runId: string): Promise<DagMetricsData | null> {
    const snapshot = await this.getRunSnapshot(runId);
    if (!snapshot) {
      return null;
    }

    return {
      runId,
      metrics: cloneSerializable(snapshot.metrics),
      limits: cloneSerializable(snapshot.limits),
      guardViolations: cloneSerializable(snapshot.guardViolations)
    };
  }

  /**
   * Get the error log for one run.
   *
   * Purpose:
   * - Support post-run inspection of node failures and retry behavior.
   *
   * Inputs/outputs:
   * - Input: run identifier.
   * - Output: error list or `null`.
   *
   * Edge case behavior:
   * - Returns `null` when the run id is unknown.
   */
  async getRunErrors(runId: string): Promise<{ runId: string; errors: DagRunError[] } | null> {
    const snapshot = await this.getRunSnapshot(runId);
    if (!snapshot) {
      return null;
    }

    return {
      runId,
      errors: cloneSerializable(snapshot.errors)
    };
  }

  /**
   * Get lineage entries for one run.
   *
   * Purpose:
   * - Expose parent chains for tree inspection and loop detection reporting.
   *
   * Inputs/outputs:
   * - Input: run identifier.
   * - Output: lineage data or `null`.
   *
   * Edge case behavior:
   * - Returns `null` when the run id is unknown.
   */
  async getRunLineage(runId: string): Promise<DagLineageData | null> {
    const snapshot = await this.getRunSnapshot(runId);
    if (!snapshot) {
      return null;
    }

    return calculateLineageEntriesFromNodes(
      snapshot.runId,
      createNodeMapFromSnapshot(snapshot),
      snapshot.loopDetected
    );
  }

  /**
   * Get the verification result for one run.
   *
   * Purpose:
   * - Provide the summarized contract checks requested by the verification endpoint.
   *
   * Inputs/outputs:
   * - Input: run identifier.
   * - Output: verification data or `null`.
   *
   * Edge case behavior:
   * - Returns `null` when the run id is unknown.
   */
  async getRunVerification(runId: string): Promise<DagVerificationData | null> {
    const snapshot = await this.getRunSnapshot(runId);
    if (!snapshot) {
      return null;
    }

    return {
      ...createTrinityRuntimeMetadata(),
      runId,
      verification: cloneSerializable(snapshot.verification),
      lineage: createVerificationLineage(snapshot)
    };
  }

  /**
   * Request cancellation for a run.
   *
   * Purpose:
   * - Stop future scheduling and mark still-pending nodes as cancelled.
   *
   * Inputs/outputs:
   * - Input: run identifier.
   * - Output: cancelled node ids or `null`.
   *
   * Edge case behavior:
   * - Returns the existing cancelled state when the run was already cancelled.
   */
  cancelRun(runId: string): { runId: string; status: 'cancelled'; cancelledNodes: string[] } | null {
    const record = this.runsById.get(runId);
    if (!record) {
      return null;
    }

    const cancelledNodes: string[] = [];
    for (const node of record.nodesById.values()) {
      //audit Assumption: cancellation should only rewrite nodes that have not finished; failure risk: terminal node history is lost; expected invariant: only waiting or queued nodes become cancelled immediately; handling strategy: update pending nodes in place and leave running nodes to settle naturally.
      if (node.status === 'waiting' || node.status === 'queued') {
        node.status = 'cancelled';
        node.completedAt = new Date().toISOString();
        cancelledNodes.push(node.nodeId);
        this.recordEvent(record, 'node.cancelled', {
          nodeId: node.nodeId,
          reason: 'Run cancellation requested.'
        });
      }
    }

    record.abortController.abort();
    record.status = 'cancelled';
    this.ensureTrackedRunState(record);
    this.syncOrchestratorState(record, this.trinityOrchestrator.markRunCancelled(runId));
    record.updatedAt = new Date().toISOString();
    record.summary = createApiSummary(record);
    record.verification = calculateVerification(record);
    this.recordEvent(record, 'run.cancelled', {
      runId,
      cancelledNodes
    });
    this.queuePersistRecord(record);

    return {
      runId,
      status: 'cancelled',
      cancelledNodes
    };
  }

  private async executeRun(
    record: StoredDagRunRecord,
    request: CreateDagRunRequest,
    settings: DagWorkerPoolSettings
  ): Promise<void> {
    record.status = 'running';
    record.updatedAt = new Date().toISOString();
    record.summary = createApiSummary(record);
    this.recordEvent(record, 'run.started', {
      runId: record.runId
    });
    this.queuePersistRecord(record);

    const orchestrator = new DAGOrchestrator({ settings });
    const observer = this.createObserver(record);

    try {
      const internalSummary = await orchestrator.runGraph(record.templateDefinition.graph, {
        dagId: record.runId,
        abortSignal: record.abortController.signal,
        observer,
        sharedState: {
          sessionId: request.sessionId,
          template: record.template
        },
        payloadByNodeId: Object.fromEntries(
          Object.entries(record.templateDefinition.graph.nodes).map(([nodeId, node]) => [
            nodeId,
            normalizeNodeOutput(node.metadata) ?? {}
          ])
        )
      });

      this.finalizeRun(record, internalSummary);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      record.status = record.abortController.signal.aborted ? 'cancelled' : 'failed';
      this.syncOrchestratorState(
        record,
        record.abortController.signal.aborted
          ? this.trinityOrchestrator.markRunCancelled(record.runId)
          : this.trinityOrchestrator.markRunFailed(record.runId)
      );
      record.updatedAt = new Date().toISOString();
      record.errors.push({
        errorId: generateRequestId('dagerr'),
        nodeId: record.rootNodeId ?? 'run',
        type: 'orchestrator_error',
        message: errorMessage,
        attempt: 1,
        at: record.updatedAt,
        retryScheduled: false
      });
      record.guardViolations.push({
        type: 'unknown',
        at: record.updatedAt,
        message: errorMessage,
        details: createErrorInfo(errorMessage)
      });
      record.metrics = recalculateMetrics(record);
      record.verification = calculateVerification(record);
      record.summary = createApiSummary(record);
      this.recordEvent(record, 'run.failed', {
        runId: record.runId,
        message: errorMessage
      });
      this.queuePersistRecord(record);
    }
  }

  private finalizeRun(record: StoredDagRunRecord, internalSummary: InternalDagRunSummary): void {
    record.status =
      internalSummary.status === 'success'
        ? 'complete'
        : internalSummary.status === 'cancelled'
          ? 'cancelled'
          : 'failed';
    record.updatedAt = internalSummary.completedAt;

    for (const cancelledNodeId of internalSummary.cancelledNodeIds) {
      const node = record.nodesById.get(cancelledNodeId);
      if (!node) {
        continue;
      }
      node.status = 'cancelled';
      node.completedAt = internalSummary.completedAt;
    }

    record.metrics.maxParallelNodesObserved = internalSummary.maxParallelNodesObserved;
    record.metrics.totalRetries = internalSummary.totalRetries;
    record.metrics.totalAiCalls = internalSummary.totalAiCalls;
    record.summary.finalOutput = calculateFinalOutput(record);
    record.metrics = recalculateMetrics(record);
    record.verification = calculateVerification(record);
    record.summary = createApiSummary(record);

    this.recordEvent(
      record,
      record.status === 'complete'
        ? 'run.completed'
        : record.status === 'cancelled'
          ? 'run.cancelled'
          : 'run.failed',
      {
        runId: record.runId,
        status: record.status
      }
    );
    this.queuePersistRecord(record);
  }

  private createObserver(record: StoredDagRunRecord): DAGRunObserver {
    return {
      onNodeQueued: payload => {
        const node = record.nodesById.get(payload.nodeId);
        if (!node) {
          return;
        }

        node.status = 'queued';
        node.attempt = payload.attempt + 1;
        node.queuedAt = payload.queuedAt;
        node.spawnDepth = payload.depth;
        node.input = normalizeNodeOutput(record.templateDefinition.graph.nodes[payload.nodeId]?.metadata) ?? {};
        record.metrics.maxSpawnDepthObserved = Math.max(record.metrics.maxSpawnDepthObserved, payload.depth);
        record.metrics.totalAiCalls += 1;
        this.recordEvent(record, 'node.queued', payload);
        this.touchRecord(record);
      },
      onNodeStarted: payload => {
        const node = record.nodesById.get(payload.nodeId);
        if (!node) {
          return;
        }

        node.status = 'running';
        node.attempt = payload.attempt + 1;
        node.startedAt = payload.startedAt;
        //audit Assumption: the DAG tree should expose the concrete queue worker slot when one is known; failure risk: hard-coded worker ids hide concurrency and make live node debugging misleading; expected invariant: `node.workerId` reflects the latest queue-reported worker and otherwise preserves any previous value; handling strategy: prefer the observer payload and fall back to existing node state when no worker id is available.
        node.workerId = payload.workerId ?? node.workerId;
        this.ensureTrackedRunState(record);
        this.syncOrchestratorState(
          record,
          this.trinityOrchestrator.markNodeActive(record.runId, payload.nodeId)
        );
        this.recordEvent(record, 'node.started', payload);
        this.touchRecord(record);
      },
      onNodeCompleted: payload => {
        const node = record.nodesById.get(payload.nodeId);
        if (!node) {
          return;
        }

        const output = normalizeNodeOutput(payload.result.output);
        const metrics = extractNodeMetricsFromOutput(output);

        node.status = 'complete';
        node.completedAt = payload.completedAt;
        node.output = output;
        node.artifactRef = payload.result.artifactRef;
        node.metrics = {
          ...metrics,
          durationMs: payload.result.metrics?.durationMs ?? extractNodeDuration(metrics, output)
        };
        node.error = null;
        this.ensureTrackedRunState(record);
        this.syncOrchestratorState(
          record,
          this.trinityOrchestrator.markNodeCompleted(record.runId, payload.nodeId)
        );
        if (typeof payload.result.artifactRef === 'string' && payload.result.artifactRef.trim().length > 0) {
          this.syncOrchestratorState(
            record,
            this.trinityOrchestrator.attachArtifact(record.runId, payload.result.artifactRef)
          );
        }
        this.recordEvent(record, 'node.completed', payload);
        this.touchRecord(record);
      },
      onNodeFailed: payload => {
        const node = record.nodesById.get(payload.nodeId);
        if (!node) {
          return;
        }

        node.status = payload.willRetry ? 'waiting' : 'failed';
        node.completedAt = payload.willRetry ? undefined : payload.completedAt;
        node.output = normalizeNodeOutput(payload.result.output);
        node.artifactRef = payload.result.artifactRef;
        node.error = createErrorInfo(
          payload.result.errorMessage ?? 'Node failed.',
          node.output,
          'node_failed'
        );

        this.ensureTrackedRunState(record);
        if (!payload.willRetry) {
          this.syncOrchestratorState(
            record,
            this.trinityOrchestrator.markNodeFailed(record.runId, payload.nodeId)
          );
        }
        if (typeof payload.result.artifactRef === 'string' && payload.result.artifactRef.trim().length > 0) {
          this.syncOrchestratorState(
            record,
            this.trinityOrchestrator.attachArtifact(record.runId, payload.result.artifactRef)
          );
        }

        record.errors.push({
          errorId: generateRequestId('dagerr'),
          nodeId: payload.nodeId,
          type: payload.result.errorMessage ?? 'node_failed',
          message: payload.result.errorMessage ?? 'Node failed.',
          attempt: payload.attempt,
          at: payload.completedAt,
          retryScheduled: payload.willRetry,
          details: node.output
        });

        this.recordEvent(record, 'node.failed', payload);
        this.touchRecord(record);
      },
      onNodeRetried: payload => {
        const node = record.nodesById.get(payload.nodeId);
        if (!node) {
          return;
        }

        node.status = 'queued';
        node.attempt = payload.attempt + 1;
        record.metrics.totalRetries += 1;
        this.recordEvent(record, 'node.retried', payload);
        this.touchRecord(record);
      },
      onNodeSkipped: payload => {
        const node = record.nodesById.get(payload.nodeId);
        if (!node) {
          return;
        }

        node.status = 'skipped';
        node.completedAt = payload.at;
        node.error = null;
        this.touchRecord(record);
      },
      onNodeCancelled: payload => {
        const node = record.nodesById.get(payload.nodeId);
        if (!node) {
          return;
        }

        node.status = 'cancelled';
        node.completedAt = payload.at;
        this.recordEvent(record, 'node.cancelled', payload);
        this.touchRecord(record);
      },
      onGuardViolation: payload => {
        record.guardViolations.push({
          type: payload.type,
          nodeId: payload.nodeId,
          at: payload.at,
          message: payload.message,
          details: payload.details
        });
        this.recordEvent(record, 'guard.violation', payload);
        this.touchRecord(record);
      },
      onRunCompleted: summary => {
        record.metrics.maxParallelNodesObserved = summary.maxParallelNodesObserved;
        record.metrics.totalRetries = summary.totalRetries;
        record.metrics.totalAiCalls = summary.totalAiCalls;
        this.ensureTrackedRunState(record);
        if (summary.status === 'success') {
          this.syncOrchestratorState(
            record,
            this.trinityOrchestrator.markRunCompleted(record.runId)
          );
        } else if (summary.status === 'cancelled') {
          this.syncOrchestratorState(
            record,
            this.trinityOrchestrator.markRunCancelled(record.runId)
          );
        } else {
          this.syncOrchestratorState(
            record,
            this.trinityOrchestrator.markRunFailed(record.runId)
          );
        }
        this.touchRecord(record);
      }
    };
  }

  private recordEvent(record: StoredDagRunRecord, type: DagEvent['type'], data: unknown): void {
    const normalizedData =
      data && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : { value: data };

    record.events.push({
      eventId: generateRequestId('dag-event'),
      type,
      at: new Date().toISOString(),
      data: normalizedData
    });
  }

  private touchRecord(record: StoredDagRunRecord): void {
    record.updatedAt = new Date().toISOString();
    //audit Assumption: verification endpoints may be queried mid-run; failure risk: stale metrics and verification flags misreport live DAG progress; expected invariant: persisted snapshots reflect the latest node state after every observer update; handling strategy: recompute aggregate metrics and verification before persisting.
    record.metrics = recalculateMetrics(record);
    record.verification = calculateVerification(record);
    record.summary = createApiSummary(record);
    this.queuePersistRecord(record);
  }
}

export const arcanosDagRunService = new ArcanosDagRunService();
