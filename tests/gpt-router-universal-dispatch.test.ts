import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRouteGptRequest = jest.fn();
const mockExecuteSystemStateRequest = jest.fn();
const mockExecuteRuntimeInspection = jest.fn();
const mockGetWorkerControlStatus = jest.fn();
const mockBuildSafetySelfHealSnapshot = jest.fn();
const mockGetDiagnosticsSnapshot = jest.fn();

class MockSystemStateConflictError extends Error {
  readonly code = 'SYSTEM_STATE_CONFLICT';

  constructor(readonly conflict: Record<string, unknown>) {
    super('system_state update conflict');
  }
}

jest.unstable_mockModule('../src/routes/_core/gptDispatch.js', () => ({
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

describe('gpt router universal dispatch', () => {
  const originalGptRouteAsyncCoreDefault = process.env.GPT_ROUTE_ASYNC_CORE_DEFAULT;
  const originalClientResponseMaxBytes = process.env.CLIENT_RESPONSE_MAX_BYTES;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GPT_ROUTE_ASYNC_CORE_DEFAULT = 'false';
    delete process.env.CLIENT_RESPONSE_MAX_BYTES;

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
      return;
    }

    process.env.CLIENT_RESPONSE_MAX_BYTES = originalClientResponseMaxBytes;
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

  it('keeps diagnostics working through POST /gpt/{gptId}', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({ action: 'diagnostics' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      registered_gpts: ['arcanos-core'],
      active_routes: ['/gpt/arcanos-core'],
    });
    expect(mockGetDiagnosticsSnapshot).toHaveBeenCalledTimes(1);
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('routes runtime.inspect through the universal public dispatcher', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({ action: 'runtime.inspect' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: true,
        action: 'runtime.inspect',
        meta: expect.objectContaining({
          detail: 'summary',
          truncated: false,
          source: 'planner',
          availableSections: expect.arrayContaining(['workers', 'queues', 'memory', 'incidents']),
          returnedSections: expect.arrayContaining(['workers', 'queues', 'memory', 'incidents']),
        }),
        result: {
          handledBy: 'runtime-inspection',
          runtimeInspection: expect.objectContaining({
            status: 'ok',
            summary: 'Collected live runtime state from 5 runtime sources.',
            sections: expect.objectContaining({
              workers: expect.any(Object),
              queues: expect.any(Object),
              memory: expect.any(Object),
              incidents: expect.any(Object),
            }),
          }),
        },
        _route: expect.objectContaining({
          gptId: 'arcanos-core',
          action: 'runtime.inspect',
          route: 'runtime_inspect',
        }),
      })
    );
    expect(mockExecuteRuntimeInspection).toHaveBeenCalledWith(
      expect.objectContaining({
        rawPrompt: 'runtime inspect live runtime status',
        normalizedPrompt: 'runtime inspect live runtime status',
      })
    );
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('honors explicit full detail and section filtering for runtime.inspect', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'runtime.inspect',
        payload: {
          detail: 'full',
          sections: ['workers', 'memory'],
        },
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: true,
        action: 'runtime.inspect',
        meta: expect.objectContaining({
          detail: 'full',
          truncated: false,
          source: 'explicit',
          returnedSections: ['workers', 'memory'],
        }),
        result: {
          handledBy: 'runtime-inspection',
          runtimeInspection: expect.objectContaining({
            sections: {
              workers: expect.any(Object),
              memory: expect.any(Object),
            },
          }),
        },
      }),
    );
    expect(response.body.result.runtimeInspection.sections.queues).toBeUndefined();
    expect(response.body.result.runtimeInspection.sections.incidents).toBeUndefined();
  });

  it('defaults self_heal.status to a shaped summary response', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({ action: 'self_heal.status' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: true,
        action: 'self_heal.status',
        meta: expect.objectContaining({
          detail: 'summary',
          truncated: false,
          source: 'planner',
          availableSections: expect.arrayContaining(['system', 'workers', 'memory', 'incidents']),
        }),
        result: expect.objectContaining({
          status: 'ok',
          enabled: true,
          active: false,
          summary: expect.any(String),
          sections: expect.objectContaining({
            system: expect.any(Object),
            incidents: expect.any(Object),
            workers: expect.any(Object),
            memory: expect.any(Object),
          }),
        }),
        _route: expect.objectContaining({
          gptId: 'arcanos-core',
          action: 'self_heal.status',
          route: 'self_heal_status',
        }),
      }),
    );
  });

  it('routes workers.status through the universal public dispatcher', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({ action: 'workers.status' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: true,
        action: 'workers.status',
        meta: expect.objectContaining({
          detail: 'standard',
          truncated: false,
          source: 'planner',
        }),
        result: expect.objectContaining({
          timestamp: '2026-04-15T00:00:00.000Z',
          workerService: expect.objectContaining({
            queueSummary: expect.objectContaining({
              pending: 2,
              running: 1,
            }),
          }),
        }),
        _route: expect.objectContaining({
          gptId: 'arcanos-core',
          action: 'workers.status',
          route: 'workers_status',
        }),
      })
    );
    expect(mockGetWorkerControlStatus).toHaveBeenCalledTimes(1);
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('rejects invalid explicit detail values with a typed 400 error', async () => {
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
          code: 'INVALID_GPT_DETAIL',
        }),
        canonical: expect.objectContaining({
          supportedDetail: 'summary, standard, full',
        }),
      }),
    );
    expect(mockExecuteRuntimeInspection).not.toHaveBeenCalled();
  });

  it('marks truncated runtime inspection responses explicitly before the public response guard', async () => {
    process.env.CLIENT_RESPONSE_MAX_BYTES = '950';
    mockExecuteRuntimeInspection.mockResolvedValueOnce({
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
                alerts: Array.from({ length: 20 }, (_, index) => `alert-${index}`),
                workers: Array.from({ length: 20 }, (_, index) => ({
                  workerId: `worker-${index}`,
                  healthStatus: 'healthy',
                })),
              },
            },
            {
              sourceType: 'metrics',
              tool: 'system.metrics',
              data: {
                diagnostics: {
                  recent_latency_ms: Array.from({ length: 40 }, (_, index) => index),
                },
              },
            },
            {
              sourceType: 'runtime-endpoint',
              tool: '/api/self-heal/events',
              data: {
                events: Array.from({ length: 50 }, (_, index) => ({
                  id: `evt-${index}`,
                  type: 'HEAL_RESULT',
                  message: 'x'.repeat(200),
                })),
              },
            },
            {
              sourceType: 'runtime-endpoint',
              tool: '/api/self-heal/inspection',
              data: {
                evidence: {
                  traces: Array.from({ length: 40 }, (_, index) => ({
                    id: `trace-${index}`,
                    detail: 'y'.repeat(200),
                  })),
                },
              },
            },
          ],
          failures: Array.from({ length: 20 }, (_, index) => ({
            tool: `tool-${index}`,
            error: 'z'.repeat(160),
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
    });

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'runtime.inspect',
        payload: {
          detail: 'full',
          sections: ['workers', 'queues', 'memory', 'incidents', 'events', 'trace'],
        },
      });

    expect(response.status).toBe(200);
    expect(response.headers['x-response-truncated']).toBe('true');
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: true,
        action: 'runtime.inspect',
        status: 'partial',
        message: 'Response exceeded public route bounds. Narrow sections or use a less verbose detail level.',
        meta: expect.objectContaining({
          detail: 'full',
          truncated: true,
          source: 'explicit',
          omittedSections: expect.any(Array),
        }),
      }),
    );
    expect(response.body.meta.omittedSections.length).toBeGreaterThan(0);
  });

  it('rejects unknown reserved control actions with a typed 400 error', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({ action: 'runtime.unknown' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: false,
        action: 'runtime.unknown',
        error: expect.objectContaining({
          code: 'UNSUPPORTED_GPT_ACTION',
        }),
        canonical: expect.objectContaining({
          supportedActions: expect.stringContaining('runtime.inspect'),
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
