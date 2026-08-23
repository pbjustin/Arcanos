import { readFileSync } from 'node:fs';

import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  createSystemStateHttpBoundary,
} from '../src/services/controlPlane/systemStateHttpBoundary.js';
import {
  SYSTEM_STATE_BODY_LIMIT_BYTES,
  systemStateBodyParser,
} from '../src/services/controlPlane/systemStateBodyParser.js';
import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const writePublicHealthResponseMock = jest.fn();
const loadStateMock = jest.fn();
const updateStateMock = jest.fn();
const getOpenAIServiceHealthMock = jest.fn();
const controlPlaneToken = 'status-route-control-token-1234567890';
const originalCredentialEnvironment = new Map(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
    (environmentName) => [environmentName, process.env[environmentName]] as const
  )
);
const originalPrincipalId = process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
const originalScopes = process.env.ARCANOS_CONTROL_PLANE_SCOPES;

jest.unstable_mockModule('../src/core/diagnostics.js', () => ({
  writePublicHealthResponse: writePublicHealthResponseMock
}));

jest.unstable_mockModule('../src/services/stateManager.js', () => ({
  loadState: loadStateMock,
  updateState: updateStateMock,
}));

jest.unstable_mockModule('../src/services/openai.js', () => ({
  getOpenAIServiceHealth: getOpenAIServiceHealthMock,
}));

const { default: statusRouter } = await import('../src/routes/status.js');

function clearPurposeBoundCredentialEnvironment(): void {
  for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[environmentName];
  }
}

function configureControlPlane(scopes = 'mcp:invoke'): void {
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = 'operator:status-route';
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = scopes;
}

function buildApp(options: {
  logEntries?: unknown[];
  preParserBoundary?: boolean;
} = {}) {
  const app = express();
  if (options.logEntries) {
    app.use((req, _res, next) => {
      req.logger = {
        error: (event: string, details?: unknown) => {
          options.logEntries?.push([event, details]);
        },
        warn: (event: string, details?: unknown) => {
          options.logEntries?.push([event, details]);
        },
      } as typeof req.logger;
      next();
    });
  }
  if (options.preParserBoundary !== false) {
    app.post('/status', createSystemStateHttpBoundary({
      maxClientRequests: 100,
      windowMs: 60_000,
    }));
    app.post('/status', systemStateBodyParser);
    app.use(express.json({ limit: '10mb' }));
  }
  app.use('/', statusRouter);
  app.use((
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    res.status((error as { status?: number }).status ?? 500).json({
      code: 'BROAD_PARSER_REJECTED',
    });
  });
  app.use((_req, res) => {
    res.status(404).json({
      error: 'Route Not Found',
      code: 404,
    });
  });
  return app;
}

function authenticatedPost(app = buildApp()) {
  return request(app)
    .post('/status')
    .set('Authorization', `Bearer ${controlPlaneToken}`);
}

describe('/status route', () => {
  beforeEach(() => {
    configureControlPlane();
    jest.clearAllMocks();
    updateStateMock.mockReset();
    getOpenAIServiceHealthMock.mockReset();
    writePublicHealthResponseMock.mockImplementation(async (_req, res) => {
      res.status(200).json({
        status: 'ok',
        service: 'arcanos-backend',
        version: '1.0.0'
      });
    });
    updateStateMock.mockImplementation((updates) => ({
      status: 'unknown',
      version: '0.0.0',
      lastSync: '2026-07-27T00:00:00.000Z',
      ...updates,
    }));
    getOpenAIServiceHealthMock.mockReturnValue({ status: 'healthy' });
  });

  it('aliases GET /status to the public health response without stale state', async () => {
    const response = await request(buildApp()).get('/status');

    expect(response.status).toBe(200);
    expect(response.headers['x-status-endpoint']).toBe('deprecated');
    expect(response.headers['x-status-replacement']).toBe('/health');
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(response.body).toEqual({
      status: 'ok',
      service: 'arcanos-backend',
      version: '1.0.0'
    });
    expect(writePublicHealthResponseMock).toHaveBeenCalledTimes(1);
  });

  it('returns a fixed no-store error while preserving deprecation metadata', async () => {
    const privateFailureSentinel = 'PRIVATE_STATUS_FAILURE_SENTINEL';
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const failure = new Error(`status failed: ${privateFailureSentinel}`);
    failure.name = `PrivateStatusFailure:${privateFailureSentinel}`;
    writePublicHealthResponseMock.mockRejectedValueOnce(failure);

    try {
      const response = await request(buildApp()).get('/status');

      expect(response.status).toBe(500);
      expect(response.headers['x-status-endpoint']).toBe('deprecated');
      expect(response.headers['x-status-replacement']).toBe('/health');
      expect(response.headers['cache-control']).toContain('no-store');
      expect(response.headers.pragma).toBe('no-cache');
      expect(response.body).toEqual({
        error: 'Failed to retrieve system state',
        message: 'Status endpoint unavailable.',
        timestamp: expect.any(String),
      });
      expect(JSON.stringify(response.body)).not.toContain(privateFailureSentinel);
      expect(JSON.stringify(consoleLogSpy.mock.calls)).not.toContain(privateFailureSentinel);
    } finally {
      consoleLogSpy.mockRestore();
    }
  });

  it('marks an unconfirmed POST challenge no-store before state mutation', async () => {
    const response = await authenticatedPost()
      .send({ status: 'maintenance' });

    expect(response.status).toBe(403);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(response.body.confirmationRequired).toBe(true);
    expect(typeof response.headers['x-confirmation-challenge']).toBe('string');
    expect(updateStateMock).not.toHaveBeenCalled();
  });

  it('rejects confirmation-only POST traffic before parsing or mutation', async () => {
    const privateBodySentinel = 'PRIVATE_STATUS_BODY_SENTINEL';
    const privateCredentialSentinel = 'private-status-credential-sentinel-1234567890';
    const logEntries: unknown[] = [];
    const app = buildApp({ logEntries });
    const response = await request(app)
      .post('/status')
      .set('x-confirmed', 'yes')
      .send({ status: privateBodySentinel });
    const invalidCredentialResponse = await request(app)
      .post('/status')
      .set('Authorization', `Bearer ${privateCredentialSentinel}`)
      .set('x-confirmed', 'yes')
      .send({ status: privateBodySentinel });

    expect(response.status).toBe(401);
    expect(response.body.error).toEqual({
      code: 'CONTROL_PLANE_AUTH_REQUIRED',
      message: 'Control-plane bearer authentication is required.',
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(response.headers['www-authenticate']).toBe('Bearer realm="control-plane"');
    expect(response.headers['x-confirmation-status']).toBeUndefined();
    expect(response.text).not.toContain(privateBodySentinel);
    expect(invalidCredentialResponse.status).toBe(401);
    expect(invalidCredentialResponse.text).not.toContain(privateBodySentinel);
    expect(invalidCredentialResponse.text).not.toContain(privateCredentialSentinel);
    expect(JSON.stringify(logEntries)).not.toContain(privateBodySentinel);
    expect(JSON.stringify(logEntries)).not.toContain(privateCredentialSentinel);
    expect(updateStateMock).not.toHaveBeenCalled();
  });

  it('fails closed when control-plane authentication is missing or colliding', async () => {
    clearPurposeBoundCredentialEnvironment();
    const unavailableResponse = await authenticatedPost()
      .set('x-confirmed', 'yes')
      .send({ status: 'maintenance' });

    configureControlPlane();
    process.env.MCP_BEARER_TOKEN = controlPlaneToken;
    const collisionResponse = await authenticatedPost()
      .set('x-confirmed', 'yes')
      .send({ status: 'maintenance' });

    for (const response of [unavailableResponse, collisionResponse]) {
      expect(response.status).toBe(503);
      expect(response.body.error).toEqual({
        code: 'CONTROL_PLANE_AUTH_UNAVAILABLE',
        message: 'Control-plane authentication is unavailable.',
      });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.text).not.toContain(controlPlaneToken);
    }
    expect(updateStateMock).not.toHaveBeenCalled();
  });

  it('denies a bearer principal without the mutation scope before confirmation', async () => {
    configureControlPlane('arcanos:read');

    const response = await authenticatedPost()
      .set('x-confirmed', 'yes')
      .send({ status: 'maintenance' });

    expect(response.status).toBe(403);
    expect(response.body.error).toEqual({
      code: 'CONTROL_PLANE_SCOPE_DENIED',
      message: 'Control-plane operation is not permitted.',
    });
    expect(response.headers['x-confirmation-status']).toBeUndefined();
    expect(updateStateMock).not.toHaveBeenCalled();
  });

  it('authenticates before allocating an oversized request body', async () => {
    const response = await request(buildApp())
      .post('/status')
      .set('x-confirmed', 'yes')
      .send({ status: 'x'.repeat(SYSTEM_STATE_BODY_LIMIT_BYTES) });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(response.body.code).not.toBe('BROAD_PARSER_REJECTED');
    expect(updateStateMock).not.toHaveBeenCalled();
  });

  it('rejects an authorized oversized body at the dedicated parser', async () => {
    const privateBodySentinel = 'PRIVATE_OVERSIZED_STATUS_BODY_SENTINEL';
    const logEntries: unknown[] = [];
    const response = await authenticatedPost(buildApp({ logEntries }))
      .set('x-confirmed', 'yes')
      .send({ status: privateBodySentinel.repeat(2_000) });

    expect(response.status).toBe(413);
    expect(response.body.error).toEqual({
      code: 'SYSTEM_STATE_REQUEST_INVALID',
      message: 'System-state request is invalid.',
    });
    expect(response.body.code).not.toBe('BROAD_PARSER_REJECTED');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.text).not.toContain(privateBodySentinel);
    expect(response.text).not.toContain(controlPlaneToken);
    expect(JSON.stringify(logEntries)).not.toContain(privateBodySentinel);
    expect(JSON.stringify(logEntries)).not.toContain(controlPlaneToken);
    expect(updateStateMock).not.toHaveBeenCalled();
  });

  it('preserves the authorized confirmed POST success payload', async () => {
    const response = await request(buildApp())
      .post('/status')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .set('x-confirmed', 'yes')
      .send({ status: 'maintenance' });

    expect(response.status).toBe(200);
    expect(response.headers['x-confirmation-status']).toBe('confirmed');
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(response.body).toEqual({
      status: 'maintenance',
      version: '0.0.0',
      lastSync: '2026-07-27T00:00:00.000Z',
    });
    expect(updateStateMock).toHaveBeenCalledWith({ status: 'maintenance' });
    expect(updateStateMock).toHaveBeenCalledTimes(1);
  });

  it('returns a fixed error when confirmed state persistence fails', async () => {
    const privateFailureSentinel = 'PRIVATE_STATUS_UPDATE_FAILURE_SENTINEL';
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error(`state persistence failed: ${privateFailureSentinel}`);
    failure.name = `PrivateStatePersistenceFailure:${privateFailureSentinel}`;
    updateStateMock.mockImplementationOnce(() => {
      throw failure;
    });

    try {
      const response = await request(buildApp())
        .post('/status')
        .set('Authorization', `Bearer ${controlPlaneToken}`)
        .set('x-confirmed', 'yes')
        .send({ status: 'maintenance' });

      expect(response.status).toBe(500);
      expect(response.headers['cache-control']).toContain('no-store');
      expect(response.headers.pragma).toBe('no-cache');
      expect(response.body).toEqual({
        error: 'Failed to update system state',
        message: 'System state update failed.',
        timestamp: expect.any(String),
      });
      expect(JSON.stringify(response.body)).not.toContain(privateFailureSentinel);
      expect(JSON.stringify(consoleLogSpy.mock.calls)).not.toContain(privateFailureSentinel);
      expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain(privateFailureSentinel);
    } finally {
      consoleLogSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });

  it('does not expose mutation behavior on unsupported methods or subpaths', async () => {
    const app = buildApp();
    const unsupportedMethodResponse = await request(app)
      .put('/status')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .set('x-confirmed', 'yes')
      .send({ status: 'maintenance' });
    const unsupportedSubpathResponse = await request(app)
      .post('/status/extra')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .set('x-confirmed', 'yes')
      .send({ status: 'maintenance' });
    const encodedSubpathResponse = await request(app)
      .post('/status%2Fextra')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .set('x-confirmed', 'yes')
      .send({ status: 'maintenance' });

    expect(unsupportedMethodResponse.status).toBe(404);
    expect(unsupportedSubpathResponse.status).toBe(404);
    expect(encodedSubpathResponse.status).toBe(404);
    expect(updateStateMock).not.toHaveBeenCalled();
  });

  it('retains the status boundary when the router is mounted independently', async () => {
    const response = await request(buildApp({ preParserBoundary: false }))
      .post('/status')
      .set('x-confirmed', 'yes')
      .send({ status: 'maintenance' });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(updateStateMock).not.toHaveBeenCalled();
  });

  it('mounts exact status authentication and bounded parsing before the broad parser', () => {
    const appSource = readFileSync(
      new URL('../src/app.ts', import.meta.url),
      'utf8'
    );
    const boundaryIndex = appSource.indexOf(
      "app.post('/status', systemStateHttpBoundary)"
    );
    const bodyParserIndex = appSource.indexOf(
      "app.post('/status', systemStateBodyParser)"
    );
    const broadParserIndex = appSource.indexOf(
      'app.use(express.json({ limit: config.limits.jsonLimit }))'
    );

    expect(boundaryIndex).toBeGreaterThan(-1);
    expect(bodyParserIndex).toBeGreaterThan(boundaryIndex);
    expect(bodyParserIndex).toBeLessThan(broadParserIndex);
  });

  it('contains failures from the shadowed detailed health compatibility handler', async () => {
    const privateFailureSentinel = 'PRIVATE_STATUS_HEALTH_FAILURE_SENTINEL';
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error(`health dependency failed: ${privateFailureSentinel}`);
    failure.name = `PrivateHealthFailure:${privateFailureSentinel}`;
    getOpenAIServiceHealthMock.mockImplementationOnce(() => {
      throw failure;
    });

    try {
      const response = await request(buildApp()).get('/health');

      expect(response.status).toBe(500);
      expect(response.headers['cache-control']).toContain('no-store');
      expect(response.headers.pragma).toBe('no-cache');
      expect(response.body).toEqual({
        error: 'Failed to retrieve health status',
        message: 'Health status unavailable.',
        status: 'unhealthy',
        timestamp: expect.any(String),
      });
      expect(JSON.stringify(response.body)).not.toContain(privateFailureSentinel);
      expect(JSON.stringify(consoleLogSpy.mock.calls)).not.toContain(privateFailureSentinel);
      expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain(privateFailureSentinel);
    } finally {
      consoleLogSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
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
