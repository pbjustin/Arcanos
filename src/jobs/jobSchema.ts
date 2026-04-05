import { z } from 'zod';
import type { JobData } from '../core/db/schema.js';
import type { DAGNode, DAGResult, QueuedDAGNodeDefinition } from '../dag/dagNode.js';
import { stripDagNodeExecutor } from '../dag/dagNode.js';
import { DEFAULT_DAG_NODE_TIMEOUT_MS } from '../workers/workerExecutionLimits.js';

const dagNodeMetricsSchema = z.record(z.number().optional()).optional();

const dagResultSchema = z.object({
  nodeId: z.string().trim().min(1),
  status: z.enum(['success', 'failed', 'skipped']),
  output: z.unknown(),
  errorMessage: z.string().trim().min(1).optional(),
  metrics: dagNodeMetricsSchema,
  artifactRef: z.string().trim().min(1).optional(),
  retryable: z.boolean().optional()
});

const queuedDagNodeDefinitionSchema = z.object({
  id: z.string().trim().min(1),
  type: z.enum(['task', 'decision', 'agent']),
  dependencies: z.array(z.string().trim().min(1)).default([]),
  executionKey: z.string().trim().min(1),
  metadata: z.record(z.unknown()).optional()
});

const dagNodeJobInputSchema = z.object({
  dagId: z.string().trim().min(1),
  node: queuedDagNodeDefinitionSchema,
  payload: z.record(z.unknown()).default({}),
  dependencyResults: z.record(dagResultSchema).default({}),
  sharedState: z.record(z.unknown()).default({}),
  depth: z.number().int().min(0),
  attempt: z.number().int().min(0).default(0),
  maxRetries: z.number().int().min(0).default(2),
  waitingTimeoutMs: z.number().int().positive().default(DEFAULT_DAG_NODE_TIMEOUT_MS)
});

export type DagQueueJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface DagNodeJobInput {
  dagId: string;
  node: QueuedDAGNodeDefinition;
  payload: Record<string, unknown>;
  dependencyResults: Record<string, DAGResult>;
  sharedState: Record<string, unknown>;
  depth: number;
  attempt: number;
  maxRetries: number;
  waitingTimeoutMs: number;
}

export interface DagQueueJobRecord {
  jobId: string;
  dagId: string;
  nodeId: string;
  status: DagQueueJobStatus;
  workerId: string | null;
  retries: number;
  maxRetries: number;
  waitingTimeoutMs: number;
  payload: Record<string, unknown>;
  node: QueuedDAGNodeDefinition;
  dependencyResults: Record<string, DAGResult>;
  sharedState: Record<string, unknown>;
  depth: number;
  output: DAGResult | null;
  errorMessage: string | null;
  timestamps: {
    queuedAt: string;
    updatedAt: string;
    startedAt?: string;
    lastHeartbeatAt?: string;
    completedAt?: string;
  };
}

export type ParsedDagNodeJobInput =
  | { ok: true; value: DagNodeJobInput }
  | { ok: false; error: string };

function normalizeDagQueueJobStatus(status: string): DagQueueJobStatus {
  switch (status) {
    case 'pending':
      return 'queued';
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    default:
      return 'failed';
  }
}

/**
 * Build the persisted queue payload for one DAG node job.
 *
 * Purpose:
 * - Convert runtime node definitions into a JSON-safe job payload for `job_data.input`.
 *
 * Inputs/outputs:
 * - Input: DAG identifiers, runtime node, dependency results, and scheduling metadata.
 * - Output: normalized DAG node job payload.
 *
 * Edge case behavior:
 * - Strips the runtime `execute` function from the node before persistence.
 */
export function buildDagNodeJobInput(input: {
  dagId: string;
  node: DAGNode;
  payload?: Record<string, unknown>;
  dependencyResults?: Record<string, DAGResult>;
  sharedState?: Record<string, unknown>;
  depth: number;
  attempt?: number;
  maxRetries?: number;
  waitingTimeoutMs?: number;
}): DagNodeJobInput {
  return {
    dagId: input.dagId,
    node: stripDagNodeExecutor(input.node),
    payload: { ...(input.payload ?? {}) },
    dependencyResults: { ...(input.dependencyResults ?? {}) },
    sharedState: { ...(input.sharedState ?? {}) },
    depth: input.depth,
    attempt: input.attempt ?? 0,
    maxRetries: input.maxRetries ?? 2,
    waitingTimeoutMs: input.waitingTimeoutMs ?? DEFAULT_DAG_NODE_TIMEOUT_MS
  };
}

/**
 * Parse raw DAG node job input loaded from the queue table.
 *
 * Purpose:
 * - Validate queued DAG payloads before a worker attempts execution.
 *
 * Inputs/outputs:
 * - Input: unknown JSON from `job_data.input`.
 * - Output: success or structured validation failure.
 *
 * Edge case behavior:
 * - Aggregates all schema issue messages into one deterministic error string.
 */
export function parseDagNodeJobInput(rawInput: unknown): ParsedDagNodeJobInput {
  const parsedInput = dagNodeJobInputSchema.safeParse(rawInput);

  //audit Assumption: malformed DAG queue payloads should fail one job rather than crash the worker loop; failure risk: poison DAG jobs destabilize the entire queue; expected invariant: invalid payloads are converted into explicit job failures; handling strategy: return a structured parse error instead of throwing.
  if (!parsedInput.success) {
    return {
      ok: false,
      error: parsedInput.error.issues
        .map(issue => `${issue.path.join('.') || 'job.input'}: ${issue.message}`)
        .join('; ')
    };
  }

  return {
    ok: true,
    value: parsedInput.data as DagNodeJobInput
  };
}

/**
 * Convert a persisted `job_data` row into a DAG-focused queue record.
 *
 * Purpose:
 * - Give orchestrator code one stable view over the existing generic queue table.
 *
 * Inputs/outputs:
 * - Input: database job row created for a `dag-node` job.
 * - Output: normalized DAG queue job record.
 *
 * Edge case behavior:
 * - Throws when the stored input is not a valid DAG node payload because the job can no longer be interpreted safely.
 */
export function buildDagQueueJobRecord(job: JobData): DagQueueJobRecord {
  const parsedInput = parseDagNodeJobInput(job.input ?? {});

  //audit Assumption: orchestrator reads only jobs it created; failure risk: foreign or corrupted queue rows are misinterpreted as DAG jobs; expected invariant: every `dag-node` row contains a valid DAG payload; handling strategy: reject invalid rows so callers can fail closed.
  if (!parsedInput.ok) {
    throw new Error(`Invalid DAG job payload for job ${job.id}: ${parsedInput.error}`);
  }

  const parsedOutput = dagResultSchema.safeParse(job.output);
  const queuedAt = new Date(job.created_at).toISOString();
  const updatedAt = new Date(job.updated_at).toISOString();
  const startedAt = job.started_at ? new Date(job.started_at).toISOString() : undefined;
  const lastHeartbeatAt = job.last_heartbeat_at
    ? new Date(job.last_heartbeat_at).toISOString()
    : undefined;
  const completedAt = job.completed_at ? new Date(job.completed_at).toISOString() : undefined;

  return {
    jobId: job.id,
    dagId: parsedInput.value.dagId,
    nodeId: parsedInput.value.node.id,
    status: normalizeDagQueueJobStatus(job.status),
    workerId: job.last_worker_id ?? job.worker_id ?? null,
    retries: parsedInput.value.attempt,
    maxRetries: parsedInput.value.maxRetries,
    waitingTimeoutMs: parsedInput.value.waitingTimeoutMs,
    payload: parsedInput.value.payload,
    node: parsedInput.value.node,
    dependencyResults: parsedInput.value.dependencyResults,
    sharedState: parsedInput.value.sharedState,
    depth: parsedInput.value.depth,
    output: parsedOutput.success ? (parsedOutput.data as DAGResult) : null,
    errorMessage: job.error_message ?? null,
    timestamps: {
      queuedAt,
      updatedAt,
      startedAt,
      lastHeartbeatAt,
      completedAt
    }
  };
}
