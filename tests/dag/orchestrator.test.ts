import { describe, expect, it, jest } from '@jest/globals';
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
  DagJobCancellationResult,
  DagJobQueue,
  EnqueueDagNodeJobRequest,
  WaitForDagJobCompletionOptions
} from '../../src/jobs/jobQueue.js';
import type { DagQueueJobRecord } from '../../src/jobs/jobSchema.js';

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise
  };
}

function buildQueueRecord(
  nodeId: string,
  status: DagQueueJobRecord['status'],
  overrides: Partial<DagQueueJobRecord> = {}
): DagQueueJobRecord {
  const queuedAt = '2026-07-27T12:00:00.000Z';
  return {
    jobId: `job-${nodeId}`,
    dagId: 'dag-cancellation-test',
    nodeId,
    status,
    workerId: status === 'running' ? 'dag-worker-1' : null,
    retries: 0,
    maxRetries: 2,
    waitingTimeoutMs: 5_000,
    payload: {},
    node: {
      id: nodeId,
      type: 'agent',
      dependencies: [],
      executionKey: `${nodeId}.agent`
    },
    dependencyResults: {},
    sharedState: {},
    depth: 0,
    output: null,
    errorMessage: null,
    timestamps: {
      queuedAt,
      updatedAt: queuedAt
    },
    ...overrides
  };
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
      workerId: null,
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

  async requestDagJobCancellation(
    _jobId: string,
    _reason?: string
  ): Promise<DagJobCancellationResult> {
    return {
      outcome: 'not_found',
      record: null
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
        workerId: null,
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
        workerId: null,
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

  it('retries a transient planner failure and continues the DAG once planner recovers', async () => {
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

    let plannerAttempts = 0;

    const graph: DAGGraph = {
      id: 'dag-planner-retry-path',
      nodes: {
        planner: createExecutableNode('planner', [], async () => {
          plannerAttempts += 1;

          if (plannerAttempts === 1) {
            return createDagFailureResult(
              'planner',
              'Request was aborted.',
              { errorMessage: 'Request was aborted.' },
              { retryable: true }
            );
          }

          return createDagSuccessResult('planner', { outline: 'plan ready' });
        }),
        research: createExecutableNode('research', ['planner'], async () =>
          createDagSuccessResult('research', { ok: true })
        ),
        writer: createExecutableNode('writer', ['research'], async context =>
          createDagSuccessResult('writer', {
            upstreamStatus: context.dependencyResults.research?.status ?? 'missing'
          })
        )
      },
      edges: [
        { from: 'planner', to: 'research' },
        { from: 'research', to: 'writer' }
      ],
      entrypoints: ['planner']
    };

    const summary = await orchestrator.runGraph(graph);

    expect(summary.status).toBe('success');
    expect(plannerAttempts).toBe(2);
    expect(summary.failedNodeIds).toEqual([]);
    expect(summary.skippedNodeIds).toEqual([]);
    expect(summary.resultsByNodeId.writer?.status).toBe('success');
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

  it('fails the DAG cleanly when planner transient failures exhaust retries', async () => {
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

    let plannerAttempts = 0;

    const graph: DAGGraph = {
      id: 'dag-planner-final-failure',
      nodes: {
        planner: createExecutableNode('planner', [], async () => {
          plannerAttempts += 1;
          return createDagFailureResult(
            'planner',
            'Planner DAG node timed out after 90000ms',
            { errorMessage: 'Planner DAG node timed out after 90000ms' },
            { retryable: true }
          );
        }),
        research: createExecutableNode('research', ['planner'], async () =>
          createDagSuccessResult('research', { ok: true })
        ),
        writer: createExecutableNode('writer', ['research'], async () =>
          createDagSuccessResult('writer', { ok: true })
        )
      },
      edges: [
        { from: 'planner', to: 'research' },
        { from: 'research', to: 'writer' }
      ],
      entrypoints: ['planner']
    };

    const summary = await orchestrator.runGraph(graph);

    expect(summary.status).toBe('failed');
    expect(plannerAttempts).toBe(3);
    expect(summary.failedNodeIds).toEqual(['planner']);
    expect(summary.skippedNodeIds).toEqual(['research', 'writer']);
    expect(summary.resultsByNodeId.research?.status).toBe('skipped');
    expect(summary.resultsByNodeId.writer?.status).toBe('skipped');
  });

  it('does not retry non-retryable planner validation failures', async () => {
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

    let plannerAttempts = 0;

    const graph: DAGGraph = {
      id: 'dag-planner-non-retryable',
      nodes: {
        planner: createExecutableNode('planner', [], async () => {
          plannerAttempts += 1;
          return createDagFailureResult(
            'planner',
            'Validation error: missing planner input.',
            { errorMessage: 'Validation error: missing planner input.' },
            { retryable: false }
          );
        }),
        research: createExecutableNode('research', ['planner'], async () =>
          createDagSuccessResult('research', { ok: true })
        ),
        writer: createExecutableNode('writer', ['research'], async () =>
          createDagSuccessResult('writer', { ok: true })
        )
      },
      edges: [
        { from: 'planner', to: 'research' },
        { from: 'research', to: 'writer' }
      ],
      entrypoints: ['planner']
    };

    const summary = await orchestrator.runGraph(graph);

    expect(summary.status).toBe('failed');
    expect(plannerAttempts).toBe(1);
    expect(summary.failedNodeIds).toEqual(['planner']);
    expect(summary.skippedNodeIds).toEqual(['research', 'writer']);
    expect(summary.resultsByNodeId.research?.status).toBe('skipped');
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

  it('treats a cancelled queue row as terminal and never retries the node', async () => {
    const enqueueRequests: EnqueueDagNodeJobRequest[] = [];
    const cancellationRequests: Array<{ jobId: string; reason?: string }> = [];
    const onNodeCancelled = jest.fn();
    const onNodeRetried = jest.fn();
    const queue: DagJobQueue = {
      async enqueueDagNodeJob(request) {
        enqueueRequests.push(request);
        return buildQueueRecord(request.node.id, 'queued', {
          dagId: request.dagId,
          maxRetries: request.maxRetries ?? 2
        });
      },
      async requestDagJobCancellation(jobId, reason) {
        cancellationRequests.push({ jobId, reason });
        return {
          outcome: 'already_terminal',
          record: buildQueueRecord('planner', 'cancelled', {
            jobId,
            errorMessage: 'Cancelled by the queue worker.'
          })
        };
      },
      async waitForDagJobCompletion(jobId) {
        return buildQueueRecord('planner', 'cancelled', {
          jobId,
          errorMessage: 'Cancelled by the queue worker.',
          timestamps: {
            queuedAt: '2026-07-27T12:00:00.000Z',
            updatedAt: '2026-07-27T12:00:01.000Z',
            completedAt: '2026-07-27T12:00:01.000Z'
          }
        });
      }
    };
    const orchestrator = new DAGOrchestrator({
      jobQueue: queue,
      settings: {
        maxConcurrentNodes: 2,
        maxDepth: 2,
        maxChildrenPerNode: 2,
        maxRetries: 2,
        maxTokenBudgetPerDag: 1000,
        nodeTimeoutMs: 5_000,
        pollIntervalMs: 1
      }
    });
    const graph: DAGGraph = {
      id: 'dag-cancelled-terminal',
      nodes: {
        planner: createExecutableNode('planner', [], async () =>
          createDagSuccessResult('planner', { unused: true })
        )
      },
      edges: [],
      entrypoints: ['planner']
    };

    const summary = await orchestrator.runGraph(graph, {
      observer: {
        onNodeCancelled,
        onNodeRetried
      }
    });

    expect(summary.status).toBe('cancelled');
    expect(summary.cancelledNodeIds).toEqual(['planner']);
    expect(summary.failedNodeIds).toEqual([]);
    expect(summary.totalRetries).toBe(0);
    expect(enqueueRequests).toHaveLength(1);
    expect(cancellationRequests).toEqual([]);
    expect(onNodeRetried).not.toHaveBeenCalled();
    expect(onNodeCancelled).toHaveBeenCalledTimes(1);
    expect(onNodeCancelled).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: 'planner',
      reason: 'Cancelled by the queue worker.'
    }));
  });

  it('stops scheduling after abort during the first enqueue and waits for its terminal cancellation row', async () => {
    const enqueueDeferred = createDeferred<DagQueueJobRecord>();
    const waiterStarted = createDeferred<void>();
    const terminalDeferred = createDeferred<DagQueueJobRecord>();
    const enqueueRequests: EnqueueDagNodeJobRequest[] = [];
    const cancellationRequests: Array<{ jobId: string; reason?: string }> = [];
    const cancellationEvents: string[] = [];
    const queue: DagJobQueue = {
      async enqueueDagNodeJob(request) {
        enqueueRequests.push(request);
        return enqueueDeferred.promise;
      },
      async requestDagJobCancellation(jobId, reason) {
        cancellationRequests.push({ jobId, reason });
        return {
          outcome: 'cancellation_requested',
          record: buildQueueRecord('first', 'running', { jobId })
        };
      },
      async waitForDagJobCompletion() {
        waiterStarted.resolve(undefined);
        return terminalDeferred.promise;
      }
    };
    const orchestrator = new DAGOrchestrator({
      jobQueue: queue,
      settings: {
        maxConcurrentNodes: 3,
        maxDepth: 2,
        maxChildrenPerNode: 2,
        maxRetries: 2,
        maxTokenBudgetPerDag: 1000,
        nodeTimeoutMs: 5_000,
        pollIntervalMs: 1
      }
    });
    const graph: DAGGraph = {
      id: 'dag-abort-during-enqueue',
      nodes: {
        first: createExecutableNode('first', [], async () =>
          createDagSuccessResult('first', { unused: true })
        ),
        second: createExecutableNode('second', [], async () =>
          createDagSuccessResult('second', { unused: true })
        )
      },
      edges: [],
      entrypoints: ['first', 'second']
    };
    const abortController = new AbortController();
    let runSettled = false;
    const runPromise = orchestrator.runGraph(graph, {
      abortSignal: abortController.signal,
      observer: {
        onNodeCancelled: event => {
          cancellationEvents.push(event.nodeId);
        }
      }
    });
    void runPromise.then(
      () => {
        runSettled = true;
      },
      () => {
        runSettled = true;
      }
    );

    expect(enqueueRequests.map(request => request.node.id)).toEqual(['first']);
    abortController.abort(new Error('Stop the DAG while enqueue is pending.'));
    enqueueDeferred.resolve(buildQueueRecord('first', 'queued'));
    await waiterStarted.promise;

    expect(enqueueRequests.map(request => request.node.id)).toEqual(['first']);
    expect(cancellationRequests).toEqual([{
      jobId: 'job-first',
      reason: 'Stop the DAG while enqueue is pending.'
    }]);
    expect(runSettled).toBe(false);

    terminalDeferred.resolve(buildQueueRecord('first', 'cancelled', {
      errorMessage: 'Stop the DAG while enqueue is pending.',
      timestamps: {
        queuedAt: '2026-07-27T12:00:00.000Z',
        updatedAt: '2026-07-27T12:00:01.000Z',
        completedAt: '2026-07-27T12:00:01.000Z'
      }
    }));
    const summary = await runPromise;

    expect(summary.status).toBe('cancelled');
    expect(summary.cancelledNodeIds).toEqual(['first', 'second']);
    expect(cancellationEvents.filter(nodeId => nodeId === 'first')).toHaveLength(1);
    expect(cancellationEvents.filter(nodeId => nodeId === 'second')).toHaveLength(1);
  });

  it('reports each unscheduled node cancelled once when abort races with an enqueue rejection', async () => {
    const enqueueDeferred = createDeferred<DagQueueJobRecord>();
    const cancellationEvents: string[] = [];
    const cancellationRequests: string[] = [];
    const queue: DagJobQueue = {
      async enqueueDagNodeJob() {
        return enqueueDeferred.promise;
      },
      async requestDagJobCancellation(jobId) {
        cancellationRequests.push(jobId);
        return {
          outcome: 'not_found',
          record: null
        };
      },
      async waitForDagJobCompletion() {
        throw new Error('No job should be returned from the rejected enqueue.');
      }
    };
    const orchestrator = new DAGOrchestrator({
      jobQueue: queue,
      settings: {
        maxConcurrentNodes: 3,
        maxDepth: 2,
        maxChildrenPerNode: 2,
        maxRetries: 2,
        maxTokenBudgetPerDag: 1000,
        nodeTimeoutMs: 5_000,
        pollIntervalMs: 1
      }
    });
    const graph: DAGGraph = {
      id: 'dag-abort-enqueue-rejection',
      nodes: {
        first: createExecutableNode('first', [], async () =>
          createDagSuccessResult('first', { unused: true })
        ),
        second: createExecutableNode('second', [], async () =>
          createDagSuccessResult('second', { unused: true })
        )
      },
      edges: [],
      entrypoints: ['first', 'second']
    };
    const abortController = new AbortController();
    const runPromise = orchestrator.runGraph(graph, {
      abortSignal: abortController.signal,
      observer: {
        onNodeCancelled: event => {
          cancellationEvents.push(event.nodeId);
        }
      }
    });

    abortController.abort(new Error('Abort before enqueue persistence completes.'));
    enqueueDeferred.reject(new Error('Queue persistence rejected.'));

    await expect(runPromise).rejects.toThrow('Queue persistence rejected.');
    expect(cancellationEvents.filter(nodeId => nodeId === 'first')).toHaveLength(1);
    expect(cancellationEvents.filter(nodeId => nodeId === 'second')).toHaveLength(1);
    expect(cancellationRequests).toEqual([]);
  });

  it('cancels all registered jobs and consumes remaining waiter rejections when one waiter fails', async () => {
    const firstWaiter = createDeferred<DagQueueJobRecord>();
    const secondWaiter = createDeferred<DagQueueJobRecord>();
    const bothWaitersRegistered = createDeferred<void>();
    const cancellationRequests: string[] = [];
    const waiterJobIds: string[] = [];
    let secondWaiterSettled = false;
    const queue: DagJobQueue = {
      async enqueueDagNodeJob(request) {
        return buildQueueRecord(request.node.id, 'queued', {
          dagId: request.dagId
        });
      },
      async requestDagJobCancellation(jobId) {
        cancellationRequests.push(jobId);
        if (jobId === 'job-second') {
          secondWaiter.reject(new Error('Second waiter also rejected.'));
        }
        return {
          outcome: 'cancellation_requested',
          record: buildQueueRecord(
            jobId === 'job-first' ? 'first' : 'second',
            'running',
            { jobId }
          )
        };
      },
      async waitForDagJobCompletion(jobId) {
        waiterJobIds.push(jobId);
        if (waiterJobIds.length === 2) {
          bothWaitersRegistered.resolve(undefined);
        }
        if (jobId === 'job-first') {
          return firstWaiter.promise;
        }
        return secondWaiter.promise.finally(() => {
          secondWaiterSettled = true;
        });
      }
    };
    const orchestrator = new DAGOrchestrator({
      jobQueue: queue,
      settings: {
        maxConcurrentNodes: 2,
        maxDepth: 2,
        maxChildrenPerNode: 2,
        maxRetries: 2,
        maxTokenBudgetPerDag: 1000,
        nodeTimeoutMs: 5_000,
        pollIntervalMs: 1
      }
    });
    const graph: DAGGraph = {
      id: 'dag-waiter-rejection',
      nodes: {
        first: createExecutableNode('first', [], async () =>
          createDagSuccessResult('first', { unused: true })
        ),
        second: createExecutableNode('second', [], async () =>
          createDagSuccessResult('second', { unused: true })
        )
      },
      edges: [],
      entrypoints: ['first', 'second']
    };
    const runPromise = orchestrator.runGraph(graph);

    await bothWaitersRegistered.promise;
    firstWaiter.reject(new Error('First waiter rejected.'));

    await expect(runPromise).rejects.toThrow('First waiter rejected.');
    expect(waiterJobIds).toEqual(['job-first', 'job-second']);
    expect(cancellationRequests).toEqual(['job-first', 'job-second']);
    expect(secondWaiterSettled).toBe(true);
  });

  it('captures an early waiter rejection while a later enqueue is pending and rethrows it after cleanup', async () => {
    const secondEnqueueStarted = createDeferred<void>();
    const secondEnqueue = createDeferred<DagQueueJobRecord>();
    const firstWaiter = createDeferred<DagQueueJobRecord>();
    const secondWaiter = createDeferred<DagQueueJobRecord>();
    const waiterError = new Error('First waiter rejected during the second enqueue.');
    const cancellationRequests: string[] = [];
    const unhandledReasons: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledReasons.push(reason);
    };
    const queue: DagJobQueue = {
      async enqueueDagNodeJob(request) {
        if (request.node.id === 'first') {
          return buildQueueRecord('first', 'queued', {
            dagId: request.dagId
          });
        }
        secondEnqueueStarted.resolve(undefined);
        return secondEnqueue.promise;
      },
      async requestDagJobCancellation(jobId) {
        cancellationRequests.push(jobId);
        if (jobId === 'job-second') {
          secondWaiter.resolve(buildQueueRecord('second', 'cancelled', {
            jobId,
            errorMessage: 'Cancelled during waiter cleanup.'
          }));
        }
        return {
          outcome: 'cancellation_requested',
          record: buildQueueRecord(
            jobId === 'job-first' ? 'first' : 'second',
            'running',
            { jobId }
          )
        };
      },
      async waitForDagJobCompletion(jobId) {
        return jobId === 'job-first'
          ? firstWaiter.promise
          : secondWaiter.promise;
      }
    };
    const orchestrator = new DAGOrchestrator({
      jobQueue: queue,
      settings: {
        maxConcurrentNodes: 2,
        maxDepth: 2,
        maxChildrenPerNode: 2,
        maxRetries: 2,
        maxTokenBudgetPerDag: 1000,
        nodeTimeoutMs: 5_000,
        pollIntervalMs: 1
      }
    });
    const graph: DAGGraph = {
      id: 'dag-waiter-rejects-during-enqueue',
      nodes: {
        first: createExecutableNode('first', [], async () =>
          createDagSuccessResult('first', { unused: true })
        ),
        second: createExecutableNode('second', [], async () =>
          createDagSuccessResult('second', { unused: true })
        )
      },
      edges: [],
      entrypoints: ['first', 'second']
    };

    process.on('unhandledRejection', onUnhandledRejection);
    try {
      const runPromise = orchestrator.runGraph(graph);
      await secondEnqueueStarted.promise;

      firstWaiter.reject(waiterError);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(unhandledReasons).toEqual([]);

      secondEnqueue.resolve(buildQueueRecord('second', 'queued'));

      await expect(runPromise).rejects.toBe(waiterError);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(cancellationRequests).toEqual(['job-first', 'job-second']);
      expect(unhandledReasons).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});
