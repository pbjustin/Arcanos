import { describe, expect, it } from '@jest/globals';
import {
  createDagFailureResult,
  createDagSuccessResult,
  type DAGNode,
  type DAGNodeExecutionContext,
  type DAGResult,
  stripDagNodeExecutor
} from '../../src/dag/dagNode.js';
import { DAGOrchestrator } from '../../src/dag/orchestrator.js';
import type { DAGGraph } from '../../src/dag/dagGraph.js';
import type {
  DagJobQueue,
  EnqueueDagNodeJobRequest,
  WaitForDagJobCompletionOptions
} from '../../src/jobs/jobQueue.js';
import type { DagQueueJobRecord } from '../../src/jobs/jobSchema.js';

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

class InMemoryDagJobQueue implements DagJobQueue {
  private jobCounter = 0;

  private readonly jobsById = new Map<string, Promise<DagQueueJobRecord>>();

  async enqueueDagNodeJob(request: EnqueueDagNodeJobRequest): Promise<DagQueueJobRecord> {
    const jobId = `job-${++this.jobCounter}`;
    const queuedAt = new Date().toISOString();

    const completionPromise = this.executeQueuedNode(jobId, request, queuedAt);
    this.jobsById.set(jobId, completionPromise);

    return {
      jobId,
      dagId: request.dagId,
      nodeId: request.node.id,
      status: 'queued',
      retries: request.attempt ?? 0,
      maxRetries: request.maxRetries ?? 2,
      waitingTimeoutMs: request.waitingTimeoutMs ?? 60000,
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

  async waitForDagJobCompletion(
    jobId: string,
    _options: WaitForDagJobCompletionOptions = {}
  ): Promise<DagQueueJobRecord> {
    const completionPromise = this.jobsById.get(jobId);
    if (!completionPromise) {
      throw new Error(`Unknown in-memory DAG job "${jobId}".`);
    }

    return completionPromise;
  }

  private async executeQueuedNode(
    jobId: string,
    request: EnqueueDagNodeJobRequest,
    queuedAt: string
  ): Promise<DagQueueJobRecord> {
    const updatedAt = new Date().toISOString();
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
      //audit Assumption: in-memory test jobs should execute directly from the node definition; failure risk: fake queue masks missing runtime handlers; expected invariant: test nodes provide `execute`; handling strategy: fail the fake job explicitly when absent.
      if (!request.node.execute) {
        throw new Error(`Test DAG node "${request.node.id}" is missing an execute function.`);
      }

      const output = await request.node.execute(executionContext);
      const completedAt = new Date().toISOString();

      return {
        jobId,
        dagId: request.dagId,
        nodeId: request.node.id,
        status: output.status === 'failed' ? 'failed' : 'completed',
        retries: request.attempt ?? 0,
        maxRetries: request.maxRetries ?? 2,
        waitingTimeoutMs: request.waitingTimeoutMs ?? 60000,
        payload: { ...(request.payload ?? {}) },
        node: stripDagNodeExecutor(request.node),
        dependencyResults: { ...(request.dependencyResults ?? {}) },
        sharedState: { ...(request.sharedState ?? {}) },
        depth: request.depth,
        output,
        errorMessage: output.errorMessage ?? null,
        timestamps: {
          queuedAt,
          updatedAt,
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
        retries: request.attempt ?? 0,
        maxRetries: request.maxRetries ?? 2,
        waitingTimeoutMs: request.waitingTimeoutMs ?? 60000,
        payload: { ...(request.payload ?? {}) },
        node: stripDagNodeExecutor(request.node),
        dependencyResults: { ...(request.dependencyResults ?? {}) },
        sharedState: { ...(request.sharedState ?? {}) },
        depth: request.depth,
        output: null,
        errorMessage,
        timestamps: {
          queuedAt,
          updatedAt,
          completedAt
        }
      };
    }
  }
}

function createExecutableNode(
  nodeId: string,
  dependencies: string[],
  execute: (context: DAGNodeExecutionContext) => Promise<DAGResult>,
  executionKey: string = `${nodeId}.agent`
): DAGNode {
  return {
    id: nodeId,
    type: 'agent',
    dependencies,
    executionKey,
    execute
  };
}

describe('DAGOrchestrator', () => {
  it('runs a planner -> parallel agents -> writer pipeline with dependency gating', async () => {
    const queue = new InMemoryDagJobQueue();
    const orchestrator = new DAGOrchestrator({
      jobQueue: queue,
      settings: {
        maxConcurrentNodes: 3,
        maxDepth: 3,
        maxChildrenPerNode: 5,
        maxRetries: 2,
        maxTokenBudgetPerDag: 1000,
        nodeTimeoutMs: 5000,
        pollIntervalMs: 1
      }
    });

    let activeParallelNodes = 0;
    let maxParallelNodes = 0;

    const graph: DAGGraph = {
      id: 'dag-happy-path',
      nodes: {
        planner: createExecutableNode('planner', [], async () => {
          await sleep(5);
          return createDagSuccessResult('planner', { outline: 'plan ready' }, { tokenUsage: 10 });
        }),
        research: createExecutableNode('research', ['planner'], async () => {
          activeParallelNodes += 1;
          maxParallelNodes = Math.max(maxParallelNodes, activeParallelNodes);
          await sleep(20);
          activeParallelNodes -= 1;
          return createDagSuccessResult('research', { content: 'research findings' }, { tokenUsage: 15 });
        }),
        build: createExecutableNode('build', ['planner'], async () => {
          activeParallelNodes += 1;
          maxParallelNodes = Math.max(maxParallelNodes, activeParallelNodes);
          await sleep(20);
          activeParallelNodes -= 1;
          return createDagSuccessResult('build', { artifact: 'build output' }, { tokenUsage: 20 });
        }),
        audit: createExecutableNode('audit', ['planner'], async () => {
          activeParallelNodes += 1;
          maxParallelNodes = Math.max(maxParallelNodes, activeParallelNodes);
          await sleep(20);
          activeParallelNodes -= 1;
          return createDagSuccessResult('audit', { verdict: 'clean' }, { tokenUsage: 12 });
        }),
        writer: createExecutableNode('writer', ['research', 'build', 'audit'], async context => {
          const dependencyNodeIds = Object.keys(context.dependencyResults).sort();
          return createDagSuccessResult('writer', {
            mergedDependencies: dependencyNodeIds,
            final: 'combined answer'
          }, { tokenUsage: 8 });
        })
      },
      edges: [
        { from: 'planner', to: 'research' },
        { from: 'planner', to: 'build' },
        { from: 'planner', to: 'audit' },
        { from: 'research', to: 'writer' },
        { from: 'build', to: 'writer' },
        { from: 'audit', to: 'writer' }
      ],
      entrypoints: ['planner']
    };

    const summary = await orchestrator.runGraph(graph);

    expect(summary.status).toBe('success');
    expect(summary.failedNodeIds).toEqual([]);
    expect(summary.skippedNodeIds).toEqual([]);
    expect(maxParallelNodes).toBe(3);
    expect(summary.resultsByNodeId.writer?.status).toBe('success');
    expect(summary.resultsByNodeId.writer?.output).toEqual({
      mergedDependencies: ['audit', 'build', 'research'],
      final: 'combined answer'
    });
    expect(summary.tokenBudgetUsed).toBe(65);
  });

  it('retries a transient node failure up to the configured retry cap', async () => {
    const queue = new InMemoryDagJobQueue();
    const orchestrator = new DAGOrchestrator({
      jobQueue: queue,
      settings: {
        maxConcurrentNodes: 2,
        maxDepth: 3,
        maxChildrenPerNode: 5,
        maxRetries: 2,
        maxTokenBudgetPerDag: 1000,
        nodeTimeoutMs: 5000,
        pollIntervalMs: 1
      }
    });

    let researchAttempts = 0;

    const graph: DAGGraph = {
      id: 'dag-retry-path',
      nodes: {
        planner: createExecutableNode('planner', [], async () => createDagSuccessResult('planner', { ok: true })),
        research: createExecutableNode('research', ['planner'], async () => {
          researchAttempts += 1;

          //audit Assumption: the first attempt should simulate a transient failure; failure risk: retry behavior is never exercised in the unit test; expected invariant: the second attempt succeeds; handling strategy: fail once, then return success.
          if (researchAttempts === 1) {
            return createDagFailureResult('research', 'transient research failure');
          }

          return createDagSuccessResult('research', { ok: true }, { tokenUsage: 5 });
        }),
        writer: createExecutableNode('writer', ['research'], async context => {
          return createDagSuccessResult('writer', {
            upstreamStatus: context.dependencyResults.research?.status ?? 'missing'
          });
        })
      },
      edges: [
        { from: 'planner', to: 'research' },
        { from: 'research', to: 'writer' }
      ],
      entrypoints: ['planner']
    };

    const summary = await orchestrator.runGraph(graph);

    expect(summary.status).toBe('success');
    expect(researchAttempts).toBe(2);
    expect(summary.failedNodeIds).toEqual([]);
    expect(summary.resultsByNodeId.writer?.status).toBe('success');
    expect(summary.resultsByNodeId.writer?.output).toEqual({ upstreamStatus: 'success' });
  });

  it('skips downstream nodes when a dependency fails after retries are exhausted', async () => {
    const queue = new InMemoryDagJobQueue();
    const orchestrator = new DAGOrchestrator({
      jobQueue: queue,
      settings: {
        maxConcurrentNodes: 2,
        maxDepth: 3,
        maxChildrenPerNode: 5,
        maxRetries: 1,
        maxTokenBudgetPerDag: 1000,
        nodeTimeoutMs: 5000,
        pollIntervalMs: 1
      }
    });

    let buildAttempts = 0;

    const graph: DAGGraph = {
      id: 'dag-failure-path',
      nodes: {
        planner: createExecutableNode('planner', [], async () => createDagSuccessResult('planner', { ok: true })),
        build: createExecutableNode('build', ['planner'], async () => {
          buildAttempts += 1;
          return createDagFailureResult('build', 'build step failed permanently');
        }),
        audit: createExecutableNode('audit', ['planner'], async () => createDagSuccessResult('audit', { ok: true })),
        writer: createExecutableNode('writer', ['build', 'audit'], async context => {
          return createDagSuccessResult('writer', {
            dependencies: Object.keys(context.dependencyResults)
          });
        })
      },
      edges: [
        { from: 'planner', to: 'build' },
        { from: 'planner', to: 'audit' },
        { from: 'build', to: 'writer' },
        { from: 'audit', to: 'writer' }
      ],
      entrypoints: ['planner']
    };

    const summary = await orchestrator.runGraph(graph);

    expect(summary.status).toBe('failed');
    expect(buildAttempts).toBe(2);
    expect(summary.failedNodeIds).toEqual(['build']);
    expect(summary.skippedNodeIds).toEqual(['writer']);
    expect(summary.resultsByNodeId.audit?.status).toBe('success');
    expect(summary.resultsByNodeId.writer?.status).toBe('skipped');
  });

  it('rejects graphs that exceed the configured max depth', async () => {
    const queue = new InMemoryDagJobQueue();
    const orchestrator = new DAGOrchestrator({
      jobQueue: queue,
      settings: {
        maxConcurrentNodes: 1,
        maxDepth: 2,
        maxChildrenPerNode: 5,
        maxRetries: 0,
        maxTokenBudgetPerDag: 1000,
        nodeTimeoutMs: 5000,
        pollIntervalMs: 1
      }
    });

    const graph: DAGGraph = {
      id: 'dag-depth-guard',
      nodes: {
        planner: createExecutableNode('planner', [], async () => createDagSuccessResult('planner', { ok: true })),
        research: createExecutableNode('research', ['planner'], async () => createDagSuccessResult('research', { ok: true })),
        build: createExecutableNode('build', ['research'], async () => createDagSuccessResult('build', { ok: true })),
        writer: createExecutableNode('writer', ['build'], async () => createDagSuccessResult('writer', { ok: true }))
      },
      edges: [
        { from: 'planner', to: 'research' },
        { from: 'research', to: 'build' },
        { from: 'build', to: 'writer' }
      ],
      entrypoints: ['planner']
    };

    await expect(orchestrator.runGraph(graph)).rejects.toThrow('maxDepth=2');
  });
});
