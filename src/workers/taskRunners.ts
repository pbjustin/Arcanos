import { dagAgentManager } from '../agents/agentManager.js';
import type { DagAgentPromptOptions } from '../agents/registry.js';
import {
  createDagFailureResult,
  createDagSuccessResult,
  type DAGResult,
  type DAGNodeExecutionContext
} from '../dag/dagNode.js';
import {
  createDagArtifactStore,
  restoreDagDependencyArtifactsForExecution,
  type DagArtifactStore
} from '../dag/artifactStore.js';
import type { DagNodeJobInput } from '../jobs/jobSchema.js';
import { dagLogger, type DagLogger } from '../utils/logger.js';
import { dagMetrics, type DagMetricsRecorder } from '../utils/metrics.js';

export interface DagTaskRunnerDependencies {
  runPrompt(prompt: string, options: DagAgentPromptOptions): Promise<unknown>;
  logger?: DagLogger;
  metrics?: DagMetricsRecorder;
  artifactStore?: DagArtifactStore;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function truncateLogValue(value: string, maxLength = 240): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 16))}...[truncated]`;
}

function extractPromptOutputSummary(promptOutput: unknown): string | undefined {
  if (typeof promptOutput === 'string' && promptOutput.trim().length > 0) {
    return promptOutput.trim();
  }

  if (!isRecord(promptOutput)) {
    return undefined;
  }

  const candidateKeys = ['summary', 'result', 'value'] as const;
  for (const candidateKey of candidateKeys) {
    const candidateValue = promptOutput[candidateKey];
    if (typeof candidateValue === 'string' && candidateValue.trim().length > 0) {
      return candidateValue.trim();
    }
  }

  return undefined;
}

function normalizeDagPromptOutput(promptOutput: unknown): unknown {
  if (!isRecord(promptOutput)) {
    return promptOutput;
  }

  const normalizedOutput: Record<string, unknown> = { ...promptOutput };
  const summaryText = extractPromptOutputSummary(promptOutput);

  //audit Assumption: downstream DAG consumers should not need to know whether Trinity emitted its user-facing text under `result` or `summary`; failure risk: verification and synthesis stages miss valid outputs because they inspect only one field; expected invariant: structured prompt outputs expose a stable top-level `summary` when user-visible text exists; handling strategy: copy the first available summary-like field into `summary` without mutating other payload fields.
  if (
    typeof summaryText === 'string' &&
    (typeof normalizedOutput.summary !== 'string' || normalizedOutput.summary.trim().length === 0)
  ) {
    normalizedOutput.summary = summaryText;
  }

  return normalizedOutput;
}

function isVerificationNodeJob(jobInput: DagNodeJobInput): boolean {
  const declaredJobType = typeof jobInput.node.metadata?.jobType === 'string'
    ? jobInput.node.metadata.jobType
    : null;

  return jobInput.node.executionKey === 'audit' || declaredJobType === 'verify';
}

function extractTokenUsageFromPromptOutput(promptOutput: unknown): number | undefined {
  if (!promptOutput || typeof promptOutput !== 'object') {
    return undefined;
  }

  const tokenContainer = (promptOutput as {
    meta?: { tokens?: { total_tokens?: number; totalTokens?: number } };
    usage?: { total_tokens?: number };
    tokensUsed?: number;
  });

  //audit Assumption: Trinity-style outputs report token usage under `meta.tokens.total_tokens`; failure risk: budget tracking misses consumed tokens and over-schedules the DAG; expected invariant: the first available numeric token count is used; handling strategy: inspect known shapes in priority order.
  if (typeof tokenContainer.meta?.tokens?.total_tokens === 'number') {
    return tokenContainer.meta.tokens.total_tokens;
  }

  if (typeof tokenContainer.meta?.tokens?.totalTokens === 'number') {
    return tokenContainer.meta.tokens.totalTokens;
  }

  if (typeof tokenContainer.usage?.total_tokens === 'number') {
    return tokenContainer.usage.total_tokens;
  }

  if (typeof tokenContainer.tokensUsed === 'number') {
    return tokenContainer.tokensUsed;
  }

  return undefined;
}

async function attachDagResultArtifactReference(
  result: DAGResult,
  params: {
    artifactStore: DagArtifactStore;
    dagId: string;
    nodeId: string;
    attempt: number;
    artifactKind: 'result' | 'failure';
    logger: DagLogger;
  }
): Promise<DAGResult> {
  try {
    const artifactRef = await params.artifactStore.writeArtifact({
      runId: params.dagId,
      nodeId: params.nodeId,
      attempt: params.attempt,
      artifactKind: params.artifactKind,
      payload: result.output
    });

    return {
      ...result,
      artifactRef
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    //audit Assumption: artifact persistence improves queue compactness and recovery but should not erase the real DAG result on storage failure; failure risk: a transient filesystem issue turns successful node work into a hard failure; expected invariant: callers still receive the original DAG result; handling strategy: log the artifact write failure and return the inline result unchanged.
    params.logger.warn('DAG node artifact persistence failed', {
      dagId: params.dagId,
      nodeId: params.nodeId,
      artifactKind: params.artifactKind,
      errorMessage
    });

    return result;
  }
}

/**
 * Execute one queued DAG node by routing it through the registered agent handlers.
 *
 * Purpose:
 * - Convert serialized queue payloads into concrete agent execution inside the existing worker process.
 *
 * Inputs/outputs:
 * - Input: validated DAG node job payload plus AI execution dependencies.
 * - Output: normalized DAG result for queue persistence.
 *
 * Edge case behavior:
 * - Returns a failed DAG result when the execution key is unknown or the handler throws.
 */
export async function runDagNodeJob(
  jobInput: DagNodeJobInput,
  dependencies: DagTaskRunnerDependencies
): Promise<DAGResult> {
  const activeLogger = dependencies.logger ?? dagLogger;
  const activeMetrics = dependencies.metrics ?? dagMetrics;
  const artifactStore = dependencies.artifactStore ?? createDagArtifactStore();
  const startedAt = Date.now();
  const agentHandler = dagAgentManager.getAgent(jobInput.node.executionKey);

  //audit Assumption: every queued node must resolve to a registered execution handler; failure risk: worker burns queue capacity on non-runnable nodes; expected invariant: executionKey lookup succeeds for all scheduled nodes; handling strategy: return a structured failed result instead of throwing.
  if (!agentHandler) {
    activeMetrics.incrementCounter('node_lookup_failed');
    return attachDagResultArtifactReference(createDagFailureResult(
      jobInput.node.id,
      `No DAG agent handler registered for executionKey="${jobInput.node.executionKey}".`
    ), {
      artifactStore,
      dagId: jobInput.dagId,
      nodeId: jobInput.node.id,
      attempt: jobInput.attempt + 1,
      artifactKind: 'failure',
      logger: activeLogger
    });
  }

  const dependencyResults = await restoreDagDependencyArtifactsForExecution({
    artifactStore,
    dependencyResults: jobInput.dependencyResults
  });

  const executionContext: DAGNodeExecutionContext = {
    dagId: jobInput.dagId,
    node: jobInput.node,
    payload: jobInput.payload,
    dependencyResults,
    sharedState: jobInput.sharedState,
    depth: jobInput.depth,
    attempt: jobInput.attempt
  };

  try {
    activeLogger.info('Executing DAG node job', {
      dagId: jobInput.dagId,
      nodeId: jobInput.node.id,
      executionKey: jobInput.node.executionKey,
      attempt: jobInput.attempt
    });

    //audit Assumption: verification-stage failures need both the queued prompt and dependency fan-in visible in logs for postmortems; failure risk: operators can see only a final refusal without knowing which dependency payload triggered it; expected invariant: verify nodes emit one structured input log before execution; handling strategy: log a bounded prompt preview and dependency ids for audit/verify nodes only.
    if (isVerificationNodeJob(jobInput)) {
      activeLogger.info('DAG verification node input', {
        dagId: jobInput.dagId,
        nodeId: jobInput.node.id,
        executionKey: jobInput.node.executionKey,
        promptPreview: truncateLogValue(String(jobInput.payload.prompt ?? '')),
        dependencyNodeIds: Object.keys(dependencyResults)
      });
    }

    const promptOutput = await agentHandler(executionContext, {
      runPrompt: dependencies.runPrompt
    });
    const normalizedPromptOutput = normalizeDagPromptOutput(promptOutput);
    const durationMs = Date.now() - startedAt;
    const tokenUsage = extractTokenUsageFromPromptOutput(normalizedPromptOutput);

    activeMetrics.incrementCounter('node_success');
    activeMetrics.recordDuration('node_execution', durationMs);

    //audit Assumption: token usage is optional for non-AI handlers; failure risk: metrics recorder stores misleading zeroes; expected invariant: gauges are recorded only when token usage is available; handling strategy: update the gauge conditionally.
    if (typeof tokenUsage === 'number') {
      activeMetrics.recordGauge('last_node_token_usage', tokenUsage);
    }

    //audit Assumption: verification rejections depend on the final emitted payload shape, not just execution success; failure risk: worker logs show success while hiding the exact summary, response mode, and guard flags seen by downstream validators; expected invariant: verify nodes emit one structured output log with bounded user-visible fields; handling strategy: log the normalized summary plus core guard metadata immediately after execution.
    if (isVerificationNodeJob(jobInput) && isRecord(normalizedPromptOutput)) {
      const reasoningHonesty = isRecord(normalizedPromptOutput.reasoningHonesty)
        ? normalizedPromptOutput.reasoningHonesty
        : undefined;
      const auditSafe = isRecord(normalizedPromptOutput.auditSafe)
        ? normalizedPromptOutput.auditSafe
        : undefined;

      activeLogger.info('DAG verification node output', {
        dagId: jobInput.dagId,
        nodeId: jobInput.node.id,
        executionKey: jobInput.node.executionKey,
        summaryPreview: truncateLogValue(extractPromptOutputSummary(normalizedPromptOutput) ?? ''),
        responseMode: typeof reasoningHonesty?.responseMode === 'string'
          ? reasoningHonesty.responseMode
          : null,
        auditFlags: Array.isArray(auditSafe?.auditFlags)
          ? auditSafe.auditFlags
          : []
      });
    }

    return attachDagResultArtifactReference(createDagSuccessResult(jobInput.node.id, normalizedPromptOutput, {
      durationMs,
      tokenUsage
    }), {
      artifactStore,
      dagId: jobInput.dagId,
      nodeId: jobInput.node.id,
      attempt: jobInput.attempt + 1,
      artifactKind: 'result',
      logger: activeLogger
    });
  } catch (error: unknown) {
    const durationMs = Date.now() - startedAt;
    const errorMessage = error instanceof Error ? error.message : String(error);

    activeMetrics.incrementCounter('node_failure');
    activeMetrics.recordDuration('node_execution_failed', durationMs);
    activeLogger.error('DAG node job failed', {
      dagId: jobInput.dagId,
      nodeId: jobInput.node.id,
      executionKey: jobInput.node.executionKey,
      errorMessage
    });

    return attachDagResultArtifactReference(createDagFailureResult(jobInput.node.id, errorMessage, {
      errorMessage,
      durationMs
    }), {
      artifactStore,
      dagId: jobInput.dagId,
      nodeId: jobInput.node.id,
      attempt: jobInput.attempt + 1,
      artifactKind: 'failure',
      logger: activeLogger
    });
  }
}
