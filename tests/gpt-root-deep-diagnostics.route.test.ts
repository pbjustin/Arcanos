import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRouteGptRequest = jest.fn();
const mockResolveGptRouting = jest.fn();
const mockAuditLog = jest.fn();
const mockGetHealthSnapshot = jest.fn();
const mockGetDiagnosticsSnapshot = jest.fn();
const mockGetWorkerControlStatus = jest.fn();
const mockGetWorkerControlHealth = jest.fn();
const mockGetTrinityStatus = jest.fn();
const mockBuildSafetySelfHealSnapshot = jest.fn();
const mockGetFeatureFlags = jest.fn();
const mockGetExecutionLimits = jest.fn();

const TEST_ADMIN_TOKEN = 'unit-test-admin-token';

jest.unstable_mockModule('../src/routes/_core/gptDispatch.js', () => ({
  resolveGptRouting: mockResolveGptRouting,
  routeGptRequest: mockRouteGptRequest,
}));

jest.unstable_mockModule('../src/platform/logging/gptLogger.js', () => ({
  logGptConnection: jest.fn(),
  logGptConnectionFailed: jest.fn(),
  logGptAckSent: jest.fn(),
}));

jest.unstable_mockModule('../src/platform/logging/auditLogger.js', () => ({
  auditLogger: {
    log: mockAuditLog,
  },
}));

jest.unstable_mockModule('../src/services/runtimeDiagnosticsService.js', () => ({
  runtimeDiagnosticsService: {
    getHealthSnapshot: mockGetHealthSnapshot,
    getDiagnosticsSnapshot: mockGetDiagnosticsSnapshot,
    recordRequestCompletion: jest.fn(),
  },
}));

jest.unstable_mockModule('../src/services/workerControlService.js', () => ({
  getWorkerControlStatus: mockGetWorkerControlStatus,
  getWorkerControlHealth: mockGetWorkerControlHealth,
}));

jest.unstable_mockModule('../src/services/runtimeInspectionRoutingService.js', () => ({
  executeRuntimeInspection: jest.fn(),
  classifyRuntimeInspectionPrompt: jest.fn(() => ({
    detectedIntent: 'STANDARD',
    matchedKeywords: [],
    repoInspectionDisabled: false,
    onlyReturnRuntimeValues: false,
  })),
}));

jest.unstable_mockModule('../src/services/trinityStatusService.js', () => ({
  getTrinityStatus: mockGetTrinityStatus,
}));

jest.unstable_mockModule('../src/services/selfHealRuntimeInspectionService.js', () => ({
  buildSafetySelfHealSnapshot: mockBuildSafetySelfHealSnapshot,
}));

jest.unstable_mockModule('../src/services/arcanosDagRunService.js', () => ({
  arcanosDagRunService: {
    getFeatureFlags: mockGetFeatureFlags,
    getExecutionLimits: mockGetExecutionLimits,
  },
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

function collectConsoleOutput(calls: unknown[][]): string {
  return calls.map((call) => call.map((entry) => String(entry)).join(' ')).join('\n');
}

describe('root.deep_diagnostics GPT bridge', () => {
  let consoleLogSpy: ReturnType<typeof jest.spyOn>;
  const originalEnv = {
    ARCANOS_ADMIN_TOKEN: process.env.ARCANOS_ADMIN_TOKEN,
    ARCANOS_ROOT_DIAGNOSTIC_GPTS: process.env.ARCANOS_ROOT_DIAGNOSTIC_GPTS,
    ENABLE_ROOT_DEEP_DIAGNOSTICS: process.env.ENABLE_ROOT_DEEP_DIAGNOSTICS,
    GPT_ROUTE_ASYNC_CORE_DEFAULT: process.env.GPT_ROUTE_ASYNC_CORE_DEFAULT,
  };

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.clearAllMocks();
    process.env.ARCANOS_ADMIN_TOKEN = TEST_ADMIN_TOKEN;
    process.env.ARCANOS_ROOT_DIAGNOSTIC_GPTS = 'arcanos-core';
    process.env.ENABLE_ROOT_DEEP_DIAGNOSTICS = 'true';
    process.env.GPT_ROUTE_ASYNC_CORE_DEFAULT = 'false';

    mockResolveGptRouting.mockResolvedValue({
      ok: true,
      plan: {
        matchedId: 'arcanos-core',
        module: 'ARCANOS:CORE',
        route: 'core',
        action: 'query',
        availableActions: ['query'],
        moduleVersion: null,
        moduleDescription: null,
        matchMethod: 'exact',
      },
      _route: {
        gptId: 'arcanos-core',
        route: 'core',
        module: 'ARCANOS:CORE',
        action: 'query',
        timestamp: '2026-04-27T00:00:00.000Z',
      },
    });
    mockRouteGptRequest.mockResolvedValue({
      ok: true,
      result: { handledBy: 'module-dispatch' },
      _route: {
        gptId: 'arcanos-core',
        module: 'ARCANOS:CORE',
        route: 'core',
        availableActions: ['query'],
      },
    });
    mockGetHealthSnapshot.mockReturnValue({ status: 'ok', timestamp: '2026-04-27T00:00:00.000Z' });
    mockGetWorkerControlStatus.mockResolvedValue({ workerService: { health: { overallStatus: 'healthy' } } });
    mockGetWorkerControlHealth.mockResolvedValue({ overallStatus: 'healthy' });
    mockGetTrinityStatus.mockResolvedValue({ pipeline: 'trinity', status: 'healthy' });
    mockBuildSafetySelfHealSnapshot.mockReturnValue({ enabled: true, active: false });
    mockGetFeatureFlags.mockReturnValue({ dag: true });
    mockGetExecutionLimits.mockReturnValue({ maxConcurrency: 1 });
    mockGetDiagnosticsSnapshot.mockResolvedValue({ requests_total: 1, errors_total: 0 });
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    consoleLogSpy.mockRestore();
  });

  it('denies missing Authorization with the exact forbidden payload', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({ action: 'root.deep_diagnostics' });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      ok: false,
      error: 'ROOT_DIAGNOSTICS_FORBIDDEN',
    });
    expect(mockAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      allowed: false,
      denialReason: 'authorization_missing',
      gptId: 'arcanos-core',
      action: 'root.deep_diagnostics',
    }));
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('denies the wrong Bearer token without logging the token value', async () => {
    const wrongToken = 'wrong-unit-test-token';

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .set('Authorization', `Bearer ${wrongToken}`)
      .send({ action: 'root.deep_diagnostics' });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      ok: false,
      error: 'ROOT_DIAGNOSTICS_FORBIDDEN',
    });
    expect(mockAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      allowed: false,
      denialReason: 'authorization_mismatch',
    }));
    expect(collectConsoleOutput(consoleLogSpy.mock.calls)).not.toContain(wrongToken);
    expect(JSON.stringify(mockAuditLog.mock.calls)).not.toContain(wrongToken);
  });

  it('denies when ARCANOS_ADMIN_TOKEN is empty', async () => {
    process.env.ARCANOS_ADMIN_TOKEN = '';

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`)
      .send({ action: 'root.deep_diagnostics' });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      ok: false,
      error: 'ROOT_DIAGNOSTICS_FORBIDDEN',
    });
    expect(mockAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      allowed: false,
      denialReason: 'admin_token_missing',
    }));
  });

  it('denies when ENABLE_ROOT_DEEP_DIAGNOSTICS is disabled', async () => {
    process.env.ENABLE_ROOT_DEEP_DIAGNOSTICS = 'false';

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`)
      .send({ action: 'root.deep_diagnostics' });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      ok: false,
      error: 'ROOT_DIAGNOSTICS_FORBIDDEN',
    });
    expect(mockAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      allowed: false,
      denialReason: 'disabled',
    }));
  });

  it('denies non-allowlisted GPT IDs', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-daemon')
      .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`)
      .send({ action: 'root.deep_diagnostics' });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      ok: false,
      error: 'ROOT_DIAGNOSTICS_FORBIDDEN',
    });
    expect(mockAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      allowed: false,
      denialReason: 'gpt_not_allowlisted',
      gptId: 'arcanos-daemon',
    }));
  });

  it('lets wrong actions follow normal GPT route behavior', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`)
      .send({
        action: 'root.not_deep_diagnostics',
        prompt: 'Use the normal route.',
      });

    expect(response.status).toBe(200);
    expect(mockRouteGptRequest).toHaveBeenCalledTimes(1);
    expect(mockAuditLog).not.toHaveBeenCalledWith(expect.objectContaining({
      action: 'root.deep_diagnostics',
    }));
    expect(mockGetWorkerControlHealth).not.toHaveBeenCalled();
  });

  it('returns a root diagnostics report for the allowlisted GPT and correct token', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`)
      .send({ action: 'root.deep_diagnostics' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      ok: true,
      gptId: 'arcanos-core',
      action: 'root.deep_diagnostics',
      traceId: expect.any(String),
      timestamp: expect.any(String),
      report: expect.arrayContaining([
        expect.objectContaining({ ok: true, name: '/status', error: null }),
        expect.objectContaining({ ok: true, name: '/workers/status', error: null }),
        expect.objectContaining({ ok: true, name: '/worker-helper/health', error: null }),
        expect.objectContaining({ ok: true, name: '/trinity/status', error: null }),
        expect.objectContaining({ ok: true, name: '/status/safety/self-heal', error: null }),
        expect.objectContaining({ ok: true, name: '/api/arcanos/capabilities', error: null }),
        expect.objectContaining({ ok: true, name: 'diagnostics.summary', error: null }),
      ]),
    }));
    expect(response.body.report).toHaveLength(7);
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
    expect(mockAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      allowed: true,
      diagnosticsResultSummary: expect.objectContaining({
        totalChecks: 7,
        failedChecks: 0,
        ok: true,
      }),
    }));
    expect(collectConsoleOutput(consoleLogSpy.mock.calls)).not.toContain(TEST_ADMIN_TOKEN);
    expect(JSON.stringify(mockAuditLog.mock.calls)).not.toContain(TEST_ADMIN_TOKEN);
  });

  it('keeps the report alive when a sub-check fails', async () => {
    mockGetWorkerControlHealth.mockRejectedValueOnce(new Error('worker health unavailable'));

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`)
      .send({ action: 'root.deep_diagnostics' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      ok: false,
      report: expect.arrayContaining([
        expect.objectContaining({
          ok: false,
          name: '/worker-helper/health',
          data: null,
          error: 'worker health unavailable',
        }),
      ]),
    }));
    expect(mockAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      allowed: true,
      diagnosticsResultSummary: expect.objectContaining({
        totalChecks: 7,
        failedChecks: 1,
        failedCheckNames: ['/worker-helper/health'],
        ok: false,
      }),
    }));
  });

  it('bounds large sub-check data so the report contract is preserved', async () => {
    mockGetWorkerControlStatus.mockResolvedValueOnce({
      recentFailedJobs: Array.from({ length: 64 }, (_, index) => ({
        id: `failed-${index}`,
        apiKey: 'unit-test-secret-value',
        error_message: 'worker failure detail '.repeat(300),
      })),
    });

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`)
      .send({ action: 'root.deep_diagnostics' });

    const workerStatus = response.body.report.find(
      (check: Record<string, unknown>) => check.name === '/workers/status'
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      ok: true,
      report: expect.any(Array),
    }));
    expect(response.body).not.toHaveProperty('truncated');
    expect(workerStatus).toEqual(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({
        recentFailedJobs: expect.objectContaining({
          total: 64,
          truncated: true,
          items: expect.any(Array),
        }),
      }),
    }));
    expect(workerStatus.data.recentFailedJobs.items).toHaveLength(3);
    expect(JSON.stringify(response.body)).not.toContain('unit-test-secret-value');
  });
});
