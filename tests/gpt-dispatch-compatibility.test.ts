import express, { type NextFunction, type Request, type Response } from 'express';
import {
  createServer,
  request as createHttpRequest,
  type Server,
} from 'node:http';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  RESEARCH_REQUEST_VALIDATION_ERROR_CODE,
  ResearchRequestValidationError,
} from '../src/shared/researchRequest.js';
import {
  BACKSTAGE_STORYLINE_PERSISTENCE_ERROR_CODE,
  BACKSTAGE_STORYLINE_PERSISTENCE_ERROR_MESSAGE,
  BACKSTAGE_STORYLINE_VALIDATION_ERROR_CODE,
  BackstageStorylinePersistenceError,
  parseBackstageStorylinePayload,
} from '../src/shared/backstage/backstageStoryline.js';
import { BackstageCanonDomainError } from '../src/core/db/repositories/backstageBookerRepository.js';
import {
  BackstageCanonUnavailableError,
} from '../src/services/backstageBookerContracts.js';
import {
  BackstageNotionCursorInvalidError,
  BackstageNotionIndexUnavailableError,
  BackstageNotionScopeResolutionError,
} from '../src/services/backstageNotionRag.js';
import {
  BackstageBookerOutputIncompleteError,
  BackstageContinuityQueryFailedError,
} from '../src/shared/backstage/backstageGenerationError.js';

const mockGetGptModuleMap = jest.fn();
const mockRebuildGptModuleMap = jest.fn();
const mockGetModuleMetadata = jest.fn();
const mockDispatchModuleAction = jest.fn();
const mockPersistModuleConversation = jest.fn(async () => undefined);
const mockInitializeModuleRegistry = jest.fn(async () => undefined);
const mockRecordDispatcherRoute = jest.fn();
const mockRecordUnknownGpt = jest.fn();

jest.unstable_mockModule('@platform/observability/appMetrics.js', () => ({
  getMetricsText: jest.fn(),
  metricsRegistry: {},
  recordAiBudgetExceeded: jest.fn(),
  recordAiOperation: jest.fn(),
  recordDagRunRequest: jest.fn(),
  recordDagRunStatus: jest.fn(),
  recordDagTraceTimeout: jest.fn(),
  recordDependencyCall: jest.fn(),
  recordDependencyLifecycleEvent: jest.fn(),
  recordDependencyOperationGateRejection: jest.fn(),
  recordDependencyOperationInFlight: jest.fn(),
  recordDispatcherFallback: jest.fn(),
  recordDispatcherMisroute: jest.fn(),
  recordDispatcherRoute: mockRecordDispatcherRoute,
  recordHttpRequestCompletion: jest.fn(),
  recordHttpRequestEnd: jest.fn(),
  recordHttpRequestStart: jest.fn(),
  recordJobEventCleanup: jest.fn(),
  recordJobEventInsertFailure: jest.fn(),
  recordMcpAutoInvoke: jest.fn(),
  recordMemoryDispatchIgnored: jest.fn(),
  recordUnknownGpt: mockRecordUnknownGpt,
  recordWorkerFailureTotal: jest.fn(),
  recordWorkerRecoveredJobs: jest.fn(),
  recordWorkerRecoveryAction: jest.fn(),
  recordWorkerJobDuration: jest.fn(),
  recordWorkerJobTotal: jest.fn(),
  recordWorkerQueueDepth: jest.fn(),
  recordWorkerQueueLatency: jest.fn(),
  recordWorkerRetryTotal: jest.fn(),
  recordWorkerLivenessWrite: jest.fn(),
  recordWorkerRuntimeHistoryWrite: jest.fn(),
  recordWorkerRuntimeSnapshotSkipped: jest.fn(),
  recordWorkerRuntimeStateWrite: jest.fn(),
  recordWorkerStaleDetection: jest.fn(),
  recordWorkerStalledJobs: jest.fn(),
  resetAppMetricsForTests: jest.fn(),
  resolveMetricRouteLabel: jest.fn(),
  shouldSkipHttpMetrics: jest.fn(() => false),
  writeMetricsResponse: jest.fn(),
}));

jest.unstable_mockModule('@services/moduleConversationPersistence.js', () => ({
  persistModuleConversation: mockPersistModuleConversation,
}));

jest.unstable_mockModule('@services/arcanosMcp.js', () => ({
  arcanosMcpService: {
    invokeTool: jest.fn(),
    listTools: jest.fn(),
  },
}));

jest.unstable_mockModule('@services/naturalLanguageMemory.js', () => ({
  executeNaturalLanguageMemoryCommand: jest.fn(),
  extractNaturalLanguageSessionId: jest.fn(() => null),
  extractNaturalLanguageStorageLabel: jest.fn(() => null),
  hasDagOrchestrationIntentCue: jest.fn(() => false),
  hasNaturalLanguageMemoryCue: jest.fn(() => false),
  parseNaturalLanguageMemoryCommand: jest.fn(() => ({ intent: 'unknown' })),
}));

jest.unstable_mockModule('@services/backstageBookerRouteShortcut.js', () => ({
  detectBackstageBookerIntent: jest.fn(() => null),
}));

jest.unstable_mockModule('@services/repoImplementationEvidence.js', () => ({
  buildRepoInspectionAnswer: jest.fn(() => 'repo inspection'),
  collectRepoImplementationEvidence: jest.fn(),
  shouldInspectRepoPrompt: jest.fn(() => false),
}));

jest.unstable_mockModule('@services/systemState.js', () => ({
  executeSystemStateRequest: jest.fn(() => ({
    mode: 'system_state'
  })),
  SystemStateConflictError: class SystemStateConflictError extends Error {
    code = 'SYSTEM_STATE_CONFLICT';
    conflict = {};
  },
}));

jest.unstable_mockModule('@platform/runtime/gptRouterConfig.js', () => ({
  default: mockGetGptModuleMap,
  getGptModuleMap: mockGetGptModuleMap,
  rebuildGptModuleMap: mockRebuildGptModuleMap,
  validateGptRegistry: jest.fn(() => ({ requiredGptIds: ['arcanos-core'] })),
}));

jest.unstable_mockModule('../src/services/moduleRegistry.js', () => ({
  getModuleMetadata: mockGetModuleMetadata,
  dispatchModuleAction: mockDispatchModuleAction,
  initializeModuleRegistry: mockInitializeModuleRegistry,
  resolveLegacyModule: jest.fn(() => null),
}));

const { resolveGptRouting, routeGptRequest } = await import('../src/routes/_core/gptDispatch.js');
const { dispatchLegacyRouteToGpt } = await import('../src/routes/_core/legacyGptCompat.js');
const { queryBackstageContinuity } = await import(
  '../src/services/backstageContinuityQuery.js'
);
const {
  createAbortError,
  getRequestAbortSignal,
  runWithRequestAbortContext,
} = await import('@arcanos/runtime');
const { listPromptDebugTraces } = await import('../src/services/promptDebugTraceService.js');
const { universalDispatch } = await import('../src/routes/dispatch.js');
const {
  backstageMutationConfirmationGate,
} = await import('../src/transport/http/middleware/backstageMutationConfirmationGate.js');
const {
  dispatchResearchGptAdmissionBoundary,
  dispatchResearchGptPreflightBoundary,
} = await import('../src/routes/_core/researchGptPreflight.js');
const {
  dispatchDagCompatibilityBoundary,
} = await import('../src/services/controlPlane/dispatchDagCompatibilityBoundary.js');
const {
  createPublicProviderAdmissionMiddleware,
} = await import('../src/transport/http/middleware/publicProviderAdmission.js');

function buildResearchDispatchApp(
  rateLimitMiddleware: (req: Request, res: Response, next: NextFunction) => void,
) {
  const app = express();
  app.use(express.json());
  app.post(
    '/dispatch',
    dispatchDagCompatibilityBoundary,
    dispatchResearchGptAdmissionBoundary,
  );
  app.use(createPublicProviderAdmissionMiddleware({
    legacyGptRoutesEnabled: false,
    rateLimitMiddleware,
  }));
  app.post(
    '/dispatch',
    dispatchResearchGptPreflightBoundary,
    universalDispatch,
  );
  return app;
}

function buildBackstageDispatchApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.controlPlanePrincipal = {
      audience: 'control-plane-http',
      role: 'operator',
      principalId: 'operator:storyline-dispatch-test',
      scopes: ['mcp:invoke'],
    };
    next();
  });
  app.post('/dispatch', backstageMutationConfirmationGate, universalDispatch);
  return app;
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function listenOnEphemeralPort(app: express.Express): Promise<{
  port: number;
  server: Server;
}> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Ephemeral dispatch test server address unavailable');
  }
  return { port: address.port, server };
}

async function closeTestServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

function startJsonRequest(input: {
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  path: string;
  port: number;
}) {
  const payload = JSON.stringify(input.body);
  const clientRequest = createHttpRequest({
    host: '127.0.0.1',
    port: input.port,
    path: input.path,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      ...input.headers,
    },
  });
  clientRequest.on('error', () => undefined);
  clientRequest.end(payload);
  return clientRequest;
}

describe('gpt dispatch compatibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetGptModuleMap.mockResolvedValue({
      'arcanos-core': {
        route: 'core',
        module: 'ARCANOS:CORE'
      }
    });
    mockRebuildGptModuleMap.mockResolvedValue({
      'arcanos-core': {
        route: 'core',
        module: 'ARCANOS:CORE'
      }
    });
    mockGetModuleMetadata.mockReturnValue({
      name: 'ARCANOS:CORE',
      description: null,
      route: 'core',
      actions: ['query', 'system_state'],
      defaultAction: 'query'
    });
    mockDispatchModuleAction.mockResolvedValue({ ok: true });
  });

  it('accepts nested payload prompts for canonical gpt routes', async () => {
    const response = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        action: 'query',
        payload: {
          prompt: 'Reply with exactly OK.',
          extra: 'kept'
        }
      },
      requestId: 'req_nested_query'
    });

    expect(response.ok).toBe(true);
    expect(mockDispatchModuleAction).toHaveBeenCalledWith(
      'ARCANOS:CORE',
      'query',
      expect.objectContaining({
        prompt: 'Reply with exactly OK.',
        extra: 'kept'
      })
    );
  });

  it('uses an explicit payload prompt instead of a conflicting top-level diagnostic prompt', async () => {
    const response = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        prompt: 'ping',
        payload: {
          prompt: 'Write a haiku.',
          extra: 'kept'
        }
      },
      requestId: 'req_payload_overrides_diagnostic_prompt'
    });

    expect(response.ok).toBe(true);
    expect(mockDispatchModuleAction).toHaveBeenCalledWith(
      'ARCANOS:CORE',
      'query',
      expect.objectContaining({
        prompt: 'Write a haiku.',
        extra: 'kept'
      })
    );
  });

  it('stores the GPT route template instead of caller-controlled URL segments in trace metadata', async () => {
    const previousMode = process.env.PROMPT_DEBUG_TRACE_MODE;
    const previousPersist = process.env.PROMPT_DEBUG_TRACE_PERSIST;
    process.env.PROMPT_DEBUG_TRACE_MODE = 'metadata';
    process.env.PROMPT_DEBUG_TRACE_PERSIST = 'false';

    try {
      await routeGptRequest({
        gptId: 'arcanos-core',
        body: {
          action: 'query',
          prompt: 'Reply with exactly OK.',
        },
        requestId: 'req_dynamic_endpoint_trace',
        request: {
          method: 'POST',
          originalUrl: '/gpt/alice@example.com?private=marker',
          url: '/gpt/alice@example.com?private=marker',
          path: '/gpt/alice@example.com',
        } as never,
      });

      const [trace] = await listPromptDebugTraces(
        1,
        'req_dynamic_endpoint_trace',
      );
      expect(trace?.endpoint).toBe('/gpt/:gptId');
      expect(JSON.stringify(trace)).not.toContain('alice@example.com');
    } finally {
      if (previousMode === undefined) {
        delete process.env.PROMPT_DEBUG_TRACE_MODE;
      } else {
        process.env.PROMPT_DEBUG_TRACE_MODE = previousMode;
      }
      if (previousPersist === undefined) {
        delete process.env.PROMPT_DEBUG_TRACE_PERSIST;
      } else {
        process.env.PROMPT_DEBUG_TRACE_PERSIST = previousPersist;
      }
    }
  });

  it('sanitizes mounted endpoint metadata for trim-compatible oversized route paths', async () => {
    const paddedGptId = `${' '.repeat(257)}arcanos-core`;
    const encodedGptId = encodeURIComponent(paddedGptId);
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    const response = await routeGptRequest({
      gptId: paddedGptId,
      body: {
        action: 'query',
        prompt: 'Preserve routing while bounding endpoint logs.',
      },
      requestId: 'req_padded_endpoint',
      logger,
      request: {
        method: 'POST',
        path: `/${encodedGptId}`,
        url: `/${encodedGptId}`,
        originalUrl: `/gpt/${encodedGptId}`,
      } as never,
    });

    expect(response.ok).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      'gpt.dispatch.received',
      expect.objectContaining({ endpoint: '/gpt/invalid' })
    );
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(encodedGptId);
  });

  it("maps nested legacy 'ask' payloads onto the canonical 'query' action", async () => {
    const response = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        action: 'ask',
        payload: {
          prompt: 'Reply with exactly OK.'
        }
      },
      requestId: 'req_nested_ask'
    });

    expect(response.ok).toBe(true);
    expect(mockDispatchModuleAction).toHaveBeenCalledWith(
      'ARCANOS:CORE',
      'query',
      expect.objectContaining({
        prompt: 'Reply with exactly OK.'
      })
    );
  });

  it('preserves the exact top-level prompt when query callers also send an explicit payload wrapper', async () => {
    const response = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        action: 'query',
        prompt: 'Reply with exactly OK.',
        payload: {
          executionMode: 'async',
          extra: 'kept'
        }
      },
      requestId: 'req_payload_prompt_query'
    });

    expect(response.ok).toBe(true);
    expect(mockDispatchModuleAction).toHaveBeenCalledWith(
      'ARCANOS:CORE',
      'query',
      expect.objectContaining({
        prompt: 'Reply with exactly OK.',
        executionMode: 'async',
        extra: 'kept'
      })
    );
  });

  it('accepts structured message content parts and forwards the original messages', async () => {
    const messages = [
      { role: 'system', content: 'You write compact operator notes.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Draft a release note for Trinity facade routing.' }
        ]
      }
    ];

    const response = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        action: 'query',
        messages
      },
      requestId: 'req_structured_messages_query'
    });

    expect(response.ok).toBe(true);
    expect(mockDispatchModuleAction).toHaveBeenCalledWith(
      'ARCANOS:CORE',
      'query',
      expect.objectContaining({
        messages,
        prompt: 'Draft a release note for Trinity facade routing.'
      })
    );
  });

  it('returns safe Trinity integrity diagnostics without exposing output text', async () => {
    const integrityError = new Error('Trinity direct-answer output failed integrity validation.');
    Object.assign(integrityError, {
      code: 'TRINITY_OUTPUT_INTEGRITY_FAILED',
      integrityIssues: ['abrupt_mid_sentence_ending']
    });
    mockDispatchModuleAction.mockRejectedValueOnce(integrityError);

    const response = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        action: 'query',
        prompt: 'Return exactly OBSERVABILITY_SMOKE_TEST_OK.'
      },
      requestId: 'req_integrity_failed',
      traceId: 'trace_integrity_failed'
    });

    expect(response).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        code: 'MODULE_ERROR',
        message: 'Trinity direct-answer output failed integrity validation.',
        details: {
          validator: 'validateTrinityAnswerIntegrity',
          failureCode: 'TRINITY_OUTPUT_INTEGRITY_FAILED',
          expectedShape: 'complete_user_visible_answer_text',
          receivedShape: 'redacted_text',
          issues: ['abrupt_mid_sentence_ending']
        }
      })
    }));
    expect(response._route).toEqual(expect.objectContaining({
      requestId: 'req_integrity_failed',
      traceId: 'trace_integrity_failed'
    }));
    expect(JSON.stringify(response)).not.toContain('OBSERVABILITY_SMOKE_TEST_OK');
  });

  it('maps typed research validation failures to the stable research code', async () => {
    mockGetGptModuleMap.mockResolvedValue({
      research: { route: 'research', module: 'ARCANOS:RESEARCH' },
    });
    mockGetModuleMetadata.mockReturnValue({
      name: 'ARCANOS:RESEARCH',
      description: null,
      route: 'research',
      actions: ['run'],
      defaultAction: 'run',
    });
    mockDispatchModuleAction.mockRejectedValueOnce(
      new ResearchRequestValidationError(
        'Research URLs must contain no more than 10 entries.',
      ),
    );

    const response = await routeGptRequest({
      gptId: 'research',
      body: { topic: 'bounded topic', urls: [] },
      requestId: 'req_research_validation',
    });

    expect(response).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        code: RESEARCH_REQUEST_VALIDATION_ERROR_CODE,
        message: 'Research URLs must contain no more than 10 entries.',
      }),
      _route: expect.objectContaining({
        module: 'ARCANOS:RESEARCH',
        action: 'run',
      }),
    }));
  });

  it.each([
    ['array', []],
    ['null', null],
    ['scalar', 'not-a-storyline-object'],
  ] as const)(
    'preserves an invalid %s storyline payload through /dispatch without a confirmation challenge',
    async (_shape, payload) => {
      mockGetGptModuleMap.mockResolvedValue({
        backstage: { route: 'backstage-booker', module: 'BACKSTAGE:BOOKER' },
      });
      mockGetModuleMetadata.mockReturnValue({
        name: 'BACKSTAGE:BOOKER',
        description: null,
        route: 'backstage-booker',
        actions: ['trackStoryline'],
        defaultAction: 'trackStoryline',
      });
      mockDispatchModuleAction.mockImplementationOnce(
        async (_moduleName: string, _action: string, dispatchedPayload: unknown) =>
          parseBackstageStorylinePayload(dispatchedPayload)
      );

      const response = await request(buildBackstageDispatchApp())
        .post('/dispatch')
        .send({
          target: 'gpt',
          gptId: 'backstage',
          action: 'trackStoryline',
          payload,
        });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        ok: false,
        error: {
          code: BACKSTAGE_STORYLINE_VALIDATION_ERROR_CODE,
          message: 'Storyline beat payload must be a JSON object.',
        },
        _route: {
          module: 'BACKSTAGE:BOOKER',
          action: 'trackStoryline',
        },
      });
      expect(response.headers['x-confirmation-challenge']).toBeUndefined();
      expect(response.headers['x-confirmation-status']).toBeUndefined();
      expect(mockDispatchModuleAction).toHaveBeenCalledWith(
        'BACKSTAGE:BOOKER',
        'trackStoryline',
        payload
      );
    }
  );

  it.each(['backstage', 'backstage-booker'])(
    'maps a non-transient storyline persistence failure for %s through /dispatch to a safe HTTP 500',
    async (gptId) => {
      mockGetGptModuleMap.mockResolvedValue({
        [gptId]: { route: 'backstage-booker', module: 'BACKSTAGE:BOOKER' },
      });
      mockGetModuleMetadata.mockReturnValue({
        name: 'BACKSTAGE:BOOKER',
        description: null,
        route: 'backstage-booker',
        actions: ['trackStoryline'],
        defaultAction: 'trackStoryline',
      });
      mockDispatchModuleAction.mockRejectedValueOnce(
        new BackstageStorylinePersistenceError(
          new Error('sensitive database invariant detail')
        )
      );

      const response = await request(buildBackstageDispatchApp())
        .post('/dispatch')
        .set('X-Confirmed', 'yes')
        .send({
          target: 'gpt',
          gptId,
          action: 'trackStoryline',
          payload: { sequence: 25, summary: 'Close the rivalry chapter.' },
        });

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({
        ok: false,
        error: {
          code: BACKSTAGE_STORYLINE_PERSISTENCE_ERROR_CODE,
          message: BACKSTAGE_STORYLINE_PERSISTENCE_ERROR_MESSAGE,
        },
        _route: {
          module: 'BACKSTAGE:BOOKER',
          action: 'trackStoryline',
        },
        target: 'gpt',
        routeFamily: 'dispatch',
      });
      expect(JSON.stringify(response.body)).not.toContain(
        BACKSTAGE_STORYLINE_VALIDATION_ERROR_CODE
      );
      expect(JSON.stringify(response.body)).not.toContain(
        'sensitive database invariant detail'
      );
      expect(mockDispatchModuleAction).toHaveBeenCalledTimes(1);
      expect(mockPersistModuleConversation).not.toHaveBeenCalled();
      expect(mockRebuildGptModuleMap).not.toHaveBeenCalled();
      expect(mockRecordUnknownGpt).not.toHaveBeenCalled();
    }
  );

  it.each([
    [
      'unavailable index',
      () => new BackstageNotionIndexUnavailableError(),
      'BACKSTAGE_NOTION_INDEX_UNAVAILABLE',
      503,
    ],
    [
      'missing scope',
      () => new BackstageNotionScopeResolutionError('not_found'),
      'BACKSTAGE_NOTION_SCOPE_UNRESOLVED',
      404,
    ],
    [
      'ambiguous scope',
      () => new BackstageNotionScopeResolutionError('ambiguous'),
      'BACKSTAGE_NOTION_SCOPE_UNRESOLVED',
      409,
    ],
    [
      'invalid cursor',
      () => new BackstageNotionCursorInvalidError(),
      'BACKSTAGE_NOTION_CURSOR_INVALID',
      409,
    ],
    [
      'incomplete output',
      () => new BackstageBookerOutputIncompleteError(),
      'BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE',
      500,
    ],
    [
      'internal continuity query failure',
      () => new BackstageContinuityQueryFailedError(),
      'BACKSTAGE_CONTINUITY_QUERY_FAILED',
      500,
    ],
  ] as const)(
    'maps a continuity %s through /dispatch and both legacy adapters',
    async (_caseName, createFailure, expectedCode, expectedStatus) => {
      mockGetGptModuleMap.mockResolvedValue({
        backstage: { route: 'backstage-booker', module: 'BACKSTAGE:BOOKER' },
      });
      mockGetModuleMetadata.mockReturnValue({
        name: 'BACKSTAGE:BOOKER',
        description: null,
        route: 'backstage-booker',
        actions: ['queryContinuity'],
        defaultAction: 'queryContinuity',
      });
      mockDispatchModuleAction.mockImplementation(async () => {
        throw createFailure();
      });

      const app = express();
      app.use(express.json());
      app.post('/dispatch', universalDispatch);
      for (const path of ['/modules/backstage-booker', '/queryroute'] as const) {
        app.post(path, async (req, res, next) => {
          await dispatchLegacyRouteToGpt(req, res, next, {
            legacyRoute: path,
            gptId: 'backstage',
            applyDeprecationHeaders: false,
          });
        });
      }

      const requestPayload = {
        action: 'queryContinuity',
        payload: {
          universeId: 'my-universe-2k26',
          query: 'Who is the current champion?',
        },
      };
      const responses = [
        await request(app).post('/dispatch').send({
          target: 'gpt',
          gptId: 'backstage',
          ...requestPayload,
        }),
        await request(app).post('/modules/backstage-booker').send(requestPayload),
        await request(app).post('/queryroute').send(requestPayload),
      ];

      for (const response of responses) {
        expect(response.status).toBe(expectedStatus);
        expect(response.body).toMatchObject({
          ok: false,
          error: {
            code: expectedCode,
          },
        });
      }
      expect(mockDispatchModuleAction).toHaveBeenCalledTimes(3);
    },
  );

  it.each([
    [
      'malformed cursor',
      { retrievalMode: 'complete_scope', cursor: '!' },
    ],
    [
      'mode-invalid cursor',
      { retrievalMode: 'relevant', cursor: 'eyJ2IjoxfQ' },
    ],
  ] as const)(
    'maps a service-validated %s to typed 409 through compatibility routes',
    async (_caseName, cursorFields) => {
      mockGetGptModuleMap.mockResolvedValue({
        backstage: { route: 'backstage-booker', module: 'BACKSTAGE:BOOKER' },
      });
      mockGetModuleMetadata.mockReturnValue({
        name: 'BACKSTAGE:BOOKER',
        description: null,
        route: 'backstage-booker',
        actions: ['queryContinuity'],
        defaultAction: 'queryContinuity',
      });
      mockDispatchModuleAction.mockImplementation(async (
        _moduleName,
        _action,
        payload
      ) => queryBackstageContinuity(payload));

      const app = express();
      app.use(express.json());
      app.post('/dispatch', universalDispatch);
      for (const path of ['/modules/backstage-booker', '/queryroute'] as const) {
        app.post(path, async (req, res, next) => {
          await dispatchLegacyRouteToGpt(req, res, next, {
            legacyRoute: path,
            gptId: 'backstage',
            applyDeprecationHeaders: false,
          });
        });
      }

      const requestPayload = {
        action: 'queryContinuity',
        payload: {
          universeId: 'my-universe-2k26',
          query: 'Continue the scoped read.',
          ...cursorFields,
        },
      };
      const responses = [
        await request(app).post('/dispatch').send({
          target: 'gpt',
          gptId: 'backstage',
          ...requestPayload,
        }),
        await request(app).post('/modules/backstage-booker').send(requestPayload),
        await request(app).post('/queryroute').send(requestPayload),
      ];

      for (const response of responses) {
        expect(response.status).toBe(409);
        expect(response.body).toMatchObject({
          ok: false,
          error: {
            code: 'BACKSTAGE_NOTION_CURSOR_INVALID',
            details: { retryable: false },
          },
        });
      }
      expect(mockDispatchModuleAction).toHaveBeenCalledTimes(3);
    }
  );

  it.each([
    [new BackstageCanonDomainError('BACKSTAGE_STORYLINE_NOT_FOUND'), 404],
    [new BackstageCanonDomainError('BACKSTAGE_STORYLINE_VERSION_CONFLICT'), 409],
    [new BackstageCanonUnavailableError('appendCanonBeat'), 503],
  ] as const)(
    'maps a canon failure through the legacy Backstage route to HTTP %i',
    async (failure, expectedStatus) => {
      mockGetGptModuleMap.mockResolvedValue({
        backstage: { route: 'backstage-booker', module: 'BACKSTAGE:BOOKER' },
      });
      mockGetModuleMetadata.mockReturnValue({
        name: 'BACKSTAGE:BOOKER',
        description: null,
        route: 'backstage-booker',
        actions: ['appendCanonBeat'],
        defaultAction: 'appendCanonBeat',
      });
      mockDispatchModuleAction.mockRejectedValueOnce(failure);

      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.controlPlanePrincipal = {
          audience: 'control-plane-http',
          role: 'operator',
          principalId: `operator:legacy-canon-${expectedStatus}`,
          scopes: ['mcp:invoke'],
        };
        next();
      });
      app.post(
        '/modules/backstage-booker',
        backstageMutationConfirmationGate,
        async (req, res, next) => {
          await dispatchLegacyRouteToGpt(req, res, next, {
            legacyRoute: '/modules/backstage-booker',
            gptId: 'backstage',
            applyDeprecationHeaders: false,
          });
        },
      );

      const response = await request(app)
        .post('/modules/backstage-booker')
        .set('X-Confirmed', 'yes')
        .send({
          action: 'appendCanonBeat',
          payload: {
            universeId: 'phase-two',
            mutationId: '44f73965-2760-4e8f-9d28-dbb4ea9a7527',
            storylineKey: 'summer-feud',
            expectedVersion: 1,
            beat: {
              kind: 'payoff',
              summary: 'The rivalry reaches its decisive match.',
              occurredAt: '2026-08-14T00:00:00.000Z',
              participantNames: [],
            },
          },
        });

      expect(response.status).toBe(expectedStatus);
      expect(response.body).toMatchObject({
        ok: false,
        error: {
          code: failure.code,
          message: failure.message,
        },
        _route: {
          module: 'BACKSTAGE:BOOKER',
          action: 'appendCanonBeat',
        },
      });
      expect(mockDispatchModuleAction).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['universal', 'legacy'] as const)(
    'propagates a %s Research disconnect and waits for cooperative drain',
    async (ingress) => {
      mockGetGptModuleMap.mockResolvedValue({
        research: { route: 'research', module: 'ARCANOS:RESEARCH' },
      });
      mockGetModuleMetadata.mockReturnValue({
        name: 'ARCANOS:RESEARCH',
        description: null,
        route: 'research',
        actions: ['run'],
        defaultAction: 'run',
        defaultTimeoutMs: 5_000,
      });
      const started = createDeferred();
      const aborted = createDeferred();
      const releaseDrain = createDeferred();
      const responseClosed = createDeferred();
      const routeFinished = createDeferred();
      let drained = false;
      let routeSettled = false;
      mockDispatchModuleAction.mockImplementationOnce(async () => {
        const signal = getRequestAbortSignal();
        expect(signal).toBeDefined();
        started.resolve();
        if (!signal?.aborted) {
          await new Promise<void>((resolve) => {
            signal?.addEventListener('abort', () => resolve(), { once: true });
          });
        }
        aborted.resolve();
        await releaseDrain.promise;
        drained = true;
        throw signal?.reason ?? createAbortError('Research client disconnected');
      });

      const app = express();
      app.use(express.json());
      app.use((_req, res, next) => {
        res.once('close', responseClosed.resolve);
        next();
      });
      const trackedUniversalDispatch = async (
        req: Request,
        res: Response,
        next: NextFunction,
      ) => {
        try {
          await universalDispatch(req, res);
        } catch (error) {
          next(error);
        } finally {
          routeSettled = true;
          routeFinished.resolve();
        }
      };
      const trackedLegacyDispatch = async (
        req: Request,
        res: Response,
        next: NextFunction,
      ) => {
        try {
          await dispatchLegacyRouteToGpt(req, res, next, {
            legacyRoute: '/modules/research',
            gptId: 'research',
            applyDeprecationHeaders: false,
          });
        } finally {
          routeSettled = true;
          routeFinished.resolve();
        }
      };
      if (ingress === 'universal') {
        app.post(
          '/dispatch',
          dispatchDagCompatibilityBoundary,
          dispatchResearchGptAdmissionBoundary,
        );
        app.post(
          '/dispatch',
          dispatchResearchGptPreflightBoundary,
          trackedUniversalDispatch,
        );
      } else {
        app.post('/modules/research', trackedLegacyDispatch);
      }

      const { port, server } = await listenOnEphemeralPort(app);
      try {
        const clientRequest = startJsonRequest({
          port,
          path: ingress === 'universal' ? '/dispatch' : '/modules/research',
          body: ingress === 'universal'
            ? {
                target: 'gpt',
                gptId: 'research',
                action: 'run',
                payload: { topic: `${ingress} disconnect drain` },
              }
            : {
                action: 'run',
                payload: { topic: `${ingress} disconnect drain` },
              },
        });

        await started.promise;
        clientRequest.destroy();
        await responseClosed.promise;
        await aborted.promise;
        await Promise.resolve();

        expect(routeSettled).toBe(false);
        expect(drained).toBe(false);

        releaseDrain.resolve();
        await routeFinished.promise;

        expect(drained).toBe(true);
      } finally {
        releaseDrain.resolve();
        await closeTestServer(server);
      }
    },
  );

  it.each(['universal', 'legacy'] as const)(
    'does not abort or detach a confirmed Backstage mutation after a %s client disconnect',
    async (ingress) => {
      mockGetGptModuleMap.mockResolvedValue({
        backstage: { route: 'backstage-booker', module: 'BACKSTAGE:BOOKER' },
      });
      mockGetModuleMetadata.mockReturnValue({
        name: 'BACKSTAGE:BOOKER',
        description: null,
        route: 'backstage-booker',
        actions: ['trackStoryline'],
        defaultAction: 'trackStoryline',
        defaultTimeoutMs: 5_000,
      });
      const started = createDeferred();
      const releaseMutation = createDeferred();
      const responseClosed = createDeferred();
      const routeFinished = createDeferred();
      let mutationCompleted = false;
      let operationSignal: AbortSignal | undefined;
      let operationAbortObserved = false;
      let routeSettled = false;
      mockDispatchModuleAction.mockImplementationOnce(async () => {
        operationSignal = getRequestAbortSignal();
        operationSignal?.addEventListener('abort', () => {
          operationAbortObserved = true;
        }, { once: true });
        started.resolve();
        await releaseMutation.promise;
        mutationCompleted = true;
        return [{ sequence: 25, summary: 'Close the rivalry chapter.' }];
      });

      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.controlPlanePrincipal = {
          audience: 'control-plane-http',
          role: 'operator',
          principalId: 'operator:disconnect-scope-test',
          scopes: ['mcp:invoke'],
        };
        next();
      });
      app.use((_req, res, next) => {
        res.once('close', responseClosed.resolve);
        next();
      });
      const trackedUniversalDispatch = async (
        req: Request,
        res: Response,
        next: NextFunction,
      ) => {
        try {
          await universalDispatch(req, res);
        } catch (error) {
          next(error);
        } finally {
          routeSettled = true;
          routeFinished.resolve();
        }
      };
      const trackedLegacyDispatch = async (
        req: Request,
        res: Response,
        next: NextFunction,
      ) => {
        try {
          await dispatchLegacyRouteToGpt(req, res, next, {
            legacyRoute: '/modules/backstage-booker',
            gptId: 'backstage',
            applyDeprecationHeaders: false,
          });
        } finally {
          routeSettled = true;
          routeFinished.resolve();
        }
      };
      app.post(
        ingress === 'universal' ? '/dispatch' : '/modules/backstage-booker',
        backstageMutationConfirmationGate,
        ingress === 'universal'
          ? trackedUniversalDispatch
          : trackedLegacyDispatch,
      );

      const { port, server } = await listenOnEphemeralPort(app);
      try {
        const clientRequest = startJsonRequest({
          port,
          path: ingress === 'universal' ? '/dispatch' : '/modules/backstage-booker',
          headers: { 'x-confirmed': 'yes' },
          body: ingress === 'universal'
            ? {
                target: 'gpt',
                gptId: 'backstage',
                action: 'trackStoryline',
                payload: { sequence: 25, summary: 'Close the rivalry chapter.' },
              }
            : {
                action: 'trackStoryline',
                payload: { sequence: 25, summary: 'Close the rivalry chapter.' },
              },
        });

        await started.promise;
        expect(operationSignal).toBeDefined();
        clientRequest.destroy();
        await responseClosed.promise;
        await new Promise<void>(resolve => setImmediate(resolve));

        expect(operationSignal?.aborted).toBe(false);
        expect(operationAbortObserved).toBe(false);
        expect(routeSettled).toBe(false);
        expect(mutationCompleted).toBe(false);

        releaseMutation.resolve();
        await routeFinished.promise;

        expect(mutationCompleted).toBe(true);
        expect(operationAbortObserved).toBe(false);
      } finally {
        releaseMutation.resolve();
        await closeTestServer(server);
      }
    },
  );

  it('does not start Research work for a pre-aborted parent request', async () => {
    mockGetGptModuleMap.mockResolvedValue({
      research: { route: 'research', module: 'ARCANOS:RESEARCH' },
    });
    mockGetModuleMetadata.mockReturnValue({
      name: 'ARCANOS:RESEARCH',
      description: null,
      route: 'research',
      actions: ['run'],
      defaultAction: 'run',
      defaultTimeoutMs: 1_000,
    });
    const parentController = new AbortController();
    parentController.abort(createAbortError('Research client disconnected'));

    const response = await routeGptRequest({
      gptId: 'research',
      body: { topic: 'pre-aborted request' },
      requestId: 'req_research_pre_aborted',
      parentAbortSignal: parentController.signal,
    });

    expect(response).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: 'REQUEST_ABORTED' }),
    }));
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
  });

  it('does not renew Research work after an ambient absolute deadline expires', async () => {
    mockGetGptModuleMap.mockResolvedValue({
      research: { route: 'research', module: 'ARCANOS:RESEARCH' },
    });
    mockGetModuleMetadata.mockReturnValue({
      name: 'ARCANOS:RESEARCH',
      description: null,
      route: 'research',
      actions: ['run'],
      defaultAction: 'run',
      defaultTimeoutMs: 1_000,
    });
    const ambientController = new AbortController();

    const response = await runWithRequestAbortContext(
      {
        requestId: 'req_research_expired_deadline',
        controller: ambientController,
        signal: ambientController.signal,
        deadlineAt: Date.now() - 1,
        timeoutMs: 1_000,
      },
      () => routeGptRequest({
        gptId: 'research',
        body: { topic: 'expired workflow deadline' },
        requestId: 'req_research_expired_deadline',
      }),
    );

    expect(response).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: 'MODULE_TIMEOUT' }),
    }));
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
  });

  it('waits for cancelled Research work to drain before returning a disconnect envelope', async () => {
    mockGetGptModuleMap.mockResolvedValue({
      research: { route: 'research', module: 'ARCANOS:RESEARCH' },
    });
    mockGetModuleMetadata.mockReturnValue({
      name: 'ARCANOS:RESEARCH',
      description: null,
      route: 'research',
      actions: ['run'],
      defaultAction: 'run',
      defaultTimeoutMs: 1_000,
    });
    const started = createDeferred();
    const aborted = createDeferred();
    const releaseDrain = createDeferred();
    let drained = false;
    mockDispatchModuleAction.mockImplementationOnce(async () => {
      const signal = getRequestAbortSignal();
      expect(signal).toBeDefined();
      started.resolve();
      if (!signal?.aborted) {
        await new Promise<void>((resolve) => {
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      aborted.resolve();
      await releaseDrain.promise;
      drained = true;
      throw signal?.reason ?? createAbortError('Research client disconnected');
    });
    const parentController = new AbortController();
    let settled = false;

    const pending = routeGptRequest({
      gptId: 'research',
      body: { topic: 'disconnect drain' },
      requestId: 'req_research_disconnect_drain',
      parentAbortSignal: parentController.signal,
    });
    void pending.then(() => {
      settled = true;
    });
    await started.promise;
    parentController.abort(createAbortError('Research client disconnected'));
    await aborted.promise;
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(drained).toBe(false);

    releaseDrain.resolve();
    const response = await pending;

    expect(drained).toBe(true);
    expect(response).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: 'REQUEST_ABORTED' }),
    }));
  });

  it('waits for timed-out Research work to drain before returning a timeout envelope', async () => {
    mockGetGptModuleMap.mockResolvedValue({
      research: { route: 'research', module: 'ARCANOS:RESEARCH' },
    });
    mockGetModuleMetadata.mockReturnValue({
      name: 'ARCANOS:RESEARCH',
      description: null,
      route: 'research',
      actions: ['run'],
      defaultAction: 'run',
      defaultTimeoutMs: 20,
    });
    const started = createDeferred();
    const aborted = createDeferred();
    const releaseDrain = createDeferred();
    let drained = false;
    mockDispatchModuleAction.mockImplementationOnce(async () => {
      const signal = getRequestAbortSignal();
      expect(signal).toBeDefined();
      started.resolve();
      if (!signal?.aborted) {
        await new Promise<void>((resolve) => {
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      aborted.resolve();
      await releaseDrain.promise;
      drained = true;
      throw signal?.reason ?? createAbortError('Research workflow timed out');
    });
    let settled = false;

    const pending = routeGptRequest({
      gptId: 'research',
      body: { topic: 'timeout drain' },
      requestId: 'req_research_timeout_drain',
    });
    void pending.then(() => {
      settled = true;
    });
    await started.promise;
    await aborted.promise;
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(drained).toBe(false);

    releaseDrain.resolve();
    const response = await pending;

    expect(drained).toBe(true);
    expect(response).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: 'MODULE_TIMEOUT' }),
    }));
  });

  it('does not start generic transcript persistence after a Research run', async () => {
    mockGetGptModuleMap.mockResolvedValue({
      research: { route: 'research', module: 'ARCANOS:RESEARCH' },
    });
    mockGetModuleMetadata.mockReturnValue({
      name: 'ARCANOS:RESEARCH',
      description: null,
      route: 'research',
      actions: ['run'],
      defaultAction: 'run',
      defaultTimeoutMs: 1_000,
    });

    const response = await routeGptRequest({
      gptId: 'research',
      body: {
        topic: 'workflow-owned persistence',
        sessionId: 'research-session',
      },
      requestId: 'req_research_persistence_fence',
    });

    expect(response.ok).toBe(true);
    expect(mockPersistModuleConversation).not.toHaveBeenCalled();
  });

  it('rejects an over-limit Research /dispatch request after one admission and before work', async () => {
    mockGetGptModuleMap.mockResolvedValue({
      'custom-research': { route: 'research', module: 'ARCANOS:RESEARCH' },
    });
    mockGetModuleMetadata.mockReturnValue({
      name: 'ARCANOS:RESEARCH',
      description: null,
      route: 'research',
      actions: ['run'],
      defaultAction: 'run',
    });
    const rateLimitMiddleware = jest.fn(
      (_req: Request, res: Response, next: NextFunction) => {
        res.setHeader('x-ratelimit-bucket', 'research-dispatch-test');
        next();
      },
    );

    const response = await request(buildResearchDispatchApp(rateLimitMiddleware))
      .post('/dispatch')
      .send({
        target: 'gpt',
        gptId: 'custom-research',
        action: 'run',
        payload: { topic: 't'.repeat(501) },
      });

    expect(response.status).toBe(400);
    expect(response.headers['x-ratelimit-bucket']).toBe('research-dispatch-test');
    expect(response.body.error).toEqual(expect.objectContaining({
      code: RESEARCH_REQUEST_VALIDATION_ERROR_CODE,
      message: 'Research topic must be no more than 500 JavaScript String.length units.',
    }));
    expect(rateLimitMiddleware).toHaveBeenCalledTimes(1);
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
  });

  it('accepts an exactly 500-unit Research topic through /dispatch', async () => {
    mockGetGptModuleMap.mockResolvedValue({
      'custom-research': { route: 'research', module: 'ARCANOS:RESEARCH' },
    });
    mockGetModuleMetadata.mockReturnValue({
      name: 'ARCANOS:RESEARCH',
      description: null,
      route: 'research',
      actions: ['run'],
      defaultAction: 'run',
    });
    const rateLimitMiddleware = jest.fn(
      (_req: Request, res: Response, next: NextFunction) => {
        res.setHeader('x-ratelimit-bucket', 'research-dispatch-test');
        next();
      },
    );

    const response = await request(buildResearchDispatchApp(rateLimitMiddleware))
      .post('/dispatch')
      .send({
        target: 'gpt',
        gptId: 'custom-research',
        action: 'run',
        payload: { topic: 't'.repeat(500) },
      });

    expect(response.status).toBe(200);
    expect(response.headers['x-ratelimit-bucket']).toBe('research-dispatch-test');
    expect(rateLimitMiddleware).toHaveBeenCalledTimes(1);
    expect(mockDispatchModuleAction).toHaveBeenCalledWith(
      'ARCANOS:RESEARCH',
      'run',
      expect.objectContaining({ topic: 't'.repeat(500) }),
    );
  });

  it('rejects over-limit Research messages before generic message traversal', async () => {
    mockGetGptModuleMap.mockResolvedValue({
      'custom-research': { route: 'research', module: 'ARCANOS:RESEARCH' },
    });
    mockGetModuleMetadata.mockReturnValue({
      name: 'ARCANOS:RESEARCH',
      description: null,
      route: 'research',
      actions: ['run'],
      defaultAction: 'run',
    });
    const content = ['m'.repeat(501)];
    Object.defineProperty(content, 'map', {
      value: () => {
        throw new Error('unbounded message traversal');
      },
    });

    const response = await routeGptRequest({
      gptId: 'custom-research',
      body: {
        messages: [{ role: 'user', content }],
      },
      requestId: 'req_research_bounded_messages',
    });

    expect(response).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        code: RESEARCH_REQUEST_VALIDATION_ERROR_CODE,
      }),
    }));
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
  });

  it('does not traverse ignored Research messages when a bounded topic is supplied', async () => {
    mockGetGptModuleMap.mockResolvedValue({
      'custom-research': { route: 'research', module: 'ARCANOS:RESEARCH' },
    });
    mockGetModuleMetadata.mockReturnValue({
      name: 'ARCANOS:RESEARCH',
      description: null,
      route: 'research',
      actions: ['run'],
      defaultAction: 'run',
    });
    const content = ['ignored'];
    Object.defineProperty(content, 'map', {
      value: () => {
        throw new Error('unbounded message traversal');
      },
    });

    const response = await routeGptRequest({
      gptId: 'custom-research',
      body: {
        topic: 'bounded topic',
        messages: [{ role: 'user', content }],
      },
      requestId: 'req_research_ignored_messages',
    });

    expect(response.ok).toBe(true);
    expect(mockDispatchModuleAction).toHaveBeenCalledWith(
      'ARCANOS:RESEARCH',
      'run',
      expect.objectContaining({ topic: 'bounded topic' }),
    );
  });

  it('preserves top-level ping fallback before explicit Research payload validation', async () => {
    mockGetGptModuleMap.mockResolvedValue({
      research: { route: 'research', module: 'ARCANOS:RESEARCH' },
    });
    mockGetModuleMetadata.mockReturnValue({
      name: 'ARCANOS:RESEARCH',
      description: null,
      route: 'research',
      actions: ['run'],
      defaultAction: 'run',
    });

    const response = await routeGptRequest({
      gptId: 'research',
      body: {
        prompt: 'ping',
        payload: {
          prompt: '',
          topic: 't'.repeat(501),
        },
      },
      requestId: 'req_research_top_level_diagnostic_fallback',
    });

    expect(response).toEqual(expect.objectContaining({
      ok: true,
      result: expect.objectContaining({ route: 'diagnostic' }),
      _route: expect.objectContaining({
        module: 'diagnostic',
        action: 'diagnostic',
      }),
    }));
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
  });

  it('does not remap a research-typed error from another module', async () => {
    mockDispatchModuleAction.mockRejectedValueOnce(
      new ResearchRequestValidationError('Research topic is required.'),
    );

    const response = await routeGptRequest({
      gptId: 'arcanos-core',
      body: { prompt: 'Run the core action.' },
      requestId: 'req_non_research_validation',
    });

    expect(response).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: 'MODULE_ERROR' }),
    }));
  });

  it('resolves normalized GPT IDs without executing a module action', async () => {
    const response = await resolveGptRouting(' ARCANOS-CORE ', 'req_resolve_normalized');

    expect(response).toEqual(
      expect.objectContaining({
        ok: true,
        plan: expect.objectContaining({
          matchedId: 'arcanos-core',
          module: 'ARCANOS:CORE',
          route: 'core',
          action: 'query',
          availableActions: ['query', 'system_state'],
          matchMethod: 'normalized'
        }),
        _route: expect.objectContaining({
          requestId: 'req_resolve_normalized',
          gptId: 'ARCANOS-CORE',
          module: 'ARCANOS:CORE',
          route: 'core',
          action: 'query',
          matchMethod: 'normalized'
        })
      })
    );
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
  });

  it.each(['default', 'foo-arcanos-bar'])('keeps unregistered GPT ID %s unknown', async (gptId) => {
    const response = await resolveGptRouting(gptId, `req_unknown_${gptId}`);

    expect(response).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        code: 'UNKNOWN_GPT'
      }),
      _route: expect.objectContaining({
        requestId: `req_unknown_${gptId}`,
        gptId
      })
    }));
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
  });

  it('rejects oversized GPT identifiers before registry, GPT logging, metrics, or response echo', async () => {
    const oversizedGptId = 'x'.repeat(257);
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    const resolved = await resolveGptRouting(oversizedGptId, 'req_oversized_resolve');
    const dispatched = await routeGptRequest({
      gptId: oversizedGptId,
      body: { prompt: 'This request must stop at the identifier boundary.' },
      requestId: 'req_oversized_dispatch',
      logger,
    });

    for (const response of [resolved, dispatched]) {
      expect(response).toEqual(expect.objectContaining({
        ok: false,
        error: {
          code: 'BAD_REQUEST',
          message: 'gptId too long',
        },
      }));
    }
    expect(JSON.stringify([resolved, dispatched])).not.toContain(oversizedGptId);
    expect(mockInitializeModuleRegistry).not.toHaveBeenCalled();
    expect(mockGetGptModuleMap).not.toHaveBeenCalled();
    expect(mockRebuildGptModuleMap).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(mockRecordUnknownGpt).not.toHaveBeenCalled();
    expect(mockRecordDispatcherRoute).not.toHaveBeenCalled();
  });

  it('uses one bounded dispatcher label for unregistered GPT identifiers', async () => {
    const response = await routeGptRequest({
      gptId: 'attacker-selected-unknown-gpt',
      body: { prompt: 'This identifier is not registered.' },
      requestId: 'req_unknown_metric_label',
    });

    expect(response).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: 'UNKNOWN_GPT' }),
    }));
    expect(mockRecordUnknownGpt).toHaveBeenCalledTimes(1);
    expect(mockRecordDispatcherRoute).toHaveBeenCalledWith(expect.objectContaining({
      gpt: { kind: 'unresolved' },
      module: 'unknown',
      route: 'unknown',
      handler: 'unknown-gpt',
      outcome: 'error',
    }));
  });

  it.each([
    ['normalized', 'ARCANOS-CORE'],
    ['substring', 'client-arcanos-core-alias'],
    ['token-subset', 'arcanos extra core'],
    ['fuzzy', 'arcanos-cor'],
  ])('uses the finite registered match for dispatcher metrics after %s routing', async (matchMethod, gptId) => {
    const response = await routeGptRequest({
      gptId,
      body: {
        action: 'query',
        prompt: 'Use the registered metric identity.'
      },
      requestId: `req_${matchMethod}_metric_label`
    });

    expect(response.ok).toBe(true);
    expect(response._route.matchMethod).toBe(matchMethod);
    expect(mockRecordDispatcherRoute).toHaveBeenCalledWith(expect.objectContaining({
      gpt: { kind: 'registered', id: 'arcanos-core' },
      module: 'ARCANOS:CORE',
      route: 'core',
      handler: 'module-dispatcher',
      outcome: 'ok',
    }));
  });

  it('uses one bounded diagnostic metric identity for one thousand rotating route IDs', async () => {
    const responses = await Promise.all(
      Array.from({ length: 1_000 }, (_, index) => routeGptRequest({
        gptId: `caller-selected-diagnostic-${index}`,
        body: { action: 'ping' },
        requestId: `req_diagnostic_metric_${index}`,
      }))
    );

    expect(responses).toHaveLength(1_000);
    expect(responses.every((response) => (
      response.ok === true && response._route.route === 'diagnostic'
    ))).toBe(true);
    expect(mockGetGptModuleMap).not.toHaveBeenCalled();
    expect(mockRecordDispatcherRoute).toHaveBeenCalledTimes(1_000);
    expect(mockRecordDispatcherRoute.mock.calls.every(([metricInput]) => (
      JSON.stringify(metricInput) === JSON.stringify({
        gpt: { kind: 'diagnostic' },
        module: 'diagnostic',
        route: 'diagnostic',
        handler: 'diagnostic',
        outcome: 'ok',
      })
    ))).toBe(true);
  });

  it('does not traverse message content for an explicit diagnostic action', async () => {
    const messages = new Proxy([{ role: 'user', content: ['ignored'] }], {
      get(target, property, receiver) {
        if (property === '0' || property === 'map') {
          throw new Error('diagnostic messages were traversed');
        }
        return Reflect.get(target, property, receiver);
      },
      getOwnPropertyDescriptor(target, property) {
        if (property === '0') {
          throw new Error('diagnostic messages were inspected');
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });

    const response = await routeGptRequest({
      gptId: 'research',
      body: { action: 'ping', messages },
      requestId: 'req_bounded_explicit_diagnostic',
    });

    expect(response).toEqual(expect.objectContaining({
      ok: true,
      result: expect.objectContaining({ route: 'diagnostic' }),
    }));
    expect(mockGetGptModuleMap).not.toHaveBeenCalled();
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
  });

  it.each([
    'cli',
    'arcanos-cli',
    'ARCANOS:CLI',
    'local-agent',
    'arcanos-local-agent',
    'ARCANOS:LOCAL_AGENT',
    'productivity',
    'arcanos-productivity',
    'ARCANOS:PRODUCTIVITY'
  ])('keeps protected module identifier %s out of fuzzy public routing', async (gptId) => {
    const resolved = await resolveGptRouting(
      gptId,
      `req_protected_resolve_${gptId}`
    );
    const dispatched = await routeGptRequest({
      gptId,
      body: {
        prompt: 'This protected identifier must remain unavailable.'
      },
      requestId: `req_protected_dispatch_${gptId}`
    });

    for (const response of [resolved, dispatched]) {
      expect(response).toEqual(expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: 'UNKNOWN_GPT'
        })
      }));
    }
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
  });
});
