import express from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it } from '@jest/globals';

import sdkRouter from '../src/routes/sdk/index.js';
import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const controlPlaneAccessToken = 'sdk-route-control-token-1234567890';
const originalCredentialEnvironment = new Map(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
    (environmentName) => [environmentName, process.env[environmentName]] as const
  )
);
const originalPrincipalId = process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
const originalScopes = process.env.ARCANOS_CONTROL_PLANE_SCOPES;
let principalCounter = 0;

function clearPurposeBoundCredentialEnvironment(): void {
  for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[environmentName];
  }
}

function configureControlPlane(scopes: string): void {
  principalCounter += 1;
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneAccessToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID =
    `operator:sdk-route-${principalCounter}`;
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = scopes;
}

function buildApp(): express.Express {
  const app = express();
  app.use('/sdk', sdkRouter);
  return app;
}

describe('SDK route security', () => {
  it('rejects a confirmed mutation without caller authentication', async () => {
    configureControlPlane('mcp:invoke');

    const response = await request(buildApp())
      .post('/sdk/workers/init')
      .set('X-Confirmed', 'yes')
      .send({});

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
  });

  it('requires mcp:invoke before issuing a confirmation challenge', async () => {
    configureControlPlane('arcanos:read');
    const scopeDeniedResponse = await request(buildApp())
      .post('/sdk/workers/init')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`)
      .set('X-Confirmed', 'yes')
      .send({});

    expect(scopeDeniedResponse.status).toBe(403);
    expect(scopeDeniedResponse.body.error.code).toBe(
      'CONTROL_PLANE_SCOPE_DENIED'
    );

    configureControlPlane('mcp:invoke');
    const confirmationResponse = await request(buildApp())
      .post('/sdk/workers/init')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`)
      .send({});

    expect(confirmationResponse.status).toBe(403);
    expect(confirmationResponse.body.confirmationRequired).toBe(true);
  });

  it('protects worker status with arcanos:read and no-store headers', async () => {
    configureControlPlane('mcp:invoke');
    const deniedResponse = await request(buildApp())
      .get('/sdk/workers/status')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`);

    expect(deniedResponse.status).toBe(403);

    configureControlPlane('arcanos:read');
    const allowedResponse = await request(buildApp())
      .get('/sdk/workers/status')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`);

    expect(allowedResponse.status).toBe(200);
    expect(allowedResponse.headers['cache-control']).toBe('no-store');
    expect(allowedResponse.body.success).toBe(true);
  });

  it('terminates authenticated unknown SDK paths', async () => {
    configureControlPlane('arcanos:read');
    const response = await request(buildApp())
      .get('/sdk/unknown')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`);

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: 'Route Not Found',
      code: 404,
    });
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
