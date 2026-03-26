import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const callOpenAI = jest.fn() as jest.MockedFunction<any>;
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

let handlePrompt: (req: any, res: any) => Promise<void>;
let activatePromptRouteDegradedMode: (reason: string) => unknown;
let activatePromptRouteReducedLatencyMode: (reason: string, defaultTokenLimit: number) => unknown;
let resetPromptRouteMitigationStateForTests: () => void;
let originalNodeEnv: string | undefined;

beforeEach(async () => {
  jest.resetModules();
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

  jest.unstable_mockModule('../src/transport/http/requestHandler.js', () => ({
    validateAIRequest,
    handleAIError,
    classifyBudgetAbortKind
  }));

  jest.unstable_mockModule('@arcanos/runtime', () => ({
    runWithRequestAbortTimeout: async (_options: unknown, fn: () => Promise<unknown>) => await fn(),
    getRequestAbortSignal: jest.fn(() => undefined)
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
  ({ activatePromptRouteDegradedMode, activatePromptRouteReducedLatencyMode, resetPromptRouteMitigationStateForTests } = await import(
    '../src/services/openai/promptRouteMitigation.js'
  ));
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
    callOpenAI.mockResolvedValue({ response: {}, output: 'ok', model: 'ft:custom-model', cached: false });

    const req: any = { body: { prompt: 'hi', model: 'ft:custom-model' } };
    const res: any = { json: jest.fn() };

    await handlePrompt(req, res);

    expect(callOpenAI).toHaveBeenCalledWith(
      'ft:custom-model',
      'hi',
      256,
      true,
      expect.objectContaining({
        timeoutMs: 6000,
        maxRetries: 1,
        metadata: expect.objectContaining({
          route: '/api/openai/prompt',
          mitigationMode: 'normal'
        })
      })
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
    callOpenAI.mockResolvedValue({ response: {}, output: 'ok', model: 'ft:custom-model', cached: false });

    const req: any = { body: { prompt: 'hi', model: '  ft:custom-model  ' } };
    const res: any = { json: jest.fn() };

    await handlePrompt(req, res);

    expect(callOpenAI).toHaveBeenCalledWith(
      'ft:custom-model',
      'hi',
      256,
      true,
      expect.objectContaining({
        timeoutMs: 6000,
        maxRetries: 1
      })
    );
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
    callOpenAI.mockResolvedValue({ response: {}, output: 'ok', model: 'ft:default-model', cached: false });

    const req: any = { body: { prompt: 'hello' } };
    const res: any = { json: jest.fn() };

    await handlePrompt(req, res);

    expect(getDefaultModel).toHaveBeenCalled();
    expect(callOpenAI).toHaveBeenCalledWith(
      'ft:default-model',
      'hello',
      256,
      true,
      expect.objectContaining({
        timeoutMs: 6000,
        maxRetries: 1
      })
    );
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
    const res: any = { json: jest.fn() };

    await handlePrompt(req, res);

    expect(callOpenAI).not.toHaveBeenCalled();
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
    callOpenAI.mockResolvedValue({ response: {}, output: 'ok', model: 'ft:fallback-model', cached: false });

    const req: any = {
      body: { prompt: 'hello' },
      logger: {
        warn: jest.fn()
      }
    };
    const res: any = { json: jest.fn() };

    await handlePrompt(req, res);

    expect(callOpenAI).toHaveBeenCalledWith(
      'ft:fallback-model',
      'hello',
      96,
      true,
      expect.objectContaining({
        timeoutMs: 3200,
        maxRetries: 0,
        metadata: expect.objectContaining({
          route: '/api/openai/prompt',
          mitigationMode: 'reduced_latency',
          bypassedSubsystems: expect.arrayContaining(['provider_retry', 'long_generation_tail'])
        })
      })
    );
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
});
