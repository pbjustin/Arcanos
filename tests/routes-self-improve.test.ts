import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const runSelfImproveCycleMock = jest.fn();
const freezeSelfImproveMock = jest.fn();
const unfreezeSelfImproveMock = jest.fn();
const setAutonomyLevelMock = jest.fn();
const getKillSwitchStatusMock = jest.fn();
const sendInternalErrorPayloadMock = jest.fn((res: express.Response, payload: unknown) => {
  res.status(500).json(payload);
});

jest.unstable_mockModule('@transport/http/middleware/capabilityGate.js', () => ({
  capabilityGate: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next()
}));

jest.unstable_mockModule('@services/selfImprove/selfHealingLoop.js', () => ({
  runSelfHealingLoop: runSelfImproveCycleMock
}));

jest.unstable_mockModule('@services/incidentResponse/killSwitch.js', () => ({
  freezeSelfImprove: freezeSelfImproveMock,
  unfreezeSelfImprove: unfreezeSelfImproveMock,
  setAutonomyLevel: setAutonomyLevelMock,
  getKillSwitchStatus: getKillSwitchStatusMock
}));

jest.unstable_mockModule('@shared/http/index.js', () => ({
  sendInternalErrorPayload: sendInternalErrorPayloadMock
}));

const selfImproveRouter = (await import('../src/routes/self-improve.js')).default;
const controlPlaneAccessToken = 'self-improve-control-token-1234567890';
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

function configureControlPlane(
  scopes = 'arcanos:read,self-heal:decide,self-heal:execute,self-improve:control'
): void {
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneAccessToken;
  principalSequence += 1;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID =
    `operator:self-improve-test:${principalSequence}`;
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = scopes;
}

function addAuthorizedControlPlanePrincipal(app: express.Express): void {
  app.use((req, _res, next) => {
    req.headers.authorization = `Bearer ${controlPlaneAccessToken}`;
    next();
  });
}

/**
 * Build a test app hosting only the self-improve router.
 *
 * Purpose: exercise route branches with deterministic mocked dependencies.
 * Inputs/outputs: none -> express app with JSON parser and mounted router.
 * Edge cases: N/A.
 */
function createTestApp(authenticate = true): express.Express {
  const app = express();
  if (authenticate) {
    addAuthorizedControlPlanePrincipal(app);
  }
  app.use(express.json());
  app.use(selfImproveRouter);
  return app;
}

function createDependencyAwareTestApp(): express.Express {
  const app = createTestApp();
  app.use((
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    const dependencyError = error as { code?: unknown; dependency?: unknown };
    res.status(
      dependencyError.code === 'REDIS_DEPENDENCY_UNAVAILABLE'
      && dependencyError.dependency === 'redis'
        ? 503
        : 500
    ).json({
      code: dependencyError.code
    });
  });
  return app;
}

describe('routes/self-improve', () => {
  beforeEach(() => {
    configureControlPlane();
    runSelfImproveCycleMock.mockReset();
    freezeSelfImproveMock.mockReset();
    unfreezeSelfImproveMock.mockReset();
    setAutonomyLevelMock.mockReset();
    getKillSwitchStatusMock.mockReset();
    sendInternalErrorPayloadMock.mockClear();
    getKillSwitchStatusMock.mockResolvedValue({ frozen: false, autonomyLevel: 1, overrides: { freeze: null, autonomy: null } });
  });

  it('requires the control-plane bearer before any self-improve dependency runs', async () => {
    const response = await request(createTestApp(false))
      .post('/api/self-improve/run')
      .send({ trigger: 'manual' });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(runSelfImproveCycleMock).not.toHaveBeenCalled();
  });

  it('requires both decision and execution scopes for manual loop runs', async () => {
    configureControlPlane('self-heal:decide');

    const response = await request(createTestApp())
      .post('/api/self-improve/run')
      .send({ trigger: 'manual' });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('CONTROL_PLANE_SCOPE_DENIED');
    expect(response.headers['x-ratelimit-bucket']).toBe('self-heal-decision');
    expect(runSelfImproveCycleMock).not.toHaveBeenCalled();
  });

  it('returns status payload when kill-switch status resolves', async () => {
    const app = createTestApp();

    const response = await request(app).get('/api/self-improve/status').expect(200);

    expect(response.body).toEqual({
      status: 'ok',
      killSwitch: { frozen: false, autonomyLevel: 1, overrides: { freeze: null, autonomy: null } }
    });
  });

  it('returns 500 on status fetch failure', async () => {
    const app = createTestApp();
    getKillSwitchStatusMock.mockRejectedValueOnce(new Error('status failed'));

    await request(app).get('/api/self-improve/status').expect(500);

    expect(sendInternalErrorPayloadMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ where: 'self-improve/status' })
    );
  });

  it('rejects invalid self-improve run payload', async () => {
    const app = createTestApp();

    const response = await request(app)
      .post('/api/self-improve/run')
      .send({ trigger: 'manual', selfTestFailureCount: -1 })
      .expect(400);

    expect(response.body.error).toBe('Invalid self-improve payload');
    expect(runSelfImproveCycleMock).not.toHaveBeenCalled();
  });

  it('rejects unknown mutation fields instead of silently executing defaults', async () => {
    const app = createTestApp();

    const runResponse = await request(app)
      .post('/api/self-improve/run')
      .send({ triggr: 'manual' })
      .expect(400);
    const freezeResponse = await request(app)
      .post('/api/self-improve/freeze')
      .send({ reasn: 'incident' })
      .expect(400);
    const autonomyResponse = await request(app)
      .post('/api/self-improve/autonomy')
      .send({ level: 1, reasn: 'incident' })
      .expect(400);

    expect(runResponse.body.error).toBe('Invalid self-improve payload');
    expect(freezeResponse.body.error).toBe('Invalid self-improve control payload');
    expect(autonomyResponse.body.error).toBe('Missing or invalid level');
    expect(runSelfImproveCycleMock).not.toHaveBeenCalled();
    expect(freezeSelfImproveMock).not.toHaveBeenCalled();
    expect(setAutonomyLevelMock).not.toHaveBeenCalled();
  });

  it('runs one self-healing loop iteration for valid payload', async () => {
    const app = createTestApp();
    runSelfImproveCycleMock.mockResolvedValueOnce({
      trigger: 'manual',
      tickAt: '2026-03-25T12:00:00.000Z',
      tickCount: 1,
      loopRunning: true,
      lastError: null,
      diagnosis: 'manual self-heal evaluation',
      action: null,
      controllerDecision: 'PATCH_PROPOSAL'
    });

    const response = await request(app)
      .post('/api/self-improve/run')
      .send({ trigger: 'manual', component: 'planner' })
      .expect(200);

    expect(runSelfImproveCycleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: 'manual',
        requestedCycle: expect.objectContaining({ trigger: 'manual', component: 'planner' })
      })
    );
    expect(response.body).toEqual({
      status: 'ok',
      result: {
        trigger: 'manual',
        tickAt: '2026-03-25T12:00:00.000Z',
        tickCount: 1,
        loopRunning: true,
        lastError: null,
        diagnosis: 'manual self-heal evaluation',
        action: null,
        controllerDecision: 'PATCH_PROPOSAL'
      }
    });
  });

  it('returns 500 when the self-improve cycle throws', async () => {
    const app = createTestApp();
    runSelfImproveCycleMock.mockRejectedValueOnce(new Error('cycle failed'));

    await request(app)
      .post('/api/self-improve/run')
      .send({ trigger: 'manual' })
      .expect(500);

    expect(sendInternalErrorPayloadMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ where: 'self-improve/run' })
    );
  });

  it('defaults to an empty payload when request body is unavailable', async () => {
    const app = express();
    addAuthorizedControlPlanePrincipal(app);
    app.use(selfImproveRouter);
    runSelfImproveCycleMock.mockResolvedValueOnce({
      trigger: 'manual',
      tickAt: '2026-03-25T12:00:00.000Z',
      tickCount: 1,
      loopRunning: false,
      lastError: null,
      diagnosis: 'manual self-heal evaluation',
      action: null,
      controllerDecision: 'PATCH_PROPOSAL'
    });

    const response = await request(app)
      .post('/api/self-improve/run')
      .expect(200);

    expect(runSelfImproveCycleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: 'manual',
        requestedCycle: expect.objectContaining({ trigger: 'manual' })
      })
    );
    expect(response.body.result.trigger).toBe('manual');
  });

  it('rejects coerced or out-of-range autonomy levels', async () => {
    const app = createTestApp();

    for (const level of [null, false, [], '2', 1.9, -1, 4]) {
      await request(app)
        .post('/api/self-improve/autonomy')
        .send({ level })
        .expect(400);
    }

    expect(setAutonomyLevelMock).not.toHaveBeenCalled();
  });

  it('handles freeze and unfreeze success flows', async () => {
    const app = createTestApp();
    freezeSelfImproveMock.mockResolvedValueOnce(undefined);
    unfreezeSelfImproveMock.mockResolvedValueOnce(undefined);
    getKillSwitchStatusMock
      .mockResolvedValueOnce({ frozen: true, autonomyLevel: 0, overrides: { freeze: true, autonomy: 0 } })
      .mockResolvedValueOnce({ frozen: false, autonomyLevel: 1, overrides: { freeze: false, autonomy: null } });

    const freezeResponse = await request(app)
      .post('/api/self-improve/freeze')
      .send({ reason: 'incident' })
      .expect(200);
    expect(freezeSelfImproveMock).toHaveBeenCalledWith('incident');
    expect(freezeResponse.body.killSwitch.frozen).toBe(true);

    const unfreezeResponse = await request(app)
      .post('/api/self-improve/unfreeze')
      .send({ reason: 'manual' })
      .expect(200);
    expect(unfreezeSelfImproveMock).toHaveBeenCalledWith('manual');
    expect(unfreezeResponse.body.killSwitch.frozen).toBe(false);
  });

  it('uses manual reason fallback for freeze/unfreeze/autonomy when reason is omitted', async () => {
    const app = createTestApp();
    freezeSelfImproveMock.mockResolvedValueOnce(undefined);
    unfreezeSelfImproveMock.mockResolvedValueOnce(undefined);
    setAutonomyLevelMock.mockResolvedValueOnce(undefined);

    await request(app)
      .post('/api/self-improve/freeze')
      .send({})
      .expect(200);
    expect(freezeSelfImproveMock).toHaveBeenCalledWith('manual');

    await request(app)
      .post('/api/self-improve/unfreeze')
      .send({})
      .expect(200);
    expect(unfreezeSelfImproveMock).toHaveBeenCalledWith('manual');

    await request(app)
      .post('/api/self-improve/autonomy')
      .send({ level: 1 })
      .expect(200);
    expect(setAutonomyLevelMock).toHaveBeenCalledWith(1, 'manual');
  });

  it('handles freeze and unfreeze failures via internal error payload', async () => {
    const app = createTestApp();
    freezeSelfImproveMock.mockRejectedValueOnce(new Error('freeze failed'));
    unfreezeSelfImproveMock.mockRejectedValueOnce(new Error('unfreeze failed'));

    await request(app).post('/api/self-improve/freeze').send({ reason: 'x' }).expect(500);
    await request(app).post('/api/self-improve/unfreeze').send({ reason: 'x' }).expect(500);

    expect(sendInternalErrorPayloadMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ where: 'self-improve/freeze' })
    );
    expect(sendInternalErrorPayloadMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ where: 'self-improve/unfreeze' })
    );
  });

  it('forwards Redis dependency failures from relaxing operations as stable 503s', async () => {
    const app = createDependencyAwareTestApp();
    const dependencyError = Object.assign(
      new Error('Redis dependency is unavailable.'),
      {
        dependency: 'redis',
        code: 'REDIS_DEPENDENCY_UNAVAILABLE'
      }
    );
    unfreezeSelfImproveMock.mockRejectedValueOnce(dependencyError);
    setAutonomyLevelMock.mockRejectedValueOnce(dependencyError);

    await request(app)
      .post('/api/self-improve/unfreeze')
      .send({ reason: 'blocked' })
      .expect(503, { code: 'REDIS_DEPENDENCY_UNAVAILABLE' });
    await request(app)
      .post('/api/self-improve/autonomy')
      .send({ level: 3, reason: 'blocked' })
      .expect(503, { code: 'REDIS_DEPENDENCY_UNAVAILABLE' });

    expect(sendInternalErrorPayloadMock).not.toHaveBeenCalled();
  });

  it('validates autonomy level and handles success/error branches', async () => {
    const app = createTestApp();
    setAutonomyLevelMock.mockResolvedValueOnce(undefined);

    await request(app).post('/api/self-improve/autonomy').send({ reason: 'manual' }).expect(400);

    await request(app)
      .post('/api/self-improve/autonomy')
      .send({ level: 2, reason: 'manual' })
      .expect(200);
    expect(setAutonomyLevelMock).toHaveBeenCalledWith(2, 'manual');

    setAutonomyLevelMock.mockRejectedValueOnce(new Error('autonomy failed'));
    await request(app)
      .post('/api/self-improve/autonomy')
      .send({ level: 1, reason: 'manual' })
      .expect(500);

    expect(sendInternalErrorPayloadMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ where: 'self-improve/autonomy' })
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
