import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const runPredictiveHealingDecisionMock = jest.fn();
const validateCapabilityMock = jest.fn();

jest.unstable_mockModule('@services/selfImprove/predictiveHealingService.js', () => ({
  runPredictiveHealingDecision: runPredictiveHealingDecisionMock,
}));

jest.unstable_mockModule('@services/selfHealRuntimeInspectionService.js', () => ({
  buildSelfHealEventsSnapshot: jest.fn(),
  buildSelfHealInspectionSnapshot: jest.fn(),
  buildSelfHealProviderHealthSnapshot: jest.fn(),
  buildSelfHealRuntimeSnapshot: jest.fn(),
}));

jest.unstable_mockModule('@stores/agentRegistry.js', () => ({
  validateCapability: validateCapabilityMock,
}));

const selfHealRouter = (await import('../src/routes/self-heal.js')).default;
const controlPlaneAccessToken = 'self-heal-composition-control-token-1234567890';
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

function configureControlPlane(scopes = 'self-heal:decide'): void {
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneAccessToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = 'operator:self-heal-composition-test';
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = scopes;
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(selfHealRouter);
  return app;
}

describe('self-heal authentication composition', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    configureControlPlane();
    validateCapabilityMock.mockResolvedValue(true);
    runPredictiveHealingDecisionMock.mockResolvedValue({
      decision: { action: 'observe' },
      execution: { status: 'not_required' },
    });
  });

  it('requires control-plane authentication before consulting caller-selected agent identity', async () => {
    const response = await request(buildApp())
      .post('/api/self-heal/decide')
      .set('x-agent-id', 'capable-agent')
      .send({ dryRun: true });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(validateCapabilityMock).not.toHaveBeenCalled();
    expect(runPredictiveHealingDecisionMock).not.toHaveBeenCalled();
  });

  it('retains capability authorization as a second check after bearer authentication', async () => {
    const response = await request(buildApp())
      .post('/api/self-heal/decide')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`)
      .send({ dryRun: true });

    expect(response.status).toBe(401);
    expect(response.body.error).toContain('Missing agent identity');
    expect(validateCapabilityMock).not.toHaveBeenCalled();
    expect(runPredictiveHealingDecisionMock).not.toHaveBeenCalled();
  });

  it('reaches the service only after principal, scope, and capability checks pass', async () => {
    const response = await request(buildApp())
      .post('/api/self-heal/decide')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`)
      .set('x-agent-id', 'capable-agent')
      .send({ dryRun: true });

    expect(response.status).toBe(200);
    expect(validateCapabilityMock).toHaveBeenCalledWith(
      'capable-agent',
      'self_improve_admin'
    );
    expect(runPredictiveHealingDecisionMock).toHaveBeenCalledTimes(1);
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
