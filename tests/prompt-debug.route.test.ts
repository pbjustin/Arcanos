import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const callOpenAIMock = jest.fn();
const validateAIRequestMock = jest.fn();
const handleAIErrorMock = jest.fn();

jest.unstable_mockModule('@services/openai.js', () => ({
  callOpenAI: callOpenAIMock,
  getDefaultModel: () => 'gpt-5',
  getFallbackModel: () => 'gpt-4.1-mini',
  getGPT5Model: () => 'gpt-5',
  getOpenAIServiceHealth: () => ({
    apiKey: { configured: true, status: 'ok' },
    client: { initialized: true, timeout: 30000, baseURL: null },
    circuitBreaker: { state: 'closed' },
    cache: { enabled: false },
    lastHealthCheck: '2026-03-27T00:00:00.000Z',
  }),
  getOpenAIKeySource: () => 'env',
}));

jest.unstable_mockModule('@transport/http/requestHandler.js', () => ({
  validateAIRequest: validateAIRequestMock,
  handleAIError: handleAIErrorMock,
  classifyBudgetAbortKind: () => null,
}));

jest.unstable_mockModule('@services/openai/promptRouteMitigation.js', () => ({
  getPromptRouteExecutionPolicy: () => ({
    mode: 'normal',
    useFallbackModel: false,
    maxTokens: 256,
    providerTimeoutMs: 12000,
    pipelineTimeoutMs: 15000,
    maxRetries: 1,
    bypassedSubsystems: [],
  }),
  getPromptRouteMitigationState: () => ({
    active: false,
    mode: 'normal',
    reason: null,
    bypassedSubsystems: [],
  }),
  recordPromptRouteTimeoutIncident: () => ({
    applied: false,
    state: {
      reason: null,
      providerTimeoutMs: 12000,
      pipelineTimeoutMs: 15000,
    }
  }),
}));

jest.unstable_mockModule('@transport/http/middleware/fallbackHandler.js', () => ({
  generateDegradedResponse: () => ({
    status: 'degraded',
    message: 'degraded',
    data: 'degraded',
    fallbackMode: 'static',
    timestamp: '2026-03-27T00:00:00.000Z',
  }),
}));

jest.unstable_mockModule('@transport/http/middleware/confirmGate.js', () => ({
  getConfirmGateConfiguration: () => ({ enabled: false }),
}));

jest.unstable_mockModule('@platform/runtime/config.js', () => ({
  config: {
    ai: {
      defaultMaxTokens: 256,
    },
  },
}));

jest.unstable_mockModule('@platform/runtime/env.js', () => ({
  getEnv: (_key?: string, defaultValue?: string) => defaultValue ?? null,
  getEnvNumber: (_key: string, defaultValue?: number) => defaultValue ?? 0,
  getEnvBoolean: (_key: string, defaultValue?: boolean) => defaultValue ?? false,
  getAutomationAuth: () => null,
  getBackendBaseUrl: () => 'http://localhost:3000',
  getBackendBaseUrlValue: () => 'http://localhost:3000',
  readRuntimeEnv: () => null,
}));

jest.unstable_mockModule('@arcanos/runtime', () => ({
  runWithRequestAbortTimeout: async (_options: unknown, operation: () => Promise<unknown>) => operation(),
  getRequestAbortSignal: () => undefined,
}));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const openaiRouter = (await import('../src/routes/openai.js')).default;
const promptDebugRouter = (await import('../src/routes/api-prompt-debug.js')).default;
const { clearPromptDebugTracesForTest } = await import('../src/services/promptDebugTraceService.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.requestId = 'req-prompt-debug-1';
    req.traceId = 'trace-prompt-debug-1';
    next();
  });
  app.use('/api/openai', openaiRouter);
  app.use(promptDebugRouter);
  return app;
}

describe('prompt debug routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearPromptDebugTracesForTest();
    validateAIRequestMock.mockReturnValue({
      client: { responses: { create: jest.fn() } },
      input: 'verify in production on the live backend runtime that is currently active',
      body: {
        prompt: 'verify in production on the live backend runtime that is currently active',
      },
    });
    callOpenAIMock.mockResolvedValue({
      output: 'Observed a response.',
      model: 'gpt-5',
    });
  });

  it('captures prompt observability fields and exposes them via the debug endpoints', async () => {
    const app = buildApp();

    const promptResponse = await request(app)
      .post('/api/openai/prompt')
      .send({
        prompt: 'verify in production on the live backend runtime that is currently active',
      });

    expect(promptResponse.status).toBe(200);

    const latestResponse = await request(app).get('/api/prompt-debug/latest');
    expect(latestResponse.status).toBe(200);
    expect(latestResponse.body.latest).toMatchObject({
      requestId: 'req-prompt-debug-1',
      rawPrompt: 'verify in production on the live backend runtime that is currently active',
      normalizedPrompt: 'verify in production on the live backend runtime that is currently active',
      selectedRoute: '/api/openai/prompt',
      selectedModule: 'openai.prompt',
      selectedTools: [],
      repoInspectionChosen: false,
      runtimeInspectionChosen: false,
      explicitlyRequestedLiveRuntimeVerification: true,
      liveRuntimeRequirementPreserved: false,
      preservedConstraints: ['live backend', 'runtime', 'currently active', 'verify in production'],
      droppedConstraints: [],
      finalExecutorPayload: expect.objectContaining({
        executor: 'callOpenAI',
        model: 'gpt-5',
      }),
      responseReturned: expect.objectContaining({
        result: 'Observed a response.',
        model: 'gpt-5',
      }),
    });

    const eventsResponse = await request(app).get('/api/prompt-debug/events');
    expect(eventsResponse.status).toBe(200);
    expect(eventsResponse.body.count).toBe(1);
    expect(eventsResponse.body.events[0].requestId).toBe('req-prompt-debug-1');
  });
});
