import { afterAll, describe, expect, it, jest } from '@jest/globals';

import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const controlPlaneToken =
  'legacy-audit-confirmation-token-1234567890';
const confirmationEnvironmentNames = [
  'ALLOW_ALL_GPTS',
  'TRUSTED_GPT_IDS',
  'ARCANOS_AUTOMATION_HEADER',
  'ARCANOS_AUTOMATION_SECRET',
] as const;
const originalCredentialEnvironment = new Map(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
    (environmentName) => [environmentName, process.env[environmentName]] as const
  )
);
const originalConfirmationEnvironment = new Map(
  confirmationEnvironmentNames.map(
    (environmentName) => [environmentName, process.env[environmentName]] as const
  )
);
const originalPrincipalId = process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
const originalScopes = process.env.ARCANOS_CONTROL_PLANE_SCOPES;

for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
  delete process.env[environmentName];
}
for (const environmentName of confirmationEnvironmentNames) {
  delete process.env[environmentName];
}
process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneToken;
process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID =
  'operator:legacy-audit-confirmation';
process.env.ARCANOS_CONTROL_PLANE_SCOPES = 'mcp:invoke';

const auditControllerMock = jest.fn(async () => undefined);

jest.unstable_mockModule(
  '@transport/http/controllers/aiController.js',
  () => ({
    default: {
      audit: auditControllerMock,
    },
  })
);

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const aiEndpointsRouter = (
  await import('../src/routes/ai-endpoints.js')
).default;

describe('legacy reinforcement audit confirmation', () => {
  it('challenges a valid authenticated audit without invoking its controller', async () => {
    const app = express();
    app.use('/', aiEndpointsRouter);

    const response = await request(app)
      .post('/audit')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .send({ prompt: 'Audit the release evidence.' });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('CONFIRMATION_REQUIRED');
    expect(response.body.confirmationRequired).toBe(true);
    expect(response.headers['x-confirmation-status']).toBe('pending');
    expect(typeof response.headers['x-confirmation-challenge']).toBe(
      'string'
    );
    expect(auditControllerMock).not.toHaveBeenCalled();
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
  for (const environmentName of confirmationEnvironmentNames) {
    delete process.env[environmentName];
  }
  for (const [environmentName, value] of originalConfirmationEnvironment) {
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
