import { readFileSync } from 'node:fs';

import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';

import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const {
  createCefHttpBoundary,
} = await import('../src/services/controlPlane/cefHttpBoundary.js');
const {
  CEF_EXECUTION_BODY_LIMIT_BYTES,
  cefBodyParser,
} = await import('../src/services/controlPlane/cefBodyParser.js');

const controlPlaneToken = 'cef-boundary-token-123456789012345678901234';
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
  principalId = 'operator:cef-boundary'
): void {
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = principalId;
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = scopes;
}

function buildApp(options: {
  maxClientRequests?: number;
  windowMs?: number;
} = {}): import('express').Express {
  const app = express();
  app.set('trust proxy', true);
  const boundary = createCefHttpBoundary({
    maxClientRequests: options.maxClientRequests ?? 100,
    windowMs: options.windowMs ?? 60_000,
  });

  for (const prefix of ['/api/commands', '/api/agent']) {
    app.use(prefix, boundary);
    app.use(prefix, cefBodyParser);
  }
  app.use(express.json({ limit: '10mb' }));
  app.get('/api/commands', (req, res) => {
    res.status(200).json({
      kind: 'commands',
      principalId: req.controlPlanePrincipal?.principalId,
    });
  });
  app.get('/api/commands/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });
  app.post('/api/commands/execute', (req, res) => {
    res.status(200).json({ kind: 'command-execution', body: req.body });
  });
  app.post('/api/agent/execute', (req, res) => {
    res.status(200).json({ kind: 'agent-execution', body: req.body });
  });
  app.post('/api/commands-neighbor', (_req, res) => {
    res.status(204).end();
  });
  app.use((
    error: unknown,
    _req: import('express').Request,
    res: import('express').Response,
    _next: import('express').NextFunction
  ) => {
    res.status((error as { status?: number }).status ?? 500).json({
      code: 'BROAD_PARSER_REJECTED',
    });
  });
  return app;
}

function authenticatedRequest(
  app: import('express').Express,
  method: 'get' | 'head' | 'post',
  path: string
) {
  return request(app)[method](path)
    .set('Authorization', `Bearer ${controlPlaneToken}`);
}

describe('CEF HTTP ingress boundary', () => {
  beforeEach(() => {
    configureControlPlane();
  });

  it('authenticates before parsing malformed or oversized execution bodies', async () => {
    const app = buildApp();
    const malformedResponse = await request(app)
      .post('/api/commands/execute')
      .set('Content-Type', 'application/json')
      .send('{"command":');
    const oversizedResponse = await request(app)
      .post('/api/agent/execute')
      .send({
        goal: 'x'.repeat(CEF_EXECUTION_BODY_LIMIT_BYTES),
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

  it('requires read scope for registry GET and HEAD, including one trailing slash', async () => {
    configureControlPlane('arcanos:read');
    const app = buildApp();

    const responses = await Promise.all([
      authenticatedRequest(app, 'get', '/api/commands'),
      authenticatedRequest(app, 'get', '/api/commands/'),
      authenticatedRequest(app, 'head', '/api/commands/health'),
      authenticatedRequest(app, 'head', '/api/commands/health/'),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      200,
      200,
      200,
      200,
    ]);
    expect(responses[0]?.body.principalId).toBe('operator:cef-boundary');
    for (const response of responses) {
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['x-ratelimit-bucket']).toBe('cef-read');
    }

    const denied = await authenticatedRequest(
      app,
      'post',
      '/api/commands/execute'
    ).send({ command: 'system:status' });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('CONTROL_PLANE_SCOPE_DENIED');
  });

  it('requires execution scope for command and agent POSTs', async () => {
    configureControlPlane('mcp:invoke');
    const app = buildApp();

    const commandResponse = await authenticatedRequest(
      app,
      'post',
      '/api/commands/execute/'
    ).send({ command: 'system:status' });
    const agentResponse = await authenticatedRequest(
      app,
      'post',
      '/api/agent/execute/'
    ).send({ goal: 'Summarize status.' });

    expect(commandResponse.status).toBe(200);
    expect(commandResponse.body.kind).toBe('command-execution');
    expect(commandResponse.headers['x-ratelimit-bucket']).toBe('cef-execution');
    expect(agentResponse.status).toBe(200);
    expect(agentResponse.body.kind).toBe('agent-execution');
    expect(agentResponse.headers['x-ratelimit-bucket']).toBe('cef-execution');

    const denied = await authenticatedRequest(app, 'get', '/api/commands');
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('CONTROL_PLANE_SCOPE_DENIED');
  });

  it('enforces strict bounded JSON after authentication', async () => {
    const app = buildApp();
    const malformedResponse = await authenticatedRequest(
      app,
      'post',
      '/api/commands/execute'
    )
      .set('Content-Type', 'application/json')
      .send('{"command":');
    const primitiveResponse = await authenticatedRequest(
      app,
      'post',
      '/api/commands/execute'
    )
      .set('Content-Type', 'application/json')
      .send('"system:status"');
    const compressedResponse = await authenticatedRequest(
      app,
      'post',
      '/api/agent/execute'
    )
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .send('compressed');
    const oversizedResponse = await authenticatedRequest(
      app,
      'post',
      '/api/agent/execute'
    ).send({
      goal: 'x'.repeat(CEF_EXECUTION_BODY_LIMIT_BYTES),
    });
    const vendorJsonResponse = await authenticatedRequest(
      app,
      'post',
      '/api/agent/execute'
    )
      .set('Content-Type', 'application/vnd.arcanos+json')
      .send(JSON.stringify({ goal: 'Summarize status.' }));

    expect(malformedResponse.status).toBe(400);
    expect(malformedResponse.body.error.code).toBe('CEF_REQUEST_INVALID');
    expect(primitiveResponse.status).toBe(400);
    expect(primitiveResponse.body.error.code).toBe('CEF_REQUEST_INVALID');
    expect(compressedResponse.status).toBe(415);
    expect(compressedResponse.body.error.code).toBe('CEF_REQUEST_INVALID');
    expect(oversizedResponse.status).toBe(413);
    expect(oversizedResponse.body.error.code).toBe('CEF_REQUEST_INVALID');
    expect(vendorJsonResponse.status).toBe(200);
  });

  it('rejects bodies on authenticated registry reads before broad parsing', async () => {
    const response = await authenticatedRequest(
      buildApp(),
      'get',
      '/api/commands'
    )
      .set('Content-Type', 'application/json')
      .send({ unexpected: 'body' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('CEF_REQUEST_INVALID');
    expect(response.body.code).not.toBe('BROAD_PARSER_REJECTED');
  });

  it('terminates unknown paths and methods with a fixed 404', async () => {
    const app = buildApp();
    const unknownPath = await authenticatedRequest(
      app,
      'get',
      '/api/commands/private'
    );
    const unknownMethod = await authenticatedRequest(
      app,
      'get',
      '/api/agent/execute'
    );
    const caseVariant = await authenticatedRequest(
      app,
      'post',
      '/API/AGENT/EXECUTE'
    ).send({ goal: 'Must not reach execution.' });
    const neighbor = await request(app).post('/api/commands-neighbor');

    expect(unknownPath.status).toBe(404);
    expect(unknownPath.body).toEqual({
      error: 'Route Not Found',
      code: 404,
    });
    expect(unknownMethod.status).toBe(404);
    expect(unknownMethod.body).toEqual({
      error: 'Route Not Found',
      code: 404,
    });
    expect(caseVariant.status).toBe(404);
    expect(caseVariant.body).toEqual({
      error: 'Route Not Found',
      code: 404,
    });
    expect(neighbor.status).toBe(204);
  });

  it('throttles invalid authentication by ingress address without charging valid principals', async () => {
    const app = buildApp({
      maxClientRequests: 1,
      windowMs: 60_000,
    });
    const firstInvalid = await request(app).get('/api/commands');
    const secondInvalid = await request(app).get('/api/commands');
    const valid = await authenticatedRequest(app, 'get', '/api/commands');

    expect(firstInvalid.status).toBe(401);
    expect(secondInvalid.status).toBe(429);
    expect(secondInvalid.headers['x-ratelimit-bucket']).toBe('cef-client');
    expect(valid.status).toBe(200);
    expect(valid.headers['x-ratelimit-bucket']).toBe('cef-read');
  });

  it('mounts authentication and bounded parsing before the broad parser', () => {
    const appSource = readFileSync(
      new URL('../src/app.ts', import.meta.url),
      'utf8'
    );
    const boundaryIndex = appSource.indexOf(
      "app.use('/api/commands', cefHttpBoundary)"
    );
    const parserIndex = appSource.indexOf(
      "app.use('/api/commands', cefBodyParser)"
    );
    const broadParserIndex = appSource.indexOf(
      'app.use(express.json({ limit: config.limits.jsonLimit }))'
    );

    expect(boundaryIndex).toBeGreaterThan(-1);
    expect(parserIndex).toBeGreaterThan(boundaryIndex);
    expect(broadParserIndex).toBeGreaterThan(parserIndex);
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
