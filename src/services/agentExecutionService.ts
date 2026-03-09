/**
 * Capability-planner execution service above the CEF.
 */

import { generateRequestId } from '@shared/idGenerator.js';
import {
  createDagFailureResult,
  createDagSuccessResult,
  stripDagNodeExecutor,
  type DAGNode,
  type DAGNodeExecutionContext
} from '../dag/dagNode.js';
import {
  DAGOrchestrator,
  type DAGRunObserver,
  type DAGRunSummary
} from '../dag/orchestrator.js';
import type { DAGGraph } from '../dag/dagGraph.js';
import type {
  DagJobQueue,
  EnqueueDagNodeJobRequest,
  WaitForDagJobCompletionOptions
} from '../jobs/jobQueue.js';
import type { DagQueueJobRecord } from '../jobs/jobSchema.js';
import {
  executeCommand,
  type CommandExecutionContext,
  type CommandExecutionResult,
  type CommandName
} from './commandCenter.js';
import { dispatchCapabilityViaCef, getCapabilityRegistryEntry } from './agentCapabilityRegistry.js';
import { planGoalExecution } from './agentGoalPlanner.js';
import { AgentExecutionTraceRecorder } from './agentExecutionTraceService.js';
import type {
  AgentCommandStepExecutionResult,
  AgentDagExecutionSummary,
  AgentExecutionPlan,
  AgentGoalExecutionRequest,
  AgentGoalExecutionResponse,
  AgentPlannedCapabilityStep
} from './agentExecutionTypes.js';

interface AgentExecutionServiceDependencies {
  commandExecutor?: (
    command: CommandName,
    payload?: Record<string, unknown>,
    context?: CommandExecutionContext
  ) => Promise<CommandExecutionResult>;
  createTraceRecorder?: (executionId: string, traceId: string) => AgentExecutionTraceRecorder;
  createDagOrchestrator?: () => DAGOrchestrator;
}

class InProcessCapabilityDagJobQueue implements DagJobQueue {
  private jobCounter = 0;

  private readonly jobsById = new Map<string, Promise<DagQueueJobRecord>>();

  /**
   * Enqueue one DAG step for immediate in-process execution.
   *
   * Purpose:
   * - Reuse the DAG orchestrator for planned CEF command graphs without depending on a separate worker process.
   *
   * Inputs/outputs:
   * - Input: queued DAG node request.
   * - Output: normalized queued job record.
   *
   * Edge case behavior:
   * - Stores the completion promise immediately so orchestrator polling can observe the job.
   */
  async enqueueDagNodeJob(request: EnqueueDagNodeJobRequest): Promise<DagQueueJobRecord> {
    const jobId = `agent-dag-job-${++this.jobCounter}`;
    const queuedAt = new Date().toISOString();
    const completionPromise = this.executeQueuedNode(jobId, request, queuedAt);
    this.jobsById.set(jobId, completionPromise);

    return {
      jobId,
      dagId: request.dagId,
      nodeId: request.node.id,
      status: 'queued',
      workerId: null,
      retries: request.attempt ?? 0,
      maxRetries: request.maxRetries ?? 0,
      waitingTimeoutMs: request.waitingTimeoutMs ?? 60_000,
      payload: { ...(request.payload ?? {}) },
      node: stripDagNodeExecutor(request.node),
      dependencyResults: { ...(request.dependencyResults ?? {}) },
      sharedState: { ...(request.sharedState ?? {}) },
      depth: request.depth,
      output: null,
      errorMessage: null,
      timestamps: {
        queuedAt,
        updatedAt: queuedAt
      }
    };
  }

  /**
   * Await completion of one in-process DAG step.
   *
   * Purpose:
   * - Satisfy the DAG orchestrator contract with an immediately-executed local queue.
   *
   * Inputs/outputs:
   * - Input: queued job identifier.
   * - Output: terminal queue record.
   *
   * Edge case behavior:
   * - Throws when an unknown job id is requested.
   */
  async waitForDagJobCompletion(
    jobId: string,
    _options: WaitForDagJobCompletionOptions = {}
  ): Promise<DagQueueJobRecord> {
    const completionPromise = this.jobsById.get(jobId);

    //audit Assumption: the orchestrator only waits on jobs previously enqueued in this queue instance; failure risk: a mismatched queue/orchestrator pair waits forever or returns nonsense; expected invariant: each waited job id exists in the local queue map; handling strategy: throw on unknown ids.
    if (!completionPromise) {
      throw new Error(`Unknown in-process agent DAG job "${jobId}".`);
    }

    return completionPromise;
  }

  private async executeQueuedNode(
    jobId: string,
    request: EnqueueDagNodeJobRequest,
    queuedAt: string
  ): Promise<DagQueueJobRecord> {
    const startedAt = new Date().toISOString();
    const executionContext: DAGNodeExecutionContext = {
      dagId: request.dagId,
      node: stripDagNodeExecutor(request.node),
      payload: { ...(request.payload ?? {}) },
      dependencyResults: { ...(request.dependencyResults ?? {}) },
      sharedState: { ...(request.sharedState ?? {}) },
      depth: request.depth,
      attempt: request.attempt ?? 0
    };

    try {
      //audit Assumption: compiled capability DAG nodes always provide an executable function; failure risk: the DAG path accepts a graph that can never run; expected invariant: every compiled node has `execute`; handling strategy: fail the queued job explicitly when the executor is missing.
      if (!request.node.execute) {
        throw new Error(`Capability DAG node "${request.node.id}" is missing an execute function.`);
      }

      const result = await request.node.execute(executionContext);
      const completedAt = new Date().toISOString();

      return {
        jobId,
        dagId: request.dagId,
        nodeId: request.node.id,
        status: result.status === 'failed' ? 'failed' : 'completed',
        workerId: null,
        retries: request.attempt ?? 0,
        maxRetries: request.maxRetries ?? 0,
        waitingTimeoutMs: request.waitingTimeoutMs ?? 60_000,
        payload: { ...(request.payload ?? {}) },
        node: stripDagNodeExecutor(request.node),
        dependencyResults: { ...(request.dependencyResults ?? {}) },
        sharedState: { ...(request.sharedState ?? {}) },
        depth: request.depth,
        output: result,
        errorMessage: result.errorMessage ?? null,
        timestamps: {
          queuedAt,
          startedAt,
          updatedAt: completedAt,
          completedAt
        }
      };
    } catch (error: unknown) {
      const completedAt = new Date().toISOString();
      const errorMessage = error instanceof Error ? error.message : String(error);

      return {
        jobId,
        dagId: request.dagId,
        nodeId: request.node.id,
        status: 'failed',
        workerId: null,
        retries: request.attempt ?? 0,
        maxRetries: request.maxRetries ?? 0,
        waitingTimeoutMs: request.waitingTimeoutMs ?? 60_000,
        payload: { ...(request.payload ?? {}) },
        node: stripDagNodeExecutor(request.node),
        dependencyResults: { ...(request.dependencyResults ?? {}) },
        sharedState: { ...(request.sharedState ?? {}) },
        depth: request.depth,
        output: null,
        errorMessage,
        timestamps: {
          queuedAt,
          startedAt,
          updatedAt: completedAt,
          completedAt
        }
      };
    }
  }
}

function isAgentCommandStepExecutionResult(value: unknown): value is AgentCommandStepExecutionResult {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.stepId === 'string' &&
    typeof candidate.capabilityId === 'string' &&
    typeof candidate.commandName === 'string' &&
    typeof candidate.status === 'string' &&
    typeof candidate.success === 'boolean' &&
    typeof candidate.message === 'string'
  );
}

function buildFallbackStepResult(
  step: AgentPlannedCapabilityStep,
  status: AgentCommandStepExecutionResult['status'],
  message: string,
  startedAt: string,
  completedAt: string,
  output: unknown = null,
  error: string | null = null
): AgentCommandStepExecutionResult {
  return {
    stepId: step.stepId,
    capabilityId: step.capabilityId,
    commandName: getCapabilityRegistryEntry(step.capabilityId)?.cefCommandName ?? 'ai:prompt',
    status,
    success: status === 'completed',
    message,
    output,
    commandMetadata: null,
    startedAt,
    completedAt,
    error
  };
}

function mapDagSummary(summary: DAGRunSummary): AgentDagExecutionSummary {
  return {
    dagId: summary.dagId,
    status: summary.status,
    failedNodeIds: [...summary.failedNodeIds],
    skippedNodeIds: [...summary.skippedNodeIds],
    cancelledNodeIds: [...summary.cancelledNodeIds],
    tokenBudgetUsed: summary.tokenBudgetUsed,
    totalAiCalls: summary.totalAiCalls,
    totalRetries: summary.totalRetries,
    maxParallelNodesObserved: summary.maxParallelNodesObserved,
    startedAt: summary.startedAt,
    completedAt: summary.completedAt
  };
}

function buildFinalOutput(stepResults: AgentCommandStepExecutionResult[]): unknown | null {
  const completedResults = stepResults.filter(stepResult => stepResult.status === 'completed');
  return completedResults.length > 0 ? completedResults[completedResults.length - 1].output : null;
}

async function executePlannedCommandStep(
  step: AgentPlannedCapabilityStep,
  commandExecutor: (
    command: CommandName,
    payload?: Record<string, unknown>,
    context?: CommandExecutionContext
  ) => Promise<CommandExecutionResult>,
  traceRecorder: AgentExecutionTraceRecorder,
  executionId: string,
  traceId: string
): Promise<AgentCommandStepExecutionResult> {
  const startedAt = new Date().toISOString();
  await traceRecorder.record('info', 'agent.step.started', {
    executionId,
    stepId: step.stepId,
    capabilityId: step.capabilityId
  });

  try {
    const commandResult = await dispatchCapabilityViaCef(step, commandExecutor, {
      executionId,
      traceId,
      capabilityId: step.capabilityId,
      stepId: step.stepId,
      source: 'agent-execution-service'
    });
    const completedAt = new Date().toISOString();
    const stepResult: AgentCommandStepExecutionResult = {
      stepId: step.stepId,
      capabilityId: step.capabilityId,
      commandName: commandResult.command,
      status: commandResult.success ? 'completed' : 'failed',
      success: commandResult.success,
      message: commandResult.message,
      output: commandResult.output ?? null,
      commandMetadata: {
        ...commandResult.metadata
      },
      startedAt,
      completedAt,
      error: commandResult.success ? null : commandResult.message
    };

    await traceRecorder.record(commandResult.success ? 'info' : 'warn', 'agent.step.completed', {
      executionId,
      stepId: step.stepId,
      capabilityId: step.capabilityId,
      commandName: commandResult.command,
      status: stepResult.status,
      success: stepResult.success
    });

    return stepResult;
  } catch (error: unknown) {
    const completedAt = new Date().toISOString();
    const errorMessage = error instanceof Error ? error.message : String(error);
    const failedResult = buildFallbackStepResult(
      step,
      'failed',
      errorMessage,
      startedAt,
      completedAt,
      null,
      errorMessage
    );

    await traceRecorder.record('error', 'agent.step.failed', {
      executionId,
      stepId: step.stepId,
      capabilityId: step.capabilityId,
      error: errorMessage
    });

    return failedResult;
  }
}

function compilePlanToDagGraph(
  executionId: string,
  traceId: string,
  plan: AgentExecutionPlan,
  commandExecutor: (
    command: CommandName,
    payload?: Record<string, unknown>,
    context?: CommandExecutionContext
  ) => Promise<CommandExecutionResult>,
  traceRecorder: AgentExecutionTraceRecorder
): DAGGraph {
  const nodes: Record<string, DAGNode> = {};
  const edges: Array<{ from: string; to: string }> = [];

  for (const step of plan.steps) {
    nodes[step.stepId] = {
      id: step.stepId,
      type: 'task',
      dependencies: [...step.dependsOnStepIds],
      executionKey: step.capabilityId,
      metadata: {
        capabilityId: step.capabilityId,
        reason: step.reason
      },
      execute: async () => {
        const stepResult = await executePlannedCommandStep(
          step,
          commandExecutor,
          traceRecorder,
          executionId,
          traceId
        );

        //audit Assumption: the DAG orchestrator must see failed command steps as failed nodes to preserve dependency blocking; failure risk: dependent nodes run after a failed command and the response claims success; expected invariant: unsuccessful CEF commands become failed DAG results; handling strategy: convert failed step results into `createDagFailureResult` payloads that still preserve the structured step result.
        if (!stepResult.success) {
          return createDagFailureResult(step.stepId, stepResult.message, stepResult);
        }

        return createDagSuccessResult(step.stepId, stepResult);
      }
    };

    for (const dependencyStepId of step.dependsOnStepIds) {
      edges.push({
        from: dependencyStepId,
        to: step.stepId
      });
    }
  }

  return {
    id: `${executionId}-dag`,
    nodes,
    edges,
    entrypoints: plan.steps.filter(step => step.dependsOnStepIds.length === 0).map(step => step.stepId)
  };
}

function normalizeDagStepResult(
  step: AgentPlannedCapabilityStep,
  dagSummary: DAGRunSummary
): AgentCommandStepExecutionResult {
  const dagResult = dagSummary.resultsByNodeId[step.stepId];

  //audit Assumption: every planned step should resolve to a DAG result unless it was cancelled before execution; failure risk: response payload omits step state and becomes ambiguous for callers; expected invariant: each planned step maps to a concrete terminal state; handling strategy: synthesize a skipped result when the DAG did not produce one.
  if (!dagResult) {
    return buildFallbackStepResult(
      step,
      'skipped',
      'Step did not produce a DAG result.',
      dagSummary.startedAt,
      dagSummary.completedAt
    );
  }

  if (isAgentCommandStepExecutionResult(dagResult.output)) {
    return dagResult.output;
  }

  if (dagResult.status === 'skipped') {
    return buildFallbackStepResult(
      step,
      'skipped',
      dagResult.errorMessage ?? 'Step was skipped.',
      dagSummary.startedAt,
      dagSummary.completedAt,
      dagResult.output ?? null,
      dagResult.errorMessage ?? null
    );
  }

  if (dagResult.status === 'failed') {
    return buildFallbackStepResult(
      step,
      'failed',
      dagResult.errorMessage ?? 'Step failed.',
      dagSummary.startedAt,
      dagSummary.completedAt,
      dagResult.output ?? null,
      dagResult.errorMessage ?? 'Step failed.'
    );
  }

  return buildFallbackStepResult(
    step,
    'completed',
    'Step completed.',
    dagSummary.startedAt,
    dagSummary.completedAt,
    dagResult.output ?? null
  );
}

async function buildSkippedDependencyResult(
  step: AgentPlannedCapabilityStep,
  executionId: string,
  failedDependencyStepId: string,
  traceRecorder: AgentExecutionTraceRecorder
): Promise<AgentCommandStepExecutionResult> {
  const now = new Date().toISOString();
  await traceRecorder.record('warn', 'agent.step.skipped', {
    executionId,
    stepId: step.stepId,
    capabilityId: step.capabilityId,
    blockedBy: failedDependencyStepId
  });

  return buildFallbackStepResult(
    step,
    'skipped',
    `Skipped because dependency "${failedDependencyStepId}" did not complete successfully.`,
    now,
    now
  );
}

/**
 * Create the capability-planner execution service.
 *
 * Purpose:
 * - Compose planning, command execution, DAG scheduling, and execution tracing into one reusable API surface.
 *
 * Inputs/outputs:
 * - Input: optional dependency overrides for tests and alternate runtimes.
 * - Output: service exposing `executeGoal`.
 *
 * Edge case behavior:
 * - Planning errors are allowed to throw so the HTTP layer can return explicit validation failures.
 */
export function createAgentExecutionService(
  dependencies: AgentExecutionServiceDependencies = {}
): {
  executeGoal(request: AgentGoalExecutionRequest): Promise<AgentGoalExecutionResponse>;
} {
  const commandExecutor = dependencies.commandExecutor ?? executeCommand;
  const createTraceRecorder = dependencies.createTraceRecorder ?? ((executionId: string, traceId: string) =>
    new AgentExecutionTraceRecorder(executionId, traceId));
  const createDagOrchestrator = dependencies.createDagOrchestrator ?? (() =>
    new DAGOrchestrator({
      jobQueue: new InProcessCapabilityDagJobQueue(),
      settings: {
        maxConcurrentNodes: 4,
        maxDepth: 8,
        maxChildrenPerNode: 8,
        maxRetries: 0,
        maxTokenBudgetPerDag: 100_000,
        nodeTimeoutMs: 60_000,
        pollIntervalMs: 1
      }
    }));

  return {
    async executeGoal(request: AgentGoalExecutionRequest): Promise<AgentGoalExecutionResponse> {
      const executionId = generateRequestId('agentexec');
      const traceId = request.traceId ?? generateRequestId('trace');
      const startedAt = new Date().toISOString();
      const traceRecorder = createTraceRecorder(executionId, traceId);
      const plan = planGoalExecution(request);

      await traceRecorder.record('info', 'agent.execution.started', {
        executionId,
        goal: request.goal,
        requestedExecutionMode: request.executionMode ?? 'auto',
        resolvedExecutionMode: plan.executionMode,
        capabilityIds: plan.selectedCapabilityIds
      });
      await traceRecorder.record('info', 'agent.execution.planned', {
        executionId,
        planId: plan.planId,
        stepCount: plan.steps.length
      });

      let stepResults: AgentCommandStepExecutionResult[];
      let dagSummary: AgentDagExecutionSummary | null = null;

      if (plan.executionMode === 'dag') {
        const orchestrator = createDagOrchestrator();
        const dagGraph = compilePlanToDagGraph(
          executionId,
          traceId,
          plan,
          commandExecutor,
          traceRecorder
        );
        const observer: DAGRunObserver = {
          onNodeQueued: (payload: NonNullable<DAGRunObserver['onNodeQueued']> extends (arg: infer T) => void ? T : never) => {
            void traceRecorder.record('info', 'agent.dag.node.queued', payload);
          },
          onNodeStarted: (payload: NonNullable<DAGRunObserver['onNodeStarted']> extends (arg: infer T) => void ? T : never) => {
            void traceRecorder.record('info', 'agent.dag.node.started', payload);
          },
          onNodeCompleted: (payload: NonNullable<DAGRunObserver['onNodeCompleted']> extends (arg: infer T) => void ? T : never) => {
            void traceRecorder.record('info', 'agent.dag.node.completed', {
              dagId: payload.dagId,
              nodeId: payload.nodeId,
              jobId: payload.jobId,
              completedAt: payload.completedAt,
              status: payload.result.status
            });
          },
          onNodeFailed: (payload: NonNullable<DAGRunObserver['onNodeFailed']> extends (arg: infer T) => void ? T : never) => {
            void traceRecorder.record('warn', 'agent.dag.node.failed', {
              dagId: payload.dagId,
              nodeId: payload.nodeId,
              jobId: payload.jobId,
              completedAt: payload.completedAt,
              error: payload.result.errorMessage ?? null,
              willRetry: payload.willRetry
            });
          },
          onNodeSkipped: (payload: NonNullable<DAGRunObserver['onNodeSkipped']> extends (arg: infer T) => void ? T : never) => {
            void traceRecorder.record('warn', 'agent.dag.node.skipped', payload);
          }
        };

        const summary = await orchestrator.runGraph(dagGraph, {
          dagId: `${executionId}-dag`,
          sharedState: {
            sessionId: request.sessionId ?? executionId,
            ...(request.sharedState ?? {})
          },
          observer
        });

        dagSummary = mapDagSummary(summary);
        stepResults = plan.steps.map(step => normalizeDagStepResult(step, summary));
      } else {
        const completedStepResults = new Map<string, AgentCommandStepExecutionResult>();
        stepResults = [];

        for (const step of plan.steps) {
          const failedDependency = step.dependsOnStepIds.find(dependencyStepId => {
            const dependencyResult = completedStepResults.get(dependencyStepId);
            return dependencyResult && dependencyResult.status !== 'completed';
          });

          if (failedDependency) {
            const skippedResult = await buildSkippedDependencyResult(step, executionId, failedDependency, traceRecorder);
            completedStepResults.set(step.stepId, skippedResult);
            stepResults.push(skippedResult);
            continue;
          }

          const stepResult = await executePlannedCommandStep(
            step,
            commandExecutor,
            traceRecorder,
            executionId,
            traceId
          );
          completedStepResults.set(step.stepId, stepResult);
          stepResults.push(stepResult);
        }
      }

      const completedAt = new Date().toISOString();
      const executionStatus = stepResults.every(stepResult => stepResult.status === 'completed')
        ? 'completed'
        : 'failed';

      await traceRecorder.record(executionStatus === 'completed' ? 'info' : 'warn', 'agent.execution.completed', {
        executionId,
        status: executionStatus,
        stepCount: stepResults.length,
        dagMode: plan.executionMode === 'dag'
      });

      return {
        executionId,
        traceId,
        goal: request.goal,
        planner: {
          planId: plan.planId,
          executionMode: plan.executionMode,
          selectedCapabilityIds: [...plan.selectedCapabilityIds],
          steps: plan.steps.map(step => ({
            stepId: step.stepId,
            capabilityId: step.capabilityId,
            reason: step.reason,
            dependsOnStepIds: [...step.dependsOnStepIds],
            capabilityPayload: {
              ...step.capabilityPayload
            }
          }))
        },
        execution: {
          status: executionStatus,
          startedAt,
          completedAt,
          steps: stepResults,
          dagSummary,
          finalOutput: buildFinalOutput(stepResults)
        },
        logs: traceRecorder.snapshot()
      };
    }
  };
}

export const agentExecutionService = createAgentExecutionService();
