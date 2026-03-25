import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const express = (await import('express')).default;
const request = (await import('supertest')).default;

const mockExtractInput = jest.fn();
const mockValidateAIRequest = jest.fn();
const mockHandleAIError = jest.fn();
const mockRunArcanosCoreQuery = jest.fn();
const mockTryExecutePromptRouteShortcut = jest.fn();

const verificationRouter = express.Router();

jest.unstable_mockModule('@transport/http/middleware/confirmGate.js', () => ({
  confirmGate: (_req: unknown, _res: unknown, next: () => void) => next()
}));

jest.unstable_mockModule('@platform/runtime/security.js', () => ({
  createValidationMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  createRateLimitMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getRequestActorKey: () => 'compat-test-actor'
}));

jest.unstable_mockModule('@transport/http/requestHandler.js', () => ({
  extractInput: mockExtractInput,
  validateAIRequest: mockValidateAIRequest,
  handleAIError: mockHandleAIError
}));

jest.unstable_mockModule('@services/arcanos-core.js', () => ({
  runArcanosCoreQuery: mockRunArcanosCoreQuery
}));

jest.unstable_mockModule('@services/promptRouteShortcuts.js', () => ({
  tryExecutePromptRouteShortcut: mockTryExecutePromptRouteShortcut
}));

jest.unstable_mockModule('../src/routes/api-arcanos-verification.js', () => ({
  default: verificationRouter
}));

const { default: apiArcanosRouter } = await import('../src/routes/api-arcanos.js');

function createApiArcanosTestApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/arcanos', apiArcanosRouter);
  return app;
}

function buildTrinityResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    result: 'Compatibility response',
    module: 'trinity',
    meta: {
      tokens: {
        prompt_tokens: 10,
        completion_tokens: 12,
        total_tokens: 22
      },
      id: 'compat-meta-1',
      created: 1772917000000
    },
    activeModel: 'gpt-5.1',
    fallbackFlag: false,
    routingStages: ['ARCANOS-INTAKE', 'ARCANOS-DIRECT-ANSWER'],
    gpt5Used: true,
    gpt5Model: 'gpt-5.1',
    dryRun: false,
    fallbackSummary: {
      intakeFallbackUsed: false,
      gpt5FallbackUsed: false,
      finalFallbackUsed: false,
      fallbackReasons: []
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
      requestId: 'compat-request-1',
      logged: true
    },
    outputControls: {
      requestedVerbosity: 'normal',
      maxWords: null,
      answerMode: 'direct',
      debugPipeline: false,
      strictUserVisibleOutput: true
    },
    ...overrides
  };
}

describe('/api/arcanos/ask compatibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExtractInput.mockImplementation((body: Record<string, unknown>) =>
      typeof body.prompt === 'string' ? body.prompt : null
    );
    mockTryExecutePromptRouteShortcut.mockResolvedValue(null);
  });

  it('preserves ping health checks and emits deprecation headers', async () => {
    const app = createApiArcanosTestApp();
    const noteUserPing = jest.fn();
    app.locals.idleStateService = { noteUserPing };

    const response = await request(app).post('/api/arcanos/ask').send({
      prompt: 'ping'
    });

    expect(response.status).toBe(200);
    expect(response.headers['x-deprecated-endpoint']).toBe('/api/arcanos/ask');
    expect(response.headers['x-canonical-route']).toBe('/gpt/arcanos-core');
    expect(response.headers['x-route-deprecated']).toBe('true');
    expect(response.headers['x-ask-route-mode']).toBe('compat');
    expect(response.body).toMatchObject({
      success: true,
      result: 'pong',
      metadata: {
        deprecatedEndpoint: true,
        canonicalRoute: '/gpt/arcanos-core',
        pipeline: 'trinity',
        endpoint: 'api-arcanos.ask'
      }
    });
    expect(noteUserPing).toHaveBeenCalledWith({
      route: '/api/arcanos/ask',
      source: 'api-arcanos.ask'
    });
    expect(mockValidateAIRequest).not.toHaveBeenCalled();
    expect(mockRunArcanosCoreQuery).not.toHaveBeenCalled();
  });

  it('routes deprecated ask traffic through the shared core wrapper', async () => {
    mockValidateAIRequest.mockReturnValue({
      client: { clientId: 'openai-client-1' },
      input: 'Say hello in one word.',
      body: {
        prompt: 'Say hello in one word.'
      }
    });
    mockRunArcanosCoreQuery.mockResolvedValue(
      buildTrinityResult({
        result: 'Hello',
        activeModel: 'gpt-4.1',
        taskLineage: {
          requestId: 'compat-request-2',
          logged: true
        }
      })
    );

    const response = await request(createApiArcanosTestApp()).post('/api/arcanos/ask').send({
      prompt: 'Say hello in one word.',
      answerMode: 'direct'
    });

    expect(response.status).toBe(200);
    expect(mockRunArcanosCoreQuery).toHaveBeenCalledWith({
      client: { clientId: 'openai-client-1' },
      prompt: 'Say hello in one word.',
      sessionId: undefined,
      overrideAuditSafe: undefined,
      sourceEndpoint: 'api-arcanos.ask',
      runOptions: expect.objectContaining({
        answerMode: 'direct'
      })
    });
    expect(response.body).toMatchObject({
      success: true,
      result: 'Hello',
      metadata: {
        model: 'gpt-4.1',
        deprecatedEndpoint: true,
        canonicalRoute: '/gpt/arcanos-core',
        pipeline: 'trinity',
        endpoint: 'api-arcanos.ask',
        requestId: 'compat-request-2',
        gptId: 'arcanos-core'
      }
    });
  });

  it('lets validation own the 400 response without invoking the core wrapper', async () => {
    mockValidateAIRequest.mockImplementation((_req: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }) => {
      res.status(400).json({
        success: false,
        error: 'Request must include prompt text.'
      });
      return null;
    });

    const response = await request(createApiArcanosTestApp()).post('/api/arcanos/ask').send({});

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      success: false,
      error: 'Request must include prompt text.'
    });
    expect(mockRunArcanosCoreQuery).not.toHaveBeenCalled();
  });
});
