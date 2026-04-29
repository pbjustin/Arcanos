import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const callOpenAI = jest.fn() as jest.MockedFunction<any>;
const runTrinityWritingPipeline = jest.fn() as jest.MockedFunction<any>;
const getDefaultModel = jest.fn() as jest.MockedFunction<any>;
const validateAIRequest = jest.fn() as jest.MockedFunction<any>;
const handleAIError = jest.fn() as jest.MockedFunction<any>;
const classifyBudgetAbortKind = jest.fn(() => null) as jest.MockedFunction<any>;
const getFallbackModel = jest.fn(() => 'ft:fallback-model');
const getGPT5Model = jest.fn(() => 'gpt-5');
const recordTraceEvent = jest.fn();
const generateDegradedResponse = jest.fn(() => ({
  status: 'degraded',
  message: 'fallback active',
  data: 'degraded output',
  fallbackMode: 'mock',
  timestamp: '2026-03-25T12:00:00.000Z'
}));
const getOpenAIServiceHealth = jest.fn(() => ({
  apiKey: { configured: false, status: 'missing' },
  client: { initialized: false, timeout: 0, baseURL: null },
  circuitBreaker: {},
  cache: {},
  lastHealthCheck: null
}));
const getOpenAIKeySource = jest.fn(() => null);
const runWithRequestAbortTimeoutMock = jest.fn(async (_options: unknown, fn: () => Promise<unknown>) => await fn());
const getRequestAbortSignalMock = jest.fn(() => undefined);

let handlePrompt: (req: any, res: any) => Promise<void>;
let activatePromptRouteDegradedMode: (reason: string) => unknown;
let activatePromptRouteReducedLatencyMode: (reason: string, defaultTokenLimit: number) => unknown;
let getPromptRouteMitigationState: () => any;
let resetPromptRouteMitigationStateForTests: () => void;
let DEFAULT_PROMPT_ROUTE_PIPELINE_TIMEOUT_MS: number;
let DEFAULT_PROMPT_ROUTE_PROVIDER_TIMEOUT_MS: number;
let originalNodeEnv: string | undefined;

function buildTrinityPromptResult(result: string, activeModel: string) {
  return {
    result,
    module: 'trinity',
    activeModel,
    fallbackFlag: false,
    routingStages: ['TRINITY'],
    auditSafe: { mode: 'true', passed: true, flags: [] },
    taskLineage: [],
    fallbackSummary: {
      intakeFallbackUsed: false,
      gpt5FallbackUsed: false,
      finalFallbackUsed: false,
      fallbackReasons: [],
    },
    meta: {
      id: 'prompt_test',
      created: 1_234,
      pipeline: 'trinity',
      bypass: false,
      sourceEndpoint: '/api/openai/prompt',
      classification: 'writing',
    },
  };
}

beforeEach(async () => {
  jest.resetModules();
  jest.clearAllMocks();
  originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';

  jest.unstable_mockModule('../src/services/openai.js', () => ({
    callOpenAI,
    getDefaultModel,
    getFallbackModel,
    getGPT5Model,
    getOpenAIServiceHealth,
    getOpenAIKeySource
  }));

  jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({
    runTrinityWritingPipeline
  }));

  jest.unstable_mockModule('../src/transport/http/requestHandler.js', () => ({
    validateAIRequest,
    handleAIError,
    classifyBudgetAbortKind
  }));

  jest.unstable_mockModule('@arcanos/runtime', () => ({
    OpenAIAbortError: class OpenAIAbortError extends Error {},
    createAbortError: jest.fn((message: string) => new Error(message)),
    isAbortError: jest.fn((error: unknown) => error instanceof Error && /abort/i.test(error.message)),
    runWithRequestAbortTimeout: runWithRequestAbortTimeoutMock,
    getRequestAbortSignal: getRequestAbortSignalMock
  }));

  jest.unstable_mockModule('../src/platform/logging/telemetry.js', () => ({
    recordTraceEvent,
    getTelemetrySnapshot: jest.fn(),
    recordLogEvent: jest.fn(),
    markOperation: jest.fn(),
    onTelemetry: jest.fn(),
    resetTelemetry: jest.fn()
  }));

  jest.unstable_mockModule('../src/transport/http/middleware/fallbackHandler.js', () => ({
    generateDegradedResponse
  }));

  ({ handlePrompt } = await import('../src/transport/http/controllers/openaiController.js'));
  ({
    activatePromptRouteDegradedMode,
    activatePromptRouteReducedLatencyMode,
    getPromptRouteMitigationState,
    resetPromptRouteMitigationStateForTests,
    DEFAULT_PROMPT_ROUTE_PIPELINE_TIMEOUT_MS,
    DEFAULT_PROMPT_ROUTE_PROVIDER_TIMEOUT_MS
  } = await import('../src/services/openai/promptRouteMitigation.js'));
  resetPromptRouteMitigationStateForTests();
});

afterEach(() => {
  resetPromptRouteMitigationStateForTests();
  process.env.NODE_ENV = originalNodeEnv;
  jest.clearAllMocks();
});

describe('handlePrompt', () => {
  it('uses provided model when specified', async () => {
    validateAIRequest.mockReturnValue({ input: 'hi', client: {} });
    runTrinityWritingPipeline.mockResolvedValue(buildTrinityPromptResult('ok', 'ft:custom-model'));

    const req: any = { body: { prompt: 'hi', model: 'ft:custom-model' } };
    const res: any = { json: jest.fn() };

    await handlePrompt(req, res);

    expect(runTrinityWritingPipeline).toHaveBeenCalledWith({
      input: expect.objectContaining({
        prompt: 'hi',
        moduleId: 'OPENAI:PROMPT',
        sourceEndpoint: '/api/openai/prompt',
        requestedAction: 'query',
        tokenLimit: 256,
        body: expect.objectContaining({
          model: 'ft:custom-model',
          tokenLimit: 256,
          mitigation: expect.objectContaining({
            route: '/api/openai/prompt',
            mitigationMode: 'normal'
          })
        })
      }),
      context: expect.objectContaining({
        client: expect.anything(),
        runOptions: expect.objectContaining({
          answerMode: 'direct',
          strictUserVisibleOutput: true,
          watchdogModelTimeoutMs: DEFAULT_PROMPT_ROUTE_PROVIDER_TIMEOUT_MS
        })
      })
    });
    expect(runWithRequestAbortTimeoutMock).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: DEFAULT_PROMPT_ROUTE_PIPELINE_TIMEOUT_MS,
        onAbort: expect.any(Function)
      }),
      expect.any(Function)
    );
    const payload = res.json.mock.calls[0][0];
    expect(payload).toEqual(
      expect.objectContaining({
        result: 'ok',
        model: 'ft:custom-model',
        activeModel: 'ft:custom-model',
        fallbackFlag: false
      })
    );
    expect(payload.meta).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^prompt_/),
        created: expect.any(Number)
      })
    );
  });

  it('trims provided model names before sending to OpenAI', async () => {
    validateAIRequest.mockReturnValue({ input: 'hi', client: {} });
    runTrinityWritingPipeline.mockResolvedValue(buildTrinityPromptResult('ok', 'ft:custom-model'));

    const req: any = { body: { prompt: 'hi', model: '  ft:custom-model  ' } };
    const res: any = { json: jest.fn() };

    await handlePrompt(req, res);

    expect(runTrinityWritingPipeline).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        body: expect.objectContaining({
          model: 'ft:custom-model',
          tokenLimit: 256
        })
      })
    }));
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'ft:custom-model',
        activeModel: 'ft:custom-model'
      })
    );
  });

  it('falls back to default model when none provided', async () => {
    validateAIRequest.mockReturnValue({ input: 'hello', client: {} });
    getDefaultModel.mockReturnValue('ft:default-model');
    runTrinityWritingPipeline.mockResolvedValue(buildTrinityPromptResult('ok', 'ft:default-model'));

    const req: any = { body: { prompt: 'hello' } };
    const res: any = { json: jest.fn() };

    await handlePrompt(req, res);

    expect(getDefaultModel).toHaveBeenCalled();
    expect(runTrinityWritingPipeline).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        prompt: 'hello',
        body: expect.objectContaining({
          model: 'ft:default-model',
          tokenLimit: 256
        })
      })
    }));
    const payload = res.json.mock.calls[0][0];
    expect(payload).toEqual(
      expect.objectContaining({
        result: 'ok',
        model: 'ft:default-model',
        activeModel: 'ft:default-model',
        fallbackFlag: false
      })
    );
    expect(payload.meta).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^prompt_/),
        created: expect.any(Number)
      })
    );
  });

  it('returns a degraded response when prompt-route mitigation is active', async () => {
    validateAIRequest.mockReturnValue({ input: 'hello', client: {} });
    activatePromptRouteDegradedMode('latency spike cluster detected');

    const req: any = {
      body: { prompt: 'hello' },
      logger: {
        warn: jest.fn()
      }
    };
    const res: any = { json: jest.fn(), setHeader: jest.fn() };

    await handlePrompt(req, res);

    expect(runTrinityWritingPipeline).not.toHaveBeenCalled();
    expect(generateDegradedResponse).toHaveBeenCalledWith('hello', 'prompt');
    expect(req.logger.warn).toHaveBeenCalledWith('prompt.route.mitigated', expect.objectContaining({
      mitigationMode: 'degraded_response',
      mitigationReason: 'latency spike cluster detected'
    }));
    expect(recordTraceEvent).toHaveBeenCalledWith('prompt_route.degraded', expect.objectContaining({
      mitigationMode: 'degraded_response',
      mitigationReason: 'latency spike cluster detected',
      fallbackMode: 'mock'
    }));
    expect(res.setHeader).toHaveBeenCalledWith(
      'x-ai-degraded-reason',
      'latency spike cluster detected'
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      result: 'degraded output',
      model: 'ft:fallback-model',
      activeModel: 'prompt-route:degraded_response',
      fallbackFlag: true,
      error: 'PROMPT_ROUTE_DEGRADED_MODE',
      degradedResponse: expect.objectContaining({
        status: 'degraded',
        message: 'fallback active',
        fallbackMode: 'mock',
        timestamp: '2026-03-25T12:00:00.000Z'
      })
    }));
  });

  it('uses the reduced-latency prompt-route policy when mitigation is active', async () => {
    validateAIRequest.mockReturnValue({ input: 'hello', client: {} });
    activatePromptRouteReducedLatencyMode('timeout storm detected', 256);
    runTrinityWritingPipeline.mockResolvedValue(buildTrinityPromptResult('ok', 'ft:fallback-model'));

    const req: any = {
      body: { prompt: 'hello' },
      logger: {
        warn: jest.fn()
      }
    };
    const res: any = { json: jest.fn() };

    await handlePrompt(req, res);

    expect(runTrinityWritingPipeline).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        prompt: 'hello',
        tokenLimit: 96,
        body: expect.objectContaining({
          model: 'ft:fallback-model',
          tokenLimit: 96,
          mitigation: expect.objectContaining({
            route: '/api/openai/prompt',
            mitigationMode: 'reduced_latency',
            bypassedSubsystems: expect.arrayContaining(['provider_retry', 'long_generation_tail'])
          })
        })
      }),
      context: expect.objectContaining({
        runOptions: expect.objectContaining({
          watchdogModelTimeoutMs: 3200
        })
      })
    }));
    expect(req.logger.warn).toHaveBeenCalledWith(
      'prompt.route.reduced_latency',
      expect.objectContaining({
        mitigationMode: 'reduced_latency',
        providerTimeoutMs: 3200,
        pipelineTimeoutMs: 3500,
        maxRetries: 0,
        maxTokens: 96,
        targetModel: 'ft:fallback-model'
      })
    );
    expect(recordTraceEvent).toHaveBeenCalledWith(
      'prompt_route.reduced_latency',
      expect.objectContaining({
        mitigationMode: 'reduced_latency',
        providerTimeoutMs: 3200,
        pipelineTimeoutMs: 3500,
        maxRetries: 0
      })
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        result: 'ok',
        model: 'ft:fallback-model',
        activeModel: 'ft:fallback-model',
        fallbackFlag: true
      })
    );
  });

  it('fast-trips into reduced latency mode after repeated prompt timeout incidents', async () => {
    validateAIRequest.mockReturnValue({ input: 'hello', client: {} });
    classifyBudgetAbortKind.mockReturnValue('budget_abort');
    runTrinityWritingPipeline.mockRejectedValue(new Error('Request was aborted.'));

    const reqFactory = () => ({
      body: { prompt: 'hello' },
      logger: {
        warn: jest.fn(),
        info: jest.fn()
      }
    });
    const resFactory = () => ({ json: jest.fn(), status: jest.fn().mockReturnThis() });

    const firstReq = reqFactory();
    await handlePrompt(firstReq as any, resFactory() as any);

    expect(getPromptRouteMitigationState()).toEqual(
      expect.objectContaining({
        active: false,
        recentTimeoutCount: 1
      })
    );

    const secondReq = reqFactory();
    await handlePrompt(secondReq as any, resFactory() as any);

    expect(secondReq.logger.warn).toHaveBeenCalledWith(
      'prompt.route.fast_trip',
      expect.objectContaining({
        route: '/api/openai/prompt',
        timeoutKind: 'budget_abort',
        mitigationMode: 'reduced_latency',
        mitigationReason: expect.stringContaining('prompt route timeout cluster detected')
      })
    );
    expect(recordTraceEvent).toHaveBeenCalledWith(
      'prompt_route.fast_trip',
      expect.objectContaining({
        route: '/api/openai/prompt',
        timeoutKind: 'budget_abort',
        mitigationMode: 'reduced_latency'
      })
    );
    expect(getPromptRouteMitigationState()).toEqual(
      expect.objectContaining({
        active: true,
        mode: 'reduced_latency',
        reason: expect.stringContaining('prompt route timeout cluster detected'),
        providerTimeoutMs: 3200,
        pipelineTimeoutMs: 3500
      })
    );
  });
});
