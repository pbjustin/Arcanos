import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockExecuteControlPlaneOperation = jest.fn();
const mockGetControlPlaneDeepDiagnostics = jest.fn();
const mockListControlPlaneAllowlist = jest.fn();
let capturedRateLimitOptions:
  | { keyGenerator?: (req: { ip?: string }) => string }
  | undefined;

jest.unstable_mockModule('@services/controlPlane/index.js', () => ({
  executeControlPlaneOperation: mockExecuteControlPlaneOperation,
  getControlPlaneDeepDiagnostics: mockGetControlPlaneDeepDiagnostics,
  listControlPlaneAllowlist: mockListControlPlaneAllowlist,
}));

jest.unstable_mockModule('@transport/http/middleware/confirmGate.js', () => ({
  confirmGate: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.unstable_mockModule('@platform/runtime/security.js', () => ({
  createRateLimitMiddleware: (options: typeof capturedRateLimitOptions) => {
    capturedRateLimitOptions = options;
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
  getRequestClientAddress: () => 'fallback-client-address',
  securityHeaders: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const { CONTROL_PLANE_PURPOSE_BOUND_CREDENTIAL_ENV_NAMES } =
  await import('../src/services/controlPlane/httpAuth.js');
const router = (await import('../src/routes/api-control-plane.js')).default;

const controlPlaneAccessToken = 'control-plane-api-access-token-1234567890';
const controlPlanePrincipalId = 'operator:control-plane-api-test';
const authEnvironmentNames = [
  'ARCANOS_CONTROL_PLANE_ACCESS_TOKEN',
  'ARCANOS_CONTROL_PLANE_PRINCIPAL_ID',
  'ARCANOS_CONTROL_PLANE_SCOPES',
  ...CONTROL_PLANE_PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
] as const;
const originalAuthEnvironment = new Map(
  authEnvironmentNames.map((name) => [name, process.env[name]])
);

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
    for (const name of authEnvironmentNames) {
      delete process.env[name];
    }
    process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneAccessToken;
    process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = controlPlanePrincipalId;
    process.env.ARCANOS_CONTROL_PLANE_SCOPES = 'backend:read,repo:verify';

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

  it('keys pre-authentication rate limits by client address, not bearer contents', () => {
    const keyGenerator = capturedRateLimitOptions?.keyGenerator;
    expect(keyGenerator).toBeDefined();

    const firstKey = keyGenerator?.({
      ip: '203.0.113.20',
      authorization: 'Bearer test-invalid-one',
    } as { ip?: string });
    const rotatedCredentialKey = keyGenerator?.({
      ip: '203.0.113.20',
      authorization: 'Bearer test-invalid-two',
    } as { ip?: string });

    expect(firstKey).toBe('ip:203.0.113.20:control-plane-operations');
    expect(rotatedCredentialKey).toBe(firstKey);
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
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`)
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
    expect(mockExecuteControlPlaneOperation.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      scope: ['backend:read', 'repo:verify'],
      requestedBy: controlPlanePrincipalId,
      dryRun: true,
    }));
  });

  it('rejects self-asserted identity and scope without the dedicated bearer credential', async () => {
    const response = await request(buildApp())
      .post('/api/control-plane/operations')
      .set('x-confirmed', 'yes')
      .send({
        operation: 'npm.test',
        provider: 'local-command',
        target: { resource: 'repository' },
        environment: 'local',
        scope: 'repo:verify',
        params: {},
        dryRun: false,
        traceId: 'trace-api-unauthenticated-test',
        requestedBy: 'spoofed-operator',
      });

    expect(response.status).toBe(401);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(mockExecuteControlPlaneOperation).not.toHaveBeenCalled();
  });

  it('fails closed before execution when HTTP authentication is not configured', async () => {
    delete process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN;

    const response = await request(buildApp())
      .post('/api/control-plane/operations')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`)
      .send({
        operation: 'backend.health',
        provider: 'backend-api',
        target: { resource: 'health' },
        environment: 'local',
        scope: 'backend:read',
        params: {},
        traceId: 'trace-api-auth-unavailable-test',
        requestedBy: 'spoofed-operator',
      });

    expect(response.status).toBe(503);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_UNAVAILABLE');
    expect(mockExecuteControlPlaneOperation).not.toHaveBeenCalled();
  });

  it('rejects caller-supplied scope when the server principal lacks the required grant', async () => {
    process.env.ARCANOS_CONTROL_PLANE_SCOPES = 'backend:read';

    const response = await request(buildApp())
      .post('/api/control-plane/operations')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`)
      .set('x-confirmed', 'yes')
      .send({
        operation: 'npm.test',
        provider: 'local-command',
        target: { resource: 'repository' },
        environment: 'local',
        scope: 'repo:verify',
        params: {},
        dryRun: false,
        traceId: 'trace-api-scope-test',
        requestedBy: 'spoofed-operator',
      });

    expect(response.status).toBe(403);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.error.code).toBe('CONTROL_PLANE_SCOPE_DENIED');
    expect(mockExecuteControlPlaneOperation).not.toHaveBeenCalled();
  });

  it('binds executor scope and audit identity to the authenticated principal', async () => {
    mockExecuteControlPlaneOperation.mockResolvedValue(buildControlPlaneResponse());

    const response = await request(buildApp())
      .post('/api/control-plane/operations')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`)
      .send({
        operation: 'backend.health',
        provider: 'backend-api',
        target: { resource: 'health' },
        environment: 'local',
        scope: 'caller:admin',
        params: {},
        traceId: 'trace-api-authoritative-principal-test',
        requestedBy: 'spoofed-operator',
      });

    expect(response.status).toBe(200);
    expect(mockExecuteControlPlaneOperation.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      scope: ['backend:read', 'repo:verify'],
      requestedBy: controlPlanePrincipalId,
    }));
  });
});

afterAll(() => {
  for (const [name, value] of originalAuthEnvironment) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});
