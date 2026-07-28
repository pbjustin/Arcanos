import { readFileSync } from 'node:fs';

import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';

import {
  createLegacyOperatorHttpBoundary,
} from '../src/services/controlPlane/legacyOperatorHttpBoundary.js';
import {
  legacyOperatorBodyParser,
} from '../src/services/controlPlane/legacyOperatorBodyParser.js';
import {
  confirmGate,
} from '../src/transport/http/middleware/confirmGate.js';
import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const controlPlaneAccessToken =
  'legacy-operator-control-token-1234567890';
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

function configureControlPlane(scopes = 'arcanos:read,mcp:invoke'): void {
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneAccessToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID =
    'operator:legacy-operator-test';
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = scopes;
}

function buildBoundaryApp(options: {
  resetHandler?: express.RequestHandler;
  purgeHandler?: express.RequestHandler;
  sdkSystemTestHandler?: express.RequestHandler;
} = {}): express.Express {
  const app = express();
  const boundary = createLegacyOperatorHttpBoundary({
    maxClientRequests: 30,
    windowMs: 60_000,
  });
  for (const routePath of [
    '/sdk',
    '/orchestration/reset',
    '/orchestration/purge',
    '/orchestration/status',
  ]) {
    app.use(routePath, boundary);
  }
  for (const routePath of [
    '/sdk',
    '/orchestration/reset',
    '/orchestration/purge',
  ]) {
    app.use(routePath, legacyOperatorBodyParser);
  }
  app.use(express.json({ limit: '10mb' }));
  app.post(
    '/orchestration/reset',
    boundary,
    confirmGate,
    options.resetHandler ?? ((_req, res) => res.status(204).end())
  );
  app.post(
    '/orchestration/purge',
    boundary,
    confirmGate,
    options.purgeHandler ?? ((_req, res) => res.status(204).end())
  );
  app.get(
    '/orchestration/status',
    boundary,
    (_req, res) => res.status(204).end()
  );
  app.get('/sdk/diagnostics', boundary, (_req, res) => res.status(204).end());
  app.post(
    '/sdk/system-test',
    boundary,
    confirmGate,
    options.sdkSystemTestHandler ?? ((_req, res) => res.status(204).end())
  );
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

function authenticatedPost(
  app: express.Express,
  routePath: string
) {
  return request(app)
    .post(routePath)
    .set('Authorization', `Bearer ${controlPlaneAccessToken}`);
}

describe('legacy operator HTTP ingress boundary', () => {
  beforeEach(() => {
    configureControlPlane();
  });

  it('treats confirmation without authentication as unauthorized', async () => {
    const response = await request(buildBoundaryApp())
      .post('/orchestration/reset')
      .set('X-Confirmed', 'yes')
      .set('Content-Type', 'application/json')
      .send('{"agentId":');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(response.body.code).not.toBe('BROAD_PARSER_REJECTED');
  });

  it('fails closed when control-plane configuration is unavailable', async () => {
    clearPurposeBoundCredentialEnvironment();
    const response = await request(buildBoundaryApp())
      .get('/sdk/diagnostics');

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_UNAVAILABLE');
  });

  it('uses arcanos:read for reads and mcp:invoke for mutations', async () => {
    configureControlPlane('arcanos:read');
    const readOnlyApp = buildBoundaryApp();
    const readResponse = await request(readOnlyApp)
      .get('/sdk/diagnostics')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`);
    const mutationDeniedResponse = await authenticatedPost(
      readOnlyApp,
      '/sdk/system-test'
    )
      .set('X-Confirmed', 'yes')
      .send({});

    expect(readResponse.status).toBe(204);
    expect(mutationDeniedResponse.status).toBe(403);
    expect(mutationDeniedResponse.body.error.code).toBe(
      'CONTROL_PLANE_SCOPE_DENIED'
    );

    configureControlPlane('mcp:invoke');
    const mutationResponse = await authenticatedPost(
      buildBoundaryApp(),
      '/sdk/system-test'
    )
      .set('X-Confirmed', 'yes')
      .send({});
    expect(mutationResponse.status).toBe(204);
  });

  it('retains confirmation as a second authorization step', async () => {
    configureControlPlane('mcp:invoke');
    const response = await authenticatedPost(
      buildBoundaryApp(),
      '/orchestration/reset'
    ).send({
      agentId: 'operator',
      sessionId: 'session',
    });

    expect(response.status).toBe(403);
    expect(response.body.confirmationRequired).toBe(true);
    expect(response.headers['x-confirmation-status']).toBe('pending');
  });

  it('returns a stable parser error after valid authentication', async () => {
    configureControlPlane('mcp:invoke');
    const response = await authenticatedPost(
      buildBoundaryApp(),
      '/sdk/system-test'
    )
      .set('X-Confirmed', 'yes')
      .set('Content-Type', 'application/json')
      .send('{"malformed":');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('LEGACY_OPERATOR_REQUEST_INVALID');
    expect(response.body.code).not.toBe('BROAD_PARSER_REJECTED');
  });

  it('shares one single-flight lock across reset and purge aliases', async () => {
    let releaseReset: (() => void) | undefined;
    let markResetStarted: (() => void) | undefined;
    const resetStarted = new Promise<void>((resolve) => {
      markResetStarted = resolve;
    });
    const resetRelease = new Promise<void>((resolve) => {
      releaseReset = resolve;
    });
    const app = buildBoundaryApp({
      resetHandler: async (_req, res) => {
        markResetStarted?.();
        await resetRelease;
        res.status(204).end();
      },
    });

    const firstResponsePromise = authenticatedPost(
      app,
      '/orchestration/reset'
    )
      .set('X-Confirmed', 'yes')
      .send({})
      .then((response) => response);
    await resetStarted;

    const concurrentResponse = await authenticatedPost(
      app,
      '/orchestration/purge'
    )
      .set('X-Confirmed', 'yes')
      .send({});

    expect(concurrentResponse.status).toBe(409);
    expect(concurrentResponse.body.error.code).toBe(
      'LEGACY_OPERATOR_OPERATION_IN_PROGRESS'
    );

    releaseReset?.();
    expect((await firstResponsePromise).status).toBe(204);
  });

  it('authenticates and terminates unknown SDK subpaths', async () => {
    const response = await authenticatedPost(
      buildBoundaryApp(),
      '/sdk/unknown'
    )
      .set('X-Confirmed', 'yes')
      .set('Content-Type', 'application/json')
      .send('{"malformed":');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: 'Route Not Found',
      code: 404,
    });
  });

  it('mounts identity and scope checks before parsing and confirmation', () => {
    const appSource = readFileSync(
      new URL('../src/app.ts', import.meta.url),
      'utf8'
    );
    const sdkSource = readFileSync(
      new URL('../src/routes/sdk/index.ts', import.meta.url),
      'utf8'
    );
    const orchestrationSource = readFileSync(
      new URL('../src/routes/orchestration.ts', import.meta.url),
      'utf8'
    );
    const parserIndex = appSource.indexOf(
      'app.use(express.json({ limit: config.limits.jsonLimit }))'
    );

    for (const routePath of [
      '/sdk',
      '/orchestration/reset',
      '/orchestration/purge',
      '/orchestration/status',
    ]) {
      const boundaryIndex = appSource.indexOf(
        `app.use('${routePath}', legacyOperatorHttpBoundary)`
      );
      expect(boundaryIndex).toBeGreaterThan(-1);
      expect(boundaryIndex).toBeLessThan(parserIndex);
    }
    expect(sdkSource.indexOf(
      'router.use(legacyOperatorHttpBoundary)'
    )).toBeLessThan(sdkSource.indexOf("router.use('/', researchRouter)"));
    const resetRouteIndex = orchestrationSource.indexOf(
      "'/orchestration/reset'"
    );
    const resetBoundaryIndex = orchestrationSource.indexOf(
      'legacyOperatorHttpBoundary',
      resetRouteIndex
    );
    const resetConfirmationIndex = orchestrationSource.indexOf(
      'confirmGate',
      resetRouteIndex
    );
    expect(resetBoundaryIndex).toBeGreaterThan(resetRouteIndex);
    expect(resetBoundaryIndex).toBeLessThan(resetConfirmationIndex);
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
