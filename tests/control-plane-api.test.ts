import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockExecuteControlPlaneOperation = jest.fn();
const mockGetControlPlaneDeepDiagnostics = jest.fn();
const mockListControlPlaneAllowlist = jest.fn();

jest.unstable_mockModule('@services/controlPlane/index.js', () => ({
  executeControlPlaneOperation: mockExecuteControlPlaneOperation,
  getControlPlaneDeepDiagnostics: mockGetControlPlaneDeepDiagnostics,
  listControlPlaneAllowlist: mockListControlPlaneAllowlist,
}));

jest.unstable_mockModule('@transport/http/middleware/confirmGate.js', () => ({
  confirmGate: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.unstable_mockModule('@platform/runtime/security.js', () => ({
  createRateLimitMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  securityHeaders: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const router = (await import('../src/routes/api-control-plane.js')).default;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/control-plane', router);
  return app;
}

function buildControlPlaneResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    operation: 'backend.health',
    provider: 'backend-api',
    environment: 'local',
    result: { dryRun: true },
    auditId: 'cp_test',
    warnings: [],
    redactedOutput: { dryRun: true },
    ...overrides,
  };
}

function buildDeepDiagnosticsResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    gptWhitelist: {
      enabled: true,
      containsArcanosCore: true,
      policyPath: 'src/services/controlPlane/gptPolicy.ts',
      gptId: 'arcanos-core',
      allowedWorkflows: ['control_plane.route.verify'],
      deniedCapabilities: ['secrets.read.raw'],
    },
    trinityRouting: {
      implemented: true,
      requestable: true,
      lastRouteStatus: 'UNKNOWN_ROUTE',
      metadataFields: ['_route', 'routingStages'],
      verificationPath: 'src/services/controlPlane/routeVerification.ts',
    },
    railwayCliWrapper: {
      implemented: true,
      allowlistEnabled: true,
      restrictedCommandsRequireApproval: true,
      readOnlyOperations: ['railway.status'],
      restrictedOperations: ['railway.deploy'],
    },
    arcanosCliWrapper: {
      implemented: true,
      allowlistEnabled: true,
      restrictedCommandsRequireApproval: false,
      readOnlyOperations: ['arcanos.status'],
      restrictedOperations: [],
    },
    mcpPolicy: {
      implemented: true,
      documentedToolsOnly: true,
      schemaValidationEnabled: true,
      registeredTools: ['control_plane.invoke', 'agents.list'],
    },
    approvalGates: {
      implemented: true,
      protectedActions: ['deploy', 'secret_change'],
    },
    auditLogging: {
      implemented: true,
      secretRedactionEnabled: true,
      auditPath: 'src/services/controlPlane/audit.ts',
    },
    safetyFlags: {
      readOnly: true,
      executesCli: false,
      callsOpenAI: false,
      mutatesState: false,
      createsJobs: false,
      deploys: false,
      invokesMcpTools: false,
      routesThroughWritingPipeline: false,
    },
    tests: {
      present: true,
      commands: ['node scripts/run-jest.mjs --runTestsByPath tests/control-plane-deep-diagnostics.test.ts'],
      knownTestFiles: ['tests/control-plane-deep-diagnostics.test.ts'],
    },
    ...overrides,
  };
}

describe('api-control-plane route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListControlPlaneAllowlist.mockReturnValue([
      {
        operation: 'backend.health',
        provider: 'backend-api',
        workflow: 'control_plane.inspect',
        readOnly: true,
        approvalRequired: false,
      },
    ]);
    mockGetControlPlaneDeepDiagnostics.mockReturnValue(buildDeepDiagnosticsResponse());
  });

  it('returns the allowlist without exposing execution output', async () => {
    const response = await request(buildApp()).get('/api/control-plane/allowlist');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      operations: [
        expect.objectContaining({
          operation: 'backend.health',
          provider: 'backend-api',
          workflow: 'control_plane.inspect',
          readOnly: true,
          approvalRequired: false,
        }),
      ],
    });
    expect(mockExecuteControlPlaneOperation).not.toHaveBeenCalled();
  });

  it('returns deep diagnostics as a redacted read-only no-store response', async () => {
    mockGetControlPlaneDeepDiagnostics.mockReturnValue(buildDeepDiagnosticsResponse({
      debug: {
        token: '[REDACTED]',
        authorization: '[REDACTED]',
      },
    }));

    const response = await request(buildApp()).get('/api/control-plane/deep-diagnostics');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual(expect.objectContaining({
      ok: true,
      gptWhitelist: expect.objectContaining({
        containsArcanosCore: true,
        gptId: 'arcanos-core',
      }),
      trinityRouting: expect.objectContaining({
        lastRouteStatus: 'UNKNOWN_ROUTE',
      }),
      railwayCliWrapper: expect.objectContaining({
        readOnlyOperations: expect.arrayContaining(['railway.status']),
        restrictedOperations: expect.arrayContaining(['railway.deploy']),
      }),
      arcanosCliWrapper: expect.objectContaining({
        readOnlyOperations: expect.arrayContaining(['arcanos.status']),
      }),
      mcpPolicy: expect.objectContaining({
        registeredTools: expect.arrayContaining(['control_plane.invoke']),
      }),
      approvalGates: expect.objectContaining({
        protectedActions: expect.arrayContaining(['deploy']),
      }),
      auditLogging: expect.objectContaining({
        secretRedactionEnabled: true,
      }),
      safetyFlags: {
        readOnly: true,
        executesCli: false,
        callsOpenAI: false,
        mutatesState: false,
        createsJobs: false,
        deploys: false,
        invokesMcpTools: false,
        routesThroughWritingPipeline: false,
      },
    }));
    expect(JSON.stringify(response.body)).not.toContain('sk-');
    expect(JSON.stringify(response.body)).not.toContain('Bearer ');
    expect(response.body.debug).toEqual({
      token: '[REDACTED]',
      authorization: '[REDACTED]',
    });
    expect(mockGetControlPlaneDeepDiagnostics).toHaveBeenCalledTimes(1);
    expect(mockExecuteControlPlaneOperation).not.toHaveBeenCalled();
  });

  it.each(['post', 'put', 'patch', 'delete'] as const)(
    'does not route %s requests to deep diagnostics',
    async (method) => {
      const response = await request(buildApp())[method]('/api/control-plane/deep-diagnostics')
        .send({ action: 'mutate' });

      expect(response.status).toBe(404);
      expect(mockGetControlPlaneDeepDiagnostics).not.toHaveBeenCalled();
      expect(mockExecuteControlPlaneOperation).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['success', buildControlPlaneResponse(), 200],
    [
      'schema failure',
      buildControlPlaneResponse({
        ok: false,
        error: { code: 'ERR_CONTROL_PLANE_SCHEMA', message: 'bad schema' },
      }),
      400,
    ],
    [
      'bad request',
      buildControlPlaneResponse({
        ok: false,
        error: { code: 'ERR_CONTROL_PLANE_BAD_REQUEST', message: 'bad request' },
      }),
      400,
    ],
    [
      'denied operation',
      buildControlPlaneResponse({
        ok: false,
        error: { code: 'ERR_CONTROL_PLANE_DENIED', message: 'denied' },
      }),
      403,
    ],
    [
      'missing scope',
      buildControlPlaneResponse({
        ok: false,
        error: { code: 'ERR_CONTROL_PLANE_SCOPE', message: 'missing scope' },
      }),
      403,
    ],
    [
      'GPT policy denial',
      buildControlPlaneResponse({
        ok: false,
        error: { code: 'ERR_CONTROL_PLANE_GPT_POLICY', message: 'GPT denied' },
      }),
      403,
    ],
    [
      'approval failure',
      buildControlPlaneResponse({
        ok: false,
        error: { code: 'ERR_CONTROL_PLANE_APPROVAL', message: 'approval required' },
      }),
      428,
    ],
    [
      'internal execution failure',
      buildControlPlaneResponse({
        ok: false,
        error: { code: 'ERR_CONTROL_PLANE_EXECUTION', message: 'internal failure' },
      }),
      500,
    ],
  ])('maps %s to HTTP %i', async (_label, controlPlaneResponse, expectedStatus) => {
    mockExecuteControlPlaneOperation.mockResolvedValue(controlPlaneResponse);

    const response = await request(buildApp())
      .post('/api/control-plane/operations')
      .send({
        operation: 'backend.health',
        provider: 'backend-api',
        target: { resource: 'health' },
        environment: 'local',
        scope: 'backend:read',
        params: {},
        traceId: 'trace-api-status-test',
        requestedBy: 'test-runner',
      });

    expect(response.status).toBe(expectedStatus);
    expect(response.body).toEqual(controlPlaneResponse);
    expect(mockExecuteControlPlaneOperation).toHaveBeenCalledTimes(1);
  });
});
