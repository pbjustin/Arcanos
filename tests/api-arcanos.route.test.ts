import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const express = (await import('express')).default;
const request = (await import('supertest')).default;

const mockRunThroughBrain = jest.fn();
const mockExtractInput = jest.fn();
const mockValidateAIRequest = jest.fn();
const mockHandleAIError = jest.fn();
const mockCreateRuntimeBudget = jest.fn();
const mockTryExecutePromptRouteShortcut = jest.fn();

const verificationRouter = express.Router();

jest.unstable_mockModule('@core/logic/trinity.js', () => ({
  runThroughBrain: mockRunThroughBrain
}));

jest.unstable_mockModule('@transport/http/middleware/confirmGate.js', () => ({
  confirmGate: (_req: unknown, _res: unknown, next: () => void) => next()
}));

jest.unstable_mockModule('@platform/runtime/security.js', () => ({
  createValidationMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  createRateLimitMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getRequestActorKey: () => 'route-test-actor'
}));

jest.unstable_mockModule('@transport/http/requestHandler.js', () => ({
  extractInput: mockExtractInput,
  validateAIRequest: mockValidateAIRequest,
  handleAIError: mockHandleAIError
}));

jest.unstable_mockModule('@platform/resilience/runtimeBudget.js', () => ({
  createRuntimeBudgetWithLimit: mockCreateRuntimeBudget
}));

jest.unstable_mockModule('@services/promptRouteShortcuts.js', () => ({
  tryExecutePromptRouteShortcut: mockTryExecutePromptRouteShortcut
}));

jest.unstable_mockModule('../src/routes/api-arcanos-verification.js', () => ({
  default: verificationRouter
}));

const router = (await import('../src/routes/api-arcanos.js')).default;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

function buildTrinityResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    result: 'Trinity output',
    module: 'trinity',
    meta: {
      tokens: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30
      },
      id: 'trinity-meta-1',
      created: 1772917000000
    },
    activeModel: 'gpt-5.1',
    fallbackFlag: false,
    routingStages: ['intake', 'reasoning', 'final'],
    gpt5Used: true,
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
      entriesAccessed: 2,
      contextSummary: 'Memory context summary',
      memoryEnhanced: true,
      maxRelevanceScore: 0.9,
      averageRelevanceScore: 0.75
    },
    taskLineage: {
      requestId: 'trinity-request-1',
      logged: true
    },
    outputControls: {
      requestedVerbosity: 'normal',
      maxWords: null,
      answerMode: 'explained',
      debugPipeline: false,
      strictUserVisibleOutput: true
    },
    ...overrides
  };
}

describe('api-arcanos route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ASK_ROUTE_MODE = 'compat';
    mockExtractInput.mockImplementation((body: Record<string, unknown>) =>
      typeof body.prompt === 'string' ? body.prompt : null
    );
    mockCreateRuntimeBudget.mockReturnValue({ budgetId: 'runtime-budget-1' });
    mockTryExecutePromptRouteShortcut.mockResolvedValue(null);
  });

  it('forces deprecated ask traffic onto compat mode and points callers to the canonical GPT route', async () => {
    delete process.env.ASK_ROUTE_MODE;

    const response = await request(buildApp())
      .post('/ask')
      .send({
        prompt: 'ping'
      });

    expect(response.status).toBe(200);
    expect(response.headers['x-canonical-route']).toBe('/gpt/arcanos-core');
    expect(response.headers['x-route-deprecated']).toBe('true');
    expect(response.headers['x-ask-route-mode']).toBe('compat');
    expect(response.body).toMatchObject({
      success: true,
      result: 'pong',
      metadata: expect.objectContaining({
        deprecatedEndpoint: true,
        canonicalRoute: '/gpt/arcanos-core',
        endpoint: 'api-arcanos.ask',
      }),
    });
    expect(mockValidateAIRequest).not.toHaveBeenCalled();
    expect(mockRunThroughBrain).not.toHaveBeenCalled();
  });

  it('routes non-ping requests through Trinity and returns explicit pipeline metadata', async () => {
    const openaiClient = { clientId: 'openai-client-1' };
    mockValidateAIRequest.mockReturnValue({
      client: openaiClient,
      input: 'Explain the deployment state.',
      body: {
        prompt: 'Explain the deployment state.'
      }
    });
    mockRunThroughBrain.mockResolvedValue(
      buildTrinityResult({
        result: 'Deployment state explained.'
      })
    );

    const response = await request(buildApp())
      .post('/ask')
      .send({
        prompt: 'Explain the deployment state.',
        sessionId: 'session-route-1',
        overrideAuditSafe: 'operator-approved'
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.result).toBe('Deployment state explained.');
    expect(response.headers['x-canonical-route']).toBe('/gpt/arcanos-core');
    expect(response.headers['x-route-deprecated']).toBe('true');
    expect(response.headers['x-ask-route-mode']).toBe('compat');
    expect(response.headers.deprecation).toBe('true');
    expect(response.body.metadata.pipeline).toBe('trinity');
    expect(response.body.metadata.trinityVersion).toBe('1.0');
    expect(response.body.metadata.endpoint).toBe('api-arcanos.ask');
    expect(response.body.metadata.requestId).toBe('trinity-request-1');
    expect(response.body.metadata.tokensUsed).toBe(30);
    expect(response.body.auditSafe).toBeUndefined();
    expect(response.body.memoryContext).toBeUndefined();
    expect(response.body.taskLineage).toBeUndefined();
    expect(mockRunThroughBrain).toHaveBeenCalledWith(
      openaiClient,
      'Explain the deployment state.',
      'session-route-1',
      undefined,
      expect.objectContaining({
        sourceEndpoint: 'api-arcanos.ask'
      }),
      { budgetId: 'runtime-budget-1' }
    );
  });

  it('exposes pipeline debug only when strict user-visible output is explicitly disabled', async () => {
    mockValidateAIRequest.mockReturnValue({
      client: { clientId: 'openai-client-debug' },
      input: 'Show the pipeline debug output.',
      body: {
        prompt: 'Show the pipeline debug output.',
        debug_pipeline: true,
        answer_mode: 'debug',
        strict_user_visible_output: false
      }
    });
    mockRunThroughBrain.mockResolvedValue(
      buildTrinityResult({
        outputControls: {
          requestedVerbosity: 'detailed',
          maxWords: null,
          answerMode: 'debug',
          debugPipeline: true,
          strictUserVisibleOutput: false
        },
        pipelineDebug: {
          capabilityFlags: {
            canBrowse: false,
            canVerifyProvidedData: false,
            canVerifyLiveData: false,
            canConfirmExternalState: false,
            canPersistData: false,
            canCallBackend: false
          },
          outputControls: {
            requestedVerbosity: 'detailed',
            maxWords: null,
            answerMode: 'debug',
            debugPipeline: true,
            strictUserVisibleOutput: false
          },
          intakeOutput: {
            framedRequest: 'framed',
            activeModel: 'ft:model',
            fallbackUsed: false
          },
          reasoningOutput: {
            output: 'reasoned',
            model: 'gpt-5.1',
            fallbackUsed: false,
            honesty: {
              responseMode: 'answer',
              achievableSubtasks: ['answer'],
              blockedSubtasks: [],
              userVisibleCaveats: [],
              evidenceTags: []
            }
          },
          finalOutput: {
            rawModelOutput: 'raw',
            translatedOutput: 'translated',
            userVisibleResult: 'final',
            removedMetaSections: [],
            blockedOrRewrittenClaims: []
          }
        }
      })
    );

    const response = await request(buildApp())
      .post('/ask')
      .send({
        prompt: 'Show the pipeline debug output.',
        debug_pipeline: true,
        answer_mode: 'debug',
        strict_user_visible_output: false
      });

    expect(response.status).toBe(200);
    expect(response.body.pipelineDebug).toBeDefined();
    expect(response.body.pipelineDebug.finalOutput.userVisibleResult).toBe('final');
  });

  it('keeps ping requests lightweight and skips Trinity execution', async () => {
    const app = buildApp();
    const noteUserPing = jest.fn();
    app.locals.idleStateService = {
      noteUserPing
    };

    const response = await request(app)
      .post('/ask')
      .send({
        prompt: 'ping'
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.result).toBe('pong');
    expect(response.body.metadata.pipeline).toBe('trinity');
    expect(noteUserPing).toHaveBeenCalledWith({
      route: '/api/arcanos/ask',
      source: 'api-arcanos.ask'
    });
    expect(mockValidateAIRequest).not.toHaveBeenCalled();
    expect(mockRunThroughBrain).not.toHaveBeenCalled();
  });

  it('accepts explicit diagnostic probes without a prompt and still bypasses Trinity', async () => {
    const response = await request(buildApp())
      .post('/ask')
      .send({
        mode: 'diagnostic',
        action: 'ping'
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.result).toBe('backend operational');
    expect(response.body.module).toBe('diagnostic');
    expect(response.body.routingStages).toEqual(['DIAGNOSTIC-SHORTCUT']);
    expect(mockValidateAIRequest).not.toHaveBeenCalled();
    expect(mockRunThroughBrain).not.toHaveBeenCalled();
  });

  it('preserves the stream option with terminal SSE frames from Trinity output', async () => {
    mockValidateAIRequest.mockReturnValue({
      client: { clientId: 'openai-client-2' },
      input: 'Stream the final result.',
      body: {
        prompt: 'Stream the final result.'
      }
    });
    mockRunThroughBrain.mockResolvedValue(
      buildTrinityResult({
        result: 'Final streamed answer.'
      })
    );

    const response = await request(buildApp())
      .post('/ask')
      .send({
        prompt: 'Stream the final result.',
        options: {
          stream: true
        }
      });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.text).toContain('"type":"chunk"');
    expect(response.text).toContain('"pipeline":"trinity"');
    expect(response.text).toContain('"type":"done"');
  });

  it('keeps memory-style prompts on the legacy route inside Trinity instead of shortcut execution', async () => {
    const openaiClient = { clientId: 'openai-client-3' };
    mockValidateAIRequest.mockReturnValue({
      client: openaiClient,
      input: 'Recall: RAW_20260308_VAN_PROBE2',
      body: {
        prompt: 'Recall: RAW_20260308_VAN_PROBE2'
      }
    });
    mockRunThroughBrain.mockResolvedValue(
      buildTrinityResult({
        result: 'Handled through Trinity instead of memory persistence.'
      })
    );

    const response = await request(buildApp())
      .post('/ask')
      .send({
        prompt: 'Recall: RAW_20260308_VAN_PROBE2',
        sessionId: 'RAW_20260308_VAN_PROBE2'
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.result).toBe('Handled through Trinity instead of memory persistence.');
    expect(response.body.module).toBe('trinity');
    expect(response.body.metadata.endpoint).toBe('api-arcanos.ask');
    expect(mockTryExecutePromptRouteShortcut).not.toHaveBeenCalled();
    expect(mockRunThroughBrain).toHaveBeenCalled();
  });

  it('keeps backstage-booker prompts on the legacy route inside Trinity instead of shortcut execution', async () => {
    const openaiClient = { clientId: 'openai-client-4' };
    mockValidateAIRequest.mockReturnValue({
      client: openaiClient,
      input: 'Generate three rivalries for RAW after WrestleMania.',
      body: {
        prompt: 'Generate three rivalries for RAW after WrestleMania.'
      }
    });
    mockRunThroughBrain.mockResolvedValue(
      buildTrinityResult({
        result: 'Handled through Trinity instead of backstage shortcut.',
      })
    );

    const response = await request(buildApp())
      .post('/ask')
      .send({
        prompt: 'Generate three rivalries for RAW after WrestleMania.',
        sessionId: 'RAW_RIVALRY_TEST'
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.result).toBe('Handled through Trinity instead of backstage shortcut.');
    expect(response.body.module).toBe('trinity');
    expect(mockTryExecutePromptRouteShortcut).not.toHaveBeenCalled();
    expect(mockRunThroughBrain).toHaveBeenCalled();
  });
});
