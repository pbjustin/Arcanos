import { describe, expect, it, jest } from '@jest/globals';
import { dagAgentManager } from '../src/agents/agentManager.js';
import { instrumentOpenAIOperation } from '../src/core/adapters/openai.adapter.js';
import type { JobData } from '../src/core/db/schema.js';
import type { DAGGraph } from '../src/dag/dagGraph.js';
import type { DAGResult } from '../src/dag/dagNode.js';
import type { DagArtifactStore } from '../src/dag/artifactStore.js';
import { DAGOrchestrator, type DAGRunObserver } from '../src/dag/orchestrator.js';
import type {
  DagJobCancellationResult,
  DagJobQueue,
  EnqueueDagNodeJobRequest,
  WaitForDagJobCompletionOptions
} from '../src/jobs/jobQueue.js';
import {
  buildDagNodeJobInput,
  buildDagQueueJobRecord,
  parseDagNodeJobInput,
  type DagQueueJobRecord
} from '../src/jobs/jobSchema.js';
import { createDagMetricsRecorder } from '../src/utils/metrics.js';
import { runDagNodeJob, type DagTaskRunnerDependencies } from '../src/workers/taskRunners.js';
import { createDagNodeRunPromptBridge } from '../src/workers/dagNodePromptBridge.js';
import { runWithDagChildAccounting } from '../src/workers/dagChildAccounting.js';
import { sanitizeGptAccessPayload } from '../src/services/gptAccessSanitization.js';
import { buildGptJobResultLookupPayload } from '../src/shared/gpt/gptJobResult.js';

const logger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
};

function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// Only provider transport is synthetic: production instrumentation observes each
// raw usage response while the real worker and orchestrator own accounting.
async function providerStage(totalTokens: number): Promise<void> {
  await instrumentOpenAIOperation({
    operation: 'responses_create',
    model: 'synthetic-dag-accounting',
    callback: async () => ({
      usage: { input_tokens: totalTokens, output_tokens: 0, total_tokens: totalTokens }
    })
  });
}

function publicOutput(finalTokens: number, cumulativeSessionTokens = 900): unknown {
  return {
    result: 'Synthetic answer',
    meta: { tokens: { total_tokens: finalTokens } },
    guardInfo: { sessionTokensUsed: cumulativeSessionTokens }
  };
}

class WorkerBoundaryQueue implements DagJobQueue {
  readonly requests: EnqueueDagNodeJobRequest[] = [];
  readonly terminalRecords: DagQueueJobRecord[] = [];
  readonly terminalObservationCounts = new Map<string, number>();
  private readonly rows = new Map<string, JobData>();
  private readonly artifacts = new Map<string, unknown>();
  private readonly artifactStore: DagArtifactStore = {
    writeArtifact: async request => {
      const reference = `${request.runId}/${request.nodeId}/${request.attempt}`;
      this.artifacts.set(reference, jsonRoundTrip(request.payload));
      return reference;
    },
    readArtifact: async <T>(reference: string): Promise<T> => {
      if (!this.artifacts.has(reference)) {
        throw new Error(`Unknown test artifact: ${reference}`);
      }
      return jsonRoundTrip(this.artifacts.get(reference)) as T;
    }
  };

  constructor(
    private readonly runPrompt: DagTaskRunnerDependencies['runPrompt'],
    private readonly terminalObservations = 1,
    private readonly persistedResultTransform?: (result: DAGResult) => DAGResult
  ) {}

  async enqueueDagNodeJob(request: EnqueueDagNodeJobRequest): Promise<DagQueueJobRecord> {
    this.requests.push(request);
    const timestamp = new Date('2026-09-21T12:00:00.000Z');
    const row = {
      id: `accounting-job-${this.requests.length}`,
      worker_id: 'synthetic-accounting-worker',
      job_type: 'dag-node',
      status: 'pending',
      input: jsonRoundTrip(buildDagNodeJobInput(request)),
      output: null,
      retry_count: 0,
      max_retries: 0,
      created_at: timestamp,
      updated_at: timestamp
    } as JobData;
    this.rows.set(row.id, row);
    return buildDagQueueJobRecord(row);
  }

  async requestDagJobCancellation(): Promise<DagJobCancellationResult> {
    return { outcome: 'not_found', record: null };
  }

  async waitForDagJobCompletion(
    jobId: string,
    options: WaitForDagJobCompletionOptions = {}
  ): Promise<DagQueueJobRecord> {
    const row = this.rows.get(jobId);
    if (!row) {
      throw new Error(`Unknown test job: ${jobId}`);
    }
    const queuedRecord = buildDagQueueJobRecord(row);
    const input = buildDagNodeJobInput({
      dagId: queuedRecord.dagId,
      node: queuedRecord.node,
      payload: queuedRecord.payload,
      dependencyResults: queuedRecord.dependencyResults,
      sharedState: queuedRecord.sharedState,
      depth: queuedRecord.depth,
      attempt: queuedRecord.retries,
      maxRetries: queuedRecord.maxRetries,
      waitingTimeoutMs: queuedRecord.waitingTimeoutMs
    });
    const workerResult = await runDagNodeJob(input, {
      runPrompt: this.runPrompt,
      artifactStore: this.artifactStore,
      logger,
      metrics: createDagMetricsRecorder()
    });
    const persistedResult = this.persistedResultTransform?.(workerResult) ?? workerResult;
    row.status = persistedResult.status === 'failed' ? 'failed' : 'completed';
    row.output = jsonRoundTrip(persistedResult);
    row.error_message = persistedResult.errorMessage;
    row.completed_at = new Date('2026-09-21T12:00:01.000Z');

    // Exercise production normalization on every observation, including repeated
    // terminal polling notifications, without re-executing the worker attempt.
    for (let observation = 0; observation < this.terminalObservations; observation += 1) {
      const record = buildDagQueueJobRecord(row);
      options.onStatusChange?.(record);
      this.terminalObservationCounts.set(jobId, observation + 1);
    }
    const terminalRecord = buildDagQueueJobRecord(row);
    this.terminalRecords.push(terminalRecord);
    return terminalRecord;
  }
}

function graph(withDependent = false, executionKey = 'planner'): DAGGraph {
  return {
    id: 'dag-token-accounting',
    nodes: {
      first: { id: 'first', type: 'agent', dependencies: [], executionKey },
      ...(withDependent ? {
        dependent: { id: 'dependent', type: 'agent' as const, dependencies: ['first'], executionKey }
      } : {})
    },
    edges: withDependent ? [{ from: 'first', to: 'dependent' }] : [],
    entrypoints: ['first']
  };
}

function orchestrator(queue: DagJobQueue, tokenCap = 1_000, maxRetries = 0): DAGOrchestrator {
  return new DAGOrchestrator({
    jobQueue: queue,
    logger,
    settings: {
      maxConcurrentNodes: 2,
      maxDepth: 3,
      maxChildrenPerNode: 5,
      maxRetries,
      maxTokenBudgetPerDag: tokenCap,
      maxAiCallsPerRun: 10,
      nodeTimeoutMs: 5_000,
      pollIntervalMs: 1
    }
  });
}

function context(observer?: DAGRunObserver) {
  return {
    payloadByNodeId: {
      first: { prompt: 'Run synthetic first stage.' },
      dependent: { prompt: 'Run synthetic dependent stage.' }
    },
    sharedState: { sessionId: 'shared-accounting-session' },
    observer
  };
}

function remotePrompt(result: unknown, status = 'completed'): DagTaskRunnerDependencies['runPrompt'] {
  return createDagNodeRunPromptBridge({} as never, {
    useGptAccess: true,
    gptAccessConfig: {
      waitForResultMs: 1_000,
      createAiJob: async () => ({
        statusCode: 202,
        payload: { ok: true, jobId: 'synthetic-child-job', status: 'queued' }
      }),
      getJobResult: async () => ({
        statusCode: 200,
        payload: sanitizeGptAccessPayload({
          ok: true,
          ...buildGptJobResultLookupPayload('synthetic-child-job', {
            id: 'synthetic-child-job',
            job_type: 'gpt',
            status,
            input: {},
            output: result,
            error_message: status === 'failed' ? 'Synthetic child failed after provider work.' : null,
            created_at: new Date('2026-09-21T12:00:00.000Z'),
            updated_at: new Date('2026-09-21T12:00:01.000Z'),
            completed_at: new Date('2026-09-21T12:00:01.000Z')
          } as JobData)
        })
      })
    }
  });
}

describe('DAG aggregate provider-token accounting through the production worker and orchestrator', () => {
  it('charges 107 aggregate tokens instead of final-stage 7 and blocks the dependent at cap 100', async () => {
    const runPrompt = jest.fn(async () => {
      await providerStage(11);
      await providerStage(89);
      await providerStage(7);
      return publicOutput(7);
    });
    const queue = new WorkerBoundaryQueue(runPrompt);
    const onGuardViolation = jest.fn();
    const summary = await orchestrator(queue, 100).runGraph(graph(true), context({ onGuardViolation }));

    // One assertion preserves the entire 107-versus-7 negative-control diagnosis.
    expect({
      tokenBudgetUsed: summary.tokenBudgetUsed,
      scheduledNodeIds: queue.requests.map(request => request.node.id),
      firstStatus: summary.resultsByNodeId.first.status,
      dependentStatus: summary.resultsByNodeId.dependent.status,
      publicTokens: (summary.resultsByNodeId.first.output as { meta: { tokens: { total_tokens: number } } }).meta.tokens.total_tokens
    }).toEqual({
      tokenBudgetUsed: 107,
      scheduledNodeIds: ['first'],
      firstStatus: 'success',
      dependentStatus: 'skipped',
      publicTokens: 7
    });
    expect(summary.resultsByNodeId.first.metrics?.attemptTokenUsage).toBe(107);
    expect(onGuardViolation).toHaveBeenCalledWith(expect.objectContaining({
      type: 'budget_exceeded', details: { tokenBudgetUsed: 107, maxTokenBudgetPerDag: 100 }
    }));
    expect(runPrompt).toHaveBeenCalledTimes(1);
  });

  it('transports distinct intake, reasoning, and final consumption exactly once through persisted metrics', async () => {
    const queue = new WorkerBoundaryQueue(async () => {
      await providerStage(11);
      await providerStage(23);
      await providerStage(7);
      return publicOutput(7, 4_000);
    });
    const summary = await orchestrator(queue).runGraph(graph(), context());

    expect(summary.tokenBudgetUsed).toBe(41);
    expect(queue.terminalRecords[0].output?.metrics).toMatchObject({ attemptTokenUsage: 41, tokenUsage: 7 });
    expect(summary.resultsByNodeId.first.output).toMatchObject({
      meta: { tokens: { total_tokens: 7 } }, guardInfo: { sessionTokensUsed: 4_000 }
    });
  });

  it('preserves and charges consumed provider tokens when later work throws', async () => {
    const queue = new WorkerBoundaryQueue(async () => {
      await providerStage(19);
      await providerStage(31);
      throw new Error('Synthetic post-provider validation failure.');
    });
    const onNodeFailed = jest.fn();
    const summary = await orchestrator(queue).runGraph(graph(true), context({ onNodeFailed }));

    expect(summary.tokenBudgetUsed).toBe(50);
    expect(queue.terminalRecords[0].output).toMatchObject({ status: 'failed', metrics: { attemptTokenUsage: 50 } });
    expect(summary.resultsByNodeId.dependent.status).toBe('skipped');
    expect(onNodeFailed).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({ metrics: expect.objectContaining({ attemptTokenUsage: 50 }) }),
      willRetry: false
    }));
  });

  it('sums different retry-local consumption without charging cumulative session totals or admitting descendants', async () => {
    const queue = new WorkerBoundaryQueue(async (_prompt, options) => {
      if (options.attempt === 0) {
        await providerStage(27);
        throw Object.assign(new Error('Retryable after provider work.'), { guardInfo: { sessionTokensUsed: 527 } });
      }
      await providerStage(43);
      return publicOutput(3, 570);
    });
    const summary = await orchestrator(queue, 70, 2).runGraph(graph(true), context());

    expect(summary.tokenBudgetUsed).toBe(70);
    expect(summary.totalRetries).toBe(1);
    expect(queue.requests.map(request => [request.node.id, request.attempt])).toEqual([['first', 0], ['first', 1]]);
    expect(queue.terminalRecords.map(record => record.output?.metrics?.attemptTokenUsage)).toEqual([27, 43]);
    expect(summary.resultsByNodeId.first.status).toBe('success');
    expect(summary.resultsByNodeId.dependent.status).toBe('skipped');
  });

  it('charges a failed attempt reaching the cap before deciding whether to retry', async () => {
    const runPrompt = jest.fn(async () => {
      await providerStage(100);
      throw new Error('Retryable failure after consuming the whole DAG cap.');
    });
    const queue = new WorkerBoundaryQueue(runPrompt);
    const onNodeFailed = jest.fn();
    const onNodeRetried = jest.fn();
    const onGuardViolation = jest.fn();
    const summary = await orchestrator(queue, 100, 2).runGraph(graph(true), context({
      onNodeFailed, onNodeRetried, onGuardViolation
    }));

    expect(summary.tokenBudgetUsed).toBe(100);
    expect(runPrompt).toHaveBeenCalledTimes(1);
    expect(summary.totalRetries).toBe(0);
    expect(onNodeFailed).toHaveBeenCalledWith(expect.objectContaining({ willRetry: false }));
    expect(onNodeRetried).not.toHaveBeenCalled();
    expect(onGuardViolation).toHaveBeenCalledWith(expect.objectContaining({ type: 'budget_exceeded' }));
    expect(summary.resultsByNodeId.first.status).toBe('failed');
    expect(summary.resultsByNodeId.dependent.status).toBe('skipped');
  });

  it('uses legacy presentation usage when no aggregate provider observation exists', async () => {
    const queue = new WorkerBoundaryQueue(async () => publicOutput(7));
    const summary = await orchestrator(queue).runGraph(graph(), context());

    expect(summary.tokenBudgetUsed).toBe(7);
    expect(summary.resultsByNodeId.first.metrics?.tokenUsage).toBe(7);
    expect(summary.resultsByNodeId.first.metrics?.attemptTokenUsage).toBeUndefined();
  });

  it('reads old queue records with only output token metadata', async () => {
    const queue = new WorkerBoundaryQueue(async () => publicOutput(13), 1, result => {
      const { metrics: _metrics, ...legacyResult } = result;
      return legacyResult;
    });
    const summary = await orchestrator(queue).runGraph(graph(), context());

    expect(summary.tokenBudgetUsed).toBe(13);
    expect(queue.terminalRecords[0].output?.metrics).toBeUndefined();
  });

  it('preserves an explicit observed zero and does not override it with final-stage compatibility usage', async () => {
    const queue = new WorkerBoundaryQueue(async () => {
      await providerStage(0);
      return publicOutput(7);
    });
    const summary = await orchestrator(queue).runGraph(graph(), context());

    expect(summary.tokenBudgetUsed).toBe(0);
    expect(summary.resultsByNodeId.first.metrics).toMatchObject({ attemptTokenUsage: 0, tokenUsage: 7 });
  });

  it('does not invent usage for deterministic non-provider work', async () => {
    const executionKey = 'token-accounting-deterministic';
    dagAgentManager.registerAgent(executionKey, async () => ({ result: 'Deterministic result.' }));
    const runPrompt = jest.fn(async () => { throw new Error('Provider must not run.'); });
    const queue = new WorkerBoundaryQueue(runPrompt);
    const summary = await orchestrator(queue).runGraph(graph(false, executionKey), context());

    expect(summary.tokenBudgetUsed).toBe(0);
    expect(summary.resultsByNodeId.first.metrics?.attemptTokenUsage).toBeUndefined();
    expect(summary.resultsByNodeId.first.metrics?.tokenUsage).toBeUndefined();
    expect(runPrompt).not.toHaveBeenCalled();
  });

  it('keeps usage unknown for failures before any provider work', async () => {
    const queue = new WorkerBoundaryQueue(async () => { throw new Error('Invalid input before provider work.'); });
    const summary = await orchestrator(queue).runGraph(graph(), context());

    expect(summary.tokenBudgetUsed).toBe(0);
    expect(summary.resultsByNodeId.first.status).toBe('failed');
    expect(summary.resultsByNodeId.first.metrics?.attemptTokenUsage).toBeUndefined();
  });

  it('charges each concurrent attempt once despite repeated terminal observations and normalization', async () => {
    const queue = new WorkerBoundaryQueue(async (_prompt, options) => {
      const tokens = options.nodeId === 'first' ? 17 : 23;
      await providerStage(tokens);
      return publicOutput(1);
    }, 3);
    const independentGraph = graph(true);
    independentGraph.nodes.dependent.dependencies = [];
    independentGraph.edges = [];
    independentGraph.entrypoints = ['first', 'dependent'];
    const onNodeCompleted = jest.fn();
    const summary = await orchestrator(queue).runGraph(independentGraph, context({ onNodeCompleted }));

    expect(summary.tokenBudgetUsed).toBe(40);
    expect(queue.requests).toHaveLength(2);
    expect([...queue.terminalObservationCounts.values()]).toEqual([3, 3]);
    expect(onNodeCompleted).toHaveBeenCalledTimes(2);
    expect(queue.terminalRecords.map(record => record.output?.metrics?.attemptTokenUsage).sort()).toEqual([17, 23]);
  });

  it('does not carry prior-run usage into a later attempt sharing the same session', async () => {
    let invocation = 0;
    const queue = new WorkerBoundaryQueue(async () => {
      invocation += 1;
      await providerStage(invocation === 1 ? 37 : 11);
      return publicOutput(1, 48);
    });
    const runner = orchestrator(queue);
    const first = await runner.runGraph(graph(), context());
    const second = await runner.runGraph(graph(), context());

    expect([first.tokenBudgetUsed, second.tokenBudgetUsed]).toEqual([37, 11]);
  });

  it('preserves remote child aggregate through real gateway projection, redaction, and bridge unwrapping', async () => {
    const child = await runWithDagChildAccounting({
      requestPath: '/gpt-access/jobs/create',
      body: { payload: { input: { pipeline: 'trinity', dagId: 'synthetic-dag', nodeId: 'first' } } }
    }, async () => {
      await providerStage(11);
      await providerStage(89);
      await providerStage(7);
      return { status: 'completed' as const, output: { ok: true, result: publicOutput(7) } };
    });
    const queue = new WorkerBoundaryQueue(remotePrompt(child.output));
    const summary = await orchestrator(queue, 100).runGraph(graph(true), context());

    expect(summary.tokenBudgetUsed).toBe(107);
    expect(summary.resultsByNodeId.first.metrics).toMatchObject({ attemptTokenUsage: 107 });
    expect(summary.resultsByNodeId.first.metrics?.tokenUsage).toBeUndefined();
    expect(summary.resultsByNodeId.first.output).toMatchObject({ meta: { tokens: '[REDACTED]' } });
    expect(summary.resultsByNodeId.dependent.status).toBe('skipped');
    expect(queue.requests).toHaveLength(1);
  });

  it.each(['failed', 'expired', 'cancelled'])('preserves remote %s consumption through the real GPT Access bridge', async status => {
    const queue = new WorkerBoundaryQueue(remotePrompt({
      ok: false,
      dagAttemptUsage: 39,
      error: { message: 'Synthetic failed child.' }
    }, status));
    const summary = await orchestrator(queue).runGraph(graph(), context());

    expect(summary.tokenBudgetUsed).toBe(39);
    expect(summary.resultsByNodeId.first).toMatchObject({ status: 'failed', metrics: { attemptTokenUsage: 39 } });
  });

  it('does not retry a terminal child accounting failure when consumption is unknown', async () => {
    const queue = new WorkerBoundaryQueue(remotePrompt({
      retryable: false,
      error: { message: 'Invalid provider token usage for execution attempt.' }
    }, 'failed'));
    const summary = await orchestrator(queue, 100, 2).runGraph(graph(true), context());

    expect(queue.requests).toHaveLength(1);
    expect(summary.totalRetries).toBe(0);
    expect(summary.tokenBudgetUsed).toBe(0);
    expect(summary.resultsByNodeId.first).toMatchObject({ status: 'failed', retryable: false });
    expect(summary.resultsByNodeId.first.metrics?.attemptTokenUsage).toBeUndefined();
    expect(summary.resultsByNodeId.dependent.status).toBe('skipped');
  });

  it('preserves remote consumed tokens when a completed child has a failed inner envelope', async () => {
    const queue = new WorkerBoundaryQueue(remotePrompt({
      ok: false,
      dagAttemptUsage: 61,
      error: { message: 'Synthetic inner execution failed.' }
    }));
    const summary = await orchestrator(queue).runGraph(graph(), context());

    expect(summary.tokenBudgetUsed).toBe(61);
    expect(summary.resultsByNodeId.first).toMatchObject({ status: 'failed', metrics: { attemptTokenUsage: 61 } });
  });

  it('preserves known usage on the original cancellation error after provider work', async () => {
    const cancellation = new AbortController();
    const originalError = new Error('Synthetic cancellation after provider work.');
    originalError.name = 'AbortError';
    const jobInput = buildDagNodeJobInput({
      dagId: 'synthetic-cancelled-attempt',
      node: graph().nodes.first,
      payload: { prompt: 'Consume synthetic provider usage then cancel.' },
      depth: 0
    });
    const operation = runDagNodeJob(jobInput, {
      abortSignal: cancellation.signal,
      runPrompt: async () => {
        await providerStage(19);
        cancellation.abort(originalError);
        return publicOutput(7);
      },
      logger,
      artifactStore: {
        writeArtifact: async () => 'unused-cancelled-artifact',
        readArtifact: async () => { throw new Error('No dependency artifact should be read.'); }
      }
    });

    await expect(operation).rejects.toBe(originalError);
    expect(originalError).toMatchObject({ name: 'AbortError', attemptTokenUsage: 19 });
  });

  it('charges known consumption on a terminal cancelled queue record without scheduling descendants', async () => {
    const workerQueue = new WorkerBoundaryQueue(async () => {
      await providerStage(19);
      return publicOutput(7);
    });
    const queue: DagJobQueue = {
      enqueueDagNodeJob: request => workerQueue.enqueueDagNodeJob(request),
      requestDagJobCancellation: () => workerQueue.requestDagJobCancellation(),
      waitForDagJobCompletion: async (jobId, options) => ({
        ...await workerQueue.waitForDagJobCompletion(jobId, options),
        status: 'cancelled',
        errorMessage: 'Queue cancellation won terminal persistence after provider work.'
      })
    };
    const onNodeCompleted = jest.fn();
    const summary = await orchestrator(queue).runGraph(graph(true), context({ onNodeCompleted }));

    expect(summary.status).toBe('cancelled');
    expect(summary.tokenBudgetUsed).toBe(19);
    expect(summary.cancelledNodeIds.sort()).toEqual(['dependent', 'first']);
    expect(workerQueue.requests).toHaveLength(1);
    expect(onNodeCompleted).not.toHaveBeenCalled();
  });
});

describe('DAG aggregate metric queue compatibility', () => {
  function persistedRow(metrics?: Record<string, unknown>): JobData {
    const timestamp = new Date('2026-09-21T12:00:00.000Z');
    return {
      id: 'synthetic-persisted-accounting-job',
      worker_id: 'synthetic-accounting-worker',
      job_type: 'dag-node',
      status: 'completed',
      input: buildDagNodeJobInput({ dagId: 'synthetic-dag', node: graph().nodes.first, depth: 0 }),
      output: { nodeId: 'first', status: 'success', output: publicOutput(7), ...(metrics ? { metrics } : {}) },
      retry_count: 0,
      max_retries: 0,
      created_at: timestamp,
      updated_at: timestamp,
      completed_at: timestamp
    } as JobData;
  }

  it.each([0, 107, Number.MAX_SAFE_INTEGER])('preserves valid explicit aggregate %s through queue reads and dependency validation', total => {
    const metrics = { attemptTokenUsage: total, tokenUsage: 7, durationMs: 12, cacheHits: 2 };
    const record = buildDagQueueJobRecord(persistedRow(metrics));
    expect(record.output?.metrics).toEqual(metrics);
    const nextInput = buildDagNodeJobInput({
      dagId: 'synthetic-next-dag',
      node: graph().nodes.first,
      depth: 0,
      dependencyResults: { first: record.output! }
    });
    const parsed = parseDagNodeJobInput(jsonRoundTrip(nextInput));
    expect(parsed).toMatchObject({ ok: true, value: { dependencyResults: { first: { metrics } } } });
  });

  it.each([NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '107', null, {}])(
    'rejects malformed explicit aggregate %p instead of using public fallback', total => {
      const row = persistedRow({ attemptTokenUsage: total, tokenUsage: 7 });
      expect(() => buildDagQueueJobRecord(row)).toThrow('Invalid provider token usage for execution attempt.');
      const nextInput = {
        ...buildDagNodeJobInput({ dagId: 'synthetic-next-dag', node: graph().nodes.first, depth: 0 }),
        dependencyResults: { first: row.output }
      };
      expect(parseDagNodeJobInput(nextInput)).toMatchObject({ ok: false });
    }
  );

  it('keeps old persisted metric bags and absent metrics readable without synthesizing aggregate usage', () => {
    const legacyMetrics = { tokenUsage: 7, durationMs: 12, cacheHits: 2 };
    const legacy = buildDagQueueJobRecord(persistedRow(legacyMetrics));
    const withoutMetrics = buildDagQueueJobRecord(persistedRow());

    expect(legacy.output?.metrics).toEqual(legacyMetrics);
    expect(legacy.output?.metrics?.attemptTokenUsage).toBeUndefined();
    expect(withoutMetrics.output?.metrics).toBeUndefined();
    expect(withoutMetrics.output?.output).toMatchObject({ meta: { tokens: { total_tokens: 7 } } });
  });

  it('fails closed when unrelated malformed metrics would otherwise erase valid aggregate consumption', () => {
    expect(() => buildDagQueueJobRecord(persistedRow({ attemptTokenUsage: 39, tokenUsage: 'invalid' })))
      .toThrow('Invalid DAG result with known attempt token usage');
  });
});
