import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockExecuteControlPlaneRequest = jest.fn();
const mockGetControlPlaneCapabilities = jest.fn();
const mockGetControlPlaneOperationRequiredScopes = jest.fn();
const mockRequiresControlPlaneApproval = jest.fn();
const mockArcanosMcpPort = {
  invokeTool: jest.fn(),
  listTools: jest.fn(),
};

jest.unstable_mockModule('@services/controlPlane/service.js', () => ({
  executeControlPlaneRequest: mockExecuteControlPlaneRequest,
  getControlPlaneCapabilities: mockGetControlPlaneCapabilities,
  getControlPlaneOperationRequiredScopes: mockGetControlPlaneOperationRequiredScopes,
  requiresControlPlaneApproval: mockRequiresControlPlaneApproval
}));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const { CONTROL_PLANE_PURPOSE_BOUND_CREDENTIAL_ENV_NAMES } =
  await import('../src/services/controlPlane/httpAuth.js');
const router = (await import('../src/routes/control-plane.js')).default;

const controlPlaneAccessToken = 'control-plane-route-access-token-1234567890';
const controlPlanePrincipalId = 'operator:control-plane-test';
const authEnvironmentNames = [
  'ARCANOS_CONTROL_PLANE_ACCESS_TOKEN',
  'ARCANOS_CONTROL_PLANE_PRINCIPAL_ID',
  'ARCANOS_CONTROL_PLANE_SCOPES',
  ...CONTROL_PLANE_PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
] as const;
const originalAuthEnvironment = new Map(
  authEnvironmentNames.map((name) => [name, process.env[name]])
);

function buildResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    requestId: 'req-http-1',
    phase: 'plan',
    adapter: 'railway-cli',
    operation: 'status',
    route: {
      requested: 'direct',
      status: 'DIRECT_FAST_PATH',
      eligibleForTrinity: false,
      reason: 'test route',
      evidence: {},
      requestedAt: '2026-04-26T00:00:00.000Z',
      verifiedAt: '2026-04-26T00:00:00.000Z'
    },
    approval: {
      required: false,
      satisfied: true,
      gate: 'none'
    },
    audit: {
      auditId: 'audit-http-1',
      logged: true
    },
    result: {
      status: 'planned',
      adapter: 'railway-cli',
      operation: 'status'
    },
    ...overrides
  };
}

function buildApp() {
  const app = express();
  app.locals.arcanosMcp = mockArcanosMcpPort;
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).requestId = 'req-http-1';
    next();
  });
  app.use(router);
  return app;
}

describe('control-plane route', () => {
  beforeEach(() => {
    for (const name of authEnvironmentNames) {
      delete process.env[name];
    }
    process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneAccessToken;
    process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = controlPlanePrincipalId;
    process.env.ARCANOS_CONTROL_PLANE_SCOPES = 'railway:read,railway:deploy,mcp:invoke';

    jest.clearAllMocks();
    mockGetControlPlaneCapabilities.mockReturnValue({
      operations: [],
      mcpTools: {
        readOnly: [],
        mutating: []
      },
      routeStatuses: [
        'TRINITY_CONFIRMED',
        'TRINITY_UNAVAILABLE',
        'TRINITY_REQUESTED_BUT_NOT_CONFIRMED',
        'DIRECT_FAST_PATH',
        'UNKNOWN_ROUTE'
      ]
    });
    mockExecuteControlPlaneRequest.mockResolvedValue(buildResponse());
    mockGetControlPlaneOperationRequiredScopes.mockImplementation(
      (payload: { adapter?: string; operation?: string }) => {
        if (payload.adapter === 'railway-cli' && payload.operation === 'deploy') {
          return ['railway:deploy'];
        }
        if (payload.adapter === 'arcanos-mcp' && payload.operation === 'invokeTool') {
          return ['mcp:invoke'];
        }
        return ['railway:read'];
      }
    );
    mockRequiresControlPlaneApproval.mockReturnValue(false);
  });

  it('returns allowlisted capabilities for discovery', async () => {
    const response = await request(buildApp()).get('/api/control-plane/capabilities');

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.capabilities.routeStatuses).toContain('TRINITY_CONFIRMED');
  });

  it('rejects requests that do not satisfy the control-plane request schema', async () => {
    const response = await request(buildApp())
      .post('/api/control-plane')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`)
      .send({
        phase: 'execute',
        adapter: 'railway-cli'
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_CONTROL_PLANE_REQUEST');
    expect(response.body.requestId).toBe('req-http-1');
    expect(mockExecuteControlPlaneRequest).not.toHaveBeenCalled();
  });

  it('passes validated requests with request and session context to the executor', async () => {
    const response = await request(buildApp())
      .post('/api/control-plane')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`)
      .set('x-session-id', 'session-http-1')
      .send({
        phase: 'plan',
        adapter: 'railway-cli',
        operation: 'status',
        routePreference: 'direct',
        context: {
          caller: {
            id: 'spoofed-caller',
            type: 'caller-selected',
            scopes: ['railway:deploy']
          }
        }
      });

    expect(response.status).toBe(200);
    expect(mockExecuteControlPlaneRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-http-1',
        phase: 'plan',
        adapter: 'railway-cli',
        operation: 'status',
        context: expect.objectContaining({
          sessionId: 'session-http-1',
          caller: expect.objectContaining({
            id: controlPlanePrincipalId,
            type: 'control-plane-http',
            scopes: ['railway:read', 'railway:deploy', 'mcp:invoke']
          })
        })
      }),
      {
        mcpClient: mockArcanosMcpPort,
      }
    );
  });

  it('rejects an unauthenticated mutation even when confirmation and body approval are supplied', async () => {
    const response = await request(buildApp())
      .post('/api/control-plane')
      .set('x-confirmed', 'yes')
      .send({
        phase: 'mutate',
        adapter: 'railway-cli',
        operation: 'deploy',
        context: {
          caller: {
            id: 'spoofed-operator',
            type: 'caller-selected',
            scopes: ['railway:deploy']
          }
        },
        approval: {
          approved: true,
          approvedBy: 'spoofed-operator',
          reason: 'body approval must not establish authorization'
        }
      });

    expect(response.status).toBe(401);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(mockExecuteControlPlaneRequest).not.toHaveBeenCalled();
  });

  it('rejects an invalid bearer without disclosing credential details', async () => {
    const invalidToken = 'invalid-control-plane-token-1234567890';
    const response = await request(buildApp())
      .post('/api/control-plane')
      .set('Authorization', `Bearer ${invalidToken}`)
      .send({
        phase: 'plan',
        adapter: 'railway-cli',
        operation: 'status'
      });

    expect(response.status).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer realm="control-plane"');
    expect(response.body.error).toEqual({
      code: 'CONTROL_PLANE_AUTH_REQUIRED',
      message: 'Control-plane bearer authentication is required.'
    });
    expect(JSON.stringify(response.body)).not.toContain(invalidToken);
    expect(mockExecuteControlPlaneRequest).not.toHaveBeenCalled();
  });

  it('fails closed when the server authentication configuration is unavailable', async () => {
    delete process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN;

    const response = await request(buildApp())
      .post('/api/control-plane')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`)
      .send({
        phase: 'plan',
        adapter: 'railway-cli',
        operation: 'status'
      });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_UNAVAILABLE');
    expect(mockExecuteControlPlaneRequest).not.toHaveBeenCalled();
  });

  it('rejects an authenticated request when server-owned scopes do not authorize the operation', async () => {
    process.env.ARCANOS_CONTROL_PLANE_SCOPES = 'railway:read';
    mockRequiresControlPlaneApproval.mockReturnValue(true);

    const response = await request(buildApp())
      .post('/api/control-plane')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`)
      .send({
        phase: 'mutate',
        adapter: 'railway-cli',
        operation: 'deploy',
        approval: {
          approved: true,
          approvedBy: 'spoofed-operator',
          reason: 'scope authorization must run before confirmation'
        }
      });

    expect(response.status).toBe(403);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.error.code).toBe('CONTROL_PLANE_SCOPE_DENIED');
    expect(mockExecuteControlPlaneRequest).not.toHaveBeenCalled();
  });

  it('allows confirmed mutation requests to reach the executor', async () => {
    mockRequiresControlPlaneApproval.mockReturnValue(true);
    mockExecuteControlPlaneRequest.mockResolvedValue(buildResponse({
      phase: 'mutate',
      operation: 'deploy',
      result: {
        status: 'completed',
        adapter: 'railway-cli',
        operation: 'deploy',
        exitCode: 0
      }
    }));

    const response = await request(buildApp())
      .post('/api/control-plane')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`)
      .set('x-confirmed', 'yes')
      .send({
        phase: 'mutate',
        adapter: 'railway-cli',
        operation: 'deploy',
        approval: {
          approved: true,
          approvedBy: 'operator:test',
          reason: 'route test'
        }
      });

    expect(response.status).toBe(200);
    expect(mockExecuteControlPlaneRequest).toHaveBeenCalledTimes(1);
    expect(mockExecuteControlPlaneRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        approval: expect.objectContaining({
          approvedBy: controlPlanePrincipalId
        }),
        context: expect.objectContaining({
          caller: {
            id: controlPlanePrincipalId,
            type: 'control-plane-http',
            scopes: ['railway:read', 'railway:deploy', 'mcp:invoke']
          }
        })
      }),
      {
        mcpClient: mockArcanosMcpPort,
      }
    );
  });

  it('runs confirmation gate before approval-gated execute requests reach the executor', async () => {
    mockRequiresControlPlaneApproval.mockReturnValue(true);

    const response = await request(buildApp())
      .post('/api/control-plane')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`)
      .send({
        phase: 'execute',
        adapter: 'arcanos-mcp',
        operation: 'invokeTool',
        input: {
          toolName: 'memory.save',
          toolArguments: {
            key: 'route-test',
            value: 'value'
          }
        },
        approval: {
          approved: true,
          approvedBy: 'spoofed',
          reason: 'spoofed body approval should not bypass confirmGate'
        }
      });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('CONFIRMATION_REQUIRED');
    expect(mockExecuteControlPlaneRequest).not.toHaveBeenCalled();
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
