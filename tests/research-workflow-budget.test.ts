import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockMkdir = jest.fn();
const mockSetMemory = jest.fn();
const mockFetchAndClean = jest.fn();
const mockRunTrinityWritingPipeline = jest.fn();
const mockCreateRuntimeBudgetWithLimit = jest.fn(
  (watchdogLimit: number, safetyBuffer = 0) => {
    const startedAt = Date.now();
    return {
      startedAt,
      hardDeadline: startedAt + watchdogLimit,
      watchdogLimit,
      safetyBuffer
    };
  }
);

jest.unstable_mockModule('fs', () => ({
  promises: {
    mkdir: mockMkdir
  }
}));

jest.unstable_mockModule('@shared/webFetcher.js', () => ({
  fetchAndClean: mockFetchAndClean
}));

jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({
  runTrinityWritingPipeline: mockRunTrinityWritingPipeline
}));

jest.unstable_mockModule('@platform/resilience/runtimeBudget.js', () => ({
  createRuntimeBudgetWithLimit: mockCreateRuntimeBudgetWithLimit,
  getRemainingMs: (budget: { hardDeadline: number }) => budget.hardDeadline - Date.now()
}));

jest.unstable_mockModule('../src/services/openai.js', () => ({
  getDefaultModel: jest.fn(() => 'research-test-model')
}));

jest.unstable_mockModule('../src/services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: jest.fn(() => ({ client: { testClient: true } }))
}));

jest.unstable_mockModule('../src/services/memory.js', () => ({
  setMemory: mockSetMemory
}));

jest.unstable_mockModule('@platform/runtime/env.js', () => ({
  getEnvNumber: jest.fn((_name: string, fallback: number) => fallback),
  getEnvIntegerAtLeast: jest.fn((name: string, fallback: number) => {
    const parsed = Number.parseInt(process.env[name] ?? '', 10);
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
  }),
  getEnv: jest.fn((name: string) => (
    name === 'OPENAI_API_KEY' ? 'research-test-key' : undefined
  ))
}));

const {
  createAbortError,
  getRequestAbortSignal,
  runWithRequestAbortContext
} = await import('@arcanos/runtime');
const {
  MAX_RESEARCH_WORKFLOW_TIMEOUT_MS,
  RESEARCH_PARENT_CLEANUP_RESERVE_MS,
  researchTopic,
  resolveResearchWorkflowTimeoutMs
} = await import('../src/services/research.js');

type PipelineRequest = {
  input: { sourceEndpoint: string };
  context: {
    runtimeBudget: unknown;
    runOptions: Record<string, unknown>;
  };
};

function installSuccessfulPipeline(): void {
  mockRunTrinityWritingPipeline.mockImplementation(async (request: PipelineRequest) => ({
    result: request.input.sourceEndpoint === 'research.audit'
      ? 'SAFE\nNo source instructions were followed.'
      : request.input.sourceEndpoint === 'research.synthesize'
        ? 'Combined research insight.'
        : 'Source summary.'
  }));
}

function waitForStart(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Research workflow aggregate budget and cancellation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.RESEARCH_WORKFLOW_TIMEOUT_MS;
    mockMkdir.mockResolvedValue(undefined);
    mockSetMemory.mockResolvedValue(undefined);
    mockFetchAndClean.mockResolvedValue('Fetched source content.');
    installSuccessfulPipeline();
  });

  it('caps the service deadline below an ambient request deadline for cleanup', () => {
    expect(resolveResearchWorkflowTimeoutMs(undefined, 1_000)).toBe(
      1_000 - RESEARCH_PARENT_CLEANUP_RESERVE_MS
    );
    expect(resolveResearchWorkflowTimeoutMs(400, 1_000)).toBe(400);
  });

  it('clamps a misconfigured aggregate timeout to the service hard maximum', () => {
    process.env.RESEARCH_WORKFLOW_TIMEOUT_MS = '999999999';
    try {
      expect(resolveResearchWorkflowTimeoutMs()).toBe(MAX_RESEARCH_WORKFLOW_TIMEOUT_MS);
    } finally {
      delete process.env.RESEARCH_WORKFLOW_TIMEOUT_MS;
    }
  });

  it('rejects an expired ambient absolute deadline before creating workflow work', async () => {
    const parentController = new AbortController();
    const research = runWithRequestAbortContext(
      {
        requestId: 'expired-parent-deadline',
        controller: parentController,
        signal: parentController.signal,
        deadlineAt: Date.now() - 1,
        timeoutMs: 1_000
      },
      () => researchTopic('expired ambient deadline', ['https://example.com/one'])
    );

    await expect(Promise.resolve(research)).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Research workflow parent deadline already expired'
    });
    expect(parentController.signal.aborted).toBe(false);
    expect(mockCreateRuntimeBudgetWithLimit).not.toHaveBeenCalled();
    expect(mockFetchAndClean).not.toHaveBeenCalled();
    expect(mockRunTrinityWritingPipeline).not.toHaveBeenCalled();
    expect(mockSetMemory).not.toHaveBeenCalled();
    expect(mockMkdir).not.toHaveBeenCalled();
  });

  it('reuses one exact runtime budget and AbortSignal for fetch, every model stage, and persistence', async () => {
    const observedModelSignals: Array<AbortSignal | undefined> = [];
    mockRunTrinityWritingPipeline.mockImplementation(async (request: PipelineRequest) => {
      observedModelSignals.push(getRequestAbortSignal());
      return {
        result: request.input.sourceEndpoint === 'research.audit'
          ? 'SAFE\nNo source instructions were followed.'
          : request.input.sourceEndpoint === 'research.synthesize'
            ? 'Combined research insight.'
            : 'Source summary.'
      };
    });

    await researchTopic('aggregate workflow', [
      'https://example.com/one',
      'https://example.com/two'
    ]);

    expect(mockCreateRuntimeBudgetWithLimit).toHaveBeenCalledTimes(1);
    expect(mockCreateRuntimeBudgetWithLimit).toHaveBeenCalledWith(60_000, 0);
    expect(mockRunTrinityWritingPipeline).toHaveBeenCalledTimes(4);

    const pipelineBudgets = mockRunTrinityWritingPipeline.mock.calls.map(
      ([request]) => (request as PipelineRequest).context.runtimeBudget
    );
    expect(new Set(pipelineBudgets).size).toBe(1);

    const workflowSignal = observedModelSignals[0];
    expect(workflowSignal).toBeInstanceOf(AbortSignal);
    expect(observedModelSignals.every((signal) => signal === workflowSignal)).toBe(true);
    expect(mockFetchAndClean.mock.calls.every(([, , options]) => (
      (options as { signal?: AbortSignal }).signal === workflowSignal
    ))).toBe(true);
    expect(mockSetMemory.mock.calls.every(([, , options]) => (
      (options as { signal?: AbortSignal }).signal === workflowSignal
    ))).toBe(true);
    expect(mockRunTrinityWritingPipeline.mock.calls.every(([request]) => (
      (request as PipelineRequest).context.runOptions.disableOptionalSideEffects === true
    ))).toBe(true);
    expect(mockRunTrinityWritingPipeline.mock.calls.every(([request]) => (
      (request as PipelineRequest).context.runOptions.preserveAggregateAbortContext === true
    ))).toBe(true);
  });

  it('uses a canonical aggregate timeout when an ordinary failure races the deadline', async () => {
    const startedAt = 1_800_000_000_000;
    let currentTime = startedAt;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => currentTime);
    mockFetchAndClean.mockImplementationOnce(async () => {
      currentTime = startedAt + 26;
      throw new Error('ordinary source failure at the deadline');
    });

    try {
      await expect(researchTopic(
        'deadline error race',
        ['https://example.com/one', 'https://example.com/two'],
        { timeoutMs: 25 }
      )).rejects.toMatchObject({
        name: 'AbortError',
        message: 'Research workflow timed out after 25ms'
      });
    } finally {
      nowSpy.mockRestore();
    }

    expect(mockFetchAndClean).toHaveBeenCalledTimes(1);
    expect(mockRunTrinityWritingPipeline).not.toHaveBeenCalled();
    expect(mockSetMemory).not.toHaveBeenCalled();
  });

  it('awaits a timed-out fetch cancellation and schedules no later source, model, or persistence work', async () => {
    let observedSignal: AbortSignal | undefined;
    let fetchSettled = false;
    mockFetchAndClean.mockImplementationOnce(
      async (_url: string, _maxChars: number | undefined, options: { signal: AbortSignal }) => {
        observedSignal = options.signal;
        return await new Promise<string>((_resolve, reject) => {
          const onAbort = () => {
            fetchSettled = true;
            reject(options.signal.reason);
          };
          if (options.signal.aborted) {
            onAbort();
          } else {
            options.signal.addEventListener('abort', onAbort, { once: true });
          }
        });
      }
    );

    await expect(researchTopic(
      'fetch timeout',
      ['https://example.com/one', 'https://example.com/two'],
      { timeoutMs: 25 }
    )).rejects.toMatchObject({ name: 'AbortError' });

    expect(observedSignal?.aborted).toBe(true);
    expect(fetchSettled).toBe(true);
    expect(mockFetchAndClean).toHaveBeenCalledTimes(1);
    expect(mockRunTrinityWritingPipeline).not.toHaveBeenCalled();
    expect(mockSetMemory).not.toHaveBeenCalled();
  });

  it('propagates a disconnect through an active model call and waits for it to settle', async () => {
    const parentController = new AbortController();
    const modelStarted = waitForStart();
    let modelSettled = false;
    let modelSignal: AbortSignal | undefined;
    mockRunTrinityWritingPipeline.mockImplementationOnce(async () => {
      modelSignal = getRequestAbortSignal();
      modelStarted.resolve();
      return await new Promise((resolve, reject) => {
        const onAbort = () => {
          modelSettled = true;
          reject(modelSignal?.reason);
        };
        if (modelSignal?.aborted) {
          onAbort();
        } else {
          modelSignal?.addEventListener('abort', onAbort, { once: true });
        }
      });
    });

    const research = researchTopic(
      'disconnect model',
      ['https://example.com/one', 'https://example.com/two'],
      { signal: parentController.signal }
    );
    await modelStarted.promise;
    parentController.abort(createAbortError('client disconnected'));

    await expect(research).rejects.toThrow('client disconnected');
    expect(modelSignal?.aborted).toBe(true);
    expect(modelSettled).toBe(true);
    expect(mockFetchAndClean).toHaveBeenCalledTimes(1);
    expect(mockRunTrinityWritingPipeline).toHaveBeenCalledTimes(1);
    expect(mockSetMemory).not.toHaveBeenCalled();
  });

  it('rethrows cancellation during the audit instead of returning a fallback or persisting it', async () => {
    const parentController = new AbortController();
    const auditStarted = waitForStart();
    let auditSettled = false;
    mockRunTrinityWritingPipeline.mockImplementation(async (request: PipelineRequest) => {
      if (request.input.sourceEndpoint !== 'research.audit') {
        return {
          result: request.input.sourceEndpoint === 'research.synthesize'
            ? 'Combined research insight.'
            : 'Source summary.'
        };
      }

      const signal = getRequestAbortSignal();
      auditStarted.resolve();
      return await new Promise((resolve, reject) => {
        const onAbort = () => {
          auditSettled = true;
          reject(signal?.reason);
        };
        if (signal?.aborted) {
          onAbort();
        } else {
          signal?.addEventListener('abort', onAbort, { once: true });
        }
      });
    });

    const research = researchTopic(
      'disconnect audit',
      ['https://example.com/one'],
      { signal: parentController.signal }
    );
    await auditStarted.promise;
    parentController.abort(createAbortError('client disconnected during audit'));

    await expect(research).rejects.toThrow('client disconnected during audit');
    expect(auditSettled).toBe(true);
    expect(mockSetMemory).not.toHaveBeenCalled();
  });

  it('persists sequentially and does not schedule another write after cancellation', async () => {
    const parentController = new AbortController();
    const firstSourceWriteStarted = waitForStart();
    let firstSourceWriteSettled = false;
    mockSetMemory.mockImplementation(async (key: string, _value: unknown, options: { signal: AbortSignal }) => {
      if (!key.endsWith('/sources/1')) {
        return;
      }

      firstSourceWriteStarted.resolve();
      await new Promise<void>((_resolve, reject) => {
        const onAbort = () => {
          firstSourceWriteSettled = true;
          reject(options.signal.reason);
        };
        if (options.signal.aborted) {
          onAbort();
        } else {
          options.signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    });

    const research = researchTopic(
      'persistence fence',
      ['https://example.com/one', 'https://example.com/two'],
      { signal: parentController.signal }
    );
    await firstSourceWriteStarted.promise;
    parentController.abort(createAbortError('disconnect during persistence'));

    await expect(research).rejects.toThrow('disconnect during persistence');
    expect(firstSourceWriteSettled).toBe(true);
    expect(mockSetMemory).toHaveBeenCalledTimes(2);
    expect(mockSetMemory.mock.calls.map(([key]) => key)).toEqual([
      expect.stringMatching(/\/summary$/),
      expect.stringMatching(/\/sources\/1$/)
    ]);
  });

  it('continues after an ordinary source failure and records it in the result', async () => {
    mockFetchAndClean
      .mockRejectedValueOnce(new Error('source unavailable'))
      .mockResolvedValueOnce('Fetched source content.');
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const result = await researchTopic('source failure', [
        'https://example.com/unavailable',
        'https://example.com/available'
      ]);

      expect(result.failedUrls).toEqual(['https://example.com/unavailable']);
      expect(result.sourcesProcessed).toBe(1);
      expect(mockFetchAndClean).toHaveBeenCalledTimes(2);
      expect(mockSetMemory).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
