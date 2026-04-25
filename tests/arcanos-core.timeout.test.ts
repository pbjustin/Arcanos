import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const runTrinityWritingPipelineMock = jest.fn();
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
const getRequestAbortContextMock = jest.fn(() => null);
const isAbortErrorMock = jest.fn((error: unknown) => error instanceof Error && error.name === 'AbortError');

jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({
  runTrinityWritingPipeline: runTrinityWritingPipelineMock
}));

jest.unstable_mockModule('@platform/resilience/runtimeBudget.js', () => ({
  createRuntimeBudgetWithLimit: createRuntimeBudgetWithLimitMock,
  getSafeRemainingMs: jest.fn((budget: { hardDeadline?: number; safetyBuffer?: number }) =>
    Math.max(0, (budget.hardDeadline ?? 0) - (budget.safetyBuffer ?? 0))
  )
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

jest.unstable_mockModule('@services/openai/aiExecutionContext.js', () => ({
  getAiExecutionContext: jest.fn(() => ({
    provider: 'openai',
    sourceType: 'route',
    sourceName: 'gpt.arcanos-core.query',
    requestId: 'req-ai-context',
    traceId: 'trace-core-timeout-test',
    totals: {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0
    },
    operationCounts: {},
    models: {}
  }))
}));

jest.unstable_mockModule('@services/systemState.js', () => ({
  executeSystemStateRequest: jest.fn()
}));

jest.unstable_mockModule('@arcanos/runtime', () => ({
  runWithRequestAbortTimeout: runWithRequestAbortTimeoutMock,
  getRequestAbortSignal: getRequestAbortSignalMock,
  getRequestAbortContext: getRequestAbortContextMock,
  getRequestRemainingMs: getRequestRemainingMsMock,
  isAbortError: isAbortErrorMock
}));

const {
  buildArcanosCoreTimeoutFallbackEnvelope,
  runArcanosCoreQuery
} = await import('../src/services/arcanos-core.js');

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
    getRequestAbortContextMock.mockReturnValue(null);
  });

  it('returns a normal GPT result for a fast simple query without engaging fallback', async () => {
    const trinityResult = createTrinityResult({
      result: 'Hello.',
      activeModel: 'gpt-4.1-mini',
      fallbackFlag: false,
      fallbackSummary: {
        intakeFallbackUsed: false,
        gpt5FallbackUsed: false,
        finalFallbackUsed: false,
        fallbackReasons: []
      }
    });
    runWithRequestAbortTimeoutMock.mockImplementationOnce(
      async (_options: unknown, callback: () => Promise<unknown>) => await callback()
    );
    runTrinityWritingPipelineMock.mockResolvedValueOnce(trinityResult);

    const result = await runArcanosCoreQuery({
      client: {} as never,
      prompt: 'Say hello in one short sentence.',
      sourceEndpoint: 'gpt.arcanos-core.query'
    });

    expect(result).toBe(trinityResult);
    expect(result.degradedModeReason).toBeUndefined();
    expect(result.timeoutKind).toBeUndefined();
    expect(runWithRequestAbortTimeoutMock).toHaveBeenCalledTimes(1);
    expect(loggerWarnMock).not.toHaveBeenCalledWith(
      '[PIPELINE] static fallback engaged',
      expect.any(Object)
    );
  });

  it('recovers with a direct-answer degraded path when the shared core pipeline times out', async () => {
    process.env.ARCANOS_CORE_PIPELINE_TIMEOUT_MS = '5000';
    const timeoutError = new Error('ARCANOS:CORE pipeline timeout after 3500ms');
    timeoutError.name = 'AbortError';

    runWithRequestAbortTimeoutMock
      .mockRejectedValueOnce(timeoutError)
      .mockImplementationOnce(async (_options: unknown, callback: () => Promise<unknown>) => await callback());
    getRequestAbortContextMock.mockReturnValue({ requestId: 'req-core-timeout-1' });
    runTrinityWritingPipelineMock.mockResolvedValueOnce(createTrinityResult());

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
    expect(runTrinityWritingPipelineMock).toHaveBeenCalledWith({
      input: {
        prompt: 'Summarize the service health quickly.',
        sessionId: undefined,
        overrideAuditSafe: undefined,
        sourceEndpoint: 'api-arcanos.ask.degraded',
        body: { prompt: 'Summarize the service health quickly.' }
      },
      context: {
        client: {} as never,
        requestId: 'req-core-timeout-1',
        runtimeBudget: expect.objectContaining({
          watchdogLimit: 2000,
          safetyBuffer: 250
        }),
        runOptions: expect.objectContaining({
          answerMode: 'direct',
          requestedVerbosity: 'minimal',
          maxWords: 60,
          strictUserVisibleOutput: true,
          directAnswerModelOverride: 'gpt-4.1-mini'
        })
      }
    });
    expect(result).toEqual(expect.objectContaining({
      timeoutKind: 'pipeline_timeout',
      degradedModeReason: 'arcanos_core_pipeline_timeout_direct_answer',
      bypassedSubsystems: expect.arrayContaining(['trinity_intake', 'trinity_reasoning', 'trinity_final'])
    }));
    expect(recordTraceEventMock).toHaveBeenCalledWith('core.pipeline.timeout', expect.any(Object));
    expect(recordTraceEventMock).toHaveBeenCalledWith('core.pipeline.degraded', expect.any(Object));
  });

  it('recovers when Trinity aborts near the shared pipeline deadline before the wrapper stamps its own timeout message', async () => {
    process.env.ARCANOS_CORE_PIPELINE_TIMEOUT_MS = '5000';
    const timeoutError = new Error('Request was aborted.');
    timeoutError.name = 'AbortError';
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(0).mockReturnValue(3200);

    runWithRequestAbortTimeoutMock
      .mockRejectedValueOnce(timeoutError)
      .mockImplementationOnce(async (_options: unknown, callback: () => Promise<unknown>) => await callback());
    getRequestAbortContextMock.mockReturnValue({ requestId: 'req-core-timeout-2' });
    runTrinityWritingPipelineMock.mockResolvedValueOnce(createTrinityResult({
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

    expect(runTrinityWritingPipelineMock).not.toHaveBeenCalled();
    expect(recordTraceEventMock).not.toHaveBeenCalled();
  });

  it('returns a static bounded fallback when the degraded direct-answer recovery also times out', async () => {
    process.env.ARCANOS_CORE_PIPELINE_TIMEOUT_MS = '5000';
    const timeoutError = new Error('ARCANOS:CORE pipeline timeout after 3000ms');
    timeoutError.name = 'AbortError';
    Object.assign(timeoutError, { timeoutPhase: 'reasoning' });
    const degradedError = new Error('Request was aborted.');
    degradedError.name = 'AbortError';
    Object.assign(degradedError, { timeoutPhase: 'direct-answer-recovery' });

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
      timeoutPhase: 'reasoning.direct-answer-recovery',
      degradedModeReason: 'arcanos_core_pipeline_timeout_static_fallback',
      routingStages: ['ARCANOS-CORE-TIMEOUT-FALLBACK'],
      bypassedSubsystems: expect.arrayContaining(['trinity_intake', 'trinity_reasoning', 'trinity_final'])
    }));
    expect(result.fallbackSummary.fallbackReasons).toEqual(expect.arrayContaining([
      'Primary pipeline timed out during reasoning.direct-answer-recovery'
    ]));
    expect(loggerWarnMock).toHaveBeenCalledWith(
      'core.runtime.trace',
      expect.objectContaining({
        traceId: 'trace-core-timeout-test',
        gptId: 'arcanos-core',
        action: 'query',
        route: 'core',
        phase: 'fallback_triggered',
        degradedReason: 'arcanos_core_pipeline_timeout_static_fallback',
        timeoutPhase: 'reasoning.direct-answer-recovery'
      })
    );
    expect(recordTraceEventMock).toHaveBeenCalledWith('core.pipeline.degraded_failure', expect.any(Object));
    expect(recordTraceEventMock).toHaveBeenCalledWith('core.pipeline.static_fallback', expect.objectContaining({
      timeoutPhase: 'reasoning.direct-answer-recovery'
    }));
  });

  it('keeps GPT fallback route metadata authoritative in static timeout envelopes', () => {
    const envelope = buildArcanosCoreTimeoutFallbackEnvelope({
      prompt: 'Say hello.',
      gptId: 'arcanos-core',
      route: 'core',
      requestId: 'req-timeout-envelope-1',
      timeoutPhase: 'reasoning'
    });

    expect(envelope._route).toEqual(expect.objectContaining({
      gptId: 'arcanos-core',
      action: 'query',
      route: 'core',
      requestId: 'req-timeout-envelope-1'
    }));
    expect(envelope.result).toEqual(expect.objectContaining({
      timeoutKind: 'pipeline_timeout',
      timeoutPhase: 'reasoning',
      degradedModeReason: 'arcanos_core_pipeline_timeout_static_fallback'
    }));
  });
});
