import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { resolveBinding } from '../src/services/dispatchControllerV9.js';
import {
  afolBodyParser,
} from '../src/services/controlPlane/afolBodyParser.js';
import {
  afolHttpBoundary,
} from '../src/services/controlPlane/afolHttpBoundary.js';
import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';
import type { DispatchAttemptV9 } from '../src/shared/types/dispatchV9.js';

const controlPlaneToken = 'afol-composition-token-123456789012345678901';
const originalCredentialEnvironment = new Map(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
    (environmentName) => [environmentName, process.env[environmentName]] as const
  )
);
const originalPrincipalId = process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
const originalScopes = process.env.ARCANOS_CONTROL_PLANE_SCOPES;

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
jest.unstable_mockModule(
  '@transport/http/middleware/memoryConsistencyGate.js',
  () => ({
    memoryConsistencyGate: memoryConsistencyGateMock,
  })
);
jest.unstable_mockModule('@services/safety/configIntegrity.js', () => ({
  assertProtectedConfigIntegrity: jest.fn(),
}));

const afolRouter = express.Router();
afolRouter.get('/health', (_req, res) => {
  res.status(200).json({ route: 'afol-health' });
});
afolRouter.get('/logs', (_req, res) => {
  res.status(200).json({ route: 'afol-logs' });
});
afolRouter.get('/analytics', (_req, res) => {
  res.status(200).json({ route: 'afol-analytics' });
});
afolRouter.post('/decide', (_req, res) => {
  res.status(200).json({ route: 'afol-decide' });
});
jest.unstable_mockModule('@routes/afol.js', () => ({
  default: afolRouter,
}));

const unrelatedApiRouteModules = [
  '@routes/api-arcanos.js',
  '@routes/api-sim.js',
  '@routes/api-memory.js',
  '@routes/api-save-conversation.js',
  '@routes/api-codebase.js',
  '@routes/api-commands.js',
  '@routes/api-control-plane.js',
  '@routes/api-assistants.js',
  '@routes/api-vision.js',
  '@routes/api-transcribe.js',
  '@routes/api-update.js',
  '@routes/api-daemon.js',
  '@routes/api-agent.js',
  '@routes/api-prompt-debug.js',
  '@routes/api-ai-routing-debug.js',
  '@routes/api-reusable-code.js',
  '@routes/pr-analysis.js',
  '@routes/openai.js',
  '@routes/web-search.js',
] as const;
for (const moduleName of unrelatedApiRouteModules) {
  jest.unstable_mockModule(moduleName, () => ({
    default: express.Router(),
  }));
}

const {
  DISPATCH_PATTERN_BINDINGS,
  DISPATCH_V9_EXEMPT_ROUTES,
} = await import('../src/platform/runtime/dispatchPatterns.js');
const apiRouter = (await import('../src/routes/api/index.js')).default;

function clearPurposeBoundCredentialEnvironment(): void {
  for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[environmentName];
  }
}

function configureControlPlane(): void {
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = 'operator:afol-composition';
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = 'arcanos:read,mcp:invoke';
}

function buildApp(): express.Express {
  const app = express();
  app.use('/api/afol', afolHttpBoundary);
  app.use('/api/afol', afolBodyParser);
  app.use(express.json({ limit: '10mb' }));
  app.use('/', apiRouter);
  return app;
}

function createAttempt(path: string): DispatchAttemptV9 {
  return {
    method: 'POST',
    path,
    routeAttempted: `POST ${path}`,
    intentHints: [],
    requestId: 'req-afol-routing',
    traceId: 'trace-afol-routing',
  };
}

describe('AFOL production routing composition', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    configureControlPlane();
  });

  it.each([
    '/api/afol/health',
    '/api/afol/logs/',
    '/api/afol/analytics',
  ])('dispatches authenticated read %s before writing-plane consistency', async (path) => {
    const response = await request(buildApp())
      .get(path)
      .set('Authorization', `Bearer ${controlPlaneToken}`);

    expect(response.status).toBe(200);
    expect(memoryConsistencyGateMock).not.toHaveBeenCalled();
  });

  it('keeps POST /decide behind writing-plane consistency', async () => {
    const response = await request(buildApp())
      .post('/api/afol/decide')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .send({ prompt: 'hello' });

    expect(response.status).toBe(418);
    expect(response.body.error.code).toBe('WRITING_PLANE_GATE_REACHED');
    expect(memoryConsistencyGateMock).toHaveBeenCalledTimes(1);
  });

  it('authenticates before parsing or dispatching malformed POST JSON', async () => {
    const response = await request(buildApp())
      .post('/api/afol/decide')
      .set('Content-Type', 'application/json')
      .send('{"prompt":');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(memoryConsistencyGateMock).not.toHaveBeenCalled();
  });

  it.each(['/api/afol/decide', '/api/afol/decide/'])(
    'strictly binds POST %s to AFOL decision execution',
    (path) => {
      expect(resolveBinding(
        createAttempt(path),
        DISPATCH_PATTERN_BINDINGS
      )).toEqual(expect.objectContaining({
        id: 'api.afol-decision',
        sensitivity: 'sensitive',
        conflictPolicy: 'strict_block',
      }));
    }
  );

  it.each(['GET', 'HEAD'])(
    'exempts AFOL %s inspection from writing-plane rerouting',
    (method) => {
      for (const path of [
        '/api/afol/health',
        '/api/afol/health/',
        '/api/afol/logs',
        '/api/afol/logs/',
        '/api/afol/analytics',
        '/api/afol/analytics/',
      ]) {
        expect(DISPATCH_V9_EXEMPT_ROUTES).toContainEqual({
          method,
          exactPath: path,
        });
      }
    }
  );
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
});
