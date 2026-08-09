import type {
  Express,
  NextFunction,
  Request,
  Response,
} from 'express';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const originalNodeEnvironment = process.env.NODE_ENV;
const originalAllowedOrigins = process.env.ALLOWED_ORIGINS;
process.env.NODE_ENV = 'development';
delete process.env.ALLOWED_ORIGINS;

const commandReadHandlerMock = jest.fn((req: Request, res: Response) => {
  res.status(200).json({
    principalId: req.controlPlanePrincipal?.principalId,
  });
});
const neighborHandlerMock = jest.fn((_req: Request, res: Response) => {
  res.status(204).end();
});

jest.unstable_mockModule('@routes/register.js', () => ({
  registerRoutes: (app: Express) => {
    app.get('/api/commands', commandReadHandlerMock);
    app.post('/api/commands-neighbor', neighborHandlerMock);
  },
}));
jest.unstable_mockModule('@core/init-openai.js', () => ({
  initOpenAI: jest.fn(),
}));
jest.unstable_mockModule('@core/diagnostics.js', () => ({
  setupDiagnostics: jest.fn(),
  writePublicHealthResponse: jest.fn(),
}));
jest.unstable_mockModule(
  '@transport/http/middleware/unsafeExecutionGate.js',
  () => ({
    unsafeExecutionGate: (
      _req: Request,
      _res: Response,
      next: NextFunction
    ) => next(),
  })
);
jest.unstable_mockModule('@services/selfImprove/controlLoop.js', () => ({
  startSelfHealingControlLoop: jest.fn(),
}));
jest.unstable_mockModule('@services/runtimeDiagnosticsService.js', () => ({
  runtimeDiagnosticsService: {
    logStartupSummary: jest.fn(),
    recordRequestCompletion: jest.fn(),
  },
}));
jest.unstable_mockModule('@platform/runtime/workerConfig.js', () => ({
  startConfiguredWorkerRuntime: jest.fn(async () => null),
}));
jest.unstable_mockModule('@services/arcanosCoreRuntimeProviders.js', () => ({
  configureDefaultArcanosCoreRuntimeProviders: jest.fn(),
}));
jest.unstable_mockModule('@services/arcanosMcp.js', () => ({
  arcanosMcpService: {},
}));
jest.unstable_mockModule('@services/gptAccessGateway.js', () => {
  const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    gptAccessAuthMiddleware: passThrough,
    requireGptAccessScope: () => passThrough,
  };
});
jest.unstable_mockModule(
  '@transport/http/middleware/fallbackHandler.js',
  () => ({
    createHealthCheckMiddleware: () => (
      _req: Request,
      _res: Response,
      next: NextFunction
    ) => next(),
    createFallbackMiddleware: () => (
      _req: Request,
      _res: Response,
      next: NextFunction
    ) => next(),
  })
);
jest.unstable_mockModule('@transport/http/gamingIngressAudit.js', () => ({
  gamingIngressAudit: (
    _req: Request,
    _res: Response,
    next: NextFunction
  ) => next(),
}));

const {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} = await import('../src/shared/security/purposeBoundCredential.js');
const request = (await import('supertest')).default;
const { createApp } = await import('../src/app.js');

const controlPlaneToken = 'cef-cors-composition-token-1234567890123456789';
const allowedOrigin = 'https://operator.example.test';
const originalCredentialEnvironment = new Map(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
    (environmentName) => [environmentName, process.env[environmentName]] as const
  )
);
const originalPrincipalId = process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
const originalScopes = process.env.ARCANOS_CONTROL_PLANE_SCOPES;

function clearPurposeBoundCredentialEnvironment(): void {
  for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[environmentName];
  }
}

function configureControlPlane(): void {
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = 'operator:cef-cors';
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = 'arcanos:read,mcp:invoke';
}

describe('CEF production CORS composition', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    configureControlPlane();
  });

  it('authenticates exact-prefix OPTIONS before CORS can terminate it', async () => {
    const response = await request(createApp())
      .options('/api/commands')
      .set('Origin', allowedOrigin)
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'authorization');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(commandReadHandlerMock).not.toHaveBeenCalled();
  });

  it('lets authenticated supported requests continue through CORS', async () => {
    const response = await request(createApp())
      .get('/api/commands')
      .set('Origin', allowedOrigin)
      .set('Authorization', `Bearer ${controlPlaneToken}`);

    expect(response.status).toBe(200);
    expect(response.body.principalId).toBe('operator:cef-cors');
    expect(response.headers['access-control-allow-origin']).toBe(allowedOrigin);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(commandReadHandlerMock).toHaveBeenCalledTimes(1);
  });

  it('keeps neighboring OPTIONS requests on the global CORS path', async () => {
    const response = await request(createApp())
      .options('/api/commands-neighbor')
      .set('Origin', allowedOrigin)
      .set('Access-Control-Request-Method', 'POST');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(allowedOrigin);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(neighborHandlerMock).not.toHaveBeenCalled();
  });
});

afterAll(() => {
  clearPurposeBoundCredentialEnvironment();
  for (const [environmentName, value] of originalCredentialEnvironment) {
    if (value !== undefined) {
      process.env[environmentName] = value;
    }
  }
  if (originalPrincipalId === undefined) {
    delete process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
  } else {
    process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = originalPrincipalId;
  }
  if (originalScopes === undefined) {
    delete process.env.ARCANOS_CONTROL_PLANE_SCOPES;
  } else {
    process.env.ARCANOS_CONTROL_PLANE_SCOPES = originalScopes;
  }
  if (originalNodeEnvironment === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnvironment;
  }
  if (originalAllowedOrigins === undefined) {
    delete process.env.ALLOWED_ORIGINS;
  } else {
    process.env.ALLOWED_ORIGINS = originalAllowedOrigins;
  }
});
