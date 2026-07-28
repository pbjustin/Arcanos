import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import safetyRouter from '../src/routes/safety.js';
import {
  selfHealingControlBodyParser,
} from '../src/services/controlPlane/selfHealingControlBodyParser.js';
import {
  selfHealingControlHttpBoundary,
} from '../src/services/controlPlane/selfHealingControlHttpBoundary.js';
import {
  getActiveQuarantines,
  registerQuarantine,
  resetSafetyRuntimeStateForTests,
} from '../src/services/safety/runtimeState.js';
import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const controlPlaneAccessToken = 'safety-control-auth-token-1234567890';
const originalCredentialEnvironment = new Map(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
    (environmentName) => [environmentName, process.env[environmentName]] as const
  )
);
const originalPrincipalId = process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
const originalScopes = process.env.ARCANOS_CONTROL_PLANE_SCOPES;
let principalSequence = 0;

function clearPurposeBoundCredentialEnvironment(): void {
  for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[environmentName];
  }
}

function configureControlPlane(scopes = 'self-improve:control'): string {
  clearPurposeBoundCredentialEnvironment();
  principalSequence += 1;
  const principalId = `operator:safety-control:${principalSequence}`;
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneAccessToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = principalId;
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = scopes;
  return principalId;
}

function buildApp(): express.Express {
  const app = express();
  app.use('/status/safety/quarantine', selfHealingControlHttpBoundary);
  app.use('/status/safety/quarantine', selfHealingControlBodyParser);
  app.use(express.json());
  app.use(safetyRouter);
  return app;
}

function bearer(requestBuilder: request.Test): request.Test {
  return requestBuilder.set(
    'Authorization',
    `Bearer ${controlPlaneAccessToken}`
  );
}

function registerIntegrityQuarantine() {
  return registerQuarantine({
    kind: 'integrity',
    reason: 'test integrity quarantine',
    integrityFailure: true,
    autoRecoverable: false,
  });
}

describe('safety quarantine control authentication', () => {
  beforeEach(() => {
    configureControlPlane();
    resetSafetyRuntimeStateForTests();
  });

  afterEach(() => {
    resetSafetyRuntimeStateForTests();
  });

  it('requires configured bearer identity before deterministic confirmation', async () => {
    const quarantine = registerIntegrityQuarantine();
    const response = await request(buildApp())
      .post(`/status/safety/quarantine/${quarantine.quarantineId}/release`)
      .send({ confirmation: `release:${quarantine.quarantineId}` });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(getActiveQuarantines()).toHaveLength(1);
  });

  it('fails closed when control-plane authentication is unavailable', async () => {
    const quarantine = registerIntegrityQuarantine();
    delete process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN;

    const response = await request(buildApp())
      .post(`/status/safety/quarantine/${quarantine.quarantineId}/release`)
      .send({ confirmation: `release:${quarantine.quarantineId}` });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_UNAVAILABLE');
    expect(getActiveQuarantines()).toHaveLength(1);
  });

  it('requires the self-improve control scope', async () => {
    configureControlPlane('arcanos:read');
    const quarantine = registerIntegrityQuarantine();

    const response = await bearer(
      request(buildApp())
        .post(`/status/safety/quarantine/${quarantine.quarantineId}/release`)
    ).send({ confirmation: `release:${quarantine.quarantineId}` });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('CONTROL_PLANE_SCOPE_DENIED');
    expect(getActiveQuarantines()).toHaveLength(1);
  });

  it('keeps confirmation as a second gate and rejects unknown body fields', async () => {
    const quarantine = registerIntegrityQuarantine();
    const path = `/status/safety/quarantine/${quarantine.quarantineId}/release`;

    const unconfirmed = await bearer(request(buildApp()).post(path)).send({});
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.body.error).toBe('CONFIRMATION_REQUIRED');

    const unknownField = await bearer(request(buildApp()).post(path)).send({
      confirmation: `release:${quarantine.quarantineId}`,
      notee: 'typo',
    });
    expect(unknownField.status).toBe(400);
    expect(unknownField.body.error).toBe('INVALID_SAFETY_RELEASE_PAYLOAD');
    expect(getActiveQuarantines()).toHaveLength(1);
  });

  it('attributes an integrity release to the server-owned principal', async () => {
    const principalId = configureControlPlane();
    const quarantine = registerIntegrityQuarantine();

    const response = await bearer(
      request(buildApp())
        .post(`/status/safety/quarantine/${quarantine.quarantineId}/release`)
    ).send({
      confirmation: `release:${quarantine.quarantineId}`,
      note: 'verified operator recovery',
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      released: true,
      quarantineId: quarantine.quarantineId,
      releasedBy: principalId,
    });
    expect(getActiveQuarantines()).toHaveLength(0);
  });

  it('does not release a non-integrity quarantine', async () => {
    const quarantine = registerQuarantine({
      kind: 'worker',
      reason: 'worker recovery remains automatic',
      integrityFailure: false,
      autoRecoverable: true,
    });

    const response = await bearer(
      request(buildApp())
        .post(`/status/safety/quarantine/${quarantine.quarantineId}/release`)
    ).set('x-confirmed', 'yes').send({});

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('INTEGRITY_RELEASE_ONLY');
    expect(getActiveQuarantines()).toHaveLength(1);
  });

  it('applies the shared self-improve control principal budget', async () => {
    const app = buildApp();

    for (let index = 0; index < 10; index += 1) {
      const quarantineId = `missing-quarantine-${index}`;
      await bearer(
        request(app)
          .post(`/status/safety/quarantine/${quarantineId}/release`)
      ).send({ confirmation: `release:${quarantineId}` }).expect(404);
    }

    const exhausted = await bearer(
      request(app)
        .post('/status/safety/quarantine/missing-quarantine-10/release')
    ).send({ confirmation: 'release:missing-quarantine-10' });
    expect(exhausted.status).toBe(429);
    expect(exhausted.headers['x-ratelimit-bucket']).toBe('self-improve-control');
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
