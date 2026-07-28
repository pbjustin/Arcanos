import express, { type NextFunction, type Request, type Response } from 'express';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const memoryRouteHandlerMock = jest.fn((_req: Request, res: Response) => {
  res.status(204).end();
});
const saveConversationRouteHandlerMock = jest.fn((_req: Request, res: Response) => {
  res.status(204).end();
});
let allowConsistencyGateToContinue = false;
const memoryConsistencyGateMock = jest.fn(
  (_req: Request, res: Response, next: NextFunction) => {
    if (allowConsistencyGateToContinue) {
      next();
      return;
    }

    res.status(418).json({
      ok: false,
      error: {
        code: 'WRITING_PLANE_GATE_REACHED',
      },
    });
  }
);

const memoryRouter = express.Router();
memoryRouter.use(memoryRouteHandlerMock);

const saveConversationRouter = express.Router();
saveConversationRouter.post('/api/save-conversation', saveConversationRouteHandlerMock);
saveConversationRouter.get('/api/save-conversation/:recordId', saveConversationRouteHandlerMock);

jest.unstable_mockModule('@routes/api-memory.js', () => ({
  default: memoryRouter,
}));
jest.unstable_mockModule('@routes/api-save-conversation.js', () => ({
  default: saveConversationRouter,
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

const memoryEnvironmentName = 'ARCANOS_MEMORY_ACCESS_TOKEN';
const memoryAccessToken = 'api-memory-composition-token-1234567890';
const originalCredentialEnvironment = new Map(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
    (environmentName) => [environmentName, process.env[environmentName]] as const
  )
);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/', apiRouter);
  return app;
}

function clearPurposeBoundCredentialEnvironment(): void {
  for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[environmentName];
  }
}

describe('memory API production authentication composition', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearPurposeBoundCredentialEnvironment();
    process.env[memoryEnvironmentName] = memoryAccessToken;
    allowConsistencyGateToContinue = false;
  });

  it.each([
    ['memory API', 'get', '/api/memory/load'],
    ['save-conversation API', 'post', '/api/save-conversation'],
  ] as const)('rejects unauthenticated %s access before consistency or route handling', async (
    _label,
    method,
    path
  ) => {
    const response = await request(buildApp())[method](path);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('MEMORY_AUTH_REQUIRED');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['www-authenticate']).toBeUndefined();
    expect(memoryConsistencyGateMock).not.toHaveBeenCalled();
    expect(memoryRouteHandlerMock).not.toHaveBeenCalled();
    expect(saveConversationRouteHandlerMock).not.toHaveBeenCalled();
  });

  it('does not promote a Bearer credential into memory authority', async () => {
    const response = await request(buildApp())
      .get('/api/memory/list')
      .set('Authorization', `Bearer ${memoryAccessToken}`);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('MEMORY_AUTH_REQUIRED');
    expect(memoryConsistencyGateMock).not.toHaveBeenCalled();
    expect(memoryRouteHandlerMock).not.toHaveBeenCalled();
  });

  it('fails before consistency or route handling when server authentication is unavailable', async () => {
    delete process.env[memoryEnvironmentName];

    const response = await request(buildApp())
      .get('/api/memory/health')
      .set('x-arcanos-memory-token', memoryAccessToken);

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('MEMORY_AUTH_UNAVAILABLE');
    expect(memoryConsistencyGateMock).not.toHaveBeenCalled();
    expect(memoryRouteHandlerMock).not.toHaveBeenCalled();
  });

  it('reaches the writing-plane consistency gate only after memory authentication', async () => {
    const response = await request(buildApp())
      .get('/api/memory/list')
      .set('x-arcanos-memory-token', memoryAccessToken);

    expect(response.status).toBe(418);
    expect(response.body.error.code).toBe('WRITING_PLANE_GATE_REACHED');
    expect(memoryConsistencyGateMock).toHaveBeenCalledTimes(1);
    expect(memoryRouteHandlerMock).not.toHaveBeenCalled();
  });

  it.each([
    ['memory API', 'get', '/api/memory/list', memoryRouteHandlerMock],
    ['save-conversation API', 'get', '/api/save-conversation/42', saveConversationRouteHandlerMock],
  ] as const)('allows authenticated %s access to continue through the production mount', async (
    _label,
    method,
    path,
    expectedHandler
  ) => {
    allowConsistencyGateToContinue = true;

    const response = await request(buildApp())[method](path)
      .set('Authorization', 'Bearer test-unrelated-gateway-token-1234567890')
      .set('x-arcanos-memory-token', memoryAccessToken);

    expect(response.status).toBe(204);
    expect(memoryConsistencyGateMock).toHaveBeenCalledTimes(1);
    expect(expectedHandler).toHaveBeenCalledTimes(1);
  });
});

afterAll(() => {
  clearPurposeBoundCredentialEnvironment();
  for (const [environmentName, value] of originalCredentialEnvironment) {
    if (value !== undefined) {
      process.env[environmentName] = value;
    }
  }
});
