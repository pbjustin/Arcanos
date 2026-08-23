import { readFileSync } from 'node:fs';

import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';

import { recordChatIntent } from '../src/routes/ask/intent_store.js';
import systemStateRouter from '../src/routes/system-state.js';
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

const controlPlaneToken = 'system-state-boundary-token-1234567890';
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
  principalId = 'operator:system-state-boundary'
): void {
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = principalId;
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = scopes;
}

function buildApp(): express.Express {
  const app = express();
  app.set('trust proxy', true);
  const boundary = createSystemStateHttpBoundary({
    maxClientRequests: 100,
    windowMs: 60_000,
  });
  app.use('/system-state', boundary);
  app.use('/system-state', systemStateBodyParser);
  app.use(express.json({ limit: '10mb' }));
  app.use('/', systemStateRouter);
  app.get('/system-stateful', (_req, res) => res.status(204).end());
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

function authenticatedGet(app: express.Express, path = '/system-state') {
  return request(app)
    .get(path)
    .set('Authorization', `Bearer ${controlPlaneToken}`);
}

function authenticatedPost(app: express.Express) {
  return request(app)
    .post('/system-state')
    .set('Authorization', `Bearer ${controlPlaneToken}`);
}

async function challengeConfirmedPost(
  app: express.Express,
  body: Record<string, unknown>
) {
  const pendingResponse = await authenticatedPost(app).send(body);
  const challengeId = pendingResponse.headers['x-confirmation-challenge'];

  expect(pendingResponse.status).toBe(403);
  expect(pendingResponse.body.confirmationRequired).toBe(true);
  expect(typeof challengeId).toBe('string');

  return authenticatedPost(app)
    .set('X-Confirmed', `token:${challengeId}`)
    .send(body);
}

describe('system-state HTTP ingress boundary', () => {
  beforeEach(() => {
    configureControlPlane();
  });

  it('authenticates before parsing an invalid request body', async () => {
    const response = await request(buildApp())
      .post('/system-state')
      .set('X-Confirmed', 'yes')
      .set('Content-Type', 'application/json')
      .send('{"patch":');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(response.body.code).not.toBe('BROAD_PARSER_REJECTED');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('uses an explicit frozen authentication environment without mutating ambient configuration', async () => {
    configureControlPlane('arcanos:read', 'operator:ambient-read-only');
    const ambientScopes = process.env.ARCANOS_CONTROL_PLANE_SCOPES;
    const explicitToken = 'system-state-explicit-preview-token-1234567890';
    const authenticationEnvironment = Object.freeze({
      ARCANOS_CONTROL_PLANE_ACCESS_TOKEN: explicitToken,
      ARCANOS_CONTROL_PLANE_PRINCIPAL_ID: 'operator:explicit-preview',
      ARCANOS_CONTROL_PLANE_SCOPES: 'mcp:invoke',
    }) as NodeJS.ProcessEnv;
    const app = express();
    app.post('/status', createSystemStateHttpBoundary({
      authenticationEnvironment,
      maxClientRequests: 10,
      windowMs: 60_000,
    }));
    app.post('/status', systemStateBodyParser);
    app.post('/status', (_req, res) => res.status(204).end());

    const response = await request(app)
      .post('/status')
      .set('Authorization', `Bearer ${explicitToken}`)
      .send({ status: 'active' });

    expect(response.status).toBe(204);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(process.env.ARCANOS_CONTROL_PLANE_SCOPES).toBe(ambientScopes);
    expect(Object.isFrozen(authenticationEnvironment)).toBe(true);
  });

  it('authenticates before allocating an oversized request body', async () => {
    const response = await request(buildApp())
      .post('/system-state')
      .set('X-Confirmed', 'yes')
      .send({
        patch: {
          label: 'x'.repeat(SYSTEM_STATE_BODY_LIMIT_BYTES),
        },
      });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(response.body.code).not.toBe('BROAD_PARSER_REJECTED');
  });

  it('fails closed when control-plane authentication is unavailable', async () => {
    clearPurposeBoundCredentialEnvironment();

    const response = await request(buildApp()).get('/system-state');

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_UNAVAILABLE');
  });

  it('keeps invalid bearer traffic from exhausting authenticated ingress', async () => {
    const app = express();
    app.set('trust proxy', true);
    app.use('/system-state', createSystemStateHttpBoundary({
      maxClientRequests: 1,
      windowMs: 60_000,
    }));
    app.use('/', systemStateRouter);
    const clientAddress = '198.51.100.42';

    const denied = await request(app)
      .get('/system-state')
      .set('X-Forwarded-For', clientAddress)
      .set('Authorization', 'Bearer invalid-control-plane-test-token');
    const throttled = await request(app)
      .get('/system-state')
      .set('X-Forwarded-For', clientAddress)
      .set('Authorization', 'Bearer invalid-control-plane-test-token');
    const authenticated = await request(app)
      .get('/system-state')
      .set('X-Forwarded-For', clientAddress)
      .set('Authorization', `Bearer ${controlPlaneToken}`);

    expect(denied.status).toBe(401);
    expect(throttled.status).toBe(429);
    expect(authenticated.status).toBe(200);
  });

  it('separates read and mutation scopes', async () => {
    configureControlPlane('arcanos:read');
    const readOnlyApp = buildApp();
    const readResponse = await authenticatedGet(readOnlyApp);
    const mutationDenied = await authenticatedPost(readOnlyApp)
      .set('X-Confirmed', 'yes')
      .send({});

    expect(readResponse.status).toBe(200);
    expect(readResponse.body.mode).toBe('system_state');
    expect(mutationDenied.status).toBe(403);
    expect(mutationDenied.body.error.code).toBe('CONTROL_PLANE_SCOPE_DENIED');

    configureControlPlane('mcp:invoke');
    const readDenied = await authenticatedGet(buildApp());
    expect(readDenied.status).toBe(403);
    expect(readDenied.body.error.code).toBe('CONTROL_PLANE_SCOPE_DENIED');
  });

  it('principal-throttles repeated requests that fail scope authorization', async () => {
    configureControlPlane(
      'arcanos:read',
      'operator:system-state-scope-throttle'
    );
    const app = buildApp();
    const deniedResponses = [];

    for (let requestIndex = 0; requestIndex < 10; requestIndex += 1) {
      deniedResponses.push(await authenticatedPost(app).send({}));
    }
    const throttledResponse = await authenticatedPost(app).send({});

    expect(deniedResponses).toHaveLength(10);
    expect(deniedResponses.every(
      (response) => (
        response.status === 403
        && response.body.error.code === 'CONTROL_PLANE_SCOPE_DENIED'
      )
    )).toBe(true);
    expect(throttledResponse.status).toBe(429);
  });

  it('requires a principal- and body-bound one-use mutation challenge', async () => {
    const primaryPrincipal = 'operator:system-state-boundary';
    const alternatePrincipal = 'operator:system-state-alternate';
    configureControlPlane('mcp:invoke', primaryPrincipal);
    const app = buildApp();
    const originalBody = {};
    const changedBody = {
      sessionId: `system-state-challenge-${Date.now()}`,
    };
    const pendingResponse = await authenticatedPost(app)
      .set('X-Confirmed', 'yes')
      .set('X-Gpt-Id', 'trusted-system-state-client')
      .set('X-Arcanos-Confirm-Token', 'non-challenge-approval')
      .send(originalBody);
    const primaryChallengeId =
      pendingResponse.headers['x-confirmation-challenge'];

    configureControlPlane('mcp:invoke', alternatePrincipal);
    const principalMismatchResponse = await authenticatedPost(app)
      .set('X-Confirmed', `token:${primaryChallengeId}`)
      .send(originalBody);
    const alternateChallengeId =
      principalMismatchResponse.headers['x-confirmation-challenge'];
    const bodyMismatchResponse = await authenticatedPost(app)
      .set('X-Confirmed', `token:${alternateChallengeId}`)
      .send(changedBody);
    const changedBodyChallengeId =
      bodyMismatchResponse.headers['x-confirmation-challenge'];
    const confirmedResponse = await authenticatedPost(app)
      .set('X-Confirmed', `token:${changedBodyChallengeId}`)
      .send(changedBody);
    const replayResponse = await authenticatedPost(app)
      .set('X-Confirmed', `token:${changedBodyChallengeId}`)
      .send(changedBody);

    expect(pendingResponse.status).toBe(403);
    expect(pendingResponse.body.confirmationRequired).toBe(true);
    expect(pendingResponse.headers['x-confirmation-status']).toBe('pending');
    expect(typeof primaryChallengeId).toBe('string');
    expect(principalMismatchResponse.status).toBe(403);
    expect(typeof alternateChallengeId).toBe('string');
    expect(bodyMismatchResponse.status).toBe(403);
    expect(typeof changedBodyChallengeId).toBe('string');
    expect(confirmedResponse.status).toBe(200);
    expect(replayResponse.status).toBe(403);
    expect(replayResponse.body.confirmationRequired).toBe(true);
  });

  it('allows one confirmed operator mutation and preserves its response', async () => {
    configureControlPlane('mcp:invoke');
    const sessionId = `system-state-boundary-${Date.now()}`;
    const seeded = recordChatIntent('Seed boundary mutation', sessionId);

    const response = await challengeConfirmedPost(buildApp(), {
      sessionId,
      expectedVersion: seeded.version,
      patch: {
        status: 'active',
        phase: 'execution',
        label: 'boundary-confirmed',
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.intent).toEqual(expect.objectContaining({
      status: 'active',
      phase: 'execution',
      label: 'boundary-confirmed',
      version: seeded.version + 1,
    }));
  });

  it.each([
    {
      name: 'malformed JSON',
      configure: (pendingRequest: request.Test) => pendingRequest
        .set('Content-Type', 'application/json')
        .send('{"patch":'),
      status: 400,
    },
    {
      name: 'malformed vendor JSON',
      configure: (pendingRequest: request.Test) => pendingRequest
        .set('Content-Type', 'application/merge-patch+json')
        .send('{"patch":'),
      status: 400,
    },
    {
      name: 'an array body',
      configure: (pendingRequest: request.Test) => pendingRequest.send([]),
      status: 400,
    },
    {
      name: 'compressed content',
      configure: (pendingRequest: request.Test) => pendingRequest
        .set('Content-Type', 'application/json')
        .set('Content-Encoding', 'gzip')
        .send('{}'),
      status: 415,
    },
  ])('returns a stable parser response for $name', async ({
    configure,
    status,
  }) => {
    configureControlPlane('mcp:invoke');
    const response = await configure(
      authenticatedPost(buildApp()).set('X-Confirmed', 'yes')
    );

    expect(response.status).toBe(status);
    expect(response.body.error).toEqual({
      code: 'SYSTEM_STATE_REQUEST_INVALID',
      message: 'System-state request is invalid.',
    });
    expect(response.body.code).not.toBe('BROAD_PARSER_REJECTED');
  });

  it('parses and confirms valid vendor JSON instead of treating it as absent', async () => {
    configureControlPlane('mcp:invoke');
    const app = buildApp();
    const sessionId = `system-state-vendor-json-${Date.now()}`;
    const seeded = recordChatIntent('Seed vendor JSON mutation', sessionId);
    const body = {
      sessionId,
      expectedVersion: seeded.version,
      patch: {
        label: 'vendor-json-confirmed',
      },
      compatibilityMetadata: {
        nested: {
          ignored: true,
        },
      },
    };
    const serializedBody = JSON.stringify(body);
    const pendingResponse = await authenticatedPost(app)
      .set('Content-Type', 'application/merge-patch+json')
      .send(serializedBody);
    const challengeId = pendingResponse.headers['x-confirmation-challenge'];

    expect(pendingResponse.status).toBe(403);
    expect(typeof challengeId).toBe('string');

    const confirmedResponse = await authenticatedPost(app)
      .set('Content-Type', 'application/merge-patch+json')
      .set('X-Confirmed', `token:${challengeId}`)
      .send(serializedBody);

    expect(confirmedResponse.status).toBe(200);
    expect(confirmedResponse.body.intent).toEqual(expect.objectContaining({
      label: 'vendor-json-confirmed',
      version: seeded.version + 1,
    }));
  });

  it('rejects deeply nested sub-limit JSON before confirmation fingerprinting', async () => {
    configureControlPlane('mcp:invoke');
    const nestedBody = `${'{"a":'.repeat(6_000)}0${'}'.repeat(6_000)}`;
    expect(Buffer.byteLength(nestedBody, 'utf8')).toBeLessThan(
      SYSTEM_STATE_BODY_LIMIT_BYTES
    );

    const response = await authenticatedPost(buildApp())
      .set('Content-Type', 'application/json')
      .send(nestedBody);

    expect(response.status).toBe(400);
    expect(response.body.error).toEqual({
      code: 'SYSTEM_STATE_REQUEST_INVALID',
      message: 'System-state request is invalid.',
    });
    expect(response.headers['x-confirmation-challenge']).toBeUndefined();
    expect(response.body.code).not.toBe('BROAD_PARSER_REJECTED');
  });

  it('rejects an oversized body at the dedicated parser', async () => {
    configureControlPlane('mcp:invoke');
    const response = await authenticatedPost(buildApp())
      .set('X-Confirmed', 'yes')
      .send({
        patch: {
          label: 'x'.repeat(SYSTEM_STATE_BODY_LIMIT_BYTES),
        },
      });

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('SYSTEM_STATE_REQUEST_INVALID');
    expect(response.body.code).not.toBe('BROAD_PARSER_REJECTED');
  });

  it('terminates unknown protected subpaths without capturing neighbors', async () => {
    const unknownResponse = await authenticatedGet(
      buildApp(),
      '/system-state/unknown'
    );
    const neighborResponse = await request(buildApp()).get('/system-stateful');

    expect(unknownResponse.status).toBe(404);
    expect(unknownResponse.body).toEqual({
      error: 'Route Not Found',
      code: 404,
    });
    expect(neighborResponse.status).toBe(204);
  });

  it.each([
    ['GET', '/system-state/', 200],
    ['GET', '/SYSTEM-STATE', 200],
    ['PUT', '/system-state', 404],
    ['GET', '/system-state/extra', 404],
    ['GET', '/system-state%2Fextra', 404],
  ])('keeps the canonical method/path boundary for %s %s', async (
    method,
    path,
    expectedStatus
  ) => {
    const response = await request(buildApp())
      [method.toLowerCase() as 'get' | 'put'](path)
      .set('Authorization', `Bearer ${controlPlaneToken}`);

    expect(response.status).toBe(expectedStatus);
  });

  it('applies read authorization to HEAD and returns no-store metadata', async () => {
    const response = await request(buildApp())
      .head('/system-state')
      .set('Authorization', `Bearer ${controlPlaneToken}`);

    expect(response.status).toBe(200);
    expect(response.text).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
  });

  it('bounds caller-selected session identifiers without reflection', async () => {
    const sessionId = `sensitive-${'x'.repeat(100)}`;
    const response = await authenticatedGet(buildApp()).query({ sessionId });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'BAD_REQUEST',
        message: 'System-state request is invalid.',
      },
    });
    expect(response.text).not.toContain(sessionId);
  });

  it('mounts authentication and bounded parsing before the broad parser', () => {
    const appSource = readFileSync(
      new URL('../src/app.ts', import.meta.url),
      'utf8'
    );
    const boundaryIndex = appSource.indexOf(
      "app.use('/system-state', systemStateHttpBoundary)"
    );
    const bodyParserIndex = appSource.indexOf(
      "app.use('/system-state', systemStateBodyParser)"
    );
    const broadParserIndex = appSource.indexOf(
      'app.use(express.json({ limit: config.limits.jsonLimit }))'
    );

    expect(boundaryIndex).toBeGreaterThan(-1);
    expect(bodyParserIndex).toBeGreaterThan(boundaryIndex);
    expect(bodyParserIndex).toBeLessThan(broadParserIndex);
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
