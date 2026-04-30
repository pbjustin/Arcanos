import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRouteGptRequest = jest.fn();
const mockResolveGptRouting = jest.fn();
const mockExecuteSystemStateRequest = jest.fn();
const mockExecuteRuntimeInspection = jest.fn();
const mockGetWorkerControlStatus = jest.fn();
const mockGetWorkerControlHealth = jest.fn();
const mockBuildSafetySelfHealSnapshot = jest.fn();
const mockGetDiagnosticsSnapshot = jest.fn();

class MockSystemStateConflictError extends Error {
  readonly code = 'SYSTEM_STATE_CONFLICT';

  constructor(readonly conflict: Record<string, unknown>) {
    super('system_state update conflict');
  }
}

jest.unstable_mockModule('../src/routes/_core/gptDispatch.js', () => ({
  resolveGptRouting: mockResolveGptRouting,
  routeGptRequest: mockRouteGptRequest,
}));

jest.unstable_mockModule('../src/platform/logging/gptLogger.js', () => ({
  logGptConnection: jest.fn(),
  logGptConnectionFailed: jest.fn(),
  logGptAckSent: jest.fn(),
}));

jest.unstable_mockModule('../src/services/systemState.js', () => ({
  executeSystemStateRequest: mockExecuteSystemStateRequest,
  SystemStateConflictError: MockSystemStateConflictError,
}));

jest.unstable_mockModule('../src/services/runtimeInspectionRoutingService.js', () => ({
  executeRuntimeInspection: mockExecuteRuntimeInspection,
  classifyRuntimeInspectionPrompt: jest.fn(() => ({
    detectedIntent: 'STANDARD',
    matchedKeywords: [],
    repoInspectionDisabled: false,
    onlyReturnRuntimeValues: false,
  })),
}));

jest.unstable_mockModule('../src/services/workerControlService.js', () => ({
  getWorkerControlStatus: mockGetWorkerControlStatus,
  getWorkerControlHealth: mockGetWorkerControlHealth,
}));

jest.unstable_mockModule('../src/services/selfHealRuntimeInspectionService.js', () => ({
  buildSafetySelfHealSnapshot: mockBuildSafetySelfHealSnapshot,
}));

jest.unstable_mockModule('../src/core/diagnostics.js', () => ({
  getDiagnosticsSnapshot: mockGetDiagnosticsSnapshot,
}));

const { default: requestContext } = await import('../src/middleware/requestContext.js');
const { default: gptRouter } = await import('../src/routes/gptRouter.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  app.use('/gpt', gptRouter);
  return app;
}

function buildOversizedRuntimeInspectionResponse() {
  return {
    ok: true,
    responsePayload: {
      handledBy: 'runtime-inspection',
      runtimeInspection: {
        status: 'ok',
        summary: 'Collected live runtime state from 5 runtime sources.',
        detectedIntent: 'RUNTIME_INSPECTION_REQUIRED',
        toolsSelected: [
          '/worker-helper/health',
          '/workers/status',
          'system.metrics',
          '/api/self-heal/events',
          '/api/self-heal/inspection',
        ],
        runtimeEndpointsQueried: ['/worker-helper/health', '/workers/status'],
        sources: [
          {
            sourceType: 'worker-health',
            tool: '/worker-helper/health',
            data: {
              alerts: Array.from({ length: 40 }, (_, index) => `alert-${index}-${'a'.repeat(160)}`),
              workers: Array.from({ length: 40 }, (_, index) => ({
                workerId: `worker-${index}`,
                healthStatus: 'healthy',
                diagnostics: 'w'.repeat(240),
              })),
            },
          },
          {
            sourceType: 'worker-health',
            tool: '/workers/status',
            data: {
              queueDetails: Array.from({ length: 40 }, (_, index) => ({
                id: `queue-${index}`,
                detail: 'q'.repeat(240),
              })),
            },
          },
          {
            sourceType: 'metrics',
            tool: 'system.metrics',
            data: {
              diagnostics: {
                recent_latency_ms: Array.from({ length: 80 }, (_, index) => index),
                memorySamples: Array.from({ length: 40 }, (_, index) => ({
                  index,
                  heap: 'm'.repeat(220),
                })),
              },
            },
          },
          {
            sourceType: 'runtime-endpoint',
            tool: '/api/self-heal/events',
            data: {
              events: Array.from({ length: 80 }, (_, index) => ({
                id: `evt-${index}`,
                type: 'HEAL_RESULT',
                message: 'e'.repeat(260),
              })),
            },
          },
          {
            sourceType: 'runtime-endpoint',
            tool: '/api/self-heal/inspection',
            data: {
              evidence: {
                traces: Array.from({ length: 80 }, (_, index) => ({
                  id: `trace-${index}`,
                  detail: 't'.repeat(260),
                })),
              },
            },
          },
        ],
        failures: Array.from({ length: 40 }, (_, index) => ({
          tool: `tool-${index}`,
          error: 'z'.repeat(220),
        })),
      },
    },
    routingDebug: {
      requestId: 'req-runtime-oversized',
      timestamp: '2026-04-15T00:00:00.000Z',
      rawPrompt: 'full raw runtime inspection with everything included',
      normalizedPrompt: 'full raw runtime inspection with everything included',
      detectedIntent: 'RUNTIME_INSPECTION_REQUIRED',
      routingDecision: 'runtime_inspection_completed',
      toolsAvailable: ['system.metrics'],
      toolsSelected: ['system.metrics'],
      cliUsed: false,
      runtimeEndpointsQueried: ['/workers/status'],
      repoFallbackUsed: false,
      constraintViolations: [],
    },
    repoFallbackAllowed: false,
    selectedTools: ['system.metrics'],
    runtimeEndpointsQueried: ['/workers/status'],
    cliUsed: false,
  };
}

function buildOversizedSelfHealSnapshot() {
  return {
    status: 'ok',
    enabled: true,
    active: false,
    isHealing: false,
    lastTriggerReason: 'steady_state',
    lastHealedComponent: 'worker-service',
    lastHealAction: 'restart_worker',
    lastHealRun: '2026-04-15T00:00:00.000Z',
    systemState: {
      status: 'healthy',
      detail: 's'.repeat(500),
    },
    loopRunning: true,
    inFlight: false,
    lastDiagnosis: 'healthy',
    lastAction: 'restart_worker',
    lastActionAt: '2026-04-15T00:00:00.000Z',
    lastError: null,
    activeMitigation: null,
    degradedModeReason: null,
    recentTimeoutCounts: {
      prompt: 0,
    },
    lastVerificationResult: {
      status: 'ok',
      evidence: 'v'.repeat(800),
    },
    recentEvents: Array.from({ length: 80 }, (_, index) => ({
      id: `evt-${index}`,
      type: 'HEAL_RESULT',
      message: 'h'.repeat(260),
    })),
    promptRouteMitigation: {
      active: false,
      diagnostics: 'p'.repeat(800),
    },
    trinity: {
      enabled: true,
      diagnostics: 'r'.repeat(800),
    },
    predictiveHealing: {
      recentObservations: Array.from({ length: 80 }, (_, index) => ({
        id: `obs-${index}`,
        memory: {
          rssMb: 128 + index,
          heapUsedMb: 64 + index,
          detail: 'o'.repeat(260),
        },
      })),
      trends: {
        memoryGrowthMb: 0,
        detail: 'n'.repeat(800),
      },
      aiProvider: {
        configured: false,
        detail: 'a'.repeat(800),
      },
    },
    inspection: {
      lastDispatchAttempt: {
        at: '2026-04-15T00:00:00.000Z',
        detail: 'd'.repeat(800),
      },
      lastWorkerReceipt: {
        at: '2026-04-15T00:00:00.000Z',
        detail: 'w'.repeat(800),
      },
    },
  };
}

describe('gpt router universal dispatch', () => {
  const originalGptRouteAsyncCoreDefault = process.env.GPT_ROUTE_ASYNC_CORE_DEFAULT;
  const originalClientResponseMaxBytes = process.env.CLIENT_RESPONSE_MAX_BYTES;
  const originalGptPublicResponseMaxBytes = process.env.GPT_PUBLIC_RESPONSE_MAX_BYTES;
  const originalDebugGptControls = process.env.ARCANOS_ENABLE_DEBUG_GPT_CONTROLS;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GPT_ROUTE_ASYNC_CORE_DEFAULT = 'false';
    delete process.env.CLIENT_RESPONSE_MAX_BYTES;
    delete process.env.GPT_PUBLIC_RESPONSE_MAX_BYTES;
    delete process.env.ARCANOS_ENABLE_DEBUG_GPT_CONTROLS;
    process.env.NODE_ENV = originalNodeEnv;

    mockResolveGptRouting.mockImplementation(async (gptId: string) => ({
      ok: true,
      plan: {
        matchedId: gptId,
        module: 'ARCANOS:CORE',
        route: 'core',
        action: 'query',
        availableActions: ['query'],
        moduleVersion: null,
        moduleDescription: null,
        matchMethod: 'exact'
      },
      _route: {
        gptId,
        route: 'core',
        module: 'ARCANOS:CORE',
        action: 'query',
        timestamp: '2026-04-24T00:00:00.000Z'
      }
    }));

    mockRouteGptRequest.mockResolvedValue({
      ok: true,
      result: { handledBy: 'module-dispatch' },
      _route: {
        gptId: 'arcanos-core',
        module: 'ARCANOS:CORE',
        route: 'core',
        action: 'query',
        timestamp: '2026-04-15T00:00:00.000Z',
      },
    });

    mockGetDiagnosticsSnapshot.mockResolvedValue({
      ok: true,
      registered_gpts: ['arcanos-core'],
      active_routes: ['/gpt/arcanos-core'],
    });

    mockExecuteRuntimeInspection.mockResolvedValue({
      ok: true,
      responsePayload: {
        handledBy: 'runtime-inspection',
        runtimeInspection: {
          status: 'ok',
          summary: 'Collected live runtime state from 5 runtime sources.',
          detectedIntent: 'RUNTIME_INSPECTION_REQUIRED',
          matchedKeywords: ['runtime', 'workers'],
          repoInspectionDisabled: false,
          onlyReturnRuntimeValues: false,
          toolsSelected: [
            '/worker-helper/health',
            '/workers/status',
            'system.metrics',
            '/api/self-heal/events',
            '/api/self-heal/inspection',
          ],
          runtimeEndpointsQueried: ['/worker-helper/health', '/workers/status'],
          evidence: {
            traceId: 'trace-1',
            collectedAt: '2026-04-15T00:00:00.000Z',
          },
          sources: [
            {
              sourceType: 'worker-health',
              tool: '/worker-helper/health',
              data: {
                overallStatus: 'healthy',
                pending: 2,
                running: 1,
                alerts: [],
              },
            },
            {
              sourceType: 'worker-health',
              tool: '/workers/status',
              data: {
                status: 'ok',
                arcanosWorkers: {
                  count: 1,
                  status: 'Active',
                },
              },
            },
            {
              sourceType: 'metrics',
              tool: 'system.metrics',
              data: {
                health: {
                  status: 'ok',
                  memory: {
                    rss_mb: 128,
                    heap_used_mb: 64,
                  },
                },
                diagnostics: {
                  requests_total: 42,
                },
              },
            },
            {
              sourceType: 'runtime-endpoint',
              tool: '/api/self-heal/events',
              data: {
                events: [
                  {
                    id: 'evt-1',
                    type: 'HEAL_RESULT',
                  },
                ],
              },
            },
            {
              sourceType: 'runtime-endpoint',
              tool: '/api/self-heal/inspection',
              data: {
                summary: 'inspection summary',
                evidence: {
                  node: 'trace-node-1',
                },
              },
            },
          ],
          failures: [
            {
              tool: 'cli:workers',
              error: 'timeout',
            },
          ],
        },
      },
      routingDebug: {
        requestId: 'req-runtime-1',
        timestamp: '2026-04-15T00:00:00.000Z',
        rawPrompt: 'runtime inspect live runtime status',
        normalizedPrompt: 'runtime inspect live runtime status',
        detectedIntent: 'RUNTIME_INSPECTION_REQUIRED',
        routingDecision: 'runtime_inspection_completed',
        toolsAvailable: ['system.metrics'],
        toolsSelected: ['system.metrics'],
        cliUsed: false,
        runtimeEndpointsQueried: ['/workers/status'],
        repoFallbackUsed: false,
        constraintViolations: [],
      },
      repoFallbackAllowed: false,
      selectedTools: ['system.metrics'],
      runtimeEndpointsQueried: ['/workers/status'],
      cliUsed: false,
    });

    mockGetWorkerControlStatus.mockResolvedValue({
      timestamp: '2026-04-15T00:00:00.000Z',
      mainApp: {
        connected: true,
        workerId: 'main-app',
        runtime: {
          enabled: true,
          started: true,
          configuredCount: 1,
          model: 'gpt-4o',
        },
      },
      workerService: {
        observationMode: 'queue-observed',
        database: {
          connected: true,
        },
        queueSummary: {
          pending: 2,
          running: 1,
        },
        queueSemantics: {
          failedCountMode: 'retained_terminal_jobs',
        },
        retryPolicy: {
          defaultMaxRetries: 3,
        },
        recentFailedJobs: [],
        latestJob: {
          id: 'job-1',
        },
        health: {
          overallStatus: 'healthy',
          alerts: [],
          diagnosticAlerts: [],
          operationalHealth: {},
          historicalDebt: {},
          workers: [],
        },
      },
    });

    mockBuildSafetySelfHealSnapshot.mockReturnValue({
      status: 'ok',
      enabled: true,
      active: false,
      isHealing: false,
      lastTriggerReason: 'steady_state',
      lastHealedComponent: 'worker-service',
      lastHealAction: 'restart_worker',
      lastHealRun: '2026-04-15T00:00:00.000Z',
      systemState: {
        status: 'healthy',
        latency: 12,
      },
      loopRunning: true,
      inFlight: false,
      lastDiagnosis: 'healthy',
      lastAction: 'restart_worker',
      lastActionAt: '2026-04-15T00:00:00.000Z',
      lastError: null,
      activeMitigation: null,
      degradedModeReason: null,
      recentTimeoutCounts: {
        prompt: 0,
      },
      lastVerificationResult: {
        status: 'ok',
      },
      lastFailure: null,
      lastFallback: null,
      recentEvents: [
        {
          id: 'evt-1',
          type: 'HEAL_RESULT',
        },
      ],
      promptRouteMitigation: {
        active: false,
      },
      trinity: {
        enabled: true,
      },
      predictiveHealing: {
        recentObservations: [
          {
            memory: {
              rssMb: 128,
              heapUsedMb: 64,
            },
          },
        ],
        trends: {
          memoryGrowthMb: 0,
        },
        aiProvider: {
          configured: false,
        },
      },
      inspection: {
        lastDispatchAttempt: {
          at: '2026-04-15T00:00:00.000Z',
        },
        lastWorkerReceipt: {
          at: '2026-04-15T00:00:00.000Z',
        },
      },
    });
  });

  afterEach(() => {
    if (originalGptRouteAsyncCoreDefault === undefined) {
      delete process.env.GPT_ROUTE_ASYNC_CORE_DEFAULT;
    } else {
      process.env.GPT_ROUTE_ASYNC_CORE_DEFAULT = originalGptRouteAsyncCoreDefault;
    }

    if (originalClientResponseMaxBytes === undefined) {
      delete process.env.CLIENT_RESPONSE_MAX_BYTES;
    } else {
      process.env.CLIENT_RESPONSE_MAX_BYTES = originalClientResponseMaxBytes;
    }

    if (originalGptPublicResponseMaxBytes === undefined) {
      delete process.env.GPT_PUBLIC_RESPONSE_MAX_BYTES;
    } else {
      process.env.GPT_PUBLIC_RESPONSE_MAX_BYTES = originalGptPublicResponseMaxBytes;
    }

    if (originalDebugGptControls === undefined) {
      delete process.env.ARCANOS_ENABLE_DEBUG_GPT_CONTROLS;
    } else {
      process.env.ARCANOS_ENABLE_DEBUG_GPT_CONTROLS = originalDebugGptControls;
    }

    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('keeps normal GPT module requests on the writing dispatcher', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({ prompt: 'Explain how the queue and worker fit together.' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: true,
        result: {
          handledBy: 'module-dispatch',
        },
      })
    );
    expect(mockRouteGptRequest).toHaveBeenCalledTimes(1);
    expect(mockExecuteRuntimeInspection).not.toHaveBeenCalled();
  });

  it('routes explicit query actions directly through the module dispatcher without intent rewrites', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'query',
        prompt: 'Reply with exactly OK.',
        executionMode: 'sync'
      });

    expect(response.status).toBe(200);
    expect(mockRouteGptRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        gptId: 'arcanos-core',
        bypassIntentRouting: true,
        body: expect.objectContaining({
          action: 'query',
          prompt: 'Reply with exactly OK.'
        })
      })
    );
    expect(mockExecuteRuntimeInspection).not.toHaveBeenCalled();
  });

  it('accepts structured message content parts for normal writing dispatch', async () => {
    const messages = [
      { role: 'system', content: 'You write compact operator notes.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Draft a release note for Trinity facade routing.' }
        ]
      }
    ];

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({ messages });

    expect(response.status).toBe(200);
    expect(mockRouteGptRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        gptId: 'arcanos-core',
        body: expect.objectContaining({ messages })
      })
    );
  });

  it('blocks diagnostics through POST /gpt/{gptId}', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        gptId: 'arcanos-core',
        action: 'diagnostics',
        gptVersion: '1.0.0',
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: false,
        gptId: 'arcanos-core',
        action: 'diagnostics',
        route: '/gpt/:gptId',
        error: expect.objectContaining({
          code: 'CONTROL_PLANE_REQUIRES_DIRECT_ENDPOINT',
          message: expect.stringContaining('/gpt-access/*'),
        }),
        canonical: expect.objectContaining({
          status: '/status',
          workers: '/workers/status',
          jobStatus: '/jobs/{jobId}',
          jobResult: '/jobs/{jobId}/result',
          gptAccessJobResult: '/gpt-access/jobs/result',
          mcp: '/mcp',
        }),
        _route: expect.objectContaining({
          gptId: 'arcanos-core',
          action: 'diagnostics',
          route: 'control_guard',
        }),
        traceId: expect.any(String),
      })
    );
    expect(mockGetDiagnosticsSnapshot).not.toHaveBeenCalled();
    expect(mockResolveGptRouting).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('returns a structured validation error for query without a prompt', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        gptId: 'arcanos-core',
        action: 'query',
        gptVersion: '1.0.0',
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: false,
        gptId: 'arcanos-core',
        action: 'query',
        route: '/gpt/:gptId',
        traceId: expect.any(String),
        error: expect.objectContaining({
          code: 'PROMPT_REQUIRED',
          message: expect.stringContaining('non-empty prompt'),
        }),
      })
    );
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('blocks unknown GPT diagnostics requests before GPT routing', async () => {
    const response = await request(buildApp())
      .post('/gpt/unknown')
      .send({ action: 'diagnostics' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: false,
        gptId: 'unknown',
        action: 'diagnostics',
        route: '/gpt/:gptId',
        traceId: expect.any(String),
        error: expect.objectContaining({
          code: 'CONTROL_PLANE_REQUIRES_DIRECT_ENDPOINT',
          message: expect.stringContaining('/gpt-access/*'),
        }),
      })
    );
    expect(mockGetDiagnosticsSnapshot).not.toHaveBeenCalled();
    expect(mockResolveGptRouting).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('blocks get_status through the GPT route before job lookup', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'get_status',
        payload: {
          jobId: 'job-123',
        },
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: false,
        action: 'get_status',
        error: expect.objectContaining({
          code: 'CONTROL_PLANE_REQUIRES_DIRECT_ENDPOINT',
        }),
        canonical: expect.objectContaining({
          jobStatus: '/jobs/{jobId}',
          jobResult: '/jobs/{jobId}/result',
        }),
        _route: expect.objectContaining({
          route: 'control_guard',
          action: 'get_status',
        }),
      })
    );
    expect(mockResolveGptRouting).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('blocks get_result through the GPT route before job lookup', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'get_result',
        payload: {
          jobId: 'job-123',
        },
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: false,
        action: 'get_result',
        error: expect.objectContaining({
          code: 'CONTROL_PLANE_REQUIRES_DIRECT_ENDPOINT',
        }),
        canonical: expect.objectContaining({
          jobStatus: '/jobs/{jobId}',
          jobResult: '/jobs/{jobId}/result',
        }),
        _route: expect.objectContaining({
          route: 'control_guard',
          action: 'get_result',
        }),
      })
    );
    expect(mockResolveGptRouting).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('blocks runtime.inspect through the GPT route', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({ action: 'runtime.inspect' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: false,
        action: 'runtime.inspect',
        error: expect.objectContaining({
          code: 'CONTROL_PLANE_REQUIRES_DIRECT_ENDPOINT',
        }),
        canonical: expect.objectContaining({
          mcp: '/mcp',
          workers: '/workers/status',
          selfHeal: '/status/safety/self-heal',
        }),
        _route: expect.objectContaining({
          gptId: 'arcanos-core',
          action: 'runtime.inspect',
          route: 'control_guard',
        }),
      })
    );
    expect(mockExecuteRuntimeInspection).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('blocks runtime.inspect detail and section payloads through the GPT route', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'runtime.inspect',
        payload: {
          detail: 'full',
          sections: ['workers', 'memory'],
        },
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: false,
        action: 'runtime.inspect',
        error: expect.objectContaining({
          code: 'CONTROL_PLANE_REQUIRES_DIRECT_ENDPOINT',
        }),
      }),
    );
    expect(mockExecuteRuntimeInspection).not.toHaveBeenCalled();
  });

  it('blocks self_heal.status through the GPT route', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({ action: 'self_heal.status' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: false,
        action: 'self_heal.status',
        error: expect.objectContaining({
          code: 'CONTROL_PLANE_REQUIRES_DIRECT_ENDPOINT',
        }),
        _route: expect.objectContaining({
          gptId: 'arcanos-core',
          action: 'self_heal.status',
          route: 'control_guard',
        }),
      }),
    );
    expect(mockBuildSafetySelfHealSnapshot).not.toHaveBeenCalled();
  });

  it('blocks workers.status through the GPT route', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({ action: 'workers.status' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: false,
        action: 'workers.status',
        error: expect.objectContaining({
          code: 'CONTROL_PLANE_REQUIRES_DIRECT_ENDPOINT',
        }),
        _route: expect.objectContaining({
          gptId: 'arcanos-core',
          action: 'workers.status',
          route: 'control_guard',
        }),
      })
    );
    expect(mockGetWorkerControlStatus).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('rejects explicit runtime control action payloads before planner validation', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'runtime.inspect',
        payload: {
          detail: 'verbose',
        },
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: false,
        action: 'runtime.inspect',
        error: expect.objectContaining({
          code: 'CONTROL_PLANE_REQUIRES_DIRECT_ENDPOINT',
        }),
        canonical: expect.objectContaining({
          mcp: '/mcp',
        }),
      }),
    );
    expect(mockExecuteRuntimeInspection).not.toHaveBeenCalled();
  });

  it('does not run runtime inspection or public truncation for blocked runtime.inspect', async () => {
    process.env.GPT_PUBLIC_RESPONSE_MAX_BYTES = '5000';
    mockExecuteRuntimeInspection.mockResolvedValueOnce(buildOversizedRuntimeInspectionResponse());

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'runtime.inspect',
        payload: {
          detail: 'full',
          sections: ['workers', 'queues', 'memory', 'incidents', 'events', 'trace'],
        },
      });

    expect(response.status).toBe(400);
    expect(response.headers['x-response-truncated']).toBeUndefined();
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: false,
        action: 'runtime.inspect',
        error: expect.objectContaining({
          code: 'CONTROL_PLANE_REQUIRES_DIRECT_ENDPOINT',
        }),
      }),
    );
    expect(mockExecuteRuntimeInspection).not.toHaveBeenCalled();
  });

  it('does not apply runtime section filtering for blocked runtime.inspect', async () => {
    process.env.GPT_PUBLIC_RESPONSE_MAX_BYTES = '5000';
    mockExecuteRuntimeInspection.mockResolvedValueOnce(buildOversizedRuntimeInspectionResponse());

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'runtime.inspect',
        payload: {
          detail: 'full',
          sections: ['workers', 'queues'],
        },
      });

    expect(response.status).toBe(400);
    expect(response.headers['x-response-truncated']).toBeUndefined();
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: false,
        action: 'runtime.inspect',
        error: expect.objectContaining({
          code: 'CONTROL_PLANE_REQUIRES_DIRECT_ENDPOINT',
        }),
      }),
    );
    expect(mockExecuteRuntimeInspection).not.toHaveBeenCalled();
  });

  it('does not build or truncate self-heal snapshots for blocked self_heal.status', async () => {
    process.env.GPT_PUBLIC_RESPONSE_MAX_BYTES = '5000';
    mockBuildSafetySelfHealSnapshot.mockReturnValueOnce(buildOversizedSelfHealSnapshot());

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'self_heal.status',
        payload: {
          detail: 'full',
        },
      });

    expect(response.status).toBe(400);
    expect(response.headers['x-response-truncated']).toBeUndefined();
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: false,
        action: 'self_heal.status',
        error: expect.objectContaining({
          code: 'CONTROL_PLANE_REQUIRES_DIRECT_ENDPOINT',
        }),
      }),
    );
    expect(mockBuildSafetySelfHealSnapshot).not.toHaveBeenCalled();
  });

  it('ignores guarded debug truncation headers for blocked runtime control actions', async () => {
    process.env.NODE_ENV = 'test';
    process.env.ARCANOS_ENABLE_DEBUG_GPT_CONTROLS = 'true';
    mockExecuteRuntimeInspection.mockResolvedValueOnce(buildOversizedRuntimeInspectionResponse());

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .set('X-Debug-Max-Bytes', '5000')
      .send({
        action: 'runtime.inspect',
        payload: {
          detail: 'full',
        },
      });

    expect(response.status).toBe(400);
    expect(response.headers['x-response-truncated']).toBeUndefined();
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: false,
        action: 'runtime.inspect',
        error: expect.objectContaining({
          code: 'CONTROL_PLANE_REQUIRES_DIRECT_ENDPOINT',
        }),
      }),
    );
    expect(mockExecuteRuntimeInspection).not.toHaveBeenCalled();
  });

  it('rejects unknown reserved control actions with a typed 400 error', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({ action: 'runtime.unknown' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: false,
        gptId: 'arcanos-core',
        action: 'runtime.unknown',
        route: '/gpt/:gptId',
        traceId: expect.any(String),
        error: expect.objectContaining({
          code: 'UNSUPPORTED_GPT_ACTION',
        }),
        canonical: expect.objectContaining({
          supportedActions: 'diagnostics, system_state',
        }),
        _route: expect.objectContaining({
          gptId: 'arcanos-core',
          route: 'control_guard',
          action: 'runtime.unknown',
        }),
      })
    );
    expect(mockExecuteRuntimeInspection).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });
});
