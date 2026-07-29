import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Express, NextFunction, Request, Response } from 'express';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const sessionListHandlerMock = jest.fn((_req: Request, res: Response) => {
  res.status(204).end();
});
const sessionCreateHandlerMock = jest.fn((req: Request, res: Response) => {
  res.status(200).json({
    parsedBody: req.body,
  });
});
const healthHandlerMock = jest.fn((_req: Request, res: Response) => {
  res.status(204).end();
});
const memoryHandlerMock = jest.fn((_req: Request, res: Response) => {
  res.status(204).end();
});
const saveConversationHandlerMock = jest.fn((_req: Request, res: Response) => {
  res.status(204).end();
});

jest.unstable_mockModule('@routes/register.js', () => ({
  registerRoutes: (app: Express) => {
    app.get('/api/health', healthHandlerMock);
    app.post('/api/memory/save', memoryHandlerMock);
    app.post('/api/save-conversation', saveConversationHandlerMock);
    app.get('/api/sessions', sessionListHandlerMock);
    app.post('/api/sessions', sessionCreateHandlerMock);
  },
}));
jest.unstable_mockModule('@core/init-openai.js', () => ({
  initOpenAI: jest.fn(),
}));
jest.unstable_mockModule('@core/diagnostics.js', () => ({
  setupDiagnostics: jest.fn(),
  writePublicHealthResponse: jest.fn(),
}));
jest.unstable_mockModule('@transport/http/middleware/unsafeExecutionGate.js', () => ({
  unsafeExecutionGate: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
jest.unstable_mockModule('@services/selfImprove/controlLoop.js', () => ({
  startSelfHealingControlLoop: jest.fn(),
}));
jest.unstable_mockModule('@services/runtimeDiagnosticsService.js', () => ({
  runtimeDiagnosticsService: {
    logStartupSummary: jest.fn(),
    recordRequestCompletion: jest.fn(),
  },
}));
jest.unstable_mockModule('@services/arcanosCoreRuntimeProviders.js', () => ({
  configureDefaultArcanosCoreRuntimeProviders: jest.fn(),
}));
jest.unstable_mockModule('@services/arcanosMcp.js', () => ({
  arcanosMcpService: {},
}));

const request = (await import('supertest')).default;
const { createApp } = await import('../src/app.js');

const memoryEnvironmentName = 'ARCANOS_MEMORY_ACCESS_TOKEN';
const memoryAccessToken = 'api-session-composition-token-1234567890';
const originalCredentialEnvironment = new Map(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
    (environmentName) => [environmentName, process.env[environmentName]] as const
  )
);

function clearPurposeBoundCredentialEnvironment(): void {
  for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[environmentName];
  }
}

describe('/api/sessions production authentication composition', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearPurposeBoundCredentialEnvironment();
    process.env[memoryEnvironmentName] = memoryAccessToken;
  });

  it('rejects missing and unrelated bearer credentials before session handlers', async () => {
    const missingResponse = await request(createApp()).get('/api/sessions');
    const bearerResponse = await request(createApp())
      .get('/api/sessions')
      .set('Authorization', `Bearer ${memoryAccessToken}`);

    expect(missingResponse.status).toBe(401);
    expect(missingResponse.body.error.code).toBe('MEMORY_AUTH_REQUIRED');
    expect(missingResponse.headers['cache-control']).toBe('no-store');
    expect(bearerResponse.status).toBe(401);
    expect(bearerResponse.body.error.code).toBe('MEMORY_AUTH_REQUIRED');
    expect(sessionListHandlerMock).not.toHaveBeenCalled();
  });

  it('fails closed when server-side memory authentication is unavailable', async () => {
    delete process.env[memoryEnvironmentName];

    const response = await request(createApp())
      .get('/api/sessions')
      .set('x-arcanos-memory-token', memoryAccessToken);

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('MEMORY_AUTH_UNAVAILABLE');
    expect(sessionListHandlerMock).not.toHaveBeenCalled();
  });

  it('authenticates before parsing a malformed JSON session body', async () => {
    const response = await request(createApp())
      .post('/api/sessions')
      .set('Content-Type', 'application/json')
      .send('{"payload":');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('MEMORY_AUTH_REQUIRED');
    expect(sessionCreateHandlerMock).not.toHaveBeenCalled();
  });

  it.each([
    ['/api/memory/save', memoryHandlerMock],
    ['/api/save-conversation', saveConversationHandlerMock],
  ] as const)('authenticates %s before parsing a malformed JSON body', async (
    path,
    expectedHandler
  ) => {
    const response = await request(createApp())
      .post(path)
      .set('Content-Type', 'application/json')
      .send('{"payload":');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('MEMORY_AUTH_REQUIRED');
    expect(expectedHandler).not.toHaveBeenCalled();
  });

  it('allows the dedicated memory header and preserves body parsing', async () => {
    const listResponse = await request(createApp())
      .get('/api/sessions')
      .set('x-arcanos-memory-token', memoryAccessToken);
    const createResponse = await request(createApp())
      .post('/api/sessions')
      .set('x-arcanos-memory-token', memoryAccessToken)
      .send({ label: 'authorized-session' });

    expect(listResponse.status).toBe(204);
    expect(listResponse.headers['cache-control']).toBe('no-store');
    expect(createResponse.status).toBe(200);
    expect(createResponse.headers['cache-control']).toBe('no-store');
    expect(createResponse.body).toEqual({
      parsedBody: {
        label: 'authorized-session',
      },
    });
    expect(sessionListHandlerMock).toHaveBeenCalledTimes(1);
    expect(sessionCreateHandlerMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the canonical API health endpoint public', async () => {
    const response = await request(createApp()).get('/api/health');

    expect(response.status).toBe(204);
    expect(healthHandlerMock).toHaveBeenCalledTimes(1);
  });

  it('mounts session authentication before the broad JSON parser', () => {
    const appSource = readFileSync(
      fileURLToPath(new URL('../src/app.ts', import.meta.url)),
      'utf8'
    );
    const authMountIndex = appSource.indexOf(
      "app.use('/api/sessions', requireMemoryPlaneAuth);"
    );
    const broadJsonParserIndex = appSource.indexOf(
      'app.use(express.json({ limit: config.limits.jsonLimit }));'
    );

    expect(authMountIndex).toBeGreaterThan(-1);
    expect(broadJsonParserIndex).toBeGreaterThan(authMountIndex);
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
