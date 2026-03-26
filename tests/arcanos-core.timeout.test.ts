import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const runThroughBrainMock = jest.fn();
const createRuntimeBudgetWithLimitMock = jest.fn((watchdogLimit: number, safetyBuffer = 0) => ({
  startedAt: 0,
  hardDeadline: watchdogLimit,
  watchdogLimit,
  safetyBuffer
}));
const loggerInfoMock = jest.fn();
const loggerWarnMock = jest.fn();
const loggerErrorMock = jest.fn();
const recordTraceEventMock = jest.fn();
const runWithRequestAbortTimeoutMock = jest.fn();
const getRequestAbortSignalMock = jest.fn(() => undefined);
const getRequestRemainingMsMock = jest.fn(() => null);
const isAbortErrorMock = jest.fn((error: unknown) => error instanceof Error && error.name === 'AbortError');

jest.unstable_mockModule('@core/logic/trinity.js', () => ({
  runThroughBrain: runThroughBrainMock
}));

jest.unstable_mockModule('@platform/resilience/runtimeBudget.js', () => ({
  createRuntimeBudgetWithLimit: createRuntimeBudgetWithLimitMock
}));

jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
  logger: {
    info: loggerInfoMock,
    warn: loggerWarnMock,
    error: loggerErrorMock
  },
  aiLogger: {
    info: loggerInfoMock,
    warn: loggerWarnMock,
    error: loggerErrorMock,
    debug: jest.fn()
  }
}));

jest.unstable_mockModule('@platform/logging/telemetry.js', () => ({
  recordTraceEvent: recordTraceEventMock
}));

jest.unstable_mockModule('@services/openai.js', () => ({
  generateMockResponse: jest.fn()
}));

jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: jest.fn(() => ({ client: { mock: true } }))
}));

jest.unstable_mockModule('@services/systemState.js', () => ({
  executeSystemStateRequest: jest.fn()
}));

jest.unstable_mockModule('@arcanos/runtime', () => ({
  runWithRequestAbortTimeout: runWithRequestAbortTimeoutMock,
  getRequestAbortSignal: getRequestAbortSignalMock,
  getRequestRemainingMs: getRequestRemainingMsMock,
  isAbortError: isAbortErrorMock
}));

const { runArcanosCoreQuery } = await import('../src/services/arcanos-core.js');

function createTrinityResult(overrides: Record<string, unknown> = {}) {
  return {
    result: 'Direct degraded answer',
    module: 'trinity',
    meta: {
      id: 'trinity-direct-1',
      created: 1772917000000
    },
    activeModel: 'gpt-4.1-mini',
    fallbackFlag: true,
    dryRun: false,
    fallbackSummary: {
      intakeFallbackUsed: false,
      gpt5FallbackUsed: false,
      finalFallbackUsed: true,
      fallbackReasons: ['Recovered via direct answer']
    },
    auditSafe: {
      mode: true,
      overrideUsed: false,
      auditFlags: [],
      processedSafely: true
    },
    memoryContext: {
      entriesAccessed: 0,
      contextSummary: 'No memory context available.',
      memoryEnhanced: false,
      maxRelevanceScore: 0,
      averageRelevanceScore: 0
    },
    taskLineage: {
      requestId: 'trinity-direct-1',
      logged: true
    },
    ...overrides
  };
}

describe('runArcanosCoreQuery timeout clamp', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ARCANOS_CORE_PIPELINE_TIMEOUT_MS;
    delete process.env.ARCANOS_CORE_DEGRADED_HEADROOM_MS;
    delete process.env.ARCANOS_CORE_DEGRADED_MAX_WORDS;
    getRequestRemainingMsMock.mockReturnValue(null);
  });

  it('recovers with a direct-answer degraded path when the shared core pipeline times out', async () => {
    const timeoutError = new Error('ARCANOS:CORE pipeline timeout after 3500ms');
    timeoutError.name = 'AbortError';

    runWithRequestAbortTimeoutMock
      .mockRejectedValueOnce(timeoutError)
      .mockImplementationOnce(async (_options: unknown, callback: () => Promise<unknown>) => await callback());
    runThroughBrainMock.mockResolvedValueOnce(createTrinityResult());

    const result = await runArcanosCoreQuery({
      client: {} as never,
      prompt: 'Summarize the service health quickly.',
      sourceEndpoint: 'api-arcanos.ask'
    });

    expect(runWithRequestAbortTimeoutMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        timeoutMs: 3000,
        abortMessage: 'ARCANOS:CORE pipeline timeout after 3000ms'
      }),
      expect.any(Function)
    );
    expect(runWithRequestAbortTimeoutMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        timeoutMs: 2000,
        abortMessage: 'ARCANOS:CORE degraded path timed out after 2000ms'
      }),
      expect.any(Function)
    );
    expect(createRuntimeBudgetWithLimitMock).toHaveBeenNthCalledWith(1, 3000, 250);
    expect(createRuntimeBudgetWithLimitMock).toHaveBeenNthCalledWith(2, 2000, 250);
    expect(runThroughBrainMock).toHaveBeenCalledWith(
      {} as never,
      'Summarize the service health quickly.',
      undefined,
      undefined,
      expect.objectContaining({
        sourceEndpoint: 'api-arcanos.ask.degraded',
        answerMode: 'direct',
        requestedVerbosity: 'minimal',
        maxWords: 60,
        strictUserVisibleOutput: true,
        directAnswerModelOverride: 'gpt-4.1-mini'
      }),
      expect.objectContaining({
        watchdogLimit: 2000,
        safetyBuffer: 250
      })
    );
    expect(result).toEqual(expect.objectContaining({
      timeoutKind: 'pipeline_timeout',
      degradedModeReason: 'arcanos_core_pipeline_timeout_direct_answer',
      bypassedSubsystems: expect.arrayContaining(['trinity_intake', 'trinity_reasoning', 'trinity_final'])
    }));
    expect(recordTraceEventMock).toHaveBeenCalledWith('core.pipeline.timeout', expect.any(Object));
    expect(recordTraceEventMock).toHaveBeenCalledWith('core.pipeline.degraded', expect.any(Object));
  });

  it('recovers when Trinity aborts near the shared pipeline deadline before the wrapper stamps its own timeout message', async () => {
    const timeoutError = new Error('Request was aborted.');
    timeoutError.name = 'AbortError';
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(0).mockReturnValue(3200);

    runWithRequestAbortTimeoutMock
      .mockRejectedValueOnce(timeoutError)
      .mockImplementationOnce(async (_options: unknown, callback: () => Promise<unknown>) => await callback());
    runThroughBrainMock.mockResolvedValueOnce(createTrinityResult({
      result: 'Recovered after near-deadline abort'
    }));

    const result = await runArcanosCoreQuery({
      client: {} as never,
      prompt: 'Analyze the current architecture tradeoffs in detail and give a careful reasoning-first answer.',
      sourceEndpoint: 'api-arcanos.ask'
    });

    expect(result).toEqual(expect.objectContaining({
      result: 'Recovered after near-deadline abort',
      timeoutKind: 'pipeline_timeout',
      degradedModeReason: 'arcanos_core_pipeline_timeout_direct_answer'
    }));
    expect(recordTraceEventMock).toHaveBeenCalledWith('core.pipeline.timeout', expect.any(Object));
    expect(recordTraceEventMock).toHaveBeenCalledWith('core.pipeline.degraded', expect.any(Object));
    nowSpy.mockRestore();
  });

  it('rethrows non-timeout failures without engaging the degraded path', async () => {
    runWithRequestAbortTimeoutMock.mockRejectedValueOnce(new Error('upstream failure'));

    await expect(
      runArcanosCoreQuery({
        client: {} as never,
        prompt: 'Explain the state.',
        sourceEndpoint: 'api-arcanos.ask'
      })
    ).rejects.toThrow('upstream failure');

    expect(runThroughBrainMock).not.toHaveBeenCalled();
    expect(recordTraceEventMock).not.toHaveBeenCalled();
  });

  it('returns a static bounded fallback when the degraded direct-answer recovery also times out', async () => {
    const timeoutError = new Error('ARCANOS:CORE pipeline timeout after 3000ms');
    timeoutError.name = 'AbortError';
    const degradedError = new Error('Request was aborted.');
    degradedError.name = 'AbortError';

    runWithRequestAbortTimeoutMock
      .mockRejectedValueOnce(timeoutError)
      .mockRejectedValueOnce(degradedError);

    const result = await runArcanosCoreQuery({
      client: {} as never,
      prompt: 'Analyze the current architecture tradeoffs in detail and give a careful reasoning-first answer.',
      sourceEndpoint: 'api-arcanos.ask'
    });

    expect(result).toEqual(expect.objectContaining({
      activeModel: 'arcanos-core:static-timeout-fallback',
      timeoutKind: 'pipeline_timeout',
      degradedModeReason: 'arcanos_core_pipeline_timeout_static_fallback',
      routingStages: ['ARCANOS-CORE-TIMEOUT-FALLBACK'],
      bypassedSubsystems: expect.arrayContaining(['trinity_intake', 'trinity_reasoning', 'trinity_final'])
    }));
    expect(recordTraceEventMock).toHaveBeenCalledWith('core.pipeline.degraded_failure', expect.any(Object));
    expect(recordTraceEventMock).toHaveBeenCalledWith('core.pipeline.static_fallback', expect.any(Object));
  });
});
