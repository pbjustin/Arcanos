import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const runSelfHealingLoopMock = jest.fn();
const freezeSelfImproveMock = jest.fn();
const unfreezeSelfImproveMock = jest.fn();
const setAutonomyLevelMock = jest.fn();
const getKillSwitchStatusMock = jest.fn();
const validateCapabilityMock = jest.fn();

jest.unstable_mockModule('@services/selfImprove/selfHealingLoop.js', () => ({
  runSelfHealingLoop: runSelfHealingLoopMock,
}));

jest.unstable_mockModule('@services/incidentResponse/killSwitch.js', () => ({
  freezeSelfImprove: freezeSelfImproveMock,
  unfreezeSelfImprove: unfreezeSelfImproveMock,
  setAutonomyLevel: setAutonomyLevelMock,
  getKillSwitchStatus: getKillSwitchStatusMock,
}));

jest.unstable_mockModule('@stores/agentRegistry.js', () => ({
  validateCapability: validateCapabilityMock,
}));

const selfImproveRouter = (await import('../src/routes/self-improve.js')).default;
const controlPlaneAccessToken = 'self-improve-composition-token-1234567890';
const automationSecret = 'self-improve-automation-secret-1234567890';
const originalCredentialEnvironment = new Map(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
    (environmentName) => [environmentName, process.env[environmentName]] as const
  )
);
const originalPrincipalId = process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
const originalScopes = process.env.ARCANOS_CONTROL_PLANE_SCOPES;
const originalAutomationHeader = process.env.ARCANOS_AUTOMATION_HEADER;
let principalSequence = 0;

function clearPurposeBoundCredentialEnvironment(): void {
  for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[environmentName];
  }
}

function configureControlPlane(
  scopes = 'arcanos:read,self-heal:decide,self-heal:execute,self-improve:control'
): void {
  clearPurposeBoundCredentialEnvironment();
  principalSequence += 1;
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneAccessToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID =
    `operator:self-improve-composition:${principalSequence}`;
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = scopes;
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(selfImproveRouter);
  return app;
}

describe('self-improve authentication composition', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    configureControlPlane();
    validateCapabilityMock.mockResolvedValue(true);
    runSelfHealingLoopMock.mockResolvedValue({ action: null });
    getKillSwitchStatusMock.mockResolvedValue({
      frozen: false,
      autonomyLevel: 1,
      overrides: { freeze: null, autonomy: null },
    });
  });

  it('authenticates before consulting caller-selected capability identity', async () => {
    const cases = [
      { method: 'get', path: '/api/self-improve/status' },
      { method: 'post', path: '/api/self-improve/run', body: {} },
      { method: 'post', path: '/api/self-improve/freeze', body: {} },
      { method: 'post', path: '/api/self-improve/unfreeze', body: {} },
      { method: 'post', path: '/api/self-improve/autonomy', body: { level: 1 } },
    ] as const;

    for (const testCase of cases) {
      const pendingRequest = testCase.method === 'get'
        ? request(buildApp()).get(testCase.path)
        : request(buildApp()).post(testCase.path).send(testCase.body);
      const response = await pendingRequest.set('x-agent-id', 'capable-agent');
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    }

    expect(validateCapabilityMock).not.toHaveBeenCalled();
    expect(runSelfHealingLoopMock).not.toHaveBeenCalled();
    expect(getKillSwitchStatusMock).not.toHaveBeenCalled();
    expect(freezeSelfImproveMock).not.toHaveBeenCalled();
    expect(unfreezeSelfImproveMock).not.toHaveBeenCalled();
    expect(setAutonomyLevelMock).not.toHaveBeenCalled();
  });

  it('does not allow the automation capability bypass to replace bearer identity', async () => {
    process.env.ARCANOS_AUTOMATION_SECRET = automationSecret;
    process.env.ARCANOS_AUTOMATION_HEADER = 'x-arcanos-automation';

    const response = await request(buildApp())
      .post('/api/self-improve/run')
      .set('x-arcanos-automation', automationSecret)
      .send({});

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(runSelfHealingLoopMock).not.toHaveBeenCalled();
  });

  it('checks every route scope before the capability gate', async () => {
    const cases = [
      { method: 'get', path: '/api/self-improve/status', scopes: '' },
      {
        method: 'post',
        path: '/api/self-improve/run',
        scopes: 'self-heal:decide',
        body: {},
      },
      { method: 'post', path: '/api/self-improve/freeze', scopes: '', body: {} },
      { method: 'post', path: '/api/self-improve/unfreeze', scopes: '', body: {} },
      {
        method: 'post',
        path: '/api/self-improve/autonomy',
        scopes: '',
        body: { level: 1 },
      },
    ] as const;

    for (const testCase of cases) {
      configureControlPlane(testCase.scopes);
      const pendingRequest = testCase.method === 'get'
        ? request(buildApp()).get(testCase.path)
        : request(buildApp()).post(testCase.path).send(testCase.body);
      const response = await pendingRequest
        .set('Authorization', `Bearer ${controlPlaneAccessToken}`)
        .set('x-agent-id', 'capable-agent');
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('CONTROL_PLANE_SCOPE_DENIED');
    }

    expect(validateCapabilityMock).not.toHaveBeenCalled();
    expect(runSelfHealingLoopMock).not.toHaveBeenCalled();
    expect(getKillSwitchStatusMock).not.toHaveBeenCalled();
    expect(freezeSelfImproveMock).not.toHaveBeenCalled();
    expect(unfreezeSelfImproveMock).not.toHaveBeenCalled();
    expect(setAutonomyLevelMock).not.toHaveBeenCalled();
  });

  it('preserves handlers after bearer, scope, and capability checks pass', async () => {
    const app = buildApp();
    const headers = {
      Authorization: `Bearer ${controlPlaneAccessToken}`,
      'x-agent-id': 'capable-agent',
    };

    await request(app).get('/api/self-improve/status').set(headers).expect(200);
    await request(app).post('/api/self-improve/run').set(headers).send({}).expect(200);
    await request(app).post('/api/self-improve/freeze').set(headers).send({}).expect(200);
    await request(app).post('/api/self-improve/unfreeze').set(headers).send({}).expect(200);
    await request(app)
      .post('/api/self-improve/autonomy')
      .set(headers)
      .send({ level: 2 })
      .expect(200);

    expect(validateCapabilityMock).toHaveBeenCalledTimes(5);
    expect(runSelfHealingLoopMock).toHaveBeenCalledTimes(1);
    expect(freezeSelfImproveMock).toHaveBeenCalledTimes(1);
    expect(unfreezeSelfImproveMock).toHaveBeenCalledTimes(1);
    expect(setAutonomyLevelMock).toHaveBeenCalledWith(2, 'manual');
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
  if (originalAutomationHeader === undefined) {
    delete process.env.ARCANOS_AUTOMATION_HEADER;
  } else {
    process.env.ARCANOS_AUTOMATION_HEADER = originalAutomationHeader;
  }
});
