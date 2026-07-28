import { readFileSync } from 'node:fs';

import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';

import aiEndpointsRouter from '../src/routes/ai-endpoints.js';
import {
  REINFORCE_BODY_LIMIT_BYTES,
  REINFORCEMENT_FEEDBACK_BODY_LIMIT_BYTES,
  reinforcementBodyParser,
} from '../src/services/controlPlane/reinforcementBodyParser.js';
import {
  createReinforcementHttpBoundary,
} from '../src/services/controlPlane/reinforcementHttpBoundary.js';
import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const controlPlaneToken =
  'reinforcement-boundary-token-1234567890';
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
  principalId = 'operator:reinforcement-boundary'
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
  const boundary = createReinforcementHttpBoundary({
    maxClientRequests: options.maxClientRequests ?? 100,
    windowMs: options.windowMs ?? 60_000,
  });
  for (const routePrefix of [
    '/reinforce',
    '/audit',
    '/reinforcement',
    '/memory',
  ]) {
    app.use(routePrefix, boundary);
    app.use(routePrefix, reinforcementBodyParser);
  }
  app.use(express.json({ limit: '10mb' }));

  app.post('/reinforce', (_req, res) => res.status(204).end());
  app.post('/audit', (_req, res) => res.status(204).end());
  app.post('/reinforcement/judge', (_req, res) => res.status(204).end());
  app.get('/memory', (_req, res) => res.json({ route: 'memory' }));
  app.get('/memory/digest', (_req, res) => res.json({ route: 'digest' }));
  app.get(
    '/reinforcement/metrics',
    (_req, res) => res.json({ route: 'metrics' })
  );
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/memorable', (_req, res) => res.status(204).end());
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

function authenticatedRequest(
  app: express.Express,
  method: 'get' | 'head' | 'post' | 'put',
  path: string
) {
  return request(app)
    [method](path)
    .set('Authorization', `Bearer ${controlPlaneToken}`);
}

describe('reinforcement HTTP ingress boundary', () => {
  beforeEach(() => {
    configureControlPlane();
  });

  it('authenticates before parsing malformed or oversized feedback', async () => {
    const app = buildApp();
    const malformedResponse = await request(app)
      .post('/audit')
      .set('Content-Type', 'application/json')
      .send('{"prompt":');
    const oversizedResponse = await request(app)
      .post('/reinforce')
      .send({
        context: 'x'.repeat(REINFORCE_BODY_LIMIT_BYTES),
      });

    expect(malformedResponse.status).toBe(401);
    expect(malformedResponse.body.error.code).toBe(
      'CONTROL_PLANE_AUTH_REQUIRED'
    );
    expect(malformedResponse.body.code).not.toBe('BROAD_PARSER_REJECTED');
    expect(oversizedResponse.status).toBe(401);
    expect(oversizedResponse.body.error.code).toBe(
      'CONTROL_PLANE_AUTH_REQUIRED'
    );
  });

  it('fails closed when control-plane authentication is unavailable', async () => {
    clearPurposeBoundCredentialEnvironment();

    const response = await request(buildApp()).get('/memory');

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe(
      'CONTROL_PLANE_AUTH_UNAVAILABLE'
    );
  });

  it('keeps invalid bearer traffic from exhausting authenticated ingress', async () => {
    const app = buildApp({
      maxClientRequests: 1,
      windowMs: 60_000,
    });
    const clientAddress = '198.51.100.87';

    const denied = await request(app)
      .get('/memory')
      .set('X-Forwarded-For', clientAddress)
      .set('Authorization', 'Bearer invalid-control-plane-test-token');
    const throttled = await request(app)
      .get('/memory/digest')
      .set('X-Forwarded-For', clientAddress)
      .set('Authorization', 'Bearer invalid-control-plane-test-token');
    const authenticated = await authenticatedRequest(
      app,
      'get',
      '/memory'
    ).set('X-Forwarded-For', clientAddress);

    expect(denied.status).toBe(401);
    expect(throttled.status).toBe(429);
    expect(authenticated.status).toBe(200);
  });

  it('separates read and mutation scopes', async () => {
    configureControlPlane('arcanos:read');
    const readOnlyApp = buildApp();
    const readResponse = await authenticatedRequest(
      readOnlyApp,
      'get',
      '/memory/digest'
    );
    const mutationDenied = await authenticatedRequest(
      readOnlyApp,
      'post',
      '/reinforcement/judge'
    ).send({});

    expect(readResponse.status).toBe(200);
    expect(mutationDenied.status).toBe(403);
    expect(mutationDenied.body.error.code).toBe(
      'CONTROL_PLANE_SCOPE_DENIED'
    );

    configureControlPlane('mcp:invoke');
    const mutationOnlyApp = buildApp();
    const mutationResponse = await authenticatedRequest(
      mutationOnlyApp,
      'post',
      '/reinforce'
    ).send({});
    const readDenied = await authenticatedRequest(
      mutationOnlyApp,
      'get',
      '/reinforcement/metrics'
    );

    expect(mutationResponse.status).toBe(204);
    expect(readDenied.status).toBe(403);
    expect(readDenied.body.error.code).toBe('CONTROL_PLANE_SCOPE_DENIED');
  });

  it.each([
    {
      name: 'malformed JSON',
      path: '/audit',
      configure: (
        pendingRequest: ReturnType<typeof authenticatedRequest>
      ) => pendingRequest
        .set('Content-Type', 'application/json')
        .send('{"prompt":'),
      status: 400,
    },
    {
      name: 'malformed vendor JSON',
      path: '/reinforcement/judge',
      configure: (
        pendingRequest: ReturnType<typeof authenticatedRequest>
      ) => pendingRequest
        .set('Content-Type', 'application/problem+json')
        .send('{"score":'),
      status: 400,
    },
    {
      name: 'an array body',
      path: '/reinforce',
      configure: (
        pendingRequest: ReturnType<typeof authenticatedRequest>
      ) => pendingRequest.send([]),
      status: 400,
    },
    {
      name: 'compressed content',
      path: '/audit',
      configure: (
        pendingRequest: ReturnType<typeof authenticatedRequest>
      ) => pendingRequest
        .set('Content-Type', 'application/json')
        .set('Content-Encoding', 'gzip')
        .send('{}'),
      status: 415,
    },
    {
      name: 'non-JSON content',
      path: '/reinforce',
      configure: (
        pendingRequest: ReturnType<typeof authenticatedRequest>
      ) => pendingRequest
        .set('Content-Type', 'text/plain')
        .send('context=operator'),
      status: 415,
    },
    {
      name: 'an absent object body',
      path: '/audit',
      configure: (
        pendingRequest: ReturnType<typeof authenticatedRequest>
      ) => pendingRequest,
      status: 400,
    },
  ])('returns a stable parser response for $name', async ({
    path,
    configure,
    status,
  }) => {
    configureControlPlane('mcp:invoke');
    const response = await configure(
      authenticatedRequest(buildApp(), 'post', path)
    );

    expect(response.status).toBe(status);
    expect(response.body.error).toEqual({
      code: 'REINFORCEMENT_REQUEST_INVALID',
      message: 'Reinforcement request is invalid.',
    });
    expect(response.body.code).not.toBe('BROAD_PARSER_REJECTED');
  });

  it.each([
    ['/reinforce', REINFORCE_BODY_LIMIT_BYTES],
    ['/audit', REINFORCEMENT_FEEDBACK_BODY_LIMIT_BYTES],
    ['/reinforcement/judge', REINFORCEMENT_FEEDBACK_BODY_LIMIT_BYTES],
  ] as const)('applies the dedicated parser limit to %s', async (
    path,
    bodyLimit
  ) => {
    configureControlPlane('mcp:invoke');
    const response = await authenticatedRequest(buildApp(), 'post', path)
      .send({
        padding: 'x'.repeat(bodyLimit),
      });

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe(
      'REINFORCEMENT_REQUEST_INVALID'
    );
    expect(response.body.code).not.toBe('BROAD_PARSER_REJECTED');
  });

  it('parses a valid vendor JSON mutation body', async () => {
    configureControlPlane('mcp:invoke');
    const app = express();
    const boundary = createReinforcementHttpBoundary();
    app.use('/reinforce', boundary, reinforcementBodyParser);
    app.post('/reinforce', (req, res) => {
      res.json({ received: req.body });
    });
    const body = {
      context: 'vendor JSON feedback',
      bias: 'positive',
    };

    const response = await authenticatedRequest(app, 'post', '/reinforce')
      .set(
        'Content-Type',
        'application/vnd.arcanos.reinforcement+json'
      )
      .send(JSON.stringify(body));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: body });
  });

  it('rejects read bodies and preserves authenticated HEAD semantics', async () => {
    configureControlPlane('arcanos:read');
    const app = buildApp();
    const bodyResponse = await authenticatedRequest(
      app,
      'get',
      '/memory'
    ).send({ unexpected: true });
    const headResponse = await authenticatedRequest(
      app,
      'head',
      '/reinforcement/metrics'
    );

    expect(bodyResponse.status).toBe(400);
    expect(bodyResponse.body.error.code).toBe(
      'REINFORCEMENT_REQUEST_INVALID'
    );
    expect(headResponse.status).toBe(200);
    expect(headResponse.text).toBeUndefined();
    expect(headResponse.headers['cache-control']).toBe('no-store');
    expect(headResponse.headers.pragma).toBe('no-cache');
  });

  it('shares the 30-request mutation bucket across all feedback routes', async () => {
    configureControlPlane(
      'mcp:invoke',
      'operator:reinforcement-shared-mutation-limit'
    );
    const app = buildApp();
    const paths = [
      ...Array<string>(10).fill('/reinforce'),
      ...Array<string>(10).fill('/audit'),
      ...Array<string>(10).fill('/reinforcement/judge'),
    ];

    const accepted = [];
    for (const path of paths) {
      accepted.push(
        await authenticatedRequest(app, 'post', path).send({})
      );
    }
    const throttled = await authenticatedRequest(
      app,
      'post',
      '/reinforce'
    ).send({});

    expect(accepted.every((response) => response.status === 204)).toBe(true);
    expect(throttled.status).toBe(429);
  });

  it('shares the 120-request read bucket across all inspection routes', async () => {
    configureControlPlane(
      'arcanos:read',
      'operator:reinforcement-shared-read-limit'
    );
    const app = buildApp();
    const paths = [
      ...Array<string>(40).fill('/memory'),
      ...Array<string>(40).fill('/memory/digest'),
      ...Array<string>(40).fill('/reinforcement/metrics'),
    ];

    const accepted = [];
    for (const path of paths) {
      accepted.push(await authenticatedRequest(app, 'get', path));
    }
    const throttled = await authenticatedRequest(app, 'get', '/memory');

    expect(accepted.every((response) => response.status === 200)).toBe(true);
    expect(throttled.status).toBe(429);
  });

  it.each([
    ['get', '/memory/', 200],
    ['get', '/MEMORY/DIGEST', 200],
    ['get', '/reinforcement/metrics/', 200],
    ['get', '/memory//', 404],
    ['get', '/memory/unknown', 404],
    ['get', '/memory%2Fdigest', 404],
    ['put', '/memory', 404],
  ] as const)('keeps the canonical method/path boundary for %s %s', async (
    method,
    path,
    expectedStatus
  ) => {
    configureControlPlane('arcanos:read,mcp:invoke');
    const response = await authenticatedRequest(
      buildApp(),
      method,
      path
    );

    expect(response.status).toBe(expectedStatus);
  });

  it('terminates unknown protected paths without capturing public neighbors', async () => {
    const app = buildApp();
    const unknownResponse = await authenticatedRequest(
      app,
      'get',
      '/reinforcement/unknown'
    );
    const neighborResponse = await request(app).get('/memorable');
    const publicHealthResponse = await request(app).get('/health');

    expect(unknownResponse.status).toBe(404);
    expect(unknownResponse.body).toEqual({
      error: 'Route Not Found',
      code: 404,
    });
    expect(neighborResponse.status).toBe(204);
    expect(publicHealthResponse.status).toBe(200);
  });

  it('protects the legacy audit router when mounted independently', async () => {
    configureControlPlane('mcp:invoke');
    const app = express();
    app.use('/', aiEndpointsRouter);

    const anonymousResponse = await request(app)
      .post('/audit')
      .set('Content-Type', 'application/json')
      .send('{"prompt":');
    const authenticatedResponse = await authenticatedRequest(
      app,
      'post',
      '/audit'
    )
      .set('Content-Type', 'application/json')
      .send('{"prompt":');

    expect(anonymousResponse.status).toBe(401);
    expect(anonymousResponse.body.error.code).toBe(
      'CONTROL_PLANE_AUTH_REQUIRED'
    );
    expect(authenticatedResponse.status).toBe(400);
    expect(authenticatedResponse.body.error.code).toBe(
      'REINFORCEMENT_REQUEST_INVALID'
    );
  });

  it('mounts the shared boundary and parsers before CORS and broad parsing', () => {
    const appSource = readFileSync(
      new URL('../src/app.ts', import.meta.url),
      'utf8'
    );
    const reinforcementSource = readFileSync(
      new URL('../src/routes/reinforcement.ts', import.meta.url),
      'utf8'
    );
    const legacyAuditSource = readFileSync(
      new URL('../src/routes/ai-endpoints.ts', import.meta.url),
      'utf8'
    );
    const boundaryIndex = appSource.indexOf(
      "app.use('/reinforce', reinforcementHttpBoundary)"
    );
    const bodyParserIndex = appSource.indexOf(
      "app.use('/reinforce', reinforcementBodyParser)"
    );
    const corsIndex = appSource.indexOf('app.use(cors(config.cors))');
    const broadParserIndex = appSource.indexOf(
      'app.use(express.json({ limit: config.limits.jsonLimit }))'
    );

    expect(boundaryIndex).toBeGreaterThan(-1);
    expect(bodyParserIndex).toBeGreaterThan(boundaryIndex);
    expect(bodyParserIndex).toBeLessThan(corsIndex);
    expect(bodyParserIndex).toBeLessThan(broadParserIndex);
    expect(reinforcementSource).toContain(
      "router.use('/reinforce', reinforcementHttpBoundary, reinforcementBodyParser)"
    );
    expect(legacyAuditSource).toContain(
      "router.use('/audit', reinforcementHttpBoundary, reinforcementBodyParser)"
    );
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
