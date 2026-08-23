import { afterEach, describe, it, expect, beforeEach, jest } from '@jest/globals';
import {
  createChatCompletionWithFallback,
  createSingleChatCompletion,
  getCircuitBreakerSnapshot,
  getDefaultModel,
  getGPT5Model,
  getFallbackModel
} from '../src/services/openai.js';
import {
  createAbortError,
  runWithRequestAbortContext,
  runWithRequestAbortTimeout
} from '@arcanos/runtime';
import {
  getTelemetrySnapshot,
  resetTelemetry,
} from '../src/platform/logging/telemetry.js';

async function restoreCircuitBreakerIsolation(): Promise<void> {
  const snapshot = getCircuitBreakerSnapshot();
  if (snapshot.state === 'CLOSED' && snapshot.failureCount === 0) {
    return;
  }

  const healthyCreate = jest.fn().mockResolvedValue({
    id: 'test-breaker-recovery',
    model: 'gpt-4.1',
    status: 'completed',
    output_text: 'Recovered for test isolation.'
  });
  const recoveryCalls = snapshot.state === 'CLOSED' ? 1 : 2;
  const now = snapshot.state === 'OPEN'
    ? jest.spyOn(Date, 'now').mockReturnValue(
        snapshot.lastFailureTime
          + snapshot.constants.CIRCUIT_BREAKER_RESET_TIMEOUT_MS
          + 1
      )
    : undefined;

  try {
    for (let index = 0; index < recoveryCalls; index += 1) {
      await createSingleChatCompletion(
        { responses: { create: healthyCreate } } as any,
        { model: 'gpt-4.1', messages: [] }
      );
    }
  } finally {
    now?.mockRestore();
  }

  expect(getCircuitBreakerSnapshot()).toMatchObject({
    state: 'CLOSED',
    failureCount: 0
  });
}

describe('createChatCompletionWithFallback', () => {
  beforeEach(async () => {
    jest.restoreAllMocks();
    await restoreCircuitBreakerIsolation();
    resetTelemetry();
  });

  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    await restoreCircuitBreakerIsolation();
  });

  it('attempts models in the expected fallback order', async () => {
    const primaryModel = getDefaultModel();
    const gpt5Model = getGPT5Model();
    const finalModel = getFallbackModel();

    const createSpy = jest
      .fn()
      .mockRejectedValueOnce(new Error('primary failure'))
      .mockRejectedValueOnce(new Error('retry failure'))
      .mockRejectedValueOnce(new Error('gpt5 failure'))
      .mockResolvedValueOnce({
        id: 'final',
        model: finalModel,
        status: 'completed',
        output_text: ''
      });

    const client = {
      responses: {
        create: createSpy
      }
    } as any;

    const result = await createChatCompletionWithFallback(client, { messages: [] });

    expect(createSpy).toHaveBeenCalledTimes(4);
    expect(createSpy.mock.calls[0][0].model).toBe(primaryModel);
    expect(createSpy.mock.calls[1][0].model).toBe(primaryModel);
    expect(createSpy.mock.calls[2][0].model).toBe(gpt5Model);
    expect(createSpy.mock.calls[3][0].model).toBe(finalModel);
    expect(result.activeModel).toBe(finalModel);
    expect(result.fallbackFlag).toBe(true);
  });

  it('does not return incomplete provider output as a successful single completion', async () => {
    const createSpy = jest.fn().mockResolvedValue({
      id: 'resp_incomplete_single',
      model: 'gpt-4.1',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output_text: '1. Open with threat. 2. Keep mitigation',
      output: [],
      usage: { input_tokens: 8, output_tokens: 16, total_tokens: 24 }
    });

    const client = {
      responses: {
        create: createSpy
      }
    } as any;

    await expect(
      createSingleChatCompletion(client, {
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'SWTOR tanking guide' }]
      })
    ).rejects.toMatchObject({
      code: 'OPENAI_COMPLETION_INCOMPLETE',
      finishReason: 'length',
      incompleteReason: 'max_output_tokens',
      truncated: true,
      lengthTruncated: true
    });
  });

  it('emits chat reasoning effort in the Responses request shape', async () => {
    const createSpy = jest.fn().mockResolvedValue({
      id: 'resp_reasoning_effort',
      model: 'gpt-5.1',
      status: 'completed',
      output_text: 'Complete booking output.',
      output: []
    });
    const client = {
      responses: {
        create: createSpy
      }
    } as any;

    await createSingleChatCompletion(client, {
      model: 'gpt-5.1',
      messages: [{ role: 'user', content: 'Build a complete wrestling show.' }],
      max_completion_tokens: 777,
      reasoning_effort: 'none',
      timeoutMs: 42_000,
    });

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.1',
        max_output_tokens: 777,
        reasoning: { effort: 'none' }
      }),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        timeout: 42_000,
      })
    );
    expect(createSpy.mock.calls[0]?.[0]).not.toHaveProperty('reasoning_effort');
  });

  it('passes an extended finite GPT-5.1 budget to Responses and rejects truncation', async () => {
    const createSpy = jest.fn().mockResolvedValue({
      id: 'resp_extended_incomplete',
      model: 'gpt-5.1',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output_text: 'PRIVATE-PARTIAL-BOOKING-SENTINEL',
      output: [],
      usage: { input_tokens: 800, output_tokens: 6_000, total_tokens: 6_800 }
    });
    const client = {
      responses: {
        create: createSpy
      }
    } as any;

    await expect(createSingleChatCompletion(client, {
      model: 'gpt-5.1',
      messages: [{ role: 'user', content: 'Build a complete wrestling show.' }],
      max_completion_tokens: 6_000,
      reasoning_effort: 'none'
    })).rejects.toMatchObject({
      code: 'OPENAI_COMPLETION_INCOMPLETE',
      finishReason: 'length',
      incompleteReason: 'max_output_tokens',
      truncated: true,
      lengthTruncated: true
    });

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.1',
        max_output_tokens: 6_000,
        reasoning: { effort: 'none' }
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('omits blank chat reasoning effort from the Responses request shape', async () => {
    const createSpy = jest.fn().mockResolvedValue({
      id: 'resp_blank_reasoning_effort',
      model: 'gpt-5.1',
      status: 'completed',
      output_text: 'Complete booking output.',
      output: []
    });
    const client = {
      responses: {
        create: createSpy
      }
    } as any;

    await createSingleChatCompletion(client, {
      model: 'gpt-5.1',
      messages: [{ role: 'user', content: 'Build a complete wrestling show.' }],
      max_completion_tokens: 777,
      reasoning_effort: '   ' as never
    });

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.calls[0]?.[0]).not.toHaveProperty('reasoning');
    expect(createSpy.mock.calls[0]?.[0]).not.toHaveProperty('reasoning_effort');
  });

  it('falls through to another model when a fallback-sequence attempt is incomplete', async () => {
    const primaryModel = getDefaultModel();
    const gpt5Model = getGPT5Model();

    const createSpy = jest
      .fn()
      .mockResolvedValueOnce({
        id: 'resp_incomplete_primary',
        model: primaryModel,
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output_text: 'partial guide',
        output: [],
        usage: { input_tokens: 8, output_tokens: 16, total_tokens: 24 }
      })
      .mockResolvedValueOnce({
        id: 'resp_complete_retry',
        model: primaryModel,
        status: 'completed',
        output_text: 'Complete guide answer.',
        output: [],
        usage: { input_tokens: 8, output_tokens: 20, total_tokens: 28 }
      });

    const client = {
      responses: {
        create: createSpy
      }
    } as any;

    const result = await createChatCompletionWithFallback(client, {
      messages: [{ role: 'user', content: 'SWTOR tanking guide' }]
    });

    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(createSpy.mock.calls[0][0].model).toBe(primaryModel);
    expect(createSpy.mock.calls[1][0].model).toBe(primaryModel);
    expect(createSpy.mock.calls[1][0].model).not.toBe(gpt5Model);
    expect(result.choices[0]?.message.content).toBe('Complete guide answer.');
    expect(result.choices[0]?.finish_reason).toBe('stop');
  });

  it('uses the exact aggregate signal and waits for provider drain when requested', async () => {
    const controller = new AbortController();
    const abortReason = createAbortError('caller disconnected');
    let startProvider!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      startProvider = resolve;
    });
    let releaseProvider!: () => void;
    const providerRelease = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let providerSignal: AbortSignal | undefined;
    let providerObservedAbort = false;
    let providerSettled = false;
    let completionSettled = false;
    const createSpy = jest.fn().mockImplementation(
      (_payload, options?: { signal?: AbortSignal }) => {
        providerSignal = options?.signal;
        startProvider();
        return new Promise((_resolve, reject) => {
          const onAbort = () => {
            providerObservedAbort = true;
            void providerRelease.then(() => {
              providerSettled = true;
              reject(new Error('provider transport closed after abort'));
            });
          };
          if (options?.signal?.aborted) {
            onAbort();
          } else {
            options?.signal?.addEventListener('abort', onAbort, { once: true });
          }
        });
      }
    );
    const client = {
      responses: {
        create: createSpy
      }
    } as any;

    const completionPromise = Promise.resolve(runWithRequestAbortContext(
      {
        requestId: 'aggregate-provider-signal',
        controller,
        signal: controller.signal,
        deadlineAt: Date.now() + 30_000,
        timeoutMs: 30_000
      },
      () => createSingleChatCompletion(client, {
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'Summarize the bounded research.' }],
        signal: controller.signal,
        preserveAggregateAbortContext: true
      })
    ));
    void completionPromise.then(
      () => { completionSettled = true; },
      () => { completionSettled = true; },
    );

    await providerStarted;
    expect(providerSignal).toBe(controller.signal);
    expect(createSpy.mock.calls[0]?.[1]).not.toHaveProperty('timeout');
    controller.abort(abortReason);
    await Promise.resolve();
    expect(providerObservedAbort).toBe(true);
    expect(providerSettled).toBe(false);
    expect(completionSettled).toBe(false);

    releaseProvider();
    await expect(completionPromise).rejects.toMatchObject({
      name: 'AbortError',
      message: abortReason.message
    });
    expect(providerSettled).toBe(true);
    expect(completionSettled).toBe(true);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps repeated in-flight aggregate cancellations breaker-neutral and admits later healthy work', async () => {
    const before = getCircuitBreakerSnapshot();
    expect(before.state).toBe('CLOSED');
    expect(before.failureCount).toBe(0);

    const createSpy = jest.fn().mockImplementation(
      (_payload, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const onAbort = () => reject(new Error('provider transport closed after abort'));
          if (options?.signal?.aborted) {
            onAbort();
          } else {
            options?.signal?.addEventListener('abort', onAbort, { once: true });
          }
        })
    );
    const client = { responses: { create: createSpy } } as any;
    const cancellationCount = before.constants.CIRCUIT_BREAKER_FAILURE_THRESHOLD;

    for (let index = 0; index < cancellationCount; index += 1) {
      const controller = new AbortController();
      const abortReason = createAbortError(`aggregate cancellation ${index + 1}`);
      const completion = Promise.resolve(runWithRequestAbortContext(
        {
          requestId: `aggregate-circuit-neutral-${index + 1}`,
          controller,
          signal: controller.signal,
          deadlineAt: Date.now() + 30_000,
          timeoutMs: 30_000
        },
        () => createSingleChatCompletion(client, {
          model: 'gpt-4.1',
          messages: [{ role: 'user', content: 'Summarize bounded research.' }],
          signal: controller.signal,
          preserveAggregateAbortContext: true
        })
      ));

      for (let attempt = 0; attempt < 5 && createSpy.mock.calls.length <= index; attempt += 1) {
        await Promise.resolve();
      }
      expect(createSpy).toHaveBeenCalledTimes(index + 1);
      controller.abort(abortReason);
      await expect(completion).rejects.toBe(abortReason);
    }

    expect(getCircuitBreakerSnapshot()).toMatchObject({
      state: 'CLOSED',
      failureCount: 0
    });
    const cancellationTelemetry = getTelemetrySnapshot();
    expect(cancellationTelemetry.metrics.operations['openai.failure']).toBeUndefined();
    expect(cancellationTelemetry.metrics.operations['openai.cancelled']?.count)
      .toBe(cancellationCount);
    expect(cancellationTelemetry.traces.recentEvents)
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'openai.resilience.failure' }),
      ]));

    const preCancelledController = new AbortController();
    const preCancelledReason = createAbortError('cancelled before admission');
    preCancelledController.abort(preCancelledReason);
    await expect(createSingleChatCompletion(client, {
      model: 'gpt-4.1',
      messages: [{ role: 'user', content: 'Do not admit cancelled work.' }],
      signal: preCancelledController.signal,
      preserveAggregateAbortContext: true
    })).rejects.toBe(preCancelledReason);
    expect(createSpy).toHaveBeenCalledTimes(cancellationCount);
    expect(getCircuitBreakerSnapshot()).toMatchObject({
      state: 'CLOSED',
      failureCount: 0
    });
    expect(getTelemetrySnapshot().metrics.operations['openai.cancelled']?.count)
      .toBe(cancellationCount + 1);

    const healthyCreate = jest.fn().mockResolvedValue({
      id: 'healthy-after-cancellations',
      model: 'gpt-4.1',
      status: 'completed',
      output_text: 'Healthy admitted result.'
    });
    const healthy = await createSingleChatCompletion(
      { responses: { create: healthyCreate } } as any,
      {
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'Run healthy admitted work.' }]
      }
    );

    expect(healthy.choices[0]?.message.content).toBe('Healthy admitted result.');
    expect(healthyCreate).toHaveBeenCalledTimes(1);
    expect(getCircuitBreakerSnapshot()).toMatchObject({
      state: 'CLOSED',
      failureCount: 0
    });
  });

  it('keeps ordinary ambient parent cancellations breaker- and failure-telemetry-neutral', async () => {
    const initial = getCircuitBreakerSnapshot();
    expect(initial).toMatchObject({ state: 'CLOSED', failureCount: 0 });
    const providerCreate = jest.fn().mockImplementation(
      (_payload, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const onAbort = () => reject(new Error('provider transport closed after parent abort'));
          if (options?.signal?.aborted) {
            onAbort();
          } else {
            options?.signal?.addEventListener('abort', onAbort, { once: true });
          }
        })
    );
    const client = { responses: { create: providerCreate } } as any;

    for (
      let index = 0;
      index < initial.constants.CIRCUIT_BREAKER_FAILURE_THRESHOLD;
      index += 1
    ) {
      const controller = new AbortController();
      const cancellation = createAbortError(`ordinary parent cancellation ${index + 1}`);
      const completion = Promise.resolve(runWithRequestAbortContext(
        {
          requestId: `ordinary-parent-cancel-${index + 1}`,
          controller,
          signal: controller.signal,
          deadlineAt: Date.now() + 30_000,
          timeoutMs: 30_000,
        },
        () => createSingleChatCompletion(client, {
          model: 'gpt-4.1',
          messages: [{ role: 'user', content: 'Run bounded synchronous work.' }],
          timeoutMs: 20_000,
        })
      ));

      for (
        let attempt = 0;
        attempt < 5 && providerCreate.mock.calls.length <= index;
        attempt += 1
      ) {
        await Promise.resolve();
      }
      controller.abort(cancellation);
      await expect(completion).rejects.toBe(cancellation);
    }

    expect(getCircuitBreakerSnapshot()).toMatchObject({
      state: 'CLOSED',
      failureCount: 0,
    });
    const telemetry = getTelemetrySnapshot();
    expect(telemetry.metrics.operations['openai.failure']).toBeUndefined();
    expect(telemetry.metrics.operations['openai.cancelled']?.count)
      .toBe(initial.constants.CIRCUIT_BREAKER_FAILURE_THRESHOLD);
    expect(telemetry.traces.recentEvents)
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'openai.resilience.failure' }),
      ]));
  });

  it.each([
    {
      label: 'an ordinary Error parent reason',
      createReason: () => new Error('ordinary parent cancellation')
    },
    {
      label: 'an AbortSignal.timeout-style TimeoutError reason',
      createReason: () => new DOMException('aggregate deadline elapsed', 'TimeoutError')
    }
  ])('keeps $label breaker-neutral after normalization', async ({ createReason }) => {
    expect(getCircuitBreakerSnapshot()).toMatchObject({
      state: 'CLOSED',
      failureCount: 0
    });

    const controller = new AbortController();
    let providerStarted!: () => void;
    const started = new Promise<void>(resolve => {
      providerStarted = resolve;
    });
    const providerCreate = jest.fn().mockImplementation(
      (_payload, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          providerStarted();
          const onAbort = () => reject(new Error('provider transport closed after caller abort'));
          if (options?.signal?.aborted) {
            onAbort();
          } else {
            options?.signal?.addEventListener('abort', onAbort, { once: true });
          }
        })
    );
    const reason = createReason();
    const completion = Promise.resolve(runWithRequestAbortContext(
      {
        requestId: 'normalized-aggregate-circuit-neutral',
        controller,
        signal: controller.signal,
        deadlineAt: Date.now() + 30_000,
        timeoutMs: 30_000
      },
      () => createSingleChatCompletion(
        { responses: { create: providerCreate } } as any,
        {
          model: 'gpt-4.1',
          messages: [{ role: 'user', content: 'Exercise normalized cancellation accounting.' }],
          signal: controller.signal,
          preserveAggregateAbortContext: true
        }
      )
    ));

    await started;
    controller.abort(reason);
    await expect(completion).rejects.toMatchObject({
      name: 'AbortError'
    });
    expect(providerCreate).toHaveBeenCalledTimes(1);
    expect(getCircuitBreakerSnapshot()).toMatchObject({
      state: 'CLOSED',
      failureCount: 0
    });
  });

  it('counts provider-originated AbortErrors and opens the breaker at its real failure threshold', async () => {
    const providerAbort = Object.assign(new Error('provider aborted its own request'), {
      name: 'AbortError'
    });
    const activeAggregateController = new AbortController();
    const providerCreate = jest.fn().mockRejectedValue(providerAbort);
    const client = { responses: { create: providerCreate } } as any;
    const initial = getCircuitBreakerSnapshot();
    expect(initial).toMatchObject({ state: 'CLOSED', failureCount: 0 });

    for (
      let index = 0;
      index < initial.constants.CIRCUIT_BREAKER_FAILURE_THRESHOLD;
      index += 1
    ) {
      await expect(createSingleChatCompletion(client, {
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'Exercise provider failure accounting.' }],
        signal: activeAggregateController.signal,
        preserveAggregateAbortContext: true
      })).rejects.toBe(providerAbort);
    }

    const opened = getCircuitBreakerSnapshot();
    expect(opened).toMatchObject({
      state: 'OPEN',
      failureCount: initial.constants.CIRCUIT_BREAKER_FAILURE_THRESHOLD
    });
    expect(providerCreate).toHaveBeenCalledTimes(
      initial.constants.CIRCUIT_BREAKER_FAILURE_THRESHOLD
    );
    const providerFailureTelemetry = getTelemetrySnapshot();
    expect(providerFailureTelemetry.metrics.operations['openai.failure']?.count)
      .toBe(initial.constants.CIRCUIT_BREAKER_FAILURE_THRESHOLD);
    expect(providerFailureTelemetry.traces.recentEvents)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'openai.resilience.failure' }),
      ]));

    const blockedHealthyCreate = jest.fn().mockResolvedValue({
      id: 'blocked-while-open',
      model: 'gpt-4.1',
      status: 'completed',
      output_text: 'must not run while open'
    });
    await expect(createSingleChatCompletion(
      { responses: { create: blockedHealthyCreate } } as any,
      { model: 'gpt-4.1', messages: [] }
    )).rejects.toThrow('Circuit breaker is OPEN');
    expect(blockedHealthyCreate).not.toHaveBeenCalled();

    const recoveredCreate = jest.fn().mockResolvedValue({
      id: 'breaker-recovery',
      model: 'gpt-4.1',
      status: 'completed',
      output_text: 'Recovered.'
    });
    const now = jest.spyOn(Date, 'now').mockReturnValue(
      opened.lastFailureTime + opened.constants.CIRCUIT_BREAKER_RESET_TIMEOUT_MS + 1
    );
    try {
      await createSingleChatCompletion(
        { responses: { create: recoveredCreate } } as any,
        { model: 'gpt-4.1', messages: [] }
      );
      await createSingleChatCompletion(
        { responses: { create: recoveredCreate } } as any,
        { model: 'gpt-4.1', messages: [] }
      );
    } finally {
      now.mockRestore();
    }
    expect(getCircuitBreakerSnapshot()).toMatchObject({
      state: 'CLOSED',
      failureCount: 0
    });
  });

  it.each([
    ['aggregate provider boundary', true],
    ['linked timeout boundary', false],
  ] as const)('preserves a provider-first AbortError through the %s when caller cancellation lands in the same turn', async (_caseName, preserveAggregateAbortContext) => {
    const providerAbort = Object.assign(new Error('provider settled before caller cancellation'), {
      name: 'AbortError'
    });
    const initial = getCircuitBreakerSnapshot();
    const providerCreate = jest.fn();

    for (
      let index = 0;
      index < initial.constants.CIRCUIT_BREAKER_FAILURE_THRESHOLD;
      index += 1
    ) {
      const controller = new AbortController();
      const callerAbort = createAbortError(`later caller cancellation ${index + 1}`);
      let rejectProvider!: (error: unknown) => void;
      let notifyProviderStarted!: () => void;
      const providerStarted = new Promise<void>(resolve => {
        notifyProviderStarted = resolve;
      });
      providerCreate.mockImplementationOnce(() => new Promise((_resolve, reject) => {
        rejectProvider = reject;
        notifyProviderStarted();
      }));

      const completion = createSingleChatCompletion(
        { responses: { create: providerCreate } } as any,
        {
          model: 'gpt-4.1',
          messages: [{ role: 'user', content: 'Preserve provider failure provenance.' }],
          signal: controller.signal,
          preserveAggregateAbortContext
        }
      );
      await providerStarted;
      rejectProvider(providerAbort);
      controller.abort(callerAbort);

      await expect(completion).rejects.toBe(providerAbort);
    }

    expect(getCircuitBreakerSnapshot()).toMatchObject({
      state: 'OPEN',
      failureCount: initial.constants.CIRCUIT_BREAKER_FAILURE_THRESHOLD
    });
    const telemetry = getTelemetrySnapshot();
    expect(telemetry.metrics.operations['openai.failure']?.count)
      .toBe(initial.constants.CIRCUIT_BREAKER_FAILURE_THRESHOLD);
    expect(telemetry.metrics.operations['openai.cancelled']).toBeUndefined();
  });

  it('preserves a pre-admitted caller cancellation while the circuit breaker is open', async () => {
    const initial = getCircuitBreakerSnapshot();
    const providerFailure = new Error('provider unavailable');
    const failingCreate = jest.fn().mockRejectedValue(providerFailure);

    for (
      let index = 0;
      index < initial.constants.CIRCUIT_BREAKER_FAILURE_THRESHOLD;
      index += 1
    ) {
      await expect(createSingleChatCompletion(
        { responses: { create: failingCreate } } as any,
        { model: 'gpt-4.1', messages: [] }
      )).rejects.toBe(providerFailure);
    }
    expect(getCircuitBreakerSnapshot().state).toBe('OPEN');

    const cancelledCreate = jest.fn();
    const controller = new AbortController();
    const callerReason = createAbortError('caller cancelled before provider admission');
    controller.abort(callerReason);

    await expect(createChatCompletionWithFallback(
      { responses: { create: cancelledCreate } } as any,
      {
        model: 'gpt-4.1',
        messages: [],
        signal: controller.signal,
      }
    )).rejects.toBe(callerReason);

    expect(cancelledCreate).not.toHaveBeenCalled();
    expect(getCircuitBreakerSnapshot()).toMatchObject({
      state: 'OPEN',
      failureCount: initial.constants.CIRCUIT_BREAKER_FAILURE_THRESHOLD,
    });
  });

  it('stops fallback expansion once the active request is aborted', async () => {
    jest.useFakeTimers();

    const createSpy = jest.fn().mockImplementation((_payload, options?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener(
          'abort',
          () => reject(options.signal?.reason ?? new Error('aborted')),
          { once: true }
        );
      });
    });

    const client = {
      responses: {
        create: createSpy
      }
    } as any;

    const resultPromise = runWithRequestAbortTimeout(
      {
        timeoutMs: 25,
        requestId: 'req_abort_fallback',
        abortMessage: 'GPT route timeout after 25ms'
      },
      () => createChatCompletionWithFallback(client, { messages: [] })
    );
    const rejectionExpectation = expect(resultPromise).rejects.toThrow('GPT route timeout after 25ms');

    await jest.advanceTimersByTimeAsync(30);

    await rejectionExpectation;
    expect(createSpy).toHaveBeenCalledTimes(1);
  });
});
