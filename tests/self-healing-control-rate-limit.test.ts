import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const runPredictiveHealingDecisionMock = jest.fn();
const buildSelfHealProviderHealthSnapshotMock = jest.fn();
const runSelfHealingLoopMock = jest.fn();
const freezeSelfImproveMock = jest.fn();
const unfreezeSelfImproveMock = jest.fn();
const setAutonomyLevelMock = jest.fn();
const getKillSwitchStatusMock = jest.fn();

jest.unstable_mockModule('@transport/http/middleware/capabilityGate.js', () => ({
  capabilityGate: () => (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => next(),
}));

jest.unstable_mockModule('@services/selfImprove/predictiveHealingService.js', () => ({
  runPredictiveHealingDecision: runPredictiveHealingDecisionMock,
}));

jest.unstable_mockModule('@services/selfHealRuntimeInspectionService.js', () => ({
  buildSelfHealEventsSnapshot: jest.fn(),
  buildSelfHealInspectionSnapshot: jest.fn(),
  buildSelfHealProviderHealthSnapshot: buildSelfHealProviderHealthSnapshotMock,
  buildSelfHealRuntimeSnapshot: jest.fn(),
}));

jest.unstable_mockModule('@services/selfImprove/selfHealingLoop.js', () => ({
  runSelfHealingLoop: runSelfHealingLoopMock,
}));

jest.unstable_mockModule('@services/incidentResponse/killSwitch.js', () => ({
  freezeSelfImprove: freezeSelfImproveMock,
  unfreezeSelfImprove: unfreezeSelfImproveMock,
  setAutonomyLevel: setAutonomyLevelMock,
  getKillSwitchStatus: getKillSwitchStatusMock,
}));

const selfHealRouter = (await import('../src/routes/self-heal.js')).default;
const selfImproveRouter = (await import('../src/routes/self-improve.js')).default;
const controlPlaneAccessToken = 'self-healing-rate-limit-token-1234567890';
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

function configureControlPlane(principalId: string): void {
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneAccessToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = principalId;
  process.env.ARCANOS_CONTROL_PLANE_SCOPES =
    'arcanos:read,self-heal:probe,self-heal:decide,self-heal:execute,self-improve:control';
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(selfHealRouter);
  app.use(selfImproveRouter);
  return app;
}

function bearer(requestBuilder: request.Test): request.Test {
  return requestBuilder.set(
    'Authorization',
    `Bearer ${controlPlaneAccessToken}`
  );
}

describe('self-healing control principal rate limits', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    runPredictiveHealingDecisionMock.mockResolvedValue({ decision: {}, execution: {} });
    runSelfHealingLoopMock.mockResolvedValue({ action: null });
    buildSelfHealProviderHealthSnapshotMock.mockResolvedValue({ status: 'ok' });
    getKillSwitchStatusMock.mockResolvedValue({
      frozen: false,
      autonomyLevel: 1,
      overrides: { freeze: null, autonomy: null },
    });
  });

  it('shares one 20-request decision budget across both decision routes', async () => {
    configureControlPlane('operator:self-healing-rate:decision');
    const app = buildApp();

    for (let index = 0; index < 10; index += 1) {
      await bearer(request(app).post('/api/self-heal/decide'))
        .send({ dryRun: true })
        .expect(200);
      await bearer(request(app).post('/api/self-improve/run'))
        .send({})
        .expect(200);
    }

    const exhausted = await bearer(request(app).post('/api/self-heal/decide'))
      .send({ dryRun: true });
    expect(exhausted.status).toBe(429);
    expect(exhausted.headers['x-ratelimit-bucket']).toBe('self-heal-decision');
  });

  it('enforces the shared 10-request self-improve control budget', async () => {
    configureControlPlane('operator:self-healing-rate:control');
    const app = buildApp();
    const paths = [
      '/api/self-improve/freeze',
      '/api/self-improve/unfreeze',
      '/api/self-improve/autonomy',
    ];

    for (let index = 0; index < 10; index += 1) {
      const path = paths[index % paths.length];
      const body = path.endsWith('/autonomy') ? { level: 1 } : {};
      await bearer(request(app).post(path)).send(body).expect(200);
    }

    const exhausted = await bearer(request(app).post('/api/self-improve/freeze'))
      .send({});
    expect(exhausted.status).toBe(429);
    expect(exhausted.headers['x-ratelimit-bucket']).toBe('self-improve-control');
  });

  it('enforces the active-provider-probe budget independently', async () => {
    configureControlPlane('operator:self-healing-rate:probe');
    const app = buildApp();

    for (let index = 0; index < 10; index += 1) {
      await bearer(request(app).get('/api/self-heal/provider-health?probe=true'))
        .expect(200);
    }

    const exhausted = await bearer(
      request(app).get('/api/self-heal/provider-health?probe=true')
    );
    expect(exhausted.status).toBe(429);
    expect(exhausted.headers['x-ratelimit-bucket']).toBe(
      'self-heal-provider-probe'
    );
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
