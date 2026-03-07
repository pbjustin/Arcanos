import { dagAgentManager } from '../agents/agentManager.js';
import type { DagAgentPromptOptions } from '../agents/registry.js';
import {
  createDagFailureResult,
  createDagSuccessResult,
  type DAGResult,
  type DAGNodeExecutionContext
} from '../dag/dagNode.js';
import type { DagNodeJobInput } from '../jobs/jobSchema.js';
import { dagLogger, type DagLogger } from '../utils/logger.js';
import { dagMetrics, type DagMetricsRecorder } from '../utils/metrics.js';

export interface DagTaskRunnerDependencies {
  runPrompt(prompt: string, options: DagAgentPromptOptions): Promise<unknown>;
  logger?: DagLogger;
  metrics?: DagMetricsRecorder;
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
  const startedAt = Date.now();
  const agentHandler = dagAgentManager.getAgent(jobInput.node.executionKey);

  //audit Assumption: every queued node must resolve to a registered execution handler; failure risk: worker burns queue capacity on non-runnable nodes; expected invariant: executionKey lookup succeeds for all scheduled nodes; handling strategy: return a structured failed result instead of throwing.
  if (!agentHandler) {
    activeMetrics.incrementCounter('node_lookup_failed');
    return createDagFailureResult(
      jobInput.node.id,
      `No DAG agent handler registered for executionKey="${jobInput.node.executionKey}".`
    );
  }

  const executionContext: DAGNodeExecutionContext = {
    dagId: jobInput.dagId,
    node: jobInput.node,
    payload: jobInput.payload,
    dependencyResults: jobInput.dependencyResults,
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

    const promptOutput = await agentHandler(executionContext, {
      runPrompt: dependencies.runPrompt
    });
    const durationMs = Date.now() - startedAt;
    const tokenUsage = extractTokenUsageFromPromptOutput(promptOutput);

    activeMetrics.incrementCounter('node_success');
    activeMetrics.recordDuration('node_execution', durationMs);

    //audit Assumption: token usage is optional for non-AI handlers; failure risk: metrics recorder stores misleading zeroes; expected invariant: gauges are recorded only when token usage is available; handling strategy: update the gauge conditionally.
    if (typeof tokenUsage === 'number') {
      activeMetrics.recordGauge('last_node_token_usage', tokenUsage);
    }

    return createDagSuccessResult(jobInput.node.id, promptOutput, {
      durationMs,
      tokenUsage
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

    return createDagFailureResult(jobInput.node.id, errorMessage, {
      errorMessage,
      durationMs
    });
  }
}
