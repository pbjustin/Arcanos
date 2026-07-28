import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';

import {
  AFOL_DECISION_BODY_LIMIT_BYTES,
  afolBodyParser,
} from '../src/services/controlPlane/afolBodyParser.js';
import {
  createAfolHttpBoundary,
} from '../src/services/controlPlane/afolHttpBoundary.js';
import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const controlPlaneToken = 'afol-boundary-token-123456789012345678901234';
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
  principalId = 'operator:afol-boundary'
): void {
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = principalId;
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = scopes;
}

function buildApp(options: {
  maxClientRequests?: number;
  windowMs?: number;
} = {}): express.Express {
  const app = express();
  app.set('trust proxy', true);
  const boundary = createAfolHttpBoundary({
    maxClientRequests: options.maxClientRequests ?? 100,
    windowMs: options.windowMs ?? 60_000,
  });
  app.use('/api/afol', boundary);
  app.use('/api/afol', afolBodyParser);
  app.use(express.json({ limit: '10mb' }));
  app.post('/api/afol/decide', (req, res) => {
    res.status(200).json({ route: 'decide', body: req.body });
  });
  app.get('/api/afol/health', (_req, res) => {
    res.status(200).json({ route: 'health' });
  });
  app.get('/api/afol/logs', (_req, res) => {
    res.status(200).json({ route: 'logs' });
  });
  app.get('/api/afol/analytics', (_req, res) => {
    res.status(200).json({ route: 'analytics' });
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

function authorized(
  pendingRequest: request.Test
): request.Test {
  return pendingRequest.set('Authorization', `Bearer ${controlPlaneToken}`);
}

describe('AFOL HTTP ingress boundary', () => {
  beforeEach(() => {
    configureControlPlane();
  });

  it('authenticates before parsing malformed or oversized decision bodies', async () => {
    const app = buildApp();
    const malformed = await request(app)
      .post('/api/afol/decide')
      .set('Content-Type', 'application/json')
      .send('{"prompt":');
    const oversized = await request(app)
      .post('/api/afol/decide')
      .send({ prompt: 'x'.repeat(AFOL_DECISION_BODY_LIMIT_BYTES) });

    expect(malformed.status).toBe(401);
    expect(malformed.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(oversized.status).toBe(401);
    expect(oversized.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
  });

  it('separates inspection and execution scopes with no-store responses', async () => {
    configureControlPlane('arcanos:read');
    const readApp = buildApp();
    const reads = await Promise.all([
      authorized(request(readApp).get('/api/afol/health')),
      authorized(request(readApp).get('/api/afol/logs/')),
      authorized(request(readApp).head('/api/afol/analytics')),
      authorized(request(readApp).head('/api/afol/health/')),
    ]);
    const executionDenied = await authorized(
      request(readApp).post('/api/afol/decide')
    ).send({ prompt: 'hello' });

    expect(reads.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    for (const response of reads) {
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers.pragma).toBe('no-cache');
      expect(response.headers['x-ratelimit-bucket']).toBe('afol-read');
    }
    expect(executionDenied.status).toBe(403);
    expect(executionDenied.body.error.code).toBe('CONTROL_PLANE_SCOPE_DENIED');

    configureControlPlane('mcp:invoke');
    const executionApp = buildApp();
    const execution = await authorized(
      request(executionApp).post('/api/afol/decide/')
    ).send({ prompt: 'hello' });
    const readDenied = await authorized(
      request(executionApp).get('/api/afol/logs')
    );

    expect(execution.status).toBe(200);
    expect(execution.headers['x-ratelimit-bucket']).toBe('afol-execution');
    expect(readDenied.status).toBe(403);
    expect(readDenied.body.error.code).toBe('CONTROL_PLANE_SCOPE_DENIED');
  });

  it('accepts one optional trailing slash but rejects two and unknown leaves', async () => {
    const app = buildApp();
    const doubleSlash = await authorized(
      request(app).get('/api/afol/health//')
    );
    const unknown = await authorized(
      request(app).get('/api/afol/status')
    );
    const wrongMethod = await authorized(
      request(app).put('/api/afol/health')
    ).send({});

    for (const response of [doubleSlash, unknown, wrongMethod]) {
      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        error: 'Route Not Found',
        code: 404,
      });
      expect(response.headers['cache-control']).toBe('no-store');
    }
  });

  it('enforces object JSON, media type, encoding, and byte bounds', async () => {
    const app = buildApp();
    const malformed = await authorized(
      request(app)
        .post('/api/afol/decide')
        .set('Content-Type', 'application/json')
        .send('{"prompt":')
    );
    const primitive = await authorized(
      request(app)
        .post('/api/afol/decide')
        .set('Content-Type', 'application/json')
        .send('"hello"')
    );
    const unsupported = await authorized(
      request(app)
        .post('/api/afol/decide')
        .set('Content-Type', 'text/plain')
        .send('hello')
    );
    const compressed = await authorized(
      request(app)
        .post('/api/afol/decide')
        .set('Content-Type', 'application/json')
        .set('Content-Encoding', 'gzip')
        .send('compressed')
    );
    const oversized = await authorized(
      request(app).post('/api/afol/decide')
    ).send({ prompt: 'x'.repeat(AFOL_DECISION_BODY_LIMIT_BYTES) });
    const vendorJson = await authorized(
      request(app)
        .post('/api/afol/decide')
        .set('Content-Type', 'application/vnd.arcanos+json')
        .send(JSON.stringify({ prompt: 'hello' }))
    );

    expect(malformed.status).toBe(400);
    expect(primitive.status).toBe(400);
    expect(unsupported.status).toBe(415);
    expect(compressed.status).toBe(415);
    expect(oversized.status).toBe(413);
    expect(vendorJson.status).toBe(200);
    for (const response of [
      malformed,
      primitive,
      unsupported,
      compressed,
      oversized,
    ]) {
      expect(response.body.error.code).toBe('AFOL_REQUEST_INVALID');
      expect(response.body.code).not.toBe('BROAD_PARSER_REJECTED');
    }
  });

  it('rejects bodies on inspection reads', async () => {
    configureControlPlane('arcanos:read');
    const response = await authorized(
      request(buildApp())
        .get('/api/afol/logs')
        .set('Content-Type', 'application/json')
        .send({ probe: true })
    );

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('AFOL_REQUEST_INVALID');
  });

  it('does not let invalid bearer traffic exhaust authenticated ingress', async () => {
    const app = buildApp({
      maxClientRequests: 1,
      windowMs: 60_000,
    });
    const clientAddress = '198.51.100.93';
    const invalid = await request(app)
      .get('/api/afol/health')
      .set('X-Forwarded-For', clientAddress)
      .set('Authorization', 'Bearer invalid-afol-token');
    const throttled = await request(app)
      .get('/api/afol/logs')
      .set('X-Forwarded-For', clientAddress)
      .set('Authorization', 'Bearer invalid-afol-token');
    const authenticated = await authorized(
      request(app).get('/api/afol/health')
    ).set('X-Forwarded-For', clientAddress);

    expect(invalid.status).toBe(401);
    expect(throttled.status).toBe(429);
    expect(authenticated.status).toBe(200);
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
