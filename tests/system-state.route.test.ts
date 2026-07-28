import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach } from '@jest/globals';

import { recordChatIntent } from '../src/routes/ask/intent_store.js';
import systemStateRouter from '../src/routes/system-state.js';
import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const controlPlaneToken = 'system-state-route-control-token-1234567890';
const originalCredentialEnvironment = new Map(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
    (environmentName) => [environmentName, process.env[environmentName]] as const
  )
);
const originalPrincipalId = process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
const originalScopes = process.env.ARCANOS_CONTROL_PLANE_SCOPES;

function configureControlPlane(scopes = 'arcanos:read,mcp:invoke'): void {
  for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[environmentName];
  }
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = 'operator:system-state-route';
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = scopes;
}

function authenticatedGet(app: express.Express) {
  return request(app)
    .get('/system-state')
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
  expect(typeof challengeId).toBe('string');

  return authenticatedPost(app)
    .set('X-Confirmed', `token:${challengeId}`)
    .send(body);
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(systemStateRouter);
  return app;
}

describe('direct system-state route', () => {
  beforeEach(() => {
    configureControlPlane();
  });

  it('fails closed when the router is mounted without a pre-parser boundary', async () => {
    const response = await request(buildApp()).get('/system-state');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
  });

  it('serves system_state through the direct endpoint', async () => {
    const response = await authenticatedGet(buildApp());

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        mode: 'system_state',
        intent: expect.objectContaining({
          version: expect.any(Number),
        }),
        routing: expect.objectContaining({
          preferred: 'backend',
        }),
      })
    );
  });

  it('applies optimistic updates without using the GPT writing route', async () => {
    const sessionId = `system-state-route-update-${Date.now()}`;
    const seeded = recordChatIntent('Seed direct system-state route test', sessionId);
    const before = await authenticatedGet(buildApp()).query({ sessionId });

    expect(before.status).toBe(200);
    expect(before.body.intent.version).toBe(seeded.version);

    const update = await challengeConfirmedPost(buildApp(), {
      sessionId,
      expectedVersion: seeded.version,
      patch: {
        status: 'active',
        phase: 'execution',
        label: 'route-direct-state',
      },
    });

    expect(update.status).toBe(200);
    expect(update.body).toEqual(
      expect.objectContaining({
        mode: 'system_state',
        intent: expect.objectContaining({
          status: 'active',
          phase: 'execution',
          label: 'route-direct-state',
        }),
      })
    );
  });

  it('returns structured errors for invalid update payloads', async () => {
    const response = await challengeConfirmedPost(
      buildApp(),
      { expectedVersion: 1 }
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: 'BAD_REQUEST',
        }),
      })
    );
  });
});

afterAll(() => {
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
