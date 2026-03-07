export type ISODateString = string;
export type UUID = string;

export interface ApiEnvelope<T> {
  ok: boolean;
  timestamp: ISODateString;
  version: string;
  requestId: string;
  data: T;
}

export type RunStatus =
  | 'queued'
  | 'running'
  | 'complete'
  | 'failed'
  | 'cancelled';

export type NodeStatus =
  | 'queued'
  | 'waiting'
  | 'running'
  | 'complete'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export type NodeResultStatus =
  | 'success'
  | 'failed'
  | 'skipped'
  | 'blocked'
  | 'timed_out';

export type WorkerType = 'in_process' | 'async_queue';

export type WorkerStatus = 'healthy' | 'degraded' | 'unhealthy' | 'offline';

export type AgentRole =
  | 'planner'
  | 'research'
  | 'build'
  | 'write'
  | 'writer'
  | 'audit'
  | 'tracker'
  | 'custom';

export type JobType =
  | 'plan'
  | 'search'
  | 'analyze'
  | 'synthesize'
  | 'verify'
  | 'execute'
  | 'custom';

export type GuardViolationType =
  | 'max_spawn_depth_exceeded'
  | 'max_children_exceeded'
  | 'max_retries_exceeded'
  | 'max_ai_calls_exceeded'
  | 'budget_exceeded'
  | 'deadline_exceeded'
  | 'loop_detected'
  | 'rate_limit_exceeded'
  | 'unknown';

export type DagEventType =
  | 'run.created'
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'node.queued'
  | 'node.started'
  | 'node.completed'
  | 'node.failed'
  | 'node.retried'
  | 'node.cancelled'
  | 'guard.violation';

export interface ErrorInfo {
  code?: string;
  type?: string;
  message: string;
  details?: unknown;
  stack?: string;
}

export interface FeatureFlags {
  dagOrchestration: boolean;
  parallelExecution: boolean;
  recursiveSpawning: boolean;
  jobTreeInspection: boolean;
  eventStreaming: boolean;
}

export interface ExecutionLimits {
  maxConcurrency: number;
  maxSpawnDepth: number;
  maxChildrenPerNode: number;
  maxRetriesPerNode: number;
  maxAiCallsPerRun: number;
  defaultNodeTimeoutMs: number;
}

export interface HealthData {
  service: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
}

export type HealthResponse = ApiEnvelope<HealthData>;

export interface CapabilitiesData {
  features: FeatureFlags;
  limits: ExecutionLimits;
}

export type CapabilitiesResponse = ApiEnvelope<CapabilitiesData>;

export interface WorkerInfo {
  workerId: string;
  type: WorkerType;
  status: WorkerStatus;
  activeJobs: number;
  lastHeartbeatAt: ISODateString;
}

export interface WorkersStatusData {
  workers: WorkerInfo[];
}

export type WorkersStatusResponse = ApiEnvelope<WorkersStatusData>;

export interface QueueSnapshot {
  name: string;
  depth: number;
  running: number;
  waiting: number;
  failed: number;
  delayed: number;
  oldestWaitingJobAgeMs: number;
  stalledJobs: number;
}

export interface QueueStatusData {
  queue: QueueSnapshot;
}

export type QueueStatusResponse = ApiEnvelope<QueueStatusData>;

export interface DagRunOptions {
  maxConcurrency?: number;
  allowRecursiveSpawning?: boolean;
  debug?: boolean;
}

export interface CreateDagRunRequest {
  sessionId: string;
  template: string;
  input: Record<string, unknown>;
  options?: DagRunOptions;
}

export interface FinalOutput {
  summary?: string;
  [key: string]: unknown;
}

export interface DagRunSummary {
  runId: string;
  sessionId: string;
  template: string;
  status: RunStatus;
  plannerNodeId?: string | null;
  rootNodeId?: string | null;
  spawnDepthMaxObserved?: number;
  totalNodes?: number;
  completedNodes?: number;
  failedNodes?: number;
  retryCount?: number;
  durationMs?: number;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  finalOutput?: FinalOutput;
}

export interface CreateDagRunData {
  run: DagRunSummary;
}

export type CreateDagRunResponse = ApiEnvelope<CreateDagRunData>;

export interface DagRunData {
  run: DagRunSummary;
}

export type DagRunResponse = ApiEnvelope<DagRunData>;

export interface DagTreeNode {
  nodeId: string;
  parentNodeId: string | null;
  agentRole: AgentRole;
  jobType: JobType;
  status: NodeStatus;
  dependencyIds: string[];
  childNodeIds: string[];
  spawnDepth: number;
  workerId?: string;
  startedAt?: ISODateString;
  completedAt?: ISODateString;
}

export interface DagTreeData {
  runId: string;
  nodes: DagTreeNode[];
}

export type DagTreeResponse = ApiEnvelope<DagTreeData>;

export interface NodeMetrics {
  durationMs?: number;
  promptTokens?: number;
  completionTokens?: number;
}

export interface NodeDetail {
  nodeId: string;
  runId: string;
  parentNodeId: string | null;
  agentRole: AgentRole;
  jobType: JobType;
  status: NodeStatus;
  dependencyIds: string[];
  spawnDepth: number;
  attempt: number;
  maxRetries: number;
  workerId?: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  metrics?: NodeMetrics;
  startedAt?: ISODateString;
  completedAt?: ISODateString;
  error: ErrorInfo | null;
}

export interface NodeDetailData {
  node: NodeDetail;
}

export type NodeDetailResponse = ApiEnvelope<NodeDetailData>;

export interface DagEvent<T = Record<string, unknown>> {
  eventId: string;
  type: DagEventType;
  at: ISODateString;
  data: T;
}

export interface DagEventsData {
  runId: string;
  events: DagEvent[];
}

export type DagEventsResponse = ApiEnvelope<DagEventsData>;

export interface GuardViolation {
  type: GuardViolationType;
  nodeId?: string;
  at?: ISODateString;
  message: string;
  details?: unknown;
}

export interface DagRunMetrics {
  totalNodes: number;
  maxParallelNodesObserved: number;
  maxSpawnDepthObserved: number;
  totalRetries: number;
  totalFailures: number;
  totalAiCalls: number;
  estimatedCostUsd: number;
  wallClockDurationMs: number;
  sumNodeDurationMs: number;
  queueWaitMsP50: number;
  queueWaitMsP95: number;
}

export interface DagMetricsData {
  runId: string;
  metrics: DagRunMetrics;
  limits: ExecutionLimits;
  guardViolations: GuardViolation[];
}

export type DagMetricsResponse = ApiEnvelope<DagMetricsData>;

export interface DagRunError {
  errorId: string;
  nodeId: string;
  type: string;
  message: string;
  attempt: number;
  at: ISODateString;
  retryScheduled: boolean;
  details?: unknown;
}

export interface DagErrorsData {
  runId: string;
  errors: DagRunError[];
}

export type DagErrorsResponse = ApiEnvelope<DagErrorsData>;

export interface LineageEntry {
  nodeId: string;
  parentNodeId: string | null;
  spawnDepth: number;
  lineage: string[];
}

export interface DagLineageData {
  runId: string;
  lineage: LineageEntry[];
  loopDetected: boolean;
}

export type DagLineageResponse = ApiEnvelope<DagLineageData>;

export interface CancelDagRunResponseData {
  runId: string;
  status: 'cancelled';
  cancelledNodes: string[];
}

export type CancelDagRunResponse = ApiEnvelope<CancelDagRunResponseData>;

export interface DagVerification {
  runCompleted: boolean;
  plannerSpawnedChildren: boolean;
  parallelExecutionObserved: boolean;
  aggregationRanLast: boolean;
  retryPolicyRespected: boolean;
  budgetPolicyRespected: boolean;
  deadlockDetected: boolean;
  stalledJobsDetected: boolean;
  loopDetected: boolean;
}

export interface DagVerificationLineage {
  workerPipeline: 'trinity';
  workerEntryPoint: 'runWorkerTrinityPrompt';
  sessionId: string;
  sessionPropagationMode: 'inherit_run_session' | 'synthetic_fallback';
  observedWorkerIds: string[];
  observedSourceEndpoints: string[];
}

export interface DagVerificationData {
  runId: string;
  verification: DagVerification;
  lineage: DagVerificationLineage;
}

export type DagVerificationResponse = ApiEnvelope<DagVerificationData>;

/**
 * Optional route map for IDE/autocomplete use.
 *
 * Purpose:
 * - Describe the typed request and response shapes for the verification API surface.
 *
 * Inputs/outputs:
 * - Input: none.
 * - Output: compile-time route contract only.
 *
 * Edge case behavior:
 * - This interface is descriptive and does not enforce runtime routing by itself.
 */
export interface ArcanosVerificationApi {
  'GET /api/arcanos/health': {
    request: undefined;
    response: HealthResponse;
  };
  'GET /api/arcanos/capabilities': {
    request: undefined;
    response: CapabilitiesResponse;
  };
  'GET /api/arcanos/workers/status': {
    request: undefined;
    response: WorkersStatusResponse;
  };
  'GET /api/arcanos/workers/queue': {
    request: undefined;
    response: QueueStatusResponse;
  };
  'POST /api/arcanos/dag/runs': {
    request: CreateDagRunRequest;
    response: CreateDagRunResponse;
  };
  'GET /api/arcanos/dag/runs/:runId': {
    request: { runId: string };
    response: DagRunResponse;
  };
  'GET /api/arcanos/dag/runs/:runId/tree': {
    request: { runId: string };
    response: DagTreeResponse;
  };
  'GET /api/arcanos/dag/runs/:runId/nodes/:nodeId': {
    request: { runId: string; nodeId: string };
    response: NodeDetailResponse;
  };
  'GET /api/arcanos/dag/runs/:runId/events': {
    request: { runId: string };
    response: DagEventsResponse;
  };
  'GET /api/arcanos/dag/runs/:runId/metrics': {
    request: { runId: string };
    response: DagMetricsResponse;
  };
  'GET /api/arcanos/dag/runs/:runId/errors': {
    request: { runId: string };
    response: DagErrorsResponse;
  };
  'GET /api/arcanos/dag/runs/:runId/lineage': {
    request: { runId: string };
    response: DagLineageResponse;
  };
  'POST /api/arcanos/dag/runs/:runId/cancel': {
    request: { runId: string };
    response: CancelDagRunResponse;
  };
  'GET /api/arcanos/dag/runs/:runId/verification': {
    request: { runId: string };
    response: DagVerificationResponse;
  };
}

/**
 * Determine whether a run status is terminal.
 *
 * Purpose:
 * - Provide a shared helper for API handlers and clients that poll run lifecycle endpoints.
 *
 * Inputs/outputs:
 * - Input: run status string.
 * - Output: `true` when the run will no longer transition.
 *
 * Edge case behavior:
 * - Only `complete`, `failed`, and `cancelled` are treated as terminal.
 */
export function isTerminalRunStatus(status: RunStatus): boolean {
  return status === 'complete' || status === 'failed' || status === 'cancelled';
}

/**
 * Determine whether a node status is terminal.
 *
 * Purpose:
 * - Keep node lifecycle checks consistent across verification APIs.
 *
 * Inputs/outputs:
 * - Input: node status string.
 * - Output: `true` when the node should no longer be scheduled or updated.
 *
 * Edge case behavior:
 * - `queued`, `waiting`, and `running` remain non-terminal.
 */
export function isTerminalNodeStatus(status: NodeStatus): boolean {
  return (
    status === 'complete' ||
    status === 'failed' ||
    status === 'skipped' ||
    status === 'cancelled'
  );
}
