import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import safetyRouter from '../src/routes/safety.js';
import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

function createSafetyApp() {
  const app = express();
  app.use(express.json());
  app.use(safetyRouter);
  return app;
}

describe('operator auth diagnostics', () => {
  const originalAdminKey = process.env.ADMIN_KEY;
  const originalCredentialEnvironment = new Map(
    PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
      (environmentName) => [environmentName, process.env[environmentName]] as const
    )
  );
  const originalPrincipalId = process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
  const originalScopes = process.env.ARCANOS_CONTROL_PLANE_SCOPES;
  const controlPlaneAccessToken =
    'operator-auth-diagnostics-control-token-1234567890';

  beforeEach(() => {
    for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
      delete process.env[environmentName];
    }
    process.env.ADMIN_KEY = 'test-admin-key';
    process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneAccessToken;
    process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID =
      'operator:auth-diagnostics-test';
    process.env.ARCANOS_CONTROL_PLANE_SCOPES =
      'arcanos:read,self-improve:control';
  });

  afterAll(() => {
    if (originalAdminKey === undefined) {
      delete process.env.ADMIN_KEY;
    } else {
      process.env.ADMIN_KEY = originalAdminKey;
    }
    for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
      delete process.env[environmentName];
    }
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

  it('returns public operator auth diagnostics without credentials', async () => {
    const app = createSafetyApp();

    const response = await request(app).get('/status/safety/operator-auth');
    expect(response.status).toBe(200);
    expect(response.body?.status).toBe('ok');
    expect(response.body?.operatorAuth?.required).toBe(false);
    expect(response.body?.operatorAuth?.mode).toBe('disabled');
    expect(response.body?.operatorAuth?.configured).toBe(false);
    expect(response.body?.operatorAuth?.acceptedCredentials).toEqual([]);
    expect(response.body?.controlPlaneAuth).toMatchObject({
      required: true,
      mode: 'purpose-bound-bearer',
      acceptedCredentials: [
        'Authorization: Bearer <ARCANOS_CONTROL_PLANE_ACCESS_TOKEN>'
      ],
      protectedEndpoints: [
        'GET /status/safety/self-heal',
        'POST /status/safety/quarantine/:quarantineId/release'
      ]
    });
    expect(typeof response.body?.controlPlaneAuth?.configured).toBe('boolean');
  });

  it('rejects release without a bearer even when deterministic confirmation is provided', async () => {
    const app = createSafetyApp();

    const response = await request(app)
      .post('/status/safety/quarantine/example/release')
      .send({ confirmation: 'release:example' });

    expect(response.status).toBe(401);
    expect(response.body?.error?.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
  });

  it('remains disabled when ADMIN_KEY is not configured', async () => {
    delete process.env.ADMIN_KEY;
    const app = createSafetyApp();

    const diagnosticsResponse = await request(app).get('/status/safety/operator-auth');
    expect(diagnosticsResponse.status).toBe(200);
    expect(diagnosticsResponse.body?.operatorAuth?.required).toBe(false);
    expect(diagnosticsResponse.body?.operatorAuth?.mode).toBe('disabled');
    expect(diagnosticsResponse.body?.operatorAuth?.configured).toBe(false);

    const releaseResponse = await request(app)
      .post('/status/safety/quarantine/example/release')
      .send({ confirmation: 'release:example' });

    expect(releaseResponse.status).toBe(401);
    expect(releaseResponse.body?.error?.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
  });
});
