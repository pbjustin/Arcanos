import { readFileSync } from 'node:fs';

import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';

import {
  createDiagnosticExecutionHttpBoundary,
} from '../src/services/controlPlane/diagnosticExecutionHttpBoundary.js';
import {
  diagnosticExecutionBodyParser,
} from '../src/services/controlPlane/diagnosticExecutionBodyParser.js';
import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const controlPlaneAccessToken =
  'diagnostic-execution-control-token-1234567890';
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

function configureControlPlane(scopes = 'diagnostics:execute,repo:verify'): void {
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneAccessToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID =
    'operator:diagnostic-execution-test';
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = scopes;
}

function buildBoundaryApp(options: {
  selfTestHandler?: express.RequestHandler;
  dailySummaryHandler?: express.RequestHandler;
  prAnalysisHandler?: express.RequestHandler;
} = {}): express.Express {
  const app = express();
  const boundary = createDiagnosticExecutionHttpBoundary({
    maxClientRequests: 20,
    windowMs: 60_000,
  });

  for (const routePath of [
    '/devops/self-test',
    '/devops/daily-summary',
    '/api/pr-analysis/analyze',
  ]) {
    app.use(routePath, boundary);
    app.use(routePath, diagnosticExecutionBodyParser);
  }
  app.use(express.json({ limit: '10mb' }));
  app.post(
    '/devops/self-test',
    options.selfTestHandler ?? ((_req, res) => res.status(204).end())
  );
  app.post(
    '/devops/daily-summary',
    options.dailySummaryHandler ?? ((_req, res) => res.status(204).end())
  );
  app.post(
    '/api/pr-analysis/analyze',
    options.prAnalysisHandler ?? ((_req, res) => res.status(204).end())
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

describe('diagnostic execution HTTP ingress boundary', () => {
  beforeEach(() => {
    configureControlPlane();
  });

  it('rejects unauthenticated malformed JSON before the broad parser', async () => {
    const response = await request(buildBoundaryApp())
      .post('/devops/self-test')
      .set('Content-Type', 'application/json')
      .send('{"baseUrl":');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(response.body.code).not.toBe('BROAD_PARSER_REJECTED');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
  });

  it('fails closed when control-plane configuration is unavailable', async () => {
    clearPurposeBoundCredentialEnvironment();
    const response = await request(buildBoundaryApp())
      .post('/devops/self-test')
      .send({});

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_UNAVAILABLE');
  });

  it('uses diagnostics:execute for DevOps and repo:verify for PR analysis', async () => {
    configureControlPlane('diagnostics:execute');
    const app = buildBoundaryApp();

    const devopsResponse = await authenticatedPost(
      app,
      '/devops/self-test'
    ).send({});
    const prDeniedResponse = await authenticatedPost(
      app,
      '/api/pr-analysis/analyze'
    ).send({});

    expect(devopsResponse.status).toBe(204);
    expect(prDeniedResponse.status).toBe(403);
    expect(prDeniedResponse.body.error.code).toBe(
      'CONTROL_PLANE_SCOPE_DENIED'
    );

    configureControlPlane('repo:verify');
    const prAllowedResponse = await authenticatedPost(
      buildBoundaryApp(),
      '/api/pr-analysis/analyze'
    ).send({});
    expect(prAllowedResponse.status).toBe(204);
  });

  it('returns a stable parser error for authenticated malformed JSON', async () => {
    const response = await authenticatedPost(
      buildBoundaryApp(),
      '/api/pr-analysis/analyze'
    )
      .set('Content-Type', 'application/json')
      .send('{"prDiff":');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe(
      'DIAGNOSTIC_EXECUTION_REQUEST_INVALID'
    );
    expect(response.body.code).not.toBe('BROAD_PARSER_REJECTED');
  });

  it('shares a single-flight lock across both DevOps operations', async () => {
    let releaseSelfTest: (() => void) | undefined;
    let markSelfTestStarted: (() => void) | undefined;
    const selfTestStarted = new Promise<void>((resolve) => {
      markSelfTestStarted = resolve;
    });
    const selfTestRelease = new Promise<void>((resolve) => {
      releaseSelfTest = resolve;
    });
    const app = buildBoundaryApp({
      selfTestHandler: async (_req, res) => {
        markSelfTestStarted?.();
        await selfTestRelease;
        res.status(204).end();
      },
    });

    const firstResponsePromise = authenticatedPost(
      app,
      '/devops/self-test'
    ).send({}).then((response) => response);
    await selfTestStarted;

    const concurrentResponse = await authenticatedPost(
      app,
      '/devops/daily-summary'
    ).send({});

    expect(concurrentResponse.status).toBe(409);
    expect(concurrentResponse.body.error.code).toBe(
      'DIAGNOSTIC_EXECUTION_IN_PROGRESS'
    );

    releaseSelfTest?.();
    expect((await firstResponsePromise).status).toBe(204);
  });

  it('authenticates and terminates unknown descendants before parsing', async () => {
    const response = await authenticatedPost(
      buildBoundaryApp(),
      '/devops/self-test/unknown'
    )
      .set('Content-Type', 'application/json')
      .send('{"malformed":');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: 'Route Not Found',
      code: 404,
    });
  });

  it('mounts exact ingress boundaries before broad JSON parsing', () => {
    const appSource = readFileSync(
      new URL('../src/app.ts', import.meta.url),
      'utf8'
    );
    const apiSource = readFileSync(
      new URL('../src/routes/api/index.ts', import.meta.url),
      'utf8'
    );
    const parserIndex = appSource.indexOf(
      'app.use(express.json({ limit: config.limits.jsonLimit }))'
    );

    for (const routePath of [
      '/devops/self-test',
      '/devops/daily-summary',
      '/api/pr-analysis/analyze',
    ]) {
      const boundaryIndex = appSource.indexOf(
        `app.use('${routePath}', diagnosticExecutionHttpBoundary)`
      );
      const bodyParserIndex = appSource.indexOf(
        `app.use('${routePath}', diagnosticExecutionBodyParser)`
      );
      expect(boundaryIndex).toBeGreaterThan(-1);
      expect(bodyParserIndex).toBeGreaterThan(boundaryIndex);
      expect(bodyParserIndex).toBeLessThan(parserIndex);
    }

    expect(apiSource.indexOf(
      "router.use('/api/pr-analysis', prAnalysisRouter)"
    )).toBeLessThan(apiSource.indexOf('router.use(memoryConsistencyGate)'));
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
