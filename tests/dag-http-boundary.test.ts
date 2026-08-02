import { readFileSync } from 'node:fs';

import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  createDagExecutionHttpBoundary,
  createDagHttpBoundary,
} from '../src/services/controlPlane/dagHttpBoundary.js';
import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const controlPlaneToken = 'dag-boundary-token-12345678901234567890';
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

function configureControlPlane(
  scopes = 'arcanos:read,mcp:invoke',
  principalId = 'operator:dag-boundary'
): void {
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = principalId;
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = scopes;
}

function buildApp(options: {
  maxClientRequests?: number;
} = {}): express.Express {
  const app = express();
  const boundary = createDagHttpBoundary({
    maxClientRequests: options.maxClientRequests ?? 100,
    windowMs: 60_000,
  });

  app.use('/api/arcanos/dag', boundary);
  app.use(express.json({ limit: '10mb' }));
  app.post('/api/arcanos/dag/runs', (req, res) => {
    res.status(202).json({
      ok: true,
      sessionId: req.body?.sessionId,
    });
  });
  app.get('/api/arcanos/dag/runs/latest', (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.get('/api/arcanos/dag/runs/:runId', (req, res) => {
    res.status(200).json({
      ok: true,
      runId: req.params.runId,
    });
  });
  app.get('/api/arcanos/dag/runs/:runId/admission', (req, res) => {
    res.status(200).json({
      ok: true,
      runId: req.params.runId,
      state: 'pending',
    });
  });
  app.post('/api/arcanos/dag/runs/:runId/cancel', (req, res) => {
    res.status(200).json({
      ok: true,
      runId: req.params.runId,
    });
  });
  app.get('/api/arcanos/dagmatic', (_req, res) => {
    res.status(204).end();
  });
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

  return app;
}

function buildExecutionCompatibilityApp(options: {
  maxClientRequests?: number;
  onAccepted?: ReturnType<typeof jest.fn>;
} = {}): express.Express {
  const app = express();
  const boundary = createDagExecutionHttpBoundary({
    maxClientRequests: options.maxClientRequests ?? 100,
    windowMs: 60_000,
  });

  app.use(express.json());
  app.post('/dispatch', boundary, (_req, res) => {
    options.onAccepted?.();
    res.status(202).json({ ok: true });
  });

  return app;
}

function authenticatedGet(
  app: express.Express,
  path = '/api/arcanos/dag/runs/latest'
) {
  return request(app)
    .get(path)
    .set('Authorization', `Bearer ${controlPlaneToken}`);
}

function authenticatedPost(
  app: express.Express,
  path = '/api/arcanos/dag/runs'
) {
  return request(app)
    .post(path)
    .set('Authorization', `Bearer ${controlPlaneToken}`);
}

describe('DAG HTTP ingress boundary', () => {
  beforeEach(() => {
    configureControlPlane();
  });

  it('authenticates before parsing an invalid DAG request body', async () => {
    const response = await request(buildApp())
      .post('/api/arcanos/dag/runs')
      .set('Content-Type', 'application/json')
      .send('{"sessionId":');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(response.body.code).not.toBe('BROAD_PARSER_REJECTED');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('fails closed when control-plane authentication is unavailable', async () => {
    clearPurposeBoundCredentialEnvironment();

    const response = await request(buildApp())
      .post('/api/arcanos/dag/runs')
      .send({ sessionId: 'session-1' });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_UNAVAILABLE');
  });

  it('separates DAG read and execution scopes', async () => {
    configureControlPlane('arcanos:read');
    const readOnlyApp = buildApp();
    const readResponse = await authenticatedGet(readOnlyApp);
    const executionDenied = await authenticatedPost(readOnlyApp)
      .send({ sessionId: 'session-read-only' });
    const admissionDenied = await authenticatedGet(
      readOnlyApp,
      '/api/arcanos/dag/runs/run-1/admission'
    );

    expect(readResponse.status).toBe(200);
    expect(executionDenied.status).toBe(403);
    expect(executionDenied.body.error.code).toBe('CONTROL_PLANE_SCOPE_DENIED');
    expect(admissionDenied.status).toBe(403);
    expect(admissionDenied.body.error.code).toBe('CONTROL_PLANE_SCOPE_DENIED');

    configureControlPlane('mcp:invoke');
    const executionOnlyApp = buildApp();
    const createResponse = await authenticatedPost(executionOnlyApp)
      .send({ sessionId: 'session-execution' });
    const cancelResponse = await authenticatedPost(
      executionOnlyApp,
      '/api/arcanos/dag/runs/run-1/cancel'
    );
    const admissionResponse = await authenticatedGet(
      executionOnlyApp,
      '/api/arcanos/dag/runs/run-1/admission'
    );
    const readDenied = await authenticatedGet(executionOnlyApp);

    expect(createResponse.status).toBe(202);
    expect(cancelResponse.status).toBe(200);
    expect(admissionResponse.status).toBe(200);
    expect(readDenied.status).toBe(403);
    expect(readDenied.body.error.code).toBe('CONTROL_PLANE_SCOPE_DENIED');
  });

  it('keeps invalid bearer traffic from exhausting authenticated ingress', async () => {
    const app = buildApp({ maxClientRequests: 1 });

    const denied = await request(app)
      .get('/api/arcanos/dag/runs/latest')
      .set('Authorization', 'Bearer invalid-control-plane-test-token');
    const throttled = await request(app)
      .get('/api/arcanos/dag/runs/latest')
      .set('Authorization', 'Bearer invalid-control-plane-test-token');
    const authenticated = await authenticatedGet(app);

    expect(denied.status).toBe(401);
    expect(throttled.status).toBe(429);
    expect(authenticated.status).toBe(200);
  });

  it('reuses the canonical execution policy for a compatibility route', async () => {
    const accepted = jest.fn();
    const response = await request(buildExecutionCompatibilityApp({ onAccepted: accepted }))
      .post('/dispatch')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .send({ target: 'dag' });

    expect(response.status).toBe(202);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-ratelimit-limit']).toBe('60');
    expect(response.headers['x-ratelimit-remaining']).toBe('59');
    expect(response.headers['x-ratelimit-bucket']).toBe('api-arcanos-dag-execution');
    expect(accepted).toHaveBeenCalledTimes(1);
  });

  it('applies canonical client admission before compatibility authentication', async () => {
    const accepted = jest.fn();
    const app = buildExecutionCompatibilityApp({
      maxClientRequests: 1,
      onAccepted: accepted,
    });

    const denied = await request(app)
      .post('/dispatch')
      .set('Authorization', 'Bearer invalid-control-plane-test-token')
      .send({ target: 'dag' });
    const throttled = await request(app)
      .post('/dispatch')
      .set('Authorization', 'Bearer invalid-control-plane-test-token')
      .send({ target: 'dag' });
    const authenticated = await request(app)
      .post('/dispatch')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .send({ target: 'dag' });

    expect(denied.status).toBe(401);
    expect(denied.headers['cache-control']).toBe('no-store');
    expect(throttled.status).toBe(429);
    expect(throttled.headers['cache-control']).toBe('no-store');
    expect(authenticated.status).toBe(202);
    expect(authenticated.headers['cache-control']).toBe('no-store');
    expect(accepted).toHaveBeenCalledTimes(1);
  });

  it('denies compatibility execution at canonical principal admission', async () => {
    const accepted = jest.fn();
    const app = buildExecutionCompatibilityApp({ onAccepted: accepted });

    for (let requestIndex = 0; requestIndex < 60; requestIndex += 1) {
      const response = await request(app)
        .post('/dispatch')
        .set('Authorization', `Bearer ${controlPlaneToken}`)
        .send({ target: 'dag' });
      expect(response.status).toBe(202);
      expect(response.headers['cache-control']).toBe('no-store');
    }

    expect(accepted).toHaveBeenCalledTimes(60);
    accepted.mockClear();

    const denied = await request(app)
      .post('/dispatch')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .send({ target: 'dag' });

    expect(denied.status).toBe(429);
    expect(denied.headers['cache-control']).toBe('no-store');
    expect(denied.headers.pragma).toBe('no-cache');
    expect(denied.headers['x-ratelimit-bucket']).toBe('api-arcanos-dag-execution');
    expect(accepted).not.toHaveBeenCalled();
  });

  it('terminates unknown protected subpaths without capturing neighbors', async () => {
    const unknownResponse = await authenticatedGet(
      buildApp(),
      '/api/arcanos/dag/runs/run-1/unknown'
    );
    const neighborResponse = await request(buildApp())
      .get('/api/arcanos/dagmatic');

    expect(unknownResponse.status).toBe(404);
    expect(unknownResponse.body).toEqual({
      error: 'Route Not Found',
      code: 404,
    });
    expect(neighborResponse.status).toBe(204);
  });

  it.each([
    ['GET', '/api/arcanos/dag/runs/latest/', 200],
    ['HEAD', '/api/arcanos/dag/runs/run-1', 200],
    ['PUT', '/api/arcanos/dag/runs/run-1', 404],
    ['POST', '/api/arcanos/dag/runs/run-1/trace', 404],
  ])('keeps the canonical method/path boundary for %s %s', async (
    method,
    path,
    expectedStatus
  ) => {
    const response = await request(buildApp())
      [method.toLowerCase() as 'get' | 'head' | 'post' | 'put'](path)
      .set('Authorization', `Bearer ${controlPlaneToken}`);

    expect(response.status).toBe(expectedStatus);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('mounts DAG authentication before the broad parser', () => {
    const appSource = readFileSync(
      new URL('../src/app.ts', import.meta.url),
      'utf8'
    );
    const apiRouterSource = readFileSync(
      new URL('../src/routes/api/index.ts', import.meta.url),
      'utf8'
    );
    const boundaryIndex = appSource.indexOf(
      "app.use('/api/arcanos/dag', dagHttpBoundary)"
    );
    const broadParserIndex = appSource.indexOf(
      'app.use(express.json({ limit: config.limits.jsonLimit }))'
    );
    const dagControlPlaneIndex = apiRouterSource.indexOf(
      "router.use('/api/arcanos', routeDagControlPlane)"
    );
    const writingPlaneGateIndex = apiRouterSource.indexOf(
      'router.use(memoryConsistencyGate)'
    );

    expect(boundaryIndex).toBeGreaterThan(-1);
    expect(boundaryIndex).toBeLessThan(broadParserIndex);
    expect(dagControlPlaneIndex).toBeGreaterThan(-1);
    expect(dagControlPlaneIndex).toBeLessThan(writingPlaneGateIndex);
  });

  it('mounts conditional dispatch DAG policy after both broad parsers and before the unsafe gate', () => {
    const appSource = readFileSync(
      new URL('../src/app.ts', import.meta.url),
      'utf8'
    );
    const jsonParserIndex = appSource.indexOf(
      'app.use(express.json({ limit: config.limits.jsonLimit }))'
    );
    const urlencodedParserIndex = appSource.indexOf(
      'app.use(express.urlencoded({ extended: true }))'
    );
    const dispatchBoundaryIndex = appSource.search(
      /app\.post\(\s*['"]\/dispatch['"],\s*dispatchDagCompatibilityBoundary\b/
    );
    const unsafeGateIndex = appSource.indexOf('app.use(unsafeExecutionGate)');

    expect(dispatchBoundaryIndex).toBeGreaterThan(jsonParserIndex);
    expect(dispatchBoundaryIndex).toBeGreaterThan(urlencodedParserIndex);
    expect(dispatchBoundaryIndex).toBeLessThan(unsafeGateIndex);
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
