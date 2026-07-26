import { readFileSync } from 'node:fs';

import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';

import {
  createSelfHealingControlHttpBoundary,
} from '../src/services/controlPlane/selfHealingControlHttpBoundary.js';
import {
  selfHealingControlBodyParser,
} from '../src/services/controlPlane/selfHealingControlBodyParser.js';
import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const controlPlaneAccessToken = 'self-heal-boundary-control-token-1234567890';
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

function configureControlPlane(): void {
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneAccessToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = 'operator:self-heal-boundary-test';
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = 'arcanos:read';
}

function buildBoundaryApp(options: {
  maxClientRequests?: number;
} = {}): express.Express {
  const app = express();
  const boundary = createSelfHealingControlHttpBoundary({
    maxClientRequests: options.maxClientRequests,
    windowMs: 60_000,
  });
  app.use('/api/self-heal', boundary);
  app.use('/api/self-improve', boundary);
  app.use('/status/safety/self-heal', boundary);
  app.use('/status/safety/quarantine', boundary);
  app.use('/api/self-heal/decide', selfHealingControlBodyParser);
  app.use('/api/self-improve', selfHealingControlBodyParser);
  app.use('/status/safety/quarantine', selfHealingControlBodyParser);
  app.use(express.json({ limit: '10mb' }));
  app.get('/api/self-heal/runtime', (_req, res) => res.status(204).end());
  app.post('/api/self-heal/decide', (_req, res) => res.status(204).end());
  app.post('/api/self-improve/run', (_req, res) => res.status(204).end());
  app.get('/status/safety/self-heal', (_req, res) => res.status(204).end());
  app.post(
    '/status/safety/quarantine/:quarantineId/release',
    (_req, res) => res.status(204).end()
  );
  app.use((
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    res.status((error as { status?: number }).status ?? 500).json({
      code: 'PARSER_REJECTED',
    });
  });
  return app;
}

describe('self-heal HTTP ingress boundary', () => {
  beforeEach(() => {
    configureControlPlane();
  });

  it('rejects unauthenticated malformed JSON before the broad parser runs', async () => {
    const response = await request(buildBoundaryApp())
      .post('/api/self-heal/decide')
      .set('Content-Type', 'application/json')
      .send('{"execute":true');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(response.headers['x-ratelimit-bucket']).toBe('self-heal-client');
    expect(response.body.code).not.toBe('PARSER_REJECTED');
  });

  it('protects self-improve mutation bodies before the broad parser runs', async () => {
    const response = await request(buildBoundaryApp())
      .post('/api/self-improve/run')
      .set('Content-Type', 'application/json')
      .send('{"trigger":');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(response.body.code).not.toBe('PARSER_REJECTED');
  });

  it('authenticates quarantine release before parsing its body', async () => {
    const response = await request(buildBoundaryApp())
      .post('/status/safety/quarantine/quarantine-123/release')
      .set('Content-Type', 'application/json')
      .send('{"confirmation":');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(response.body.code).not.toBe('PARSER_REJECTED');
  });

  it('applies a bounded authenticated body parser before the broad parser', async () => {
    const malformedResponse = await request(buildBoundaryApp())
      .post('/api/self-heal/decide')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`)
      .set('Content-Type', 'application/json')
      .send('{"execute":');

    expect(malformedResponse.status).toBe(400);
    expect(malformedResponse.body.error.code).toBe(
      'SELF_HEALING_CONTROL_REQUEST_INVALID'
    );

    const oversizedResponse = await request(buildBoundaryApp())
      .post('/api/self-improve/run')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`)
      .send({ context: { value: 'x'.repeat(300 * 1024) } });

    expect(oversizedResponse.status).toBe(413);
    expect(oversizedResponse.body.error.code).toBe(
      'SELF_HEALING_CONTROL_REQUEST_INVALID'
    );
  });

  it('rejects an authenticated non-JSON mutation body before handlers run', async () => {
    const response = await request(buildBoundaryApp())
      .post('/api/self-improve/run')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`)
      .set('Content-Type', 'text/plain')
      .send('trigger=manual');

    expect(response.status).toBe(415);
    expect(response.body.error.code).toBe(
      'SELF_HEALING_CONTROL_REQUEST_INVALID'
    );
  });

  it('shares a pre-auth client bucket across rotating invalid bearer values', async () => {
    const app = buildBoundaryApp({ maxClientRequests: 2 });
    const responses = [];
    const paths = [
      '/api/self-heal/runtime',
      '/api/self-improve/status',
      '/status/safety/self-heal',
    ];

    for (const [index, suffix] of ['one', 'two', 'three'].entries()) {
      responses.push(await request(app)
        .get(paths[index])
        .set('Authorization', `Bearer test-invalid-self-heal-token-${suffix}-1234567890`)
        .set('X-Forwarded-For', `203.0.113.${index + 1}`));
    }

    expect(responses.map((response) => response.status)).toEqual([401, 401, 429]);
    expect(responses[2].headers['x-ratelimit-bucket']).toBe('self-heal-client');
    expect(JSON.stringify(responses.map((response) => response.body))).not.toContain(
      'invalid-self-heal-token'
    );
  });

  it('accepts case-insensitive and trailing-slash forms that Express routes accept', async () => {
    const response = await request(buildBoundaryApp())
      .get('/API/SELF-HEAL/RUNTIME/')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`);

    expect(response.status).toBe(204);
  });

  it('counts an app and router boundary composition only once per request', async () => {
    const app = express();
    const boundary = createSelfHealingControlHttpBoundary({
      maxClientRequests: 1,
      windowMs: 60_000,
    });
    app.use('/api/self-heal', boundary);
    app.use('/api/self-heal', boundary);
    app.get('/api/self-heal/runtime', (_req, res) => res.status(204).end());

    const firstResponse = await request(app)
      .get('/api/self-heal/runtime')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`);
    const secondResponse = await request(app)
      .get('/api/self-heal/runtime')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`);

    expect(firstResponse.status).toBe(204);
    expect(secondResponse.status).toBe(429);
  });

  it('terminates authenticated unknown namespace paths before downstream parsing', async () => {
    const response = await request(buildBoundaryApp())
      .post('/api/self-heal/unknown')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`)
      .set('Content-Type', 'application/json')
      .send('{"malformed":');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: 'Route Not Found',
      code: 404,
    });

    const selfImproveResponse = await request(buildBoundaryApp())
      .post('/api/self-improve/unknown')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`)
      .set('Content-Type', 'application/json')
      .send('{"malformed":');

    expect(selfImproveResponse.status).toBe(404);
    expect(selfImproveResponse.body).toEqual({
      error: 'Route Not Found',
      code: 404,
    });

    const safetyControlResponse = await request(buildBoundaryApp())
      .post('/status/safety/quarantine/quarantine-123/release/extra')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`)
      .send({});

    expect(safetyControlResponse.status).toBe(404);
    expect(safetyControlResponse.body).toEqual({
      error: 'Route Not Found',
      code: 404,
    });
  });

  it('mounts ingress before global parsing and handlers before the writing-plane API router', () => {
    const appSource = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8');
    const registerSource = readFileSync(new URL('../src/routes/register.ts', import.meta.url), 'utf8');

    const parserIndex = appSource.indexOf(
      'app.use(express.json({ limit: config.limits.jsonLimit }))'
    );
    for (const prefix of [
      '/api/self-heal',
      '/api/self-improve',
      '/status/safety/self-heal',
      '/status/safety/quarantine',
    ]) {
      const mountIndex = appSource.indexOf(
        `app.use('${prefix}', selfHealingControlHttpBoundary)`
      );
      expect(mountIndex).toBeGreaterThan(-1);
      expect(mountIndex).toBeLessThan(parserIndex);
    }
    for (const prefix of [
      '/api/self-heal/decide',
      '/api/self-improve',
      '/status/safety/quarantine',
    ]) {
      const boundedParserIndex = appSource.indexOf(
        `app.use('${prefix}', selfHealingControlBodyParser)`
      );
      expect(boundedParserIndex).toBeGreaterThan(-1);
      expect(boundedParserIndex).toBeLessThan(parserIndex);
    }
    expect(registerSource.indexOf("app.use('/', selfHealRouter)")).toBeGreaterThan(-1);
    expect(registerSource.indexOf("app.use('/', selfHealRouter)")).toBeLessThan(
      registerSource.indexOf("app.use('/', apiRouter)")
    );
    const selfImproveMountIndex = registerSource.indexOf(
      "app.use('/', selfImproveRouter)"
    );
    expect(selfImproveMountIndex).toBeGreaterThan(-1);
    expect(selfImproveMountIndex).toBeLessThan(registerSource.indexOf("app.use('/', apiRouter)"));
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
