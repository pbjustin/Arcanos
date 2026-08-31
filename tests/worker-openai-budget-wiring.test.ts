import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

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
  createWorkerBudgetedOpenAIFetch,
  WorkerAiCallBudgetPausedError,
  resetOpenAIAdapter,
} = await import('../src/core/adapters/openai.adapter.js');
const {
  createAiExecutionContext,
  runWithAiExecutionContext,
} = await import('../src/services/openai/aiExecutionContext.js');
const {
  getOpenAIProviderRuntimeStatus,
  probeOpenAIProviderHealth,
  syncOpenAIProviderRuntime,
} = await import('../src/services/openai/serviceHealth.js');
const {
  configureBackendUnifiedOpenAIClient,
} = await import('../src/core/init-openai.js');
const {
  getOrCreateClient,
  resetClient,
} = await import('@arcanos/openai/unifiedClient');
const {
  resetCredentialCache,
} = await import('../src/services/openai/credentialProvider.js');
const {
  resolveLlmDispatchPlan,
} = await import('../src/dispatcher/naturalLanguage/llmResolver.js');

const originalFetch = globalThis.fetch;
const originalOpenAIKey = process.env.OPENAI_API_KEY;
const originalOpenAIBaseURL = process.env.OPENAI_BASE_URL;
const originalOpenAIApiBaseURL = process.env.OPENAI_API_BASE_URL;
const originalOpenAIApiBase = process.env.OPENAI_API_BASE;
const originalWorkerApiTimeoutMs = process.env.WORKER_API_TIMEOUT_MS;

function buildSyntheticOpenAIKey(label: string): string {
  return ['sk', 'test', label].join('-');
}

function configureWorkerOpenAI(
  nativeFetch: jest.Mock,
  options: { apiKey?: string; baseURL?: string } = {}
): void {
  globalThis.fetch = nativeFetch as unknown as typeof globalThis.fetch;
  process.env.OPENAI_API_KEY = options.apiKey ?? buildSyntheticOpenAIKey('worker-budget-wiring');
  if (options.baseURL === undefined) {
    delete process.env.OPENAI_BASE_URL;
  } else {
    process.env.OPENAI_BASE_URL = options.baseURL;
  }
  delete process.env.OPENAI_API_BASE_URL;
  delete process.env.OPENAI_API_BASE;
  resetCredentialCache();
  resetOpenAIAdapter();
  configureBackendUnifiedOpenAIClient();
}

function createWorkerContext(onOperationalFailure = jest.fn()) {
  return createAiExecutionContext({
    sourceType: 'background',
    sourceName: 'worker-openai-wiring-test',
    workerBudget: {
      statsWorkerId: 'async-queue',
      workerId: 'async-queue-slot-1',
      maxCallsPerHour: 2,
      onOperationalFailure,
    }
  });
}

function admittedReservation() {
  return {
    kind: 'ai_provider_attempt',
    statsWorkerId: 'async-queue',
    allowed: true,
    used: 1,
    limit: 2,
    remaining: 1,
    evaluatedAt: '2026-08-30T14:00:00.000Z',
    nextAvailableAt: null
  };
}

function modelListResponse(status = 200): Response {
  return new Response(JSON.stringify(status === 200
    ? { object: 'list', data: [] }
    : {
      error: {
        message: 'retryable provider failure',
        type: 'server_error',
        code: null,
        param: null
      }
    }), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

describe('worker OpenAI budget wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    reserveWorkerAiProviderAttemptMock.mockResolvedValue(admittedReservation());
  });

  afterEach(() => {
    jest.useRealTimers();
    resetClient();
    resetOpenAIAdapter();
    resetCredentialCache();
    globalThis.fetch = originalFetch;
    if (originalOpenAIKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAIKey;
    }
    if (originalOpenAIBaseURL === undefined) {
      delete process.env.OPENAI_BASE_URL;
    } else {
      process.env.OPENAI_BASE_URL = originalOpenAIBaseURL;
    }
    if (originalOpenAIApiBaseURL === undefined) {
      delete process.env.OPENAI_API_BASE_URL;
    } else {
      process.env.OPENAI_API_BASE_URL = originalOpenAIApiBaseURL;
    }
    if (originalOpenAIApiBase === undefined) {
      delete process.env.OPENAI_API_BASE;
    } else {
      process.env.OPENAI_API_BASE = originalOpenAIApiBase;
    }
    if (originalWorkerApiTimeoutMs === undefined) {
      delete process.env.WORKER_API_TIMEOUT_MS;
    } else {
      process.env.WORKER_API_TIMEOUT_MS = originalWorkerApiTimeoutMs;
    }
  });

  it('turns an exhausted worker provider probe into a budget pause without native transport', async () => {
    const nativeFetch = jest.fn();
    const onOperationalFailure = jest.fn();
    configureWorkerOpenAI(nativeFetch);
    reserveWorkerAiProviderAttemptMock.mockResolvedValueOnce({
      ...admittedReservation(),
      allowed: false,
      used: 2,
      remaining: 0,
      nextAvailableAt: '2026-08-30T15:00:00.000Z'
    });
    const context = createWorkerContext(onOperationalFailure);

    await expect(runWithAiExecutionContext(
      context,
      () => probeOpenAIProviderHealth({
        force: true,
        source: 'job_runner:async-queue-slot-1'
      })
    )).rejects.toBeInstanceOf(WorkerAiCallBudgetPausedError);

    expect(reserveWorkerAiProviderAttemptMock).toHaveBeenCalledTimes(1);
    expect(reserveWorkerAiProviderAttemptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: '00000000-0000-0000-0000-000000000000',
        operation: '/v1/models',
        statsWorkerId: 'async-queue',
        workerId: 'async-queue-slot-1'
      })
    );
    expect(nativeFetch).not.toHaveBeenCalled();
    expect(context.workerBudgetFailure).toBeInstanceOf(WorkerAiCallBudgetPausedError);
    expect(onOperationalFailure).toHaveBeenCalledWith(
      expect.any(WorkerAiCallBudgetPausedError)
    );
  });

  it('reserves exactly one worker unit for one admitted provider-health transport', async () => {
    const nativeFetch = jest.fn(async () => modelListResponse());
    configureWorkerOpenAI(nativeFetch);

    await expect(runWithAiExecutionContext(
      createWorkerContext(),
      () => probeOpenAIProviderHealth({
        force: true,
        source: 'job_runner:async-queue-slot-1'
      })
    )).resolves.toMatchObject({ ok: true });

    expect(reserveWorkerAiProviderAttemptMock).toHaveBeenCalledTimes(1);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it('does not let a throwing transport-ready observer strand an admitted probe', async () => {
    const nativeFetch = jest.fn(async () => modelListResponse());
    configureWorkerOpenAI(nativeFetch);
    const context = createWorkerContext();
    context.workerBudgetTransportReady = () => {
      throw new Error('transport observer failed');
    };

    await expect(runWithAiExecutionContext(
      context,
      () => probeOpenAIProviderHealth({
        force: true,
        source: 'job_runner:throwing-transport-observer'
      })
    )).resolves.toMatchObject({ ok: true });

    expect(reserveWorkerAiProviderAttemptMock).toHaveBeenCalledTimes(1);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it('rotates the configured unified client before one metered recovery probe', async () => {
    const rotatedApiKey = buildSyntheticOpenAIKey('worker-budget-rotated');
    const observedRequests: Request[] = [];
    const nativeFetch = jest.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      observedRequests.push(new Request(input, init));
      return modelListResponse();
    });
    configureWorkerOpenAI(nativeFetch, {
      apiKey: buildSyntheticOpenAIKey('worker-budget-initial'),
      baseURL: 'https://initial.openai.test/v1'
    });
    const initialClient = getOrCreateClient();
    expect(initialClient).not.toBeNull();

    process.env.OPENAI_API_KEY = rotatedApiKey;
    process.env.OPENAI_BASE_URL = 'https://rotated.openai.test/v1';

    expect(syncOpenAIProviderRuntime({
      forceReload: true,
      reason: 'worker_budget_rotation_test'
    })).toMatchObject({ reloaded: true });
    const rotatedClient = getOrCreateClient();
    expect(rotatedClient).not.toBeNull();
    expect(rotatedClient).not.toBe(initialClient);

    await expect(runWithAiExecutionContext(
      createWorkerContext(),
      () => probeOpenAIProviderHealth({
        force: true,
        source: 'job_runner:rotated-provider'
      })
    )).resolves.toMatchObject({ ok: true });

    expect(reserveWorkerAiProviderAttemptMock).toHaveBeenCalledTimes(1);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    expect(observedRequests).toHaveLength(1);
    expect(observedRequests[0]?.url).toMatch(
      /^https:\/\/rotated\.openai\.test\/v1\/models(?:\?|$)/u
    );
    expect(observedRequests[0]?.headers.get('authorization')).toBe(
      `Bearer ${rotatedApiKey}`
    );
  });

  it('keeps SDK and provider timeouts off slow admission, then times the one transport', async () => {
    jest.useFakeTimers();
    process.env.WORKER_API_TIMEOUT_MS = '30000';
    let observedSignal: AbortSignal | null = null;
    let timerCountAtTransport = 0;
    const nativeFetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      timerCountAtTransport = jest.getTimerCount();
      const request = new Request(input, init);
      observedSignal = request.signal;
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          reject(request.signal.reason);
        }, { once: true });
      });
    });
    configureWorkerOpenAI(nativeFetch);
    let resolveAdmission: ((value: ReturnType<typeof admittedReservation>) => void) | null = null;
    let markAdmissionStarted: (() => void) | null = null;
    let admittedReservations = 0;
    const admissionStarted = new Promise<void>(resolve => {
      markAdmissionStarted = resolve;
    });
    reserveWorkerAiProviderAttemptMock.mockImplementationOnce(() => {
      markAdmissionStarted?.();
      return new Promise<ReturnType<typeof admittedReservation>>(resolve => {
        resolveAdmission = resolve;
      });
    });
    let probeSettled = false;
    const probePromise = Promise.resolve(runWithAiExecutionContext(
      createWorkerContext(),
      () => probeOpenAIProviderHealth({
        force: true,
        source: 'job_runner:slow-budget-admission',
        timeoutMs: 1_000
      })
    )).finally(() => {
      probeSettled = true;
    });

    await admissionStarted;
    const runtimeBefore = getOpenAIProviderRuntimeStatus();
    await jest.advanceTimersByTimeAsync(31_000);
    const timerCountDuringAdmission = jest.getTimerCount();

    expect(probeSettled).toBe(false);
    expect(admittedReservations).toBe(0);
    expect(nativeFetch).not.toHaveBeenCalled();
    expect(getOpenAIProviderRuntimeStatus()).toEqual(runtimeBefore);

    admittedReservations += 1;
    resolveAdmission?.(admittedReservation());
    while (nativeFetch.mock.calls.length === 0) {
      await Promise.resolve();
    }
    expect(timerCountAtTransport).toBe(timerCountDuringAdmission + 1);
    expect(observedSignal?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(probePromise).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining('timed out after 1000ms')
    });

    expect(admittedReservations).toBe(1);
    expect(observedSignal?.aborted).toBe(true);
    expect(reserveWorkerAiProviderAttemptMock).toHaveBeenCalledTimes(1);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it('arms and aborts the probe timeout for a prefixed base URL transport', async () => {
    jest.useFakeTimers();
    let observedRequest: Request | null = null;
    const nativeFetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      observedRequest = new Request(input, init);
      return new Promise<Response>((_resolve, reject) => {
        const signal = observedRequest?.signal;
        signal?.addEventListener('abort', () => {
          reject(signal.reason);
        }, { once: true });
      });
    });
    configureWorkerOpenAI(nativeFetch, {
      baseURL: 'https://gateway.openai.test/proxy/v1'
    });
    const probePromise = Promise.resolve(runWithAiExecutionContext(
      createWorkerContext(),
      () => probeOpenAIProviderHealth({
        force: true,
        source: 'job_runner:prefixed-provider',
        timeoutMs: 1_000
      })
    ));

    while (nativeFetch.mock.calls.length === 0) {
      await Promise.resolve();
    }
    expect(observedRequest?.url).toMatch(
      /^https:\/\/gateway\.openai\.test\/proxy\/v1\/models(?:\?|$)/u
    );
    await jest.advanceTimersByTimeAsync(1_000);

    await expect(probePromise).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining('timed out after 1000ms')
    });
    expect(observedRequest?.signal.aborted).toBe(true);
    expect(reserveWorkerAiProviderAttemptMock).toHaveBeenCalledTimes(1);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it('does not let a pending final-capacity report delay transport or its timeout', async () => {
    jest.useFakeTimers();
    reserveWorkerAiProviderAttemptMock.mockResolvedValueOnce({
      ...admittedReservation(),
      remaining: 0,
      nextAvailableAt: '2026-08-30T15:00:00.000Z'
    });
    const onCapacityExhausted = jest.fn(() => new Promise<void>(() => {}));
    let observedSignal: AbortSignal | null = null;
    const nativeFetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      observedSignal = request.signal;
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          reject(request.signal.reason);
        }, { once: true });
      });
    });
    configureWorkerOpenAI(nativeFetch);
    const context = createAiExecutionContext({
      sourceType: 'background',
      sourceName: 'worker-final-capacity-report-test',
      workerBudget: {
        statsWorkerId: 'async-queue',
        workerId: 'async-queue-slot-1',
        maxCallsPerHour: 2,
        onCapacityExhausted
      }
    });
    const probePromise = Promise.resolve(runWithAiExecutionContext(
      context,
      () => probeOpenAIProviderHealth({
        force: true,
        source: 'job_runner:pending-final-capacity-report',
        timeoutMs: 1_000
      })
    ));

    while (nativeFetch.mock.calls.length === 0) {
      await Promise.resolve();
    }
    expect(onCapacityExhausted).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1_000);

    await expect(probePromise).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining('timed out after 1000ms')
    });
    expect(observedSignal?.aborted).toBe(true);
    expect(reserveWorkerAiProviderAttemptMock).toHaveBeenCalledTimes(1);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it('charges conservatively when an external abort arrives after admission but before transport', async () => {
    reserveWorkerAiProviderAttemptMock.mockResolvedValueOnce({
      ...admittedReservation(),
      remaining: 0,
      nextAvailableAt: '2026-08-30T15:00:00.000Z'
    });
    const controller = new AbortController();
    const nativeFetch = jest.fn(async () => modelListResponse());
    const budgetedFetch = createWorkerBudgetedOpenAIFetch(
      nativeFetch as unknown as typeof globalThis.fetch
    );
    const onCapacityExhausted = jest.fn(() => {
      controller.abort(new Error('cancelled after committed admission'));
    });
    const context = createAiExecutionContext({
      sourceType: 'background',
      sourceName: 'worker-post-admission-abort-test',
      workerBudget: {
        statsWorkerId: 'async-queue',
        workerId: 'async-queue-slot-1',
        maxCallsPerHour: 2,
        onCapacityExhausted
      }
    });

    const response = await runWithAiExecutionContext(
      context,
      () => budgetedFetch('https://api.openai.test/v1/models', {
        signal: controller.signal
      })
    );

    expect(response).toBeInstanceOf(Response);
    await expect((response as Response).json()).resolves.toMatchObject({
      error: {
        code: 'worker_ai_call_budget_dependency_unavailable'
      }
    });
    expect(onCapacityExhausted).toHaveBeenCalledTimes(1);
    expect(reserveWorkerAiProviderAttemptMock).toHaveBeenCalledTimes(1);
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it('disables SDK retries for a retryable provider-health failure', async () => {
    const nativeFetch = jest.fn(async () => modelListResponse(500));
    configureWorkerOpenAI(nativeFetch);

    await expect(runWithAiExecutionContext(
      createWorkerContext(),
      () => probeOpenAIProviderHealth({
        force: true,
        source: 'job_runner:no-probe-retries'
      })
    )).resolves.toMatchObject({ ok: false });

    expect(reserveWorkerAiProviderAttemptMock).toHaveBeenCalledTimes(1);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it('routes the ambient semantic planner through the configured adapter and one reservation', async () => {
    const plannerOutput = {
      action: 'queue.inspect',
      payload: {},
      confidence: 0.95,
      requiresConfirmation: false,
      reason: 'queue_status_requested',
      candidates: []
    };
    const nativeFetch = jest.fn(async () => new Response(JSON.stringify({
      id: 'resp_worker_planner',
      object: 'response',
      created_at: 1,
      status: 'completed',
      model: 'gpt-4.1-mini',
      output_text: JSON.stringify(plannerOutput),
      output: [{
        id: 'msg_worker_planner',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{
          type: 'output_text',
          text: JSON.stringify(plannerOutput),
          annotations: []
        }]
      }],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2
      }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));
    configureWorkerOpenAI(nativeFetch);
    const queueInspectAction = {
      action: 'queue.inspect',
      risk: 'readonly',
      requiresConfirmation: false,
      runner: { kind: 'local' }
    };
    const registry = {
      listActions: () => [queueInspectAction],
      getAction: (action: string) => action === queueInspectAction.action
        ? queueInspectAction
        : null
    };
    const context = createAiExecutionContext({
      sourceType: 'job',
      sourceName: 'gpt',
      jobId: '10000000-0000-4000-8000-000000000001',
      workerBudget: {
        statsWorkerId: 'async-queue',
        workerId: 'async-queue-slot-1',
        maxCallsPerHour: 2
      }
    });

    const plan = await runWithAiExecutionContext(
      context,
      () => resolveLlmDispatchPlan({
        utterance: 'show the queue',
        registry: registry as never,
      })
    );

    expect(plan).toMatchObject({
      action: 'queue.inspect',
      source: 'llm'
    });

    expect(reserveWorkerAiProviderAttemptMock).toHaveBeenCalledTimes(1);
    expect(reserveWorkerAiProviderAttemptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: '10000000-0000-4000-8000-000000000001',
        operation: '/v1/responses'
      })
    );
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    expect(context.workerBudgetFailure).toBeNull();
  });
});
