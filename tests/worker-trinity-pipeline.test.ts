import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const runTrinityWritingPipelineMock = jest.fn();
const createRuntimeBudgetWithLimitMock = jest.fn(() => ({ budgetId: 'runtime-budget' }));
const getWorkerExecutionLimitsMock = jest.fn(() => ({
  workerTrinityRuntimeBudgetMs: 420_000,
  workerTrinityStageTimeoutMs: 180_000,
  dagMaxTokenBudget: 250_000,
  dagNodeTimeoutMs: 420_000,
  dagQueueClaimGraceMs: 120_000,
  plannerTimeoutMs: 90_000,
  plannerMaxRetries: 2,
  plannerRetryBackoffMs: 500
}));
const runWithRequestAbortTimeoutMock = jest.fn(async (_options, callback) => callback());
const getRequestAbortSignalMock = jest.fn(() => undefined);
const getRequestAbortContextMock = jest.fn(() => null);
const isAbortErrorMock = jest.fn((error: unknown) =>
  error instanceof Error && error.message.toLowerCase().includes('abort')
);
const createAbortErrorMock = jest.fn((message = 'request_aborted') => {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
});
const sleepMock = jest.fn(async () => undefined);

jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({
  runTrinityWritingPipeline: runTrinityWritingPipelineMock
}));

jest.unstable_mockModule('@platform/resilience/runtimeBudget.js', () => ({
  createRuntimeBudgetWithLimit: createRuntimeBudgetWithLimitMock
}));

jest.unstable_mockModule('../src/workers/workerExecutionLimits.js', () => ({
  getWorkerExecutionLimits: getWorkerExecutionLimitsMock
}));

jest.unstable_mockModule('@arcanos/runtime', () => ({
  createAbortError: createAbortErrorMock,
  getRequestAbortContext: getRequestAbortContextMock,
  getRequestAbortSignal: getRequestAbortSignalMock,
  isAbortError: isAbortErrorMock,
  runWithRequestAbortTimeout: runWithRequestAbortTimeoutMock
}));

jest.unstable_mockModule('@shared/sleep.js', () => ({
  sleep: sleepMock
}));

const { runWorkerTrinityPrompt } = await import('../src/workers/trinityWorkerPipeline.js');

describe('runWorkerTrinityPrompt', () => {
  beforeEach(() => {
    runTrinityWritingPipelineMock.mockReset();
    createRuntimeBudgetWithLimitMock.mockClear();
    getWorkerExecutionLimitsMock.mockClear();
    runWithRequestAbortTimeoutMock.mockClear();
    getRequestAbortSignalMock.mockClear();
    isAbortErrorMock.mockClear();
    createAbortErrorMock.mockClear();
    sleepMock.mockClear();
    runTrinityWritingPipelineMock.mockResolvedValue({ result: 'ok' });
    runWithRequestAbortTimeoutMock.mockImplementation(async (_options, callback) => callback());
    getRequestAbortSignalMock.mockReturnValue(undefined);
    getRequestAbortContextMock.mockReturnValue(null);
    isAbortErrorMock.mockImplementation((error: unknown) =>
      error instanceof Error && error.message.toLowerCase().includes('abort')
    );
  });

  it('forwards worker routing metadata into Trinity', async () => {
    const openaiClient = {} as never;
    getRequestAbortContextMock.mockReturnValue({ requestId: 'req-worker-1' });

    await runWorkerTrinityPrompt(openaiClient, {
      prompt: 'Audit the DAG output',
      sessionId: 'session-123',
      tokenAuditSessionId: 'session-123:dag:run-1:audit:a0',
      overrideAuditSafe: 'allow',
      cognitiveDomain: 'diagnostic',
      sourceEndpoint: 'dag.agent.audit',
      toolBackedCapabilities: {
        verifyProvidedData: true
      }
    });

    expect(createRuntimeBudgetWithLimitMock).toHaveBeenCalledTimes(1);
    expect(runTrinityWritingPipelineMock).toHaveBeenCalledWith({
      input: {
        prompt: 'Audit the DAG output',
        sessionId: 'session-123',
        overrideAuditSafe: 'allow',
        sourceEndpoint: 'dag.agent.audit',
        body: expect.objectContaining({
          prompt: 'Audit the DAG output',
          sourceEndpoint: 'dag.agent.audit',
          tokenAuditSessionId: 'session-123:dag:run-1:audit:a0'
        })
      },
      context: {
        client: openaiClient,
        requestId: 'req-worker-1',
        runtimeBudget: { budgetId: 'runtime-budget' },
        runOptions: {
          cognitiveDomain: 'diagnostic',
          toolBackedCapabilities: {
            verifyProvidedData: true
          },
          tokenAuditSessionId: 'session-123:dag:run-1:audit:a0',
          watchdogModelTimeoutMs: 180_000
        }
      }
    });
    expect(createRuntimeBudgetWithLimitMock).toHaveBeenCalledWith(420_000);
  });

  it('forwards preview reasoning chaos hooks into Trinity options', async () => {
    const openaiClient = {} as never;

    await runWorkerTrinityPrompt(openaiClient, {
      prompt: 'Force a preview-only timeout once.',
      sourceEndpoint: 'worker-helper',
      previewChaosHook: {
        kind: 'reasoning_timeout_once',
        hookId: 'preview-chaos-test-hook',
        delayBeforeCallMs: 250,
        timeoutMs: 50
      }
    });

    expect(runTrinityWritingPipelineMock).toHaveBeenCalledWith({
      input: expect.objectContaining({
        prompt: 'Force a preview-only timeout once.',
        sourceEndpoint: 'worker-helper'
      }),
      context: expect.objectContaining({
        runtimeBudget: { budgetId: 'runtime-budget' },
        runOptions: expect.objectContaining({
          reasoningStagePreviewChaosHook: {
            kind: 'reasoning_timeout_once',
            hookId: 'preview-chaos-test-hook',
            delayBeforeCallMs: 250,
            timeoutMs: 50
          }
        })
      })
    });
  });

  it('applies the default worker source endpoint when the caller omits one', async () => {
    const openaiClient = {} as never;

    await runWorkerTrinityPrompt(openaiClient, {
      prompt: 'Research the latest deployment logs'
    });

    expect(runTrinityWritingPipelineMock).toHaveBeenCalledWith({
      input: expect.objectContaining({
        prompt: 'Research the latest deployment logs',
        sourceEndpoint: 'worker.dispatch'
      }),
      context: expect.objectContaining({
        runtimeBudget: { budgetId: 'runtime-budget' },
        runOptions: {
          cognitiveDomain: undefined,
          watchdogModelTimeoutMs: 180_000
        }
      })
    });
  });

  it('retries planner abort failures and succeeds on a later attempt', async () => {
    const openaiClient = {} as never;

    runTrinityWritingPipelineMock
      .mockRejectedValueOnce(new Error('Request was aborted.'))
      .mockResolvedValueOnce({ result: 'planner recovered' });

    const result = await runWorkerTrinityPrompt(openaiClient, {
      prompt: 'Plan the DAG execution.',
      sourceEndpoint: 'dag.agent.planner'
    });

    expect(result).toEqual({ result: 'planner recovered' });
    expect(runTrinityWritingPipelineMock).toHaveBeenCalledTimes(2);
    expect(createRuntimeBudgetWithLimitMock).toHaveBeenNthCalledWith(1, 90_000);
    expect(createRuntimeBudgetWithLimitMock).toHaveBeenNthCalledWith(2, 90_000);
    expect(runWithRequestAbortTimeoutMock).toHaveBeenCalledTimes(2);
    expect(runWithRequestAbortTimeoutMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        timeoutMs: 90_000,
        abortMessage: 'Planner DAG node timed out after 90000ms'
      }),
      expect.any(Function)
    );
    expect(sleepMock).toHaveBeenCalledWith(500, { unref: true });
    expect(runTrinityWritingPipelineMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        input: expect.objectContaining({
          prompt: 'Plan the DAG execution.',
          sourceEndpoint: 'dag.agent.planner'
        }),
        context: expect.objectContaining({
          runtimeBudget: { budgetId: 'runtime-budget' },
          runOptions: expect.objectContaining({
            watchdogModelTimeoutMs: 90_000
          })
        })
      })
    );
  });

  it('classifies planner timeout failures as transient and retries once', async () => {
    const openaiClient = {} as never;

    runTrinityWritingPipelineMock
      .mockRejectedValueOnce(new Error('Planner DAG node timed out after 90000ms'))
      .mockResolvedValueOnce({ result: 'planner recovered after timeout' });

    const result = await runWorkerTrinityPrompt(openaiClient, {
      prompt: 'Plan after timeout.',
      sourceEndpoint: 'dag.agent.planner'
    });

    expect(result).toEqual({ result: 'planner recovered after timeout' });
    expect(runTrinityWritingPipelineMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledWith(500, { unref: true });
  });

  it('stops planner retries after the configured retry budget is exhausted', async () => {
    const openaiClient = {} as never;

    runTrinityWritingPipelineMock.mockRejectedValue(new Error('Request was aborted.'));

    await expect(
      runWorkerTrinityPrompt(openaiClient, {
        prompt: 'Plan the DAG execution.',
        sourceEndpoint: 'dag.agent.planner'
      })
    ).rejects.toMatchObject({
      name: 'PlannerExecutionError',
      plannerExecution: expect.objectContaining({
        sourceEndpoint: 'dag.agent.planner',
        timeoutMs: 90_000,
        maxRetries: 2,
        retryBackoffMs: 500,
        attemptsUsed: 3,
        finalFailureClassification: 'abort',
        transientFailure: true,
        retryable: false
      })
    });

    expect(runTrinityWritingPipelineMock).toHaveBeenCalledTimes(3);
    expect(sleepMock).toHaveBeenNthCalledWith(1, 500, { unref: true });
    expect(sleepMock).toHaveBeenNthCalledWith(2, 1000, { unref: true });
  });

  it('does not retry planner validation failures', async () => {
    const openaiClient = {} as never;

    runTrinityWritingPipelineMock.mockRejectedValue(new Error('Validation error: missing planner prompt.'));

    await expect(
      runWorkerTrinityPrompt(openaiClient, {
        prompt: 'Plan the DAG execution.',
        sourceEndpoint: 'dag.agent.planner'
      })
    ).rejects.toMatchObject({
      name: 'PlannerExecutionError',
      plannerExecution: expect.objectContaining({
        attemptsUsed: 1,
        finalFailureClassification: 'input',
        transientFailure: false,
        retryable: false
      })
    });

    expect(runTrinityWritingPipelineMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).not.toHaveBeenCalled();
  });
});
