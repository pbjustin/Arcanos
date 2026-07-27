import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import request from 'supertest';
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

import {
  assistantRegistryBodyParser,
} from '../src/services/controlPlane/assistantRegistryBodyParser.js';
import {
  assistantRegistryHttpBoundary,
} from '../src/services/controlPlane/assistantRegistryHttpBoundary.js';
import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

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

const assistantRouter = express.Router();
assistantRouter.get('/', (_req, res) => {
  res.status(200).json({ route: 'assistant-list' });
});
assistantRouter.get('/:name', (_req, res) => {
  res.status(200).json({ route: 'assistant-detail' });
});
assistantRouter.post('/sync', (_req, res) => {
  res.status(200).json({ route: 'assistant-sync' });
});
jest.unstable_mockModule('@routes/api-assistants.js', () => ({
  default: assistantRouter,
}));

const unrelatedApiRouteModules = [
  '@routes/api-arcanos.js',
  '@routes/api-sim.js',
  '@routes/api-memory.js',
  '@routes/api-save-conversation.js',
  '@routes/api-codebase.js',
  '@routes/api-commands.js',
  '@routes/api-control-plane.js',
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
  '@routes/afol.js',
  '@routes/web-search.js',
] as const;
for (const moduleName of unrelatedApiRouteModules) {
  jest.unstable_mockModule(moduleName, () => ({
    default: express.Router(),
  }));
}

const apiRouter = (await import('../src/routes/api/index.js')).default;

const controlPlaneToken =
  'assistant-composition-token-12345678901234567890';
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
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID =
    'operator:assistant-composition';
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = 'arcanos:read,mcp:invoke';
}

function buildApp(): express.Express {
  const app = express();
  app.use('/api/assistants', assistantRegistryHttpBoundary);
  app.use('/api/assistants', assistantRegistryBodyParser);
  app.use(express.json({ limit: '10mb' }));
  app.use('/', apiRouter);
  return app;
}

function authorized(pendingRequest: request.Test): request.Test {
  return pendingRequest.set(
    'Authorization',
    `Bearer ${controlPlaneToken}`
  );
}

describe('assistant registry production routing composition', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    configureControlPlane();
  });

  it.each([
    ['GET', '/api/assistants'],
    ['HEAD', '/api/assistants/'],
    ['GET', '/api/assistants/alpha'],
    ['HEAD', '/api/assistants/alpha/'],
  ])('dispatches authenticated %s %s before writing-plane consistency', async (
    method,
    path
  ) => {
    const pending = request(buildApp())[method.toLowerCase() as 'get' | 'head'](
      path
    );
    const response = await authorized(pending);

    expect(response.status).toBe(200);
    expect(memoryConsistencyGateMock).not.toHaveBeenCalled();
  });

  it('dispatches authorized sync before writing-plane consistency', async () => {
    const response = await authorized(
      request(buildApp()).post('/api/assistants/sync')
    ).send({});

    expect(response.status).toBe(200);
    expect(memoryConsistencyGateMock).not.toHaveBeenCalled();
  });

  it('authenticates before parsing malformed sync JSON', async () => {
    const response = await request(buildApp())
      .post('/api/assistants/sync')
      .set('Content-Type', 'application/json')
      .send('{');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(memoryConsistencyGateMock).not.toHaveBeenCalled();
  });

  it('terminates unknown assistant paths before writing-plane consistency', async () => {
    const response = await authorized(
      request(buildApp()).get('/api/assistants/alpha/extra')
    );

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: 'Route Not Found',
      code: 404,
    });
    expect(memoryConsistencyGateMock).not.toHaveBeenCalled();
  });

  it('keeps unrelated API traffic behind writing-plane consistency', async () => {
    const response = await request(buildApp()).get('/api/openai/models');

    expect(response.status).toBe(418);
    expect(response.body.error.code).toBe('WRITING_PLANE_GATE_REACHED');
    expect(memoryConsistencyGateMock).toHaveBeenCalledTimes(1);
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
});
