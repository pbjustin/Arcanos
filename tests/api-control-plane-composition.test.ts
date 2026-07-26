import express, { type NextFunction, type Request, type Response } from 'express';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const memoryConsistencyGateMock = jest.fn(
  (_req: Request, res: Response, _next: NextFunction) => {
    res.status(418).json({
      ok: false,
      error: {
        code: 'WRITING_PLANE_GATE_REACHED',
      },
    });
  }
);
const executeControlPlaneOperationMock = jest.fn();
const arcanosMcpPortMock = {
  invokeTool: jest.fn(),
  listTools: jest.fn(),
};

jest.unstable_mockModule('@services/controlPlane/index.js', () => ({
  executeControlPlaneOperation: executeControlPlaneOperationMock,
  getControlPlaneDeepDiagnostics: jest.fn(() => ({ ok: true })),
  listControlPlaneAllowlist: jest.fn(() => []),
}));

jest.unstable_mockModule(
  '@transport/http/middleware/memoryConsistencyGate.js',
  () => ({
    memoryConsistencyGate: memoryConsistencyGateMock,
  })
);

const unrelatedApiRouteModules = [
  '@routes/api-arcanos.js',
  '@routes/api-sim.js',
  '@routes/api-memory.js',
  '@routes/api-save-conversation.js',
  '@routes/api-codebase.js',
  '@routes/api-commands.js',
  '@routes/api-assistants.js',
  '@routes/api-vision.js',
  '@routes/api-transcribe.js',
  '@routes/api-update.js',
  '@routes/api-daemon.js',
  '@routes/api-agent.js',
  '@routes/api-prompt-debug.js',
  '@routes/api-reusable-code.js',
  '@routes/pr-analysis.js',
  '@routes/openai.js',
  '@routes/afol.js',
  '@routes/web-search.js',
] as const;

for (const moduleName of unrelatedApiRouteModules) {
  jest.unstable_mockModule(moduleName, () => ({
    default: express.Router(),
  }));
}

const request = (await import('supertest')).default;
const apiRouter = (await import('../src/routes/api/index.js')).default;

const controlPlaneAccessToken = 'composition-control-plane-token-1234567890';
const accessTokenEnvironmentName = 'ARCANOS_CONTROL_PLANE_ACCESS_TOKEN';
const principalEnvironmentName = 'ARCANOS_CONTROL_PLANE_PRINCIPAL_ID';
const scopesEnvironmentName = 'ARCANOS_CONTROL_PLANE_SCOPES';
const originalEnvironment = new Map([
  [accessTokenEnvironmentName, process.env[accessTokenEnvironmentName]],
  [principalEnvironmentName, process.env[principalEnvironmentName]],
  [scopesEnvironmentName, process.env[scopesEnvironmentName]],
]);

function buildApp() {
  const app = express();
  app.locals.arcanosMcp = arcanosMcpPortMock;
  app.use(express.json());
  app.use('/', apiRouter);
  return app;
}

describe('API control-plane production composition', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env[accessTokenEnvironmentName] = controlPlaneAccessToken;
    process.env[principalEnvironmentName] = 'operator:composition-test';
    process.env[scopesEnvironmentName] = 'backend:read';
    executeControlPlaneOperationMock.mockResolvedValue({
      ok: true,
      operation: 'backend.health',
      provider: 'backend-api',
      environment: 'local',
      result: { status: 'ok' },
      auditId: 'cp_composition_test',
      warnings: [],
      redactedOutput: { status: 'ok' },
    });
  });

  it('reaches control-plane authentication before the writing-plane reroute gate', async () => {
    const response = await request(buildApp())
      .post('/api/control-plane/operations')
      .send({
        operation: 'backend.health',
        provider: 'backend-api',
        target: { resource: 'health' },
        environment: 'local',
        scope: 'backend:read',
        params: {},
        traceId: 'trace-api-composition-test',
        requestedBy: 'spoofed-operator',
      });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(memoryConsistencyGateMock).not.toHaveBeenCalled();
  });

  it('applies the real confirmation gate after authentication and scope authorization', async () => {
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
        traceId: 'trace-api-composition-confirmation-test',
        requestedBy: 'spoofed-operator',
      });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('CONFIRMATION_REQUIRED');
    expect(executeControlPlaneOperationMock).not.toHaveBeenCalled();
    expect(memoryConsistencyGateMock).not.toHaveBeenCalled();
  });

  it('executes only after the real confirmation gate accepts the request', async () => {
    const response = await request(buildApp())
      .post('/api/control-plane/operations')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`)
      .set('x-confirmed', 'yes')
      .send({
        operation: 'backend.health',
        provider: 'backend-api',
        target: { resource: 'health' },
        environment: 'local',
        scope: 'caller:admin',
        params: {},
        traceId: 'trace-api-composition-confirmed-test',
        requestedBy: 'spoofed-operator',
      });

    expect(response.status).toBe(200);
    expect(executeControlPlaneOperationMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      scope: ['backend:read'],
      requestedBy: 'operator:composition-test',
    }));
    expect(executeControlPlaneOperationMock.mock.calls[0]?.[1]).toEqual({
      request: expect.any(Object),
      mcpService: arcanosMcpPortMock,
    });
    expect(memoryConsistencyGateMock).not.toHaveBeenCalled();
  });

  it('keeps the writing-plane gate active for later API mounts', async () => {
    const response = await request(buildApp()).get('/api/commands');

    expect(response.status).toBe(418);
    expect(response.body.error.code).toBe('WRITING_PLANE_GATE_REACHED');
    expect(memoryConsistencyGateMock).toHaveBeenCalledTimes(1);
  });

  it('protects AI-routing debug reads before the writing-plane gate', async () => {
    const unauthenticated = await request(buildApp()).get(
      '/api/ai-routing/debug/latest',
    );

    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body.error.code).toBe(
      'CONTROL_PLANE_AUTH_REQUIRED',
    );
    expect(memoryConsistencyGateMock).not.toHaveBeenCalled();

    const wrongScope = await request(buildApp())
      .get('/api/ai-routing/debug/latest')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`);

    expect(wrongScope.status).toBe(403);
    expect(wrongScope.body.error.code).toBe(
      'CONTROL_PLANE_SCOPE_DENIED',
    );
    expect(memoryConsistencyGateMock).not.toHaveBeenCalled();
  });
});

afterAll(() => {
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});
