import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const reserveWorkerAiProviderAttemptMock = jest.fn();
const recordJobEventMock = jest.fn();

jest.unstable_mockModule('@core/db/repositories/workerBudgetRepository.js', () => ({
  reserveWorkerAiProviderAttempt: reserveWorkerAiProviderAttemptMock,
  WORKER_BUDGET_NON_JOB_SUBJECT_ID: '00000000-0000-0000-0000-000000000000'
}));

jest.unstable_mockModule('@core/db/repositories/jobEventRepository.js', () => ({
  recordJobEvent: recordJobEventMock
}));

const {
  WorkerAiCallBudgetDependencyError,
  WorkerAiCallBudgetPausedError,
  createOpenAIAdapter,
  createWorkerBudgetedOpenAIFetch,
  instrumentOpenAIOperation,
} = await import('../src/core/adapters/openai.adapter.js');
const {
  createAiExecutionContext,
  runWithAiExecutionContext
} = await import('../src/services/openai/aiExecutionContext.js');
const { executeChatFlow } = await import('../src/services/openai/chatFlow/execute.js');

function createWorkerContext(
  onOperationalFailure?: (error: unknown) => void,
  onCapacityExhausted?: (nextAvailableAt: string | null) => void
) {
  return createAiExecutionContext({
    sourceType: 'job',
    sourceName: 'ask',
    requestId: 'request-1',
    jobId: '10000000-0000-4000-8000-000000000001',
    workerBudget: {
      statsWorkerId: 'async-queue',
      workerId: 'async-queue-slot-1',
      maxCallsPerHour: 2,
      onCapacityExhausted,
      onOperationalFailure,
    }
  });
}

function successfulResponsePayload() {
  return {
    id: 'resp_test',
    object: 'response',
    created_at: 1,
    status: 'completed',
    model: 'gpt-4.1-mini',
    output: [],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2
    }
  };
}

describe('worker OpenAI provider-attempt budget', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    reserveWorkerAiProviderAttemptMock.mockResolvedValue({
      kind: 'ai_provider_attempt',
      statsWorkerId: 'async-queue',
      allowed: true,
      used: 1,
      limit: 2,
      remaining: 1,
      evaluatedAt: '2026-08-30T14:00:00.000Z',
      nextAvailableAt: null
    });
  });

  it('reports the final admitted unit before dispatch without cancelling that transport', async () => {
    const events: string[] = [];
    const onOperationalFailure = jest.fn();
    const onCapacityExhausted = jest.fn(() => {
      events.push('capacity-exhausted');
      throw new Error('observer failure');
    });
    const nativeFetch = jest.fn(async () => {
      events.push('native-dispatch');
      return new Response('{}', { status: 200 });
    });
    reserveWorkerAiProviderAttemptMock.mockResolvedValueOnce({
      kind: 'ai_provider_attempt',
      statsWorkerId: 'async-queue',
      allowed: true,
      used: 2,
      limit: 2,
      remaining: 0,
      evaluatedAt: '2026-08-30T14:00:00.000Z',
      nextAvailableAt: '2026-08-30T15:00:00.000Z'
    });
    const context = createWorkerContext(
      onOperationalFailure,
      onCapacityExhausted
    );

    await expect(runWithAiExecutionContext(
      context,
      () => createWorkerBudgetedOpenAIFetch(nativeFetch)(
        'https://api.openai.test/v1/responses'
      )
    )).resolves.toMatchObject({ status: 200 });

    expect(onCapacityExhausted).toHaveBeenCalledWith(
      '2026-08-30T15:00:00.000Z'
    );
    expect(events).toEqual(['capacity-exhausted', 'native-dispatch']);
    expect(onOperationalFailure).not.toHaveBeenCalled();
    expect(context.workerBudgetFailure).toBeNull();
  });

  it('reserves every pinned-SDK transport retry before native dispatch', async () => {
    const onOperationalFailure = jest.fn();
    const nativeFetch = jest.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'temporary upstream failure', type: 'server_error' }
      }), {
        status: 500,
        headers: {
          'content-type': 'application/json',
          'retry-after-ms': '0'
        }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(successfulResponsePayload()), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }));
    const adapter = createOpenAIAdapter({
      apiKey: 'test-key',
      maxRetries: 1,
      fetch: nativeFetch
    });

    await expect(runWithAiExecutionContext(
      createWorkerContext(onOperationalFailure),
      () => adapter.responses.create({ model: 'gpt-4.1-mini', input: 'hello' })
    )).resolves.toMatchObject({ id: 'resp_test' });

    expect(nativeFetch).toHaveBeenCalledTimes(2);
    expect(reserveWorkerAiProviderAttemptMock).toHaveBeenCalledTimes(2);
    expect(reserveWorkerAiProviderAttemptMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        statsWorkerId: 'async-queue',
        workerId: 'async-queue-slot-1',
        jobId: '10000000-0000-4000-8000-000000000001'
      })
    );
    const firstReservationId = reserveWorkerAiProviderAttemptMock.mock.calls[0]?.[0]?.reservationId;
    const secondReservationId = reserveWorkerAiProviderAttemptMock.mock.calls[1]?.[0]?.reservationId;
    expect(firstReservationId).toEqual(expect.any(String));
    expect(secondReservationId).toEqual(expect.any(String));
    expect(secondReservationId).not.toBe(firstReservationId);
    expect(onOperationalFailure).not.toHaveBeenCalled();
  });

  it('counts distinct multi-stage calls once per transport without logical double counting', async () => {
    const nativeFetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes('/embeddings')) {
        return new Response(JSON.stringify({
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: [0.1] }],
          model: 'text-embedding-3-small',
          usage: { prompt_tokens: 1, total_tokens: 1 }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify(successfulResponsePayload()), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });
    const adapter = createOpenAIAdapter({ apiKey: 'test-key', maxRetries: 0, fetch: nativeFetch });

    await runWithAiExecutionContext(createWorkerContext(), async () => {
      await adapter.responses.create({ model: 'gpt-4.1-mini', input: 'stage one' });
      await adapter.embeddings.create({
        model: 'text-embedding-3-small',
        input: ['stage two']
      });
    });

    expect(nativeFetch).toHaveBeenCalledTimes(2);
    expect(reserveWorkerAiProviderAttemptMock).toHaveBeenCalledTimes(2);
  });

  it('accounts worker-owned background transports under the reserved non-job subject', async () => {
    const nativeFetch = jest.fn(async () => new Response('{}', { status: 200 }));
    const budgetedFetch = createWorkerBudgetedOpenAIFetch(nativeFetch);
    const backgroundContext = createAiExecutionContext({
      sourceType: 'background',
      sourceName: 'backstage-notion-sync-loop',
      workerBudget: {
        statsWorkerId: 'async-queue',
        workerId: 'async-queue-slot-1',
        maxCallsPerHour: 2
      }
    });

    await runWithAiExecutionContext(backgroundContext, () =>
      budgetedFetch('https://api.openai.test/v1/embeddings')
    );

    expect(nativeFetch).toHaveBeenCalledTimes(1);
    expect(reserveWorkerAiProviderAttemptMock).toHaveBeenCalledWith(expect.objectContaining({
      jobId: '00000000-0000-0000-0000-000000000000',
      operation: '/v1/embeddings',
      statsWorkerId: 'async-queue',
      workerId: 'async-queue-slot-1'
    }));
  });

  it('denies callback-free background transport when the shared ledger is exhausted', async () => {
    const nativeFetch = jest.fn();
    const adapter = createOpenAIAdapter({
      apiKey: 'test-key',
      maxRetries: 0,
      fetch: nativeFetch
    });
    const backgroundContext = createAiExecutionContext({
      sourceType: 'background',
      sourceName: 'backstage-notion-sync-loop',
      workerBudget: {
        statsWorkerId: 'async-queue',
        workerId: 'async-queue-slot-1',
        maxCallsPerHour: 2
      }
    });
    reserveWorkerAiProviderAttemptMock.mockResolvedValueOnce({
      kind: 'ai_provider_attempt',
      statsWorkerId: 'async-queue',
      allowed: false,
      used: 2,
      limit: 2,
      remaining: 0,
      evaluatedAt: '2026-08-30T14:00:00.000Z',
      nextAvailableAt: '2026-08-30T14:30:00.000Z'
    });

    await expect(runWithAiExecutionContext(backgroundContext, () =>
      adapter.embeddings.create({
        model: 'text-embedding-3-small',
        input: ['blocked authority embedding']
      })
    )).rejects.toBeInstanceOf(WorkerAiCallBudgetPausedError);

    expect(backgroundContext.workerBudgetFailure).toBeInstanceOf(
      WorkerAiCallBudgetPausedError
    );
    expect(reserveWorkerAiProviderAttemptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: '00000000-0000-0000-0000-000000000000',
        statsWorkerId: 'async-queue',
        workerId: 'async-queue-slot-1'
      })
    );
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it('does not let the SDK retry local quota exhaustion or budget-store failure', async () => {
    const nativeFetch = jest.fn();
    const adapter = createOpenAIAdapter({ apiKey: 'test-key', maxRetries: 2, fetch: nativeFetch });
    reserveWorkerAiProviderAttemptMock.mockResolvedValueOnce({
      kind: 'ai_provider_attempt',
      statsWorkerId: 'async-queue',
      allowed: false,
      used: 2,
      limit: 2,
      remaining: 0,
      evaluatedAt: '2026-08-30T14:00:00.000Z',
      nextAvailableAt: '2026-08-30T14:30:00.000Z'
    });

    const pausedFailureReporter = jest.fn();
    const pausedContext = createWorkerContext(pausedFailureReporter);
    await expect(runWithAiExecutionContext(
      pausedContext,
      () => adapter.responses.create({ model: 'gpt-4.1-mini', input: 'blocked' })
    )).rejects.toBeInstanceOf(WorkerAiCallBudgetPausedError);
    expect(pausedContext.workerBudgetFailure).toBeInstanceOf(
      WorkerAiCallBudgetPausedError
    );
    expect(pausedFailureReporter).toHaveBeenCalledTimes(1);
    expect(reserveWorkerAiProviderAttemptMock).toHaveBeenCalledTimes(1);
    expect(nativeFetch).not.toHaveBeenCalled();

    reserveWorkerAiProviderAttemptMock.mockRejectedValueOnce(new Error('database unavailable'));
    const dependencyFailureReporter = jest.fn();
    const dependencyContext = createWorkerContext(dependencyFailureReporter);
    await expect(runWithAiExecutionContext(
      dependencyContext,
      () => adapter.responses.create({ model: 'gpt-4.1-mini', input: 'blocked again' })
    )).rejects.toBeInstanceOf(WorkerAiCallBudgetDependencyError);
    expect(dependencyContext.workerBudgetFailure).toBeInstanceOf(
      WorkerAiCallBudgetDependencyError
    );
    expect(dependencyFailureReporter).toHaveBeenCalledTimes(1);
    expect(reserveWorkerAiProviderAttemptMock).toHaveBeenCalledTimes(2);
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it('reports only a final worker-owned provider operation failure', async () => {
    const events: string[] = [];
    const providerFailureReporter = jest.fn(() => {
      events.push('operational-failure-reported');
    });
    const context = createWorkerContext(providerFailureReporter);

    const operation = runWithAiExecutionContext(context, () =>
      instrumentOpenAIOperation({
        operation: 'models_retrieve',
        model: 'gpt-4.1-mini',
        callback: async () => {
          const error = new Error('Connection error.');
          error.name = 'APIConnectionError';
          throw error;
        }
      })
    );
    void operation.catch(() => {
      events.push('operation-settled');
    });
    await expect(operation).rejects.toThrow('Connection error.');

    expect(providerFailureReporter).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      'operational-failure-reported',
      'operation-settled',
    ]);
    expect(context.workerBudgetFailure).toBeNull();
  });

  it('does not retry local budget denials or count them against the generic circuit breaker', async () => {
    const budgetError = new WorkerAiCallBudgetPausedError(
      '2026-08-30T14:30:00.000Z'
    );
    const create = jest.fn(async () => {
      throw budgetError;
    });
    const adapter = {
      responses: { create }
    };

    for (let index = 0; index < 6; index += 1) {
      await expect(executeChatFlow(
        adapter as never,
        'gpt-4.1-mini',
        [{ role: 'user', content: 'blocked' }],
        32,
        { maxRetries: 2 }
      )).rejects.toBe(budgetError);
    }

    expect(create).toHaveBeenCalledTimes(6);
  });

  it('bypasses unscoped job-like work and rejects pre-aborted scoped work before native fetch', async () => {
    const nativeFetch = jest.fn(async () => new Response('{}', { status: 200 }));
    const budgetedFetch = createWorkerBudgetedOpenAIFetch(nativeFetch);
    const unscopedContext = createAiExecutionContext({
      sourceType: 'job',
      sourceName: 'priority-direct',
      jobId: '10000000-0000-4000-8000-000000000002'
    });

    await runWithAiExecutionContext(unscopedContext, () =>
      budgetedFetch('https://api.openai.test/v1/responses')
    );
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    expect(reserveWorkerAiProviderAttemptMock).not.toHaveBeenCalled();

    nativeFetch.mockClear();
    const controller = new AbortController();
    controller.abort(new Error('cancelled before dispatch'));
    await expect(runWithAiExecutionContext(createWorkerContext(), () =>
      budgetedFetch('https://api.openai.test/v1/responses', {
        signal: controller.signal
      })
    )).rejects.toThrow('cancelled before dispatch');
    expect(nativeFetch).not.toHaveBeenCalled();
    expect(reserveWorkerAiProviderAttemptMock).not.toHaveBeenCalled();
  });
});
